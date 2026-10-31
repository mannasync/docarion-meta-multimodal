import log from '../utils/logger';
import { callVoiceDiarizationService, CallDiarizationResult } from './call-voice-diarization.service';
import { liveScribeAsrService } from './live-scribe-asr.service';

/**
 * Live consultation audio for the in-call AI scribe.
 *
 * Owner decision 2026-10-28: live transcription is enabled, but ONLY through
 * the HTTP live scribe (routes/live-scribe.routes.ts → live-scribe.service),
 * which enforces, on every segment: assigned-doctor relationship, active NDPA
 * patient consent (opt-out stops it), a configured speech provider, size/
 * duration/rate limits, no audio retention, PHI scrubbing of the transcript
 * before any language model, and metadata-only audit entries.
 *
 * The legacy WebSocket transport below can never run in the Firebase
 * Functions deployment and its 2-second MediaRecorder fragments are not
 * independently decodable, so it still refuses to start and never retains or
 * forwards raw audio. It tells the client to use the HTTP scribe instead.
 *
 * `processCallAudio` (recorded-call voice segregation) is a separate path and
 * is unchanged.
 */
const HTTP_ONLY_MESSAGE =
    'The live AI scribe runs over HTTPS (/api/v1/live-scribe). This socket transport does not accept call audio.';

export const audioStreamService = {
    /** True when a speech provider is configured for the HTTP live scribe. */
    isAvailable(): boolean {
        return liveScribeAsrService.isAvailable();
    },

    /**
     * Process recorded consultation call audio with voice segregation and
     * pre-LLM PHI de-identification.
     */
    async processCallAudio(input: {
        audioBase64?: string;
        consultationId?: string;
        language?: string;
        stripNoise?: boolean;
    }): Promise<CallDiarizationResult> {
        return callVoiceDiarizationService.diarizeConsultationAudio(input);
    },

    startSession(
        consultationId: string,
        _doctorSocketId: string,
        emitter: (eventName: string, data: any) => void,
    ): boolean {
        log.warn(`AI_SOCKET_AUDIO_REFUSED transport=socket consultationPresent=${Boolean(consultationId)}`);
        emitter('ai:error', {
            code: 'AI_LIVE_SCRIBE_HTTP_ONLY',
            error: HTTP_ONLY_MESSAGE,
        });
        return false;
    },

    stopSession(_consultationId: string): void {
        // No raw-audio session is created.
    },

    addAudioChunk(_consultationId: string, _chunk: string, _mimeType: string): void {
        // Fail closed: never retain or transmit raw audio.
    },

    findSessionBySocketId(_socketId: string): string | undefined {
        return undefined;
    },
};

export default audioStreamService;
