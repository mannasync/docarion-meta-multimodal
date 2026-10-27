import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/error.middleware';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.middleware';
import {
    conductIntake, getIntakeStatus, getPhysicianBrief, GuestSessionConflictError,
} from '../services/ai-intake.service';
import { collections } from '../config/database';
import {
    canViewConsultationClinicalData,
    canViewPhysicianBrief,
    isPlatformAdmin,
    ConsultationContext,
} from '../utils/consultation-access';
import { facilityContextRequiredBody, platformCanSeeFacility } from '../utils/platform-facility-context';
import { haversineKm, extractCoordinates } from '../utils/geo';
import { validatePointOfCareTests, sanitizePointOfCareTests } from '../utils/point-of-care';
import { FieldValue } from '../config/database';
import { notificationService } from '../services/notification.service';
import { getActivePlatformCoverage } from '../services/coverage.service';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { issueRecordIdentifierFields } from '../services/identifier.service';
import { ensureEncounterForConsultation } from '../services/identifier-coverage.service';
import { requireCompletedCredential } from '../middleware/credential-gate.middleware';
import { cleanDisplayName } from '../utils/person-name';
import { medicalVisionService } from '../services/medical-vision.service';
import { nafdacVerificationService } from '../services/nafdac-verification.service';
import { callVoiceDiarizationService } from '../services/call-voice-diarization.service';
import { aiCopilotService } from '../services/ai-copilot.service';
import { trainingDataService } from '../services/training-data.service';

const router = Router();

// ── Liveness / bot heuristics ───────────────────────────────────────────────
// Humans read the AI's reply before answering. Sub-1.2s turnarounds (or the
// same message repeated) are bot/bug signatures: violations are counted on the
// session and surfaced on the physician brief as an integrity flag. Repeated
// violations get a soft 429 to break bot loops without hurting real patients.
const MIN_HUMAN_REPLY_MS = 1200;
async function livenessCheck(sessionId: string, message: string): Promise<{ block: boolean }> {
    try {
        const ref = collections.intakeSessions.doc(sessionId);
        const doc = await ref.get();
        const now = Date.now();
        const data = doc.exists ? doc.data()! : {};
        const lastAt = data.lastMessageAt?.toMillis?.() ?? (data.lastMessageAt ? new Date(data.lastMessageAt).getTime() : 0);
        const tooFast = lastAt > 0 && now - lastAt < MIN_HUMAN_REPLY_MS;
        const repeated = typeof data.lastMessageText === 'string' && data.lastMessageText === message.trim() && message.trim().length > 0;
        const botSignals = (Number(data.botSignals) || 0) + (tooFast || repeated ? 1 : 0);
        await ref.set({
            lastMessageAt: new Date(now),
            lastMessageText: message.trim().slice(0, 500),
            botSignals,
            livenessCheckedAt: new Date(now),
        }, { merge: true });
        // Only hard-block on a sustained pattern, never a single fast tap.
        return { block: (tooFast || repeated) && botSignals >= 4 };
    } catch {
        return { block: false }; // heuristics never block care on infrastructure errors
    }
}



// Rate limit: 10 requests per minute per IP (higher than symptom checker — intake is rapid-fire)
const intakeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { success: false, error: 'Too many requests — please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false,
});

/** Facility staff roles allowed to operate walk-in intake (C1). */
const WALK_IN_STAFF_ROLES = [
    // `care_home_nurse` is a registered nurse on the SAME NMCN register as `nurse`
    // and is the clinician who actually runs the front desk of a care home that
    // is configured for OUTPATIENT care (`care-mode.routes.ts` supports exactly
    // that configuration). Its facility ADMIN was already here, so the facility
    // could operate walk-ins only through a non-clinical account — the inverse
    // of the intended model. `caregiver` is deliberately NOT added: it is an
    // unlicensed assistive role with no entry on any professional register, and
    // these routes are walled by `requireCompletedCredential()`.
    'nurse', 'care_home_nurse', 'midwife', 'doctor', 'pharmacist', 'medicine_store_attendant', 'receptionist' as any,
    'clinic_admin', 'pharmacy_admin', 'hospital_admin', 'care_home_admin',
    'admin', 'super_admin',
] as const;

/**
 * Load the consultation + intake-session for an ownership/relationship check.
 * Either doc may be absent (session-only guest walk-ins, or a not-yet-created
 * session); we merge whatever identifiers exist. Session `patientId` is written
 * by the service and mirrors the consultation's.
 */
async function loadConsultationContext(consultationId: string): Promise<ConsultationContext | null> {
    const [consultDoc, sessionDoc] = await Promise.all([
        collections.consultations.doc(consultationId).get(),
        collections.intakeSessions.doc(consultationId).get(),
    ]);
    const consult = consultDoc.exists ? consultDoc.data() : null;
    const session = sessionDoc.exists ? sessionDoc.data() : null;
    if (!consult && !session) return null;
    return {
        patientId: consult?.patientId ?? session?.patientId ?? null,
        doctorId: consult?.doctorId ?? null,
        facilityId: consult?.facilityId ?? session?.facilityId ?? null,
        status: consult?.status ?? null,
        usedPlatformDoctor: consult?.usedPlatformDoctor ?? false,
    };
}

// POST /ai-intake/message — Send a message during intake (Patient only)
router.post('/message', authenticate, authorize('patient'), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { message, consultationId, language } = req.body;

        if (!message || !consultationId) {
            res.status(400).json({ success: false, error: 'message and consultationId are required' });
            return;
        }

        // Validate language
        const allowedLanguages = ['en', 'pcm', 'ha', 'yo', 'ig', 'fr'];
        const validLanguage = allowedLanguages.includes(language) ? language : 'en';

        // H1 — ownership check: a patient may only drive THEIR OWN intake session.
        // Load the consultation/session and 403 unless the caller is the patient.
        // (A brand-new session that doesn't exist yet is created by conductIntake
        // and bound to the consultation's patientId; if the consultation exists it
        // must belong to the caller.)
        const ctx = await loadConsultationContext(consultationId);
        if (ctx && ctx.patientId && ctx.patientId !== req.user!.userId) {
            res.status(403).json({ success: false, error: 'You are not authorized to access this intake session.' });
            return;
        }

        const liveness = await livenessCheck(consultationId, String(message));
        if (liveness.block) {
            res.status(429).json({ success: false, error: 'You are sending messages too quickly. Please slow down and answer in your own words.' });
            return;
        }

        const result = await conductIntake(message.trim(), consultationId, validLanguage);

        res.json({ success: true, data: result });
    })
);
// L7: consolidate onto utils/geo.ts (shared with the public nearby-facility
// discovery endpoint) so the haversine + coordinate-extraction logic never
// drifts. haversineKm returns kilometres; this endpoint works in metres.
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    return haversineKm(lat1, lon1, lat2, lon2) * 1000; // metres
}

async function findNearestFacility(lat: number, lng: number) {
    const facilities: any[] = [];

    try {
        const clinicsSnap = await collections.clinics.get();
        clinicsSnap.docs.forEach(doc => {
            const data = doc.data();
            if (data.status === 'active' || !data.status) {
                facilities.push({ id: doc.id, ...data, type: 'clinic' });
            }
        });
    } catch (e) {
        console.error('Failed to fetch clinics:', e);
    }

    try {
        const pharmaciesSnap = await collections.pharmacies.get();
        pharmaciesSnap.docs.forEach(doc => {
            const data = doc.data();
            if (data.status === 'active' || !data.status) {
                facilities.push({ id: doc.id, ...data, type: 'pharmacy' });
            }
        });
    } catch (e) {
        console.error('Failed to fetch pharmacies:', e);
    }

    try {
        const hospitalsSnap = await collections.hospitals.get();
        hospitalsSnap.docs.forEach(doc => {
            const data = doc.data();
            if (data.status === 'active' || !data.status) {
                facilities.push({ id: doc.id, ...data, type: 'hospital' });
            }
        });
    } catch (e) {
        console.error('Failed to fetch hospitals:', e);
    }

    // Auto-seed default test facilities in Lekki, Lagos if DB is empty.
    // DEV ONLY: this is an unauthenticated write path that fabricates facility docs.
    // It must never run in production — it would pollute the real facility directory
    // with fake clinics/pharmacies (fake phone/email) via a guest-reachable route.
    if (facilities.length === 0 && process.env.NODE_ENV !== 'production') {
        const defaultClinicId = 'docarion_clinic_lekki';
        const defaultClinic = {
            facilityId: defaultClinicId,
            name: 'Docarion Clinic Lekki',
            type: 'clinic',
            status: 'active',
            address: {
                street: 'Admiralty Way',
                city: 'Lekki',
                state: 'Lagos',
                country: 'Nigeria',
                coordinates: { latitude: 6.4281, longitude: 3.4219 }
            },
            phone: '08012345678',
            email: 'lekki@docarion.com',
            createdAt: new Date()
        };
        await collections.clinics.doc(defaultClinicId).set(defaultClinic);
        facilities.push(defaultClinic);

        const defaultPharmacyId = 'docarion_pharmacy_lekki';
        const defaultPharmacy = {
            facilityId: defaultPharmacyId,
            name: 'Docarion Pharmacy Lekki',
            type: 'pharmacy',
            status: 'active',
            address: {
                street: 'Admiralty Way',
                city: 'Lekki',
                state: 'Lagos',
                country: 'Nigeria',
                coordinates: { latitude: 6.4281, longitude: 3.4219 }
            },
            phone: '08012345679',
            email: 'pharmacy_lekki@docarion.com',
            createdAt: new Date()
        };
        await collections.pharmacies.doc(defaultPharmacyId).set(defaultPharmacy);
        facilities.push(defaultPharmacy);
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const facility of facilities) {
        // L7: use the shared, validated coordinate extractor (handles all three
        // storage shapes and rejects out-of-range values).
        const coords = extractCoordinates(facility);

        if (coords) {
            const distance = calculateDistance(lat, lng, coords.latitude, coords.longitude);
            if (distance < minDistance) {
                minDistance = distance;
                nearest = {
                    facilityId: facility.facilityId || facility.id,
                    facilityName: facility.name,
                    type: facility.type,
                    distance: distance
                };
            }
        }
    }

    // Match if within 1000m (1km)
    if (nearest && minDistance <= 1000) {
        return {
            in_facility: true,
            facilityId: nearest.facilityId,
            facilityName: nearest.facilityName,
            type: nearest.type,
            distance: `${Math.round(minDistance)}m`
        };
    }

    return {
        in_facility: false,
        nearestFacility: nearest ? {
            facilityId: nearest.facilityId,
            facilityName: nearest.facilityName,
            type: nearest.type,
            distance: `${Math.round(minDistance)}m`
        } : null
    };
}

/** Marks a session name typed by an unauthenticated guest. */
const GUEST_UNVERIFIED_NAME = 'guest_unverified';

/**
 * The session's patient name for alerts and alert-driving records: a valid
 * display name that did NOT come from unauthenticated guest input, else null
 * (callers use "A patient" / "Walk-in Patient").
 */
function transportSafeSessionName(sessionData: any): string | null {
    if (!sessionData || sessionData.firstNameSource === GUEST_UNVERIFIED_NAME) return null;
    return cleanDisplayName([sessionData.firstName, sessionData.lastName].filter(Boolean).join(' '));
}

// POST /ai-intake/guest — Unauthenticated frictionless triage
router.post('/guest', intakeLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { message, sessionId, language, lat, lng, firstName, walkInCode } = req.body;

    if (!message || !sessionId) {
        res.status(400).json({ success: false, error: 'message and sessionId are required' });
        return;
    }

    const allowedLanguages = ['en', 'pcm', 'ha', 'yo', 'ig', 'fr'];
    const validLanguage = allowedLanguages.includes(language) ? language : 'en';

    // We reuse conductIntake using sessionId as consultationId.
    // C2 — guest flag: the service refuses to bind to (or seed history from) a
    // real patient's consultation/session and never runs carry-over seeding.
    const liveness = await livenessCheck(sessionId, String(message));
    if (liveness.block) {
        res.status(429).json({ success: false, error: 'You are sending messages too quickly. Please slow down and answer in your own words.' });
        return;
    }

    let result;
    try {
        result = await conductIntake(message.trim(), sessionId, validLanguage, { guest: true });
    } catch (e) {
        if (e instanceof GuestSessionConflictError) {
            res.status(400).json({ success: false, error: e.message });
            return;
        }
        throw e;
    }

    // Calculate dynamic coordinates-based facility matching
    let facilityContext = null;
    if (lat && lng) {
        facilityContext = await findNearestFacility(Number(lat), Number(lng));
    }

    // Save/update session metadata in Firestore
    const sessionUpdate: any = {
        updatedAt: new Date()
    };
    // Unauthenticated input: keep a name only if it looks like a name, and mark
    // it unverified so it is never put on a staff lock screen or copied into
    // consultation/queue records that drive alerts. Anything else is kept as
    // typed in a clearly separate field for staff to read in the app.
    if (firstName !== undefined && firstName !== null && firstName !== '') {
        const cleanFirstName = cleanDisplayName(firstName);
        if (cleanFirstName) {
            sessionUpdate.firstName = cleanFirstName;
            sessionUpdate.firstNameSource = GUEST_UNVERIFIED_NAME;
        } else {
            sessionUpdate.firstNameAsTyped = String(firstName).slice(0, 200);
        }
    }
    if (walkInCode) sessionUpdate.walkInCode = walkInCode.replace('#', '');
    
    if (facilityContext?.in_facility) {
        sessionUpdate.facilityId = facilityContext.facilityId;
        sessionUpdate.facilityName = facilityContext.facilityName;
        sessionUpdate.inFacility = true;
        
        // Only set status if it doesn't already exist to avoid overwriting nurse vitals status
        const sessionDoc = await collections.intakeSessions.doc(sessionId).get();
        if (!sessionDoc.exists || !sessionDoc.data()?.status) {
            sessionUpdate.status = 'waiting_vitals';
        }
    }
    
    await collections.intakeSessions.doc(sessionId).set(sessionUpdate, { merge: true });

    res.json({ success: true, data: { ...result, facilityContext } });
}));

function normalizePhoneVariants(rawPhone?: string | null): string[] {
    if (!rawPhone || typeof rawPhone !== 'string') return [];
    const cleaned = rawPhone.replace(/[\s\-()]/g, '').trim();
    if (!cleaned) return [];
    const set = new Set<string>([cleaned]);
    if (cleaned.startsWith('0') && cleaned.length === 11) {
        set.add(`+234${cleaned.slice(1)}`);
        set.add(`234${cleaned.slice(1)}`);
    } else if (cleaned.startsWith('+234') && cleaned.length >= 13) {
        set.add(`0${cleaned.slice(4)}`);
        set.add(cleaned.slice(1));
    } else if (cleaned.startsWith('234') && cleaned.length === 13) {
        set.add(`+${cleaned}`);
        set.add(`0${cleaned.slice(3)}`);
    }
    return Array.from(set);
}

function formatCareStationPatientDoc(docId: string, u: any, fallbackPhone?: string | null) {
    const firstName = u.profile?.firstName || u.firstName || '';
    const lastName = u.profile?.lastName || u.lastName || '';
    const fullName =
        u.profile?.fullName
        || u.fullName
        || [firstName, lastName].filter(Boolean).join(' ')
        || u.name
        || 'Patient';
    return {
        userId: docId || u.userId,
        firstName,
        lastName,
        fullName,
        phone: u.phone || u.profile?.phone || fallbackPhone || null,
        email: u.email || null,
        gender: u.profile?.gender || u.gender || null,
        dateOfBirth: u.profile?.dateOfBirth || u.dateOfBirth || null,
        mrn: u.mrn || u.patientNumber || null,
        allergies: Array.isArray(u.allergies)
            ? u.allergies
            : (Array.isArray(u.medicalProfile?.allergies) ? u.medicalProfile.allergies : []),
        chronicConditions: Array.isArray(u.chronicConditions)
            ? u.chronicConditions
            : (Array.isArray(u.medicalProfile?.chronicConditions) ? u.medicalProfile.chronicConditions : []),
    };
}

async function lookupOrCreatePatientForCareStation(params: {
    phone?: string | null;
    email?: string | null;
    mrn?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    age?: number | string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    createIfMissing?: boolean;
    facilityId?: string | null;
}): Promise<{ found: boolean; created: boolean; patient: any | null }> {
    const phoneVariants = normalizePhoneVariants(params.phone);
    for (const v of phoneVariants) {
        const snap = await collections.users.where('phone', '==', v).limit(5).get();
        // Patients only: falling back to snap.docs[0] handed a staff member's
        // record (name, DOB, contact) to the walk-in desk when a staff
        // account shared the phone/email.
        const patientDoc = snap.docs.find((d: any) => !d.data().role || d.data().role === 'patient');
        if (patientDoc) {
            return {
                found: true,
                created: false,
                patient: formatCareStationPatientDoc(patientDoc.id, patientDoc.data(), v),
            };
        }
    }

    if (params.email && typeof params.email === 'string' && params.email.trim()) {
        const emailNorm = params.email.trim().toLowerCase();
        const snap = await collections.users.where('email', '==', emailNorm).limit(5).get();
        // Patients only: falling back to snap.docs[0] handed a staff member's
        // record (name, DOB, contact) to the walk-in desk when a staff
        // account shared the phone/email.
        const patientDoc = snap.docs.find((d: any) => !d.data().role || d.data().role === 'patient');
        if (patientDoc) {
            return {
                found: true,
                created: false,
                patient: formatCareStationPatientDoc(patientDoc.id, patientDoc.data(), phoneVariants[0] || null),
            };
        }
    }

    if (params.mrn && typeof params.mrn === 'string' && params.mrn.trim()) {
        const mrnNorm = params.mrn.trim();
        const snap = await collections.users.where('mrn', '==', mrnNorm).limit(5).get();
        const patientDoc = snap.docs.find((d: any) => !d.data().role || d.data().role === 'patient');
        if (patientDoc) {
            return {
                found: true,
                created: false,
                patient: formatCareStationPatientDoc(patientDoc.id, patientDoc.data(), phoneVariants[0] || null),
            };
        }
    }

    if (!params.createIfMissing) {
        return { found: false, created: false, patient: null };
    }

    const rawFull = (params.fullName || [params.firstName, params.lastName].filter(Boolean).join(' ') || 'Walk-in Patient').trim();
    const parts = rawFull.split(/\s+/);
    const resolvedFirst = (params.firstName && String(params.firstName).trim()) || parts[0] || 'Walk-in';
    const resolvedLast = (params.lastName && String(params.lastName).trim()) || parts.slice(1).join(' ') || '';
    const resolvedFull = [resolvedFirst, resolvedLast].filter(Boolean).join(' ');
    const primaryPhone = phoneVariants[0] || (params.phone ? String(params.phone).trim() : null);

    const newUserId = uuidv4();
    let idFields: Record<string, any> = {};
    try {
        idFields = (await issueRecordIdentifierFields('patient' as any, newUserId, {
            facilityId: params.facilityId || null,
        })) || {};
    } catch {
        idFields = {};
    }
    const resolvedMrn = idFields.mrn || idFields.patientNumber || `MRN-${String(crypto.randomInt(100000, 999999))}`;
    const now = new Date();
    const newUserDoc: any = {
        userId: newUserId,
        role: 'patient',
        phone: primaryPhone,
        email: params.email ? String(params.email).trim().toLowerCase() : null,
        mrn: resolvedMrn,
        ...idFields,
        firstName: resolvedFirst,
        lastName: resolvedLast,
        fullName: resolvedFull,
        profile: {
            firstName: resolvedFirst,
            lastName: resolvedLast,
            fullName: resolvedFull,
            phone: primaryPhone,
            gender: params.gender || null,
            dateOfBirth: params.dateOfBirth || null,
            age: Number.isFinite(Number(params.age)) ? Number(params.age) : null,
        },
        createdVia: 'care_station_assisted_intake',
        sourceFacilityId: params.facilityId || null,
        status: 'active',
        isActive: true,
        allergies: [],
        chronicConditions: [],
        createdAt: now,
        updatedAt: now,
    };

    await collections.users.doc(newUserId).set(newUserDoc);

    return {
        found: false,
        created: true,
        patient: formatCareStationPatientDoc(newUserId, newUserDoc, primaryPhone),
    };
}

// POST /ai-intake/care-station/patient-lookup — Search or auto-create a patient account by phone/email/MRN
router.post('/care-station/patient-lookup', authenticate, authorize(...WALK_IN_STAFF_ROLES),
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const {
            phone,
            email,
            mrn,
            firstName,
            lastName,
            fullName,
            age,
            gender,
            dateOfBirth,
            createIfMissing,
        } = req.body || {};

        if (!phone && !email && !mrn && !createIfMissing) {
            res.status(400).json({
                success: false,
                error: 'Provide phone, email, or mrn to look up a patient.',
            });
            return;
        }

        const result = await lookupOrCreatePatientForCareStation({
            phone,
            email,
            mrn,
            firstName,
            lastName,
            fullName,
            age,
            gender,
            dateOfBirth,
            createIfMissing: Boolean(createIfMissing),
            facilityId: req.user!.facilityId || null,
        });

        res.json({
            success: true,
            data: result,
        });
    })
);

// GET /ai-intake/walk-ins — Retrieve active walk-ins for a facility (Nurse/Pharmacy)
// C1: authenticated facility staff only; facilityId is ALWAYS derived from the
// token (never trusted from the query string) to prevent cross-facility reads.
// LICENSURE WALL: the walk-in board is patient data. Facility admins/reception
// roles hold no regulated credential and pass the gate by construction.
router.get('/walk-ins', authenticate, authorize(...WALK_IN_STAFF_ROLES), requireCompletedCredential(), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
    const facilityId = req.user!.facilityId;
    if (!facilityId) {
        res.status(400).json({ success: false, error: 'Your account is not assigned to a facility.' });
        return;
    }

    const snapshot = await collections.intakeSessions
        .where('facilityId', '==', facilityId)
        .get();

    const walkIns = snapshot.docs
        .map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.firstName || 'Anonymous',
                code: data.walkInCode || '',
                status: data.status || 'waiting_vitals',
                vitals: data.vitals || undefined,
                patientId: data.patientId || null,
                phone: data.phone || null,
                mrn: data.mrn || null,
                chiefComplaint: data.chiefComplaint || null,
                triageCategory: data.triage?.category || null,
                updatedAt: data.updatedAt
            };
        })
        .filter(p => p.status !== 'sent_to_doctor')
        .sort((a, b) => {
            const dateA = a.updatedAt?.toDate?.() || new Date(a.updatedAt || 0);
            const dateB = b.updatedAt?.toDate?.() || new Date(b.updatedAt || 0);
            return dateB.getTime() - dateA.getTime();
        });

    res.json({ success: true, data: walkIns });
}));

// POST /ai-intake/walk-ins — Register a walk-in from the front desk / Pro app.
// Creates an intake session directly (no kiosk chat needed) so the nurse can
// record vitals and send to a doctor. facilityId is ALWAYS taken from the token.
//
// GATING ASYMMETRY CLOSED (MOBILE_REVIEW_2026-07-30 §1). GET /walk-ins,
// /:id/vitals and /:id/send all carry `requireCompletedCredential()`; CREATE did
// not. The result was incoherent rather than merely inconsistent: an
// uncredentialed nurse could register a walk-in and then be refused the list
// containing it — she could write but not read her own work. Registration also
// captures the presenting complaint, which is the first clinical record of the
// episode. The gate is a NO-OP for roles with no regulated credential (facility
// admins, front-desk accounts), so this blocks the unlicensed clinician without
// closing the front desk.
router.post('/walk-ins', authenticate, authorize(...WALK_IN_STAFF_ROLES), requireCompletedCredential(), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
    const facilityId = req.user!.facilityId;
    if (!facilityId) {
        res.status(400).json({ success: false, error: 'Your account is not assigned to a facility.' });
        return;
    }

    const { patientName, phone, age, gender, dateOfBirth, chiefComplaint, triageCategory, patientId: explicitPatientId } = req.body || {};
    const name = typeof patientName === 'string' ? patientName.trim().slice(0, 120) : '';
    if (!name) {
        res.status(400).json({ success: false, error: 'patientName is required' });
        return;
    }

    let linkedPatientId: string | null = typeof explicitPatientId === 'string' && explicitPatientId.trim() ? explicitPatientId.trim() : null;
    let linkedMrn: string | null = null;
    let isExistingAccount = false;

    if (typeof phone === 'string' && phone.trim().length > 0) {
        const lookupResult = await lookupOrCreatePatientForCareStation({
            phone: phone.trim(),
            fullName: name,
            age,
            gender,
            dateOfBirth,
            createIfMissing: true,
            facilityId,
        });
        if (lookupResult.patient) {
            linkedPatientId = lookupResult.patient.userId;
            linkedMrn = lookupResult.patient.mrn || null;
            isExistingAccount = lookupResult.found;
        }
    } else if (linkedPatientId) {
        const pDoc = await collections.users.doc(linkedPatientId).get();
        if (pDoc.exists) {
            isExistingAccount = true;
            linkedMrn = pDoc.data()?.mrn || pDoc.data()?.patientNumber || null;
        }
    }

    const sessionId = uuidv4();
    const walkInCode = String(crypto.randomInt(1000, 10000)); // 4-digit desk code

    const session: any = {
        firstName: name,
        phone: typeof phone === 'string' ? phone.slice(0, 32) : null,
        age: Number.isFinite(Number(age)) ? Number(age) : null,
        gender: typeof gender === 'string' ? gender.slice(0, 20) : null,
        chiefComplaint: typeof chiefComplaint === 'string' ? chiefComplaint.slice(0, 1000) : null,
        patientId: linkedPatientId,
        mrn: linkedMrn,
        isExistingAccount,
        walkInCode,
        facilityId,
        inFacility: true,
        registeredBy: req.user!.userId,
        source: 'staff_registration',
        status: 'waiting_vitals',
        is_sandbox: req.isSandbox || false,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    if (typeof triageCategory === 'string' && triageCategory) {
        session.triage = { category: triageCategory, reason: 'Staff-assigned at registration' };
    }

    await collections.intakeSessions.doc(sessionId).set(session);

    res.status(201).json({
        success: true,
        data: {
            id: sessionId,
            name,
            code: walkInCode,
            status: 'waiting_vitals',
            patientId: linkedPatientId,
            isExistingAccount,
            mrn: linkedMrn,
        },
    });
}));

// POST /ai-intake/walk-ins/:sessionId/vitals — Record vitals
// C1: authenticated facility staff only; the session must belong to the
// caller's facility (vitals now feed deterministic triage floors).
// LICENSURE WALL: recording vitals is a clinical act on a patient record.
router.post('/walk-ins/:sessionId/vitals', authenticate, authorize(...WALK_IN_STAFF_ROLES), requireCompletedCredential(), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
    const { sessionId } = req.params;
    const { bp, temp, hr, spo2, weight, pointOfCareTests } = req.body;

    if (!bp || !temp || !hr || !spo2 || !weight) {
        res.status(400).json({ success: false, error: 'All vital signs are required' });
        return;
    }

    // Optional bedside rapid-test records recorded alongside the vitals.
    const pocErr = validatePointOfCareTests(pointOfCareTests);
    if (pocErr) {
        res.status(400).json({ success: false, error: pocErr });
        return;
    }

    const sessionDoc = await collections.intakeSessions.doc(sessionId).get();
    if (!sessionDoc.exists) {
        res.status(404).json({ success: false, error: 'Intake session not found' });
        return;
    }

    // C1: scope to the caller's facility (never write across facilities).
    const sessionFacilityId = sessionDoc.data()?.facilityId || null;
    // Owner rule: a platform admin acts only with this facility selected.
    if (!(req.user!.facilityId && req.user!.facilityId === sessionFacilityId)
        && !platformCanSeeFacility(req.user!, sessionFacilityId)) {
        if (isPlatformAdmin(req.user!) && !req.user!.facilityId) {
            res.status(403).json(facilityContextRequiredBody(sessionFacilityId));
            return;
        }
        res.status(403).json({ success: false, error: 'This walk-in belongs to another facility.' });
        return;
    }

    const update: any = {
        vitals: { bp, temp, hr, spo2, weight },
        status: 'vitals_taken',
        updatedAt: new Date()
    };
    const sanitizedPoc = sanitizePointOfCareTests(pointOfCareTests, {
        takenBy: req.user!.userId, takenByRole: req.user!.role,
    });
    if (sanitizedPoc.length > 0) update.pointOfCareTests = FieldValue.arrayUnion(...sanitizedPoc);

    await collections.intakeSessions.doc(sessionId).update(update);

    res.json({ success: true, message: 'Vitals recorded successfully' });
}));

// POST /ai-intake/walk-ins/:sessionId/send — Push to Doctor queue
// C1: authenticated facility staff only; session must belong to the facility.
// LICENSURE WALL: pushing a walk-in to the doctor queue connects a patient to
// care under this clinician's name.
router.post('/walk-ins/:sessionId/send', authenticate, authorize(...WALK_IN_STAFF_ROLES), requireCompletedCredential(), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
    const { sessionId } = req.params;

    const sessionDoc = await collections.intakeSessions.doc(sessionId).get();
    if (!sessionDoc.exists) {
        res.status(404).json({ success: false, error: 'Intake session not found' });
        return;
    }

    const sessionData = sessionDoc.data()!;

    // C1: scope to the caller's facility.
    // Owner rule: a platform admin acts only with this facility selected.
    const walkInFacilityId = sessionData.facilityId || null;
    if (!(req.user!.facilityId && req.user!.facilityId === walkInFacilityId)
        && !platformCanSeeFacility(req.user!, walkInFacilityId)) {
        if (isPlatformAdmin(req.user!) && !req.user!.facilityId) {
            res.status(403).json(facilityContextRequiredBody(walkInFacilityId));
            return;
        }
        res.status(403).json({ success: false, error: 'This walk-in belongs to another facility.' });
        return;
    }

    // Create the actual consultation document in Doctor queue
    // (This links the guest session to a pending consultation that human doctors can see)
    const consultationId = sessionId; // Reuse sessionId as consultationId

    // Check if the consultation already exists
    const consultDoc = await collections.consultations.doc(consultationId).get();

    // ── Server-side platform-coverage routing ──────────────────────────────
    // If the facility has a LIVE platform coverage booking, this walk-in is
    // routed to Docarion platform doctors (telehealth queue) instead of the
    // facility's own queue. The decision is made HERE, not by the client.
    const activeCoverage = sessionData.facilityId
        ? await getActivePlatformCoverage(sessionData.facilityId).catch(() => null)
        : null;

    const consultationIdentifier = !consultDoc.exists
        ? await issueRecordIdentifierFields('consultation', consultationId, {
            facilityId: sessionData.facilityId || null,
        })
        : {};
    const consultPayload: any = {
        consultationId,
        ...consultationIdentifier,
        patientName: transportSafeSessionName(sessionData) || 'Walk-in Patient',
        patientId: sessionData.patientId || null,
        patientPhone: sessionData.phone || null,
        mrn: sessionData.mrn || null,
        doctorId: null,
        status: 'pending',
        type: 'video',
        scheduledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        facilityId: sessionData.facilityId || null,
        facilityName: sessionData.facilityName || null,
        symptoms: sessionData.chiefComplaint ? [sessionData.chiefComplaint] : ['Walk-in Intake Done'],
        chiefComplaint: sessionData.chiefComplaint || null,
        vitals: sessionData.vitals || null,
        // Carry any bedside rapid-test records the care team captured at intake.
        pointOfCareTests: sessionData.pointOfCareTests || [],
        nurseIntakeComplete: true,
        hxIntakeComplete: true,
        hxIntakeMethod: sessionData.hxIntakeMethod || 'nurse',
    };

    // Carry the intake triage disposition onto the queue entry (additive fields)
    if (sessionData.triage?.category) {
        consultPayload.triageCategory = sessionData.triage.category;
        consultPayload.esiLevel = sessionData.triage.esiLevel || null;
        consultPayload.triageReason = sessionData.triage.reason || null;
        consultPayload.triagedAt = new Date();
    }

    // Stamp coverage-routing provenance on the consultation so dashboards and
    // billing can attribute the encounter to the platform coverage window.
    if (activeCoverage) {
        consultPayload.routedToPlatform = true;
        consultPayload.platformCoverageBookingId = activeCoverage.bookingId;
        consultPayload.routedVia = 'platform_coverage';
    }

    if (!consultDoc.exists) {
        await collections.consultations.doc(consultationId).set(consultPayload);
    } else {
        const existingConsult = consultDoc.data() || {};
        const existingVitals = existingConsult.vitals || {};
        const mergedVitals = sessionData.vitals ? { ...existingVitals, ...sessionData.vitals } : existingConsult.vitals;
        await collections.consultations.doc(consultationId).update({
            status: 'pending',
            ...(sessionData.patientId ? { patientId: sessionData.patientId } : {}),
            ...(sessionData.mrn ? { mrn: sessionData.mrn } : {}),
            vitals: mergedVitals || null,
            nurseIntakeComplete: true,
            hxIntakeComplete: true,
            hxIntakeMethod: sessionData.hxIntakeMethod || 'nurse',
            ...(Array.isArray(sessionData.pointOfCareTests) && sessionData.pointOfCareTests.length
                ? { pointOfCareTests: FieldValue.arrayUnion(...sessionData.pointOfCareTests) } : {}),
            updatedAt: new Date(),
            ...(sessionData.triage?.category ? {
                triageCategory: sessionData.triage.category,
                esiLevel: sessionData.triage.esiLevel || null,
                triageReason: sessionData.triage.reason || null,
                triagedAt: new Date(),
            } : {})
        });
    }
    await ensureEncounterForConsultation(consultationId);

    // Mark intake session as sent
    await collections.intakeSessions.doc(sessionId).update({
        status: 'sent_to_doctor',
        updatedAt: new Date()
    });

    // Lock screen: "<name> is waiting for a doctor" (name only, never intake
    // answers). A guest-typed name is never used: "A patient" instead.
    const walkInLockScreenName: string | null = transportSafeSessionName(sessionData);

    // ── Route to the platform telehealth queue when coverage is live ───────
    if (activeCoverage) {
        // Don't double-enqueue on repeat sends of the same walk-in.
        const existingSnap = await collections.telehealthQueue
            .where('consultationId', '==', consultationId)
            .get();
        const alreadyQueued = existingSnap.docs.some((d: any) =>
            ['waiting', 'assigned', 'in_consultation'].includes(d.data().status));

        if (!alreadyQueued) {
            const waitingSnap = await collections.telehealthQueue.where('status', '==', 'waiting').get();
            const position = waitingSnap.size + 1;
            const queueId = uuidv4();
            await collections.telehealthQueue.doc(queueId).set({
                queueId,
                patientId: sessionData.patientId || null,
                is_sandbox: req.isSandbox || false,
                patientName: transportSafeSessionName(sessionData) || 'Walk-in Patient',
                facilityId: null, // platform-wide queue → platform doctors pick up
                sourceFacilityId: sessionData.facilityId || null,
                routedVia: 'platform_coverage',
                platformCoverageBookingId: activeCoverage.bookingId,
                symptoms: consultPayload.symptoms || [],
                urgencyLevel: sessionData.triage?.category === 'emergency' ? 'emergency' : 'medium',
                triageCategory: sessionData.triage?.category || null,
                preferredLanguage: 'en',
                status: 'waiting' as const,
                assignedDoctorId: null,
                consultationId,
                position,
                joinedAt: new Date(),
                assignedAt: null,
                completedAt: null,
                estimatedWaitMinutes: position * 10,
            });
        }

        // Notify platform doctors (facilityId null → all doctors) — the walk-in
        // bypasses the facility queue during the coverage window.
        if (!req.isSandbox) {
            notificationService.sendToFacilityStaff(
                null as any,
                ['doctor'],
                'Platform coverage: walk-in waiting',
                `${sessionData.firstName || 'A walk-in patient'} was routed to the platform queue (facility coverage window active).`,
                { type: 'platform_coverage_walk_in', consultationId },
                { lockScreen: { patientName: walkInLockScreenName } },
            ).catch(() => {});
        }
    } else if (sessionData.facilityId && !req.isSandbox) {
        // Normal path: notify the facility's own doctors/nurses (closes the
        // previously-missing notification gap on the walk-in → queue handoff).
        notificationService.sendToFacilityStaff(
            sessionData.facilityId,
            ['doctor', 'nurse', 'clinic_admin', 'hospital_admin'],
            'New walk-in ready for review',
            `${sessionData.firstName || 'A walk-in patient'} has completed intake and is waiting for a doctor.`,
            { type: 'walk_in', consultationId },
            { lockScreen: { patientName: walkInLockScreenName } },
        ).catch(() => {});
    }

    res.json({
        success: true,
        message: activeCoverage
            ? 'Patient routed to platform telehealth queue (coverage window active)'
            : 'Patient sent to doctor queue',
        data: {
            consultationId,
            patientId: sessionData.patientId || null,
            consultationNumber: consultPayload.consultationNumber
                || consultDoc.data()?.consultationNumber
                || null,
            routedToPlatform: !!activeCoverage,
        },
    });
}));

// POST /ai-intake/walk-ins/claim-handoff — Claim a Care Station QR / 6-digit handoff code
// Supports both authenticated patients and guests presenting a valid handoffToken or handoffCode.
router.post('/walk-ins/claim-handoff',
    (req: AuthRequest, res: Response, next: any) => {
        const hasAuth = Boolean(req.headers?.authorization || (req as any).cookies?.token || (req as any).cookies?.accessToken);
        if (hasAuth || process.env.NODE_ENV === 'test') {
            return authenticate(req, res, () => next());
        }
        return next();
    },
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { sessionId, consultationId, handoffToken, handoffCode, phone } = req.body || {};
        const targetId = sessionId || consultationId || null;

        if (!handoffToken && !handoffCode) {
            res.status(400).json({
                success: false,
                error: 'Either handoffToken or handoffCode is required to claim handoff.',
            });
            return;
        }

        let sessionDoc: any = null;
        if (targetId) {
            const doc = await collections.intakeSessions.doc(String(targetId)).get();
            if (doc.exists) sessionDoc = doc;
        }

        if (!sessionDoc && handoffToken) {
            const snap = await collections.intakeSessions.where('handoffToken', '==', String(handoffToken)).limit(1).get();
            if (!snap.empty) sessionDoc = snap.docs[0];
        }

        if (!sessionDoc && handoffCode) {
            const snap = await collections.intakeSessions.where('handoffCode', '==', String(handoffCode).trim()).limit(1).get();
            if (!snap.empty) sessionDoc = snap.docs[0];
        }

        if (!sessionDoc || !sessionDoc.exists) {
            res.status(404).json({ success: false, error: 'Walk-in intake session not found.' });
            return;
        }

        const resolvedSessionId = sessionDoc.id;
        const sessionData = sessionDoc.data() || {};

        const tokenMatches = handoffToken && sessionData.handoffToken === String(handoffToken);
        const codeMatches = handoffCode && String(sessionData.handoffCode) === String(handoffCode).trim();
        if (!tokenMatches && !codeMatches) {
            res.status(403).json({
                success: false,
                error: 'Invalid handoff token or code.',
            });
            return;
        }

        const expiresAtMs = sessionData.handoffExpiresAt?.toDate
            ? sessionData.handoffExpiresAt.toDate().getTime()
            : (sessionData.handoffExpiresAt ? new Date(sessionData.handoffExpiresAt).getTime() : 0);
        if (expiresAtMs > 0 && Date.now() > expiresAtMs) {
            res.status(410).json({
                success: false,
                error: 'Handoff token has expired. Ask facility staff to generate a new code.',
            });
            return;
        }

        let resolvedPatientId: string | null =
            (req.user?.role === 'patient' ? req.user.userId : null)
            || sessionData.patientId
            || null;

        if (!resolvedPatientId && phone) {
            const lookupResult = await lookupOrCreatePatientForCareStation({
                phone: String(phone),
                fullName: transportSafeSessionName(sessionData) || 'Walk-in Patient',
                createIfMissing: true,
                facilityId: sessionData.facilityId || null,
            });
            resolvedPatientId = lookupResult.patient?.userId || null;
        }

        const claimedAt = new Date();
        await collections.intakeSessions.doc(resolvedSessionId).set({
            ...(resolvedPatientId ? { patientId: resolvedPatientId } : {}),
            handoffClaimed: true,
            handoffClaimedAt: claimedAt,
            updatedAt: claimedAt,
        }, { merge: true });

        const consultDoc = await collections.consultations.doc(resolvedSessionId).get();
        if (consultDoc.exists) {
            await collections.consultations.doc(resolvedSessionId).set({
                ...(resolvedPatientId ? { patientId: resolvedPatientId } : {}),
                handoffClaimed: true,
                handoffClaimedAt: claimedAt,
                updatedAt: claimedAt,
            }, { merge: true });
        }

        if (resolvedPatientId) {
            const qSnap = await collections.telehealthQueue.where('consultationId', '==', resolvedSessionId).get();
            for (const qDoc of qSnap.docs) {
                await collections.telehealthQueue.doc(qDoc.id).update({
                    patientId: resolvedPatientId,
                });
            }
        }

        res.json({
            success: true,
            message: 'Consultation handoff claimed successfully',
            data: {
                sessionId: resolvedSessionId,
                consultationId: resolvedSessionId,
                patientId: resolvedPatientId,
                patientName: sessionData.firstName || consultDoc.data()?.patientName || 'Walk-in Patient',
                status: consultDoc.data()?.status || sessionData.status || 'pending',
                handoffClaimed: true,
            },
        });
    })
);

// POST /ai-intake/walk-ins/:sessionId/chat — Staff-assisted AI Intake Bot conversation on behalf of a walk-in patient
router.post('/walk-ins/:sessionId/chat', authenticate, authorize(...WALK_IN_STAFF_ROLES),
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { sessionId } = req.params;
        const { message, language } = req.body || {};

        if (!message || typeof message !== 'string' || !message.trim()) {
            res.status(400).json({ success: false, error: 'message is required' });
            return;
        }

        const sessionDoc = await collections.intakeSessions.doc(sessionId).get();
        if (!sessionDoc.exists) {
            res.status(404).json({ success: false, error: 'Intake session not found' });
            return;
        }

        const sessionData = sessionDoc.data() || {};
        const sessionFacilityId = sessionData.facilityId || null;
        if (!(req.user!.facilityId && req.user!.facilityId === sessionFacilityId)
            && !platformCanSeeFacility(req.user!, sessionFacilityId)) {
            res.status(403).json({ success: false, error: 'This walk-in belongs to another facility.' });
            return;
        }

        const allowedLanguages = ['en', 'pcm', 'ha', 'yo', 'ig', 'fr'];
        const validLanguage = allowedLanguages.includes(language) ? language : 'en';

        const result = await conductIntake(message.trim(), sessionId, validLanguage);

        await collections.intakeSessions.doc(sessionId).set({
            assistedByStaffId: req.user!.userId,
            assistedByRole: req.user!.role,
            hxIntakeMethod: 'assisted_ai',
            updatedAt: new Date(),
        }, { merge: true });

        res.json({
            success: true,
            data: result,
        });
    })
);

// POST /ai-intake/walk-ins/:sessionId/handoff-token — Generate short-lived QR / 6-digit handoff token for patient's phone
router.post('/walk-ins/:sessionId/handoff-token', authenticate, authorize(...WALK_IN_STAFF_ROLES),
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { sessionId } = req.params;
        const sessionDoc = await collections.intakeSessions.doc(sessionId).get();
        if (!sessionDoc.exists) {
            res.status(404).json({ success: false, error: 'Intake session not found' });
            return;
        }

        const sessionData = sessionDoc.data() || {};
        const sessionFacilityId = sessionData.facilityId || null;
        if (!(req.user!.facilityId && req.user!.facilityId === sessionFacilityId)
            && !platformCanSeeFacility(req.user!, sessionFacilityId)) {
            res.status(403).json({ success: false, error: 'This walk-in belongs to another facility.' });
            return;
        }

        const handoffCode = String(crypto.randomInt(100000, 1000000)); // 6-digit code
        const handoffToken = crypto.randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

        await collections.intakeSessions.doc(sessionId).set({
            handoffCode,
            handoffToken,
            handoffExpiresAt: expiresAt,
            handoffGeneratedBy: req.user!.userId,
            updatedAt: new Date(),
        }, { merge: true });

        const consultDoc = await collections.consultations.doc(sessionId).get();
        if (consultDoc.exists) {
            await collections.consultations.doc(sessionId).set({
                handoffCode,
                handoffToken,
                handoffExpiresAt: expiresAt,
                updatedAt: new Date(),
            }, { merge: true });
        }

        const baseUrl = (process.env.FRONTEND_URL || 'https://docarion.com').replace(/\/+$/, '');
        const handoffUrl = `${baseUrl}/consultations/${sessionId}?handoff=${handoffToken}`;

        res.json({
            success: true,
            data: {
                sessionId,
                consultationId: sessionId,
                handoffCode,
                handoffToken,
                handoffUrl,
                expiresAt: expiresAt.toISOString(),
            },
        });
    })
);

// GET /ai-intake/care-station/:consultationId/terminal — Live Care Station terminal state for patient or assisting staff
router.get('/care-station/:consultationId/terminal', authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { consultationId } = req.params;
        const user = req.user!;

        const [consultDoc, sessionDoc, queueSnap, messagesSnap, rxSnap, labSnap] = await Promise.all([
            collections.consultations.doc(consultationId).get(),
            collections.intakeSessions.doc(consultationId).get(),
            collections.telehealthQueue.where('consultationId', '==', consultationId).get(),
            collections.messages.where('consultationId', '==', consultationId).get(),
            collections.prescriptions.where('consultationId', '==', consultationId).get(),
            collections.labOrders.where('consultationId', '==', consultationId).get(),
        ]);

        if (!consultDoc.exists && !sessionDoc.exists) {
            res.status(404).json({ success: false, error: 'Consultation or Care Station session not found' });
            return;
        }

        const consultData = consultDoc.exists ? consultDoc.data()! : {};
        const sessionData = sessionDoc.exists ? sessionDoc.data()! : {};
        const facilityId = consultData.facilityId || sessionData.facilityId || null;
        const patientId = consultData.patientId || sessionData.patientId || null;

        const isOwnerPatient = user.role === 'patient' && patientId && patientId === user.userId;
        const isAssignedDoctor = user.role === 'doctor' && consultData.doctorId === user.userId;
        const isSameFacilityStaff =
            WALK_IN_STAFF_ROLES.includes(user.role as any)
            && Boolean(user.facilityId && facilityId && user.facilityId === facilityId);
        const isPlatform = isPlatformAdmin(user);

        if (!isOwnerPatient && !isAssignedDoctor && !isSameFacilityStaff && !isPlatform) {
            res.status(403).json({ success: false, error: 'You are not authorized to access this Care Station terminal.' });
            return;
        }

        const queueDoc = queueSnap.docs[0];
        const queueData = queueDoc ? queueDoc.data() : null;

        const messages = messagesSnap.docs
            .map((d: any) => ({ id: d.id, ...d.data() }))
            .sort((a: any, b: any) => {
                const tA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt || 0).getTime();
                const tB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt || 0).getTime();
                return tA - tB;
            });

        const prescriptions = rxSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        const labOrders = labSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

        res.json({
            success: true,
            data: {
                consultation: {
                    id: consultationId,
                    status: consultData.status || sessionData.status || 'pending',
                    type: consultData.type || 'video',
                    patientId,
                    patientName: consultData.patientName || sessionData.firstName || 'Walk-in Patient',
                    doctorId: consultData.doctorId || queueData?.assignedDoctorId || null,
                    doctorName: consultData.doctorName || null,
                    facilityId,
                    facilityName: consultData.facilityName || sessionData.facilityName || null,
                    chiefComplaint: consultData.chiefComplaint || sessionData.chiefComplaint || null,
                    vitals: consultData.vitals || sessionData.vitals || null,
                    triageCategory: consultData.triageCategory || sessionData.triage?.category || null,
                    routedToPlatform: Boolean(consultData.routedToPlatform || queueData?.routedVia === 'platform_coverage'),
                    meetingUrl: consultData.meetingUrl || null,
                    callRoomId: consultData.callRoomId || consultationId,
                },
                queueStatus: queueData
                    ? {
                        status: queueData.status,
                        position: queueData.position ?? 1,
                        estimatedWaitMinutes: queueData.estimatedWaitMinutes ?? 10,
                        assignedDoctorId: queueData.assignedDoctorId || null,
                    }
                    : null,
                messages,
                prescriptions,
                labOrders,
            },
        });
    })
);

// POST /ai-intake/care-station/:consultationId/terminal-message — Send message from Care Station terminal (patient_terminal or staff_assisted)
router.post('/care-station/:consultationId/terminal-message', authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { consultationId } = req.params;
        const { content, message, senderMode, senderName } = req.body || {};
        const resolvedContent = String(content ?? message ?? '').trim();

        if (!resolvedContent) {
            res.status(400).json({ success: false, error: 'content is required' });
            return;
        }

        const user = req.user!;
        const [consultDoc, sessionDoc] = await Promise.all([
            collections.consultations.doc(consultationId).get(),
            collections.intakeSessions.doc(consultationId).get(),
        ]);

        if (!consultDoc.exists && !sessionDoc.exists) {
            res.status(404).json({ success: false, error: 'Consultation or Care Station session not found' });
            return;
        }

        const consultData = consultDoc.exists ? consultDoc.data()! : {};
        const sessionData = sessionDoc.exists ? sessionDoc.data()! : {};
        const facilityId = consultData.facilityId || sessionData.facilityId || null;
        const patientId = consultData.patientId || sessionData.patientId || null;

        const isOwnerPatient = user.role === 'patient' && patientId && patientId === user.userId;
        const isAssignedDoctor = user.role === 'doctor' && consultData.doctorId === user.userId;
        const isSameFacilityStaff =
            WALK_IN_STAFF_ROLES.includes(user.role as any)
            && Boolean(user.facilityId && facilityId && user.facilityId === facilityId);
        const isPlatform = isPlatformAdmin(user);

        if (!isOwnerPatient && !isAssignedDoctor && !isSameFacilityStaff && !isPlatform) {
            res.status(403).json({ success: false, error: 'You are not authorized to send messages on this Care Station terminal.' });
            return;
        }

        const resolvedMode: 'patient_terminal' | 'staff_assisted' =
            senderMode === 'patient_terminal' || user.role === 'patient'
                ? 'patient_terminal'
                : 'staff_assisted';

        const messageId = uuidv4();
        const now = new Date();
        const resolvedSenderName =
            typeof senderName === 'string' && senderName.trim()
                ? senderName.trim()
                : resolvedMode === 'patient_terminal'
                    ? (consultData.patientName || sessionData.firstName || 'Walk-in Patient')
                    : `Care Station (${user.role})`;

        const msgPayload = {
            id: messageId,
            messageId,
            consultationId,
            senderId: user.userId,
            senderName: resolvedSenderName,
            senderRole: user.role,
            senderMode: resolvedMode,
            content: resolvedContent,
            createdAt: now,
        };

        await collections.messages.doc(messageId).set(msgPayload);

        res.status(201).json({
            success: true,
            data: msgPayload,
        });
    })
);

// GET /ai-intake/:consultationId/brief — Get Physician Brief
// H3: role-gated AND relationship-gated. Assigned doctor, same-facility clinical
// staff, or platform admin may view; a platform doctor may view an UNCLAIMED
// platform-queue consultation (needed to decide whether to claim). Otherwise 403.
router.get('/:consultationId/brief', authenticate, authorize('doctor', 'admin', 'nurse'),
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { consultationId } = req.params;

        const ctx = await loadConsultationContext(consultationId);
        let allowed = Boolean(ctx && canViewPhysicianBrief(req.user!, ctx));
        if (!allowed && ctx && !ctx.doctorId && ctx.status !== 'completed' && ctx.status !== 'cancelled' && req.user?.role === 'doctor') {
            try {
                const dSnap = await collections.doctors.doc(req.user.userId).get();
                const dData = dSnap.exists ? dSnap.data() : null;
                if (dData && (dData.doctorType === 'both' || dData.doctorType === 'platform' || dData.platformTelehealthAgreement === true)) {
                    const allowedFacs = [req.user.facilityId, dData.facilityId, ...(Array.isArray(dData.allowedFacilityIds) ? dData.allowedFacilityIds : [])].filter(Boolean);
                    if (!ctx.facilityId || ctx.facilityId === 'DOCARION_PLATFORM' || allowedFacs.includes(ctx.facilityId)) {
                        allowed = true;
                    }
                }
            } catch { /* fallback to allowed=false */ }
        }
        if (!ctx || !allowed) {
            res.status(403).json({ success: false, error: 'You are not authorized to view this physician brief.' });
            return;
        }

        const result = await getPhysicianBrief(consultationId);

        let fallbackBrief: any = null;
        if (!result.brief) {
            const cDoc = await collections.consultations.doc(consultationId).get();
            if (cDoc.exists && cDoc.data()?.physicianBrief) {
                fallbackBrief = cDoc.data()?.physicianBrief;
            }
        }

        const resolvedBrief = result.brief || fallbackBrief;

        if (!resolvedBrief) {
            res.status(404).json({
                success: false,
                error: 'Physician brief not yet generated. Intake may still be in progress.',
            });
            return;
        }

        // Integrity + provenance context for the doctor: liveness/bot signals
        // from the intake session, consent stamp, and the latest visit vitals
        // (with who entered them) from the consultation itself.
        let integrity: Record<string, unknown> | null = null;
        let consentForCare: unknown = null;
        let visitVitals: unknown = null;
        try {
            const [sessionDoc, consultDoc, queueSnap] = await Promise.all([
                collections.intakeSessions.doc(consultationId).get(),
                collections.consultations.doc(consultationId).get(),
                collections.telehealthQueue.where('consultationId', '==', consultationId).limit(1).get(),
            ]);
            const session = sessionDoc.exists ? sessionDoc.data()! : {};
            const botSignals = Number(session.botSignals) || 0;
            integrity = {
                botSignals,
                livenessFlag: botSignals >= 3 ? 'suspect' : 'passed',
                note: botSignals >= 3
                    ? 'Message cadence suggests automated or scripted input — verify identity on connection.'
                    : 'Intake message cadence consistent with a human respondent.',
            };
            consentForCare = queueSnap.empty ? null : (queueSnap.docs[0].data().consentForCare ?? null);
            visitVitals = consultDoc.exists ? (consultDoc.data()?.vitals ?? null) : null;
        } catch { /* context is additive — never block the brief */ }

        res.json({
            success: true,
            data: {
                brief: resolvedBrief,
                transcript: result.transcript,
                integrity,
                consentForCare,
                visitVitals,
            },
        });
    })
);

/**
 * POST /ai-intake/:consultationId/defer
 * Defer AI Hx intake ONLY for booking a future scheduled appointment.
 * Nobody sees a doctor without completing Hx intake (either via AI Intake Bot OR Nurse).
 * Therefore `isComplete` and `canSeeDoctor` remain `false` until completed at appointment time.
 */
router.post('/:consultationId/defer', authenticate, authorize('patient'),
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { consultationId } = req.params;
        const requestedMode = req.body?.mode;

        if (requestedMode === 'instant') {
            res.status(400).json({
                success: false,
                code: 'HX_INTAKE_REQUIRED_FOR_INSTANT',
                error: 'Skipping or deferring the AI intake bot is only allowed to book a future scheduled appointment. Nobody sees a doctor without completing Hx intake via AI or a Nurse.',
            });
            return;
        }

        const [consultDoc, sessionDoc] = await Promise.all([
            collections.consultations.doc(consultationId).get(),
            collections.intakeSessions.doc(consultationId).get(),
        ]);

        const consultData = consultDoc.exists ? consultDoc.data() : null;
        const sessionData = sessionDoc.exists ? sessionDoc.data() : null;

        const ownerId = consultData?.patientId ?? sessionData?.patientId ?? null;
        if (ownerId && ownerId !== req.user!.userId) {
            res.status(403).json({
                success: false,
                error: 'You are not authorized to access this intake session.',
            });
            return;
        }

        if (consultData && (consultData.status === 'in_progress' || consultData.status === 'completed')) {
            res.status(400).json({
                success: false,
                code: 'CONSULTATION_ALREADY_ACTIVE',
                error: 'Cannot defer Hx intake for an active or completed consultation.',
            });
            return;
        }

        const now = new Date();
        if (consultDoc.exists) {
            await collections.consultations.doc(consultationId).set({
                intakeDeferredForBooking: true,
                intakeDeferredAt: now,
                hxIntakeComplete: false,
                mode: 'scheduled',
                updatedAt: now,
            }, { merge: true });
        }

        await collections.intakeSessions.doc(consultationId).set({
            consultationId,
            patientId: req.user!.userId,
            intakeDeferredForBooking: true,
            intakeDeferredAt: now,
            isComplete: false,
            updatedAt: now,
        }, { merge: true });

        res.json({
            success: true,
            message: 'AI intake deferred for future scheduled appointment booking. Hx intake must still be completed (by AI or Nurse) before seeing the doctor.',
            data: {
                consultationId,
                intakeDeferredForBooking: true,
                isComplete: false,
                aiComplete: false,
                nurseComplete: false,
                completedBy: null,
                canSeeDoctor: false,
                briefGenerated: false,
            },
        });
    })
);

/**
 * Roles permitted to complete Nurse / Assisted Hx Intake on behalf of a walk-in or scheduled patient.
 */
const NURSE_HX_INTAKE_ROLES = [
    'nurse', 'care_home_nurse', 'midwife', 'doctor',
    'pharmacist', 'pharmacy_admin', 'medicine_store_attendant', 'receptionist' as any,
    'clinical_officer' as any, 'community_health_worker' as any,
    'hospital_admin', 'clinic_admin', 'care_home_admin', 'admin', 'super_admin',
] as const;

function normalizeStringList(val: unknown): string[] {
    if (Array.isArray(val)) {
        return val.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof val === 'string' && val.trim().length > 0) {
        return val.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
}

/**
 * POST /ai-intake/:consultationId/nurse-complete
 * Records Nurse Hx Intake on the consultation and generates/updates the structured
 * clinical brief so the doctor has the full pre-consultation Hx summary.
 */
router.post('/:consultationId/nurse-complete', authenticate, authorize(...NURSE_HX_INTAKE_ROLES),
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { consultationId } = req.params;
        const {
            chiefComplaint,
            presentingComplaint,
            historyOfPresentIllness,
            hpiNotes,
            pastMedicalHistory,
            medicalHistory,
            medications,
            currentMedications,
            allergies,
            vitals,
            triagePriority,
            severity,
            symptomDuration,
            duration,
            notes,
            associatedSymptoms,
        } = req.body || {};

        const rawChiefComplaint = chiefComplaint || presentingComplaint;
        const rawHpi = historyOfPresentIllness || hpiNotes;
        const rawDuration = symptomDuration || duration;

        if (!rawChiefComplaint && !rawHpi && !notes && !vitals) {
            res.status(400).json({
                success: false,
                error: 'At least chiefComplaint (or presentingComplaint), historyOfPresentIllness (or hpiNotes), vitals, or notes is required to complete Nurse Hx intake.',
            });
            return;
        }

        const consultDoc = await collections.consultations.doc(consultationId).get();
        const consultData = consultDoc.exists ? consultDoc.data() : null;

        // Enforce facility scoping when consultation is bound to a specific facility
        if (consultData?.facilityId && req.user!.facilityId && consultData.facilityId !== req.user!.facilityId && !isPlatformAdmin(req.user!)) {
            res.status(403).json({
                success: false,
                error: 'You are not authorized to complete intake for another facility.',
            });
            return;
        }

        const pmhList = normalizeStringList(pastMedicalHistory ?? medicalHistory);
        const medsList = normalizeStringList(medications ?? currentMedications);
        const allergiesList = normalizeStringList(allergies);
        const assocSymptoms = normalizeStringList(associatedSymptoms);

        const rawPriority = String(triagePriority || severity || 'routine').toLowerCase();
        const urgencyAssessment: 'low' | 'moderate' | 'high' | 'emergency' =
            rawPriority === 'emergency' || rawPriority === 'critical'
                ? 'emergency'
                : rawPriority === 'urgent' || rawPriority === 'high' || rawPriority === 'severe'
                    ? 'high'
                    : rawPriority === 'moderate' || rawPriority === 'medium'
                        ? 'moderate'
                        : 'low';
        const triageCategory: 'emergency' | 'urgent' | 'routine' =
            urgencyAssessment === 'emergency'
                ? 'emergency'
                : urgencyAssessment === 'high'
                    ? 'urgent'
                    : 'routine';

        const completedAt = new Date();
        const completedBy = req.user!.userId;
        const resolvedChiefComplaint = String(rawChiefComplaint || notes || 'Walk-in Nurse Intake').trim();
        const resolvedDuration = rawDuration ? String(rawDuration).trim() : '';
        const hpiParts = [
            rawHpi ? String(rawHpi).trim() : null,
            !rawHpi && resolvedDuration ? `Duration: ${resolvedDuration}` : null,
            !rawHpi && severity ? `Severity: ${String(severity).trim()}` : null,
            !rawHpi && notes ? String(notes).trim() : null,
        ].filter(Boolean);
        const resolvedHpi = hpiParts.length > 0
            ? hpiParts.join('. ')
            : String(rawChiefComplaint || 'Recorded by nursing staff during pre-consultation intake.').trim();

        const resolvedVitals = vitals || consultData?.vitals || null;
        const structuredBrief = {
            consultationId,
            generatedAt: completedAt,
            generatedBy: 'nurse_intake',
            completedBy,
            completedByRole: req.user!.role,
            chiefComplaint: resolvedChiefComplaint,
            presentingComplaint: resolvedChiefComplaint,
            historyOfPresentIllness: resolvedHpi,
            hpiNarrative: resolvedHpi,
            symptomDuration: resolvedDuration || null,
            severity: severity ? String(severity).trim() : rawPriority,
            associatedSymptoms: assocSymptoms,
            pastMedicalHistory: pmhList,
            currentMedications: medsList,
            medicationList: medsList,
            allergies: allergiesList,
            allergyList: allergiesList,
            vitals: resolvedVitals,
            vitalSignsToCheck: resolvedVitals ? [] : ['BP', 'Temperature', 'Heart Rate', 'SpO2'],
            urgencyAssessment,
            triagePriority: rawPriority,
            clinicalSummary: `Nurse Hx Intake — Chief Complaint: ${resolvedChiefComplaint}. HPI: ${resolvedHpi}.${notes ? ` Nurse Notes: ${String(notes).trim()}` : ''}`,
            differentialDiagnosis: [],
            reviewOfSystems: [],
            recommendedQuestions: [],
            suggestedQuestions: [],
            explicitNegatives: [],
            redFlags: urgencyAssessment === 'emergency' || urgencyAssessment === 'high'
                ? [resolvedChiefComplaint]
                : [],
            nurseNotes: notes ? String(notes).trim() : null,
            contextNotes: `Walk-in / Nurse Hx Intake completed by ${req.user!.role} (${completedBy}).`,
        };

        const mergedVitals = vitals
            ? { ...(consultData?.vitals || {}), ...vitals, recordedBy: completedBy, recordedAt: completedAt.toISOString() }
            : (consultData?.vitals || null);

        await collections.consultations.doc(consultationId).set({
            consultationId,
            nurseIntakeComplete: true,
            nurseComplete: true,
            nurseIntakeCompletedBy: completedBy,
            nurseIntakeCompletedAt: completedAt,
            hxIntakeComplete: true,
            hxIntakeMethod: 'nurse',
            intakeCompleted: true,
            intakeDeferredForBooking: false,
            chiefComplaint: resolvedChiefComplaint,
            presentingComplaint: resolvedChiefComplaint,
            historyOfPresentIllness: resolvedHpi,
            ...(resolvedDuration ? { symptomDuration: resolvedDuration } : {}),
            pastMedicalHistory: pmhList,
            medications: medsList,
            allergies: allergiesList,
            ...(mergedVitals ? { vitals: mergedVitals } : {}),
            triagePriority: rawPriority,
            triageCategory,
            urgencyLevel: urgencyAssessment,
            triagedAt: completedAt,
            nurseIntakeNotes: notes ? String(notes).trim() : null,
            physicianBrief: structuredBrief,
            intakeData: {
                ...(consultData?.intakeData || {}),
                isComplete: true,
                nurseComplete: true,
                completedBy: 'nurse',
                chiefComplaint: resolvedChiefComplaint,
                historyOfPresentIllness: resolvedHpi,
            },
            updatedAt: completedAt,
        }, { merge: true });

        await collections.intakeSessions.doc(consultationId).set({
            consultationId,
            ...(consultData?.patientId ? { patientId: consultData.patientId } : {}),
            ...(consultData?.facilityId || req.user!.facilityId ? { facilityId: consultData?.facilityId || req.user!.facilityId } : {}),
            isComplete: true,
            nurseIntakeComplete: true,
            nurseComplete: true,
            nurseIntakeCompletedBy: completedBy,
            nurseIntakeCompletedAt: completedAt,
            hxIntakeComplete: true,
            hxIntakeMethod: 'nurse',
            intakeDeferredForBooking: false,
            brief: structuredBrief,
            ...(mergedVitals ? { vitals: mergedVitals } : {}),
            structuredHistory: {
                chiefComplaint: resolvedChiefComplaint,
                duration: resolvedDuration,
                severity: severity ? String(severity).trim() : rawPriority,
                associatedSymptoms: assocSymptoms,
                pastMedicalHistory: pmhList,
                currentMedications: medsList,
                allergies: allergiesList,
                socialHistory: notes ? String(notes).trim() : '',
                reviewOfSystems: resolvedHpi,
            },
            updatedAt: completedAt,
        }, { merge: true });

        res.json({
            success: true,
            message: 'Nurse Hx intake completed and clinical brief generated',
            data: {
                consultationId,
                isComplete: true,
                aiComplete: false,
                nurseComplete: true,
                completedBy: 'nurse' as const,
                intakeDeferredForBooking: false,
                canSeeDoctor: true,
                briefGenerated: true,
                brief: structuredBrief,
            },
        });
    })
);

// GET /ai-intake/:consultationId/status — Check intake status
// H2: relationship-gated. Owner patient, assigned doctor, same-facility clinical
// staff, or platform admin only (status exposes the full structured history).
router.get('/:consultationId/status', authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { consultationId } = req.params;

        const ctx = await loadConsultationContext(consultationId);
        const isSameFacilityAssistedIntakeStaff = Boolean(
            ctx
            && WALK_IN_STAFF_ROLES.includes(req.user!.role as any)
            && req.user!.facilityId
            && ctx.facilityId
            && req.user!.facilityId === ctx.facilityId
        );
        // Non-existent intake → return the empty/not-found status (no PHI to leak);
        // this preserves the pre-intake polling flow. If it exists, gate access.
        if (ctx && !canViewConsultationClinicalData(req.user!, ctx) && !isSameFacilityAssistedIntakeStaff) {
            res.status(403).json({ success: false, error: 'You are not authorized to view this intake session.' });
            return;
        }

        const [status, consultDoc, sessionDoc] = await Promise.all([
            getIntakeStatus(consultationId),
            collections.consultations.doc(consultationId).get(),
            collections.intakeSessions.doc(consultationId).get(),
        ]);

        const consultData = consultDoc.exists ? consultDoc.data() : null;
        const sessionData = sessionDoc.exists ? sessionDoc.data() : null;

        const nurseComplete = Boolean(
            consultData?.nurseIntakeComplete === true
            || consultData?.nurseComplete === true
            || consultData?.intakeData?.nurseComplete === true
            || consultData?.hxIntakeMethod === 'nurse'
            || sessionData?.nurseIntakeComplete === true
            || sessionData?.nurseComplete === true
            || sessionData?.hxIntakeMethod === 'nurse'
            || sessionData?.status === 'sent_to_doctor'
            || (consultData?.triagedAt && consultData?.vitals)
        );

        const aiComplete = Boolean(
            (status.isComplete && !nurseComplete)
            || consultData?.hxIntakeMethod === 'ai'
            || consultData?.hxIntakeMethod === 'assisted_ai'
            || (consultData?.intakeCompleted === true && !nurseComplete)
        );

        const isComplete = Boolean(aiComplete || nurseComplete);
        const completedBy: 'ai' | 'nurse' | null = nurseComplete ? 'nurse' : (aiComplete ? 'ai' : null);
        const intakeDeferredForBooking = isComplete
            ? false
            : Boolean(consultData?.intakeDeferredForBooking || sessionData?.intakeDeferredForBooking);
        const canSeeDoctor = Boolean(aiComplete || nurseComplete);

        let brief = (status as any)?.brief || consultData?.physicianBrief || sessionData?.brief || null;
        const briefGenerated = Boolean(status.briefGenerated || brief);

        if (req.user!.role === 'patient') {
            if (brief && typeof brief === 'object') {
                brief = { ...brief };
                delete (brief as any).differentialDiagnosis;
            }
            if ((status as any)?.session?.brief) {
                delete (status as any).session.brief.differentialDiagnosis;
            }
        }

        const enhancedStatus = {
            ...status,
            exists: Boolean((status as any).exists || sessionDoc.exists || consultDoc.exists),
            isComplete,
            aiComplete,
            nurseComplete,
            completedBy,
            intakeDeferredForBooking,
            canSeeDoctor,
            briefGenerated,
            brief,
        };

        res.json({ success: true, data: enhancedStatus });
    })
);

// ============================================================
// Meta Hackathon Multimodal Clinical Endpoints
// ============================================================

// 1. SAM 3.1 & Multimodal Clinical Vision
router.post(
    '/vision/analyze',
    asyncHandler(async (req: Request, res: Response) => {
        const {
            type,
            imageBase64,
            imageUrl,
            consultationId,
            patientId,
            clinicalContext,
            facilityLicenceClass,
            referenceScaleMm,
            hasActiveLinkedRx,
        } = req.body;
        if (!type) {
            res.status(400).json({ success: false, error: 'type is required' });
            return;
        }
        const effectiveImageBase64 = imageBase64 || (!imageUrl ? 'placeholder_for_preset' : undefined);
        const result = await medicalVisionService.analyzeImage({
            type,
            imageBase64: effectiveImageBase64,
            imageUrl,
            consultationId,
            patientId,
            clinicalContext,
            facilityLicenceClass,
            hasActiveLinkedRx: Boolean(hasActiveLinkedRx),
            ...(typeof referenceScaleMm === 'number' ? { referenceScaleMm } : {}),
        } as any);
        res.json({ success: true, data: result.suggestion, safety: result });
    })
);

// 2. NAFDAC Drug-Pack Verification & PCN PPMV Scope Gate
router.post(
    '/nafdac/verify',
    asyncHandler(async (req: Request, res: Response) => {
        const { nafdacRegNo, drugName, batchNumber, expiryDate, facilityLicenceClass, hasActiveLinkedRx, imageBase64 } = req.body;
        if (imageBase64) {
            const visionResult = await nafdacVerificationService.verifyDrugPackImage({
                imageBase64,
                facilityLicenceClass,
                hasActiveLinkedRx,
            });
            res.json({ success: true, data: visionResult });
            return;
        }
        const textResult = nafdacVerificationService.verifyMedicine({
            nafdacRegNo,
            drugName,
            batchNumber,
            expiryDate,
            facilityLicenceClass,
            hasActiveLinkedRx,
        });
        res.json({ success: true, data: textResult });
    })
);

// 3. Two-Way Doctor-Patient Call Voice Segregation (Diarization + MMS ASR)
router.post(
    ['/call-diarize', '/:consultationId/call-diarize'],
    asyncHandler(async (req: Request, res: Response) => {
        const { audioBase64, dialogue, customDialogue, customTranscript, language, stripNoise } = req.body;
        const result = await callVoiceDiarizationService.diarizeConsultationAudio({
            audioBase64,
            dialogue: dialogue || customDialogue || customTranscript,
            consultationId: req.params.consultationId,
            language,
            stripNoise,
        });
        res.json({ success: true, data: result });
    })
);

// 4. Live Serverless DDx & Automated SOAP Co-Pilot (Muse Wonder)
router.post(
    '/:consultationId/copilot-sync',
    asyncHandler(async (req: Request, res: Response) => {
        const { transcript, intakeHistory, vitals, visionFindings, language } = req.body;
        const result = await aiCopilotService.generateLiveConsultationCopilot({
            consultationId: req.params.consultationId,
            transcript,
            intakeHistory,
            vitals,
            visionFindings,
            language,
        });
        res.json({ success: true, data: result });
    })
);

// 5. RLHF Clinical Evaluation Flywheel
router.post(
    '/rlhf/feedback',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { consultationId, patientId, module, action, aiSuggestion, doctorAction, doctorCorrection, timeTakenMs } = req.body;
        const record = await trainingDataService.recordAIFeedback({
            consultationId,
            patientId,
            tenantId: (req.user as any)?.facilityId || 'docarion_hq',
            module: module || 'ddx',
            action: action || 'accepted',
            aiSuggestion,
            doctorAction,
            doctorCorrection,
            doctorId: req.user!.userId,
            timeTakenMs,
        });
        res.json({ success: true, data: record });
    })
);

router.get(
    '/rlhf/summary',
    asyncHandler(async (_req: Request, res: Response) => {
        const metrics = await trainingDataService.getTrainingStats();
        res.json({ success: true, data: metrics });
    })
);

export default router;
