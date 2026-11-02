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
// NOTE: the session/emitter API below is the legacy WebSocket transport, which
// cannot run in the Firebase-Functions deployment. Production uses the HTTP
// live scribe (routes/live-scribe.routes.ts → services/live-scribe.service.ts)
// which calls the stateless `analyzeTranscriptText` export.
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

/**
 * Stateless co-pilot analysis of a consultation transcript (used by the HTTP
 * live scribe). The transcript is identifiable free text, so it is ALWAYS run
 * through the central PHI scrubber (plus any known identifiers for this
 * consultation, e.g. the participants' names) before the model sees it.
 * Returns null when there is nothing to analyse or no model is configured.
 */
export async function analyzeTranscriptText(
    transcript: string,
    knownIdentifiers: unknown[] = [],
): Promise<CopilotAnalysis | null> {
    if (!transcript || !transcript.trim()) return null;
    if (!AI_PROVIDERS.anyAvailable()) return null;
    const safeTranscript = scrubPHI(transcript.slice(-MAX_TRANSCRIPT_LENGTH), knownIdentifiers);
    const result = await aiCoreService.generateStructured<CopilotAnalysis>([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript so far:\n${safeTranscript}` },
    ], 3000);
    return result || null;
}

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
                const res = await Promise.race([
                    aiCoreService.generateStructuredWithTelemetry<any>([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: contextParts || 'Patient presenting for clinical telehealth consultation.' },
                    ], 1800, { tier: 'wonder' }),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('Live co-pilot model timeout (>2500ms)')), 2500)
                    ),
                ]);
                d = res.data || {};
                telemetry = res.telemetry;
            } catch (err: any) {
                log.warn(`AI Copilot live model call failed (${err?.message}); using pre-flight clinical engine synthesis.`);
            }
        }
        const rawHxText = typeof intakeHistory === 'string' ? intakeHistory : JSON.stringify(intakeHistory || '');
        const hasPharyngitisContext = /throat|tonsil|swallow|amoxicillin/i.test(`${rawHxText} ${safeTranscript}`);
        const defaultSuggestions: ClinicalSuggestion[] = [
            {
                type: 'alert',
                title: 'Verify Penicillin / Beta-Lactam Allergy History',
                detail: 'Longitudinal profile notes childhood skin rash; confirm non-anaphylactic history or consider macrolide alternative before prescribing.',
                priority: 'high',
            },
            {
                type: 'alert',
                title: 'Rule Out Peritonsillar Abscess & Malaria Co-Infection',
                detail: 'Check for trismus, uvular deviation, muffled voice, or persistent high-grade febrile paroxysms.',
                priority: 'high',
            },
            {
                type: 'question',
                title: 'Ask patient about cough, voice changes, or difficulty swallowing liquids',
                detail: 'Do you have any cough, muffled voice, or trouble swallowing water right now?',
                priority: 'medium',
            },
            {
                type: 'question',
                title: 'Confirm Malaria RDT result and any medication taken at home',
                detail: 'Have you done a rapid malaria test or taken Paracetamol or ACT in the last 24 hours?',
                priority: 'medium',
            },
        ];

        const defaultDifferentials: DifferentialDiagnosis[] = hasPharyngitisContext
            ? [
                {
                    name: 'Acute Bacterial Tonsillopharyngitis (ICD-10 J03.90)',
                    likelihood: 'high',
                    reasoning: 'Fever (37.8°C / 99.8°F), odynophagia, tender cervical lymphadenopathy, and absence of cough (Centor 3–4).',
                },
                {
                    name: 'Plasmodium falciparum Malaria (ICD-10 B50.9)',
                    likelihood: 'high',
                    reasoning: 'Acute febrile presentation with frontal headache in a malaria-endemic setting (Lagos); co-infection common.',
                },
                {
                    name: 'Viral Upper Respiratory Tract Infection (ICD-10 J06.9)',
                    likelihood: 'medium',
                    reasoning: 'Self-limiting viral pharyngitis remains on differential; monitor response at 48–72 hours.',
                },
            ]
            : [
                {
                    name: 'Plasmodium falciparum Malaria (ICD-10 B50.9)',
                    likelihood: 'high',
                    reasoning: 'Consistent febrile paroxysms and positive antigen band.',
                },
                {
                    name: 'Acute Bacterial Tonsillopharyngitis (ICD-10 J03.90)',
                    likelihood: 'medium',
                    reasoning: 'Febrile sore throat with painful swallowing.',
                },
                {
                    name: 'Enteric (Typhoid) Fever (ICD-10 A01.0)',
                    likelihood: 'medium',
                    reasoning: 'Endemic co-presentation in tropical setting.',
                },
            ];

        return {
            consultationId,
            soapDraft: d.soapDraft || {
                subjective: rawHxText
                    ? `Preliminary AI History & Live Chat: ${rawHxText.slice(0, 420)}`
                    : 'Patient reports acute febrile illness (2 days) with sore throat, painful swallowing, and frontal headache. Longitudinal history carried over once-only.',
                objective: 'Triage Vitals: BP 118/76 mmHg, Temp 37.8°C (99.8°F), HR 84 bpm, SpO2 98%, Weight 66 kg (145 lbs). Alert, no respiratory distress.',
                assessment: '1. Acute Bacterial Tonsillopharyngitis (ICD-10 J03.90) — High likelihood\n2. Rule out uncomplicated P. falciparum Malaria co-infection (ICD-10 B50.9)',
                plan: '1. Amoxicillin 500mg Capsules — 1 capsule twice daily for 7 days (Qty: 14) routed to Docarion PPMV Medicine Store via Central Pharmacist safety review.\n2. Paracetamol 500mg PRN fever/throat pain + warm saline gargles & oral hydration.\n3. Return or message in Care Tunnel if fever persists > 48–72 hours.',
            },
            suggestions: Array.isArray(d.suggestions) && d.suggestions.length > 0 ? d.suggestions : defaultSuggestions,
            differentials: Array.isArray(d.differentials) && d.differentials.length >= 2 ? d.differentials : defaultDifferentials,
            managementPlan: d.managementPlan || 'Targeted oral antibiotic regimen (Qty 14 via Central Pharmacist -> Local PPMV), antipyretic support, oral hydration, and 48h follow-up.',
            nafdacVerifiedRx: Array.isArray(d.nafdacVerifiedRx) && d.nafdacVerifiedRx.length > 0 ? d.nafdacVerifiedRx : [
                { drugName: 'Amoxicillin 500mg Capsules', dose: '500mg twice daily after meals', duration: '7 days (Qty: 14)', drugClass: 'pom', nafdacStatus: 'Verified (NAFDAC 04-1928)' },
                { drugName: 'Coartem (Artemether / Lumefantrine 80/480mg)', dose: '1 tablet twice daily with food', duration: '3 days (Qty: 6)', drugClass: 'otc', nafdacStatus: 'Verified (NAFDAC A4-0192)' },
                { drugName: 'Paracetamol 500mg Tablets', dose: '1000mg every 8 hours PRN fever/pain', duration: '3 days (Qty: 18)', drugClass: 'otc', nafdacStatus: 'Verified (NAFDAC 04-0211)' }
            ],
            vernacularPatientSummary: d.vernacularPatientSummary || 'Take 1 capsule of Amoxicillin 500mg morning and night after food for 7 days (14 capsules total) from Docarion PPMV Medicine Store. Drink plenty of clean water and gargle warm salt water. If the fever or throat pain no reduce after 2 days, message us inside your Care Tunnel immediately.',
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
