import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { collections, FieldValue, firestore } from '../config/database';
import { rotaShiftsOnDate } from '../services/rota-reader.service';
import { addDays, doctorTimeZones, localClock, resolveDoctorHours, ResolvedDoctorHours } from '../services/doctor-hours.service';
// Guardian check: `memberId` must be an ACTIVE dependent of the caller.
import { isActiveFamilyDependentOf } from '../services/family-dependent.service';
import { doctorPresenceService } from '../services/doctor-presence.service';
import { logAudit } from '../services/audit.service';
import { notificationService } from '../services/notification.service';
import { emitToUser } from '../services/realtime.service';
import {
    computeSlaState,
    computeQueuePosition,
    normalizeBand,
    bandReassurance,
    summarizeSla,
    AVG_CONSULT_MINUTES as SLA_AVG_CONSULT_MINUTES,
    type TriageBand,
    type QueuePositionItem,
} from '../services/queue-sla.service';
import { toMillis } from '../utils/timestamp';
import { notifyQueueMilestoneOnWhatsApp } from '../services/wa-link.service';
import { UserRole } from '../types';
import { issueRecordIdentifierFields } from '../services/identifier.service';
import { evaluateEncounterCloseGate } from '../services/encounter-billing-gate.service';
import { ensureEncounterForConsultation, transitionEncounterFromConsultation } from '../services/identifier-coverage.service';
import { requireCompletedCredential } from '../middleware/credential-gate.middleware';
import { filterCredentialedPrincipals } from '../services/credential-gate.service';
import { requireMFA } from '../middleware/mfa.middleware';
import { createOrGetEpisode, linkSourceToEpisode, getEpisodeBySource } from '../services/consultation-episode.service';
import { activeFacilityContext, facilityContextRequiredBody, isPlatformPrincipal, platformCanSeeFacility } from '../utils/platform-facility-context';
import { computePatientOnlinePresence } from '../utils/consultation-access';

const router = Router();

/**
 * AUTH + MFA ARE APPLIED HERE, IN-ROUTER — NOT at the server.ts mount.
 *
 * Every route in this file already carried its own `authenticate`, so the
 * bare `app.use('/telehealth-queue', telehealthQueueRoutes)` mount was a
 * REDUNDANCY, not an unauthenticated hole. It was still the wrong shape:
 * the next route added here without remembering the per-route guard would
 * have published patient names, symptoms and triage bands to the internet.
 * Hoisting the guard to the router makes "authenticated" the default and
 * closes that class of mistake permanently.
 *
 * MFA reuses the platform's existing `requireMFA` policy verbatim (see
 * middleware/mfa.middleware.ts) — deliberately NOT a stricter local rule:
 *   - Patients are not in STAFF_ROLES, so /join, /leave, /position and
 *     /my-status are unaffected (no extra read, no new failure mode).
 *   - Privileged staff (admin, super_admin, it_admin) are hard-gated with no
 *     grace period — exactly as they already are on /patients, /doctors,
 *     /consultations and /admin, so this adds no NEW lockout.
 *   - Other staff sit inside the STAFF_MFA_ENFORCED_AFTER rollout window and
 *     pass with the `X-MFA-Enrollment-Due` nag header until the cutoff.
 *
 * Applied in-router (the clinical-docs.routes.ts precedent) rather than at the
 * mount so that the guard travels with the router: the route-level Jest suites
 * mount this router directly, and an auth model that only exists in server.ts
 * is an auth model those suites can never test.
 */
router.use(authenticate);
router.use(requireMFA);


/**
 * Build the live SLA-aware status payload for a single waiting/assigned queue
 * entry. Reads the current waiting set to compute band-aware position. Shared
 * by GET /my-status (route) and the WhatsApp channel (via getPatientQueueStatus).
 *
 * When `dependentId` is provided, only a queue entry joined FOR that dependent
 * (entry.dependentId === dependentId) counts — otherwise `{ inQueue: false }`.
 * When omitted, behaviour is unchanged (any active entry for the account).
 */
export async function computePatientQueueStatus(patientId: string, dependentId?: string): Promise<any> {
    const snapshot = await collections.telehealthQueue
        .where('patientId', '==', patientId)
        .where('status', 'in', ['waiting', 'assigned', 'in_consultation', 'diagnostics'])
        .limit(5)
        .get();

    const match = dependentId
        ? snapshot.docs.find((d: any) => d.data()?.dependentId === dependentId)
        : snapshot.docs[0];

    if (!match) {
        return { inQueue: false };
    }

    const entry = match.data();
    const band: TriageBand = normalizeBand(entry.triageCategory || entry.urgencyLevel);
    const enqueuedAtMs = toMillis(entry.joinedAt) || Date.now();
    const engagedAtMs = entry.assignedAt ? toMillis(entry.assignedAt) : null;

    // Load the current waiting set for band-aware position math
    const waitingSnap = await collections.telehealthQueue
        .where('status', '==', 'waiting')
        .get();

    const waiting: QueuePositionItem[] = waitingSnap.docs.map((d: any) => {
        const w = d.data();
        return {
            id: w.queueId,
            band: normalizeBand(w.triageCategory || w.urgencyLevel),
            enqueuedAtMs: toMillis(w.joinedAt) || Date.now(),
        };
    });

    const selfId = entry.queueId || match.id;
    const self: QueuePositionItem = { id: selfId, band, enqueuedAtMs };
    const pos = computeQueuePosition(waiting, self);
    const sla = computeSlaState(band, enqueuedAtMs, Date.now(), engagedAtMs);

    const engaged = entry.status === 'assigned' || entry.status === 'in_consultation';

    return {
        inQueue: true,
        queueId: selfId,
        status: entry.status,
        dependentId: entry.dependentId || null,
        triageBand: band,
        // Position math (only meaningful while still waiting)
        position: engaged ? 0 : pos.position,
        peopleAhead: engaged ? 0 : pos.peopleAhead,
        totalWaiting: pos.totalWaiting,
        estimatedWaitMinutes: engaged ? 0 : pos.estimatedWaitMinutes,
        // Engagement state
        assigned: engaged,
        assignedDoctorId: entry.assignedDoctorId || null,
        consultationId: entry.consultationId || (engaged ? (entry.sessionId || selfId) : null),
        // SLA
        sla: {
            state: sla.state,
            targetMinutes: sla.targetMinutes,
            elapsedMinutes: sla.elapsedMinutes,
            remainingMinutes: sla.remainingMinutes,
        },
        reassurance: bandReassurance(band),
    };
}

/** Emit a queue:update event to a patient's socket room (best-effort). */
async function emitQueueUpdate(patientId: string): Promise<void> {
    try {
        const status = await computePatientQueueStatus(patientId);
        emitToUser(patientId, 'queue:update', status);
    } catch { /* best-effort */ }
}

/**
 * Remove doctors who have explicitly turned OFF `availability.isAcceptingConsultations`
 * (persisted via PUT /doctors/me/availability). A missing flag is treated as
 * available (opt-out, not opt-in), preserving today's behaviour for doctors who
 * never touched the toggle. Used by the queue's auto-assign / visibility paths.
 */
export async function filterDoctorsAcceptingConsultations<T extends { userId?: string; id?: string }>(
    doctors: T[],
): Promise<T[]> {
    if (!doctors.length) return doctors;
    const checked: (T | null)[] = await Promise.all(
        doctors.map(async (d): Promise<T | null> => {
            const id = (d as any).userId || (d as any).id;
            if (!id) return d;
            try {
                const docDoc = await collections.doctors.doc(id).get();
                const accepting = docDoc.exists ? docDoc.data()?.availability?.isAcceptingConsultations : undefined;
                return accepting === false ? null : d;
            } catch {
                return d; // On lookup error, don't block the doctor.
            }
        }),
    );
    const accepting = checked.filter((d): d is T => d !== null);
    // LICENSURE WALL (Wave 3): availability is a preference; a completed
    // credential is a precondition. A doctor without a current, independently
    // verified licence is invisible to queue visibility, assignment and
    // auto-assignment — the patient is never routed to them.
    return filterCredentialedPrincipals(accepting);
}

// ========== TELEHEALTH QUEUE SYSTEM ==========

/**
 * Patient joins the telehealth queue.
 * Requires authentication. Optionally passes symptoms, urgency, preferred language.
 */
router.post('/join', asyncHandler(async (req: AuthRequest, res: Response) => {
    const { symptoms, urgencyLevel, preferredLanguage, facilityId, dependentId } = req.body;

    // Joining on behalf of a dependent (family member sub-profile): verify the
    // caller actually guards this dependent before tagging the queue entry.
    let dependentName: string | null = null;
    if (dependentId) {
        const familySnap = await firestore.collection('family_members')
            .where('memberId', '==', String(dependentId))
            .where('parentUserId', '==', req.user!.userId)
            .limit(1)
            .get();
        const member = familySnap.empty ? null : familySnap.docs[0].data();
        if (!member || member.status !== 'active') {
            return res.status(404).json({
                success: false,
                error: 'Family member not found or does not belong to your account',
            });
        }
        dependentName = `${member.profile?.firstName || ''} ${member.profile?.lastName || ''}`.trim() || null;
    }

    // Check patient isn't already in queue
    const existing = await collections.telehealthQueue
        .where('patientId', '==', req.user!.userId)
        .where('status', 'in', ['waiting', 'assigned', 'diagnostics'])
        .limit(1)
        .get();

    if (!existing.empty) {
        return res.status(409).json({
            success: false,
            error: 'You are already in the telehealth queue',
            data: existing.docs[0].data()
        });
    }

    // Get current queue size for position
    const queueSnapshot = await collections.telehealthQueue
        .where('status', '==', 'waiting')
        .get();
    const position = queueSnapshot.size + 1;

    // Estimate wait time: ~10 min per position (configurable)
    const AVG_CONSULT_MINUTES = 10;
    const estimatedWaitMinutes = position * AVG_CONSULT_MINUTES;

    const queueId = uuidv4();
    const entry: any = {
        queueId,
        patientId: req.user!.userId,
        is_sandbox: req.isSandbox || false,
        patientName: req.user!.email, // Will be enriched from user profile
        ...(dependentId ? { dependentId: String(dependentId), dependentName } : {}),
        facilityId: facilityId || null,
        symptoms: symptoms || [],
        urgencyLevel: urgencyLevel || 'low',
        preferredLanguage: preferredLanguage || 'en',
        status: 'waiting' as const,
        assignedDoctorId: null,
        consultationId: null,
        position,
        joinedAt: new Date(),
        assignedAt: null,
        completedAt: null,
        estimatedWaitMinutes,
    };

    // Enrich patient name from users collection
    try {
        const userDoc = await collections.users.doc(req.user!.userId).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            entry.patientName = `${userData?.firstName || ''} ${userData?.lastName || ''}`.trim() || req.user!.email;
        }
    } catch { /* fallback to email */ }

    // Consent-for-care stamp: joining the queue for a consultation IS the
    // consent action; version + timestamp make it auditable.
    entry.consentForCare = {
        signedAt: new Date().toISOString(),
        method: 'queue_join',
        policyVersion: 'care-consent-v1',
    };

    await collections.telehealthQueue.doc(queueId).set(entry);

    await logAudit(req, 'QUEUE_JOINED', 'telehealthQueue', queueId, {
        details: { urgencyLevel: entry.urgencyLevel, position },
    });

    // ── Notify facility staff (or all doctors if no facility) ──
    const lockScreenPatientName: string | null = entry.dependentName || entry.patientName || null;
    if (!req.isSandbox) {
        const urgencyLabel = entry.urgencyLevel.charAt(0).toUpperCase() + entry.urgencyLevel.slice(1);
        const notifTitle = entry.urgencyLevel === 'emergency'
            ? '🚨 Emergency Patient in Queue'
            : '🩺 New Patient in Queue';
        const notifBody = `${entry.patientName} is waiting in the telehealth queue (Urgency: ${urgencyLabel}). Position: #${position}.`;

        // Facility queues: the triage team (nurses, reception) must hear a
        // patient arrive too — they sit at the desk and run intake, and they may
        // read this queue. Midwives are NOT alerted (mobile role audit L-P8):
        // the alert invites a claim, but a midwife cannot complete or prescribe
        // for a general telehealth consult (consultation complete = doctor,
        // prescription = doctor / anaesthesia). Central-platform queue: doctors
        // only, nobody else works it.
        const joinedQueueRoles: UserRole[] = entry.facilityId
            ? ['doctor', 'clinic_admin', 'hospital_admin', 'nurse', 'receptionist' as any]
            : ['doctor', 'clinic_admin', 'hospital_admin'];
        notificationService.sendToFacilityStaff(
            entry.facilityId,   // null → all doctors; set → only that facility + central team
            joinedQueueRoles,
            notifTitle,
            notifBody,
            {
                type: 'patient_joined_queue',
                queueId: entry.queueId,
                urgencyLevel: entry.urgencyLevel,
                patientName: entry.patientName,
                facilityId: entry.facilityId || '',
                url: '/dashboard/telehealth/queue',
            },
            // Lock screen: "<name> is waiting for a doctor" — the person who
            // is actually waiting (a dependent when joining on their behalf).
            { lockScreen: { patientName: lockScreenPatientName } },
        ).catch(() => { /* Notification dispatch is best-effort */ });

        // Zero-Doctor Escalation Signal: when 0 doctors are online & accepting consultations,
        // escalate to facility admins (or platform admins for Central Network).
        try {
            const rawPresence = (await doctorPresenceService.getAvailableDoctors?.(entry.facilityId || undefined)) || [];
            const availableDoctors = await filterDoctorsAcceptingConsultations(rawPresence);
            if (availableDoctors.length === 0) {
                const escalationRoles: UserRole[] = entry.facilityId
                    ? ['doctor', 'hospital_admin', 'clinic_admin', 'admin']
                    : ['doctor', 'admin', 'super_admin'];
                notificationService.sendToFacilityStaff?.(
                    entry.facilityId,
                    escalationRoles,
                    '⚠️ Zero Doctors Online — Patient Waiting',
                    `${entry.patientName} joined the telehealth queue (Urgency: ${urgencyLabel}), but 0 doctors are currently online and available. Immediate coverage required.`,
                    {
                        type: 'zero_doctors_online_alert',
                        queueId: entry.queueId,
                        urgencyLevel: entry.urgencyLevel,
                        patientName: entry.patientName,
                        facilityId: entry.facilityId || '',
                        url: '/dashboard/telehealth/queue',
                    },
                    { lockScreen: { patientName: lockScreenPatientName } },
                )?.catch?.(() => { /* best-effort escalation */ });
            }
        } catch { /* best-effort escalation check */ }
    }

    // Realtime: push initial place-in-line to the patient's own socket room
    emitQueueUpdate(entry.patientId).catch(() => { });

    res.status(201).json({ success: true, data: entry });
}));

/**
 * Patient leaves the queue (cancel).
 */
router.delete('/leave', asyncHandler(async (req: AuthRequest, res: Response) => {
    const snapshot = await collections.telehealthQueue
        .where('patientId', '==', req.user!.userId)
        .where('status', 'in', ['waiting', 'assigned'])
        .limit(1)
        .get();

    if (snapshot.empty) {
        return res.status(404).json({ success: false, error: 'Not in queue' });
    }

    const doc = snapshot.docs[0];
    const queueData = doc.data() || {};
    await doc.ref.update({ status: 'cancelled', completedAt: new Date() });

    if (queueData.consultationId) {
        await collections.consultations.doc(queueData.consultationId).update({
            status: 'cancelled',
            updatedAt: new Date(),
        }).catch(() => {});
    }

    await logAudit(req, 'QUEUE_LEFT', 'telehealthQueue', queueData.queueId);

    res.json({ success: true, message: 'Left the queue' });
}));

/**
 * Patient checks their position in the queue.
 */
router.get('/position', asyncHandler(async (req: AuthRequest, res: Response) => {
    const snapshot = await collections.telehealthQueue
        .where('patientId', '==', req.user!.userId)
        .where('status', 'in', ['waiting', 'assigned'])
        .limit(1)
        .get();

    if (snapshot.empty) {
        return res.json({ success: true, data: { inQueue: false } });
    }

    const entry = snapshot.docs[0].data();

    // Recalculate position dynamically
    const aheadSnapshot = await collections.telehealthQueue
        .where('status', '==', 'waiting')
        .where('joinedAt', '<', entry.joinedAt)
        .get();

    // Count by urgency priority: emergency > high > moderate > low
    const urgencyOrder = { emergency: 0, high: 1, moderate: 2, low: 3 };
    const entryPriority = urgencyOrder[entry.urgencyLevel as keyof typeof urgencyOrder] ?? 3;
    const aheadCount = aheadSnapshot.docs.filter((d: any) => {
        const p = urgencyOrder[d.data().urgencyLevel as keyof typeof urgencyOrder] ?? 3;
        return p <= entryPriority; // Same or higher priority
    }).length;

    const currentPosition = aheadCount + 1;
    const AVG_CONSULT_MINUTES = 10;

    res.json({
        success: true,
        data: {
            inQueue: true,
            ...entry,
            currentPosition,
            estimatedWaitMinutes: currentPosition * AVG_CONSULT_MINUTES,
            totalInQueue: aheadSnapshot.size + 1,
        }
    });
}));

/**
 * Patient live queue status with SLA + band-aware position (premium "place in line").
 * Additive richer variant of /position — includes triageBand, SLA state, reassurance.
 */
router.get('/my-status', asyncHandler(async (req: AuthRequest, res: Response) => {
    // Optional ?dependentId= — status of a queue entry joined FOR a family
    // member. The caller must be that dependent's guardian (403 otherwise).
    const dependentId = typeof req.query.dependentId === 'string' && req.query.dependentId
        ? req.query.dependentId
        : undefined;
    if (dependentId && !(await isActiveFamilyDependentOf(req.user!.userId, dependentId))) {
        return res.status(403).json({
            success: false,
            error: 'Family member not found or does not belong to your account',
        });
    }
    // Best-effort heartbeat: stamp lastPatientActiveAt on the patient's active queue entry & consultation
    collections.telehealthQueue
        .where('patientId', '==', req.user!.userId)
        .where('status', 'in', ['waiting', 'assigned', 'in_consultation'])
        .limit(1)
        .get()
        .then((snap: any) => {
            if (!snap.empty) {
                const now = new Date();
                const qDoc = snap.docs[0];
                qDoc.ref.update({ lastPatientActiveAt: now }).catch(() => {});
                const cid = qDoc.data()?.consultationId;
                if (cid) {
                    collections.consultations.doc(cid).update({ lastPatientActiveAt: now }).catch(() => {});
                }
            }
        })
        .catch(() => {});
    const status = await computePatientQueueStatus(req.user!.userId, dependentId);
    res.json({ success: true, data: status });
}));

/**
 * Staff SLA dashboard view of the queue — every waiting/assigned entry annotated
 * with its triage band + SLA state (on_track / at_risk / breached), plus a summary.
 * Read-only; does not mutate the queue. Facility-scoped when facilityId given.
 */
router.get('/sla-dashboard', authorize('doctor', 'nurse', 'midwife', 'care_home_nurse', 'receptionist' as any, 'clinic_admin', 'hospital_admin', 'care_home_admin', 'admin', 'super_admin', 'customer_service', 'cs_admin', 'support'), asyncHandler(async (req: AuthRequest, res: Response) => {
    // Same tenancy rule as GET /queue — this board carries patient names too.
    const facilityId = queueReadScopeOr403(req, res);
    if (facilityId === undefined) return;

    let query: any = collections.telehealthQueue.where('status', 'in', ['waiting', 'assigned', 'in_consultation', 'diagnostics']);
    query = applyQueueScope(query, facilityId);

    const snapshot = await query.limit(200).get();
    const now = Date.now();

    const items = snapshot.docs.map((doc: any) => {
        const e = doc.data();
        const band = normalizeBand(e.triageCategory || e.urgencyLevel);
        const enqueuedAtMs = toMillis(e.joinedAt) || now;
        const engagedAtMs = e.assignedAt ? toMillis(e.assignedAt) : null;
        const sla = computeSlaState(band, enqueuedAtMs, now, engagedAtMs);
        return {
            queueId: e.queueId,
            patientId: e.patientId,
            patientName: e.patientName,
            facilityId: e.facilityId || null,
            status: e.status,
            triageBand: band,
            assignedDoctorId: e.assignedDoctorId || null,
            joinedAt: e.joinedAt,
            waitedMinutes: sla.elapsedMinutes,
            sla: {
                state: sla.state,
                targetMinutes: sla.targetMinutes,
                elapsedMinutes: sla.elapsedMinutes,
                remainingMinutes: sla.remainingMinutes,
                met: sla.met,
            },
        };
    });

    // Sort: breached first, then at_risk, then band priority, then longest wait
    const stateRank: Record<string, number> = { breached: 0, at_risk: 1, on_track: 2 };
    items.sort((a: any, b: any) => {
        const sr = (stateRank[a.sla.state] ?? 3) - (stateRank[b.sla.state] ?? 3);
        if (sr !== 0) return sr;
        return b.waitedMinutes - a.waitedMinutes;
    });

    const summary = summarizeSla(items.map((i: any) => ({ state: i.sla.state, band: i.triageBand })));

    res.json({ success: true, data: { queue: items, summary } });
}));

// ============================================================
// QUEUE TENANCY (WALL-GAP-2 / -3 / -4 / -5)
// ============================================================
//
// The queue carries patient identity, presenting symptoms and urgency. Before
// this block `facilityId` was an OPTIONAL QUERY FILTER on every staff route, so
// a facility-bound clinic_admin/hospital_admin/facility doctor could read — and
// mutate, and clear — the entire platform queue.
//
// The repo convention is "token facilityId wins". Three actor classes:
//
//   PLATFORM ADMIN  (super_admin, or admin with adminLevel 'platform' / no site)
//        → unrestricted; may pass ?facilityId= to narrow.
//   FACILITY STAFF  (any staff user carrying a facilityId)
//        → hard-locked to their own facility's entries; the query param is
//          ignored, never widened.
//   PLATFORM-CENTRAL STAFF (staff with NO facilityId — e.g. the platform
//   telehealth doctor who works the claim queue)
//        → the platform queue is their job. READ stays as it was (they can
//          claim from any facility per consultation.routes' claim gate);
//          MUTATIONS are limited to unattached (facilityId == null) entries.

/** Platform-level admin — mirrors utils/consultation-access#isPlatformAdmin. */
function isPlatformQueueAdmin(user: AuthRequest['user']): boolean {
    if (!user) return false;
    if (user.role === 'super_admin') return true;
    return user.role === 'admin'
        && (user.adminLevel === 'platform' || (user.adminLevel == null && !user.facilityId));
}

/**
 * The facility a LIST read must be locked to, or `null` for "no lock".
 * Facility staff → their own facility (query ignored). Everyone else → the
 * optional query filter.
 */
/**
 * Sentinel scope: Docarion central-service entries only (facilityId == null).
 * Owner rule — "we should not be able to see a facility's records without
 * first picking that facility": a platform PRINCIPAL (platform admin, or a
 * facility-less HQ role such as customer_service) reads the selected
 * facility's queue, or with none selected only the unattached central queue.
 */
const CENTRAL_QUEUE = Symbol('central-queue');
type QueueReadScope = string | typeof CENTRAL_QUEUE | null;

class QueueFacilityContextError extends Error {
    constructor(public facilityId: string | null) { super('FACILITY_CONTEXT_REQUIRED'); }
}

function resolveQueueReadFacility(req: AuthRequest): QueueReadScope {
    const user = req.user!;
    const q = typeof req.query.facilityId === 'string' && req.query.facilityId ? req.query.facilityId : null;
    if (isPlatformQueueAdmin(user)) {
        if (user.facilityId && (!q || q === user.facilityId)) return user.facilityId;
        const target = q || activeFacilityContext(user)?.facilityId || null;
        if (target) {
            if (activeFacilityContext(user)?.facilityId && !platformCanSeeFacility(user, target)) {
                throw new QueueFacilityContextError(target);
            }
            return target;
        }
        return null;
    }
    if (!user.facilityId && isPlatformPrincipal(user)) {
        const target = q || activeFacilityContext(user)?.facilityId || null;
        if (!target) return CENTRAL_QUEUE;
        if (!platformCanSeeFacility(user, target)) throw new QueueFacilityContextError(target);
        return target;
    }
    if (user.facilityId) return user.facilityId;   // token wins — cannot be widened
    return q;                                       // overlay / platform-central clinicians may narrow (claim queue)
}

/** Apply a read scope to a Firestore query. */
function applyQueueScope(query: any, scope: QueueReadScope): any {
    if (scope === CENTRAL_QUEUE) return query.where('facilityId', '==', null);
    if (scope) return query.where('facilityId', '==', scope);
    return query;
}

/** Resolve the read scope, answering 403 FACILITY_CONTEXT_REQUIRED on mismatch. */
function queueReadScopeOr403(req: AuthRequest, res: Response): QueueReadScope | undefined {
    try {
        return resolveQueueReadFacility(req);
    } catch (err) {
        if (err instanceof QueueFacilityContextError) {
            res.status(403).json(facilityContextRequiredBody(err.facilityId));
            return undefined;
        }
        throw err;
    }
}

/**
 * May this actor MUTATE this queue entry (assign / no-show / release / requeue /
 * bulk-update)? Symmetric tenancy: facility staff own their facility's entries,
 * platform-central staff own the unattached platform entries, platform admins
 * own everything.
 */
function canActOnQueueEntry(user: AuthRequest['user'], entry: any): boolean {
    if (!user) return false;
    const entryFacility = entry?.facilityId || null;
    // Platform admins: unrestricted across entries (WALL-GAP-4)
    if (isPlatformQueueAdmin(user)) return true;
    if (user.facilityId) return entryFacility === user.facilityId;
    return entryFacility === null;
}

/**
 * The doctor a patient is assigned to may always finish or hand back that
 * patient. A hybrid doctor ('both' / platformTelehealthAgreement) can accept a
 * central-platform or allowed-facility patient (see /assign); without this the
 * same doctor was then refused Complete / Release with QUEUE_SCOPE_DENIED.
 */
function isAssignedDoctor(user: AuthRequest['user'], entry: any): boolean {
    return !!user && user.role === 'doctor' && !!entry?.assignedDoctorId && entry.assignedDoctorId === user.userId;
}

/**
 * Doctor-to-doctor separation. Once a colleague has taken a patient, another
 * doctor may neither act on that queue entry (complete / release / no-show /
 * bulk-update) nor read the patient's identity or symptoms from the queue.
 * Facility scope alone ("same hospital") is not enough — that let Doctor B end
 * or hand back Doctor A's live consultation. Nurses and administrators keep
 * their existing facility-scoped queue powers.
 */
function isAnotherDoctorsPatient(user: AuthRequest['user'], entry: any): boolean {
    return !!user && user.role === 'doctor' && !!entry?.assignedDoctorId && entry.assignedDoctorId !== user.userId;
}

/** Uniform 403 for a doctor acting on a colleague's patient. */
function denyAnotherDoctorsPatient(res: Response): Response {
    return res.status(403).json({
        success: false,
        error: 'This patient is already with another doctor',
        code: 'ASSIGNED_TO_ANOTHER_DOCTOR',
    });
}

/**
 * What a doctor sees of a colleague's engaged queue entry: enough for the board
 * to show "in consultation" and keep counts right — no name, symptoms,
 * dependent or patient id.
 */
function redactForOtherDoctor(entry: any): any {
    return {
        queueId: entry.queueId,
        status: entry.status,
        facilityId: entry.facilityId ?? null,
        urgencyLevel: entry.urgencyLevel,
        triageCategory: entry.triageCategory,
        joinedAt: entry.joinedAt,
        assignedAt: entry.assignedAt,
        assignedDoctorId: entry.assignedDoctorId,
        patientName: 'Patient in consultation',
        symptoms: [],
        redacted: true,
    };
}

/** Uniform 403 for a cross-tenant queue mutation. */
function denyQueueScope(res: Response): Response {
    return res.status(403).json({
        success: false,
        error: 'This queue entry belongs to another facility',
        code: 'QUEUE_SCOPE_DENIED',
    });
}

/**
 * Doctors/admins CLAIM from the queue (assign / auto-assign / complete).
 */
const DOCTOR_ROLES: UserRole[] = ['doctor', 'midwife', 'nurse', 'admin', 'super_admin', 'hospital_admin', 'clinic_admin'];

/**
 * Who may CLAIM / assign a general telehealth queue entry (POST /assign,
 * /auto-assign). Midwives are excluded (mobile role audit L-P8 + security
 * review): they could take a general consult they cannot complete
 * (consultation complete = doctor/admin) or prescribe for (doctor /
 * anaesthesia). They keep reading the queue (QUEUE_READ_ROLES) and every
 * maternity-specific flow is untouched.
 */
const QUEUE_CLAIM_ROLES: UserRole[] = DOCTOR_ROLES.filter((r) => r !== 'midwife');

/**
 * Who may READ the queue list.
 *
 * `nurse` is included because reading is strictly LESS privileged than what a
 * nurse can already do with the very same entries:
 *   - `QUEUE_MUTATION_ROLES` (below) lets a nurse no-show / release / requeue /
 *     bulk-update queue entries, and
 *   - `GET /sla-dashboard` already returns those entries to nurses INCLUDING
 *     `patientName`.
 * Leaving nurses off the plain list read meant a nurse could mutate a queue she
 * was forbidden to see — and, because `/dashboard/nurse` mounts
 * `<WaitlistManager />`, it meant every nurse session 403-looped this endpoint
 * every 30 seconds forever (the production console log of 2026-07-30).
 *
 * `customer_service` is deliberately NOT added: CS keeps the de-identified-ish
 * SLA/analytics reads, and no CS surface calls this route.
 */
const QUEUE_READ_ROLES: UserRole[] = [...DOCTOR_ROLES, 'nurse', 'receptionist' as any];
// LICENSURE WALL: the queue carries patient identity + presenting symptoms.
// Non-credentialed roles on this route (admins) pass the gate by construction;
// doctors and nurses both hold a credential type, so both are walled until
// verified — the client renders that as an actionable "complete your
// credentials" state instead of an empty board.
router.get('/queue', authorize(...QUEUE_READ_ROLES), requireCompletedCredential(), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status, presenceFilter } = req.query;
    // WALL-GAP-2: token facilityId wins. A facility-bound staffer can no longer
    // read the platform-wide queue by omitting the query param.
    const facilityId = queueReadScopeOr403(req, res);
    if (facilityId === undefined) return;

    // Heartbeat: when a doctor polls the telehealth queue and is accepting consultations,
    // refresh their doctorPresence so they do not go stale after 5 minutes.
    let isHybridDoctor = false;
    let hybridAllowedFacilities = new Set<string>();
    if (req.user?.role === 'doctor') {
        try {
            const docSnap = await collections.doctors.doc(req.user.userId).get();
            const docData = docSnap.exists ? docSnap.data() : null;
            if (docData) {
                if (docData.doctorType === 'both' || docData.platformTelehealthAgreement === true) {
                    isHybridDoctor = true;
                    [req.user.facilityId, docData.facilityId, ...(Array.isArray(docData.allowedFacilityIds) ? docData.allowedFacilityIds : [])]
                        .filter(Boolean)
                        .forEach((f: string) => hybridAllowedFacilities.add(f));
                }
                if (docData.availability?.isAcceptingConsultations !== false) {
                    await doctorPresenceService.setOnline?.(
                        req.user.userId,
                        docData.facilityId ?? req.user.facilityId,
                    );
                    await doctorPresenceService.setAvailable?.(req.user.userId, true);
                }
            }
        } catch { /* best-effort presence heartbeat */ }
    }

    let query: any = collections.telehealthQueue;

    if (status) {
        query = query.where('status', '==', status);
    } else {
        query = query.where('status', 'in', ['waiting', 'assigned', 'in_consultation', 'diagnostics']);
    }

    // A hybrid doctor ('both' / platformTelehealthAgreement) polling without an explicit facility filter
    // sees the central platform queue AND each allowed facility. Each scope is its own query: a single
    // unscoped `limit(100)` filtered in memory let other facilities' entries crowd theirs out.
    const scopes: QueueReadScope[] = isHybridDoctor && !req.query.facilityId
        ? [CENTRAL_QUEUE, 'DOCARION_PLATFORM', ...Array.from(hybridAllowedFacilities)]
        : [facilityId];
    const snapshots = await Promise.all(
        scopes.map((scope) => applyQueueScope(query, scope).orderBy('joinedAt', 'asc').limit(100).get()),
    );
    const seen = new Set<string>();
    const nowMs = Date.now();
    let entries = snapshots
        .flatMap((snapshot: any) => snapshot.docs)
        .filter((doc: any) => (seen.has(doc.id) ? false : (seen.add(doc.id), true)))
        .map((doc: any) => {
            const raw = doc.data();
            if (isAnotherDoctorsPatient(req.user, raw)) return redactForOtherDoctor(raw);
            const presence = computePatientOnlinePresence(raw, nowMs);
            return {
                ...raw,
                ...presence,
            };
        });

    if (presenceFilter === 'online') {
        entries = entries.filter((e: any) => e.patientOnline === true);
    } else if (presenceFilter === 'offline') {
        entries = entries.filter((e: any) => e.patientOnline === false);
    }

    // Sort by urgency priority then joinedAt
    const urgencyOrder = { emergency: 0, high: 1, moderate: 2, low: 3 };
    entries.sort((a: any, b: any) => {
        const pa = urgencyOrder[a.urgencyLevel as keyof typeof urgencyOrder] ?? 3;
        const pb = urgencyOrder[b.urgencyLevel as keyof typeof urgencyOrder] ?? 3;
        if (pa !== pb) return pa - pb;
        return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
    });

    // Get available doctors count (respecting the accepting-consultations toggle)
    const availableDoctors = await filterDoctorsAcceptingConsultations(
        await doctorPresenceService.getAvailableDoctors(typeof facilityId === 'string' ? facilityId : undefined)
    );

    const waitingEntries = entries.filter((e: any) => e.status === 'waiting');

    res.json({
        success: true,
        data: {
            queue: entries,
            stats: {
                total: entries.length,
                waiting: waitingEntries.length,
                onlineWaiting: waitingEntries.filter((e: any) => e.patientOnline).length,
                offlineWaiting: waitingEntries.filter((e: any) => !e.patientOnline).length,
                assigned: entries.filter((e: any) => e.status === 'assigned').length,
                inConsultation: entries.filter((e: any) => e.status === 'in_consultation').length,
                availableDoctors: availableDoctors.length,
            }
        }
    });
}));

/** Roles that may assign a queue entry to SOMEONE ELSE. */
const ASSIGN_ADMIN_ROLES: UserRole[] = ['admin', 'super_admin', 'hospital_admin', 'clinic_admin'];

/**
 * FLOW-GAP-3 — find the consultation this visit ALREADY has.
 *
 * The patient app creates a consultation during AI intake and only then joins
 * the queue, so `POST /assign` minting a fresh consultation produced TWO
 * clinical records for one visit (and the second one can trip the KYC gate).
 * Resolution order: the entry's own link → a consult carrying this `queueId` →
 * the patient's most recent still-unclaimed consult.
 */
async function findExistingConsultationForEntry(entry: any, queueId: string): Promise<any | null> {
    try {
        if (entry?.consultationId) {
            const doc = await collections.consultations.doc(entry.consultationId).get();
            if (doc.exists) return doc.data();
        }
        const byQueue = await collections.consultations.where('queueId', '==', queueId).limit(1).get();
        if (!byQueue.empty) return byQueue.docs[0].data();
        if (!entry?.patientId) return null;
        const open = await collections.consultations
            .where('patientId', '==', entry.patientId)
            .where('status', 'in', ['pending', 'intake_complete', 'waitlist', 'awaiting_payment', 'waiting', 'queued'])
            .limit(10)
            .get();
        const candidates = open.docs
            .map((d: any) => d.data())
            .filter((c: any) => !c.doctorId)
            .sort((a: any, b: any) => (toMillis(b.createdAt) || 0) - (toMillis(a.createdAt) || 0));
        return candidates[0] || null;
    } catch {
        return null; // never block the assignment on a lookup problem
    }
}

/**
 * Manually assign a queue entry to a specific doctor.
 *
 * WALL-GAP-3: this used to accept ANY `DOCTOR_ROLES` caller assigning ANY entry
 * to ANY doctor — no tenancy, no self-check, no doctor↔facility check.
 * Now: administrators assign within their own tenancy; a plain doctor may only
 * take the patient THEMSELVES (which is what the web queue board does — the
 * equivalent of /claim), never hand them to a colleague.
 */
router.post('/assign', authorize(...QUEUE_CLAIM_ROLES), requireCompletedCredential(), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { queueId, doctorId } = req.body;

    if (!queueId || !doctorId) {
        return res.status(400).json({ success: false, error: 'queueId and doctorId required' });
    }

    // (1) ACTOR — a non-admin doctor may only assign to themselves.
    const isAssignAdmin = ASSIGN_ADMIN_ROLES.includes(req.user!.role);
    if (!isAssignAdmin && String(doctorId) !== req.user!.userId) {
        return res.status(403).json({
            success: false,
            error: 'Doctors can only take a patient themselves. Ask an administrator to assign another doctor.',
            code: 'ASSIGN_SELF_ONLY',
        });
    }

    // (2) TENANCY — load the entry first; the transaction re-checks status.
    const queueRef = collections.telehealthQueue.doc(queueId);
    const preRead = await queueRef.get();
    if (!preRead.exists) return res.status(404).json({ success: false, error: 'Queue entry not found' });
    const preEntry: any = preRead.data();
    if (!canActOnQueueEntry(req.user, preEntry)) {
        // Check if caller is a hybrid doctor ('both' / platformTelehealthAgreement) taking a platform or allowed-facility patient
        let hybridAllowed = false;
        if (req.user?.role === 'doctor' && String(doctorId) === req.user.userId) {
            const callerDoc = await collections.doctors.doc(req.user.userId).get();
            const callerData: any = callerDoc.exists ? callerDoc.data() : null;
            if (callerData && (callerData.doctorType === 'both' || callerData.platformTelehealthAgreement === true)) {
                const allowedFacs = [req.user.facilityId, callerData.facilityId, ...(callerData.allowedFacilityIds || [])].filter(Boolean);
                if (!preEntry.facilityId || preEntry.facilityId === 'DOCARION_PLATFORM' || allowedFacs.includes(preEntry.facilityId)) {
                    hybridAllowed = true;
                }
            }
        }
        if (!hybridAllowed) return denyQueueScope(res);
    }

    // LICENSURE WALL: the ACTOR is gated by requireCompletedCredential above;
    // the TARGET is gated here — an admin must not be able to hand a patient to
    // a doctor who has not completed licensure.
    const [assignable] = await filterCredentialedPrincipals([{ userId: String(doctorId) }]);
    if (!assignable) {
        return res.status(403).json({
            success: false,
            error: 'That doctor has not completed licensure verification and cannot be assigned patients.',
            code: 'CREDENTIAL_REQUIRED',
            missing: ['credential'],
            credential: { required: true, subject: 'assignee', doctorId },
        });
    }

    // (3) TARGET ↔ FACILITY — same rule the claim gate applies
    // (consultation.routes.ts): a FACILITY doctor may only serve their own
    // facility (or an explicitly allowed one). Platform doctors serve anywhere.
    if (preEntry.facilityId) {
        const targetDoc = await collections.doctors.doc(String(doctorId)).get();
        const target: any = targetDoc.exists ? targetDoc.data() : null;
        if (target && (target.doctorType || 'platform') === 'facility') {
            const allowed = [target.facilityId, ...(target.allowedFacilityIds || [])].filter(Boolean);
            if (!allowed.includes(preEntry.facilityId)) {
                return res.status(403).json({
                    success: false,
                    error: 'That doctor cannot serve this facility',
                    code: 'DOCTOR_FACILITY_MISMATCH',
                });
            }
        }
    }

    // FLOW-GAP-3: reuse the visit's existing consultation when there is one.
    const existingConsult = await findExistingConsultationForEntry(preEntry, queueId);
    const consultationId = existingConsult?.consultationId || uuidv4();
    const conversationId = uuidv4();
    let entry: any;

    try {
        await firestore.runTransaction(async (tx: any) => {
            const queueDoc = await tx.get(queueRef);
            if (!queueDoc.exists) throw new Error('NOT_FOUND');
            
            entry = queueDoc.data()!;
            if (entry.status !== 'waiting') throw new Error(`NOT_WAITING:${entry.status}`);

            tx.update(queueRef, {
                status: 'assigned',
                assignedDoctorId: doctorId,
                consultationId,
                assignedAt: new Date(),
            });
        });
    } catch (error: any) {
        if (error.message === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'Queue entry not found' });
        if (error.message.startsWith('NOT_WAITING')) return res.status(400).json({ success: false, error: `Cannot assign — status is ${error.message.split(':')[1]}` });
        throw error;
    }

    // Consultation — REUSE the visit's existing one when the patient already
    // has one from intake (FLOW-GAP-3); only mint a new record otherwise.
    let consultationNumber: any = existingConsult?.consultationNumber;
    if (existingConsult) {
        await collections.consultations.doc(consultationId).set({
            doctorId,
            status: 'scheduled',
            queueId,
            ...(existingConsult.facilityId ? {} : { facilityId: entry.facilityId }),
            assignedAt: new Date(),
            updatedAt: new Date(),
        }, { merge: true });
    } else {
        const consultationIdentifier = await issueRecordIdentifierFields('consultation', consultationId, {
            facilityId: entry.facilityId || null,
        });
        consultationNumber = consultationIdentifier.consultationNumber;
        await collections.consultations.doc(consultationId).set({
            consultationId,
            ...consultationIdentifier,
            patientId: entry.patientId,
            is_sandbox: req.isSandbox || false,
            doctorId,
            facilityId: entry.facilityId,
            type: 'chat',
            status: 'scheduled',
            symptoms: entry.symptoms,
            urgencyLevel: entry.urgencyLevel,
            queueId,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }
    await ensureEncounterForConsultation(consultationId);

    // W2.2 — Create or link canonical consultation episode (no-op when flag disabled).
    // Queue and booking races resolve to one consultation via the guard document.
    const epResult = await createOrGetEpisode(
        consultationId,
        { kind: 'queue', id: queueId },
        { patientId: entry.patientId, facilityId: entry.facilityId },
    ).catch(() => ({ episode: null, created: false }));
    // If the episode already existed (e.g., from intake), link the queue source
    if (epResult.episode && !epResult.created) {
        await linkSourceToEpisode(epResult.episode.episodeId, { kind: 'queue', id: queueId })
            .catch(() => { /* non-blocking */ });
    }

    // Conversation — reuse the consultation's existing thread if there is one.
    const allParticipants = [entry.patientId, doctorId];
    let resolvedConversationId = conversationId;
    let existingConversation: any = null;
    try {
        const convSnap = await collections.conversations
            .where('consultationId', '==', consultationId)
            .limit(1)
            .get();
        if (!convSnap.empty) existingConversation = convSnap.docs[0].data();
    } catch { /* fall through to creating one */ }

    if (existingConversation?.conversationId) {
        resolvedConversationId = existingConversation.conversationId;
        await collections.conversations.doc(resolvedConversationId).set({
            participants: Array.from(new Set([...(existingConversation.participants || []), ...allParticipants])),
            updatedAt: new Date(),
        }, { merge: true });
    } else {
        await collections.conversations.doc(conversationId).set({
            conversationId,
            type: 'consultation',
            is_sandbox: req.isSandbox || false,
            participants: allParticipants,
            participantDetails: {},
            facilityId: entry.facilityId,
            consultationId,
            lastMessage: null,
            lastMessageAt: null,
            unreadCount: { [entry.patientId]: 0, [doctorId]: 0 },
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }

    // Update doctor presence
    await doctorPresenceService.updateActiveConsultations(doctorId, 1);

    // Manual admin assign may override the doctor's accepting-consultations toggle — record it.
    let assignOverride = false;
    try {
        const dDoc = await collections.doctors.doc(doctorId).get();
        if (dDoc.exists && dDoc.data()?.availability?.isAcceptingConsultations === false) assignOverride = true;
    } catch { /* non-blocking */ }

    // Notify patient via FCM push + in-app (skip external push in sandbox)
    if (!req.isSandbox) {
        notificationService.sendToUser(entry.patientId, 'Doctor Available',
            'A doctor is ready to see you. Your consultation is starting.',
            { consultationId, conversationId: resolvedConversationId, queueId, type: 'queue_assigned', url: '/dashboard/patient/telehealth' }
        ).catch(() => { });
        // WhatsApp milestone: if the patient has a linked WhatsApp number, notify there too.
        notifyQueueMilestoneOnWhatsApp(entry.patientId, 'doctor_ready').catch(() => { });
    }

    // Realtime: doctor-ready milestone to the patient's socket room
    emitQueueUpdate(entry.patientId).catch(() => { });

    void notifyQueueAdvancement();
    await logAudit(req, 'QUEUE_ASSIGNED', 'telehealthQueue', queueId, {
        details: {
            doctorId,
            consultationId,
            patientId: entry.patientId,
            overrideNotAccepting: assignOverride,
            reusedConsultation: Boolean(existingConsult),
        },
    });

    res.json({
        success: true,
        data: {
            queueId,
            consultationId,
            consultationNumber: consultationNumber != null ? String(consultationNumber) : null,
            conversationId: resolvedConversationId,
            doctorId,
            reusedConsultation: Boolean(existingConsult),
        },
        message: 'Patient assigned to doctor'
    });
}));

export interface AutoAssignResult {
    status: 'assigned' | 'no_waiting' | 'no_doctors' | 'conflict' | 'not_found';
    data?: {
        queueId: string;
        consultationId: string;
        consultationNumber?: string;
        conversationId: string;
        doctorId: string;
        patientId: string;
    };
}

/**
 * Assign the next waiting patient (priority/emergency-first) to the least-loaded
 * available doctor who is still accepting consultations. Shared core called by
 * BOTH the POST /auto-assign route (manual/admin) and the queueAutoAssign job
 * runner (jobs.service.ts). No req/res dependency; callers own their own audit.
 */
export async function autoAssignNextPatient(
    opts: { facilityId?: string; isSandbox?: boolean } = {},
): Promise<AutoAssignResult> {
    const { facilityId, isSandbox } = opts;

    // Get next waiting patient (priority-ordered)
    let queueQuery: any = collections.telehealthQueue.where('status', '==', 'waiting');
    if (facilityId) queueQuery = queueQuery.where('facilityId', '==', facilityId);

    const queueSnapshot = await queueQuery.orderBy('joinedAt', 'asc').limit(10).get();
    if (queueSnapshot.empty) return { status: 'no_waiting' };

    // Sort by urgency priority (emergency first)
    const urgencyOrder = { emergency: 0, high: 1, moderate: 2, low: 3 };
    const entries = queueSnapshot.docs.map((d: any) => d.data());
    entries.sort((a: any, b: any) => {
        const pa = urgencyOrder[a.urgencyLevel as keyof typeof urgencyOrder] ?? 3;
        const pb = urgencyOrder[b.urgencyLevel as keyof typeof urgencyOrder] ?? 3;
        return pa - pb;
    });
    const nextPatient = entries[0];

    // Get available doctor (round-robin by active consultations),
    // then drop any who have turned off accepting consultations.
    const presentDoctors = await doctorPresenceService.getAvailableDoctors(facilityId);
    const doctors = await filterDoctorsAcceptingConsultations(presentDoctors);
    if (doctors.length === 0) return { status: 'no_doctors' };

    // Optionally match by language
    const selectedDoctor = doctors[0]; // Default: least loaded

    const consultationId = nextPatient.consultationId || uuidv4();
    const conversationId = uuidv4();
    const allParticipants = [nextPatient.patientId, selectedDoctor.userId];

    const queueRef = collections.telehealthQueue.doc(nextPatient.queueId);

    try {
        await firestore.runTransaction(async (tx: any) => {
            const queueDoc = await tx.get(queueRef);
            if (!queueDoc.exists) throw new Error('NOT_FOUND');
            const entry = queueDoc.data()!;
            if (entry.status !== 'waiting') throw new Error(`NOT_WAITING:${entry.status}`);

            tx.update(queueRef, {
                status: 'assigned',
                assignedDoctorId: selectedDoctor.userId,
                consultationId,
                assignedAt: new Date(),
            });
        });
    } catch (error: any) {
        if (error.message === 'NOT_FOUND') return { status: 'not_found' };
        if (error.message?.startsWith('NOT_WAITING')) return { status: 'conflict' };
        throw error;
    }

    const consultationIdentifier = await issueRecordIdentifierFields('consultation', consultationId, {
        facilityId: nextPatient.facilityId || null,
    });

    if (nextPatient.consultationId) {
        await collections.consultations.doc(consultationId).set({
            doctorId: selectedDoctor.userId,
            status: 'scheduled',
            queueId: nextPatient.queueId,
            assignedAt: new Date(),
            updatedAt: new Date(),
        }, { merge: true });
    } else {
        await collections.consultations.doc(consultationId).set({
            consultationId,
            ...consultationIdentifier,
            patientId: nextPatient.patientId,
            is_sandbox: isSandbox || false,
            doctorId: selectedDoctor.userId,
            facilityId: nextPatient.facilityId,
            type: 'chat',
            status: 'scheduled',
            symptoms: nextPatient.symptoms,
            urgencyLevel: nextPatient.urgencyLevel,
            queueId: nextPatient.queueId,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }
    await ensureEncounterForConsultation(consultationId);

    // W2.2 — Create canonical consultation episode for auto-assign path
    await createOrGetEpisode(
        consultationId,
        { kind: 'queue', id: nextPatient.queueId },
        { patientId: nextPatient.patientId, facilityId: nextPatient.facilityId },
    ).catch(() => { /* non-blocking */ });

    await collections.conversations.doc(conversationId).set({
        conversationId,
        type: 'consultation',
        is_sandbox: isSandbox || false,
        participants: allParticipants,
        participantDetails: {},
        facilityId: nextPatient.facilityId,
        consultationId,
        lastMessage: null,
        lastMessageAt: null,
        unreadCount: { [nextPatient.patientId]: 0, [selectedDoctor.userId]: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
    });

    await doctorPresenceService.updateActiveConsultations(selectedDoctor.userId, 1);

    // Notify both via FCM push + in-app (skip external push in sandbox)
    if (!isSandbox) {
        for (const uid of allParticipants) {
            const isPatient = uid === nextPatient.patientId;
            notificationService.sendToUser(uid,
                isPatient ? 'Doctor Available' : 'New Patient Assigned',
                isPatient ? 'A doctor is ready to see you. Your consultation is starting.'
                    : `Patient ${nextPatient.patientName} has been assigned to you.`,
                {
                    consultationId, conversationId, queueId: nextPatient.queueId, type: 'queue_assigned',
                    url: isPatient ? '/dashboard/patient/telehealth' : `/consultations/${consultationId}`
                },
                // Doctor's lock screen: "<name> has been assigned to you". A
                // patient recipient never gets a name (registry rule).
                { lockScreen: { patientName: nextPatient.dependentName || nextPatient.patientName || null } },
            ).catch(() => { });
        }
        notifyQueueMilestoneOnWhatsApp(nextPatient.patientId, 'doctor_ready').catch(() => { });
    }

    // Realtime: doctor-ready milestone to the patient's socket room
    emitQueueUpdate(nextPatient.patientId).catch(() => { });

    return {
        status: 'assigned',
        data: {
            queueId: nextPatient.queueId,
            consultationId,
            consultationNumber: String(consultationIdentifier.consultationNumber),
            conversationId,
            doctorId: selectedDoctor.userId,
            patientId: nextPatient.patientId,
        },
    };
}

/**
 * Auto-assign the next patient to the least-loaded available doctor.
 * Can be called by system (cron) or manually by admin.
 */
router.post('/auto-assign', authorize(...QUEUE_CLAIM_ROLES), requireCompletedCredential(), asyncHandler(async (req: AuthRequest, res: Response) => {
    // Same tenancy rule as the rest of the queue: facility staff can only pull
    // from their own facility, whatever the body says.
    let facilityId: string | undefined;
    if (isPlatformQueueAdmin(req.user) && !req.user!.facilityId) {
        // Owner rule: a platform admin pulls from a facility only once picked.
        const target = req.body?.facilityId || activeFacilityContext(req.user)?.facilityId || null;
        if (target && !platformCanSeeFacility(req.user, target)) {
            return res.status(403).json(facilityContextRequiredBody(target));
        }
        facilityId = target || undefined;
    } else {
        facilityId = req.user!.facilityId || req.body?.facilityId || undefined;
    }

    const result = await autoAssignNextPatient({ facilityId, isSandbox: req.isSandbox });

    if (result.status === 'no_waiting') return res.json({ success: true, data: null, message: 'No patients waiting' });
    if (result.status === 'no_doctors') return res.json({ success: true, data: null, message: 'No doctors available' });
    if (result.status === 'not_found') return res.status(404).json({ success: false, data: null, message: 'Queue entry not found during auto-assign' });
    if (result.status === 'conflict') return res.status(409).json({ success: false, data: null, message: 'Patient already assigned' });

    void notifyQueueAdvancement();
    await logAudit(req, 'QUEUE_AUTO_ASSIGNED', 'telehealthQueue', result.data!.queueId, {
        details: { doctorId: result.data!.doctorId, consultationId: result.data!.consultationId, autoAssigned: true },
    });

    res.json({ success: true, data: result.data, message: 'Auto-assigned successfully' });
}));

/**
 * Doctor marks a queue entry as consulted/completed.
 */
router.post('/complete', authorize(...DOCTOR_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { queueId } = req.body;
    if (!queueId) return res.status(400).json({ success: false, error: 'queueId required' });

    const doc = await collections.telehealthQueue.doc(queueId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Queue entry not found' });

    const entry = doc.data()!;
    if (isAnotherDoctorsPatient(req.user, entry)) return denyAnotherDoctorsPatient(res);
    if (!canActOnQueueEntry(req.user, entry) && !isAssignedDoctor(req.user, entry)) return denyQueueScope(res);
    if (!['assigned', 'in_consultation'].includes(entry.status)) {
        return res.status(400).json({ success: false, error: `Cannot complete — status is ${entry.status}` });
    }

    // Billing gate (R6): never complete a telehealth consult whose wallet
    // charge is still outstanding. Inert unless CONSULT_BILLING_ENFORCED=true.
    if (entry.consultationId) {
        const consultSnap = await collections.consultations.doc(entry.consultationId).get();
        const consult = consultSnap.exists ? consultSnap.data() : null;
        const gate = evaluateEncounterCloseGate(consult as any);
        if (!gate.allowed) {
            return res.status(409).json({ success: false, error: gate.reason, code: gate.code });
        }
    }

    await collections.telehealthQueue.doc(queueId).update({
        status: 'completed',
        completedAt: new Date(),
    });

    if (entry.consultationId) {
        await collections.consultations.doc(entry.consultationId).update({
            status: 'completed',
            endedAt: new Date(),
            locked: true,
            updatedAt: new Date(),
        }).catch(() => {});
        await transitionEncounterFromConsultation(entry.consultationId, 'completed', new Date()).catch(() => {});
    }

    // Decrement doctor's active consultations
    if (entry.assignedDoctorId) {
        await doctorPresenceService.updateActiveConsultations(entry.assignedDoctorId, -1);
    }

    void notifyQueueAdvancement();
    await logAudit(req, 'QUEUE_COMPLETED', 'telehealthQueue', queueId, {
        details: { doctorId: entry.assignedDoctorId, patientId: entry.patientId },
    });

    res.json({ success: true, message: 'Queue entry completed' });
}));

/**
 * Get available doctors (for admin dashboard visibility).
 */
router.get('/available-doctors', authorize(...DOCTOR_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { facilityId } = req.query;
    const present = await doctorPresenceService.getAvailableDoctors(facilityId as string | undefined);
    const doctors = await filterDoctorsAcceptingConsultations(present);
    res.json({ success: true, data: doctors });
}));

// ========== WAITLIST MANAGEMENT (Phase 3) ==========
// Cross-role queue operations for doctors, nurses, and admins

const STAFF_ROLES: UserRole[] = ['doctor', 'nurse', 'clinic_admin', 'hospital_admin', 'admin', 'super_admin', 'customer_service'];

/**
 * WALL-GAP-4 — who may MUTATE a waitlist entry.
 *
 * `customer_service` is deliberately dropped from the mutation routes: no
 * surface in either app calls them as CS (the CS console is `csApi`), and a
 * support agent cancelling/no-showing a clinical queue entry is not a supported
 * workflow. CS keeps its READ access (`/sla-dashboard`, `/analytics`).
 */
const QUEUE_MUTATION_ROLES: UserRole[] = ['doctor', 'nurse', 'clinic_admin', 'hospital_admin', 'admin', 'super_admin'];

/**
 * Bulk status update — update multiple queue entries at once.
 * WALL-GAP-4: entries outside the caller's tenancy are skipped, never mutated.
 */
router.patch('/bulk-update', authorize(...QUEUE_MUTATION_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { queueIds, status, reason } = req.body;

    if (!queueIds?.length || !status) {
        return res.status(400).json({ success: false, error: 'queueIds and status are required' });
    }
    if (!['cancelled', 'no_show', 'completed'].includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid status. Must be: cancelled, no_show, or completed' });
    }

    const batch = firestore.batch();
    let updated = 0;
    let skippedOutOfScope = 0;
    let skippedAssignedElsewhere = 0;

    for (const queueId of queueIds.slice(0, 50)) { // Max 50 per batch
        const ref = collections.telehealthQueue.doc(queueId);
        const doc = await ref.get();
        if (doc.exists && !canActOnQueueEntry(req.user, doc.data())) {
            skippedOutOfScope++;
            continue;
        }
        if (doc.exists && isAnotherDoctorsPatient(req.user, doc.data())) {
            skippedAssignedElsewhere++;
            continue;
        }
        if (doc.exists && ['waiting', 'assigned'].includes(doc.data()!.status)) {
            batch.update(ref, {
                status,
                completedAt: new Date(),
                statusReason: reason || `Bulk ${status} by staff`,
                updatedBy: req.user!.userId,
                updatedByRole: req.user!.role,
                updatedAt: new Date(),
            });
            updated++;
        }
    }

    await batch.commit();

    await logAudit(req, 'QUEUE_BULK_UPDATE', 'telehealthQueue', queueIds.join(','), {
        details: { status, count: updated, reason, skippedOutOfScope, skippedAssignedElsewhere },
        ...(skippedOutOfScope ? { severity: 'warning' as const } : {}),
    });

    res.json({
        success: true,
        message: `${updated} queue entries updated to ${status}`,
        data: { updated, skippedOutOfScope, skippedAssignedElsewhere },
    });
}));

/**
 * Clear the queue — cancel every waiting/assigned entry in scope.
 *
 * WALL-GAP-5 (highest blast radius of the five): `facilityId` was an OPTIONAL
 * query filter, so a single facility admin calling this with no params cancelled
 * the ENTIRE PLATFORM queue. Now:
 *   - a facility-scoped admin is hard-locked to their own facilityId (the
 *     param is ignored, and can never widen the blast radius);
 *   - a platform admin may target one facility with `?facilityId=`;
 *   - clearing PLATFORM-WIDE requires an explicit `scope=platform`, so it can
 *     never happen by omission.
 * The mobile Pro client sends `facilityId` as a query param (2026-07-30 audit)
 * and the web sends it in the DELETE body — both are accepted.
 */
router.delete('/clear', authorize('clinic_admin', 'hospital_admin', 'admin', 'super_admin'), asyncHandler(async (req: AuthRequest, res: Response) => {
    const rawFacilityId = (req.query.facilityId ?? (req.body || {}).facilityId);
    const requestedFacilityId = typeof rawFacilityId === 'string' && rawFacilityId ? rawFacilityId : null;
    const rawScope = (req.query.scope ?? (req.body || {}).scope);
    const scope = typeof rawScope === 'string' ? rawScope : null;

    let facilityId: string | null;
    if (isPlatformQueueAdmin(req.user)) {
        if (requestedFacilityId) {
            facilityId = requestedFacilityId;
        } else if (scope === 'platform') {
            facilityId = null;
        } else {
            return res.status(400).json({
                success: false,
                error: 'Specify a facilityId to clear, or pass scope=platform to clear the entire platform queue.',
                code: 'CLEAR_SCOPE_REQUIRED',
            });
        }
    } else if (req.user!.facilityId) {
        facilityId = req.user!.facilityId; // token wins — param ignored
    } else {
        return res.status(403).json({
            success: false,
            error: 'Your account is not scoped to a facility queue',
            code: 'QUEUE_SCOPE_DENIED',
        });
    }

    let query: any = collections.telehealthQueue.where('status', 'in', ['waiting', 'assigned']);
    if (facilityId) query = query.where('facilityId', '==', facilityId);

    const snapshot = await query.get();

    if (snapshot.empty) {
        return res.json({ success: true, message: 'Queue is already empty', data: { cleared: 0 } });
    }

    const batch = firestore.batch();
    snapshot.docs.forEach((doc: any) => {
        batch.update(doc.ref, {
            status: 'cancelled',
            completedAt: new Date(),
            statusReason: 'Queue cleared by admin',
            updatedBy: req.user!.userId,
            updatedByRole: req.user!.role,
            updatedAt: new Date(),
        });
    });

    await batch.commit();

    await logAudit(req, 'QUEUE_CLEARED', 'telehealthQueue', facilityId || 'platform', {
        details: { cleared: snapshot.size, facilityId, scope: facilityId ? 'facility' : 'platform' },
        severity: facilityId ? 'warning' : 'critical',
    });

    res.json({ success: true, message: `Queue cleared: ${snapshot.size} entries`, data: { cleared: snapshot.size } });
}));

/**
 * Mark patient as no-show
 */
router.patch('/:queueId/no-show', authorize(...QUEUE_MUTATION_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { queueId } = req.params;
    const { reason } = req.body;

    const doc = await collections.telehealthQueue.doc(queueId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Queue entry not found' });

    const data = doc.data()!;
    if (isAnotherDoctorsPatient(req.user, data)) return denyAnotherDoctorsPatient(res);
    if (!canActOnQueueEntry(req.user, data)) return denyQueueScope(res); // WALL-GAP-4
    if (!['waiting', 'assigned'].includes(data.status)) {
        return res.status(400).json({ success: false, error: 'Entry is not in an active state' });
    }

    // Release the doctor if assigned
    if (data.assignedDoctorId) {
        await doctorPresenceService.updateActiveConsultations(data.assignedDoctorId, -1);
    }

    await doc.ref.update({
        status: 'no_show',
        completedAt: new Date(),
        statusReason: reason || 'Patient did not respond when called',
        noShowAt: new Date(),
        updatedBy: req.user!.userId,
        updatedByRole: req.user!.role,
        updatedAt: new Date(),
    });

    if (data.consultationId) {
        await collections.consultations.doc(data.consultationId).update({
            status: 'no_show',
            updatedAt: new Date(),
        }).catch(() => {});
    }

    await logAudit(req, 'QUEUE_NO_SHOW', 'telehealthQueue', queueId, {
        details: { patientId: data.patientId, reason },
    });

    res.json({ success: true, message: 'Patient marked as no-show' });
}));

/**
 * Re-queue a patient (bring back no-show or cancelled patients)
 */
/**
 * Notify waiting patients whose position just improved (someone ahead was
 * assigned/completed/removed). Only the front of the line is pinged — position
 * spam annoys everyone further back. Best-effort: never blocks the caller.
 */
async function notifyQueueAdvancement(): Promise<void> {
    try {
        const waitingSnap = await collections.telehealthQueue.where('status', '==', 'waiting').get();
        const waiting = waitingSnap.docs
            .map((d) => d.data())
            .filter((w: any) => !!w.patientId)
            .sort((a: any, b: any) => (toMillis(a.joinedAt) || 0) - (toMillis(b.joinedAt) || 0));

        for (let i = 0; i < Math.min(waiting.length, 3); i++) {
            const w: any = waiting[i];
            const pos = i + 1;
            // Only notify when the position actually changed since last ping.
            if (w.lastNotifiedPosition === pos) continue;
            await collections.telehealthQueue.doc(w.queueId)
                .update({ lastNotifiedPosition: pos, updatedAt: new Date() })
                .catch(() => {});
            const title = pos === 1 ? "You're next! 🩺" : `You're #${pos} in line`;
            const body = pos === 1
                ? 'The doctor will call you any moment — keep the app open.'
                : `${pos - 1} ${pos - 1 === 1 ? 'person' : 'people'} ahead of you. Stay close to your phone.`;
            notificationService.sendToUser(w.patientId, title, body, {
                type: 'queue_position',
                queueId: w.queueId,
                position: String(pos),
                url: '/queue',
            }).catch(() => {});
        }
    } catch { /* advancement pings are best-effort */ }
}

/**
 * Release an ASSIGNED/IN-CONSULTATION patient back to the waiting queue —
 * e.g. the doctor opened the visit but vitals weren't recorded yet, so they
 * return this patient and take the next one while it's sorted out.
 * The patient keeps their original joinedAt (their place in line is fair).
 */
router.post('/:queueId/release', authorize(...QUEUE_MUTATION_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { queueId } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : '';

    // Accept either the queue entry id OR a consultation id (the Pro app's
    // queue works off consultations).
    let doc = await collections.telehealthQueue.doc(queueId).get();
    if (!doc.exists) {
        const byConsult = await collections.telehealthQueue
            .where('consultationId', '==', queueId)
            .where('status', 'in', ['assigned', 'in_consultation'])
            .limit(1)
            .get();
        if (!byConsult.empty) doc = byConsult.docs[0];
    }
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Queue entry not found' });
    const data = doc.data()!;
    if (isAnotherDoctorsPatient(req.user, data)) return denyAnotherDoctorsPatient(res);
    if (!canActOnQueueEntry(req.user, data) && !isAssignedDoctor(req.user, data)) return denyQueueScope(res); // WALL-GAP-4
    if (!['assigned', 'in_consultation'].includes(data.status)) {
        return res.status(409).json({ success: false, error: `Can only return assigned patients (current: ${data.status})` });
    }

    await doc.ref.update({
        status: 'waiting',
        assignedDoctorId: null,
        assignedAt: null,
        releasedBy: req.user!.userId,
        releasedAt: new Date(),
        releaseReason: reason || null,
        updatedAt: new Date(),
    });

    // Consultation goes back to pending so the next doctor can claim it.
    if (data.consultationId) {
        await collections.consultations.doc(data.consultationId)
            .update({ status: 'pending', doctorId: null, updatedAt: new Date() })
            .catch(() => {});
    }

    await logAudit(req, 'QUEUE_RELEASED', 'telehealthQueue', queueId, {
        details: { patientId: data.patientId, reason },
    });

    if (data.patientId) {
        notificationService.sendToUser(
            data.patientId,
            'Back in the queue',
            reason
                ? `You've been returned to the queue: ${reason}. You keep your place in line.`
                : "You've been returned to the queue — you keep your place in line.",
            { type: 'queue_returned', queueId, url: '/queue' },
        ).catch(() => {});
    }

    void notifyQueueAdvancement();
    res.json({ success: true, message: 'Patient returned to the queue (place in line kept)' });
}));

router.post('/:queueId/requeue', authorize(...QUEUE_MUTATION_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const { queueId } = req.params;
    const { priority } = req.body; // 'front' or 'back'

    const doc = await collections.telehealthQueue.doc(queueId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Queue entry not found' });

    const data = doc.data()!;
    if (!canActOnQueueEntry(req.user, data)) return denyQueueScope(res); // WALL-GAP-4
    if (!['no_show', 'cancelled', 'completed'].includes(data.status)) {
        return res.status(400).json({ success: false, error: 'Can only re-queue no-show, cancelled, or completed entries' });
    }

    // Check if patient is already back in queue
    const existingActive = await collections.telehealthQueue
        .where('patientId', '==', data.patientId)
        .where('status', 'in', ['waiting', 'assigned'])
        .limit(1)
        .get();

    if (!existingActive.empty) {
        return res.status(409).json({ success: false, error: 'Patient is already in the queue' });
    }

    // Calculate new position
    const queueSnapshot = await collections.telehealthQueue.where('status', '==', 'waiting').get();
    const newPosition = priority === 'front' ? 1 : queueSnapshot.size + 1;

    // Create new queue entry (keep history of old one)
    const newQueueId = require('uuid').v4();
    await collections.telehealthQueue.doc(newQueueId).set({
        queueId: newQueueId,
        patientId: data.patientId,
        patientName: data.patientName,
        facilityId: data.facilityId,
        symptoms: data.symptoms,
        urgencyLevel: data.urgencyLevel,
        preferredLanguage: data.preferredLanguage,
        status: 'waiting',
        position: newPosition,
        assignedDoctorId: null,
        consultationId: null,
        joinedAt: new Date(),
        assignedAt: null,
        completedAt: null,
        estimatedWaitMinutes: newPosition * 10,
        requeuedFrom: queueId,
        requeuedBy: req.user!.userId,
        requeuedAt: new Date(),
    });

    // Mark old entry as requeued
    await doc.ref.update({
        requeuedTo: newQueueId,
        updatedAt: new Date(),
    });

    await logAudit(req, 'QUEUE_REQUEUED', 'telehealthQueue', newQueueId, {
        details: { originalQueueId: queueId, patientId: data.patientId, position: newPosition },
    });

    res.status(201).json({
        success: true,
        message: `Patient re-queued at position #${newPosition}`,
        data: { newQueueId, position: newPosition },
    });
}));

/**
 * Queue analytics / summary
 */
router.get('/analytics', authorize(...STAFF_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    // Same tenancy rule as the queue reads — aggregates over another facility's
    // patients are still that facility's data.
    const facilityId = queueReadScopeOr403(req, res);
    if (facilityId === undefined) return;

    let baseQuery: any = collections.telehealthQueue;
    
    // Current queue
    let waitingQuery = applyQueueScope(baseQuery.where('status', '==', 'waiting'), facilityId);
    let assignedQuery = applyQueueScope(baseQuery.where('status', 'in', ['assigned']), facilityId);

    const [waitingSnap, assignedSnap] = await Promise.all([
        waitingQuery.get(),
        assignedQuery.get(),
    ]);

    // Today's stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let todayQuery = baseQuery.where('joinedAt', '>=', todayStart);
    todayQuery = applyQueueScope(todayQuery, facilityId);
    const todaySnap = await todayQuery.get();

    const todayStats = {
        total: todaySnap.size,
        completed: 0,
        noShow: 0,
        cancelled: 0,
    };

    todaySnap.docs.forEach((doc: any) => {
        const s = doc.data().status;
        if (s === 'completed') todayStats.completed++;
        else if (s === 'no_show') todayStats.noShow++;
        else if (s === 'cancelled') todayStats.cancelled++;
    });

    // Average wait time today
    const completedToday = todaySnap.docs.filter((d: any) => d.data().status === 'completed' && d.data().assignedAt);
    const avgWait = completedToday.length > 0
        ? completedToday.reduce((sum: number, d: any) => {
            const joined = d.data().joinedAt?.toDate?.() || new Date(d.data().joinedAt);
            const assigned = d.data().assignedAt?.toDate?.() || new Date(d.data().assignedAt);
            return sum + (assigned.getTime() - joined.getTime()) / 60000;
        }, 0) / completedToday.length
        : 0;

    res.json({
        success: true,
        data: {
            currentQueue: {
                waiting: waitingSnap.size,
                inConsultation: assignedSnap.size,
                total: waitingSnap.size + assignedSnap.size,
            },
            today: todayStats,
            avgWaitMinutes: Math.round(avgWait),
        },
    });
}));

// ============================================================
// LIVE DOCTOR SESSION / DUTY COVERAGE & ON-DUTY ESCALATION
// ============================================================

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const COVERAGE_STALE_MS = 5 * 60 * 1000;

function isTimeWithinShiftWindow(currentHHMM: string, start?: string, end?: string): boolean {
    if (!start || !end) return false;
    const s = String(start).trim().slice(0, 5);
    const e = String(end).trim().slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(s) || !/^\d{2}:\d{2}$/.test(e)) return false;
    if (s <= e) {
        return currentHHMM >= s && currentHHMM <= e;
    }
    // Overnight shift (e.g. 22:00 to 06:00)
    return currentHHMM >= s || currentHHMM <= e;
}

function resolveDoctorShiftNow(
    userId: string,
    docData: any,
    todayShifts: any[],
    hours: ResolvedDoctorHours,
    dayName: string,
    currentHHMM: string,
    targetFacilityId: string | null,
): { onShiftNow: boolean; currentShiftWindow: string | null } {
    // 1. Check today's rota (V2 + not-yet-migrated staffShifts)
    const doctorShifts = todayShifts.filter((sh) => {
        if (sh.staffUserId !== userId) return false;
        if (sh.status === 'cancelled') return false;
        if (targetFacilityId && targetFacilityId !== 'central' && sh.facilityId && sh.facilityId !== targetFacilityId) {
            return false;
        }
        return true;
    });

    for (const sh of doctorShifts) {
        if (isTimeWithinShiftWindow(currentHHMM, sh.startTime, sh.endTime)) {
            return {
                onShiftNow: true,
                currentShiftWindow: `${String(sh.startTime).slice(0, 5)}-${String(sh.endTime).slice(0, 5)}`,
            };
        }
    }

    // 2. The doctor's working hours for today — the same canonical hours the
    //    Pro app and web editor write and patient booking reads (legacy weekly
    //    maps and the profile's availability.schedule/workingHours are adapted).
    const day = hours.days[DAY_NAMES.indexOf(dayName as (typeof DAY_NAMES)[number])];
    const slotsList = day?.isActive ? day.periods : [];

    for (const slot of slotsList) {
        const start = slot.start;
        const end = slot.end;
        if (isTimeWithinShiftWindow(currentHHMM, start, end)) {
            return {
                onShiftNow: true,
                currentShiftWindow: `${String(start).slice(0, 5)}-${String(end).slice(0, 5)}`,
            };
        }
    }

    return { onShiftNow: false, currentShiftWindow: null };
}

function buildCoverageSummary(doctorsList: any[], waitingPatientsCount: number) {
    const totalCredentialedDoctors = doctorsList.length;
    const onlineAvailableDoctors = doctorsList.filter((d) => d.shiftStatus === 'online_available').length;
    const inSessionDoctors = doctorsList.filter((d) => d.shiftStatus === 'online_in_session').length;
    const scheduledOnShiftNow = doctorsList.filter((d) => d.onShiftNow).length;
    const scheduledButOfflineCount = doctorsList.filter((d) => d.shiftStatus === 'offline_on_shift').length;
    const totalOnline = onlineAvailableDoctors + inSessionDoctors;

    let coverageAlert:
        | 'critical_no_doctors_with_waiting_patients'
        | 'warning_scheduled_doctors_offline'
        | 'warning_no_doctors_online'
        | 'healthy';

    if (totalOnline === 0 && waitingPatientsCount > 0) {
        coverageAlert = 'critical_no_doctors_with_waiting_patients';
    } else if (scheduledButOfflineCount > 0) {
        coverageAlert = 'warning_scheduled_doctors_offline';
    } else if (totalOnline === 0) {
        coverageAlert = 'warning_no_doctors_online';
    } else {
        coverageAlert = 'healthy';
    }

    return {
        totalCredentialedDoctors,
        onlineAvailableDoctors,
        inSessionDoctors,
        scheduledOnShiftNow,
        scheduledButOfflineCount,
        waitingPatientsCount,
        coverageAlert,
    };
}

const COVERAGE_VIEW_ROLES: UserRole[] = [
    ...QUEUE_READ_ROLES,
    'care_home_nurse' as any,
    'care_home_admin' as any,
    'pharmacist',
    'pharmacy_admin',
    'medicine_store_attendant' as any,
    'lab_technician',
    'lab_admin',
    'rad_technician',
    'rad_admin',
];

/**
 * GET /api/v1/telehealth-queue/coverage-status
 * Live Doctor Session / Duty Coverage API for Hospital Admin, Clinic Admin,
 * Platform Admin, Doctors, Nurses, Pharmacists/PPMVs, and Front Desk / Receptionists.
 */
router.get('/coverage-status', authorize(...COVERAGE_VIEW_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const queryFacilityId = typeof req.query.facilityId === 'string' && req.query.facilityId.trim()
        ? req.query.facilityId.trim()
        : null;

    // Resolve target facility scope:
    // - Facility-bound non-platform staff default/lock to their own user.facilityId
    // - Platform admins without facilityId get network-wide + centralBreakdown
    let targetFacilityId: string | null = null;
    if (user.facilityId && !isPlatformQueueAdmin(user)) {
        targetFacilityId = user.facilityId;
    } else {
        targetFacilityId = queryFacilityId || activeFacilityContext(user)?.facilityId || user.facilityId || null;
    }

    // "On shift now" is judged on each doctor's local clock (facility zone,
    // else Africa/Lagos), never the server's. Shifts are stored by local date,
    // so read the UTC day either side and match each doctor's local date.
    const now = new Date();
    const utcDate = now.toISOString().slice(0, 10);
    const shiftDates = [addDays(utcDate, -1), utcDate, addDays(utcDate, 1)];

    const [
        doctorsSnap,
        presenceSnap,
        inProgressSnap,
        shiftsSnap,
        schedulesSnap,
        waitingQueueSnap,
    ] = await Promise.all([
        collections.doctors.get(),
        firestore.collection('doctorPresence').get(),
        collections.consultations.where('status', '==', 'in_progress').get(),
        // Rota (V2 shifts plus not-yet-migrated staffShifts) for each date.
        Promise.all(shiftDates.map((d) => rotaShiftsOnDate(d))).then((lists) => lists.flat()),
        firestore.collection('doctorSchedules').get(),
        collections.telehealthQueue.where('status', '==', 'waiting').get(),
    ]);

    const activeRawDoctors = doctorsSnap.docs
        .map((d: any) => ({
            userId: d.data()?.userId || d.id,
            data: () => ({ ...d.data(), userId: d.data()?.userId || d.id }),
        }))
        .filter((d: any) => {
            const st = d.data()?.status;
            return !st || st === 'active';
        });

    const credentialedDoctors = await filterCredentialedPrincipals(activeRawDoctors);

    // Scope doctors to facility when targetFacilityId is set
    const scopedDoctors = credentialedDoctors.filter((d: any) => {
        const doc = d.data();
        if (!targetFacilityId) return true;
        if (targetFacilityId === 'central') {
            return !doc.facilityId || doc.doctorType === 'platform';
        }
        const allowed = [doc.facilityId, ...(Array.isArray(doc.allowedFacilityIds) ? doc.allowedFacilityIds : [])].filter(Boolean);
        return allowed.includes(targetFacilityId);
    });

    // Map doctorPresence by userId
    const presenceMap = new Map<string, any>();
    presenceSnap.docs.forEach((doc: any) => {
        const pData = doc.data();
        const uid = pData?.userId || doc.id;
        presenceMap.set(uid, pData);
    });

    // Map active in_progress consultations by doctorId
    const activeConsultsMap = new Map<string, any[]>();
    inProgressSnap.docs.forEach((doc: any) => {
        const cData = doc.data();
        const docId = cData?.doctorId;
        if (!docId) return;
        const list = activeConsultsMap.get(docId) || [];
        list.push({ ...cData, consultationId: cData.consultationId || doc.id });
        activeConsultsMap.set(docId, list);
    });

    // Rota shifts around today (V2 + not-yet-migrated staffShifts); each doctor
    // is matched on their own facility-local date.
    const nearbyShifts: any[] = shiftsSnap;
    const zones = await doctorTimeZones(scopedDoctors.map((d: any) => ({ userId: d.userId, data: d.data() })));

    // Group every doctorSchedules doc by doctor (one per weekday + settings doc)
    const scheduleDocsByDoctor = new Map<string, Array<{ id: string; data: any }>>();
    schedulesSnap.docs.forEach((doc: any) => {
        const sData = doc.data();
        const uid = sData?.doctorId || doc.id;
        const list = scheduleDocsByDoctor.get(uid) || [];
        list.push({ id: doc.id, data: sData });
        scheduleDocsByDoctor.set(uid, list);
    });

    // Waiting queue entries
    const allWaitingEntries = waitingQueueSnap.docs.map((d: any) => d.data());
    const scopedWaitingEntries = allWaitingEntries.filter((entry: any) => {
        if (!targetFacilityId) return true;
        if (targetFacilityId === 'central') return !entry.facilityId;
        return entry.facilityId === targetFacilityId;
    });

    const doctors = scopedDoctors.map((d: any) => {
        const doc = d.data();
        const userId = d.userId;
        const presence = presenceMap.get(userId);
        const lastSeenDate = presence?.lastSeen?.toDate
            ? presence.lastSeen.toDate()
            : (presence?.lastSeen ? new Date(presence.lastSeen) : null);
        const isFreshPresence = Boolean(
            presence?.isOnline
            && lastSeenDate
            && !Number.isNaN(lastSeenDate.getTime())
            && (now.getTime() - lastSeenDate.getTime() < COVERAGE_STALE_MS)
        );
        const isAcceptingConsultations = doc.availability?.isAcceptingConsultations !== false;
        const isOnline = Boolean(isFreshPresence && isAcceptingConsultations);

        const activeConsults = activeConsultsMap.get(userId) || [];
        const activeConsultationsCount = activeConsults.length || (isOnline ? Number(presence?.activeConsultations || 0) : 0);
        const inActiveSession = activeConsultationsCount > 0;
        const currentConsultationId = activeConsults[0]?.consultationId || null;

        const clock = localClock(zones.get(userId) || 'Africa/Lagos', now);
        const { onShiftNow, currentShiftWindow } = resolveDoctorShiftNow(
            userId,
            doc,
            nearbyShifts.filter((sh: any) => sh?.date === clock.date),
            resolveDoctorHours(userId, scheduleDocsByDoctor.get(userId) || [], doc),
            DAY_NAMES[clock.dayOfWeek],
            clock.hhmm,
            targetFacilityId,
        );

        let shiftStatus: 'online_in_session' | 'online_available' | 'offline_on_shift' | 'off_duty';
        if (isOnline && inActiveSession) {
            shiftStatus = 'online_in_session';
        } else if (isOnline) {
            shiftStatus = 'online_available';
        } else if (onShiftNow) {
            shiftStatus = 'offline_on_shift';
        } else {
            shiftStatus = 'off_duty';
        }

        const fullName = `${doc.profile?.firstName || doc.firstName || ''} ${doc.profile?.lastName || doc.lastName || ''}`.trim()
            || doc.name
            || doc.email
            || userId;

        return {
            userId,
            name: fullName,
            specialization: doc.specialization || 'General Practice',
            facilityId: doc.facilityId || null,
            doctorType: doc.doctorType || (doc.facilityId ? 'facility' : 'platform'),
            isOnline,
            isAcceptingConsultations,
            lastSeen: lastSeenDate && !Number.isNaN(lastSeenDate.getTime()) ? lastSeenDate.toISOString() : null,
            inActiveSession,
            activeConsultationsCount,
            currentConsultationId,
            onShiftNow,
            currentShiftWindow,
            shiftStatus,
        };
    });

    const summary = buildCoverageSummary(doctors, scopedWaitingEntries.length);

    // For platform admins querying without a specific facilityId, include Central Network breakdown
    let centralBreakdown: any = undefined;
    if (!targetFacilityId && isPlatformQueueAdmin(user)) {
        const centralDoctors = doctors.filter((d: any) => !d.facilityId || d.doctorType === 'platform');
        const centralWaitingCount = allWaitingEntries.filter((e: any) => !e.facilityId).length;
        centralBreakdown = buildCoverageSummary(centralDoctors, centralWaitingCount);
    }

    res.json({
        success: true,
        data: {
            facilityId: targetFacilityId,
            timestamp: now.toISOString(),
            summary,
            ...(centralBreakdown ? { centralBreakdown } : {}),
            doctors,
        },
    });
}));

const NOTIFY_ON_DUTY_ROLES: UserRole[] = [
    'hospital_admin', 'clinic_admin', 'admin', 'super_admin', 'nurse', 'receptionist' as any,
    'pharmacist', 'pharmacy_admin', 'medicine_store_attendant' as any,
    'doctor', 'midwife', 'care_home_nurse' as any, 'care_home_admin' as any,
    'lab_technician', 'lab_admin', 'rad_technician', 'rad_admin',
];

/**
 * POST /api/v1/telehealth-queue/notify-on-duty
 * Sends an urgent notification to all scheduled/credentialed doctors in that
 * facility (or Central Network) to come online and attend to waiting patients.
 */
router.post('/notify-on-duty', authorize(...NOTIFY_ON_DUTY_ROLES), asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const requestedFacilityId = typeof req.body?.facilityId === 'string' && req.body.facilityId.trim()
        ? req.body.facilityId.trim()
        : (typeof req.query.facilityId === 'string' && req.query.facilityId.trim() ? req.query.facilityId.trim() : null);

    let targetFacilityId: string | null = null;
    if (user.facilityId && !isPlatformQueueAdmin(user)) {
        targetFacilityId = user.facilityId;
    } else {
        targetFacilityId = requestedFacilityId || activeFacilityContext(user)?.facilityId || user.facilityId || null;
    }

    const customMessage = typeof req.body?.message === 'string' && req.body.message.trim()
        ? req.body.message.trim()
        : null;

    const [doctorsSnap, waitingSnap] = await Promise.all([
        collections.doctors.get(),
        collections.telehealthQueue.where('status', '==', 'waiting').get(),
    ]);

    const activeRawDoctors = doctorsSnap.docs
        .map((d: any) => ({
            userId: d.data()?.userId || d.id,
            data: () => ({ ...d.data(), userId: d.data()?.userId || d.id }),
        }))
        .filter((d: any) => {
            const st = d.data()?.status;
            return !st || st === 'active';
        });

    const credentialedDoctors = await filterCredentialedPrincipals(activeRawDoctors);
    const matchedDoctors = credentialedDoctors.filter((d: any) => {
        const doc = d.data();
        if (!targetFacilityId || targetFacilityId === 'central') {
            return !doc.facilityId || doc.doctorType === 'platform' || !targetFacilityId;
        }
        const allowed = [doc.facilityId, ...(Array.isArray(doc.allowedFacilityIds) ? doc.allowedFacilityIds : [])].filter(Boolean);
        return allowed.includes(targetFacilityId);
    });

    const waitingPatientsCount = waitingSnap.docs
        .map((d: any) => d.data())
        .filter((entry: any) => {
            if (!targetFacilityId) return true;
            if (targetFacilityId === 'central') return !entry.facilityId;
            return entry.facilityId === targetFacilityId;
        }).length;

    const title = '🚨 Urgent Coverage Request: Patients Waiting';
    const body = customMessage
        || `There ${waitingPatientsCount === 1 ? 'is 1 patient' : `are ${waitingPatientsCount} patients`} waiting in the telehealth queue. Please go online and accept consultations immediately.`;

    const notifiedDoctorIds: string[] = [];
    for (const d of matchedDoctors) {
        const doctorId = d.userId;
        notifiedDoctorIds.push(doctorId);
        if (!req.isSandbox) {
            notificationService.sendToUser?.(doctorId, title, body, {
                type: 'urgent_on_duty_coverage_request',
                facilityId: targetFacilityId || '',
                waitingPatientsCount: String(waitingPatientsCount),
                url: '/dashboard/telehealth/queue',
            })?.catch?.(() => {});
        }
    }

    if (!req.isSandbox) {
        notificationService.sendToFacilityStaff?.(
            targetFacilityId && targetFacilityId !== 'central' ? targetFacilityId : null,
            ['doctor'],
            title,
            body,
            {
                type: 'urgent_on_duty_coverage_request',
                facilityId: targetFacilityId || '',
                waitingPatientsCount: String(waitingPatientsCount),
                url: '/dashboard/telehealth/queue',
            },
        )?.catch?.(() => {});
    }

    await logAudit(req, 'NOTIFY_ON_DUTY_DOCTORS', 'telehealthQueue', targetFacilityId || 'central', {
        details: {
            facilityId: targetFacilityId,
            notifiedCount: notifiedDoctorIds.length,
            notifiedDoctorIds,
            waitingPatientsCount,
        },
    });

    res.json({
        success: true,
        message: `Urgent coverage alert sent to ${notifiedDoctorIds.length} doctor(s).`,
        data: {
            facilityId: targetFacilityId,
            notifiedCount: notifiedDoctorIds.length,
            notifiedDoctorIds,
            waitingPatientsCount,
        },
    });
}));

export default router;
