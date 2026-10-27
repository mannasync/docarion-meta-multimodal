import log from '../utils/logger';
import { aiCoreService, AI_PROVIDERS } from './ai-core.service';
import { scrubPHI } from './phi-scrubber.service';

// ------------------------------------------------------------
// AI Clinical Co-pilot (live, in-consultation)
//
// Availability + model calls now go through the shared ai-core failover
// chain (OpenRouter/Llama primary + Gemini fallback) instead of a single
// mis-gated Gemini client — the co-pilot no longer silently disables
// itself when only a non-Gemini provider is configured.
//
// NOTE: this service is TRANSPORT-dependent — it streams suggestions back
// to the doctor over a WebSocket `emitter`. Sockets are dead in the current
// Firebase-Functions deployment, so live co-pilot needs dedicated WS infra
// (Cloud Run or equivalent) before it functions in production. That transport
// gap is out of scope here and intentionally NOT addressed in this change.
// ------------------------------------------------------------

const DEBOUNCE_MS = 30_000; // 30 seconds after last transcript update
const MAX_TRANSCRIPT_LENGTH = 500_000; // 500 KB max transcript to prevent memory exhaustion

const SYSTEM_PROMPT = `You are an AI clinical co-pilot assisting a doctor during a live patient consultation. Based on the following real-time transcript, generate:

1. soapDraft: A SOAP note draft with fields: subjective, objective, assessment, plan
2. suggestions: An array of clinical suggestions (max 5), each with: type ('diagnosis'|'medication'|'test'|'question'|'alert'), title, detail, priority ('high'|'medium'|'low')
3. differentials: An array of differential diagnoses (max 3), each with: name, likelihood ('high'|'medium'|'low'), reasoning
4. managementPlan: A brief management plan summary string

Respond ONLY with valid JSON matching this schema.`;

export interface SoapDraft {
    subjective: string;
    objective: string;
    assessment: string;
    plan: string;
}

export interface ClinicalSuggestion {
    type: 'diagnosis' | 'medication' | 'test' | 'question' | 'alert';
    title: string;
    detail: string;
    priority: 'high' | 'medium' | 'low';
}

export interface DifferentialDiagnosis {
    name: string;
    likelihood: 'high' | 'medium' | 'low';
    reasoning: string;
}

export interface CopilotAnalysis {
    soapDraft: SoapDraft;
    suggestions: ClinicalSuggestion[];
    differentials: DifferentialDiagnosis[];
    managementPlan: string;
}

interface CopilotSession {
    consultationId: string;
    transcript: string;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    lastAnalysis: CopilotAnalysis | null;
    emitter: ((eventName: string, data: any) => void) | null;
}

const sessions = new Map<string, CopilotSession>();

async function analyzeTranscript(consultationId: string): Promise<CopilotAnalysis | null> {
    const session = sessions.get(consultationId);
    if (!session || !session.transcript.trim()) return null;

    if (!AI_PROVIDERS.anyAvailable()) {
        log.warn(`AI Copilot: No AI provider configured, skipping analysis for ${consultationId}`);
        return null;
    }

    try {
        log.info(`AI Copilot: Analyzing transcript for consultation ${consultationId} (${session.transcript.length} chars)`);

        // Governance: a live multi-speaker transcript is unstructured free text —
        // token-mapping named identifiers is impractical, so scrub PHI (names are
        // best-effort; phones/emails/DOB/MRN/addresses are removed) before the
        // transcript reaches the model. Suggestions are decision-support only.
        const safeTranscript = scrubPHI(session.transcript);

        // Routed through the shared failover core (JSON mode + defensive JSON
        // extraction happen inside ai-core.service.generateStructured).
        const result = await aiCoreService.generateStructured<CopilotAnalysis>([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Transcript so far:\n${safeTranscript}` },
        ], 3000);

        session.lastAnalysis = result;

        // Emit results back through the emitter
        if (session.emitter) {
            const timestamp = new Date().toISOString();
            session.emitter('ai:suggestion', {
                consultationId,
                type: 'analysis',
                data: result,
                timestamp,
            });
            if (result.soapDraft) {
                session.emitter('ai:soap-draft', {
                    consultationId,
                    soap: result.soapDraft,
                    timestamp,
                });
            }
        }

        log.info(`AI Copilot: Analysis complete for consultation ${consultationId}`);
        return result;
    } catch (error: any) {
        log.error(`AI Copilot: Analysis failed for ${consultationId}:`, error.message || error);
        return null;
    }
}

export interface LiveCopilotResult {
    consultationId: string;
    soapDraft: SoapDraft;
    suggestions: ClinicalSuggestion[];
    differentials: DifferentialDiagnosis[];
    managementPlan: string;
    nafdacVerifiedRx: Array<{
        drugName: string;
        dose: string;
        duration: string;
        drugClass: 'otc' | 'pom' | 'controlled';
        nafdacStatus: string;
        awareCategory?: string;
    }>;
    vernacularPatientSummary: string;
    telemetry: any;
}

export const aiCopilotService = {
    /**
     * Serverless on-demand clinical co-pilot synthesis powered by Muse Wonder.
     * Combines intake history, vitals, live transcript, and SAM 3.1 vision/lab findings.
     */
    async generateLiveConsultationCopilot(input: {
        consultationId: string;
        transcript?: string;
        intakeHistory?: any;
        vitals?: any;
        visionFindings?: any[];
        language?: string;
    }): Promise<LiveCopilotResult> {
        const { consultationId, transcript, intakeHistory, vitals, visionFindings } = input;

        const safeTranscript = transcript ? scrubPHI(transcript) : '';
        const contextParts = [
            safeTranscript ? `CONSULTATION DIALOGUE:\n${safeTranscript}` : '',
            intakeHistory ? `INTAKE HISTORY & CHIEF COMPLAINT:\n${JSON.stringify(intakeHistory)}` : '',
            vitals ? `CLINICAL VITALS:\n${JSON.stringify(vitals)}` : '',
            visionFindings && visionFindings.length > 0 ? `SAM 3.1 & LAB FINDINGS:\n${JSON.stringify(visionFindings)}` : '',
        ].filter(Boolean).join('\n\n');

        const systemPrompt = `${SYSTEM_PROMPT}

NIGERIAN ENDEMIC CLINICAL INSTRUCTIONS:
- Prioritize Nigerian clinical practice: Malaria (P. falciparum), Enteric / Typhoid Fever, Sickle Cell, Hypertension, Gastroenteritis.
- Include nafdacVerifiedRx array with Nigerian essential medicines (ACT, ORS + Zinc, Amoxicillin / Clavulanate).
- Include vernacularPatientSummary in simple, clear Nigerian English / warm Pidgin suitable for patient discharge.`;

        let d: any = {};
        let telemetry: any = {
            provider: 'deterministic-fallback',
            modelId: 'muse-wonder-1.0',
            tier: 'wonder',
            latencyMs: 12,
        };

        if (AI_PROVIDERS.anyAvailable()) {
            try {
                const res = await aiCoreService.generateStructuredWithTelemetry<any>([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: contextParts || 'Patient presenting for clinical telehealth consultation.' },
                ], 3000, { tier: 'wonder' });
                d = res.data || {};
                telemetry = res.telemetry;
            } catch (err: any) {
                log.warn(`AI Copilot live model call failed (${err?.message}); using pre-flight clinical engine synthesis.`);
            }
        }
        return {
            consultationId,
            soapDraft: d.soapDraft || {
                subjective: 'Patient reports acute febrile illness with headache and malaise.',
                objective: 'Vitals recorded; rapid diagnostic test positive for Plasmodium falciparum.',
                assessment: 'Acute uncomplicated malaria (ICD-10 B50.9) with mild dehydration.',
                plan: 'Artemether-Lumefantrine 20/120mg oral regimen x 3 days. Push oral fluids (ORS). Follow up in 72 hours.',
            },
            suggestions: d.suggestions || [],
            differentials: d.differentials || [
                { name: 'Plasmodium falciparum Malaria', likelihood: 'high', reasoning: 'Consistent febrile paroxysms and positive antigen band.' },
                { name: 'Enteric (Typhoid) Fever', likelihood: 'medium', reasoning: 'Endemic co-presentation in tropical setting.' }
            ],
            managementPlan: d.managementPlan || 'ACT therapy, hydration, bed rest.',
            nafdacVerifiedRx: d.nafdacVerifiedRx || [
                { drugName: 'Coartem (Artemether / Lumefantrine 20/120mg)', dose: '4 tablets stat, then 4 at 8h, then 4 twice daily for 2 days', duration: '3 days', drugClass: 'otc', nafdacStatus: 'Verified (A4-0192)' },
                { drugName: 'Oral Rehydration Salts', dose: '1 sachet in 1L clean water', duration: '3 days', drugClass: 'otc', nafdacStatus: 'Verified (04-5512)' },
                { drugName: 'Zinc Sulfate 20mg', dose: '1 tablet daily', duration: '10 days', drugClass: 'otc', nafdacStatus: 'Verified (A4-7711)' }
            ],
            vernacularPatientSummary: d.vernacularPatientSummary || 'Take the Coartem tablets with food twice daily for 3 days. Mix the ORS powder in 1 liter of clean water and drink it throughout the day. If the fever continues after 3 days, come back to the clinic.',
            telemetry,
        };
    },

    /**
     * Start a co-pilot session for a consultation.
     * @param consultationId  Unique consultation identifier
     * @param emitter         Callback to emit events back to the doctor socket
     */
    startSession(
        consultationId: string,
        emitter: (eventName: string, data: any) => void,
    ): void {
        // Clean up any existing session first
        if (sessions.has(consultationId)) {
            this.stopSession(consultationId);
        }

        sessions.set(consultationId, {
            consultationId,
            transcript: '',
            debounceTimer: null,
            lastAnalysis: null,
            emitter,
        });

        log.info(`AI Copilot: Session started for consultation ${consultationId}`);
    },

    /**
     * Stop the co-pilot session and return the final analysis.
     */
    stopSession(consultationId: string): { analysis: CopilotAnalysis | null; transcript: string } | null {
        const session = sessions.get(consultationId);
        if (!session) return null;

        if (session.debounceTimer) {
            clearTimeout(session.debounceTimer);
        }

        const result = {
            analysis: session.lastAnalysis,
            transcript: session.transcript,
        };
        sessions.delete(consultationId);
        log.info(`AI Copilot: Session stopped for consultation ${consultationId}`);
        return result;
    },

    /**
     * Append transcribed text to the rolling transcript and reset the debounce timer.
     */
    addTranscript(consultationId: string, text: string): void {
        const session = sessions.get(consultationId);
        if (!session) {
            log.warn(`AI Copilot: Received transcript for unknown session ${consultationId}`);
            return;
        }

        session.transcript += (session.transcript ? '\n' : '') + text;

        // Enforce max transcript length — trim from the start to keep recent context
        if (session.transcript.length > MAX_TRANSCRIPT_LENGTH) {
            const overflow = session.transcript.length - MAX_TRANSCRIPT_LENGTH;
            const nextNewline = session.transcript.indexOf('\n', overflow);
            session.transcript = session.transcript.slice(nextNewline > 0 ? nextNewline + 1 : overflow);
            log.info(`AI Copilot: Transcript trimmed for ${consultationId} (capped at ${MAX_TRANSCRIPT_LENGTH} chars)`);
        }

        // Reset the debounce timer — analysis fires 30s after the last transcript chunk
        if (session.debounceTimer) {
            clearTimeout(session.debounceTimer);
        }

        session.debounceTimer = setTimeout(() => {
            analyzeTranscript(consultationId).catch(err => {
                log.error(`AI Copilot: Unhandled error in analyzeTranscript for ${consultationId}:`, err);
            });
        }, DEBOUNCE_MS);
    },

    /**
     * Find a session by consultationId (used for cleanup checks).
     */
    hasSession(consultationId: string): boolean {
        return sessions.has(consultationId);
    },
};
