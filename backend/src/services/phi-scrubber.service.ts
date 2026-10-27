// ============================================================
// Docarion TaaS — PHI Scrubber Service
//
// Conservative text-boundary de-identification for AI egress.
// Strips direct identifiers plus Nigerian-specific PII (NIN, BVN,
// NHIA IDs) from free-text clinical data. Image/audio modalities
// cannot be made safe by this text scrubber and must be rejected at
// their own boundary unless a prior deterministic de-identification
// step has already produced text.
//
// Used by: ai-intake.service.ts, training-data.service.ts
// ============================================================

import log from '../utils/logger';

// ── Replacement tokens ──────────────────────────────────────

const T = {
    EMAIL:      '[EMAIL_REDACTED]',
    PHONE:      '[PHONE_REDACTED]',
    DOB:        '[DOB_REDACTED]',
    NIN:        '[NIN_REDACTED]',
    BVN:        '[BVN_REDACTED]',
    ID:         '[ID_REDACTED]',
    PASSPORT:   '[PASSPORT_REDACTED]',
    ADDRESS:    '[ADDRESS_REDACTED]',
    POBOX:      '[POBOX_REDACTED]',
    MRN:        '[MRN_REDACTED]',
    INSURANCE:  '[INSURANCE_REDACTED]',
    IPV4:       '[IP_REDACTED]',
    IPV6:       '[IP_REDACTED]',
    SSN:        '[SSN_REDACTED]',
    NAME:       '[NAME_REDACTED]',
} as const;

// ── Regex patterns ──────────────────────────────────────────

// Email addresses
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Z|a-z]{2,}\b/g;

// Phone numbers — Nigerian formats (+234, 0-prefix, spaced/hyphenated) and international (E.164)
const PHONE_NIGERIAN_RE = /(?:\+234[\s\-]?|0)[789](?:[\s\-]?\d){9}\b/g;
const PHONE_INTL_RE = /\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}\b/g;

// Dates of birth — multiple formats
// DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
const DOB_DMY_RE = /\b(0?[1-9]|[12]\d|3[01])[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](19|20)\d{2}\b/g;
// YYYY-MM-DD (ISO)
const DOB_ISO_RE = /\b(19|20)\d{2}[\-\/](0?[1-9]|1[0-2])[\-\/](0?[1-9]|[12]\d|3[01])\b/g;
// "January 15, 1990" or "15 January 1990" or "Jan 15 1990"
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DOB_WRITTEN_RE = new RegExp(
    `\\b(?:(?:${MONTHS})\\s+\\d{1,2},?\\s+(?:19|20)\\d{2}|\\d{1,2}\\s+(?:${MONTHS}),?\\s+(?:19|20)\\d{2})\\b`,
    'gi'
);

// NIN (National Identification Number) — exactly 11 digits
const NIN_RE = /\b\d{11}\b/g;
// BVN (Bank Verification Number) — exactly 11 digits (same pattern, context flags both)

// Nigerian 10-digit NUBAN bank account numbers (in dialogue or with banking context)
const BANK_ACCOUNT_RE = /\b((?:(?:transfer|pay|send)\s+(?:the\s+refund\s+)?to\s+)?(?:(?:[A-Za-z]+\s+)?(?:bank\s+)?(?:account(?:\s*(?:number|no\.?))?|acct(?:\s*(?:number|no\.?))?|nuban)|(?:Access|Zenith|GTB(?:ank)?|First\s*Bank|UBA|Fidelity|FCMB|Stanbic|Sterling|Wema|Polaris|Keystone|Ecobank|Union|Kuda|Opay|Moniepoint|PalmPay|Providus)\s+(?:bank\s+)?)(?:\s+is)?\s*[:=#\-]?\s*)(\d{10})\b/gi;

// Passport numbers — Nigerian passports (A followed by 8 digits) + generic
const PASSPORT_NIGERIAN_RE = /\b[A-Z]\d{8}\b/g;
const PASSPORT_GENERIC_RE = /\b(?:passport\s*(?:no|number|#)?:?\s*)([A-Z0-9]{6,9})\b/gi;

// Street addresses — heuristic: number + street name + street type
const STREET_RE = /\b\d{1,5}\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Close|Crescent|Cres|Way|Court|Ct|Terrace|Place|Pl)\b\.?/gi;

// P.O. Box
const POBOX_RE = /\b(?:P\.?\s*O\.?\s*Box|PMB)\s*\d+\b/gi;

// Health record / medical record numbers — MRN-XXXXXX or MR-XXXXX patterns
const MRN_RE = /\b(?:MRN|MR|HRN|HR|RN|NHIA)[\-\s]?\d{4,10}\b/gi;
// Enterprise Docarion MRNs:
//   DCR-MRN-0000000001-X
//   DCR-ORG-<scope>-MRN-00000001-X
//   DCR-SITE-<scope>-MRN-00000001-X
const DOCARION_MRN_RE = /\bDCR(?:-(?:ORG|SITE)-[A-F0-9]{10})?-MRN-\d{8,10}-[A-Z0-9]\b/gi;
// Human-readable workflow identifiers are linkable health-record identifiers
// even when they do not contain a patient name.
const DOCARION_RECORD_ID_RE = /\bDCR-(?:RX|LAB|RAD|REF|ADM|INV|DLV|APT|CON|PAY|CLM|SPC)-\d{4}-\d{10}-[A-Z0-9]\b/gi;

// Insurance policy numbers — common prefixes
const INSURANCE_RE = /\b(?:HMO|NHIS|INS|POL|POLICY)[\-\s]?\d{4,12}\b/gi;

// IP addresses (IPv4)
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

// IP addresses (IPv6) — full and abbreviated
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
const IPV6_ABBREV_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,7}:[0-9a-fA-F]{0,4}\b/g;

// US SSN (in case of international patients)
const SSN_RE = /\b\d{3}[\-\s]?\d{2}[\-\s]?\d{4}\b/g;

// Explicit name-bearing labels and common self-identification phrases.
// A free-form capitalized word is not automatically a name (it may be a drug,
// diagnosis, tribe, place, or ordinary sentence start), so callers should also
// supply known identifiers when they have access to the patient profile.
const LABELED_NAME_RE = /\b(Patient(?:[ \t]+(?:[Ff]ull[ \t]+)?[Nn]ame)?|[Ff]ull[ \t]+[Nn]ame|[Ff]irst[ \t]+[Nn]ame|[Ll]ast[ \t]+[Nn]ame)\s*[:=\-]\s*([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}(?:[ \t]+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}){0,3})/g;
const INTRODUCED_NAME_RE = /\b((?:My|my)[ \t]+(?:Name|name)[ \t]+(?:Is|is))[ \t]+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}(?:[ \t]+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}){0,3})/g;
const SPOKEN_NAME_RE = /\b((?:I|i)(?:'m| am)|(?:This|this) is|(?:Patient|patient) is|(?:Called|called)|(?:Named|named))[ \t]+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}(?:[ \t]+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}){0,3})/g;
const CLINICAL_SUBJECT_NAME_RE = /\b([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}(?:[ \t]+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39})?)(?=[ \t]+(?:reports?|says?|states?|presents?|complains?|has|had|was|is|denies?|describes?|feels?|needs?|requires?)\b)/g;
const TITLED_NAME_RE = /\b(Mr|Mrs|Ms|Miss|Master|Chief|Alhaji|Hajia|Pastor|Dr)\.?[ \t]+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}(?:[ \t]+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39}){0,3})/g;
const GREETING_NAME_RE = /\b(Dear|Hello|Hi)\s+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{1,39})(?=[,!.]|\s)/g;

// Identifiers serialized into a prompt as JSON or as a labelled line.
const JSON_PII_VALUE_RE = /(["']?(?:firstName|lastName|fullName|patientName|email|phone|phoneNumber|mobile|address|street|dateOfBirth|dob|birthDate|nin|nationalId|idNumber|bvn|mrn|medicalRecordNumber|patientId|userId|insuranceId|hmoId|policyNumber|passportNumber|account|accountNumber|bankAccount|nuban)["']?\s*:\s*["'])([^"'\r\n]{1,200})(["'])/gi;
const LABELED_ID_RE = /\b(Patient\s*ID|User\s*ID|Medical\s*Record\s*(?:Number|No\.?)|MRN|NIN|BVN|NHIA\s*ID|Policy\s*(?:Number|No\.?)|Account\s*(?:Number|No\.?)|Acct\s*(?:No\.?|Number)|NUBAN|Bank\s*Account)\s*[:=#\-]\s*([A-Za-z0-9_.\-]{4,128})\b/gi;

export type PHICategory =
    | 'email'
    | 'phone'
    | 'date'
    | 'government_id'
    | 'passport'
    | 'address'
    | 'medical_record'
    | 'insurance'
    | 'network'
    | 'name'
    | 'known_identifier';

export interface PHIFinding {
    category: PHICategory;
    count: number;
}

export interface PHIScrubResult {
    scrubbed: string;
    findings: PHIFinding[];
    redactionCount: number;
}

function countMatches(text: string, pattern: RegExp): number {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return Array.from(text.matchAll(new RegExp(pattern.source, flags))).length;
}

function addFinding(counts: Map<PHICategory, number>, category: PHICategory, count: number): void {
    if (count > 0) counts.set(category, (counts.get(category) || 0) + count);
}

// Words that commonly appear capitalized at the start of sentences, questions,
// greetings, or clinical notes and must NEVER be mistaken for a person's name
// by heuristic regexes (SPOKEN_NAME_RE, CLINICAL_SUBJECT_NAME_RE, GREETING_NAME_RE).
const NON_NAME_TOKENS = new Set([
    // Interrogatives, pronouns, determiners, conjunctions, prepositions
    'what', 'where', 'when', 'why', 'who', 'whom', 'whose', 'which', 'how',
    'there', 'here', 'this', 'that', 'these', 'those', 'it', 'its', 'he', 'him', 'his',
    'she', 'her', 'hers', 'they', 'them', 'their', 'theirs', 'we', 'us', 'our', 'ours',
    'you', 'your', 'yours', 'i', 'me', 'my', 'mine', 'myself', 'yourself', 'himself', 'herself',
    'someone', 'somebody', 'anyone', 'anybody', 'everyone', 'everybody', 'nobody', 'nothing',
    'something', 'anything', 'everything', 'none', 'all', 'both', 'each', 'either', 'neither',
    'other', 'another', 'such', 'same', 'some', 'any', 'no', 'not', 'yes', 'okay', 'ok',
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'so', 'because', 'since',
    'while', 'although', 'though', 'unless', 'until', 'before', 'after', 'during', 'within',
    'without', 'about', 'above', 'across', 'against', 'along', 'among', 'around',
    'as', 'at', 'behind', 'below', 'beneath', 'beside', 'between', 'beyond', 'by', 'down',
    'from', 'in', 'inside', 'into', 'near', 'of', 'off', 'on', 'onto', 'out', 'outside',
    'over', 'past', 'through', 'throughout', 'to', 'toward', 'towards', 'under', 'underneath',
    'up', 'upon', 'with',
    // Nigerian Pidgin question/pronoun tokens
    'wetin', 'abi', 'una', 'dey', 'na', 'make', 'fit', 'wan', 'sabi', 'pikin', 'belle',
    // Roles, titles, greetings, system terms
    'patient', 'patients', 'doctor', 'doctors', 'doc', 'arion', 'docarion', 'nurse', 'nurses',
    'pharmacist', 'clinician', 'assistant', 'provider', 'hospital', 'clinic', 'pharmacy',
    'laboratory', 'lab', 'radiology', 'station', 'kiosk', 'triage', 'intake', 'emergency',
    'urgent', 'routine', 'medical', 'clinical', 'health', 'care', 'system', 'summary',
    'team', 'friend', 'sir', 'ma', 'madam', 'boss', 'hello', 'hi', 'dear', 'hey', 'welcome',
    // Common clinical nouns, symptoms, body parts, adjectives, states
    'pain', 'fever', 'cough', 'headache', 'nausea', 'vomiting', 'diarrhea', 'diarrhoea',
    'dizziness', 'fatigue', 'weakness', 'bleeding', 'swelling', 'rash', 'itching', 'chills',
    'sweating', 'shortness', 'breathing', 'breath', 'chest', 'stomach', 'abdomen', 'abdominal',
    'back', 'neck', 'head', 'throat', 'eye', 'eyes', 'ear', 'ears', 'nose', 'mouth', 'tooth',
    'arm', 'leg', 'hand', 'foot', 'joint', 'muscle', 'skin', 'heart', 'lung', 'kidney', 'liver',
    'blood', 'pressure', 'sugar', 'glucose', 'temperature', 'pulse', 'oxygen', 'weight', 'height',
    'malaria', 'typhoid', 'infection', 'ulcer', 'asthma', 'diabetes', 'diabetic', 'hypertension',
    'hypertensive', 'pregnant', 'pregnancy', 'allergy', 'allergies', 'allergic', 'medication',
    'medications', 'medicine', 'drug', 'drugs', 'treatment', 'surgery', 'surgical', 'history',
    'symptom', 'symptoms', 'condition', 'conditions', 'problem', 'issue', 'onset', 'duration',
    'severity', 'location', 'character', 'characteristics', 'aggravating', 'relieving',
    'today', 'yesterday', 'tomorrow', 'morning', 'afternoon', 'evening', 'night', 'daily',
    'weekly', 'monthly', 'currently', 'recently', 'previously', 'usually', 'always', 'never',
    'sometimes', 'often', 'rarely', 'now', 'still', 'already', 'just', 'only', 'very', 'quite',
    'feeling', 'experiencing', 'having', 'taking', 'using', 'doing', 'going', 'coming',
    'starting', 'getting', 'seeing', 'looking', 'asking', 'calling', 'waiting',
    'fine', 'good', 'well', 'bad', 'worse', 'better', 'severe', 'mild', 'moderate', 'acute',
    'chronic', 'stable', 'normal', 'high', 'low', 'positive', 'negative', 'unknown',
    'nigeria', 'nigerian', 'lagos', 'abuja', 'kano', 'ibadan', 'port', 'harcourt', 'lekki',
    'english', 'pidgin', 'hausa', 'yoruba', 'igbo', 'french',
]);

// Names that double as common lowercase English words ("will", "may", "can", "joy", etc.)
// should only be scrubbed case-sensitively when matched via `knownIdentifiers`.
const COMMON_ENGLISH_HOMOGRAPH_NAMES = new Set([
    'will', 'may', 'can', 'joy', 'grace', 'hope', 'faith', 'peace', 'love',
    'patience', 'comfort', 'blessing', 'good', 'best', 'bright', 'precious',
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
    'january', 'february', 'march', 'april', 'june', 'july', 'august',
    'patient', 'user', 'test', 'doctor', 'nurse', 'admin', 'guest', 'walk', 'in',
    'what', 'where', 'when', 'who', 'how', 'hi', 'hello',
]);

function isLikelyPersonNameCandidate(candidate: string): boolean {
    if (!candidate || typeof candidate !== 'string') return false;
    const words = candidate
        .trim()
        .split(/\s+/)
        .map(w => w.replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g, '').toLowerCase())
        .filter(Boolean);
    if (words.length === 0) return false;
    // If the first word or every word is a known non-name token (e.g. "What", "Where",
    // "Pain", "Doctor", "Doc Arion"), do not treat it as a person's name.
    if (NON_NAME_TOKENS.has(words[0])) return false;
    if (words.every(w => NON_NAME_TOKENS.has(w))) return false;
    return true;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean up any residual `[NAME_REDACTED]` / `[REDACTED]` markers in conversational
 * chat text so patients never see or hear robotic redaction placeholders while
 * zero PII is ever transmitted to or from the model.
 */
export function cleanConversationalRedactions(text: string): string {
    if (!text || typeof text !== 'string') return text;
    return text
        // Repair false-positive question openings: "[NAME_REDACTED] is the main..." -> "What is the main..."
        .replace(/(?:^|(?<=[.!?]\s+))\[NAME_REDACTED\]\s+(?=(?:is|was|has|had|are|were|can|could|will|would|do|does|did|brings|brought)\b)/gi, 'What ')
        // Repair dropped-pronoun question openings: "Is the main health problem..." -> "What is the main health problem..."
        .replace(/(?:^|(?<=[.!?]\s+))Is\s+(the\s+(?:main|primary)\s+(?:health\s+)?(?:problem|issue|symptom|reason|concern)\b)/g, 'What is $1')
        // Smooth greetings: "Hello [NAME_REDACTED]," -> "Hello,"
        .replace(/\b(Hello|Hi|Dear|Hey|Welcome|Thank you|Thanks),?\s*\[NAME_REDACTED\]([!.,?]?)/gi, '$1$2')
        // Smooth self-introductions in user messages: "my name is [NAME_REDACTED]" -> ""
        .replace(/\b(?:my name is|i am|i'm|this is|called|named)\s+\[NAME_REDACTED\][,.!]?\s*/gi, '')
        // Remove any remaining bracketed redaction tokens cleanly
        .replace(/\s*\[(?:NAME|PHONE|EMAIL|DOB|ID|MRN|NIN|BVN|ADDRESS|PASSPORT|INSURANCE|IP|SSN|POBOX)_REDACTED\]/g, '')
        .replace(/\s*\[REDACTED\]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.;!?])/g, '$1')
        .trim();
}

// ── Scrub function ──────────────────────────────────────────

/**
 * Scrub all PHI from a free-text string.
 *
 * Order matters — more specific patterns run before general ones
 * to avoid partial replacements.
 */
export function scrubPHIWithReport(text: string, knownIdentifiers: unknown[] = []): PHIScrubResult {
    if (!text || typeof text !== 'string') {
        return { scrubbed: text, findings: [], redactionCount: 0 };
    }

    let cleaned = text;
    const counts = new Map<PHICategory, number>();

    // Exact known values are the only reliable way to catch an unlabelled first
    // name in free text without destroying clinical terms. They are normalized
    // here and applied after generic email/phone/date patterns, so a short name
    // cannot partially corrupt an email address before the email detector sees it.
    const known = [...new Set(
        knownIdentifiers
            .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
            .map(value => String(value).trim())
            .filter(value => value.length >= 2)
    )].sort((a, b) => b.length - a.length);
    // Match complete Docarion identifiers before labelled-ID heuristics. A
    // partial match on the embedded "-MRN-" segment would otherwise leave a
    // linkable organization/site prefix behind.
    let count = countMatches(cleaned, DOCARION_MRN_RE);
    addFinding(counts, 'medical_record', count);
    cleaned = cleaned.replace(DOCARION_MRN_RE, T.MRN);
    count = countMatches(cleaned, DOCARION_RECORD_ID_RE);
    addFinding(counts, 'medical_record', count);
    cleaned = cleaned.replace(DOCARION_RECORD_ID_RE, T.MRN);

    // JSON and labelled identifiers are processed before generic regexes so the
    // field label remains useful while the value is removed.
    count = countMatches(cleaned, JSON_PII_VALUE_RE);
    addFinding(counts, 'known_identifier', count);
    cleaned = cleaned.replace(JSON_PII_VALUE_RE, '$1[REDACTED]$3');

    count = countMatches(cleaned, LABELED_NAME_RE);
    addFinding(counts, 'name', count);
    cleaned = cleaned.replace(LABELED_NAME_RE, '$1: [NAME_REDACTED]');

    count = countMatches(cleaned, INTRODUCED_NAME_RE);
    addFinding(counts, 'name', count);
    cleaned = cleaned.replace(INTRODUCED_NAME_RE, '$1 [NAME_REDACTED]');

    cleaned = cleaned.replace(SPOKEN_NAME_RE, (fullMatch, prefix: string, candidate: string) => {
        if (!isLikelyPersonNameCandidate(candidate)) return fullMatch;
        addFinding(counts, 'name', 1);
        return `${prefix} [NAME_REDACTED]`;
    });

    cleaned = cleaned.replace(CLINICAL_SUBJECT_NAME_RE, (fullMatch, candidate: string) => {
        if (!isLikelyPersonNameCandidate(candidate)) return fullMatch;
        addFinding(counts, 'name', 1);
        return '[NAME_REDACTED]';
    });

    count = countMatches(cleaned, TITLED_NAME_RE);
    addFinding(counts, 'name', count);
    cleaned = cleaned.replace(TITLED_NAME_RE, '$1 [NAME_REDACTED]');

    cleaned = cleaned.replace(GREETING_NAME_RE, (fullMatch, greeting: string, candidate: string) => {
        if (!isLikelyPersonNameCandidate(candidate)) return fullMatch;
        addFinding(counts, 'name', 1);
        return `${greeting} [NAME_REDACTED]`;
    });

    count = countMatches(cleaned, LABELED_ID_RE);
    addFinding(counts, 'medical_record', count);
    cleaned = cleaned.replace(LABELED_ID_RE, '$1: [ID_REDACTED]');

    count = countMatches(cleaned, BANK_ACCOUNT_RE);
    addFinding(counts, 'government_id', count);
    cleaned = cleaned.replace(BANK_ACCOUNT_RE, '$1[ID_REDACTED]');

    // 1. Email (before general patterns)
    addFinding(counts, 'email', countMatches(cleaned, EMAIL_RE));
    cleaned = cleaned.replace(EMAIL_RE, T.EMAIL);

    // 2. Phone numbers — Nigerian first, then international
    addFinding(counts, 'phone', countMatches(cleaned, PHONE_NIGERIAN_RE));
    cleaned = cleaned.replace(PHONE_NIGERIAN_RE, T.PHONE);
    addFinding(counts, 'phone', countMatches(cleaned, PHONE_INTL_RE));
    cleaned = cleaned.replace(PHONE_INTL_RE, T.PHONE);

    // 3. Dates of birth — written form first, then numeric
    addFinding(counts, 'date', countMatches(cleaned, DOB_WRITTEN_RE));
    cleaned = cleaned.replace(DOB_WRITTEN_RE, T.DOB);
    addFinding(counts, 'date', countMatches(cleaned, DOB_ISO_RE));
    cleaned = cleaned.replace(DOB_ISO_RE, T.DOB);
    addFinding(counts, 'date', countMatches(cleaned, DOB_DMY_RE));
    cleaned = cleaned.replace(DOB_DMY_RE, T.DOB);

    // 4. Passport numbers
    addFinding(counts, 'passport', countMatches(cleaned, PASSPORT_GENERIC_RE));
    cleaned = cleaned.replace(PASSPORT_GENERIC_RE, T.PASSPORT);
    addFinding(counts, 'passport', countMatches(cleaned, PASSPORT_NIGERIAN_RE));
    cleaned = cleaned.replace(PASSPORT_NIGERIAN_RE, T.PASSPORT);

    // 5. Health record / MRN/workflow numbers (before generic ID match)
    addFinding(counts, 'medical_record', countMatches(cleaned, MRN_RE));
    cleaned = cleaned.replace(MRN_RE, T.MRN);

    // 6. Insurance policy numbers
    addFinding(counts, 'insurance', countMatches(cleaned, INSURANCE_RE));
    cleaned = cleaned.replace(INSURANCE_RE, T.INSURANCE);

    // 7. NIN/BVN — 11-digit IDs
    addFinding(counts, 'government_id', countMatches(cleaned, NIN_RE));
    cleaned = cleaned.replace(NIN_RE, T.ID);

    // 8. US SSN
    addFinding(counts, 'government_id', countMatches(cleaned, SSN_RE));
    cleaned = cleaned.replace(SSN_RE, T.SSN);

    // 9. Street addresses
    addFinding(counts, 'address', countMatches(cleaned, STREET_RE));
    cleaned = cleaned.replace(STREET_RE, T.ADDRESS);

    // 10. P.O. Box / PMB
    addFinding(counts, 'address', countMatches(cleaned, POBOX_RE));
    cleaned = cleaned.replace(POBOX_RE, T.POBOX);

    // 11. IP addresses
    addFinding(counts, 'network', countMatches(cleaned, IPV4_RE));
    cleaned = cleaned.replace(IPV4_RE, T.IPV4);
    addFinding(counts, 'network', countMatches(cleaned, IPV6_RE));
    cleaned = cleaned.replace(IPV6_RE, T.IPV6);
    addFinding(counts, 'network', countMatches(cleaned, IPV6_ABBREV_RE));
    cleaned = cleaned.replace(IPV6_ABBREV_RE, T.IPV6);

    // Apply known values last. Longer values are first to avoid a bare first name
    // partially replacing an already-known full name.
    for (const value of known) {
        const lowerValue = value.toLowerCase();
        // Skip single-word known identifiers that are pure structural stopwords ("what", "hi", "the")
        if (['what', 'where', 'when', 'why', 'who', 'which', 'how', 'the', 'and', 'for', 'you', 'are', 'not', 'yes'].includes(lowerValue)) {
            continue;
        }
        // Name fragments must match whole tokens. Without boundaries, a short
        // first name such as "Ada" corrupts clinical words such as "headache"
        // (he[NAME_REDACTED]che). Non-word-leading values such as "+234..."
        // intentionally omit the corresponding boundary.
        const leftBoundary = /^[\p{L}\p{N}]/u.test(value) ? '(?<![\\p{L}\\p{N}])' : '';
        const rightBoundary = /[\p{L}\p{N}]$/u.test(value) ? '(?![\\p{L}\\p{N}])' : '';
        // If a single-word name is also a common lowercase English word (e.g. "Will", "May", "Joy"),
        // match only capitalized occurrences so lowercase "will" or "may" in sentences stays intact.
        const isHomograph = COMMON_ENGLISH_HOMOGRAPH_NAMES.has(lowerValue);
        const targetExpr = isHomograph
            ? escapeRegex(value.charAt(0).toUpperCase() + value.slice(1).toLowerCase())
            : escapeRegex(value);
        const flags = isHomograph ? 'gu' : 'giu';
        const pattern = new RegExp(`${leftBoundary}${targetExpr}${rightBoundary}`, flags);
        const knownCount = countMatches(cleaned, pattern);
        if (knownCount > 0) {
            addFinding(counts, 'known_identifier', knownCount);
            cleaned = cleaned.replace(pattern, T.NAME);
        }
    }

    const findings = [...counts.entries()].map(([category, findingCount]) => ({ category, count: findingCount }));
    return {
        scrubbed: cleaned,
        findings,
        redactionCount: findings.reduce((sum, finding) => sum + finding.count, 0),
    };
}

export function scrubPHI(text: string, knownIdentifiers: unknown[] = []): string {
    return scrubPHIWithReport(text, knownIdentifiers).scrubbed;
}

/**
 * Detect direct identifiers without returning their raw values. This is safe to
 * use in audit logs and fail-closed assertions.
 */
export function detectPHI(text: string, knownIdentifiers: unknown[] = []): PHIFinding[] {
    return scrubPHIWithReport(text, knownIdentifiers).findings;
}

export function assertNoPHI(text: string, knownIdentifiers: unknown[] = []): void {
    const findings = detectPHI(text, knownIdentifiers);
    if (findings.length > 0) {
        throw new Error(`AI privacy boundary rejected direct identifiers: ${findings.map(f => `${f.category}:${f.count}`).join(',')}`);
    }
}

/**
 * Recursively scrub PHI from an object (for structured data export).
 * Also redacts known PII field names entirely.
 */
export function scrubObject(data: any): any {
    if (!data || typeof data !== 'object') {
        if (typeof data === 'string') return scrubPHI(data);
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(item => scrubObject(item));
    }

    const PII_FIELDS = [
        'firstName', 'lastName', 'fullName', 'name', 'patientName',
        'email', 'phone', 'phoneNumber', 'mobile',
        'address', 'street', 'city', 'lga',
        'dateOfBirth', 'dob', 'birthDate',
        'nin', 'nationalId', 'idNumber', 'bvn',
        'account', 'accountNumber', 'bankAccount', 'nuban',
        'nextOfKin', 'emergencyContact',
        'insuranceId', 'hmoId', 'policyNumber',
        'ipAddress', 'deviceId',
        'passportNumber', 'driversLicense',
    ];

    const scrubbed: any = {};
    for (const [key, value] of Object.entries(data)) {
        const keyLower = key.toLowerCase();

        if (PII_FIELDS.some(pii => keyLower.includes(pii.toLowerCase()))) {
            scrubbed[key] = '[REDACTED]';
            continue;
        }

        // Keep IDs but anonymize patient/doctor references
        if (keyLower === 'patientid' || keyLower === 'doctorid') {
            scrubbed[key] = hashId(value as string);
            continue;
        }

        scrubbed[key] = scrubObject(value);
    }

    return scrubbed;
}

function hashId(id: string): string {
    let hash = 0;
    for (let i = 0; i < (id || '').length; i++) {
        const char = id.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return `anon_${Math.abs(hash).toString(36)}`;
}

export interface PHIInspectionReceipt {
    scrubbedText: string;
    redactionCount: number;
    redactedCategories: string[];
    hasRedactions: boolean;
}

export function inspectAndScrubPHI(text: string, knownIdentifiers: unknown[] = []): PHIInspectionReceipt {
    const report = scrubPHIWithReport(text, knownIdentifiers);
    const categoryLabels: Record<PHICategory, string> = {
        email: 'EMAIL',
        phone: 'PHONE',
        date: 'DOB',
        government_id: 'NIN/BVN',
        passport: 'PASSPORT',
        address: 'ADDRESS',
        medical_record: 'NHIA/MRN',
        insurance: 'INSURANCE',
        network: 'IP',
        name: 'NAME',
        known_identifier: 'IDENTIFIER',
    };
    const categories = report.findings
        .filter(f => f.count > 0)
        .map(f => categoryLabels[f.category] || f.category);

    return {
        scrubbedText: report.scrubbed,
        redactionCount: report.redactionCount,
        redactedCategories: [...new Set(categories)],
        hasRedactions: report.redactionCount > 0,
    };
}

// ── Exports ─────────────────────────────────────────────────

export const phiScrubberService = {
    scrubPHI,
    scrubPHIWithReport,
    inspectAndScrubPHI,
    detectPHI,
    assertNoPHI,
    scrubObject,
    cleanConversationalRedactions,
};

export default phiScrubberService;
