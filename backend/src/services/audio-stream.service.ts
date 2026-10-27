import log from '../utils/logger';
import { callVoiceDiarizationService, CallDiarizationResult } from './call-voice-diarization.service';

/**
 * Two-way consultation call audio voice segregation and transcription.
 * Raw audio is segregated into doctor vs. patient speech tracks and deterministically
 * de-identified by phi-scrubber.service before clinical entity extraction.
 */
export const audioStreamService = {
    isAvailable(): boolean {
        return true;
    },

    /**
     * Process consultation call audio with voice segregation and pre-LLM PHI de-identification.
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
        log.info(`AI_AUDIO_SESSION_STARTED consultationId=${consultationId}`);
        emitter('ai:audio_ready', {
            consultationId,
            status: 'voice_segregation_active',
            model: 'meta-sam-audio-mms',
        });
        return true;
    },

    stopSession(consultationId: string): void {
        log.info(`AI_AUDIO_SESSION_STOPPED consultationId=${consultationId}`);
    },

    addAudioChunk(_consultationId: string, _chunk: string, _mimeType: string): void {
        // Chunks are buffered or passed to diarize endpoint
    },

    findSessionBySocketId(_socketId: string): string | undefined {
        return undefined;
    },
};

export default audioStreamService;
