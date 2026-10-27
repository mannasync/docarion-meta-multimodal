/**
 * Drug classification for inventory items — pure helpers (no I/O).
 *
 *   otc        — over-the-counter / patent & proprietary medicine (or a
 *                non-medicine product). Any cashier may sell it; it is the
 *                ONLY class a PPMV (Patent & Proprietary Medicine Vendor) may
 *                stock or sell.
 *   pom        — prescription-only medicine. At a pharmacy POS it needs a
 *                linked, valid prescription for that facility and drug AND a
 *                PCN-credentialed pharmacist (pharmacist / pharmacy_admin).
 *   controlled — controlled drug. NEVER sold through the POS; it must go
 *                through the prescription dispense flow (controlled-dispense
 *                OTP, controlled register).
 *
 * BACKFILL RULE for items written before `drugClass` existed (documented
 * decision — "missing → otc" would silently make every legacy medicine an
 * over-the-counter sale, which is unsafe):
 *   1. `isControlled === true`                    → 'controlled' (always wins)
 *   2. a valid stored `drugClass`                 → that value
 *   3. category clearly NOT a medicine (reagents,
 *      PPE, consumables, devices, toiletries …)   → 'otc'
 *   4. anything else (tablets, syrups, 'other',
 *      missing category …)                        → 'pom'
 */

import { AWARE_ANTIBIOTICS } from '../data/terminology/aware-2023';
import { FALLBACK_DRUGS } from '../data/catalog-fallback';

export type DrugClass = 'otc' | 'pom' | 'controlled';
export const DRUG_CLASSES: readonly DrugClass[] = ['otc', 'pom', 'controlled'] as const;

export const DRUG_CLASS_LABELS: Record<DrugClass, string> = {
    otc: 'OTC',
    pom: 'Prescription only',
    controlled: 'Controlled',
};

/**
 * Inventory categories that are clearly not medicines. Items in these
 * categories backfill to 'otc' (freely sellable). Deliberately narrow:
 * anything ambiguous ('other', 'supplements', 'contrast_media') stays 'pom'.
 */
export const NON_MEDICINE_CATEGORIES: ReadonlySet<string> = new Set([
    'reagents', 'consumables', 'sample_containers', 'ppe', 'calibrators',
    'films', 'equipment', 'supplies', 'medical_supplies', 'devices',
    'medical_devices', 'nutrition', 'hygiene', 'toiletries', 'cosmetics',
    'personal_care', 'baby_care', 'food', 'beverages', 'general_merchandise',
]);

const normalizeCategory = (v: unknown): string =>
    typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';

/** A valid DrugClass, or null when the value is not one. */
export function normalizeDrugClass(value: unknown): DrugClass | null {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    return (DRUG_CLASSES as readonly string[]).includes(v) ? (v as DrugClass) : null;
}

/** Effective class of a stored inventory item (applies the backfill rule). */
export function resolveDrugClass(item: { drugClass?: unknown; isControlled?: unknown; category?: unknown } | null | undefined): DrugClass {
    if (!item) return 'pom';
    if (item.isControlled === true) return 'controlled';
    const stored = normalizeDrugClass(item.drugClass);
    if (stored) return stored;
    if (NON_MEDICINE_CATEGORIES.has(normalizeCategory(item.category))) return 'otc';
    return 'pom';
}

export interface DrugClassInputResult {
    ok: boolean;
    error?: string;
    /** Resolved class to persist. */
    drugClass?: DrugClass;
    /** `isControlled` kept in lock-step so the legacy controlled-register queries still match. */
    isControlled?: boolean;
}

/**
 * Resolve the class for a create payload. An explicit `drugClass` wins; an
 * invalid one is a 400. `isControlled:true` (legacy checkbox) maps to
 * 'controlled'. Otherwise the backfill rule applies to the category.
 */
export function drugClassForCreate(body: any): DrugClassInputResult {
    if (body?.drugClass !== undefined && body?.drugClass !== null && body?.drugClass !== '') {
        const explicit = normalizeDrugClass(body.drugClass);
        if (!explicit) return { ok: false, error: `drugClass must be one of ${DRUG_CLASSES.join(', ')}` };
        // A legacy controlled flag can never be downgraded by a conflicting class.
        if (body?.isControlled === true && explicit !== 'controlled') {
            return { ok: false, error: 'isControlled:true conflicts with drugClass; use drugClass "controlled"' };
        }
        return { ok: true, drugClass: explicit, isControlled: explicit === 'controlled' };
    }
    const resolved = resolveDrugClass({ isControlled: body?.isControlled === true, category: body?.category });
    return { ok: true, drugClass: resolved, isControlled: resolved === 'controlled' };
}

/**
 * Resolve the class change for an update payload. Returns `{ ok:true }` with
 * no drugClass when neither `drugClass` nor `isControlled` is supplied.
 */
export function drugClassForUpdate(body: any, existing?: { drugClass?: unknown; isControlled?: unknown; category?: unknown } | null): DrugClassInputResult {
    const hasClass = body?.drugClass !== undefined;
    const hasControlled = body?.isControlled !== undefined;
    if (!hasClass && !hasControlled) return { ok: true };
    if (hasClass) {
        const explicit = normalizeDrugClass(body.drugClass);
        if (!explicit) return { ok: false, error: `drugClass must be one of ${DRUG_CLASSES.join(', ')}` };
        if (body?.isControlled === true && explicit !== 'controlled') {
            return { ok: false, error: 'isControlled:true conflicts with drugClass; use drugClass "controlled"' };
        }
        return { ok: true, drugClass: explicit, isControlled: explicit === 'controlled' };
    }
    // Legacy checkbox only. Unticking "controlled" lands on 'pom' (never
    // straight to 'otc'); unticking an item that was not controlled keeps
    // its current class.
    if (body.isControlled === true) return { ok: true, drugClass: 'controlled', isControlled: true };
    const current = resolveDrugClass(existing);
    return { ok: true, drugClass: current === 'controlled' ? 'pom' : current, isControlled: false };
}

/** Normalized drug-name comparison used to match a POS line to an Rx medication. */
export function normalizeDrugName(v: unknown): string {
    return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
}

/**
 * True when a prescription medication entry refers to the inventory item.
 * Matches on inventory id when the Rx carries one, else on normalized
 * brand/generic name (exact, or one contains the other for names ≥ 4 chars —
 * "amoxicillin" vs "amoxicillin 500mg capsules").
 */
export function medicationMatchesItem(med: any, item: { itemId?: string; name?: unknown; genericName?: unknown }): boolean {
    if (!med) return false;
    if (item.itemId && (med.inventoryItemId === item.itemId || med.itemId === item.itemId)) return true;
    const medNames = [med.name, med.genericName, med.drugName].map(normalizeDrugName).filter(Boolean);
    const itemNames = [item.name, item.genericName].map(normalizeDrugName).filter(Boolean);
    for (const m of medNames) {
        for (const i of itemNames) {
            if (m === i) return true;
            const [short, long] = m.length <= i.length ? [m, i] : [i, m];
            if (short.length >= 4 && (` ${long} `).includes(` ${short} `)) return true;
        }
    }
    return false;
}

// ─── Free-text drug-name classification (POS loophole guard) ────────────────


/**
 * Generic names that are controlled drugs in Nigeria (NDLEA / NAFDAC
 * narcotics & psychotropics schedules, plus tramadol and codeine products,
 * which NAFDAC restricts). Never sellable through the POS.
 */
export const KNOWN_CONTROLLED_DRUG_NAMES: readonly string[] = [
    'tramadol', 'tramal', 'ultram', 'tradonal', 'tramacet',
    'codeine', 'dihydrocodeine', 'co-codamol', 'cocodamol', 'codapane',
    'morphine', 'pethidine', 'pentazocine',
    'fentanyl', 'methadone', 'oxycodone', 'tapentadol', 'buprenorphine', 'ketamine',
    'diazepam', 'valium', 'lorazepam', 'ativan', 'midazolam', 'alprazolam', 'xanax',
    'clonazepam', 'bromazepam', 'nitrazepam', 'chlordiazepoxide', 'rohypnol', 'flunitrazepam',
    'phenobarbital', 'zolpidem',
];

/** Catalog categories whose members are prescription-only medicines. */
const POM_CATALOG_CATEGORIES = new Set(['antibiotics', 'antihypertensives', 'cardiovascular', 'antidiabetics', 'corticosteroids']);

/**
 * Known prescription-only medicine names: every systemic antibiotic in the WHO
 * AWaRe seed plus the built-in catalog's POM categories. Used so a POS cashier
 * cannot dodge the pom rule by typing a free-text line for a drug the facility
 * has not (yet) catalogued.
 */
export const KNOWN_POM_DRUG_NAMES: readonly string[] = Array.from(new Set([
    ...AWARE_ANTIBIOTICS.map((a) => a.name),
    ...FALLBACK_DRUGS
        .filter((d) => POM_CATALOG_CATEGORIES.has(String(d.category || '').toLowerCase()))
        .flatMap((d) => [d.name, d.genericName].filter((n): n is string => !!n)),
]));

const CLASS_RANK: Record<DrugClass, number> = { otc: 0, pom: 1, controlled: 2 };

/**
 * Classify a free-text POS line by its description (pure). Returns the
 * STRICTEST class among: matching inventory items at the facility (backfill
 * rule applied), the known-controlled list, and the known-POM list. Returns
 * null when nothing matches (an unrecognised product / service line).
 */
export function classifyFreeTextDrugName(
    description: unknown,
    inventory: ReadonlyArray<{ name?: unknown; genericName?: unknown; drugClass?: unknown; isControlled?: unknown; category?: unknown }> = [],
): DrugClass | null {
    if (!normalizeDrugName(description)) return null;
    const med = { name: description };
    let best: DrugClass | null = null;
    const consider = (c: DrugClass) => { if (best === null || CLASS_RANK[c] > CLASS_RANK[best]) best = c; };
    for (const item of inventory) {
        if (medicationMatchesItem(med, { name: item.name, genericName: item.genericName })) consider(resolveDrugClass(item));
    }
    if (KNOWN_CONTROLLED_DRUG_NAMES.some((n) => medicationMatchesItem(med, { name: n }))) consider('controlled');
    else if (KNOWN_POM_DRUG_NAMES.some((n) => medicationMatchesItem(med, { name: n }))) consider('pom');
    return best;
}
