// ============================================================
// Docarion — Intake History Engine (deterministic core)
//
// Pure, unit-testable logic backing the AI intake service:
//   - Typed HistoryState (full clinical history framework)
//   - Extraction merging (model JSON → HistoryState)
//   - Completeness calculation + next-domain prioritisation
//   - Context detection (pediatric / obstetric / mental health /
//     chronic follow-up / language)
//   - Red-flag library with immediate vs clarify-first tiers
//
// NO model calls and NO Firestore access in this file.
// ============================================================

// ── Types ───────────────────────────────────────────────────

export interface HpiState {
    onset: string | null;
    location: string | null;
    duration: string | null;
    characteristics: string | null;
    aggravating: string | null;
    relieving: string | null;
    treatmentTried: string | null;
    severity: string | null;
}

export interface PediatricState {
    ageAndWeight: string | null;
    feeding: string | null;
    immunization: string | null;
    feverBehavior: string | null;
}

export interface ObstetricState {
    lmp: string | null;
    gravidaPara: string | null;
    gestationalAge: string | null;
    bleedingPainFetalMovement: string | null;
    dangerSigns: string | null;
}

export interface MentalHealthState {
    moodSleepAppetite: string | null;
    riskAssessment: string | null; // MANDATORY when isMentalHealth
}

export interface ChronicFollowUpState {
    medicationAdherence: string | null;
    symptomTrajectory: string | null;
    complicationsScreen: string | null;
}

export interface ContextFlags {
    isPediatric: boolean;
    isObstetric: boolean;
    isMentalHealth: boolean;
    isChronicFollowUp: boolean;
    preferredLanguage: string; // en | pcm | ha | yo | ig | fr
    literacyMode: boolean;     // extra-simple phrasing requested/detected
}

// ── Carry-over (returning patients) ─────────────────────────

/**
 * Per-domain provenance for carried-over history:
 *  - 'newly_taken'         — collected fresh this visit (default)
 *  - 'carried_unconfirmed' — pre-filled from the last completed intake, not yet confirmed
 *  - 'confirmed_unchanged' — patient confirmed the carried value is still accurate
 *  - 'updated'             — patient reported a change; the value was updated this visit
 */
export type DomainProvenance = 'newly_taken' | 'carried_unconfirmed' | 'confirmed_unchanged' | 'updated';

export interface CarryOverState {
    /** Consultation/session id of the prior completed intake the data came from */
    sourceConsultationId: string;
    /** ISO timestamp of when the prior intake was completed */
    sourceCompletedAt: string;
    /** Domain → value at seed time (for "changes since last visit" deltas) */
    priorValues: Record<string, string>;
    /** Domain → provenance. Only carried domains appear here; absent = 'newly_taken'. */
    provenance: Record<string, DomainProvenance>;
}

export interface HistoryState {
    presentingComplaint: string | null;
    hpi: HpiState;
    pastMedical: string | null;
    pastSurgical: string | null;
    medications: string | null;
    allergies: string | null;
    familyHistory: string | null;
    socialHistory: string | null;
    reviewOfSystems: Record<string, string>;
    pediatric: PediatricState;
    obstetric: ObstetricState;
    mentalHealth: MentalHealthState;
    chronicFollowUp: ChronicFollowUpState;
    explicitNegatives: string[];
    context: ContextFlags;
    /** Present only when this session was seeded from a prior completed intake */
    carryOver?: CarryOverState;
}

export interface Completeness {
    complete: boolean;
    percent: number;          // 0-100 over required domains
    filled: string[];         // required domains that are filled/denied
    missing: string[];        // required domains still open, priority order
}

export interface RedFlagHit {
    id: string;
    label: string;
    severity: 'immediate' | 'clarify';
    matchedText: string;
}

// ── Factory ─────────────────────────────────────────────────

export function createEmptyHistoryState(language: string = 'en'): HistoryState {
    return {
        presentingComplaint: null,
        hpi: {
            onset: null, location: null, duration: null, characteristics: null,
            aggravating: null, relieving: null, treatmentTried: null, severity: null,
        },
        pastMedical: null,
        pastSurgical: null,
        medications: null,
        allergies: null,
        familyHistory: null,
        socialHistory: null,
        reviewOfSystems: {},
        pediatric: { ageAndWeight: null, feeding: null, immunization: null, feverBehavior: null },
        obstetric: { lmp: null, gravidaPara: null, gestationalAge: null, bleedingPainFetalMovement: null, dangerSigns: null },
        mentalHealth: { moodSleepAppetite: null, riskAssessment: null },
        chronicFollowUp: { medicationAdherence: null, symptomTrajectory: null, complicationsScreen: null },
        explicitNegatives: [],
        context: {
            isPediatric: false, isObstetric: false, isMentalHealth: false,
            isChronicFollowUp: false, preferredLanguage: language || 'en', literacyMode: true,
        },
    };
}

// ── Carry-over seeding (returning patients) ─────────────────

/**
 * Carried history older than this is considered STALE: nothing is carried
 * over and all domains are re-asked fresh (12 months — clinical data drifts:
 * new diagnoses, surgeries, medication changes accumulate over a year).
 */
export const CARRY_OVER_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 12 months

/** Stable domains: pre-filled AND counted as complete (AI still confirms conversationally). */
export const STABLE_CARRY_DOMAINS = ['pastMedical', 'pastSurgical', 'familyHistory', 'socialHistory'] as const;

/**
 * Safety domains: pre-filled but counted as INCOMPLETE until the patient
 * confirms or updates them this visit (medication reconciliation; allergies
 * must never be silently assumed).
 */
export const SAFETY_CARRY_DOMAINS = ['medications', 'allergies'] as const;

type CarryDomain = typeof STABLE_CARRY_DOMAINS[number] | typeof SAFETY_CARRY_DOMAINS[number];
const ALL_CARRY_DOMAINS: CarryDomain[] = [...STABLE_CARRY_DOMAINS, ...SAFETY_CARRY_DOMAINS];

/** Effective provenance for a domain ('newly_taken' when never carried). */
export function getDomainProvenance(state: HistoryState, domain: string): DomainProvenance {
    return state.carryOver?.provenance?.[domain] || 'newly_taken';
}

/**
 * Seed a FRESH HistoryState from the patient's most recent completed intake.
 * - Stable domains (PMH/PSH/family/social) carried with provenance 'carried_unconfirmed'.
 * - Safety domains (medications/allergies) carried the same way, but
 *   computeCompleteness treats them as missing until confirmed/updated.
 * - Presenting complaint, HPI, ROS and conditional modules are ALWAYS fresh.
 * - If the prior intake is older than CARRY_OVER_MAX_AGE_MS, nothing is
 *   carried and a plain empty state is returned.
 */
export function seedHistoryFromPrior(
    prior: HistoryState,
    opts: { sourceConsultationId: string; completedAtMs: number; nowMs?: number; language?: string }
): HistoryState {
    const fresh = createEmptyHistoryState(opts.language || prior?.context?.preferredLanguage || 'en');
    const now = opts.nowMs ?? Date.now();
    if (!prior || !opts.completedAtMs || now - opts.completedAtMs > CARRY_OVER_MAX_AGE_MS) {
        return fresh; // stale (or unknown age) → re-ask everything
    }

    const priorValues: Record<string, string> = {};
    const provenance: Record<string, DomainProvenance> = {};
    for (const domain of ALL_CARRY_DOMAINS) {
        const value = (prior as any)[domain];
        if (typeof value === 'string' && value.trim().length > 0) {
            (fresh as any)[domain] = value.trim().slice(0, MAX_FIELD_LEN);
            priorValues[domain] = (fresh as any)[domain];
            // Static domains (PMH, PSH, family, social) are taken ONCE and already complete on file.
            // Only safety domains (medications, allergies) require active confirmation this visit.
            provenance[domain] = (STABLE_CARRY_DOMAINS as readonly string[]).includes(domain)
                ? 'confirmed_unchanged'
                : 'carried_unconfirmed';
        }
    }

    // Carry once-only obstetric parity (gravida/para) if previously recorded
    if (typeof prior.obstetric?.gravidaPara === 'string' && prior.obstetric.gravidaPara.trim().length > 0) {
        fresh.obstetric.gravidaPara = prior.obstetric.gravidaPara.trim().slice(0, MAX_FIELD_LEN);
    }

    if (Object.keys(provenance).length === 0) return fresh; // nothing usable to carry

    fresh.carryOver = {
        sourceConsultationId: opts.sourceConsultationId,
        sourceCompletedAt: new Date(opts.completedAtMs).toISOString(),
        priorValues,
        provenance,
    };
    return fresh;
}

/** Domains still awaiting this-visit confirmation. */
export function unconfirmedCarriedDomains(state: HistoryState): string[] {
    if (!state.carryOver) return [];
    return Object.keys(state.carryOver.provenance)
        .filter(d => state.carryOver!.provenance[d] === 'carried_unconfirmed');
}

/** "Changes since last visit": carried domains the patient updated this visit. */
export function computeCarryOverDeltas(state: HistoryState): { domain: string; previous: string; current: string }[] {
    if (!state.carryOver) return [];
    const deltas: { domain: string; previous: string; current: string }[] = [];
    for (const domain of Object.keys(state.carryOver.provenance)) {
        if (state.carryOver.provenance[domain] === 'updated') {
            deltas.push({
                domain,
                previous: state.carryOver.priorValues[domain] || '',
                current: (state as any)[domain] || '',
            });
        }
    }
    return deltas;
}

// ── Merge helpers ───────────────────────────────────────────

const MAX_FIELD_LEN = 600;
const MAX_ROS_SYSTEMS = 24;
const MAX_NEGATIVES = 60;

function cleanString(value: any): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, MAX_FIELD_LEN);
}

/** Firestore field names must not contain '.', '/', '[', ']', '*' */
function sanitizeKey(key: string): string {
    return key.replace(/[.\/\[\]*]/g, '_').trim().slice(0, 60);
}

function mergeStringField(current: string | null, incoming: any): string | null {
    const cleaned = cleanString(incoming);
    return cleaned !== null ? cleaned : current; // never null-out a filled field
}

function mergeSubObject<T extends object>(current: T, incoming: any): T {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return current;
    const result: any = { ...current };
    for (const key of Object.keys(current)) {
        if (key in incoming) {
            result[key] = mergeStringField((current as any)[key], incoming[key]);
        }
    }
    return result;
}

const ALLOWED_LANGUAGES = ['en', 'pcm', 'ha', 'yo', 'ig', 'fr'];

/**
 * Merge a (possibly partial / malformed) model extraction into HistoryState.
 * Non-destructive: filled fields are never reset to null, booleans only latch true.
 * Returns a NEW state object.
 */
export function mergeExtraction(state: HistoryState, extraction: any): HistoryState {
    if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) {
        return state;
    }

    const next: HistoryState = {
        ...state,
        ...(state.carryOver ? {
            carryOver: {
                ...state.carryOver,
                priorValues: { ...state.carryOver.priorValues },
                provenance: { ...state.carryOver.provenance },
            },
        } : {}),
        hpi: mergeSubObject(state.hpi, extraction.hpi),
        pediatric: mergeSubObject(state.pediatric, extraction.pediatric),
        obstetric: mergeSubObject(state.obstetric, extraction.obstetric),
        mentalHealth: mergeSubObject(state.mentalHealth, extraction.mentalHealth),
        chronicFollowUp: mergeSubObject(state.chronicFollowUp, extraction.chronicFollowUp),
        presentingComplaint: mergeStringField(state.presentingComplaint, extraction.presentingComplaint),
        pastMedical: mergeStringField(state.pastMedical, extraction.pastMedical),
        pastSurgical: mergeStringField(state.pastSurgical, extraction.pastSurgical),
        medications: mergeStringField(state.medications, extraction.medications),
        allergies: mergeStringField(state.allergies, extraction.allergies),
        familyHistory: mergeStringField(state.familyHistory, extraction.familyHistory),
        socialHistory: mergeStringField(state.socialHistory, extraction.socialHistory),
        reviewOfSystems: { ...state.reviewOfSystems },
        explicitNegatives: [...state.explicitNegatives],
        context: { ...state.context },
    };

    // Review of systems: merge map entries
    if (extraction.reviewOfSystems && typeof extraction.reviewOfSystems === 'object' && !Array.isArray(extraction.reviewOfSystems)) {
        for (const rawKey of Object.keys(extraction.reviewOfSystems)) {
            const key = sanitizeKey(rawKey);
            const value = cleanString(extraction.reviewOfSystems[rawKey]);
            if (key && value && Object.keys(next.reviewOfSystems).length < MAX_ROS_SYSTEMS) {
                next.reviewOfSystems[key] = value;
            } else if (key && value && next.reviewOfSystems[key] !== undefined) {
                next.reviewOfSystems[key] = value; // update existing even at cap
            }
        }
    }

    // Explicit negatives: dedupe (case-insensitive), cap
    if (Array.isArray(extraction.explicitNegatives)) {
        const seen = new Set(next.explicitNegatives.map(n => n.toLowerCase()));
        for (const raw of extraction.explicitNegatives) {
            const value = cleanString(raw);
            if (value && !seen.has(value.toLowerCase()) && next.explicitNegatives.length < MAX_NEGATIVES) {
                seen.add(value.toLowerCase());
                next.explicitNegatives.push(value);
            }
        }
    }

    // Carry-over provenance transitions (deterministic):
    //  - explicit confirmation → 'confirmed_unchanged'
    //  - explicit "updated" confirmation OR a DIFFERENT value extracted → 'updated'
    //  - re-emitting the identical carried value does NOT auto-confirm
    //  - 'updated' is terminal; 'confirmed_unchanged' can still become 'updated'
    if (next.carryOver) {
        const confirmations = (extraction.confirmations && typeof extraction.confirmations === 'object' && !Array.isArray(extraction.confirmations))
            ? extraction.confirmations : {};
        for (const domain of Object.keys(next.carryOver.provenance)) {
            const current = next.carryOver.provenance[domain];
            if (current === 'updated') continue;
            const conf = typeof confirmations[domain] === 'string' ? confirmations[domain].toLowerCase() : null;
            const incomingValue = cleanString(extraction[domain]);
            const valueChanged = incomingValue !== null && incomingValue !== next.carryOver.priorValues[domain];
            if (conf === 'updated' || conf === 'changed' || valueChanged) {
                next.carryOver.provenance[domain] = 'updated';
            } else if (conf === 'unchanged' || conf === 'confirmed' || conf === 'same') {
                next.carryOver.provenance[domain] = 'confirmed_unchanged';
            }
        }
    }

    // Context flags: booleans latch true; language only if valid
    const flags = extraction.contextFlags || extraction.context;
    if (flags && typeof flags === 'object') {
        for (const boolKey of ['isPediatric', 'isObstetric', 'isMentalHealth', 'isChronicFollowUp'] as const) {
            if (flags[boolKey] === true) next.context[boolKey] = true;
        }
        const lang = flags.detectedLanguage || flags.preferredLanguage;
        if (typeof lang === 'string' && ALLOWED_LANGUAGES.includes(lang)) {
            next.context.preferredLanguage = lang;
        }
        if (flags.literacyMode === true) next.context.literacyMode = true;
    }

    return next;
}

// ── Completeness ────────────────────────────────────────────

/**
 * Required domains in PRIORITY order (the first missing entry is the
 * most important thing to ask about next). Conditional modules are
 * inserted at clinically appropriate priority.
 */
export function requiredDomains(context: ContextFlags): string[] {
    const domains: string[] = ['presentingComplaint'];

    // Safety-critical modules come right after the complaint is known
    if (context.isMentalHealth) domains.push('mentalHealth.riskAssessment');
    if (context.isObstetric) domains.push('obstetric.dangerSigns', 'obstetric.bleedingPainFetalMovement');

    // Core HPI (OLD-CARTS essentials)
    domains.push('hpi.onset', 'hpi.duration', 'hpi.characteristics', 'hpi.severity');

    if (context.isObstetric) domains.push('obstetric.lmp', 'obstetric.gravidaPara', 'obstetric.gestationalAge');
    if (context.isPediatric) {
        domains.push('pediatric.ageAndWeight', 'pediatric.feverBehavior', 'pediatric.feeding', 'pediatric.immunization');
    }
    if (context.isMentalHealth) domains.push('mentalHealth.moodSleepAppetite');
    if (context.isChronicFollowUp) {
        domains.push('chronicFollowUp.medicationAdherence', 'chronicFollowUp.symptomTrajectory', 'chronicFollowUp.complicationsScreen');
    }

    domains.push(
        'medications', 'allergies', 'pastMedical', 'pastSurgical',
        'familyHistory', 'socialHistory', 'reviewOfSystems',
    );
    return domains;
}

function domainIsFilled(state: HistoryState, path: string): boolean {
    if (path === 'reviewOfSystems') return Object.keys(state.reviewOfSystems).length > 0;
    // Safety carry-over domains (medications/allergies) stay INCOMPLETE until
    // the patient confirms or updates them this visit — never silently assumed.
    if ((SAFETY_CARRY_DOMAINS as readonly string[]).includes(path)
        && getDomainProvenance(state, path) === 'carried_unconfirmed') {
        return false;
    }
    const parts = path.split('.');
    let node: any = state;
    for (const part of parts) {
        node = node?.[part];
    }
    return typeof node === 'string' && node.trim().length > 0;
}

export function computeCompleteness(state: HistoryState): Completeness {
    const required = requiredDomains(state.context);
    const filled: string[] = [];
    const missing: string[] = [];
    for (const domain of required) {
        (domainIsFilled(state, domain) ? filled : missing).push(domain);
    }
    return {
        complete: missing.length === 0,
        percent: Math.round((filled.length / required.length) * 100),
        filled,
        missing,
    };
}

// ── Context detection ───────────────────────────────────────

const PEDIATRIC_RE = /\b(my|our|the)\s+(son|daughter|baby|child|pikin)\b|\bfor my (son|daughter|baby|child|pikin)\b|\b(newborn|toddler|infant)\b|\bmy pikin\b|\b\d+\s*(month|week)s?\s*old\s+(baby|child|son|daughter|boy|girl)\b/i;
const OBSTETRIC_RE = /\bpregnan\w*\b|\bi (am|dey) carry(ing)? bell?e\b|\bmissed (my )?period\b|\bantenatal\b|\bweeks? gestation\b|\bexpecting a baby\b|\bwith child\b/i;
const MENTAL_HEALTH_RE = /\bdepress\w*\b|\banxi(ety|ous)\b|\bpanic attacks?\b|\bfeeling (very )?(sad|down|hopeless|empty|worthless)\b|\bhear(ing)? voices\b|\bsuicid\w*\b|\bself.?harm\b|\bwant to die\b|\bkill myself\b|\bend my life\b|\bmy mind (is|dey) (not|no) (rest|settle)\b|\btired of (life|living)\b|\bdon tire for this life\b/i;
const CHRONIC_RE = /\bfollow.?up\b|\brefill\b|\bmy (diabetes|sugar|hypertension|blood pressure|bp|hiv|asthma|sickle cell|epilepsy|ulcer)\b|\bsince (my|the) last (visit|appointment|check.?up)\b|\bcheck.?up for my\b|\bmy (usual|regular) (medicine|drugs?|medication)\b/i;

export function detectContext(text: string): Partial<Omit<ContextFlags, 'preferredLanguage' | 'literacyMode'>> {
    const detected: Partial<Omit<ContextFlags, 'preferredLanguage' | 'literacyMode'>> = {};
    if (PEDIATRIC_RE.test(text)) detected.isPediatric = true;
    if (OBSTETRIC_RE.test(text)) detected.isObstetric = true;
    if (MENTAL_HEALTH_RE.test(text)) detected.isMentalHealth = true;
    if (CHRONIC_RE.test(text)) detected.isChronicFollowUp = true;
    return detected;
}

// Language marker sets — need >= 2 hits to switch (avoid false positives)
const LANGUAGE_MARKERS: Record<string, RegExp[]> = {
    pcm: [/\bdey\b/i, /\bwetin\b/i, /\babeg\b/i, /\bwahala\b/i, /\bpikin\b/i, /\bbell?e\b/i, /\bno fit\b/i, /\bwan make\b/i, /\bsabi\b/i, /\bkolo\b/i, /\bshey\b/i, /\bcomot\b/i],
    ha: [/\bina jin\b/i, /\bciwo\w*\b/i, /\bzazzabi\b/i, /\bjiki na\b/i, /\bkaina\b/i, /\bmara lafiya\b/i, /\bhaihuwa\b/i, /\bgobe\b/i, /\bjini\b/i, /\bamai\b/i],
    yo: [/\bmo ni\b/i, /\bara mi\b/i, /\binu mi\b/i, /\bori mi\b/i, /\bn dun( mi)?\b/i, /\biba\b/i, /\bomo mi\b/i, /\bjowo\b/i, /\bogun\b/i, /\baisan\b/i, /\bko le\b/i],
    ig: [/\bahu m\b/i, /\bisi m\b/i, /\bafo m\b/i, /\bbiko\b/i, /\bnwa m\b/i, /\bna.egbu m mgbu\b/i, /\boria\b/i, /\bahu oku\b/i, /\bogwu\b/i, /\bike gwuru m?\b/i],
};

/** Returns a language code when >= 2 markers of that language match, else null. */
export function detectLanguage(text: string): string | null {
    let best: { lang: string; hits: number } | null = null;
    for (const lang of Object.keys(LANGUAGE_MARKERS)) {
        const hits = LANGUAGE_MARKERS[lang].filter(re => re.test(text)).length;
        if (hits >= 2 && (!best || hits > best.hits)) best = { lang, hits };
    }
    return best ? best.lang : null;
}

// ── Red-flag library ────────────────────────────────────────

interface RedFlagDef {
    id: string;
    label: string;
    immediate: RegExp[]; // unmistakable → escalate NOW, no clarification loop
    clarify: RegExp[];   // ambiguous → two-step clarification via the model
}

export const RED_FLAG_LIBRARY: RedFlagDef[] = [
    {
        id: 'acs',
        label: 'Possible heart attack (acute coronary syndrome)',
        immediate: [
            /crushing (chest|heart) pain/i,
            /chest pain\b.{0,60}\b(left arm|jaw|sweat\w*|collapse)/i,
            /(heavy|squeez\w+|press\w+|tight\w*)\s.{0,30}chest.{0,60}(sweat\w*|dizz\w*|arm|jaw)/i,
            /\belephant (sitting|standing) on (my|the) chest\b/i,
        ],
        clarify: [/chest (dey )?pain/i, /\bchest pain\b/i, /heart dey (pain|beat)/i, /pain (for|in) my chest/i],
    },
    {
        id: 'stroke',
        label: 'Possible stroke (FAST signs)',
        immediate: [
            /face\s.{0,20}(droop\w*|bend\w*|twist\w*)/i,
            /(one side|half) (of )?(my |the |him |her )?(body|face)\s.{0,30}(weak|numb|dead|paraly)/i,
            /(can'?t|cannot|no fit|unable to) (talk|speak|move (my|his|her) (arm|leg|side))/i,
            /slurred speech|speech .{0,20}slurr/i,
            /sudden\w* .{0,30}(weak|numb)\w*.{0,30}(one side|arm|leg|face)/i,
        ],
        clarify: [/sudden (numbness|confusion)/i, /worst headache (of my life)?/i, /\bmouth (don )?(shift|bend)\b/i],
    },
    {
        id: 'sepsis',
        label: 'Possible sepsis (fever with altered consciousness)',
        immediate: [
            /(fever|high temperature|body (dey )?hot)\b.{0,80}(confus\w*|not responding|unconscious|can'?t wake|no dey answer|drowsy and weak)/i,
            /(confus\w*|unconscious|not responding)\b.{0,80}(fever|high temperature|body (dey )?hot)/i,
        ],
        clarify: [/(fever|body (dey )?hot).{0,60}(shiver\w*|rigor|heart (racing|beating fast)|breathing fast)/i],
    },
    {
        id: 'anaphylaxis',
        label: 'Possible anaphylaxis (severe allergic reaction)',
        immediate: [
            /throat\s.{0,20}(clos\w*|tight\w*|swell\w*)/i,
            /(swollen|swelling)\s.{0,20}(lips|tongue|face)\s.{0,50}(breath|allerg)/i,
            /(can'?t|cannot|no fit) breathe\b.{0,60}(hives|rash|allerg|sting|swell)/i,
            /(allerg\w+|sting|drug)\s.{0,50}(can'?t|cannot|no fit) breathe/i,
        ],
        clarify: [/allergic reaction/i, /\bhives\b/i, /body (dey )?(scratch|itch)\w*.{0,40}(swell|medicine|drug|food)/i],
    },
    {
        id: 'child_dehydration',
        label: 'Severe dehydration in a child',
        immediate: [
            /(child|baby|pikin|son|daughter)\b.{0,100}(no (urine|wee|piss)|not (urinat|passing urine)|sunken (eyes?|fontanelle)|floppy|lethargic|won'?t wake|not waking|vomits? everything)/i,
            /(sunken (eyes?|fontanelle)|floppy|won'?t wake)\b.{0,80}(child|baby|pikin)/i,
        ],
        clarify: [/(child|baby|pikin|son|daughter)\b.{0,80}(vomit\w*|diarrh\w*|purg\w*|watery stool|toilet\w* plenty)/i],
    },
    {
        id: 'obstetric_emergency',
        label: 'Obstetric emergency (bleeding / eclampsia / reduced fetal movement)',
        immediate: [
            /(pregnan\w*|carry\w* bell?e)\b.{0,100}(heavy bleed\w*|bleed\w* (a lot|plenty|heavily)|soak\w* (pad|cloth)|convuls\w*|seizure|fit\b)/i,
            /(heavy bleed\w*|convuls\w*|seizure)\b.{0,80}(pregnan\w*|carry\w* bell?e)/i,
            /baby (is not|not|no dey|has stopped|stopped) mov\w*/i,
            /(pregnan\w*)\b.{0,100}(severe headache|blurr\w* vision)\b.{0,60}(swell\w*|face|hands?)/i,
        ],
        clarify: [/(pregnan\w*|carry\w* bell?e)\b.{0,80}(bleed\w*|spott\w*|pain|headache|swell\w*|water (don )?br(ea|o)k)/i],
    },
    {
        id: 'meningitis',
        label: 'Possible meningitis',
        immediate: [
            /(stiff neck|neck (is )?stiff|neck no fit bend)\b.{0,80}(fever|body (dey )?hot|headache)/i,
            /(fever|headache)\b.{0,80}(stiff neck|neck (is )?stiff)/i,
            /(fever)\b.{0,60}(rash)\b.{0,60}(light hurts|can'?t stand light|photophobia)/i,
        ],
        clarify: [/stiff neck/i, /(severe|terrible) headache.{0,50}(fever|vomit)/i, /light (dey )?(hurt|pain) my eyes?/i],
    },
    {
        id: 'suicide_risk',
        label: 'Suicide / self-harm risk',
        immediate: [
            /\b(kill myself|end my life|take my( own)? life|commit suicide|suicidal?)\b/i,
            /\bwant(s)? to die\b/i,
            /\b(hurt|harm|cut)(ing)? myself\b/i,
            /\bno reason to (live|continue living)\b/i,
            /\bbetter off (dead|without me)\b/i,
            /\bplan(ning)? to (die|end it( all)?)\b/i,
            /\bi wan (die|kill myself)\b/i,
        ],
        clarify: [/\bhopeless\b/i, /\bno point (in )?(anything|living)\b/i, /\btired of (life|living|everything)\b/i, /\bdon tire for this life\b/i],
    },
    {
        id: 'acute_abdomen',
        label: 'Possible acute abdomen',
        immediate: [
            /(belly|stomach|abdom\w*|bell?e)\b.{0,60}(rigid|hard (as|like) (a )?(board|stone|wood))/i,
            /vomit\w*\s.{0,15}blood|blood (in|for) (my )?vomit/i,
            /(can'?t|cannot|no fit) (pass|poo|shit|stool|toilet)\b.{0,60}(swollen|swell\w*) (belly|bell?e|stomach)/i,
        ],
        clarify: [/(severe|terrible|worst|serious) (belly|stomach|abdominal|bell?e) pain/i, /bell?e (dey )?pain\w* (me )?(bad|serious|well ?well)/i],
    },
    {
        id: 'severe_malaria',
        label: 'Possible severe malaria',
        immediate: [
            /(fever|body (dey )?hot|malaria)\b.{0,80}(convuls\w*|seizure|fit\b|not responding|unconscious|can'?t wake)/i,
            /(dark|coca.?cola|coke|tea).?colou?r\w*\s?urine/i,
            /urine\s.{0,20}(dark|black|brown|like coca.?cola|like coke)/i,
            /(yellow (eyes?|skin))\b.{0,60}(fever|weak\w*|confus\w*)/i,
        ],
        clarify: [/(fever|malaria|body (dey )?hot)\b.{0,80}(vomit\w* everything|can'?t keep (anything|food|water) down|no fit (chop|drink))/i],
    },
    {
        id: 'respiratory_failure',
        label: 'Severe breathing difficulty',
        immediate: [
            /(can'?t|cannot|no fit) breathe at all/i,
            /\bgasping( for (air|breath))?\b/i,
            /(lips?|fingers?|skin)\s.{0,20}(turn\w*\s)?(blue|purple)/i,
            /(can'?t|cannot|no fit) (talk|speak|complete)\s.{0,20}(sentence|word)/i,
            /struggl\w+ to breathe right now/i,
        ],
        clarify: [/(hard|difficult) to breathe/i, /short(ness)? of breath/i, /no fit breathe well/i, /i dey breathe hard/i],
    },
    {
        id: 'unresponsive_or_seizing',
        label: 'Unconscious or actively seizing',
        immediate: [
            /\b(unconscious|unresponsive|not responding|fainted and (has not|no) w(a|o)ke)\b/i,
            /(seizure|convuls\w*|fit)\b.{0,40}(right now|happening now|now now|as we (speak|chat))/i,
            /(is )?(convulsing|seizing|shaking all over) (now|right now)/i,
        ],
        clarify: [/\bseizure\b/i, /\bconvuls\w*\b/i, /\bfainted?\b/i, /body (dey )?shake/i],
    },
    {
        id: 'uncontrolled_bleeding',
        label: 'Uncontrolled bleeding',
        immediate: [
            /bleed\w*\s.{0,50}(won'?t|will not|not|no dey) stop/i,
            /(soak\w*|soaking) (through )?(cloth|pad|bandage|towel)s?/i,
            /blood\s.{0,20}(gushing|pumping|everywhere)/i,
        ],
        clarify: [/\bbleed\w*\b/i, /blood (dey )?(comot|come out)/i],
    },
];

/**
 * Mask explicitly DENIED findings so an immediate-tier pattern cannot fire on
 * a patient's negatives. A thorough answer like "no vomiting, no fever, no neck
 * stiffness" used to satisfy the meningitis rule ("fever … neck stiff") and end
 * the history with a false emergency.
 *
 * Deliberately narrow (safety first):
 *  - cues: no / denies / denied / without / negative for / never (had) /
 *    don't|do not|didn't|did not have. "not" and "can't" are NOT cues — they
 *    carry positive findings ("not responding", "will not stop", "cannot breathe").
 *  - the word after "no"/"never" must not be one that makes a POSITIVE finding:
 *    Pidgin "no fit"/"no dey", "passed no urine/wee", "no reason/point to live",
 *    "no stop", "without stopping", "never woke", "no longer", "no more".
 *  - a denial runs until punctuation, "and" or "but".
 */
const DENIAL_SPAN_RE = new RegExp(
    String.raw`\b(?:no|denies|denied|deny|without|negative for|never(?: had)?|(?:don'?t|do not|didn'?t|did not) have)\s+` +
    String.raw`(?!(?:fit|dey|urine|wee|piss|reason|point|stop|stopping|woke|longer|more)\b)` +
    String.raw`[^,;.!?]{1,40}?(?=\s*(?:[,;.!?]|\band\b|\bbut\b|$))`,
    'gi'
);

export function maskDeniedFindings(text: string): string {
    return text.replace(DENIAL_SPAN_RE, ' [denied] ');
}

export function classifyRedFlags(text: string): { immediate: RedFlagHit[]; suspected: RedFlagHit[] } {
    const immediate: RedFlagHit[] = [];
    const suspected: RedFlagHit[] = [];
    const affirmedText = maskDeniedFindings(text);

    for (const def of RED_FLAG_LIBRARY) {
        let hit: RedFlagHit | null = null;
        let deniedMatch: string | null = null;
        for (const re of def.immediate) {
            const match = text.match(re);
            if (!match) continue;
            const affirmed = affirmedText.match(re);
            if (affirmed) {
                hit = { id: def.id, label: def.label, severity: 'immediate', matchedText: affirmed[0].slice(0, 120) };
                break;
            }
            // Matched only through denied findings — never escalate on that
            // alone, but keep it visible as an unconfirmed (clarify) flag.
            deniedMatch = deniedMatch || match[0];
        }
        if (hit) {
            immediate.push(hit);
            continue;
        }
        if (deniedMatch) {
            suspected.push({ id: def.id, label: def.label, severity: 'clarify', matchedText: deniedMatch.slice(0, 120) });
            continue;
        }
        for (const re of def.clarify) {
            const match = text.match(re);
            if (match) {
                suspected.push({ id: def.id, label: def.label, severity: 'clarify', matchedText: match[0].slice(0, 120) });
                break;
            }
        }
    }
    return { immediate, suspected };
}

/**
 * Patient-facing emergency action. No ambulance or care team comes to the
 * patient (not available in Nigeria today), so the patient must get themselves
 * to the hospital — with someone, never driving themselves. The text lives in
 * the shared copy module (one source for web, mobile and the CI scanner).
 */
import { GO_TEXT } from './emergency-copy';

/** Patient-facing directive for an immediate emergency escalation. */
export function emergencyDirective(
    hits: RedFlagHit[],
    location?: { kind?: 'home' | 'in_facility'; facilityName?: string | null; edCapable?: boolean; unverified?: boolean } | null,
): string {
    const isSuicide = hits.some(h => h.id === 'suicide_risk');
    const facilityName = location?.facilityName || 'this facility';
    // Only a CONFIRMED in-facility patient is told "stay where you are, staff
    // are coming". An unverified match (guest coordinates) gets both messages.
    const confirmedInFacility = location?.kind === 'in_facility' && !location.unverified;
    const unverifiedFacility = !!location?.unverified && !!location?.facilityName;

    if (isSuicide) {
        if (unverifiedFacility) {
            return '⚠️ I hear you, and I am really glad you told me. You matter, and help is available right now. '
                + `If you are inside ${location!.facilityName} right now, please tell a member of staff straight away so someone can stay with you. `
                + 'Otherwise, please go to the nearest hospital emergency room now, with someone you trust if you can. '
                + 'If you can, tell someone close to you — a family member, friend, or neighbour — so you are not alone. '
                + 'A doctor on this platform will also be alerted to speak with you urgently.';
        }
        if (confirmedInFacility) {
            return `⚠️ I hear you, and I am really glad you told me. You matter, and help is available right now. `
                + `Please stay where you are. A member of staff at ${facilityName} is coming to stay with you right now, and a doctor has been alerted. You are not alone.`;
        }
        return '⚠️ I hear you, and I am really glad you told me. You matter, and help is available right now. '
            + 'Please go to the nearest hospital emergency room now. '
            + 'If you can, ask someone close to you — a family member, friend, or neighbour — to go with you, so you are not alone. '
            + 'A doctor on this platform will also be alerted to speak with you urgently.';
    }

    if (confirmedInFacility) {
        if (location!.edCapable) {
            return `🚨 What you described requires immediate medical attention. `
                + `Stay where you are. You are being moved to the front of the queue, and the emergency clinical team here at ${facilityName} has been alerted and is attending to you now.`;
        } else {
            return `🚨 What you described requires immediate medical attention. `
                + `Stay where you are. Staff at ${facilityName} have been alerted and are attending to you right now. A doctor is being notified, and emergency arrangements are being coordinated.`;
        }
    }

    if (unverifiedFacility) {
        return `⚠️ What you have described sounds like a medical emergency. `
            + `If you are currently inside ${location!.facilityName}, please inform a member of staff immediately. `
            + `Otherwise, g${GO_TEXT.slice(1)} Do not wait for a doctor on this app.`;
    }

    const concern = hits[0]?.label ? ` (${hits.map(h => h.label).join('; ')})` : '';
    return `⚠️ What you have described sounds like a medical emergency${concern}. `
        + `${GO_TEXT} Do not wait for a doctor on this app.`;
}

// ── Early triage (provisional disposition + queue routing) ──

export type TriageCategory = 'emergency' | 'urgent' | 'routine';

export interface TriageDisposition {
    esiLevel: 1 | 2 | 3 | 4 | 5;
    category: TriageCategory;
    /** 0-1 (model-reported; deterministic sources use 1) */
    confidence: number;
    reason: string;
    source: 'red_flag' | 'floor_rule' | 'model';
}

export interface UrgencyFloorHit {
    id: string;
    label: string;
    matchedText: string;
}

/**
 * Complaint classes that FLOOR the disposition at 'urgent' (ESI ≤ 3)
 * regardless of what the model says. Deliberately broad — the floor is a
 * safety net below the red-flag library (which handles true emergencies).
 */
export const URGENT_FLOOR_RULES: { id: string; label: string; patterns: RegExp[] }[] = [
    {
        id: 'chest_pain',
        label: 'Chest pain (any mention)',
        patterns: [/chest\s?.{0,20}pain/i, /pain\s.{0,15}(in|for|on) (my |the )?chest/i, /chest (dey )?pain/i, /heart (dey )?pain/i],
    },
    {
        id: 'breathing_difficulty',
        label: 'Breathing difficulty',
        patterns: [
            /(hard|difficult\w*|struggl\w+|trouble|wahala) (to |with )?breath\w*/i,
            /short(ness)? of breath/i, /(can'?t|cannot|no fit) breathe/i,
            /breathing (problem|difficulty|trouble|fast|hard)/i, /i dey breathe (hard|fast)/i,
        ],
    },
    {
        id: 'pregnancy_bleeding',
        label: 'Bleeding in pregnancy',
        patterns: [
            /(pregnan\w*|carry\w* bell?e|antenatal)\b.{0,120}(bleed\w*|spott\w*|blood)/i,
            /(bleed\w*|spott\w*)\b.{0,120}(pregnan\w*|carry\w* bell?e)/i,
        ],
    },
    {
        id: 'infant_fever',
        label: 'Fever in a child under 2',
        patterns: [
            /(newborn|infant|\bbaby\b|\d+\s*(week|month)s?[- ]old|\bone year old\b|\b1 year old\b).{0,120}(fever|temperature|body (dey )?hot|\bhot\b)/i,
            /(fever|temperature|body (dey )?hot).{0,120}(newborn|infant|\bbaby\b|\d+\s*(week|month)s?[- ]old|\bone year old\b|\b1 year old\b)/i,
        ],
    },
    {
        id: 'altered_consciousness',
        label: 'Altered consciousness',
        patterns: [
            /confus\w*/i, /drowsy/i, /(hard|difficult) to wake/i, /faint\w*/i,
            /not (fully )?(awake|alert)/i, /unrespons\w*/i, /not responding/i,
            /no dey answer/i, /altered (mental|consciousness)/i, /\bblack(ed)? out\b/i,
        ],
    },
];

export function classifyUrgencyFloor(text: string): UrgencyFloorHit[] {
    const hits: UrgencyFloorHit[] = [];
    for (const rule of URGENT_FLOOR_RULES) {
        for (const re of rule.patterns) {
            const match = text.match(re);
            if (match) {
                hits.push({ id: rule.id, label: rule.label, matchedText: match[0].slice(0, 120) });
                break;
            }
        }
    }
    return hits;
}

const CATEGORY_RANK: Record<TriageCategory, number> = { emergency: 0, urgent: 1, routine: 2 };

function esiToCategory(esi: number): TriageCategory {
    if (esi <= 1) return 'emergency';
    if (esi <= 3) return 'urgent';
    return 'routine';
}

function clampEsi(value: any): 1 | 2 | 3 | 4 | 5 | null {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(5, Math.max(1, Math.round(n))) as 1 | 2 | 3 | 4 | 5;
}

/**
 * Deterministically resolve the provisional triage disposition for a turn.
 * Rules (in priority order):
 *  1. Confirmed red flag → emergency / ESI 1 (always overrides everything).
 *  2. Model triage block accepted, but clamped for internal consistency
 *     (category is derived from esiLevel; a more-urgent model category pulls
 *     the esiLevel up to match — never the other way down).
 *  3. Urgency floor rules → at minimum 'urgent' / ESI 3.
 *  4. NEVER auto-downgrade: the previous disposition wins if more urgent.
 */
export function resolveTriage(opts: {
    modelTriage?: any;
    floorHits?: UrgencyFloorHit[];
    redFlagEmergency?: boolean;
    previous?: TriageDisposition | null;
}): TriageDisposition | null {
    const { modelTriage, floorHits = [], redFlagEmergency = false, previous = null } = opts;

    if (redFlagEmergency) {
        return {
            esiLevel: 1, category: 'emergency', confidence: 1,
            reason: 'Red-flag emergency detected during intake', source: 'red_flag',
        };
    }
    if (previous?.category === 'emergency') return previous; // emergency is sticky

    // Candidate from the model's provisional triage block (if valid)
    let candidate: TriageDisposition | null = null;
    if (modelTriage && typeof modelTriage === 'object') {
        const esi = clampEsi(modelTriage.esiLevel);
        if (esi !== null) {
            let category = esiToCategory(esi);
            let level = esi;
            // If the model's own category is MORE urgent than its esiLevel implies, honour the category
            const modelCat = typeof modelTriage.category === 'string' ? modelTriage.category.toLowerCase() : '';
            if ((modelCat === 'emergency' || modelCat === 'urgent') && CATEGORY_RANK[modelCat as TriageCategory] < CATEGORY_RANK[category]) {
                category = modelCat as TriageCategory;
                level = (category === 'emergency' ? 1 : 3) as 1 | 3;
            }
            const conf = Number(modelTriage.confidence);
            candidate = {
                esiLevel: level, category,
                confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
                reason: (typeof modelTriage.reason === 'string' && modelTriage.reason.trim())
                    ? modelTriage.reason.trim().slice(0, 300) : 'Model provisional triage',
                source: 'model',
            };
        }
    }

    // Urgency floor: certain complaint classes can never be triaged below 'urgent'
    if (floorHits.length > 0) {
        const floorReason = `Urgency floor: ${floorHits.map(h => h.label).join('; ')}`;
        if (!candidate) {
            candidate = { esiLevel: 3, category: 'urgent', confidence: 1, reason: floorReason, source: 'floor_rule' };
        } else if (CATEGORY_RANK[candidate.category] > CATEGORY_RANK.urgent) {
            candidate = {
                esiLevel: 3, category: 'urgent', confidence: 1,
                reason: `${floorReason} (model suggested ${candidate.category})`, source: 'floor_rule',
            };
        }
    }

    if (!candidate) return previous;
    if (!previous) return candidate;

    // Upward revision only: keep whichever is MORE urgent (previous wins ties)
    if (CATEGORY_RANK[candidate.category] < CATEGORY_RANK[previous.category]) return candidate;
    if (CATEGORY_RANK[candidate.category] === CATEGORY_RANK[previous.category] && candidate.esiLevel < previous.esiLevel) return candidate;
    return previous;
}

/**
 * Queue rank for a consultation doc: 0 = emergency, 1 = urgent, 2 = routine/untriaged.
 * Reads the additive `triageCategory` field, falling back to the legacy
 * `urgencyLevel`/`esiLevel` fields written by the emergency escalation path.
 */
export function consultationTriageRank(c: { triageCategory?: string; urgencyLevel?: string; esiLevel?: number }): number {
    const cat = c?.triageCategory || c?.urgencyLevel;
    if (cat === 'emergency') return 0;
    if (cat === 'urgent') return 1;
    if (typeof c?.esiLevel === 'number') return CATEGORY_RANK[esiToCategory(c.esiLevel)];
    return 2;
}

/**
 * Comparator for the doctor claim queue: triage priority first
 * (emergency → urgent → routine), then ESI, then scheduled/created time
 * ascending (unchanged behaviour within the same priority band).
 */
export function compareConsultationsByTriage(
    a: any, b: any,
    toMillisFn: (v: any) => number = defaultToMillis
): number {
    const rankDiff = consultationTriageRank(a) - consultationTriageRank(b);
    if (rankDiff !== 0) return rankDiff;
    const esiA = typeof a?.esiLevel === 'number' ? a.esiLevel : 6;
    const esiB = typeof b?.esiLevel === 'number' ? b.esiLevel : 6;
    if (esiA !== esiB) return esiA - esiB;
    return toMillisFn(a?.scheduledAt ?? a?.createdAt) - toMillisFn(b?.scheduledAt ?? b?.createdAt);
}

function defaultToMillis(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    const seconds = value._seconds ?? value.seconds;
    if (typeof seconds === 'number') return seconds * 1000;
    if (value instanceof Date) return isNaN(value.getTime()) ? 0 : value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const parsed = new Date(value).getTime();
        return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

// ── Prompt builders (deterministic strings for the model) ───

/**
 * Prompt addendum for returning patients: instructs the model to CONFIRM
 * carried history (one grouped confirmation per domain) instead of re-asking,
 * and to report the outcome via extraction.confirmations.
 */
export function buildCarryOverAddendum(state: HistoryState): string {
    const pending = unconfirmedCarriedDomains(state);
    if (!state.carryOver || pending.length === 0) return '';

    const domainLabel: Record<string, string> = {
        medications: 'Current medications',
        allergies: 'Allergies',
        pastMedical: 'Past medical history',
        pastSurgical: 'Past surgical history',
        familyHistory: 'Family history',
        socialHistory: 'Social history',
    };
    const lines = Object.keys(state.carryOver.priorValues).map(d => {
        const isPending = pending.includes(d);
        const suffix = isPending ? '' : ' (already complete on file)';
        return `- ${domainLabel[d] || d}: "${state.carryOver!.priorValues[d]}"${suffix}`;
    });
    const safetyPending = pending.filter(d => (SAFETY_CARRY_DOMAINS as readonly string[]).includes(d));

    return `\n\nRETURNING PATIENT — HISTORY CARRIED FROM THE LAST VISIT (${state.carryOver.sourceCompletedAt.slice(0, 10)}):
${lines.join('\n')}
ONCE-ONLY STATIC HISTORY RULE: Past medical history, Past surgical history, Family history, Social history, and Obstetric parity (gravida/para) are taken ONCE and are ALREADY COMPLETE on file above — DO NOT ask the patient about Past medical, Past surgical, Family, Social, or Obstetric parity history again unless the patient volunteers a change.
For safety domains (Current medications and Allergies), do NOT re-take the history from scratch. Instead CONFIRM them with ONE short grouped question, e.g. "Last time you told us you take [X] — has anything changed?". If the patient says nothing changed, record it in "extraction.confirmations" as "unchanged". If they report a change, record the NEW full value in the extraction field AND set "extraction.confirmations" to "updated" for that domain.
${safetyPending.length ? `SAFETY: ${safetyPending.map(d => domainLabel[d]).join(' and ')} MUST be explicitly confirmed this visit before the intake can complete — never assume they are unchanged.` : ''}
Add to your extraction JSON: "confirmations": {${safetyPending.map(d => `"${d}": "unchanged|updated"`).join(', ')}} (only include domains the patient has actually confirmed or updated).`;
}

export function buildSituationAddendums(context: ContextFlags): string {
    const sections: string[] = [];
    if (context.isPediatric) {
        sections.push(`PEDIATRIC MODE (a caregiver is answering for a child):
- Address the caregiver ("your child"), never assume the patient is typing.
- You MUST establish: the child's age AND approximate weight; feeding/drinking status (breastfeeding, taking fluids, refusing food); immunization status (up to date? recent vaccines?); and behaviour during fever (playing, dull, crying nonstop, convulsions).
- Danger signs to actively check: not able to drink or breastfeed, vomits everything, convulsions, lethargic or unconscious, fast/difficult breathing, sunken eyes, no urine. Any of these = emergency.`);
    }
    if (context.isObstetric) {
        sections.push(`OBSTETRIC MODE (the patient is or may be pregnant):
- You MUST establish: last menstrual period (LMP); gravida/para ("How many times have you been pregnant, and how many children have you delivered?" — ask simply); estimated gestational age (in weeks or months); any bleeding, abdominal pain, or change in the baby's movement.
- Danger signs to actively check: heavy vaginal bleeding, severe headache with blurred vision or swelling of face/hands (possible pre-eclampsia), convulsions, fever, the baby not moving, water breaking early. Any of these = emergency.`);
    }
    if (context.isMentalHealth) {
        sections.push(`MENTAL HEALTH MODE:
- Use gentle, non-judgmental, stigma-free language. Never say "crazy", "mad", or dismiss feelings. Normalise: "Many people feel this way, and it is okay to talk about it."
- Screen mood, sleep, and appetite changes.
- MANDATORY SAFETY SCREEN: you MUST ask, kindly and directly, whether they have had thoughts of harming themselves or ending their life (e.g., "Sometimes when people feel this low, they have thoughts of hurting themselves or that life is not worth living. Have you had any thoughts like that?"). If YES or ambiguous-yes, set emergencyDetected to true immediately and give the emergency instructions with warmth.`);
    }
    if (context.isChronicFollowUp) {
        sections.push(`CHRONIC FOLLOW-UP MODE (existing condition review):
- You MUST establish: medication adherence ("Are you still taking your medicines every day? Have you missed doses or run out?"); symptom trajectory since the last visit (better / same / worse, with specifics); and screening for complications relevant to the condition (e.g., diabetes: vision changes, foot sores, numbness; hypertension: headaches, chest pain, swelling; asthma: night waking, rescue-inhaler use; sickle cell: crisis frequency, fever).`);
    }
    return sections.length ? '\n\n' + sections.join('\n\n') : '';
}

/**
 * Everyday, basic-schooling (Grade 4-5) phrasing hints for each clinical domain.
 * Prevents the LLM from leaking clinical/textbook words ("characteristics",
 * "aggravating", "relieving", "review of systems", "manifestations") to patients.
 */
export const PLAIN_LANGUAGE_DOMAIN_GUIDE: Record<string, string> = {
    presentingComplaint: 'Ask simply: "What problem or discomfort is bothering you today?"',
    'hpi.onset': 'Ask simply: "When did this start? Was it today, a few days ago, or longer?"',
    'hpi.location': 'Ask simply: "Where on your body do you feel it? For example, is it on the front, back, left side, right side, or all over?"',
    'hpi.duration': 'Ask simply: "Is the feeling there all the time, or does it come and go?"',
    'hpi.characteristics': 'Ask simply: "How does it feel? For example, is it sharp, dull, burning, throbbing, or tight?" (NEVER use the words "characteristics" or "quality")',
    'hpi.aggravating': 'Ask simply: "Is there anything that makes it feel worse — like moving, eating, coughing, or lying down?" (NEVER use the words "aggravating" or "exacerbating")',
    'hpi.relieving': 'Ask simply: "Is there anything that helps it feel better — like resting, drinking water, or sitting up?" (NEVER use the words "relieving" or "alleviating")',
    'hpi.treatmentTried': 'Ask simply: "Have you taken any medicine or home remedy for this yet?"',
    'hpi.severity': 'Ask simply: "From 1 to 10, where 1 is very small and 10 is the worst pain or discomfort you have ever felt, what number is it now?"',
    medications: 'Ask simply: "Are you taking any regular medicines, chemist drugs, or herbal remedies right now?"',
    allergies: 'Ask simply: "Does any medicine or food give you a bad reaction, like a rash or swelling?"',
    pastMedical: 'Ask simply: "Do you have any long-term health problems, like high blood pressure, sugar (diabetes), asthma, or ulcer?"',
    pastSurgical: 'Ask simply: "Have you ever had an operation (surgery) or been admitted to a hospital before?"',
    familyHistory: 'Ask simply: "Does anyone in your close family (parents, brothers, or sisters) have health problems like high blood pressure, diabetes, or heart trouble?"',
    socialHistory: 'Ask simply: "What kind of work do you do, and do you smoke or drink alcohol?"',
    reviewOfSystems: 'Ask simply about 1 or 2 related everyday symptoms: "Apart from this, have you noticed fever, vomiting, cough, or body weakness?" (NEVER say "review of systems" or "associated symptoms/manifestations")',
    'pediatric.ageWeight': 'Ask simply: "How old is the child, and roughly how much do they weigh?"',
    'pediatric.feedingStatus': 'Ask simply: "Is the child still eating, drinking water, or breastfeeding well?"',
    'pediatric.immunizationStatus': 'Ask simply: "Are the child\'s baby clinic vaccines up to date?"',
    'pediatric.behaviorDuringFever': 'Ask simply: "How is the child acting — are they still playing, or are they very weak and sleepy?"',
    'obstetric.lmp': 'Ask simply: "When did you see your last monthly period?"',
    'obstetric.gravidaPara': 'Ask simply: "How many times have you been pregnant, and how many babies have you given birth to?"',
    'obstetric.gestationalAge': 'Ask simply: "How many months or weeks pregnant are you now?"',
    'obstetric.dangerSigns': 'Ask simply: "Have you noticed any bleeding, strong headache, blurred eyesight, face/hand swelling, or less baby movement?"',
    'mentalHealth.moodSleepAppetite': 'Ask simply: "How have your sleep, appetite, and mood been lately?"',
    'mentalHealth.suicidalIdeation': 'Ask gently and simply: "Sometimes when people feel very down, they have thoughts of hurting themselves. Have you had any thoughts like that?"',
    'chronicFollowUp.adherence': 'Ask simply: "Have you been able to take your regular medicines every day, or have you missed any?"',
    'chronicFollowUp.trajectory': 'Ask simply: "Since your last check-up, has your condition felt better, the same, or worse?"',
    'chronicFollowUp.complications': 'Ask simply: "Have you noticed any new problems like blurry eyesight, foot sores, chest pain, or leg swelling?"',
};

/**
 * Per-turn steering note injected into the system prompt so the model
 * targets the most important INCOMPLETE domain next.
 */
export function buildSteeringNote(
    state: HistoryState,
    completeness: Completeness,
    turnCount: number,
    maxTurns: number,
    suspectedRedFlags: RedFlagHit[] = []
): string {
    const lines: string[] = ['\n\n=== CURRENT INTAKE STATE (system-generated — do not mention to the patient) ==='];
    lines.push(`HISTORY COLLECTED SO FAR (do NOT re-ask anything already answered):\n${JSON.stringify(state)}`);
    if (completeness.missing.length > 0) {
        lines.push(`MISSING REQUIRED DOMAINS (priority order): ${completeness.missing.join(', ')}`);
        const first = completeness.missing[0];
        if (getDomainProvenance(state, first) === 'carried_unconfirmed') {
            lines.push(`Your NEXT question must CONFIRM the carried-over domain "${first}" (value from the last visit is already recorded above): ask ONE short "has anything changed since last time?" question — do NOT re-take it from scratch. Report the outcome in extraction.confirmations. Do NOT set isComplete to true while required domains are missing.`);
        } else {
            lines.push(`Your NEXT question must target the FIRST missing domain: "${first}". Do NOT set isComplete to true while required domains are missing — an explicit denial (e.g. "no known allergies", "none") counts as filled if you record it in the extraction.`);
            const plainGuide = PLAIN_LANGUAGE_DOMAIN_GUIDE[first];
            if (plainGuide) {
                lines.push(`PLAIN-ENGLISH PHRASING FOR "${first}": ${plainGuide}`);
            }
        }
    } else {
        lines.push('All required domains are filled. Confirm anything unclear, then close the intake and set isComplete to true.');
    }
    if (suspectedRedFlags.length > 0) {
        lines.push(`POSSIBLE EMERGENCY MENTIONED (unconfirmed): ${suspectedRedFlags.map(f => f.label).join('; ')}. Before anything else, ask ONE clarifying question to confirm or rule out this emergency (is it happening RIGHT NOW, and how severe?). If confirmed, set emergencyDetected to true.`);
    }
    const turnsLeft = maxTurns - turnCount;
    if (turnsLeft <= 8) {
        lines.push(`ONLY ${turnsLeft} QUESTIONS LEFT. Combine efficiently: ask only the most clinically important missing domains, and accept brief answers.`);
    }
    return lines.join('\n');
}
