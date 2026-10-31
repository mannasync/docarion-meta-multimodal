import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/error.middleware';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.middleware';
import { allowCareStation, allowCareStationStaff } from '../middleware/care-station-access.middleware';
import {
    conductIntake, getIntakeStatus, getPhysicianBrief, GuestSessionConflictError, generatePhysicianBrief,
} from '../services/ai-intake.service';
import { createQueueEntryForConsultation, markQueueEntryIntakeComplete } from '../services/queue-entry.service';
import { computeCompleteness } from '../services/intake-history.service';
import { verifyGuestSession, GUEST_SESSION_ID_RE } from '../services/guest-session-token.service';
import { IntakeLocationContext, NearestEmergencyFacility, findNearestEmergencyFacilities, attachNearestEmergencyServices } from '../services/intake-emergency.service';
import type { NearestEmergencyService } from '../services/emergency-services.service';
import { collections, firestore } from '../config/database';
import {
    canViewConsultationClinicalData,
    canViewPhysicianBrief,
    isPlatformAdmin,
    ConsultationContext,
} from '../utils/consultation-access';
import { resolveDoctorScope, facilityUsesPlatformDoctorsAt } from '../services/doctor-scope.service';
import { facilityContextRequiredBody, platformCanSeeFacility } from '../utils/platform-facility-context';
import { logAudit } from '../services/audit.service';
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
import { clientIp } from '../utils/client-ip';
import { estimateState } from '../utils/nigeria-states';
import { claimOrVerifyGuestSession, guestTokenFrom } from '../services/guest-session-token.service';
import { medicalVisionService } from '../services/medical-vision.service';
import { nafdacVerificationService } from '../services/nafdac-verification.service';
import { callVoiceDiarizationService, DiarizationUnavailableError } from '../services/call-voice-diarization.service';
import { aiCopilotService } from '../services/ai-copilot.service';
import { trainingDataService } from '../services/training-data.service';
import { centralRecordFacilityId, partnerSiteIdOf } from '../config/tenancy';

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

/**
 * A registered Care Station device (services/care-station.service.ts). Only
 * the patient-facing Care Station routes accept it (allowCareStation).
 */
const STATION_DEVICE = 'care_station' as any;

/**
 * A Care Station device may only act on intake sessions it created itself
 * (its own check-ins). Staff are unaffected. Returns false for any other
 * session so the caller can answer 404 without disclosing it exists.
 */
function stationMaySeeSession(user: AuthRequest['user'], sessionData: any): boolean {
    if (user?.role !== STATION_DEVICE) return true;
    return !!sessionData && sessionData.createdByStationId === (user as any).stationId;
}

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
                    state: facility.address?.state || facility.state || null,
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
            state: nearest.state,
            distance: `${Math.round(minDistance)}m`
        };
    }

    return {
        in_facility: false,
        nearestFacility: nearest ? {
            facilityId: nearest.facilityId,
            facilityName: nearest.facilityName,
            type: nearest.type,
            state: nearest.state,
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

// ============================================================
// POST /ai-intake/guest/:sessionId/attach — guest → account conversion
// ============================================================
// A patient who started the AI triage as a GUEST (web /triage, patient-app
// guest intake) signs up and continues WITHOUT repeating themselves: the guest
// session (transcript, history state, triage, red flags) is copied into a new
// consultation owned by the signed-in patient, which is then queued (or marked
// intake_complete and briefed) exactly as an authenticated intake would be.
//
// Security (C2): binding requires the guest token minted on the first guest
// message; the guest doc is COPIED to a brand-new consultation id, never merged
// into any existing patient session, and carry-over seeding never runs.
router.post('/guest/:sessionId/attach', authenticate, authorize('patient'), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const sessionId = String(req.params.sessionId || '').trim();
        if (!GUEST_SESSION_ID_RE.test(sessionId)) {
            res.status(400).json({ success: false, error: 'Invalid session id' });
            return;
        }
        const tokenOk = await verifyGuestSession(sessionId, guestTokenFrom(req));
        if (!tokenOk) {
            res.status(403).json({ success: false, code: 'GUEST_TOKEN_INVALID', error: 'This symptom check could not be verified. Please start a new one.' });
            return;
        }

        const guestDoc = await collections.intakeSessions.doc(sessionId).get();
        if (!guestDoc.exists) {
            res.status(404).json({ success: false, error: 'Session not found' });
            return;
        }
        const guest: any = guestDoc.data() || {};
        const patientId = req.user!.userId;

        // Already attached by this patient → idempotent.
        if (guest.patientId && guest.patientId !== patientId) {
            res.status(409).json({ success: false, code: 'SESSION_OTHER_ACCOUNT', error: 'This symptom check belongs to another account.' });
            return;
        }
        if (guest.patientId === patientId && guest.attachedToConsultationId) {
            const existing = await collections.consultations.doc(guest.attachedToConsultationId).get();
            if (existing.exists) {
                res.json({
                    success: true,
                    data: attachResponse(guest.attachedToConsultationId, existing.data() || {}, guest, true),
                });
                return;
            }
        }

        // ── Create the patient's consultation (instant, general) ──
        const consultationId = uuidv4();
        // The guest route stamps `facilityId` on the session only when the
        // patient was confirmed INSIDE a facility (Care Station / verified desk).
        const facilityId: string | null = guest.facilityId ? String(guest.facilityId) : null;
        const identifier = await issueRecordIdentifierFields('consultation', consultationId, { facilityId });
        const chiefComplaint: string | null =
            guest.historyState?.chiefComplaint?.text
            || guest.historyState?.chiefComplaint
            || (Array.isArray(guest.messages) ? guest.messages.find((m: any) => m?.role === 'user')?.content : null)
            || null;
        const isComplete = guest.isComplete === true;
        const emergency = guest.emergencyDetected === true;
        const triage = guest.triage || null;
        const now = new Date();
        const consultation: Record<string, any> = {
            consultationId,
            ...identifier,
            patientId,
            is_sandbox: req.isSandbox || false,
            doctorId: null,
            facilityId: centralRecordFacilityId(facilityId),
            type: 'video',
            mode: 'instant',
            specialtyId: 'general',
            status: isComplete ? 'intake_complete' : 'pending',
            scheduledAt: now,
            symptoms: chiefComplaint ? [String(chiefComplaint).slice(0, 2000)] : [],
            preferredLanguage: guest.language || guest.historyState?.language || 'en',
            intakeSessionId: sessionId,
            attachedFromGuestSessionId: sessionId,
            fee: 0,
            paymentStatus: 'completed',
            ...(emergency && {
                urgencyLevel: 'emergency', esiLevel: 1, triageColor: 'red', triageCategory: 'emergency',
                emergencyDetectedAt: guest.emergencyDetectedAt || now,
                intakeRedFlags: (guest.redFlags || []).map((f: any) => ({ id: f.id, label: f.label, severity: f.severity })),
            }),
            ...(!emergency && triage?.category && {
                triageCategory: triage.category, esiLevel: triage.esiLevel ?? null, triagedAt: now, triageReason: triage.reason || null,
                urgencyLevel: triage.category === 'urgent' ? 'high' : 'low',
            }),
            ...(isComplete && { intakeCompleted: true, intakeCompletedAt: guest.completedAt || now }),
            createdAt: now,
            updatedAt: now,
        };
        await collections.consultations.doc(consultationId).set(consultation);
        await ensureEncounterForConsultation(consultationId, consultation).catch(() => null);

        // ── Copy the guest session onto the consultation id (the intake session id IS the consultation id) ──
        const { guest: _g, anonymousClientKey: _k, ...rest } = guest;
        await collections.intakeSessions.doc(consultationId).set({
            ...rest,
            id: consultationId,
            consultationId,
            patientId,
            attachedFromGuestSessionId: sessionId,
            attachedAt: now,
            updatedAt: now,
        });
        await collections.intakeSessions.doc(sessionId).set({
            patientId,
            attachedToConsultationId: consultationId,
            attachedAt: now,
        }, { merge: true });
        // The guest secret has done its job.
        await firestore.collection('guestSessionTokens').doc(sessionId).delete().catch(() => { });

        // ── Queue: hidden until the intake completes; emergencies surface at once ──
        let patientName = 'Patient';
        try {
            const u = (await collections.users.doc(patientId).get()).data();
            patientName = `${u?.profile?.firstName || u?.firstName || ''} ${u?.profile?.lastName || u?.lastName || ''}`.trim() || u?.email || 'Patient';
        } catch { /* best-effort */ }
        const queueEntry = await createQueueEntryForConsultation({
            consultationId,
            patientId,
            patientName,
            facilityId,
            symptoms: consultation.symptoms,
            urgencyLevel: consultation.urgencyLevel || 'low',
            triageCategory: consultation.triageCategory || null,
            preferredLanguage: consultation.preferredLanguage,
            isSandbox: req.isSandbox || false,
            intakePending: !isComplete && !emergency,
            consentMethod: 'guest_intake_attach',
        }).catch(() => null);
        if (isComplete || emergency) {
            await markQueueEntryIntakeComplete(consultationId, { emergency }).catch(() => null);
            generatePhysicianBrief(consultationId).catch(() => { /* lazily regenerated on GET /brief */ });
        }
        consultation.queueId = queueEntry?.queueId || null;

        res.status(201).json({ success: true, data: attachResponse(consultationId, consultation, guest, false) });
    })
);

/** Patient-safe projection of an attached session (never differentials/brief). */
function attachResponse(consultationId: string, consultation: any, session: any, reused: boolean) {
    const messages = (Array.isArray(session.messages) ? session.messages : [])
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m: any) => ({ role: m.role, content: String(m.content ?? ''), timestamp: m.timestamp ?? null }));
    const triage = session.triage
        ? { category: session.triage.category, esiLevel: session.triage.esiLevel ?? null, reason: session.triage.reason ?? null }
        : null;
    let completenessRaw: number | null = null;
    try {
        completenessRaw = session.historyState ? computeCompleteness(session.historyState).percent : null;
    } catch { completenessRaw = null; }
    return {
        consultationId,
        queueId: consultation.queueId ?? null,
        status: consultation.status ?? 'pending',
        isComplete: session.isComplete === true,
        questionNumber: Number(session.turnCount) || messages.filter((m: any) => m.role === 'user').length,
        totalExpected: 18,
        messages,
        triage,
        completeness: typeof completenessRaw === 'number' ? completenessRaw : null,
        emergencyDetected: session.emergencyDetected === true,
        language: session.language || session.historyState?.language || 'en',
        reused,
    };
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

    // The guest session id is client-chosen and guessable: the first message
    // mints a secret (returned once) that every later message must carry.
    const guestClaim = await claimOrVerifyGuestSession(String(sessionId), guestTokenFrom(req));
    if (!guestClaim.ok) {
        res.status(404).json({ success: false, error: 'Session not found. Please start a new symptom check.' });
        return;
    }

    // We reuse conductIntake using sessionId as consultationId.
    // C2 — guest flag: the service refuses to bind to (or seed history from) a
    // real patient's consultation/session and never runs carry-over seeding.
    const liveness = await livenessCheck(sessionId, String(message));
    if (liveness.block) {
        res.status(429).json({ success: false, error: 'You are sending messages too quickly. Please slow down and answer in your own words.' });
        return;
    }

    // Location is resolved BEFORE the AI turn so an emergency on this very
    // message gets the right advice. A guest is unauthenticated and both the
    // coordinates and the 4-digit desk code are client-supplied, so a facility
    // match is never trusted as "inside the facility": it is marked unverified,
    // which gives both the "tell staff" and the "go to the nearest hospital" advice and never
    // fires a lock-screen alert at that facility's staff.
    let facilityContext = null;
    if (lat && lng) {
        facilityContext = await findNearestFacility(Number(lat), Number(lng));
    }
    let guestFacility: { facilityId: string; facilityName?: string | null; type?: string | null } | null = null;
    if (facilityContext?.in_facility && facilityContext.facilityId) {
        guestFacility = { facilityId: facilityContext.facilityId, facilityName: facilityContext.facilityName, type: facilityContext.type };
    } else if (!facilityContext) {
        const priorSession = (await collections.intakeSessions.doc(sessionId).get()).data();
        if (priorSession?.facilityId && !priorSession?.patientId) {
            guestFacility = { facilityId: priorSession.facilityId, facilityName: priorSession.facilityName };
        }
    }
    const guestLocation: IntakeLocationContext = guestFacility
        ? {
            kind: 'in_facility',
            facilityId: guestFacility.facilityId,
            facilityName: guestFacility.facilityName || null,
            facilityType: guestFacility.type || null,
            edCapable: false,
            unverified: true,
            source: 'guest_geo',
        }
        : { kind: 'home', source: 'guest' };
    // Approximate area for the call-back (regional admin). Rounded to ~100 m.
    if (facilityContext) {
        const near: any = facilityContext.in_facility ? facilityContext : facilityContext.nearestFacility;
        const latN = Number(lat);
        const lngN = Number(lng);
        guestLocation.approxLocation = {
            state: estimateState(latN, lngN, {
                state: near?.state,
                distanceKm: near?.distance ? parseInt(String(near.distance), 10) / 1000 : null,
            }),
            lat: Number.isFinite(latN) ? Math.round(latN * 1000) / 1000 : null,
            lng: Number.isFinite(lngN) ? Math.round(lngN * 1000) / 1000 : null,
            nearestFacilityName: near?.facilityName || null,
        };
    }

    let result;
    try {
        // Hashed client address: only used to limit how many anonymous emergencies
        // one device can page admins with. Never stored in clear.
        const anonymousClientKey = crypto
            .createHmac('sha256', process.env.JWT_SECRET || 'docarion')
            .update(clientIp(req) || 'unknown')
            .digest('hex')
            .slice(0, 32);
        result = await conductIntake(message.trim(), sessionId, validLanguage, { guest: true, location: guestLocation, anonymousClientKey });
    } catch (e) {
        if (e instanceof GuestSessionConflictError) {
            res.status(400).json({ success: false, error: e.message });
            return;
        }
        throw e;
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
        sessionUpdate.unverifiedLocation = true;

        // Only set status if it doesn't already exist to avoid overwriting nurse vitals status
        const sessionDoc = await collections.intakeSessions.doc(sessionId).get();
        if (!sessionDoc.exists || !sessionDoc.data()?.status) {
            sessionUpdate.status = 'waiting_vitals';
        }
    }
    
    await collections.intakeSessions.doc(sessionId).set(sessionUpdate, { merge: true });

    // A patient who can travel is shown the closest emergency-capable care.
    let nearestEmergencyFacilities: NearestEmergencyFacility[] = [];
    if (result.emergencyDetected && lat && lng) {
        nearestEmergencyFacilities = await findNearestEmergencyFacilities(Number(lat), Number(lng), { limit: 3 })
            .catch(() => []);
    }
    // Verified PRIVATE emergency-transport providers (independent, fees apply)
    // as an aid to reaching hospital — never a reason to wait at home.
    let nearestEmergencyServices: NearestEmergencyService[] = [];
    if (result.emergencyDetected && (lat && lng || guestLocation.approxLocation?.state)) {
        nearestEmergencyServices = await attachNearestEmergencyServices(
            lat && lng ? Number(lat) : null,
            lat && lng ? Number(lng) : null,
            guestLocation.approxLocation?.state ?? null,
        );
    }

    res.json({
        success: true,
        data: {
            ...result,
            facilityContext,
            nearestEmergencyFacilities,
            nearestEmergencyServices,
            ...(guestClaim.newToken ? { guestToken: guestClaim.newToken } : {}),
        },
    });
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
router.post('/care-station/patient-lookup', allowCareStation, authenticate, authorize(...WALK_IN_STAFF_ROLES, STATION_DEVICE),
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

        // A self-service kiosk is a public screen: it never learns whether an
        // account exists, never sees anyone's details and never creates
        // accounts. The check-in is recorded as typed and linked to an account
        // only by staff or by the patient signing in on their own phone.
        if (req.user!.role === STATION_DEVICE) {
            res.json({ success: true, data: { found: false, patient: null, stationCheckIn: true } });
            return;
        }

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
                // Placed here only by a guest's own coordinates: not confirmed
                // to be in the building. Shown flagged and never ranked first.
                unverifiedLocation: data.unverifiedLocation === true,
                updatedAt: data.updatedAt
            };
        })
        .filter(p => p.status !== 'sent_to_doctor')
        .sort((a, b) => {
            // Emergencies first (the patient is told they are moved to the
            // front of the queue), then urgent, then most recently updated.
            const rank = (c: string | null, unverified: boolean) =>
                (unverified ? 10 : 0) + (c === 'emergency' ? 0 : c === 'urgent' ? 1 : 2);
            const byTriage = rank(a.triageCategory, a.unverifiedLocation) - rank(b.triageCategory, b.unverifiedLocation);
            if (byTriage !== 0) return byTriage;
            const dateA = a.updatedAt?.toDate?.() || new Date(a.updatedAt || 0);
            const dateB = b.updatedAt?.toDate?.() || new Date(b.updatedAt || 0);
            return dateB.getTime() - dateA.getTime();
        });

    res.json({ success: true, data: walkIns });
}));

// DELETE /ai-intake/walk-ins/:sessionId — close a front-desk session that will
// not be seen (patient left, duplicate, registered in error). Reason required;
// facility from the token; nothing clinical is deleted. (Audit 2026-10-29 O3.)
router.delete('/walk-ins/:sessionId', allowCareStationStaff, authenticate, authorize(...WALK_IN_STAFF_ROLES), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
    const reason = typeof (req.body?.reason ?? req.query.reason) === 'string' ? String(req.body?.reason ?? req.query.reason).trim().slice(0, 300) : '';
    if (reason.length < 3) {
        res.status(400).json({ success: false, error: 'A reason is required to close a walk-in', code: 'REASON_REQUIRED' });
        return;
    }
    const ref = collections.intakeSessions.doc(req.params.sessionId);
    const sessionDoc = await ref.get();
    if (!sessionDoc.exists) {
        res.status(404).json({ success: false, error: 'Intake session not found' });
        return;
    }
    const session: any = sessionDoc.data();
    const sessionFacilityId = session?.facilityId || null;
    if (!(req.user!.facilityId && req.user!.facilityId === sessionFacilityId)
        && !platformCanSeeFacility(req.user!, sessionFacilityId)) {
        if (isPlatformAdmin(req.user!) && !req.user!.facilityId) {
            res.status(403).json(facilityContextRequiredBody(sessionFacilityId));
            return;
        }
        res.status(403).json({ success: false, error: 'This walk-in belongs to another facility.' });
        return;
    }
    if (['sent_to_doctor', 'cancelled', 'expired', 'completed'].includes(String(session?.status))) {
        res.status(409).json({ success: false, error: `This walk-in is already ${session.status}`, code: 'NOT_OPEN' });
        return;
    }
    await ref.update({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: req.user!.userId,
        cancelledByRole: req.user!.role,
        cancelReason: reason,
        updatedAt: new Date(),
    });
    await logAudit(req, 'WALKIN_CLOSED', 'intakeSession', req.params.sessionId, {
        details: { reason, previousStatus: session?.status || null }, facilityId: sessionFacilityId || undefined,
    });
    res.json({ success: true, message: 'Walk-in closed', data: { sessionId: req.params.sessionId, status: 'cancelled' } });
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
/**
 * Apply a staff-only gate to every caller except a registered Care Station
 * device (which is not a person and has no licence). Staff stay walled.
 */
function exceptStationDevice(gate: (req: AuthRequest, res: Response, next: (err?: any) => void) => any) {
    return (req: AuthRequest, res: Response, next: (err?: any) => void) =>
        (req.user?.role === STATION_DEVICE ? next() : gate(req, res, next));
}

// A registered Care Station may also check a patient in.
router.post('/walk-ins', allowCareStation, authenticate, authorize(...WALK_IN_STAFF_ROLES, STATION_DEVICE), exceptStationDevice(requireCompletedCredential()), intakeLimiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
    const facilityId = req.user!.facilityId;
    const fromStation = req.user!.role === STATION_DEVICE;
    if (!facilityId) {
        res.status(400).json({ success: false, error: 'Your account is not assigned to a facility.' });
        return;
    }

    const body = req.body || {};
    const { patientName, phone, age, gender, dateOfBirth, chiefComplaint } = body;
    // At a self-service station only staff assign triage, and a patient is
    // linked only through the phone lookup — never by a typed patient id.
    const triageCategory = fromStation ? undefined : body.triageCategory;
    const explicitPatientId = fromStation ? undefined : body.patientId;
    const name = typeof patientName === 'string' ? patientName.trim().slice(0, 120) : '';
    if (!name) {
        res.status(400).json({ success: false, error: 'patientName is required' });
        return;
    }

    let linkedPatientId: string | null = typeof explicitPatientId === 'string' && explicitPatientId.trim() ? explicitPatientId.trim() : null;
    let linkedMrn: string | null = null;
    let isExistingAccount = false;

    if (fromStation) {
        // Kiosk check-in: never bound to an account by a typed phone number.
    } else if (typeof phone === 'string' && phone.trim().length > 0) {
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
        source: fromStation ? 'care_station_kiosk' : 'staff_registration',
        ...(fromStation ? { createdByStationId: (req.user as any).stationId, phoneUnverified: true } : {}),
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
router.post('/walk-ins/:sessionId/vitals', allowCareStationStaff, authenticate, authorize(...WALK_IN_STAFF_ROLES), requireCompletedCredential(), intakeLimiter,
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
router.post('/walk-ins/:sessionId/send', allowCareStationStaff, authenticate, authorize(...WALK_IN_STAFF_ROLES), requireCompletedCredential(), intakeLimiter,
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
        facilityId: centralRecordFacilityId(sessionData.facilityId || null),
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
                facilityId: centralRecordFacilityId(null), // platform-wide queue → Central's doctors pick up
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
const HANDOFF_CODE_FAILURES_PER_HOUR = 60;

async function handoffCodeAttemptsExhausted(): Promise<boolean> {
    const hour = new Date().toISOString().slice(0, 13);
    const snap = await firestore.collection('handoffCodeFailures').doc(hour).get();
    return (Number(snap.data()?.count) || 0) >= HANDOFF_CODE_FAILURES_PER_HOUR;
}

async function recordHandoffCodeFailure(): Promise<void> {
    const hour = new Date().toISOString().slice(0, 13);
    const ref = firestore.collection('handoffCodeFailures').doc(hour);
    await firestore.runTransaction(async (tx: any) => {
        const count = (Number((await tx.get(ref)).data()?.count) || 0) + 1;
        tx.set(ref, { count, hour }, { merge: true });
    }).catch(() => undefined);
}

router.post('/walk-ins/claim-handoff',
    (req: AuthRequest, res: Response, next: any) => {
        const hasAuth = Boolean(req.headers?.authorization || (req as any).cookies?.token || (req as any).cookies?.accessToken);
        if (hasAuth || process.env.NODE_ENV === 'test') {
            return authenticate(req, res, () => next());
        }
        return next();
    },
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { sessionId, consultationId, handoffToken, phone } = req.body || {};
        // Web and the apps send the typed code as `code`.
        const handoffCode = req.body?.handoffCode ?? req.body?.code;
        const targetId = sessionId || consultationId || null;
        const usingTypedCode = !handoffToken && !!handoffCode;

        // A typed 6-digit code is short: cap failed code attempts platform-wide
        // so nobody can walk the code space. The QR link (long token) and a
        // signed-in patient are unaffected by the cap.
        if (usingTypedCode && !req.user && await handoffCodeAttemptsExhausted()) {
            res.status(429).json({
                success: false,
                error: 'Too many attempts. Scan the QR code on the Care Station screen, or sign in and try again.',
                code: 'HANDOFF_CODE_LOCKED',
            });
            return;
        }

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
            if (usingTypedCode) await recordHandoffCodeFailure();
            res.status(404).json({ success: false, error: 'Walk-in intake session not found.' });
            return;
        }

        const resolvedSessionId = sessionDoc.id;
        const sessionData = sessionDoc.data() || {};

        const tokenMatches = handoffToken && sessionData.handoffToken === String(handoffToken);
        const codeMatches = handoffCode && String(sessionData.handoffCode) === String(handoffCode).trim();
        if (!tokenMatches && !codeMatches) {
            if (usingTypedCode) await recordHandoffCodeFailure();
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

        // A session already linked to a patient is never re-linked to someone else.
        const claimingPatientId = req.user?.role === 'patient' ? req.user.userId : null;
        if (sessionData.patientId && claimingPatientId && sessionData.patientId !== claimingPatientId) {
            res.status(409).json({ success: false, error: 'This visit belongs to another account.', code: 'HANDOFF_OTHER_ACCOUNT' });
            return;
        }
        let resolvedPatientId: string | null = sessionData.patientId || claimingPatientId || null;

        // Linking by a typed phone number only for staff of this facility, who
        // can check the patient in person. Anyone else's typed number is kept
        // as unverified and never links an account.
        const staffOfFacility = !!req.user
            && WALK_IN_STAFF_ROLES.includes(req.user.role as any)
            && !!req.user.facilityId
            && req.user.facilityId === sessionData.facilityId;
        if (!resolvedPatientId && phone && !staffOfFacility) {
            await collections.intakeSessions.doc(resolvedSessionId).set({
                claimPhone: String(phone).slice(0, 32),
                claimPhoneUnverified: true,
            }, { merge: true });
        }

        if (!resolvedPatientId && phone && staffOfFacility) {
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
router.post('/walk-ins/:sessionId/chat', allowCareStation, authenticate, authorize(...WALK_IN_STAFF_ROLES, STATION_DEVICE),
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
        if (!stationMaySeeSession(req.user, sessionData)) {
            res.status(404).json({ success: false, error: 'Intake session not found' });
            return;
        }
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
router.post('/walk-ins/:sessionId/handoff-token', allowCareStation, authenticate, authorize(...WALK_IN_STAFF_ROLES, STATION_DEVICE),
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const { sessionId } = req.params;
        const sessionDoc = await collections.intakeSessions.doc(sessionId).get();
        if (!sessionDoc.exists) {
            res.status(404).json({ success: false, error: 'Intake session not found' });
            return;
        }

        const sessionData = sessionDoc.data() || {};
        const sessionFacilityId = sessionData.facilityId || null;
        if (!stationMaySeeSession(req.user, sessionData)) {
            res.status(404).json({ success: false, error: 'Intake session not found' });
            return;
        }
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
router.get('/care-station/:consultationId/terminal', allowCareStation, authenticate,
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
            (WALK_IN_STAFF_ROLES.includes(user.role as any)
                || (user.role === STATION_DEVICE && stationMaySeeSession(user, sessionData)))
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
router.post('/care-station/:consultationId/terminal-message', allowCareStation, authenticate,
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
            (WALK_IN_STAFF_ROLES.includes(user.role as any)
                || (user.role === STATION_DEVICE && stationMaySeeSession(user, sessionData)))
            && Boolean(user.facilityId && facilityId && user.facilityId === facilityId);
        const isPlatform = isPlatformAdmin(user);

        if (!isOwnerPatient && !isAssignedDoctor && !isSameFacilityStaff && !isPlatform) {
            res.status(403).json({ success: false, error: 'You are not authorized to send messages on this Care Station terminal.' });
            return;
        }

        const resolvedMode: 'patient_terminal' | 'staff_assisted' =
            senderMode === 'patient_terminal' || user.role === 'patient' || user.role === STATION_DEVICE
                ? 'patient_terminal'
                : 'staff_assisted';

        const messageId = uuidv4();
        const now = new Date();
        // The sender's name always comes from the record, never the client, so
        // nobody can post into the doctor's chat as someone else.
        void senderName;
        const resolvedSenderName = resolvedMode === 'patient_terminal'
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
            // Unclaimed item: the SAME scope predicate as the claim gate decides
            // whether this doctor may read the brief before claiming.
            try {
                const scope = await resolveDoctorScope(req.user);
                const fid = partnerSiteIdOf(ctx.facilityId);
                allowed = canViewPhysicianBrief(req.user, {
                    ...ctx,
                    facilityUsesPlatformDoctors: fid ? await facilityUsesPlatformDoctorsAt(fid).catch(() => false) : false,
                }, scope);
            } catch { /* fallback to allowed=false */ }
        }
        if (!ctx || !allowed) {
            res.status(403).json({ success: false, error: 'You are not authorized to view this physician brief.' });
            return;
        }

        const result = await getPhysicianBrief(consultationId, { regenerateIfMissing: true });

        if (result.status === 'generating') {
            res.status(202).json({
                success: true,
                status: 'generating',
                data: { brief: null, transcript: result.transcript, retryAfterSeconds: 5 },
            });
            return;
        }

        if (!result.brief) {
            res.status(404).json({
                success: false,
                code: result.error ? 'BRIEF_GENERATION_FAILED' : 'BRIEF_NOT_READY',
                error: result.error
                    ? 'The physician brief could not be generated for this intake. The transcript is still available.'
                    : 'Physician brief not yet generated. Intake may still be in progress.',
                data: { transcript: result.transcript },
            });
            return;
        }
        const resolvedBrief = result.brief;

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
                safety: result.safety,
                briefRaw: result.briefRaw,
                generatedAt: result.generatedAt,
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
router.post('/:consultationId/nurse-complete', allowCareStationStaff, authenticate, authorize(...NURSE_HX_INTAKE_ROLES),
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
        if (partnerSiteIdOf(consultData?.facilityId) && req.user!.facilityId && consultData?.facilityId !== req.user!.facilityId && !isPlatformAdmin(req.user!)) {
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
    // Call audio and transcripts are patient data: signed-in staff only.
    authenticate,
    asyncHandler(async (req: Request, res: Response) => {
        if ((req as AuthRequest).user?.role === 'patient') {
            res.status(403).json({ success: false, error: 'Not allowed' });
            return;
        }
        const { audioBase64, dialogue, customDialogue, customTranscript, language, stripNoise } = req.body;
        try {
            const result = await callVoiceDiarizationService.diarizeConsultationAudio({
                audioBase64,
                dialogue: dialogue || customDialogue || customTranscript,
                consultationId: req.params.consultationId,
                language,
                stripNoise,
            });
            res.json({ success: true, data: result });
        } catch (err) {
            if (err instanceof DiarizationUnavailableError) {
                res.status(503).json({ success: false, error: err.message, code: err.code });
                return;
            }
            throw err;
        }
    })
);

// 4. Live Serverless DDx & Automated SOAP Co-Pilot (Muse Wonder)
// Clinician decision support only: same access as the physician brief
// (patients and unrelated staff are refused; the patient-facing kiosk never calls it).
router.post(
    '/:consultationId/copilot-sync',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
        const ctx = await loadConsultationContext(req.params.consultationId);
        if (!ctx) {
            res.status(404).json({ success: false, error: 'Consultation or intake session not found' });
            return;
        }
        if (!canViewPhysicianBrief(req.user!, ctx)) {
            res.status(403).json({ success: false, error: 'The clinical co-pilot is available to the treating care team only.' });
            return;
        }
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
