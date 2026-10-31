import axios from 'axios';
import log from '../utils/logger';
import { resolveDiarizeEndpoint, modalAuthHeaders } from './call-voice-diarization.service';

// ============================================================
// Live-scribe speech recognition (server-side, HTTP transport)
// ------------------------------------------------------------
// One short call-audio segment in, plain transcript text out.
//
// Privacy contract (NDPA 2023, owner decision 2026-10-28):
//   - The audio buffer is forwarded to ONE configured speech provider and is
//     never written to disk, a database, a cache or a log. Callers drop their
//     reference as soon as this returns.
//   - Nothing here logs transcript text or audio bytes — only provider name,
//     byte counts and status codes.
//   - The transcript TEXT is identifiable; callers must pass it through the
//     PHI scrubber before it reaches any language model.
//
// Provider chain (first configured provider that succeeds wins):
//   1. modal     — Meta MMS-1B on Modal (backend/modal/modal_mms_asr_app.py,
//                  verified with real speech 2026-10-28; primary for
//                  Pidgin/Hausa/Yoruba/Igbo). GATED: only used when
//                  LIVE_SCRIBE_MODAL_VERIFIED=true. On 2026-10-28 the deployed
//                  endpoint returned a fixed demo dialogue for one second of
//                  silence (scripts/modal_meta_open_weights.py hard-codes its
//                  turns), so it must never write into a real patient record
//                  until a genuine model is deployed. Known demo output is also
//                  rejected defensively.
//   2. fireworks — Whisper v3 turbo (FIREWORKS_API_KEY).
// Only the providers in the hackathon model plan are allowed (owner,
// 2026-10-28): no other speech service may receive patient audio.
// LIVE_SCRIBE_ASR_PROVIDERS (comma list) overrides the order / disables one.
// ============================================================

export type LiveScribeAsrProvider = 'modal' | 'fireworks';

export interface LiveScribeTurn {
    speaker: string;
    text: string;
}

export interface LiveScribeTranscription {
    provider: LiveScribeAsrProvider;
    text: string;
    turns: LiveScribeTurn[];
}

export class LiveScribeAsrUnavailableError extends Error {
    code = 'LIVE_SCRIBE_ASR_UNAVAILABLE';
    constructor(message = 'No live transcription provider is configured') {
        super(message);
    }
}

export class LiveScribeAsrFailedError extends Error {
    code = 'LIVE_SCRIBE_ASR_FAILED';
    constructor(message = 'Transcription failed') {
        super(message);
    }
}

const DEFAULT_ORDER: LiveScribeAsrProvider[] = ['modal', 'fireworks'];
const ASR_TIMEOUT_MS = 25_000;
// Modal scales to zero; the first segment after idle waits ~25 s for the model
// to load. Stays under the browser's 60 s segment upload timeout.
const MODAL_ASR_TIMEOUT_MS = 50_000;

/** Exact phrases the demo Modal app returns regardless of input audio. */
const MODAL_DEMO_FIXTURE_PHRASES = [
    'abeg my body dey hot well well since three days',
    'the ppmv chemist gave me paracetamol yesterday',
    'my name is chinedu okafor',
];

function env(name: string): string {
    return (process.env[name] || '').trim();
}

function providerOrder(): LiveScribeAsrProvider[] {
    const raw = env('LIVE_SCRIBE_ASR_PROVIDERS');
    if (!raw) return DEFAULT_ORDER;
    const parsed = raw
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p): p is LiveScribeAsrProvider => (DEFAULT_ORDER as string[]).includes(p));
    return parsed.length ? parsed : DEFAULT_ORDER;
}

function isProviderConfigured(p: LiveScribeAsrProvider): boolean {
    if (p === 'modal') return env('LIVE_SCRIBE_MODAL_VERIFIED') === 'true' && !!resolveDiarizeEndpoint();
    return !!env('FIREWORKS_API_KEY');
}

/** Normalise a browser/device MIME type to the bare container type. */
export function baseMimeType(mimeType: string): string {
    return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

function extensionFor(mimeType: string): string {
    const base = baseMimeType(mimeType);
    if (base === 'audio/ogg') return 'ogg';
    if (base === 'audio/wav' || base === 'audio/x-wav' || base === 'audio/wave') return 'wav';
    if (base === 'audio/mpeg') return 'mp3';
    if (base === 'audio/mp4' || base === 'audio/x-m4a' || base === 'audio/m4a' || base === 'audio/aac') return 'm4a';
    return 'webm';
}

function looksLikeModalDemoFixture(text: string): boolean {
    const t = text.toLowerCase();
    return MODAL_DEMO_FIXTURE_PHRASES.some((p) => t.includes(p));
}

function joinTurns(turns: LiveScribeTurn[]): string {
    return turns.map((t) => t.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function transcribeWithModal(audio: Buffer, language?: string): Promise<LiveScribeTranscription> {
    const url = resolveDiarizeEndpoint();
    const res = await axios.post(url, {
        audio_base64: audio.toString('base64'),
        language: language || 'english',
        strip_noise: true,
    }, { timeout: MODAL_ASR_TIMEOUT_MS, headers: modalAuthHeaders() });
    const rawTurns: any[] = Array.isArray(res.data?.turns) ? res.data.turns : [];
    const turns: LiveScribeTurn[] = rawTurns
        .map((t) => ({
            speaker: String(t?.speaker || 'SPEAKER').slice(0, 40),
            text: String(t?.transcript || '').trim(),
        }))
        .filter((t) => t.text);
    const text = joinTurns(turns);
    if (text && looksLikeModalDemoFixture(text)) {
        // Never let a canned demo dialogue reach a clinical record.
        throw new LiveScribeAsrFailedError('Modal endpoint returned demo fixture output');
    }
    return { provider: 'modal', text, turns };
}

async function transcribeWithFireworks(audio: Buffer, mimeType: string, language?: string): Promise<LiveScribeTranscription> {
    const url = env('FIREWORKS_AUDIO_URL') || 'https://audio-turbo.api.fireworks.ai/v1/audio/transcriptions';
    const model = env('FIREWORKS_ASR_MODEL') || 'whisper-v3-turbo';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: baseMimeType(mimeType) || 'audio/webm' }), `segment.${extensionFor(mimeType)}`);
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (language && /^[a-z]{2,3}$/.test(language)) form.append('language', language);

    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('FIREWORKS_API_KEY')}` },
        body: form,
        signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new LiveScribeAsrFailedError(`Fireworks transcription HTTP ${res.status}`);
    }
    const data: any = await res.json();
    const text = String(data?.text || '').trim();
    return { provider: 'fireworks', text, turns: text ? [{ speaker: 'SPEAKER', text }] : [] };
}

export const liveScribeAsrService = {
    /** Providers that are configured, in the order they will be tried. */
    configuredProviders(): LiveScribeAsrProvider[] {
        return providerOrder().filter(isProviderConfigured);
    },

    isAvailable(): boolean {
        return this.configuredProviders().length > 0;
    },

    /**
     * Transcribe one segment. Returns text ('' when nobody spoke).
     * Throws LiveScribeAsrUnavailableError when no provider is configured and
     * LiveScribeAsrFailedError when every configured provider failed.
     * Never logs or retains the audio or the text.
     */
    async transcribeSegment(input: { audio: Buffer; mimeType: string; language?: string }): Promise<LiveScribeTranscription> {
        const providers = this.configuredProviders();
        if (providers.length === 0) throw new LiveScribeAsrUnavailableError();

        let lastError: unknown = null;
        for (const provider of providers) {
            try {
                if (provider === 'modal') return await transcribeWithModal(input.audio, input.language);
                return await transcribeWithFireworks(input.audio, input.mimeType, input.language);
            } catch (err: any) {
                lastError = err;
                const status = err?.response?.status;
                log.warn(`LIVE_SCRIBE_ASR_PROVIDER_FAILED provider=${provider} bytes=${input.audio.length}${status ? ` status=${status}` : ''} reason=${String(err?.message || 'error').slice(0, 120)}`);
            }
        }
        throw new LiveScribeAsrFailedError(lastError instanceof Error ? lastError.message : 'All transcription providers failed');
    },
};

export default liveScribeAsrService;
