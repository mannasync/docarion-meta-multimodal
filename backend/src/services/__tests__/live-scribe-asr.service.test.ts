/**
 * Live-scribe speech provider chain.
 *  - no provider configured → LiveScribeAsrUnavailableError (fail closed)
 *  - Modal (MMS + Pyannote) is only used when LIVE_SCRIBE_MODAL_VERIFIED=true,
 *    and its known demo-fixture output is rejected (the deployed endpoint
 *    returned a canned dialogue for silence on 2026-10-28)
 *  - only hackathon-plan providers: modal → fireworks; a failing provider
 *    falls through to the next; no other speech service is ever called
 *  - logs never contain audio or transcript text
 */
import axios from 'axios';
import log from '../../utils/logger';
import { liveScribeAsrService, LiveScribeAsrUnavailableError, LiveScribeAsrFailedError } from '../live-scribe-asr.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ENV_KEYS = ['LIVE_SCRIBE_ASR_PROVIDERS', 'LIVE_SCRIBE_MODAL_VERIFIED', 'FIREWORKS_API_KEY', 'DEEPGRAM_API_KEY', 'MODAL_DIARIZE_ENDPOINT_URL'];
const saved: Record<string, string | undefined> = {};
const audio = Buffer.from('fake-audio-bytes-SECRET-AUDIO');
const fetchMock = jest.fn();

beforeAll(() => {
    (global as any).fetch = fetchMock;
});

beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    mockedAxios.post.mockReset();
    fetchMock.mockReset();
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

const fireworksOk = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) });

test('fails closed when no provider is configured', async () => {
    expect(liveScribeAsrService.isAvailable()).toBe(false);
    await expect(liveScribeAsrService.transcribeSegment({ audio, mimeType: 'audio/webm' }))
        .rejects.toBeInstanceOf(LiveScribeAsrUnavailableError);
});

test('Modal is not used unless explicitly verified', () => {
    process.env.MODAL_DIARIZE_ENDPOINT_URL = 'https://example.modal.run/diarize';
    expect(liveScribeAsrService.configuredProviders()).toEqual([]);
    process.env.LIVE_SCRIBE_MODAL_VERIFIED = 'true';
    expect(liveScribeAsrService.configuredProviders()).toEqual(['modal']);
});

test('Deepgram is never used, even when its key is present', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-test';
    expect(liveScribeAsrService.configuredProviders()).toEqual([]);
    await expect(liveScribeAsrService.transcribeSegment({ audio, mimeType: 'audio/webm' }))
        .rejects.toBeInstanceOf(LiveScribeAsrUnavailableError);
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
});

test('Modal demo fixture output is rejected and falls through to the next provider', async () => {
    process.env.LIVE_SCRIBE_MODAL_VERIFIED = 'true';
    process.env.MODAL_DIARIZE_ENDPOINT_URL = 'https://example.modal.run/diarize';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    mockedAxios.post.mockResolvedValue({ status: 200, data: { turns: [{ speaker: 'SPEAKER_PATIENT', transcript: 'Doctor, good morning. Abeg my body dey hot well well since three days and my head dey pain me.' }] } } as any);
    fetchMock.mockResolvedValue(fireworksOk('Real words from the call.'));
    const out = await liveScribeAsrService.transcribeSegment({ audio, mimeType: 'audio/webm' });
    expect(out.provider).toBe('fireworks');
    expect(out.text).toBe('Real words from the call.');
});

test('a verified Modal endpoint with genuine output is used first', async () => {
    process.env.LIVE_SCRIBE_MODAL_VERIFIED = 'true';
    process.env.MODAL_DIARIZE_ENDPOINT_URL = 'https://example.modal.run/diarize';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    mockedAxios.post.mockResolvedValue({ status: 200, data: { turns: [
        { speaker: 'SPEAKER_DOCTOR', transcript: 'Wetin dey worry you?' },
        { speaker: 'SPEAKER_PATIENT', transcript: 'Belle dey pain me.' },
    ] } } as any);
    const out = await liveScribeAsrService.transcribeSegment({ audio, mimeType: 'audio/webm' });
    expect(out.provider).toBe('modal');
    expect(out.turns.map((t) => t.speaker)).toEqual(['SPEAKER_DOCTOR', 'SPEAKER_PATIENT']);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
});

test('Fireworks is tried after Modal when Modal fails', async () => {
    process.env.LIVE_SCRIBE_MODAL_VERIFIED = 'true';
    process.env.MODAL_DIARIZE_ENDPOINT_URL = 'https://example.modal.run/diarize';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    mockedAxios.post.mockRejectedValue(new Error('modal down'));
    fetchMock.mockResolvedValue(fireworksOk('Fallback text.'));
    const out = await liveScribeAsrService.transcribeSegment({ audio, mimeType: 'audio/webm' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://audio-turbo.api.fireworks.ai/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBe('Bearer fw-test');
    expect(out.provider).toBe('fireworks');
});

test('Fireworks success is returned', async () => {
    process.env.FIREWORKS_API_KEY = 'fw-test';
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: ' I feel dizzy. ' }) });
    const out = await liveScribeAsrService.transcribeSegment({ audio, mimeType: 'audio/ogg' });
    expect(out).toEqual({ provider: 'fireworks', text: 'I feel dizzy.', turns: [{ speaker: 'SPEAKER', text: 'I feel dizzy.' }] });
});

test('all providers failing throws and logs no audio or transcript content', async () => {
    process.env.FIREWORKS_API_KEY = 'fw-test';
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ text: 'should-not-be-logged' }) });
    const warn = jest.spyOn(log, 'warn');
    await expect(liveScribeAsrService.transcribeSegment({ audio, mimeType: 'audio/webm' }))
        .rejects.toBeInstanceOf(LiveScribeAsrFailedError);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('SECRET-AUDIO');
    expect(logged).not.toContain(audio.toString('base64'));
    expect(logged).not.toContain('should-not-be-logged');
    warn.mockRestore();
});

test('LIVE_SCRIBE_ASR_PROVIDERS can disable a provider', () => {
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.LIVE_SCRIBE_MODAL_VERIFIED = 'true';
    process.env.MODAL_DIARIZE_ENDPOINT_URL = 'https://example.modal.run/diarize';
    process.env.LIVE_SCRIBE_ASR_PROVIDERS = 'fireworks,deepgram';
    expect(liveScribeAsrService.configuredProviders()).toEqual(['fireworks']);
});
