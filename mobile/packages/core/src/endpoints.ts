import { apiClient, ApiError, type Envelope } from './api/client';
import { newIdempotencyKey, syncQueue } from './sync/queue';
import {
  User,
  AuthTokens,
  QueueStatus,
  SlaBoardEntry,
  IntakeMessageResult,
  Consultation,
  ChatMessage,
  Prescription,
  WalletState,
  WalletTransaction,
  RpmProgram,
  RpmEnrollment,
  RpmReading,
  RpmAlert,
  NearbyFacility,
  AppNotification,
  WalkIn,
  InventoryItem,
  DoctorAnalytics,
  Language,
  Pagination,
  Delivery,
  FamilyMember,
  InviteInfo,
  CareCapabilities,
  CarePreference,
  InpatientPatient,
  Admission,
  TimelineItem,
  AdmissionVital,
  MarMedication,
  MarStatus,
  PpidStartResult,
  PpidVerificationResult,
  AdmissionNote,
  CanonicalInpatientOrderInput,
  CanonicalInpatientOrderCreateResult,
  CanonicalInpatientOrderListResult,
  HospitalCarePlanCreateInput,
  HospitalCarePlanMutationResult,
  HospitalCarePlanListResult,
  HospitalCarePlanEligibleAssigneeListResult,
  HospitalCarePlanAssignInput,
  HospitalCarePlanRescheduleInput,
  HospitalCarePlanReasonInput,
  AttentionFlag,
  AttentionFlagStatus,
  CreateAttentionFlagInput,
  CareHomeResident,
  CarePlanTask,
  PatientVerificationStatus,
  IntakeFormData,
  PatientAdmissionStatus,
  PatientAdmissionDetails,
  NurseCall,
  PatientNurseCallResponse,
  StaffNurseCall,
  NurseCallReason,
  NurseCallUrgency,
  NurseCallResolutionCode,
  HmoProvider,
  InsurancePolicy,
  EligibilityResult,
  InsuranceClaim,
  ClaimLineItem,
  PreAuthResult,
  PractitionerMe,
  PractitionerCredential,
  RoleAgreement,
  PractitionerRoleAppointment,
  AccountClosureCase,
  AccountClosureCareHold,
  AccountClosureHistoryEvent,
  AccountClosureReceipt,
  PostClosureRightType,
  PostClosureRightsCase,
  PostClosureRightsSession,
  PublicClosureStatus,
  PublicClosureReceiptArtifact,
} from './types';

const api = apiClient;

// ── Auth ──────────────────────────────────────────────────────────────────
export const authApi = {
  login: (email: string, password: string) =>
    api.post<{
      user: User;
      tokens?: AuthTokens;
      mfaRequired?: boolean;
      /** Pending MFA JWT (only when `mfaRequired`). */
      mfaToken?: string;
      /** Second factors the account can answer the challenge with. */
      mfaMethods?: MfaMethod[];
      expiresIn?: number;
    }>('/auth/login', { email, password }, { auth: false }),
  register: (body: { email: string; password: string; phone?: string; profile: { firstName: string; lastName: string } }) =>
    api.post<{ user: User; expiresIn?: number }>('/auth/register', { ...body, role: 'patient' }, { auth: false }),
  refresh: (refreshToken: string) => api.post<{ tokens: AuthTokens }>('/auth/refresh', { refreshToken }, { auth: false }),
  me: () => api.get<User>('/auth/me'),
  logout: () => api.post('/auth/logout'),
  forgotPassword: (email: string) => api.post('/auth/forgot-password', { email }, { auth: false }),
  changePassword: (currentPassword: string, newPassword: string) => api.post('/auth/change-password', { currentPassword, newPassword }),
  socialLogin: (
    provider: 'google' | 'apple',
    idToken: string,
    profileDraft?: { firstName?: string; lastName?: string; phone?: string; phoneVerifiedToken?: string; dateOfBirth?: string; gender?: string },
  ) =>
    // MFA-enrolled accounts get `{ user, mfaRequired: true, mfaToken, mfaMethods,
    // expiresIn }` and NO tokens (SPEC D10) — callers must branch on
    // `mfaRequired` exactly like a password login.
    api.post<{
      user: User;
      tokens?: AuthTokens;
      isNewUser?: boolean;
      requiresOnboarding?: boolean;
      mfaRequired?: boolean;
      mfaToken?: string;
      mfaMethods?: MfaMethod[];
      expiresIn?: number;
    }>(
      '/auth/social-login',
      { provider, idToken, ...(profileDraft ? { profileDraft } : {}) },
      { auth: false },
    ),
  prefillLookup: (body: { phone?: string; email?: string }) =>
    api.post<{
      matched: boolean;
      hasPasswordAccount?: boolean;
      isWalkInAccount?: boolean;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      dateOfBirth?: string;
      gender?: string;
      mrn?: string | null;
    }>('/auth/prefill-lookup', body, { auth: false }),
  sendPhoneOtp: (phone: string) => api.post<{ success: boolean; message?: string; otp?: string; devOtp?: string }>('/auth/send-phone-otp', { phone }, { auth: false }),
  verifyPhoneOtp: (phone?: string, code?: string, idToken?: string) =>
    api.post<{ verified: boolean; tempToken?: string; phone?: string }>('/auth/verify-phone-otp', { phone, code, idToken }, { auth: false }),
  /**
   * Begin (or RESUME) TOTP enrolment.
   *
   * `POST /mfa/setup` is idempotent by design (`mfa.routes.ts`): an enrolment
   * already in progress returns the SAME pending secret (`resumed: true`) until
   * it is verified or explicitly restarted with `regenerate`. It used to mint a
   * fresh secret on every call, so a remount handed the user a secret their
   * authenticator no longer held and enrolment became impossible. Callers must
   * still guard against calling it twice on mount — see `mfa-setup.tsx`.
   *
   * An ALREADY-ENABLED account gets 400 ("MFA is already enabled…"). That is a
   * state, not a failure: handle it as "already enrolled".
   */
  mfaSetup: (regenerate = false) =>
    api.post<{ secret: string; qrUri: string; resumed?: boolean; message?: string }>(
      '/mfa/setup',
      regenerate ? { regenerate: true } : undefined,
    ),
  /**
   * Confirm the authenticator and enable MFA.
   *
   * Returns the one-time `recoveryCodes` (shown once, never again) AND fresh
   * `tokens` carrying `mfaVerified: true`. Applying those tokens is NOT
   * optional: without them the caller keeps a session JWT with
   * `mfaVerified:false` and stays 403'd on every gated route despite having
   * just enrolled — the exact lockout the web console hit.
   */
  mfaVerify: (token: string) =>
    api.post<{ recoveryCodes?: string[]; warning?: string; tokens?: AuthTokens; expiresIn?: number }>(
      '/mfa/verify',
      { token },
    ),
  mfaDisable: (token: string) => api.post('/mfa/disable', { token }),
  mfaStatus: () => api.get<MfaStatus>('/mfa/status'),
  /**
   * Re-confirm identity for a sensitive change (passkey add/remove, MFA
   * disable) after the server answered 403 `REAUTH_REQUIRED`. Accounts with an
   * authenticator app send `totpCode` (and `password` too when the server
   * answers 400 `PASSWORD_AND_CODE_REQUIRED`); passkey-only staff get 400
   * `USE_PASSKEY` and must use the passkey step-up instead; social-only
   * accounts get 400 `REAUTH_SIGN_IN_AGAIN`. Returns fresh tokens with a new
   * `auth_time` — store them with `applyTokens`.
   *
   * `noRefresh`: a 401 here means "that password/code was wrong", never "the
   * session expired" — refreshing and replaying would resend the secret.
   */
  reauth: (body: { password?: string; totpCode?: string }) =>
    api.post<PasskeyTokensBody>('/auth/reauth', body, { noRefresh: true }),
  verifyDevice: (code: string, tempToken: string) =>
    api.post<{ verified: boolean; tokens?: AuthTokens; user?: User }>('/auth/verify-device', { code, tempToken }, { auth: false }),
  trustDevice: () => api.post('/auth/trust-device'),
};

// ── Passkeys (WebAuthn) ───────────────────────────────────────────────────
// Contract: SPEC §2. `/passkeys/*` is mounted WITHOUT requireMFA (like
// `/mfa/*`) so staff can enrol a passkey from inside the MFA gate; the api
// client's MFA latch lets the path through for the same reason.
export type MfaMethod = 'totp' | 'passkey';

export interface MfaStatus {
  /** TOTP (authenticator app) enabled — unchanged legacy meaning. */
  enabled: boolean;
  passkeyCount?: number;
  methods?: MfaMethod[];
  /** Account satisfies the MFA requirement (TOTP, or passkeys per policy). */
  hasMfa?: boolean;
  passkeysEnabled?: boolean;
  staffPasskeyMfa?: boolean;
  recoveryCodesRemaining?: number;
}

export interface PasskeySummary {
  /** Credential id (base64url). */
  id: string;
  nickname: string;
  provider: string;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdPlatform: 'web' | 'ios' | 'android';
  createdAt: string;
  lastUsedAt: string | null;
  status: 'active' | 'suspect';
}

export interface PasskeyStatus {
  enabled: boolean;
  staffMfa: boolean;
  rpId: string;
}

/** Identical to the `/auth/login` success body. */
export interface PasskeyTokensBody {
  user: User;
  tokens: AuthTokens;
  expiresIn?: number;
}

/** Server-issued WebAuthn options (JSON form, base64url binary fields). */
export interface PasskeyCeremonyOptions<T = Record<string, unknown>> {
  challengeId: string;
  options: T;
}

export interface PasskeyRegistrationResult {
  passkey: PasskeySummary;
  /** Present when this passkey is the account's first MFA method. Shown once. */
  recoveryCodes?: string[];
  /** Present when this enrolment made a not-yet-verified session MFA-complete. */
  tokens?: AuthTokens;
  user?: User;
}

export const passkeyApi = {
  status: () => api.get<PasskeyStatus>('/passkeys/status', undefined, { auth: false }),
  /**
   * `{ usernameless: true }` for a plain passkey sign-in (the server then
   * ignores any stale mfa_pending cookie); `{ mfaToken }` for the second step.
   */
  authenticationOptions: (body: { mfaToken?: string; usernameless?: boolean } = {}) =>
    api.post<PasskeyCeremonyOptions>('/passkeys/authentication/options', body, { auth: false, noRefresh: true }),
  authenticationVerify: (body: { challengeId: string; response: unknown; mfaToken?: string }) =>
    api.post<PasskeyTokensBody>('/passkeys/authentication/verify', body, { auth: false, noRefresh: true }),
  registrationOptions: (body: { authenticatorAttachment?: 'platform' | 'cross-platform' } = {}) =>
    api.post<PasskeyCeremonyOptions>('/passkeys/registration/options', body),
  registrationVerify: (body: {
    challengeId: string;
    response: unknown;
    nickname?: string;
    platform?: 'web' | 'ios' | 'android';
  }) => api.post<PasskeyRegistrationResult>('/passkeys/registration/verify', body),
  list: () => api.get<{ passkeys: PasskeySummary[] }>('/passkeys'),
  rename: (id: string, nickname: string) =>
    api.patch<{ passkey: PasskeySummary }>(`/passkeys/${encodeURIComponent(id)}`, { nickname }),
  remove: (id: string) => api.del<{ removed: boolean }>(`/passkeys/${encodeURIComponent(id)}`),
  // `noRefresh`: a 401 from a ceremony means "passkey not accepted"; a
  // refresh-and-replay would double every failed attempt.
  stepUpOptions: () => api.post<PasskeyCeremonyOptions>('/passkeys/step-up/options', {}, { noRefresh: true }),
  stepUpVerify: (body: { challengeId: string; response: unknown }) =>
    api.post<PasskeyTokensBody>('/passkeys/step-up/verify', body, { noRefresh: true }),
};

// ── Permanent practitioner identity + site appointments ──────────────────
export const practitionerApi = {
  me: () => api.get<PractitionerMe>('/practitioners/me'),
  selectRole: (practitionerRoleId: string) =>
    api.post<{ role: PractitionerRoleAppointment; tokens: AuthTokens }>(
      '/practitioners/me/select-role',
      { practitionerRoleId, reason: 'mobile_self_service_context_switch' },
    ),
  attestOrientation: (practitionerRoleId: string, version: string) =>
    api.post(`/practitioners/me/roles/${practitionerRoleId}/orientation-attestation`, {
      version,
      reason: 'mobile_self_service_orientation_attestation',
    }),

  /**
   * Register a professional licence against the caller's own practitioner
   * identity (`POST /practitioners/me/credentials`).
   *
   * This closes the licensure wall's dead end: `CredentialGate` told the
   * clinician to "Add your licence" and routed to a READ-ONLY screen whose own
   * copy said to use the web dashboard — as plain text, with no link. The write
   * endpoints existed the whole time and were simply absent from this file.
   *
   * 404 `Practitioner identity not found` means the account has no practitioner
   * record at all (`no_practitioner_identity`); that is an administrator task,
   * not something the clinician can self-serve, and the UI says so.
   */
  addCredential: (body: {
    type: string;
    registrationNumber: string;
    authority: string;
    expiresAt: string;
    issuedAt?: string | null;
    verificationMethod?: string;
    documentUrl?: string | null;
  }) => api.post<PractitionerCredential>('/practitioners/me/credentials', body),

  /** Renew an existing licence (`PATCH /practitioners/me/credentials/:id/renew`). */
  renewCredential: (
    credentialId: string,
    body: { expiresAt: string; issuedAt?: string | null; verificationMethod?: string; documentUrl?: string | null },
  ) => api.patch<PractitionerCredential>(`/practitioners/me/credentials/${credentialId}/renew`, body),
};

// ── Role agreements (the contract gate) ──────────────────────────────────
/**
 * The agreement corpus is SERVED, never duplicated into the app.
 *
 * `GET /contracts/my-agreement` resolves the caller's role to the one reviewed
 * document and returns it with the version metadata that the signature record
 * stores. Mobile previously had to hand off to the web because it had no
 * lawful way to show the text; copying `frontend/src/content/agreements.ts`
 * into the app would have created a second, silently diverging legal corpus.
 */
export const contractsApi = {
  status: () => api.get<{ signed: boolean }>('/contracts/status'),
  myAgreement: () => api.get<RoleAgreement>('/contracts/my-agreement'),
  sign: (body: {
    signatureData: string;
    agreementKey: string;
    agreementVersion: string;
    agreementTitle: string;
    corpusVersion: string;
  }) => api.post<{ success: boolean }>('/contracts/sign-user-contract', body),
};

// ── AI intake ────────────────────────────────────────────────────────────
/**
 * Normalize the backend intake payload to the mobile `IntakeMessageResult`.
 * The service returns `aiResponse` (not `message`), `emergencyDetected` (not
 * `emergencyEscalation`) and `completeness` as an object `{percent,...}` (not a
 * 0-1 number). Both the guest and authenticated chat screens read the mobile
 * shape, so we map it in one place here.
 */
function cleanConversationalText(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/(?:^|(?<=[.!?]\s+))\[NAME_REDACTED\]\s+(?=(?:is|was|has|had|are|were|can|could|will|would|do|does|did|brings|brought)\b)/gi, 'What ')
    .replace(/(?:^|(?<=[.!?]\s+))Is\s+(the\s+(?:main|primary)\s+(?:health\s+)?(?:problem|issue|symptom|reason|concern)\b)/g, 'What is $1')
    .replace(/\b(Hello|Hi|Dear|Hey|Welcome|Thank you|Thanks),?\s*\[NAME_REDACTED\]([!.,?]?)/gi, '$1$2')
    .replace(/\s*\[(?:NAME|PHONE|EMAIL|DOB|ID|MRN|NIN|BVN|ADDRESS|PASSPORT|INSURANCE|IP|SSN|POBOX)_REDACTED\]/g, '')
    .replace(/\s*\[REDACTED\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
}

function normalizeIntake(raw: Record<string, unknown>): IntakeMessageResult {
  const c = raw.completeness as unknown;
  let completeness: number | undefined;
  if (typeof c === 'number') completeness = c > 1 ? c / 100 : c;
  else if (c && typeof c === 'object' && typeof (c as { percent?: unknown }).percent === 'number') {
    completeness = (c as { percent: number }).percent / 100;
  }
  const rawMessage = (raw.message as string) ?? (raw.aiResponse as string) ?? '';
  return {
    message: cleanConversationalText(rawMessage),
    category: raw.category as string | undefined,
    isComplete: raw.isComplete === true,
    completeness,
    redFlags: Array.isArray(raw.redFlags) ? (raw.redFlags as string[]) : [],
    emergencyEscalation:
      raw.emergencyDetected === true ||
      (Array.isArray(raw.emergencyEscalation) && (raw.emergencyEscalation as unknown[]).length > 0) ||
      raw.emergencyEscalation === true,
    triage: (raw.triage as IntakeMessageResult['triage']) ?? undefined,
  };
}

export const intakeApi = {
  message: (body: { message: string; consultationId: string; language?: Language }) =>
    api.post<Record<string, unknown>>('/ai-intake/message', body).then(normalizeIntake),
  guest: (body: { message: string; sessionId?: string; language?: Language }) =>
    api.post<Record<string, unknown>>('/ai-intake/guest', body, { auth: false }).then(normalizeIntake),
  status: (consultationId: string) => api.get<Record<string, unknown>>(`/ai-intake/${consultationId}/status`),
  getStatus: (consultationId: string) => api.get<Record<string, unknown>>(`/ai-intake/${consultationId}/status`),
  brief: (consultationId: string) => api.get<Record<string, unknown>>(`/ai-intake/${consultationId}/brief`),
  getBrief: (consultationId: string) => api.get<Record<string, unknown>>(`/ai-intake/${consultationId}/brief`),
  /** Defer AI History (Hx) Intake when booking a future scheduled appointment.
   *  The patient must still complete Hx intake (via AI or Walk-In Nurse) before seeing the doctor. */
  defer: (consultationId: string, body?: { reason?: string; mode?: string }) =>
    api.post<Record<string, unknown>>(`/ai-intake/${consultationId}/defer`, {
      mode: 'scheduled',
      ...(body ?? {}),
    }),
  /** Nurse completes History (Hx) Intake on behalf of a patient at a walk-in facility. */
  nurseComplete: (consultationId: string, data: Record<string, unknown>) =>
    api.post<Record<string, unknown>>(`/ai-intake/${consultationId}/nurse-complete`, data),
  walkIns: () => api.get<WalkIn[]>('/ai-intake/walk-ins'),
  /** Register a new walk-in patient from mobile (nurse/front-desk). */
  createWalkIn: (body: { patientName: string; phone?: string; age?: number; gender?: string; chiefComplaint?: string; triageCategory?: string }) =>
    api.post<WalkIn>('/ai-intake/walk-ins', body),
  walkInVitals: (sessionId: string, body: Record<string, unknown>) => api.post(`/ai-intake/walk-ins/${sessionId}/vitals`, body),
  walkInSend: (sessionId: string) => api.post(`/ai-intake/walk-ins/${sessionId}/send`),
  /** Lookup or create a phone-linked patient account at a Care Station / Assisted Intake terminal. */
  careStationPatientLookup: (body: {
    /** One of phone / email / mrn identifies the patient. */
    phone?: string;
    email?: string;
    mrn?: string;
    patientName?: string;
    age?: number;
    gender?: string;
    chiefComplaint?: string;
    triageCategory?: string;
    createIfMissing?: boolean;
  }) => api.post<Record<string, unknown>>('/ai-intake/care-station/patient-lookup', body),
  /** Conduct staff-assisted or station AI intake chat on a walk-in session. */
  walkInChat: (
    sessionId: string,
    body: {
      message: string;
      language?: Language;
      vitals?: Record<string, unknown>;
      structuredHx?: Record<string, unknown>;
    },
  ) => api.post<Record<string, unknown>>(`/ai-intake/walk-ins/${sessionId}/chat`, body),
  /** Generate a 6-character handoff code & QR URL so a patient with a phone can claim their intake/consultation on their own device. */
  createHandoffToken: (sessionId: string) =>
    api.post<{
      sessionId: string;
      consultationId?: string;
      handoffCode: string;
      handoffToken: string;
      handoffUrl: string;
      expiresAt: string;
    }>(`/ai-intake/walk-ins/${sessionId}/handoff-token`),
  /** Claim a walk-in handoff session using the 6-character code or token. */
  claimHandoff: (body: { code: string; handoffToken?: string; phone?: string }) =>
    api.post<Record<string, unknown>>('/ai-intake/walk-ins/claim-handoff', body),
  /** Read the live Care Station consultation terminal state (messages, status, doctor info). */
  getTerminalSession: (consultationId: string) =>
    api.get<Record<string, unknown>>(`/ai-intake/care-station/${consultationId}/terminal`),
  /** Send a patient message or terminal action from the shared Care Station consultation terminal. */
  sendTerminalMessage: (consultationId: string, body: { content?: string; action?: string }) =>
    api.post<Record<string, unknown>>(`/ai-intake/care-station/${consultationId}/terminal-message`, body),
  /** Save pre-consultation intake data (structured form) to a consultation record.
   *  Backend reads FLAT fields (`presentingComplaint`, `severity`, …, `other`) —
   *  so the form data is spread into the body and `otherInfo` maps to `other`. */
  saveIntake: (consultationId: string, intakeData: IntakeFormData) => {
    const { otherInfo, ...rest } = intakeData;
    return api.post<Record<string, unknown>>('/patients/intake', { consultationId, ...rest, other: otherInfo });
  },
  /** Verify NAFDAC registration, brand details & PCN PPMV counter dispensing gate. */
  verifyNafdac: (body: {
    nafdacRegNo?: string;
    drugName?: string;
    batchNumber?: string;
    expiryDate?: string;
    facilityLicenceClass?: string;
    hasActiveLinkedRx?: boolean;
    imageBase64?: string;
  }) => api.post<Record<string, unknown>>('/ai-intake/nafdac/verify', body),
  /** Segment and analyze clinical ROI images via SAM 3.1 & Meta Muse. */
  analyzeVision: (body: {
    type: string;
    imageBase64?: string;
    imageUrl?: string;
    consultationId?: string;
    patientId?: string;
    clinicalContext?: string;
    facilityLicenceClass?: string;
    hasActiveLinkedRx?: boolean;
    referenceScaleMm?: number;
  }) =>
    api.post<Record<string, unknown>>('/ai-intake/vision/analyze', {
      ...body,
      imageBase64:
        body.imageBase64 ||
        (!body.imageUrl
          ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
          : undefined),
    }),
  /** Two-way doctor-patient call audio diarization and speech transcription. */
  callDiarize: (consultationId: string, body: { audioBase64: string; language?: string; stripNoise?: boolean }) =>
    api.post<Record<string, unknown>>(`/ai-intake/${consultationId}/call-diarize`, body),
  /** Live consultation copilot sync with Meta Muse Wonder. */
  copilotSync: (consultationId: string, body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>(`/ai-intake/${consultationId}/copilot-sync`, body),
};

export const aiIntakeApi = intakeApi;

// ── Telehealth queue ────────────────────────────────────────────────────────
export const queueApi = {
  join: (body: { symptoms?: string; urgencyLevel?: string; preferredLanguage?: Language; facilityId?: string; dependentId?: string }) =>
    api.post<QueueStatus>('/telehealth-queue/join', body),
  leave: () => api.del('/telehealth-queue/leave'),
  myStatus: (dependentId?: string) => api.get<QueueStatus>('/telehealth-queue/my-status', { dependentId }),
  slaDashboard: (facilityId?: string) =>
    api.get<{ queue: SlaBoardEntry[]; summary?: Record<string, unknown> }>('/telehealth-queue/sla-dashboard', { facilityId }),
  /**
   * Staff read of the live queue. `GET /telehealth-queue/queue` is
   * `QUEUE_READ_ROLES` = DOCTOR_ROLES + `nurse` (widened 2026-07-31 precisely
   * because a nurse could MUTATE a queue she was forbidden to read).
   *
   * Nurses must use THIS, not `consultationsApi.doctorQueue()` — the latter is
   * `/doctors/me/consultations`, which is `authorize('doctor')`, so a nurse
   * polling it 403-looped her own landing tab every 15s forever.
   *
   * `customer_service` is deliberately excluded server-side; do not call this
   * from a CS surface.
   */
  queue: (status?: string) =>
    api.get<{ queue: QueueEntry[]; stats?: QueueStats }>('/telehealth-queue/queue', { status }),
  /** Live doctor coverage, active sessions, and scheduled on-shift status for Facility & Central Admins. */
  getCoverageStatus: (facilityId?: string) =>
    api.get<DoctorCoverageStatus>('/telehealth-queue/coverage-status', facilityId ? { facilityId } : undefined),
  coverageStatus: (facilityId?: string) =>
    api.get<DoctorCoverageStatus>('/telehealth-queue/coverage-status', facilityId ? { facilityId } : undefined),
  /** Send an immediate high-priority alert to on-duty / credentialed doctors when coverage is needed. */
  notifyOnDuty: (data?: { facilityId?: string; message?: string }) =>
    api.post<Record<string, unknown>>('/telehealth-queue/notify-on-duty', data ?? {}),
};

export const telehealthQueueApi = queueApi;

export interface DoctorCoverageSummary {
  totalCredentialedDoctors?: number;
  onlineAvailableDoctors?: number;
  inSessionDoctors?: number;
  scheduledOnShiftNow?: number;
  scheduledButOfflineCount?: number;
  waitingPatientsCount?: number;
  coverageAlert?:
    | 'critical_no_doctors_with_waiting_patients'
    | 'warning_scheduled_doctors_offline'
    | 'warning_no_doctors_online'
    | 'healthy'
    | string;
}

export interface DoctorCoverageDoctor {
  userId?: string;
  id?: string;
  name?: string;
  specialization?: string;
  facilityId?: string | null;
  facilityName?: string | null;
  doctorType?: string;
  isOnline?: boolean;
  isAcceptingConsultations?: boolean;
  lastSeen?: unknown;
  inActiveSession?: boolean;
  activeConsultationsCount?: number;
  currentConsultationId?: string | null;
  onShiftNow?: boolean;
  currentShiftWindow?: string | null;
  shiftStatus?: 'online_in_session' | 'online_available' | 'offline_on_shift' | 'off_duty' | string;
}

export interface DoctorCoverageStatus {
  summary?: DoctorCoverageSummary;
  doctors?: DoctorCoverageDoctor[];
  [key: string]: unknown;
}

/** A live queue row as returned by `GET /telehealth-queue/queue`. */
export interface QueueEntry {
  queueId?: string;
  patientId?: string;
  patientName?: string;
  consultationId?: string;
  status?: string;
  urgencyLevel?: string;
  triageBand?: string;
  symptoms?: string;
  joinedAt?: string;
  facilityId?: string;
  [key: string]: unknown;
}

export interface QueueStats {
  total?: number;
  waiting?: number;
  assigned?: number;
  inConsultation?: number;
  availableDoctors?: number;
}

// ── Scheduling ──────────────────────────────────────────────────────────────
export const schedulingApi = {
  /** Doctors a patient can book (same list as the web booking drawer; licensure-checked on the server). */
  bookableDoctors: (query?: { specialization?: string; limit?: number }) => api.get<unknown[]>('/doctors', { limit: 50, ...query }),
  doctorSlots: (doctorId: string, query?: { date?: string }) => api.get<unknown[]>(`/scheduling/doctors/${doctorId}/slots`, query),
  bookSlot: (body: Record<string, unknown>) => api.post('/scheduling/slots/book', body),
  appointments: (query?: Record<string, string | undefined>) => api.get<unknown[]>('/scheduling/appointments', query),
  appointment: (id: string) => api.get(`/scheduling/appointments/${id}`),
  reschedule: (id: string, body: Record<string, unknown>) => api.patch(`/scheduling/appointments/${id}`, body),
  cancel: (id: string) => api.del(`/scheduling/appointments/${id}`),
};

// ── Consultations ───────────────────────────────────────────────────────────
export const consultationsApi = {
  create: (body: Record<string, unknown>) => api.post<Consultation>('/consultations', body),
  get: (id: string) => api.get<Consultation>(`/consultations/${id}`),
  myList: (dependentId?: string) => api.get<Consultation[]>('/patients/consultations', { dependentId }),
  doctorQueue: (query?: { status?: string; facilityId?: string }) => api.get<Consultation[]>('/doctors/me/consultations', query),
  claim: (id: string) => api.post<Consultation>(`/consultations/${id}/claim`),
  setStatus: (id: string, status: string) => api.patch(`/consultations/${id}/status`, { status }),
  setDiagnosis: (id: string, body: Record<string, unknown>) => api.patch(`/consultations/${id}/diagnosis`, body),
  prescribe: (id: string, body: { medications: unknown[]; instructions?: string; pharmacyId?: string }) =>
    api.post<Prescription>(`/consultations/${id}/prescription`, body),
  markPrescriptionFulfilled: (consultationId: string, prescriptionId: string, note?: string) =>
    // Backend handler lives in doctor.routes.ts, mounted under /doctors.
    api.post(`/doctors/consultations/${consultationId}/prescriptions/${prescriptionId}/mark-fulfilled`, { note }),
  labOrder: (id: string, body: Record<string, unknown>) => api.post(`/consultations/${id}/lab-order`, body),
  messages: (id: string) => api.get<ChatMessage[]>(`/consultations/${id}/messages`),
  sendMessage: (id: string, body: { message: string; attachments?: unknown[] }) => api.post<ChatMessage>(`/consultations/${id}/messages`, body),
  markRead: (id: string) => api.patch<{ updated: number }>(`/consultations/${id}/messages/read`),
  rate: (id: string, body: { rating: number; feedback?: string }) =>
    api.post<Record<string, unknown>>(`/consultations/${id}/rating`, body),
  /** Treating-doctor view of the patient's identity + prior essential records. */
  patientSummary: (id: string) => api.get<PatientSummary>(`/consultations/${id}/patient-summary`),
  /** Transcribe audio and save as a consultation note.
   *  NOTE: DISABLED SERVER-SIDE — the backend route unconditionally returns
   *  422 `AI_IDENTIFIABLE_MEDIA_DISABLED` (AI processing of identifiable
   *  patient media is switched off). Callers must treat a 422 from this
   *  endpoint as "feature unavailable", not a transient error. */
  transcribe: (id: string, body: { audio: string; mimeType?: string; language?: string }) =>
    api.post<{ transcript: string; noteId: string }>(`/consultations/${id}/transcribe`, body),
  /** Append a note (with optional attachments) to a consultation. */
  addNote: (id: string, body: { content: string; type?: string; attachments?: unknown[] }) =>
    api.post<Record<string, unknown>>(`/consultations/${id}/notes`, body),
  /** Nurse / facility clinician asks for urgent doctor review: records an escalation note and pushes the doctor. */
  escalate: (id: string, reason: string) =>
    api.post<{ consultationId: string; notifiedAssignedDoctor: boolean }>(`/consultations/${id}/escalate`, { reason }),
  /** Append an addendum to a locked (completed) consultation. */
  addAddendum: (id: string, body: { content: string; attachments?: unknown[] }) =>
    api.post<Record<string, unknown>>(`/consultations/${id}/addendum`, body),
  /** Set the consultation type (outpatient or inpatient). */
  setConsultationType: (id: string, consultationType: 'outpatient' | 'inpatient') =>
    api.patch<Record<string, unknown>>(`/consultations/${id}/type`, { consultationType }),
  /** Add a late prescription to a completed consultation (doctor with prescribe permission). */
  latePrescribe: (id: string, body: { medications: unknown[]; instructions?: string; reason: string; pharmacyId?: string }) =>
    api.post<Prescription>(`/consultations/${id}/late-prescription`, body),
  /** Extract clinical entities from the consultation transcript. */
  extractEntities: (id: string) =>
    api.post<{ symptoms: string[]; diagnoses: string[]; medications: string[]; followUps: string[]; redFlags: string[] }>(`/consultations/${id}/extract-entities`),
  /** W2.3 — Doctor-ready packet projection (feature-flagged, dual-read). */
  getPacket: (id: string) => api.get<Record<string, unknown>>(`/consultations/${id}/packet`),
  recomputePacket: (id: string) => api.post<Record<string, unknown>>(`/consultations/${id}/packet/recompute`),
  getPacketStale: (id: string) => api.get<{ stale: boolean; enabled: boolean; episodeFound?: boolean }>(`/consultations/${id}/packet/stale`),
};

// ── Differential Diagnosis & Clinical AI Endpoints ─────────────────────────
export interface DifferentialDx {
  rank: number;
  diagnosis: string;
  icdCode?: string;
  probability: 'high' | 'moderate' | 'low';
  supportingEvidence?: string[];
  contradictingEvidence?: string[];
  keyDistinguishers?: string[];
  redFlags?: string[];
}

export interface ManagementPlan {
  forDiagnosis: string;
  investigations: Array<{ name: string; urgency: string; reason?: string }>;
  treatment: Array<{ intervention: string; details?: string; priority?: string }>;
  referrals?: Array<{ specialty: string; reason: string; urgency: string }>;
  followUp?: string;
  patientEducation?: string[];
}

export interface PhysicalExamSuggestion {
  examination: string;
  bodySystem?: string;
  technique?: string;
  lookingFor?: string;
  relevantTo?: string[];
  priority?: 'essential' | 'recommended' | 'if_indicated';
}

export interface DDxData {
  differentials: DifferentialDx[];
  managementPlans: ManagementPlan[];
  alerts: string[];
  overallAssessment: string;
  generatedAt?: string | null;
  suggestedPhysicalExams?: PhysicalExamSuggestion[];
}

export interface DoctorSummaryResult {
  patientDemographics?: unknown;
  vitals?: unknown;
  intakeSummary?: unknown;
  differentials: DifferentialDx[];
  managementPlans: ManagementPlan[];
  recentLabResults?: unknown[];
  alerts: string[];
  findings?: unknown[];
  suggestedPhysicalExams?: PhysicalExamSuggestion[];
  suggestedNote?: string;
  pointOfCareTests?: unknown[];
  generatedAt?: string | Date;
}

export const ddxApi = {
  get: (consultationId: string) => api.get<DDxData>(`/consultations/${consultationId}/ddx`),
  compute: (consultationId: string, trigger?: string) =>
    api.post<DDxData>(`/consultations/${consultationId}/ddx/compute`, { trigger }),
  addFinding: (
    consultationId: string,
    finding: { type: string; value: string; details?: string; severity?: string; negated?: boolean },
  ) => api.post<DDxData>(`/consultations/${consultationId}/findings`, finding),
  suggestExams: (consultationId: string) =>
    api.post<PhysicalExamSuggestion[]>(`/consultations/${consultationId}/ddx/pe-suggest`),
  getDoctorSummary: (consultationId: string) =>
    api.get<DoctorSummaryResult>(`/consultations/${consultationId}/doctor-summary`),
};

// ── Patient summary (doctor-facing prior-records view) ───────────────────────
export interface LongitudinalSynthesis {
  isReturningPatient: boolean;
  visitCount: number;
  lastVisitDate?: string | null;
  lastVisitSummary?: string | null;
  clinicalNarrative: string;
  activeFlags: string[];
  keyTrends: Array<{
    metric: string;
    latest: string;
    previous?: string | null;
    direction: 'up' | 'down' | 'stable' | 'single';
  }>;
}

export interface PatientSummary {
  patient: {
    patientId: string | null;
    name: string;
    age: number | null;
    dateOfBirth: string | null;
    gender: string | null;
    bloodType: string | null;
    phone: string | null;
    registered: boolean;
  };
  allergies: string[];
  chronicConditions: string[];
  currentMedications: Array<{ name: string; dosage?: string | null; frequency?: string | null; duration?: string | null } | string>;
  recentVitals: Array<{
    date: string | null;
    bloodPressure?: string | number | null;
    heartRate?: string | number | null;
    temperature?: string | number | null;
    spo2?: string | number | null;
    respiratoryRate?: string | number | null;
    weight?: string | number | null;
  }>;
  priorConsultations: Array<{ consultationId: string; date: string | null; chiefComplaint: string | null; diagnosis: string | null; type: string | null; status: string | null }>;
  activePrescriptions: Array<{ prescriptionId: string; date: string | null; status: string | null; instructions: string | null; medications: Array<{ name: string; dosage?: string | null; frequency?: string | null; duration?: string | null }> }>;
  recentLabResults: Array<{ labResultId: string; date: string | null; testName: string; status: string | null; summary: string | null }>;
  longitudinalSynthesis?: LongitudinalSynthesis | null;
}

// ── Chat uploads ────────────────────────────────────────────────────────────
export const chatUploadApi = {
  uploadToConsultation: (id: string, form: FormData) => api.request<{ attachments: unknown[] }>(`/chat-upload/consultation/${id}/upload`, { method: 'POST', form }),
  attachmentUrl: (consultationId: string, fileId: string) =>
    api.get<{ url: string }>(`/chat-upload/consultation-attachment/${consultationId}/${fileId}`),
};

// ── Video ───────────────────────────────────────────────────────────────────
export const videoApi = {
  iceServers: () => api.get<{ iceServers: unknown[] }>('/video/ice-servers'),
  room: (consultationId: string) => api.get<{ roomId: string }>(`/video/consultations/${consultationId}/room`),
  /** Create/get a video room + signaling token for a consultation. */
  videoToken: (consultationId: string) =>
    api.post<{ roomId: string; signalingToken: string; iceServers: unknown[]; signalingPath: string; participantsPath: string }>(`/video/consultations/${consultationId}/video-token`),
  /** SSE stream for receiving WebRTC signaling messages. */
  signalingStream: (consultationId: string) => `/video/consultations/${consultationId}/signaling`,
  /** POST a WebRTC signaling message (offer/answer/ICE candidate). */
  sendSignal: (consultationId: string, body: { type: string; data: unknown }) =>
    api.post(`/video/consultations/${consultationId}/signaling`, body),
  joinRoom: (roomId: string) => api.post(`/video/rooms/${roomId}/join`),
  leaveRoom: (roomId: string) => api.post(`/video/rooms/${roomId}/leave`),
  endRoom: (roomId: string) => api.post(`/video/rooms/${roomId}/end`),
  /** Notify the other participant that the caller switched to audio-only or back to video. */
  switchMode: (roomId: string, body: { mode: 'audio' | 'video'; userId: string }) =>
    api.post(`/video/rooms/${roomId}/switch-mode`, body),
  firebaseToken: () => api.post<{ token: string }>('/account/firebase-token'),
};

// ── Patient records ─────────────────────────────────────────────────────────
export interface PatientRadiologySummary {
  /** The identifier used by the patient detail route. Rows without one are not exposed. */
  resultId: string;
  orderId?: string;
  modality: string;
  bodyPart?: string;
  reportStatus: string;
  criticality?: string;
  facilityName?: string;
  findings?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  patientViewedAt?: unknown;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

/**
 * The self-results endpoint returns `resultId`/`modality`/`reportStatus`, while
 * the legacy dependent endpoint returns `orderId`/`studyType`/`status`. Keep
 * those endpoint differences at the client boundary and only render a row that
 * can actually navigate to a detail identifier. The dependent request still
 * carries its `dependentId` query parameter; this helper does not broaden scope.
 */
export function normalizePatientRadiologySummary(input: unknown): PatientRadiologySummary | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const resultId = firstString(raw.resultId, raw.id, raw.orderId);
  if (!resultId) return null;
  return {
    resultId,
    orderId: firstString(raw.orderId),
    // Prefer the canonical self fields, then map the dependent aliases.
    modality: firstString(raw.modality, raw.studyType, raw.type) ?? 'unknown',
    bodyPart: firstString(raw.bodyPart, raw.region),
    reportStatus: firstString(raw.reportStatus, raw.status) ?? 'pending',
    criticality: firstString(raw.criticality),
    facilityName: firstString(raw.facilityName, raw.radiologyCenterName, raw.laboratoryName),
    findings: firstString(raw.findings, raw.reportSummary, raw.summary),
    createdAt: raw.createdAt ?? raw.date,
    updatedAt: raw.updatedAt,
    patientViewedAt: raw.patientViewedAt,
  };
}

export const patientsApi = {
  profile: () => api.get<User>('/patients/profile'),
  identifiers: () => api.get<{
    patientId: string;
    patientMasterId: string;
    globalMrn: string;
    identifiers: Array<{ identifier: string; scopeType: string; scopeId: string }>;
  }>('/patients/identifiers/me'),
  updateProfile: (body: Record<string, unknown>) => api.put<User>('/patients/profile', body),
  medicalRecords: (dependentId?: string) => api.get<unknown[]>('/patients/medical-records', { dependentId }),
  prescriptions: (dependentId?: string) => api.get<Prescription[]>('/patients/prescriptions', { dependentId }),
  prescription: (prescriptionId: string) =>
    api.get<Prescription>(`/patients/prescriptions/${prescriptionId}`),
  labResults: (dependentId?: string) => api.get<unknown[]>('/patients/lab-results', { dependentId }),
  vitals: (dependentId?: string) => api.get<unknown[]>('/patients/vitals', { dependentId }),
  selfVitals: (body: Record<string, unknown>) => api.post('/patients/vitals/self', body),
  radiologyResults: async (dependentId?: string): Promise<PatientRadiologySummary[]> => {
    // Keep the dependentId query parameter on the legacy path: the backend
    // authorizes the managing patient before applying the dependent scope.
    const raw = dependentId
      ? await api.get<unknown[]>('/patients/radiology-results', { dependentId })
      : await api.get<unknown[]>('/radiology/patient/my-results');
    return (Array.isArray(raw) ? raw : [])
      .map(normalizePatientRadiologySummary)
      .filter((row): row is PatientRadiologySummary => row !== null);
  },
  radiologyResult: (resultId: string) =>
    api.get<Record<string, unknown>>(`/radiology/patient/my-results/${encodeURIComponent(resultId)}`),
  recordVitals: (body: Record<string, unknown>) => api.post('/patients/vitals', body),
  guardianInvite: (guardianEmail: string, relationship?: string) =>
    api.post<Record<string, unknown>>('/patients/guardian', { guardianEmail, relationship }),
  guardianAccept: (inviteId?: string) =>
    api.post<Record<string, unknown>>('/patients/guardian/accept', { inviteId }),
  /**
   * Set / change the patient's affiliated facility for a given category
   * (e.g. hospital, clinic, pharmacy, laboratory). Pass `facilityId:null` to
   * clear the affiliation. Backend: PUT /patients/facility-affiliations.
   */
  setFacilityAffiliation: (body: { category: string; facilityId: string | null }) =>
    api.put<Record<string, unknown>>('/patients/facility-affiliations', body),
  /**
   * (Re)route a not-yet-dispensed prescription to a chosen pharmacy. Online-only
   * action. Backend: POST /patients/prescriptions/:prescriptionId/route.
   */
  routePrescription: (prescriptionId: string, pharmacyId: string) =>
    api.post<Record<string, unknown>>(`/patients/prescriptions/${prescriptionId}/route`, { pharmacyId }),
  /** Issue an opaque, short-lived prescription authenticity presentation token. */
  verifyToken: (prescriptionId: string) =>
    api.post<IssuedPresentationToken>(
      `/barcodes/prescriptions/${encodeURIComponent(prescriptionId)}/verification-token`,
    ),
  /** Request a refill for an existing dispensed/active prescription. */
  requestRefill: (prescriptionId: string, note?: string) =>
    api.post<Record<string, unknown>>(`/patients/prescriptions/${prescriptionId}/refill-request`, { note }),
  /** List the patient's refill requests. */
  refillRequests: () => api.get<Record<string, unknown>[]>('/patients/refill-requests'),
  /** Cancel a pending refill request. */
  cancelRefillRequest: (requestId: string) =>
    api.post(`/patients/refill-requests/${requestId}/cancel`),
  /** Verify NIN via Smile ID / NIMC. */
  verifyNin: (nin: string) =>
    api.post<Record<string, unknown>>('/identity/verify-nin', { nin }),
  /** Verify an ID document (driver's license, voter's card, passport). */
  verifyIdDocument: (idType: string, idNumber: string) =>
    api.post<Record<string, unknown>>('/identity/verify-id-document', { idType, idNumber }),
  /** Get identity verification status. */
  identityStatus: () =>
    api.get<{ identityVerified: boolean; method?: string; verifiedAt?: string }>('/identity/status'),
  /** Get 3-tier identity verification status. */
  verificationStatus: () =>
    api.get<PatientVerificationStatus>('/patients/verification-status'),
  /** Check if the patient is currently admitted (inpatient). */
  getAdmissionStatus: () =>
    api.get<PatientAdmissionStatus>('/patients/admission-status'),
  /** Get full admission details for an admitted patient. */
  admissionDetails: (admissionId?: string) =>
    api.get<PatientAdmissionDetails>('/patients/admission-details', { admissionId }),
};

// ── Admission nurse calls ───────────────────────────────────────────────────
export const nurseCallApi = {
  createPatient: (
    admissionId: string,
    body: { reason: NurseCallReason; urgency: NurseCallUrgency },
    idempotencyKey = newIdempotencyKey('nurse-call'),
  ) => api.post<NurseCall>(
    `/patients/admissions/${encodeURIComponent(admissionId)}/nurse-calls`,
    body,
    { idempotencyKey },
  ),
  patientStatus: (admissionId: string) =>
    api.get<PatientNurseCallResponse>(`/patients/admissions/${encodeURIComponent(admissionId)}/nurse-calls`),
  staffList: (facilityId: string) =>
    api.get<StaffNurseCall[]>(`/nurse-calls/${encodeURIComponent(facilityId)}`),
  staffDetail: (facilityId: string, nurseCallId: string) =>
    api.get<{ nurseCall: NurseCall; admission: StaffNurseCall['admission'] }>(
      `/nurse-calls/${encodeURIComponent(facilityId)}/${encodeURIComponent(nurseCallId)}`,
    ),
  acknowledge: (facilityId: string, nurseCallId: string) =>
    api.post<NurseCall>(`/nurse-calls/${encodeURIComponent(facilityId)}/${encodeURIComponent(nurseCallId)}/acknowledge`),
  resolve: (facilityId: string, nurseCallId: string, resolutionCode: NurseCallResolutionCode) =>
    api.post<NurseCall>(
      `/nurse-calls/${encodeURIComponent(facilityId)}/${encodeURIComponent(nurseCallId)}/resolve`,
      { resolutionCode },
    ),
};

// ── Opaque clinical presentation barcodes ──────────────────────────────────
export type PresentationTokenPurpose =
  | 'patient_presentation'
  | 'patient_wristband'
  | 'specimen_label'
  | 'prescription_verification';

export interface IssuedPresentationToken {
  token: string;
  purpose: PresentationTokenPurpose;
  expiresAt: string;
  barcodeValue?: string;
  expiresInSeconds?: number;
  verificationUrl?: string;
}

export interface PatientBarcodeResolution {
  patientId: string;
  displayName: string;
  dateOfBirth: string | null;
  globalMrn: string | null;
  verificationTier: string | number | null;
  replayed: boolean;
}

export interface WristbandBarcodeResolution extends PatientBarcodeResolution {
  admissionId: string;
  admissionNumber: string | null;
}

export interface SpecimenBarcodeResolution extends PatientBarcodeResolution {
  specimenId: string;
  specimenNumber: string | null;
  orderId: string;
  labRequestNumber: string | null;
}

export interface PrescriptionAuthenticity {
  valid: boolean;
  replayed: boolean;
  reason?: 'expired' | 'revoked' | 'invalid' | 'wrong_purpose' | 'not_found' | 'terminal';
  prescription?: {
    prescriptionNumber: string | null;
    status: string;
    issuedAt: string | null;
    prescriber: string | null;
    controlledMedication: boolean;
    medications: Array<{
      name: string;
      dosage: string | null;
      frequency: string | null;
      duration: string | null;
      route: string | null;
    }>;
  };
}

export const barcodeApi = {
  issuePatientPresentation: () =>
    api.post<IssuedPresentationToken>('/barcodes/patients/me/presentation'),
  resolvePatient: (token: string) =>
    api.post<PatientBarcodeResolution>('/barcodes/patients/resolve', { token }),
  resolveWristband: (token: string) =>
    api.post<WristbandBarcodeResolution>('/barcodes/wristbands/resolve', { token }),
  resolveSpecimen: (token: string) =>
    api.post<SpecimenBarcodeResolution>('/barcodes/specimens/resolve', { token }),
  verifyPrescription: (token: string) =>
    api.post<PrescriptionAuthenticity>(
      '/barcodes/public/prescriptions/verify',
      { token },
      { auth: false },
    ),
  revokePrescriptionPresentation: (prescriptionId: string) =>
    api.post<{ revoked: number }>(
      `/barcodes/prescriptions/${encodeURIComponent(prescriptionId)}/verification/revoke`,
    ),
};

// ── Patient lab ─────────────────────────────────────────────────────────────
// Test items in catalog
export interface CatalogLabTest {
  testId: string;
  name: string;
  code?: string;
  category?: string;
  sampleType?: string;
  price?: number;
  turnaroundHours?: number;
  requiresDoctorAssessment?: boolean;
  description?: string;
  preparationInstructions?: string;
}

export const patientLabApi = {
  labs: () => api.get<unknown[]>('/patient-lab/labs'),
  tests: (params?: { labId?: string; category?: string; search?: string }) => api.get<CatalogLabTest[]>('/patient-lab/tests', params),
  categories: () => api.get<unknown[]>('/patient-lab/categories'),
  book: (body: Record<string, unknown>) => api.post('/patient-lab/book', body),
  myOrders: () => api.get<unknown[]>('/patient-lab/my-orders'),
  cancelOrder: (orderId: string) => api.patch(`/patient-lab/my-orders/${orderId}/cancel`),
  myResults: (dependentId?: string) => api.get<unknown[]>('/patient-lab/my-results', { dependentId }),
  myResult: (resultIdOrOrderId: string) =>
    api.get<Record<string, unknown>>(`/patient-lab/my-results/${encodeURIComponent(resultIdOrOrderId)}`),
};

// ── Catalog typeahead (medications + lab tests) ─────────────────────────────
export interface DrugSuggestion {
  name: string;
  genericName?: string;
  category?: string;
  form?: string;
  commonDosages: string[];
  commonFrequencies: string[];
  standardDuration?: string;
  notes?: string;
}
export interface LabTestSuggestion {
  name: string;
  category: string;
  code?: string;
  specimen?: string;
}
export const catalogApi = {
  /** Medication typeahead — up to 10 matches with common dosages/frequencies. */
  drugs: (q: string) => api.get<DrugSuggestion[]>('/catalog/drugs', { q }),
  /** Lab-test typeahead — up to 10 matches with category/code/specimen. */
  labTests: (q: string) => api.get<LabTestSuggestion[]>('/catalog/lab-tests', { q }),
};

// ── Wallet ──────────────────────────────────────────────────────────────────
export const walletApi = {
  get: () => api.get<WalletState & { hasPin?: boolean }>('/wallet'),
  fund: (amount: number) => api.post<{ authorizationUrl: string; txRef: string }>('/wallet/fund', { amount }),
  verify: (txRef: string) => api.get<{ status: string; balance?: number }>(`/wallet/verify/${txRef}`),
  transactions: () => api.get<WalletTransaction[]>('/wallet/transactions'),
  /** Pay from wallet — debits for a service (e.g. prescription delivery). Requires transaction PIN. */
  pay: (amount: number, purpose: string, referenceId?: string, referenceType?: string, pin?: string) =>
    api.post<{ transactionId: string; newBalance: number; amount: number; currency: string }>('/wallet/pay', {
      amount,
      purpose,
      referenceId,
      referenceType,
      pin,
    }),
  setPin: (pin: string, currentPin?: string) =>
    api.post<{ message: string }>('/wallet/set-pin', { pin, currentPin }),
  verifyPin: (pin: string) =>
    api.post<{ valid: boolean }>('/wallet/verify-pin', { pin }),
};

// ── RPM ─────────────────────────────────────────────────────────────────────
export const rpmApi = {
  programs: () => api.get<RpmProgram[]>('/rpm/programs'),
  program: (id: string) => api.get<RpmProgram>(`/rpm/programs/${id}`),
  enrollments: () => api.get<RpmEnrollment[]>('/rpm/enrollments'),
  enrollment: (id: string) => api.get<RpmEnrollment>(`/rpm/enrollments/${id}`),
  readings: (enrollmentId: string) => api.get<RpmReading[]>(`/rpm/enrollments/${enrollmentId}/readings`),
  addReading: (enrollmentId: string, body: Record<string, unknown>) => api.post<RpmReading>(`/rpm/enrollments/${enrollmentId}/readings`, body),
  trends: (enrollmentId: string) => api.get<Record<string, unknown>>(`/rpm/enrollments/${enrollmentId}/trends`),
  alerts: () => api.get<RpmAlert[]>('/rpm/alerts'),
  alert: (id: string) => api.get<RpmAlert>(`/rpm/alerts/${id}`),
  acknowledgeAlert: (id: string) => api.patch(`/rpm/alerts/${id}/acknowledge`),
  resolveAlert: (id: string) => api.patch(`/rpm/alerts/${id}/resolve`),
  createEnrollment: (body: Record<string, unknown>) => api.post<RpmEnrollment>('/rpm/enrollments', body),
};

// ── Facilities (public + patient submit / check-in) ──────────────────────────
export const facilitiesApi = {
  /** Public nearby search (no auth). */
  nearby: (query: { lat: number; lng: number; radius?: number; limit?: number; type?: string }) =>
    api.get<{ facilities: NearbyFacility[]; count: number; origin: unknown; radiusKm: number }>('/facilities/nearby', query, { auth: false }),
  /** Patient submits a new facility to the directory (authenticated). */
  submit: (body: {
    name: string;
    type: 'pharmacy' | 'laboratory';
    address: { street?: string; city?: string; state?: string; country?: string };
    phone?: string;
    notes?: string;
  }) => api.post<Record<string, unknown>>('/facilities/submit', body),
  /** Create a check-in at a facility (authenticated). */
  checkIn: (
    facilityId: string,
    body: { visitType: string; prescriptionId?: string; notes?: string },
  ) => api.post<{ checkInId: string; status: string }>(`/facilities/${facilityId}/checkin`, body),
  /** Confirm a completed visit for a check-in (authenticated). */
  confirmCheckIn: (facilityId: string, checkInId: string) =>
    api.post<Record<string, unknown>>(`/facilities/${facilityId}/checkin/${checkInId}/confirm`),
  /** Claim a facility token for the patient (authenticated). */
  claimToken: (facilityId: string) => api.post<{ token: string }>(`/facilities/${facilityId}/claim-token`),
  /** Verify a claim token (public, no auth). */
  verifyClaimToken: (token: string) =>
    api.get<{ valid: boolean; facilityId?: string; facilityName?: string }>(
      `/facilities/claim/${token}/verify`,
      undefined,
      { auth: false },
    ),
};

// ── Notifications ───────────────────────────────────────────────────────────
export const notificationsApi = {
  /**
   * `platform`/`bundleId` are REQUIRED for iOS to work: the backend routes
   * platform==='ios' tokens to the direct APNs sender and uses bundleId as the
   * apns-topic. Omitting them files a raw APNs token as an FCM token, which can
   * never be delivered. (`push/register.ts` is the normal caller and always
   * sends them; these params keep any other caller correct.)
   */
  registerToken: (token: string, platform?: string, bundleId?: string) =>
    api.post('/notifications/token', {
      token,
      ...(platform ? { platform } : {}),
      ...(bundleId ? { bundleId } : {}),
    }),
  deleteToken: (token: string) => api.del('/notifications/token', { token }),
  /** Self-serve push delivery check — pushes to this account's own devices. */
  testPush: () => api.post<Record<string, unknown>>('/notifications/test-push', {}),
  list: (limit?: number) => api.get<AppNotification[]>('/notifications', { limit }),
  unreadCount: () => api.get<{ count: number }>('/notifications/unread-count'),
  markRead: (id: string) => api.patch<AppNotification>(`/notifications/${encodeURIComponent(id)}/read`),
  markAllRead: () => api.patch<{ marked: number; unreadCount: number }>('/notifications/read-all'),
  preferences: () => api.get<Record<string, unknown>>('/notifications/preferences'),
  updatePreferences: (body: Record<string, unknown>) => api.put('/notifications/preferences', body),
};

/**
 * Record a notification view durably. Network/5xx failures are queued under a
 * stable key and retried across restarts; ownership/authentication failures are
 * surfaced because falsely showing those records as read would hide a defect.
 */
export async function markNotificationReadDurably(
  notificationId: string,
): Promise<'persisted' | 'queued'> {
  if (!notificationId) throw new Error('Notification ID is required');
  try {
    await notificationsApi.markRead(notificationId);
    return 'persisted';
  } catch (error) {
    if (
      error instanceof ApiError
      && error.status >= 400
      && error.status < 500
      && error.status !== 408
      && error.status !== 429
    ) {
      throw error;
    }
    await syncQueue.enqueue({
      type: 'notification_read',
      method: 'PATCH',
      endpoint: `/notifications/${encodeURIComponent(notificationId)}/read`,
      prefix: 'notification-read',
      idempotencyKey: `notification-read:${notificationId}`,
      label: 'Notification read receipt',
    });
    return 'queued';
  }
}

// ── WhatsApp link ───────────────────────────────────────────────────────────
export const whatsappApi = {
  status: () => api.get<{ linked: boolean; phone?: string }>('/whatsapp/link/status'),
  /** Send an OTP to the given WhatsApp number (E.164, e.g. +2348030000000). */
  request: (phone: string) => api.post('/whatsapp/link/request', { phone }),
  /** Confirm the OTP for the number it was requested for. Backend expects `{ phone, code, consentAck }`. */
  confirm: (phone: string, otp: string, consentAck: boolean) =>
    api.post('/whatsapp/link/confirm', { phone, code: otp, consentAck }),
  unlink: () => api.del('/whatsapp/link'),
};

// ── Consent Requests ────────────────────────────────────────────────────────
export interface ConsentRequest {
  requestId: string;
  patientId: string;
  facilityId: string;
  facilityName?: string;
  requestedBy?: string;
  requestedByName?: string;
  requestedAt?: string;
  status: 'pending' | 'approved' | 'rejected';
  expirationDate?: string;
  respondedAt?: string;
  dataScope?: string[];
}

export const consentApi = {
  /** GET /consent/requests — patient sees incoming consent requests */
  getRequests: () => api.get<ConsentRequest[]>('/consent/requests'),
  /** POST /consent/respond — approve or reject a consent request */
  respond: (requestId: string, action: 'approve' | 'reject') =>
    api.post('/consent/respond', { requestId, action }),
};

// ── Account ─────────────────────────────────────────────────────────────────
export const accountApi = {
  requestDeletion: (body: {
    currentPassword: string;
    confirmation: 'CLOSE';
    reasonCategory?: string;
  }) => api.post<AccountClosureCase>('/account/deletion-request', body, {
    headers: { 'X-Docarion-Client': 'patient-mobile' },
  }),
  getDeletion: () => api.get<AccountClosureCase | null>('/account/deletion-request'),
  getDeletionHistory: () =>
    api.get<AccountClosureHistoryEvent[]>('/account/deletion-request/history'),
  getDeletionHolds: () =>
    api.get<AccountClosureCareHold[]>('/account/deletion-request/holds'),
  getDeletionReceipt: () =>
    api.get<AccountClosureReceipt>('/account/deletion-request/receipt'),
  cancelDeletion: () => api.del('/account/deletion-request'),
  firebaseToken: () => api.post<{ token: string }>('/account/firebase-token'),
  // Local data export ("pack up my data") — the full patient record envelope.
  export: () => api.get<Record<string, unknown>>('/account/export'),
  /** Upload a profile picture URI to Firebase Storage and update photoURL. */
  uploadAvatar: (uri: string) => {
    const form = new FormData();
    form.append('avatar', { uri, name: 'avatar.jpg', type: 'image/jpeg' } as unknown as Blob);
    return api.request<{ photoURL: string }>('/account/avatar', { method: 'POST', form });
  },
};

// ── Post-closure privacy rights (public, purpose-bound session) ─────────────
// The rights token is supplied by the caller and is intentionally not stored
// by core. A privacy-rights session cannot authenticate to the application.
export const postClosureRightsApi = {
  initiate: (email: string) =>
    api.post<{ requestId: string; message: string }>(
      '/privacy/rights/initiate',
      { email },
      { auth: false, noRefresh: true },
    ),
  verify: (requestId: string, code: string) =>
    api.post<PostClosureRightsSession>(
      '/privacy/rights/verify',
      { requestId, code },
      { auth: false, noRefresh: true },
    ),
  getClosureStatus: (sessionToken: string) =>
    api.get<PublicClosureStatus>(
      '/privacy/rights/closure-status',
      undefined,
      {
        auth: false,
        noRefresh: true,
        headers: { 'X-Rights-Session': sessionToken },
      },
    ),
  listCases: (sessionToken: string) =>
    api.get<PostClosureRightsCase[]>(
      '/privacy/rights/cases',
      undefined,
      {
        auth: false,
        noRefresh: true,
        headers: { 'X-Rights-Session': sessionToken },
      },
    ),
  createCase: (
    sessionToken: string,
    input: {
      rightType: PostClosureRightType;
      details?: string;
      deliveryFormat?: 'json' | 'pdf' | 'fhir';
    },
    idempotencyKey = newIdempotencyKey('post-closure-right'),
  ) =>
    api.post<PostClosureRightsCase>(
      '/privacy/rights/cases',
      input,
      {
        auth: false,
        noRefresh: true,
        headers: { 'X-Rights-Session': sessionToken },
        idempotencyKey,
      },
    ),
  getReceipt: (sessionToken: string) =>
    api.get<PublicClosureReceiptArtifact>(
      '/privacy/rights/receipt',
      undefined,
      {
        auth: false,
        noRefresh: true,
        headers: { 'X-Rights-Session': sessionToken },
      },
    ),
  accessReceipt: (caseId: string, token: string) =>
    api.post<PublicClosureReceiptArtifact>(
      '/privacy/rights/receipt/access',
      { caseId, token },
      { auth: false, noRefresh: true },
    ),
  endSession: (sessionToken: string) =>
    api.del<void>(
      '/privacy/rights/session',
      undefined,
      {
        auth: false,
        noRefresh: true,
        headers: { 'X-Rights-Session': sessionToken },
      },
    ),
};

// ── Patient documents (scanner uploads) ──────────────────────────────────────
export interface ScannedDocument {
  documentId: string;
  type: string;
  title: string;
  fileUrl?: string;
  thumbnailUrl?: string;
  uploadedAt: string;
  status?: string;
  fileSize?: number;
  mimeType?: string;
  [key: string]: unknown;
}

export const documentsApi = {
  /** List the patient's uploaded documents. */
  list: () => api.get<ScannedDocument[]>('/patients/documents'),
  /** Upload a scanned document (image URI → multipart). */
  upload: (uri: string, body: { type: string; title: string; consultationId?: string }, mimeType = 'image/jpeg') => {
    const form = new FormData();
    form.append('document', {
      uri,
      name: `document.${mimeType === 'image/png' ? 'png' : 'jpg'}`,
      type: mimeType,
    } as unknown as Blob);
    form.append('type', body.type);
    form.append('title', body.title);
    if (body.consultationId) form.append('consultationId', body.consultationId);
    return api.request<ScannedDocument>('/patients/documents', { method: 'POST', form });
  },
  /** Delete a scanned document. */
  remove: (documentId: string) => api.del(`/patients/documents/${documentId}`),
};

// ── Doctor ──────────────────────────────────────────────────────────────────
export const doctorApi = {
  myConsultations: (query?: { status?: string; facilityId?: string }) => api.get<Consultation[]>('/doctors/me/consultations', query),
  brief: (consultationId: string) => api.get<Record<string, unknown>>(`/ai-intake/${consultationId}/brief`),
  analytics: () => api.get<DoctorAnalytics>('/analytics/doctors/me'),
  earnings: () => api.get<Record<string, unknown>>('/doctors/me/earnings'),
  schedule: () => api.get<Record<string, unknown>>('/doctors/me/schedule'),
  availability: () => api.get<Record<string, unknown>>('/doctors/me/availability'),
  // clinical docs
  soapNote: (consultationId: string) => api.post<{ note: unknown }>(`/clinical-docs/consultations/${consultationId}/soap-note`),
  dischargeSummary: (consultationId: string) => api.post(`/clinical-docs/consultations/${consultationId}/discharge-summary`),
  referralLetter: (consultationId: string, body: { specialty: string; reason: string }) =>
    api.post(`/clinical-docs/consultations/${consultationId}/referral-letter`, body),
  medicalCertificate: (consultationId: string, body: { type: 'sick_leave' | 'fitness_to_work' | 'medical_report'; details: Record<string, unknown> }) =>
    api.post(`/clinical-docs/consultations/${consultationId}/medical-certificate`, body),
  updateClinicalNote: (consultationId: string, noteId: string, body: { content: string; finalized?: boolean }) =>
    api.patch(`/clinical-docs/consultations/${consultationId}/clinical-notes/${noteId}`, body),
};

// ── Nurse ───────────────────────────────────────────────────────────────────
export const nurseApi = {
  walkIns: () => api.get<WalkIn[]>('/ai-intake/walk-ins'),
  /** Admission vitals — idempotent (offline-capable). Pass an idempotencyKey for retry stability. */
  admissionVitals: (
    hospitalId: string,
    admissionId: string,
    body: Record<string, unknown>,
    idempotencyKey = newIdempotencyKey('vitals'),
  ) =>
    api.post(`/hospitals/${hospitalId}/admissions/${admissionId}/vitals`, { ...body, idempotencyKey }, { idempotencyKey }),
  getAdmissionVitals: (hospitalId: string, admissionId: string) =>
    api.get<unknown[]>(`/hospitals/${hospitalId}/admissions/${admissionId}/vitals`),
};

// ── Pharmacist ──────────────────────────────────────────────────────────────
export const pharmacyApi = {
  /** Dispense — idempotent. Controlled meds require otpCode (server → {requiresOtp:true}). */
  dispense: (
    prescriptionId: string,
    body: Record<string, unknown>,
    idempotencyKey = newIdempotencyKey('dispense'),
  ) => api.post<{ requiresOtp?: boolean } & Record<string, unknown>>(`/pharmacies/prescriptions/${prescriptionId}/dispense`, { ...body, idempotencyKey }, { idempotencyKey }),
  partialDispense: (prescriptionId: string, body: Record<string, unknown>, idempotencyKey = newIdempotencyKey('dispense')) =>
    api.post(`/pharmacies/prescriptions/${prescriptionId}/partial-dispense`, { ...body, idempotencyKey }, { idempotencyKey }),
  inventory: (pharmacyId: string, query?: Record<string, string | undefined>) => api.get<InventoryItem[]>(`/pharmacies/${pharmacyId}/inventory`, query),
  lowStock: (pharmacyId: string) => api.get<InventoryItem[]>(`/pharmacies/${pharmacyId}/inventory/low-stock`),
  expiring: (pharmacyId: string) => api.get<InventoryItem[]>(`/pharmacies/${pharmacyId}/inventory/expiring`),
  adjustInventory: (pharmacyId: string, itemId: string, body: Record<string, unknown>) =>
    api.post(`/pharmacies/${pharmacyId}/inventory/${itemId}/adjust`, body),
  barcodeLookup: (pharmacyId: string, barcode: string) => api.get<InventoryItem>(`/pharmacies/${pharmacyId}/inventory/barcode/${encodeURIComponent(barcode)}`),
  verifyBarcode: (pharmacyId: string, body: { barcode: string; prescriptionId: string }) =>
    api.post(`/pharmacies/${pharmacyId}/dispense/verify-barcode`, body),
  /** Verify a patient's prescription QR card (pharmacist scans QR). */
  verifyQr: (signedToken: string) =>
    api.post<{ valid: boolean; prescription: Record<string, unknown>; alreadyDispensed: boolean }>('/pharmacies/prescriptions/verify-qr', { signedToken }),
  /**
   * Cancel a prescription (doctor-visible action). Sets status to 'cancelled'.
   * Backend: PATCH /pharmacies/prescriptions/:prescriptionId/cancel — the
   * prescribing doctor or an admin may cancel a not-yet-dispensed prescription.
   */
  cancelPrescription: (prescriptionId: string, reason: string) =>
    api.patch(`/pharmacies/prescriptions/${prescriptionId}/cancel`, { reason }),
  /**
   * Modify a pending prescription's medication details (dosage, frequency,
   * duration, notes) or instructions. Doctor-visible action.
   * Backend: PATCH /pharmacies/prescriptions/:prescriptionId/modify — the
   * prescribing doctor may modify a not-yet-dispensed prescription.
   */
  modifyPrescription: (prescriptionId: string, body: Record<string, unknown>) =>
    api.patch(`/pharmacies/prescriptions/${prescriptionId}/modify`, body),
  /** Verify a patient's physical ID in person (staff action). */
  verifyPhysicalId: (patientId: string, body: { idType: string; idNumber: string; notes?: string }) =>
    api.post<{ success: boolean; message?: string; verificationTier?: number }>(`/pharmacies/patients/${patientId}/verify-physical-id`, body),
};

// ── Delivery ────────────────────────────────────────────────────────────────
export const deliveryApi = {
  // Patient self-service
  request: (body: {
    prescriptionId?: string;
    pharmacyId: string;
    deliveryAddress: Record<string, unknown>;
    contactPhone?: string;
    specialInstructions?: string;
    preferredTimeSlot?: string;
  }) => api.post<{ deliveryId: string; status: string; estimatedFee: number; currency: string; pharmacyName?: string }>('/deliveries/patient-request', body),
  myDeliveries: () => api.get<Delivery[]>('/deliveries/patient/my-deliveries'),
  get: (deliveryId: string) => api.get<Delivery>(`/deliveries/${deliveryId}`),
  track: (deliveryId: string) => api.get<{ status: string; trackingHistory: unknown[]; currentLocation?: unknown }>(`/deliveries/${deliveryId}/track`),
  rate: (deliveryId: string, body: { rating: number; comment?: string }) => api.post(`/deliveries/${deliveryId}/rate`, body),

  // Delivery agent (Docarion Pro)
  assigned: () => api.get<Delivery[]>('/deliveries/agent/assigned'),
  mine: () => api.get<Delivery[]>('/deliveries/me'),
  updateStatus: (deliveryId: string, body: { status: string; location?: unknown; notes?: string }) =>
    api.patch(`/deliveries/${deliveryId}/status`, body),
  updateLocation: (deliveryId: string, body: { lat: number; lng: number }) =>
    api.patch(`/deliveries/${deliveryId}/location`, body),
  confirm: (deliveryId: string, body: { otp?: string; notes?: string; signature?: string }) =>
    api.post(`/deliveries/${deliveryId}/confirm`, body),
  setAvailability: (online: boolean) => api.patch<{ online: boolean }>('/deliveries/agents/me/availability', { online }),
};

// ── Invite rewards ──────────────────────────────────────────────────────────
export const inviteApi = {
  mine: () => api.get<InviteInfo>('/invites/mine'),
  redeem: (code: string) => api.post<{ redemptionId: string; rewardAmount: number; currency: string }>('/invites/redeem', { code }),
  redemption: () => api.get<Record<string, unknown> | null>('/invites/redemption'),
};

// ── Family (dependent sub-profiles) ─────────────────────────────────────────
export const familyApi = {
  list: () => api.get<FamilyMember[]>('/family/members'),
  get: (memberId: string) => api.get<FamilyMember>(`/family/members/${memberId}`),
  add: (body: {
    relationship: 'child' | 'spouse' | 'parent' | 'sibling' | 'other';
    profile: { firstName: string; lastName: string; dateOfBirth: string; gender: string; bloodType?: string };
  }) => api.post<FamilyMember>('/family/members', body),
  update: (memberId: string, body: Record<string, unknown>) => api.put(`/family/members/${memberId}`, body),
  remove: (memberId: string) => api.del(`/family/members/${memberId}`),
  graduate: (memberId: string, body?: { email?: string; password?: string }) =>
    api.post<{ newUserId: string; email: string; temporaryPassword?: string; status: string }>(`/family/members/${memberId}/graduate`, body ?? {}),
  undoGraduation: (memberId: string) =>
    api.post<{ memberId: string; status: string; recordsReclaimed: number }>(`/family/members/${memberId}/undo-graduation`),
  /** CAREGIVER_DELEGATION_V2 — assign caregiver with legal-authority consent. */
  assignCaregiver: (memberId: string, body: {
    caregiverUserId?: string;
    caregiverEmail?: string;
    legalAuthorityConfirmed: true;
    reason?: string;
  }) => api.post(`/family/members/${memberId}/assign-caregiver`, body),
  switchProfile: (memberId: string) => api.post(`/family/members/${memberId}/switch`),
  switchToSelf: () => api.post('/family/members/switch-self'),
};

// ── Care mode (inpatient / outpatient module switch) ─────────────────────────
export const careModeApi = {
  /** What care modes the user's facility supports + the user's effective modes. */
  getCapabilities: () => api.get<CareCapabilities>('/me/care-capabilities'),
  /** Persist the user's care-mode preference; returns the refreshed capabilities. */
  setMode: (preference: CarePreference) => api.put<CareCapabilities>('/me/care-mode', { preference }),
};

// ── Inpatient (rounds + hospital bedside) ────────────────────────────────────
// hospitalId is always the logged-in user's facilityId. NOTE the MAR endpoints
// deliberately have NO :hospitalId segment (per the backend contract).
export const inpatientApi = {
  /** Rounds list — the caller's inpatients (hospital admissions + care-home residents). */
  myPatients: (query?: { wardId?: string; status?: string; limit?: number }) =>
    api.get<InpatientPatient[]>('/inpatient/my-patients', { status: 'active', limit: 50, ...query }),
  /** Admit a patient from mobile (doctor/hospital_admin). */
  createAdmission: (hospitalId: string, body: { patientId?: string; patientName?: string; primaryDiagnosis: string; wardId?: string; bedId?: string; admissionType?: string; attendingDoctorId?: string }) =>
    api.post<Admission>(`/hospitals/${hospitalId}/admissions`, body),
  admission: (hospitalId: string, admissionId: string) =>
    api.get<Admission>(`/hospitals/${hospitalId}/admissions/${admissionId}`),
  timeline: (hospitalId: string, admissionId: string) =>
    api.get<TimelineItem[]>(`/hospitals/${hospitalId}/admissions/${admissionId}/timeline`),
  getVitals: (hospitalId: string, admissionId: string) =>
    api.get<AdmissionVital[]>(`/hospitals/${hospitalId}/admissions/${admissionId}/vitals`),
  /** Record vitals — idempotent (offline-capable). Pass an idempotencyKey for retry stability. */
  recordVitals: (
    hospitalId: string,
    admissionId: string,
    body: Record<string, unknown>,
    idempotencyKey = newIdempotencyKey('vitals'),
  ) =>
    api.post(`/hospitals/${hospitalId}/admissions/${admissionId}/vitals`, { ...body, idempotencyKey }, { idempotencyKey }),
  notes: (hospitalId: string, admissionId: string) =>
    api.get<AdmissionNote[]>(`/hospitals/${hospitalId}/admissions/${admissionId}/notes`),
  addNote: (hospitalId: string, admissionId: string, content: string) =>
    api.post<AdmissionNote>(`/hospitals/${hospitalId}/admissions/${admissionId}/notes`, { content }),
  discharge: (
    hospitalId: string,
    admissionId: string,
    body: { summary?: string; notes?: string; followUpInstructions?: string },
  ) => api.patch(`/hospitals/${hospitalId}/admissions/${admissionId}/discharge`, body),
  // MAR — NO :hospitalId segment.
  medications: (admissionId: string) => api.get<MarMedication[]>(`/hospitals/admissions/${admissionId}/medications`),
  /** Prescribe an inpatient medication (doctor). */
  prescribeMed: (
    admissionId: string,
    body: {
      drugName: string;
      dosage: string;
      route: string;
      frequency: string;
      gtin: string;
      scheduledTimes?: string[];
      timingWindowMinutes?: number;
      notes?: string;
    },
  ) => api.post<MarMedication>(`/hospitals/admissions/${admissionId}/medications`, body),
  startPpid: (admissionId: string, administrationId: string, wristbandToken: string) =>
    api.post<PpidStartResult>(
      `/hospitals/admissions/${admissionId}/medications/${administrationId}/ppid/start`,
      { wristbandToken },
    ),
  verifyPpid: (
    admissionId: string,
    administrationId: string,
    body: {
      sessionToken: string;
      drugBarcode: string;
      nameConfirmed: boolean;
      dateOfBirthConfirmed: boolean;
      observedDose: string;
      observedRoute: string;
      scheduledFor: string;
    },
  ) => api.post<PpidVerificationResult>(
    `/hospitals/admissions/${admissionId}/medications/${administrationId}/ppid/verify`,
    body,
  ),
  administerMed: (
    admissionId: string,
    administrationId: string,
    body: { status: MarStatus; withheldReason?: string; notes?: string; ppidAuthorization?: string },
  ) => api.patch(`/hospitals/admissions/${admissionId}/medications/${administrationId}`, body),
};

// ── Canonical non-medication inpatient orders (staff-only callers) ───────────
export const inpatientOrdersApi = {
  list: (admissionId: string) =>
    api.get<CanonicalInpatientOrderListResult>(
      `/hospitals/admissions/${encodeURIComponent(admissionId)}/orders`,
    ),
  create: (
    admissionId: string,
    body: CanonicalInpatientOrderInput,
    idempotencyKey: string,
  ) => api.post<CanonicalInpatientOrderCreateResult>(
    `/hospitals/admissions/${encodeURIComponent(admissionId)}/orders`,
    body,
    { idempotencyKey },
  ),
};

// ── Persisted hospital admission care-plan tasks ──────────────────────────────
const hospitalCarePlanPath = (admissionId: string, taskId?: string, operation?: string) =>
  `/hospitals/admissions/${encodeURIComponent(admissionId)}/care-plan-tasks${taskId ? `/${encodeURIComponent(taskId)}` : ''}${operation ? `/${operation}` : ''}`;
export const hospitalCarePlanApi = {
  list: (admissionId: string) => api.get<HospitalCarePlanListResult>(hospitalCarePlanPath(admissionId)),
  eligibleAssignees: (admissionId: string, limit = 25) =>
    api.get<HospitalCarePlanEligibleAssigneeListResult>(
      `${hospitalCarePlanPath(admissionId)}/eligible-assignees`,
      { limit },
    ),
  create: (admissionId: string, body: HospitalCarePlanCreateInput, idempotencyKey: string) =>
    api.post<HospitalCarePlanMutationResult>(hospitalCarePlanPath(admissionId), body, { idempotencyKey }),
  assign: (admissionId: string, taskId: string, body: HospitalCarePlanAssignInput, idempotencyKey: string) =>
    api.post<HospitalCarePlanMutationResult>(hospitalCarePlanPath(admissionId, taskId, 'assign'), body, { idempotencyKey }),
  reschedule: (admissionId: string, taskId: string, body: HospitalCarePlanRescheduleInput, idempotencyKey: string) =>
    api.post<HospitalCarePlanMutationResult>(hospitalCarePlanPath(admissionId, taskId, 'reschedule'), body, { idempotencyKey }),
  complete: (admissionId: string, taskId: string, idempotencyKey: string) =>
    api.post<HospitalCarePlanMutationResult>(hospitalCarePlanPath(admissionId, taskId, 'complete'), {}, { idempotencyKey }),
  skip: (admissionId: string, taskId: string, body: HospitalCarePlanReasonInput, idempotencyKey: string) =>
    api.post<HospitalCarePlanMutationResult>(hospitalCarePlanPath(admissionId, taskId, 'skip'), body, { idempotencyKey }),
  discontinue: (admissionId: string, taskId: string, body: HospitalCarePlanReasonInput, idempotencyKey: string) =>
    api.post<HospitalCarePlanMutationResult>(hospitalCarePlanPath(admissionId, taskId, 'discontinue'), body, { idempotencyKey }),
};

// ── Staff-only admission attention flags ─────────────────────────────────────
export const attentionFlagsApi = {
  list: (admissionId: string, status?: AttentionFlagStatus) =>
    api.get<AttentionFlag[]>(
      `/attention-flags/admissions/${encodeURIComponent(admissionId)}`,
      status ? { status } : undefined,
    ),
  create: (
    admissionId: string,
    body: CreateAttentionFlagInput,
    idempotencyKey: string,
  ) => api.post<AttentionFlag>(
    `/attention-flags/admissions/${encodeURIComponent(admissionId)}`,
    body,
    { idempotencyKey },
  ),
  resolve: (flagId: string) =>
    api.patch<AttentionFlag>(`/attention-flags/${encodeURIComponent(flagId)}/resolve`),
};

// ── Care home (residents) ────────────────────────────────────────────────────
// careHomeId is always the logged-in user's facilityId (roles caregiver / care_home_nurse).
export const careHomeApi = {
  resident: (careHomeId: string, residentId: string) =>
    api.get<CareHomeResident>(`/care-homes/${careHomeId}/residents/${residentId}`),
  recordVitals: (careHomeId: string, residentId: string, body: Record<string, unknown>) =>
    api.post(`/care-homes/${careHomeId}/residents/${residentId}/vitals`, body),
  carePlans: (careHomeId: string, residentId: string) =>
    api.get<CarePlanTask[]>(`/care-homes/${careHomeId}/care-plans`, { residentId }),
  completeTask: (careHomeId: string, residentId: string, taskId: string) =>
    api.patch(`/care-homes/${careHomeId}/residents/${residentId}/care-plans/${taskId}/complete`),
  skipTask: (careHomeId: string, residentId: string, taskId: string) =>
    api.patch(`/care-homes/${careHomeId}/residents/${residentId}/care-plans/${taskId}/skip`),
  administerMed: (careHomeId: string, recordId: string, body?: { status?: string; notes?: string }) =>
    api.patch(`/care-homes/${careHomeId}/medications/${recordId}/administer`, body ?? {}),
};

// ── Admin (read-only management) ────────────────────────────────────────────
export const adminApi = {
  /** The api client already unwraps the `{success,data}` envelope — the result IS the analytics object. */
  platformAnalytics: () => api.get<Record<string, unknown>>('/admin/analytics/platform'),
  moduleAnalytics: () => api.get<Record<string, unknown>>('/admin/analytics/modules'),
  facilities: (query?: { limit?: number; offset?: number }) =>
    api.requestFull<unknown[]>('/admin/facilities', { method: 'GET', query }) as Promise<{ data?: unknown[]; pagination?: Pagination }>,
  facility: (facilityId: string) => api.get<Record<string, unknown>>(`/admin/facilities/${facilityId}`),
  /** Update facility fields (e.g. enabledModules). Admin/super_admin only. */
  updateFacility: (facilityId: string, body: Record<string, unknown>) =>
    api.patch<Record<string, unknown>>(`/admin/facilities/${facilityId}`, body),
  slaDashboard: (facilityId?: string) => api.get<{ queue: SlaBoardEntry[]; summary?: Record<string, unknown> }>('/telehealth-queue/sla-dashboard', { facilityId }),
  /** Queue operations. Backend reads `facilityId` from the QUERY string, not the body. */
  /**
   * `DELETE /telehealth-queue/clear`.
   *
   * A PLATFORM admin (no facilityId on the token) must now send either an
   * explicit `facilityId` or `scope=platform`, otherwise the server answers
   * `400 CLEAR_SCOPE_REQUIRED` — it will not silently wipe every facility's
   * queue. The old no-argument call was therefore 100% dead for exactly the
   * actors that can reach the control. A facility-scoped admin is unaffected:
   * the token wins and the params are ignored.
   */
  clearQueue: (opts: { facilityId?: string; scope?: 'platform' } = {}) =>
    api.del<{ cleared: number }>('/telehealth-queue/clear', undefined, {
      query: { facilityId: opts.facilityId, scope: opts.scope },
    }),
  bulkUpdateQueue: (queueIds: string[], status: 'cancelled' | 'no_show' | 'completed', reason?: string) => 
    api.patch<{ updated: number }>('/telehealth-queue/bulk-update', { queueIds, status, reason }),
  /**
   * Read Care Station & Assisted Intake configuration for a facility. The
   * server nests the settings under `careStationConfig`; this returns that
   * object (careStationEnabled, assistedIntakeEnabled, enabledRoles,
   * hasStationPin, ...). The Station Exit PIN itself is never returned.
   */
  getCareStationConfig: async (facilityId: string): Promise<Record<string, unknown>> => {
    const res = await api.get<Record<string, unknown>>(`/admin/facilities/${facilityId}/care-station-config`);
    const nested = res && typeof res === 'object' ? (res as { careStationConfig?: unknown }).careStationConfig : null;
    return (nested && typeof nested === 'object' ? nested : res ?? {}) as Record<string, unknown>;
  },
  /** Update Care Station & Assisted Intake configuration (enabled roles, PIN, modules) for a facility. */
  updateCareStationConfig: (facilityId: string, body: Record<string, unknown>) =>
    api.put<Record<string, unknown>>(`/admin/facilities/${facilityId}/care-station-config`, body),
  /** Check a Station Exit PIN against the facility's saved one (kiosk unlock). Rejects on a wrong PIN. */
  verifyCareStationPin: (facilityId: string, pin: string) =>
    api.post<{ valid: boolean }>(`/admin/facilities/${facilityId}/care-station-config/verify-pin`, { pin }),
};

// ── Doctor productivity (availability + working-hours schedule) ──────────────
// The doctor's online/offline toggle + weekly working-hours editor. Kept as a
// dedicated export (endpoints.ts is append-only for this workstream).
export const doctorSelfApi = {
  /** Full doctor profile doc — includes the `availability` map used to hydrate the toggle. */
  profile: () => api.get<Record<string, unknown>>('/doctors/me/profile'),
  /** Weekly working-hours doc: { weeklySchedule: { monday:[{start,end}], … }, … }. */
  getSchedule: () => api.get<Record<string, unknown>>('/doctors/me/schedule'),
  setSchedule: (body: Record<string, unknown>) => api.put('/doctors/me/schedule', body),
  /**
   * Online/offline availability. `true` = accepting patients (routing sends new
   * consults + push); `false` = offline. The backend deep-merges into the
   * doctor's `availability` map, so passing both keys keeps them consistent.
   */
  setAvailability: (isAcceptingConsultations: boolean) =>
    api.put('/doctors/me/availability', { isAcceptingConsultations, isAvailable: isAcceptingConsultations }),
};

// ── Staff shifts (RETIRED rota — /staff-shifts) ─────────────────────────────
// The facility rota moved to Enterprise Scheduling V2 (enterpriseSchedulingApi
// below). The backend answers 410 {code:'RETIRED'} on /staff-shifts once
// LEGACY_STAFF_SHIFTS_RETIRED is on. Kept only for type compatibility.
export interface StaffShift {
  shiftId?: string;
  id?: string;
  facilityId?: string;
  staffUserId?: string;
  staffName?: string;
  role?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  area?: string;
  ward?: string;
  status?: string;
  notes?: string;
  [key: string]: unknown;
}
export interface ShiftSwap {
  requestId?: string;
  shiftId?: string;
  facilityId?: string;
  fromStaffUserId?: string;
  toStaffUserId?: string | null;
  reason?: string;
  status?: string;
  requestedBy?: string;
  date?: string;
  createdAt?: unknown;
  [key: string]: unknown;
}
/** @deprecated Retired rota. Use enterpriseSchedulingApi (myShifts, requestSubstitution, requestLeave, …). */
export const staffShiftsApi = {
  /** @deprecated use enterpriseSchedulingApi.myShifts */
  mine: (query?: { from?: string; to?: string; staffId?: string }) => api.get<StaffShift[]>('/staff-shifts', query),
  /** @deprecated */
  roster: (query?: { date?: string }) => api.get<Record<string, unknown>>('/staff-shifts/roster', query),
  /** @deprecated use enterpriseSchedulingApi.listSubstitutions */
  swaps: (query?: { status?: string }) => api.get<ShiftSwap[]>('/staff-shifts/swaps', query),
  /** @deprecated use enterpriseSchedulingApi.requestSubstitution */
  requestSwap: (shiftId: string, body: { toStaffUserId?: string; reason?: string }) =>
    api.post<ShiftSwap>(`/staff-shifts/${shiftId}/swap-request`, body),
  /** @deprecated use enterpriseSchedulingApi.approveSubstitution / denySubstitution / cancelSubstitution */
  resolveSwap: (requestId: string, action: 'approve' | 'deny' | 'cancel') =>
    api.patch(`/staff-shifts/swap/${requestId}`, { action }),
};

// ── Enterprise Scheduling V2 — the facility rota ────────────────────────────
// 503 FEATURE_DISABLED when ENTERPRISE_SCHEDULING_V2 is off. The server scopes
// everything to the caller's facility and resolves the staff member's active
// appointment itself, so self-service calls need no ids beyond the shift.

/** One shift on the V2 rota. */
export interface RotaShift {
  shiftId: string;
  facilityId: string;
  staffUserId: string;
  practitionerRoleId?: string;
  staffName?: string;
  role?: string;
  area?: string;
  service?: string;
  resourceId?: string;
  resourceName?: string;
  date: string;
  startTime: string;
  endTime: string;
  startAt?: string;
  endAt?: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled' | 'no_show' | string;
  shiftType?: 'regular' | 'on_call' | string;
  notes?: string;
  [key: string]: unknown;
}

/** A swap / cover request. `toStaffUserId` is null for an open request (a manager picks the cover). */
export interface RotaSubstitution {
  substitutionId: string;
  shiftId: string;
  facilityId: string;
  fromStaffUserId: string;
  toStaffUserId: string | null;
  fromStaffName?: string;
  toStaffName?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  area?: string;
  role?: string;
  reason?: string;
  status: 'pending' | 'approved' | 'denied' | 'cancelled' | string;
  requestedBy: string;
  [key: string]: unknown;
}

export type RotaLeaveType = 'annual' | 'sick' | 'maternity' | 'study' | 'unpaid' | 'emergency';

export interface RotaLeave {
  leaveId: string;
  staffUserId: string;
  facilityId: string;
  leaveType: RotaLeaveType | string;
  startDate: string;
  endDate: string;
  reason?: string;
  status: 'pending' | 'approved' | 'denied' | 'active' | 'completed' | 'cancelled' | string;
  requestedBy?: string;
  [key: string]: unknown;
}

/** Roles that manage the rota (mirrors backend ROTA_MANAGER_ROLES). */
export const ROTA_MANAGER_ROLES: readonly string[] = Object.freeze([
  'hospital_admin', 'clinic_admin', 'care_home_admin', 'pharmacy_admin',
  'lab_admin', 'rad_admin', 'hr_admin', 'admin', 'super_admin',
]);

const flag = (value?: boolean) => (value ? 'true' : undefined);

export const enterpriseSchedulingApi = {
  listSchedules: (query?: { facilityId?: string }) =>
    api.get<unknown[]>('/enterprise-scheduling/schedules', query),
  /** Managers: the facility rota (or one person via staffId). Staff always get only their own. */
  listShifts: (query?: { facilityId?: string; from?: string; to?: string; mine?: boolean; staffId?: string }) =>
    api.get<RotaShift[]>('/enterprise-scheduling/shifts', {
      facilityId: query?.facilityId,
      from: query?.from,
      to: query?.to,
      staffId: query?.staffId,
      mine: flag(query?.mine),
    }),
  /** Exactly the caller's own shifts (also for managers). */
  myShifts: (query?: { from?: string; to?: string }) =>
    api.get<RotaShift[]>('/enterprise-scheduling/shifts', { from: query?.from, to: query?.to, mine: 'true' }),
  createShift: (body: Record<string, unknown>) =>
    api.post<RotaShift>('/enterprise-scheduling/shifts', body),
  updateShift: (shiftId: string, body: Record<string, unknown>) =>
    api.patch(`/enterprise-scheduling/shifts/${shiftId}`, body),
  listLeave: (query?: { facilityId?: string; status?: string; mine?: boolean }) =>
    api.get<RotaLeave[]>('/enterprise-scheduling/leave', {
      facilityId: query?.facilityId,
      status: query?.status,
      mine: flag(query?.mine),
    }),
  /** Request leave. Leave out staffUserId to request it for yourself. */
  requestLeave: (body: {
    leaveType: RotaLeaveType;
    startDate: string;
    endDate: string;
    reason: string;
    staffUserId?: string;
    facilityId?: string;
  }) => api.post<RotaLeave>('/enterprise-scheduling/leave', body),
  approveLeave: (leaveId: string) =>
    api.patch<{ leaveId: string; shiftsNeedingCover: Array<Partial<RotaShift>> }>(`/enterprise-scheduling/leave/${leaveId}/approve`, {}),
  denyLeave: (leaveId: string) =>
    api.patch(`/enterprise-scheduling/leave/${leaveId}/deny`, {}),
  cancelLeave: (leaveId: string) =>
    api.patch(`/enterprise-scheduling/leave/${leaveId}/cancel`, {}),
  listSubstitutions: (query?: { facilityId?: string; status?: string; mine?: boolean }) =>
    api.get<RotaSubstitution[]>('/enterprise-scheduling/substitutions', {
      facilityId: query?.facilityId,
      status: query?.status,
      mine: flag(query?.mine),
    }),
  /** Ask for cover. Name a colleague, or leave toStaffUserId out and a manager picks the cover. */
  requestSubstitution: (shiftId: string, body: {
    toStaffUserId?: string; reason?: string; toPractitionerRoleId?: string;
  } = {}) => api.post<RotaSubstitution>(`/enterprise-scheduling/shifts/${shiftId}/substitute`, body),
  /** Managers. For an open request pass the colleague who will cover. */
  approveSubstitution: (substitutionId: string, body: { toStaffUserId?: string } = {}) =>
    api.patch(`/enterprise-scheduling/substitutions/${substitutionId}/approve`, body),
  denySubstitution: (substitutionId: string) =>
    api.patch(`/enterprise-scheduling/substitutions/${substitutionId}/deny`, {}),
  cancelSubstitution: (substitutionId: string) =>
    api.patch(`/enterprise-scheduling/substitutions/${substitutionId}/cancel`, {}),
  getCoverage: (facilityId: string, date: string) =>
    api.get(`/enterprise-scheduling/coverage/${encodeURIComponent(facilityId)}/${date}`),
  bookAppointment: (body: Record<string, unknown>) =>
    api.post('/enterprise-scheduling/appointments', body),
  cancelAppointment: (appointmentId: string) =>
    api.del(`/enterprise-scheduling/appointments/${appointmentId}`),
};

// ── Procurement / inventory ledger / assets (Wave 6 — /procurement) ─────────
export const procurementApi = {
  listLocations: (query?: { facilityId?: string }) =>
    api.get<unknown[]>('/procurement/locations', query),
  listLots: (query?: Record<string, string | undefined>) =>
    api.get<unknown[]>('/procurement/lots', query),
  adjustLot: (lotId: string, body: { delta: number; reason: string; notes?: string }) =>
    api.post(`/procurement/lots/${lotId}/adjust`, body),
  listRequisitions: (query?: { facilityId?: string; status?: string }) =>
    api.get<unknown[]>('/procurement/requisitions', query),
  createRequisition: (body: Record<string, unknown>) =>
    api.post('/procurement/requisitions', body),
  approveRequisition: (requisitionId: string) =>
    api.patch(`/procurement/requisitions/${requisitionId}/approve`, {}),
  listPurchaseOrders: (query?: { facilityId?: string; status?: string }) =>
    api.get<unknown[]>('/procurement/purchase-orders', query),
  createPurchaseOrder: (body: Record<string, unknown>) =>
    api.post('/procurement/purchase-orders', body),
  receivePurchaseOrder: (orderId: string, body: Record<string, unknown>) =>
    api.post(`/procurement/purchase-orders/${orderId}/receive`, body),
  listAssets: (query?: { facilityId?: string }) =>
    api.get<unknown[]>('/procurement/assets', query),
  createAsset: (body: Record<string, unknown>) =>
    api.post('/procurement/assets', body),
  listWorkOrders: (query?: { facilityId?: string; assetId?: string; status?: string }) =>
    api.get<unknown[]>('/procurement/work-orders', query),
  createWorkOrder: (body: Record<string, unknown>) =>
    api.post('/procurement/work-orders', body),
  startWorkOrder: (workOrderId: string) =>
    api.patch(`/procurement/work-orders/${workOrderId}/start`, {}),
  completeWorkOrder: (workOrderId: string, body?: Record<string, unknown>) =>
    api.patch(`/procurement/work-orders/${workOrderId}/complete`, body ?? {}),
  assetDowntime: (assetId: string) =>
    api.get(`/procurement/assets/${assetId}/downtime`),
};

// ══════════════════════════════════════════════════════════════════════════
// Admin mobile tools + notifications (BUILD AGENT ADMIN+NOTIF — append-only,
// after DOC's doctorSelfApi/staffShiftsApi block). Everything here reuses
// existing backend endpoints — grep-verified paths/bodies, no invented routes.
// ══════════════════════════════════════════════════════════════════════════

/** A consultation flagged by the ops attention monitor (stuck/unattended/awaiting-payment). */
export interface AttentionConsult {
  consultationId: string;
  status: string;
  paymentStatus?: string | null;
  reason: string;
  ageMinutes: number;
  patientId?: string | null;
  doctorId?: string | null;
  facilityId?: string | null;
  urgencyLevel?: string | null;
  triageCategory?: string | null;
  servicePrice?: number | null;
  paidAmount?: number | null;
  patientName?: string;
  doctorName?: string;
  createdAt?: unknown;
  [key: string]: unknown;
}

/** Lifecycle jobs registry + most recent run records. */
export interface JobsStatus {
  jobs: string[];
  recentRuns: Array<Record<string, unknown>>;
  lastRun: Record<string, unknown> | null;
}

/** A staff licence approaching (or past) expiry. */
export interface ExpiringCredential {
  userId: string;
  email?: string;
  role?: string;
  name?: string;
  licenseNumber?: string;
  licenseAuthority?: string;
  licenseExpiry?: string;
  daysUntilExpiry: number;
  isExpired: boolean;
  [key: string]: unknown;
}

/** A user row from the admin directory (lookup for incident-response actions). */
export interface AdminUserRow {
  userId: string;
  email?: string;
  phone?: string;
  role?: string;
  status?: string;
  facilityId?: string | null;
  adminLevel?: string;
  profile?: { firstName?: string; lastName?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** A facility staff member (facility-scoped console). */
export interface FacilityStaff {
  userId: string;
  email?: string;
  phone?: string;
  role?: string;
  status?: string;
  adminLevel?: string;
  permissions?: string[];
  profile?: { firstName?: string; lastName?: string; [key: string]: unknown };
  createdAt?: unknown;
  [key: string]: unknown;
}

/**
 * Ops attention monitor + incident actions. Backed by `/admin-ops` — read gated
 * to admin/super_admin/support/cs_admin; cancel/refund writes to admin/super_admin.
 */
export const adminOpsApi = {
  /** Consultations needing attention (paginated envelope). */
  attention: (query?: { limit?: number; offset?: number }) =>
    api.requestFull<AttentionConsult[]>('/admin-ops/consultations/attention', { method: 'GET', query }) as Promise<{
      data?: AttentionConsult[];
      pagination?: Pagination;
    }>,
  /** Cancel a consult (auto-refunds if paid). A reason is required by the API. */
  cancelConsult: (id: string, reason: string) =>
    api.post<{ refunded: boolean; refundAmount: number }>(`/admin-ops/consultations/${id}/cancel`, { reason }),
  /** Standalone refund (paid consults only). A reason is required by the API. */
  refundConsult: (id: string, reason: string) =>
    api.post<{ amount: number }>(`/admin-ops/consultations/${id}/refund`, { reason }),
  /** Lifecycle jobs health. */
  jobsStatus: () => api.get<JobsStatus>('/admin-ops/jobs/status'),
};

/**
 * Platform-admin incident tools over `/admin`. User status/force-logout/
 * reset-password respect the backend's super_admin + OTP gating; broadcast and
 * expiring-credentials are admin/super_admin.
 */
export const adminToolsApi = {
  /** User directory lookup (search by name/email/facility). Paginated envelope. */
  users: (query?: { search?: string; role?: string; status?: string; limit?: number; offset?: number }) =>
    api.requestFull<AdminUserRow[]>('/admin/users', { method: 'GET', query }) as Promise<{
      data?: AdminUserRow[];
      pagination?: Pagination;
    }>,
  /**
   * Suspend / reactivate a user. `otpCode` is only needed when the target is a
   * super_admin (backend returns `requiresOTP` otherwise).
   */
  setUserStatus: (userId: string, status: 'active' | 'suspended' | 'deactivated', otpCode?: string) =>
    api.patch<{ requiresOTP?: boolean }>(`/admin/users/${userId}/status`, otpCode ? { status, otpCode } : { status }),
  /** Terminate all of a user's sessions (super_admin only). */
  forceLogout: (userId: string) => api.post<Record<string, unknown>>(`/admin/users/${userId}/force-logout`),
  /** Generate a temporary password (super_admin only). Returns it once. */
  resetPassword: (userId: string) =>
    api.post<{ temporaryPassword: string }>(`/admin/users/${userId}/reset-password`),
  /** Staff licences expiring within `daysAhead` (default 90). */
  expiringCredentials: (daysAhead?: number) =>
    api.get<ExpiringCredential[]>('/admin/credentials/expiring', { daysAhead }),
  /**
   * Send a broadcast notification. Must target a role or a facility (the API
   * rejects an unscoped platform-wide send unless `targetRole:'all'`).
   */
  broadcast: (body: { title: string; body: string; targetRole?: string; targetFacilityId?: string }) =>
    api.post<{ recipientCount: number }>('/admin/broadcast', body),
};

/**
 * Facility-scoped console for hospital_admin / clinic_admin. Uses only
 * facility-scoped endpoints (never platform-admin-only ones, which would 403
 * for these roles).
 */
export const facilityAdminApi = {
  /** Roster of this facility's staff. */
  staff: (facilityId: string) => api.get<FacilityStaff[]>(`/admin/facilities/${facilityId}/staff`),
  /** Invite a (non-admin) staff member to this facility. */
  inviteStaff: (
    facilityId: string,
    body: { email: string; firstName: string; lastName: string; phone?: string; role?: string },
  ) => api.post<Record<string, unknown>>(`/admin/facilities/${facilityId}/staff/invite`, body),
  /** Get available permission modules for a facility. */
  permissionModules: (facilityId: string) =>
    api.get<{ facilityType: string; modules: { key: string; label: string; category: string; description: string }[] }>(`/admin/facilities/${facilityId}/permission-modules`),
  /** Get a staff member's current permissions. */
  staffPermissions: (facilityId: string, userId: string) =>
    api.get<{ userId: string; permissions: string[] }>(`/admin/facilities/${facilityId}/staff/${userId}/permissions`),
  /** Update a staff member's permissions (toggle modules). */
  updateStaffPermissions: (facilityId: string, userId: string, permissions: string[]) =>
    api.put<{ userId: string; permissions: string[] }>(`/admin/facilities/${facilityId}/staff/${userId}/permissions`, { permissions }),

  // ── Admin hierarchy (ADMIN_DELEGATION_V2) ────────────────────────────
  /** Site Admin: onboard an Assistant Admin at this facility. */
  delegateAdmin: (body: {
    userId: string;
    facilityId?: string;
    approvalMatrix?: Record<string, 'independent' | 'requires_approval'>;
    grantedPermissions?: string[];
  }) => api.post<Record<string, unknown>>('/admin/delegate', body),
  listDelegations: (params?: { facilityId?: string; status?: string }) =>
    api.get<Record<string, unknown>[]>('/admin/delegations', params),
  pendingApprovals: (params?: { facilityId?: string; scope?: string }) =>
    api.get<Record<string, unknown>[]>('/admin/pending-approvals', params),
  approveAction: (actionId: string, note?: string) =>
    api.post<Record<string, unknown>>(`/admin/approve/${encodeURIComponent(actionId)}`, note ? { note } : {}),
  denyAction: (actionId: string, note?: string) =>
    api.post<Record<string, unknown>>(`/admin/deny/${encodeURIComponent(actionId)}`, note ? { note } : {}),
  myDelegation: () => api.get<Record<string, unknown> | null>('/admin/me/delegation'),
  revokeDelegation: (delegationId: string, reason?: string) =>
    api.post<Record<string, unknown>>(`/admin/delegations/${encodeURIComponent(delegationId)}/revoke`, reason ? { reason } : {}),

  /** Record a vaccination administration. */
  recordVaccination: (body: { patientId: string; vaccineName: string; doseNumber?: number; administrationDate?: string; batchNumber?: string; manufacturer?: string; site?: string; notes?: string }) =>
    api.post<Record<string, unknown>>('/admin/clinical/vaccinations', body),
  /** SLA queue snapshot scoped to this facility. */
  slaDashboard: (facilityId: string) =>
    api.get<{ queue: SlaBoardEntry[]; summary?: Record<string, unknown> }>('/telehealth-queue/sla-dashboard', { facilityId }),
  /** Facility-scoped broadcast (targetFacilityId must equal the admin's own facility). */
  broadcast: (body: { title: string; body: string; targetFacilityId: string }) =>
    api.post<{ recipientCount: number }>('/admin/broadcast', body),
};

// ==== FE1 patient-journey ====

/** A facility from the community/operational library (search + public + resolve). */
export interface LibraryFacility {
  facilityId: string;
  name: string | null;
  type: string;
  address?: { street?: string; city?: string; state?: string; country?: string } | null;
  coordinates?: { latitude: number; longitude: number } | null;
  distanceKm?: number;
  telehealthEnabled?: boolean;
  source?: 'operational' | 'community';
  [key: string]: unknown;
}

export interface PreferredFacilities {
  preferredPharmacyId: string | null;
  preferredLabId: string | null;
  preferredPharmacyName: string | null;
  preferredLabName: string | null;
  language?: string | null;
  [key: string]: unknown;
}

/**
 * Facility library — public discovery of pharmacies/labs/clinics the patient
 * can "walk with", plus community-contributed additions and QR/deep-link
 * resolution. Search + public + resolve are unauthenticated; addToLibrary needs
 * a session (dedup: an existing match returns { duplicate:true, data }).
 */
export const facilityLibraryApi = {
  /** Search the library. Provide state OR lat+lng OR q (radiusKm default ~5). */
  searchLibrary: (
    query: { state?: string; lat?: number; lng?: number; type?: string; q?: string; radiusKm?: number; limit?: number },
  ) => api.get<LibraryFacility[]>('/facility-library/search', query, { auth: false }),
  /** Contribute a facility. Returns { data, duplicate } — duplicate:true when it folded into an existing entry. */
  addToLibrary: (body: {
    name: string;
    type: string;
    address: { city: string; state: string; country?: string; street?: string };
    phone?: string;
    email?: string;
    coordinates?: { latitude: number; longitude: number };
  }) =>
    api.requestFull<LibraryFacility>('/facility-library', { method: 'POST', body }) as Promise<
      Envelope<LibraryFacility> & { duplicate?: boolean }
    >,
  /** Public info for a facility id (QR deep-link "signing up with <Name>"). */
  facilityPublic: (facilityId: string) => api.get<LibraryFacility>(`/facilities/${facilityId}/public`, undefined, { auth: false }),
  /** Resolve a QR/signup short-code to a facility (currently facility ids). */
  resolve: (code: string) => api.get<LibraryFacility>('/facilities/resolve', { code }, { auth: false }),
};

/** Patient's preferred pharmacy/lab ("facilities I walk with") used for Rx/lab routing. */
export const patientPrefsApi = {
  get: () => api.get<PreferredFacilities>('/patients/preferred-facilities'),
  set: (body: { preferredPharmacyId?: string | null; preferredLabId?: string | null; preferredLabName?: string | null; language?: string | null }) =>
    api.put<PreferredFacilities>('/patients/preferred-facilities', body),
};

// ==== FE2 facility-staff ====

/** Point-of-care / rapid-test types the backend accepts (utils/point-of-care). */
export type PocTestType = 'malaria_rdt' | 'hiv' | 'blood_glucose' | 'pregnancy' | 'covid_rdt' | 'urinalysis' | 'other';

/** A single bedside rapid-test result attached to a walk-in / consult. */
export interface PointOfCareTest {
  type: PocTestType;
  result?: string;
  value?: string | number;
  unit?: string;
  notes?: string;
  takenBy?: string;
  takenByRole?: string;
  takenAt?: string;
}

/**
 * Point-of-care records — any facility staffer (nurse/pharmacist/lab tech/doctor)
 * attached to a live or queued consult can push a temp/BP/MP/HIV the reviewing
 * doctor sees. Roles gated at the consult's facility; notifies the assigned doctor.
 * (Walk-in vitals carry `pointOfCareTests` inline via intakeApi.walkInVitals.)
 */
export const pocApi = {
  addToConsult: (
    consultationId: string,
    body: { pointOfCareTests?: PointOfCareTest[]; vitals?: Record<string, unknown> },
  ) =>
    api.post<{ pointOfCareTests: PointOfCareTest[]; vitals: Record<string, unknown> | null }>(
      `/consultations/${consultationId}/point-of-care`,
      body,
    ),
};

/**
 * Doctor end-of-consult handoff. One call completes the consult and, per the
 * chosen actions, routes an Rx to a pharmacy, creates a lab order, sends a
 * referral, and/or files a follow-up SUGGESTION. Returns the summary the doctor
 * (and later patient) sees. Omit `handoff` / pass `{ endOnly:true }` to just end.
 */
export interface HandoffPayload {
  endOnly?: boolean;
  pharmacy?: { pharmacyId?: string; create?: boolean; medications?: unknown[]; instructions?: string };
  lab?: { laboratoryId?: string; tests: Array<{ name: string; price?: number }>; priority?: string };
  referral?: { facilityId?: string; specialty?: string; reason?: string; urgency?: string };
  followUp?: { timeframe?: string; reason?: string; type?: string; date?: string };
}
export interface HandoffSummary {
  completed: boolean;
  pharmacy?: { pharmacyId: string | null; patientMustChoose: boolean; prescriptionId?: string };
  lab?: { laboratoryId: string | null; patientMustChoose: boolean; labOrderId: string };
  referralId?: string;
  followUpSuggestionId?: string;
  [key: string]: unknown;
}
export const consultHandoffApi = {
  complete: (consultationId: string, body?: { diagnosis?: string; note?: string; handoff?: HandoffPayload }) =>
    api.post<HandoffSummary>(`/consultations/${consultationId}/complete`, body ?? {}),
};

/** Pharmacist incoming queue — prescriptions routed to the pharmacist's facility. */
export const pharmacyQueueApi = {
  incoming: (pharmacyId: string) => api.get<Prescription[]>(`/pharmacies/${pharmacyId}/prescriptions`),
};

/** A lab order in a laboratory's incoming queue. */
export interface LabOrder {
  orderId: string;
  id?: string;
  consultationId?: string | null;
  patientId?: string | null;
  patientName?: string | null;
  laboratoryId?: string | null;
  referringFacilityId?: string | null;
  status?: string;
  priority?: string;
  tests?: Array<{ name?: string; code?: string; price?: number } | string>;
  totalCost?: number;
  paymentStatus?: string;
  createdAt?: unknown;
  labRequestNumber?: string;
  specimenNumber?: string;
  specimenNumbers?: string[];
  specimens?: Array<{
    specimenKey: string;
    specimenNumber: string;
    collectionType?: string | null;
    collectedBy?: string;
    collectedAt?: unknown;
  }>;
  [key: string]: unknown;
}

/** Lab-tech incoming queue — orders routed to the technician's laboratory. */
export const labQueueApi = {
  incoming: (labId: string) => api.get<LabOrder[]>(`/laboratories/${labId}/orders`),
  /**
   * Update an order's status (e.g. pending → processing, sample_collected).
   * Backend: PATCH /laboratories/orders/:orderId/status — lab_technician/lab_admin.
   * NOTE: the backend rejects direct → 'completed'; use submitResults for that.
   */
  updateStatus: (orderId: string, status: string) =>
    api.patch(`/laboratories/orders/${orderId}/status`, { status }),
  /** Allocate an immutable server-side specimen accession and collect it. */
  collectSpecimen: (orderId: string, body?: { specimenKey?: string; collectionType?: string }) =>
    api.post<{ specimenKey: string; specimenNumber: string }>(
      `/laboratories/orders/${orderId}/specimens`,
      body || {},
    ),
  /**
   * Submit lab results for an order. In legacy mode (LAB_RESULT_VALIDATION unset)
   * the order is marked 'completed' and the patient is notified; in gated mode it
   * parks at 'awaiting_validation' until a second person signs off via validate().
   * Backend: POST /laboratories/orders/:orderId/results — lab_technician/lab_admin.
   */
  submitResults: (orderId: string, body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>(`/laboratories/orders/${orderId}/results`, body),
  /** Upload result files (images / PDF, up to 5) to an open order. Backend: POST /laboratories/orders/:orderId/attachments. */
  uploadAttachments: (orderId: string, form: FormData) =>
    api.request<Array<{ fileId: string; name: string; mimeType: string; size: number }>>(`/laboratories/orders/${orderId}/attachments`, { method: 'POST', form }),
  /**
   * Validate (sign off) an entered result — ISO 15189 four-eyes gate.
   * Backend: POST /laboratories/orders/:orderId/validate — lab_technician/lab_admin.
   */
  validate: (orderId: string) =>
    api.post<Record<string, unknown>>(`/laboratories/orders/${orderId}/validate`),
};

/**
 * Care-connect — patient shows a 6-char code/QR; staff redeem it to record
 * vitals + rapid tests onto the patient's live visit (provenance-tagged).
 */
export const careConnectApi = {
  /** Patient: mint (or reuse) the connect code shown on the queue screen. */
  generate: () =>
    api.post<{ code: string; expiresAt: string; hasActiveVisit: boolean }>('/care-connect/generate'),
  /** Staff: redeem a code → active connection to the patient's visit. */
  redeem: (code: string) =>
    api.post<{
      connectionId: string;
      patientName: string;
      hasActiveVisit: boolean;
      queueStatus: string | null;
      triageCategory: string | null;
      symptoms: string[];
      expiresAt: string;
    }>('/care-connect/redeem', { code }),
  /** Staff: record vitals and/or point-of-care tests onto the visit. */
  record: (connectionId: string, body: { vitals?: Record<string, unknown>; pointOfCareTests?: Array<Record<string, unknown>> }) =>
    api.post<{ attachedToVisit: boolean }>(`/care-connect/${connectionId}/record`, body),
  close: (connectionId: string) => api.post(`/care-connect/${connectionId}/close`),
};

/** Staff queue controls — return a patient to the line or mark a no-show. */
export const queueControlApi = {
  /** Return an assigned patient to waiting (keeps their place in line). Accepts queueId OR consultationId. */
  release: (queueOrConsultationId: string, reason?: string) =>
    api.post(`/telehealth-queue/${queueOrConsultationId}/release`, { reason }),
  noShow: (queueId: string) => api.patch(`/telehealth-queue/${queueId}/no-show`),
  requeue: (queueId: string, priority: 'front' | 'back' = 'back') =>
    api.post(`/telehealth-queue/${queueId}/requeue`, { priority }),
};

/** A diagnostics-tier order: mid-consult tests, billed before completion. */
export interface DiagnosticOrder {
  orderId: string;
  consultationId: string;
  patientId?: string | null;
  patientName?: string;
  requestedBy?: string;
  performerFacilityId?: string | null;
  tests: { key: string; name: string }[];
  note?: string | null;
  status: 'requested' | 'awaiting_payment' | 'paid' | 'completed' | 'cancelled';
  patientChoice?: 'wait' | 'later';
  billing?: { amount: number; currency: string; source: string; paymentMethod?: string | null } | null;
  results?: Array<{ testKey: string; name: string; result: string; notes?: string | null }>;
  createdAt?: unknown;
  [key: string]: unknown;
}

/** Diagnostics tier — order mid-consult tests, bill-before-complete, results back to the doctor. */
export const diagnosticsApi = {
  /** Doctor: order tests; patient moves to the diagnostics tier (not the back of the line). */
  order: (body: { consultationId: string; tests: Array<string | { key: string; name?: string }>; performerFacilityId?: string; note?: string }) =>
    api.post<DiagnosticOrder>('/diagnostics', body),
  worklist: () => api.get<DiagnosticOrder[]>('/diagnostics/worklist'),
  mine: () => api.get<DiagnosticOrder[]>('/diagnostics/mine'),
  patientActive: () => api.get<DiagnosticOrder | null>('/diagnostics/patient/active'),
  /** Performer: accept + bill (facility catalog item or manual price). */
  accept: (orderId: string, body: { catalogItemId?: string; amount?: number }) =>
    api.post<{ status: string; billing: Record<string, unknown> }>(`/diagnostics/${orderId}/accept`, body),
  /** Patient (verified wallet tx) or staff (cash/pos/transfer + exact amount received). */
  markPaid: (orderId: string, body: { transactionId?: string; method?: 'cash' | 'pos' | 'transfer'; amountReceived?: number }) =>
    api.post<{ paymentMethod: string; amountReceived: number; changeDue: number }>(`/diagnostics/${orderId}/mark-paid`, body),
  patientChoice: (orderId: string, choice: 'wait' | 'later') =>
    api.post(`/diagnostics/${orderId}/patient-choice`, { choice }),
  /** Performer: upload results (payment-gated) — patient auto-returns to the front of the queue. */
  submitResults: (orderId: string, results: Array<{ testKey: string; result: string; notes?: string }>) =>
    api.post<{ returnedToQueue: boolean }>(`/diagnostics/${orderId}/results`, { results }),
  cancel: (orderId: string) => api.post(`/diagnostics/${orderId}/cancel`),
};

/** Facility service agreements (EMR-only vs telehealth coverage) + markup. */
export const facilityAgreementsApi = {
  texts: () => api.get<Record<string, unknown>>('/facility-agreements/texts'),
  status: (facilityId: string) =>
    api.get<{
      emr_only: { version: string; acceptedAt: unknown } | null;
      telehealth_coverage: { version: string; acceptedAt: unknown } | null;
      billing: { markupPercent: number };
    }>(`/facility-agreements/${facilityId}`),
  accept: (facilityId: string, type: 'emr_only' | 'telehealth_coverage') =>
    api.post(`/facility-agreements/${facilityId}/accept`, { type }),
};

/** Staff view of a patient's preventive-medicine standing (done/due/overdue). */
export const preventiveStaffApi = {
  status: (patientId: string) =>
    api.get<{
      summary: { done: number; due: number; overdue: number; total: number };
      done: Array<{ type: string; frequency?: string | null; lastDone?: string | null }>;
      due: Array<{ type: string; frequency?: string | null; priority?: string | null }>;
      overdue: Array<{ type: string; frequency?: string | null; priority?: string | null }>;
    }>(`/patients/${patientId}/preventive-status`),
};

/** An in-app content banner (blogs / newsletter / announcements widget). */
export interface ContentBanner {
  bannerId: string;
  title: string;
  body?: string | null;
  emoji?: string | null;
  audience?: 'patient' | 'pro' | 'all';
  platform?: 'ios' | 'android' | 'all';
  linkType?: 'route' | 'url' | 'article';
  linkValue?: string | null;
  priority?: number;
  [key: string]: unknown;
}

/** Home-screen banner widget content (admin-published). */
export const contentBannersApi = {
  active: (audience: 'patient' | 'pro', platform?: 'ios' | 'android') =>
    api.get<ContentBanner[]>('/content-banners/active', { audience, ...(platform ? { platform } : {}) }),
};

/** A radiology (imaging) order routed to a radiology center. */
export interface RadiologyOrder {
  orderId: string;
  radiologyCenterId?: string | null;
  patientId?: string | null;
  patientName?: string | null;
  consultationId?: string | null;
  doctorId?: string | null;
  studies?: Array<{ studyId?: string; name?: string; modality?: string; bodyPart?: string; price?: number }>;
  priority?: string; // routine | urgent | stat
  clinicalIndication?: string;
  contrastRequired?: boolean;
  allergies?: string[];
  pregnancyStatus?: string;
  referringPhysicianNotes?: string;
  totalCost?: number;
  status?: string; // pending | scheduled | in_progress | completed | cancelled
  paymentStatus?: string;
  resultId?: string | null;
  scheduledAt?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}

/**
 * Radiology staff worklist — imaging orders routed to the caller's radiology
 * center. Backend: backend/src/routes/radiology.routes.ts (rad_technician /
 * rad_admin; order-scoped routes are doc-tenant guarded).
 */
export const radiologyStaffApi = {
  /** All orders for the center (newest first). */
  orders: (centerId: string) => api.get<RadiologyOrder[]>(`/radiology/${centerId}/orders`),
  /** Single order detail (staff of the owning center, or the patient). */
  order: (orderId: string) => api.get<RadiologyOrder>(`/radiology/orders/${orderId}`),
  /**
   * Move an order through the workflow. Valid: pending | scheduled |
   * in_progress | completed | cancelled. NOTE: submitting a report via
   * submitResults() completes the order atomically — prefer that over a
   * direct → 'completed'.
   */
  updateStatus: (orderId: string, status: 'pending' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled') =>
    api.patch(`/radiology/orders/${orderId}/status`, { status }),
  /** Schedule the exam appointment (emails the patient). */
  schedule: (orderId: string, scheduledAt: string, notes?: string) =>
    api.patch(`/radiology/orders/${orderId}/schedule`, { scheduledAt, notes }),
  /** Record cash/POS payment against the order. */
  recordPayment: (orderId: string, body: { amountPaid: number; paymentMethod: string; receiptNumber?: string }) =>
    api.patch<{ paymentStatus: string; amountPaid: number; totalCost: number }>(`/radiology/orders/${orderId}/pay`, body),
  /**
   * Submit the imaging report — atomically stores the result, marks the order
   * completed, syncs any parent inpatient order, and notifies the patient.
   */
  submitResults: (orderId: string, body: { technique?: string; findings?: string; impression?: string; recommendation?: string; reportStatus?: 'preliminary' | 'final'; [key: string]: unknown }) =>
    api.post<Record<string, unknown>>(`/radiology/orders/${orderId}/results`, body),
  /** Read a submitted result (report + re-signed image URLs). */
  result: (resultId: string) => api.get<Record<string, unknown>>(`/radiology/results/${resultId}`),
};

/** A follow-up / referral suggestion awaiting front-desk confirmation. */
export interface FollowUpSuggestion {
  id: string;
  consultationId: string;
  patientId: string | null;
  facilityId: string | null;
  doctorId: string | null;
  kind: 'follow_up' | 'referral';
  suggestion: {
    timeframe: string | null;
    reason: string | null;
    type: string | null;
    specialty?: string | null;
    tests_before_visit?: string[];
  };
  source: string;
  status: 'pending_review' | 'confirmed' | 'dismissed';
  createdAt?: unknown;
  [key: string]: unknown;
}

/**
 * Admin follow-up / referral review queue — the human-in-the-loop that keeps
 * doctors streamlined. Facility admins (token-scoped) + platform admins +
 * customer service confirm (book / refer) or dismiss AI-suggested follow-ups.
 */
export const followUpAdminApi = {
  list: (query?: { facilityId?: string; status?: 'pending_review' | 'confirmed' | 'dismissed' }) =>
    api.get<FollowUpSuggestion[]>('/follow-up-suggestions', { status: 'pending_review', ...(query ?? {}) }),
  confirmBook: (id: string, body?: { date?: string; doctorId?: string }) =>
    api.patch<{ id: string; status: string; action: string; appointmentId?: string }>(
      `/follow-up-suggestions/${id}/confirm`,
      { action: 'book', ...(body ?? {}) },
    ),
  confirmReferral: (id: string, body?: { toFacilityId?: string; specialty?: string }) =>
    api.patch<{ id: string; status: string; action: string; referralId?: string }>(
      `/follow-up-suggestions/${id}/confirm`,
      { action: 'referral', ...(body ?? {}) },
    ),
  dismiss: (id: string) => api.patch<{ id: string; status: string }>(`/follow-up-suggestions/${id}/dismiss`),
};

// ── Drugstoc (drug search + pricing + ordering) ──────────────────────────────
export interface DrugstocDrug {
  drugId: string;
  name: string;
  genericName?: string;
  brand?: string;
  form?: string;
  strength?: string;
  packSize?: string;
  manufacturer?: string;
  category?: string;
  requiresPrescription?: boolean;
}
export interface DrugstocPrice {
  drugId: string;
  name: string;
  price: number;
  currency: string;
  unitPrice?: number;
  packPrice?: number;
  inStock: boolean;
  estimatedDeliveryDays?: number;
}
export const drugstocApi = {
  /** Search drugs by name/generic name (public). */
  search: (q: string) => api.get<DrugstocDrug[]>('/drugstoc/search', { q }, { auth: false }),
  /** Get price for a specific drug (public). */
  getPrice: (drugId: string) => api.get<DrugstocPrice>(`/drugstoc/price/${drugId}`, undefined, { auth: false }),
  /** Place an order from a prescription (authenticated patient). */
  placeOrder: (body: {
    prescriptionData: {
      prescriptionId: string;
      medications: Array<{ name: string; dosage?: string; quantity: number; drugId?: string }>;
      patientName?: string;
      patientPhone?: string;
    };
    deliveryAddress: { street?: string; city?: string; state?: string; country?: string; lat?: number; lng?: number };
  }) => api.post<Record<string, unknown>>('/drugstoc/order', body),
};

// ── Prescription delivery (quote + order) ────────────────────────────────────
export interface DeliveryQuote {
  drugCost: number;
  deliveryFee: number;
  /**
   * Amount of the service & handling line, in naira. The RATE that produced it
   * is a commercial mechanic (BUSINESS_MODEL.md) and is deliberately not on the
   * wire — do not re-add `markupPercent`.
   */
  markup: number;
  total: number;
  currency: string;
  drugSource: 'pharmacy_catalog' | 'drugstoc' | 'estimated';
  medications: Array<{ name: string; dosage: string | null; quantity: number; estimatedPrice: number | null }>;
}
export interface DeliveryOrderResult {
  orderId: string;
  paymentStatus: 'paid' | 'pending' | 'failed';
  total: number;
  currency: string;
  costBreakdown: DeliveryQuote;
  walletBalance?: number;
  authorizationUrl?: string;
  txRef?: string;
  deliveryId?: string;
}
export const prescriptionDeliveryApi = {
  /** Get an itemized delivery cost quote for a prescription. */
  getQuote: (prescriptionId: string, body: {
    deliveryAddress: { street?: string; city?: string; state?: string; country?: string; lat?: number; lng?: number };
    pharmacyId?: string;
  }) => api.post<DeliveryQuote>(`/prescriptions/${prescriptionId}/delivery-quote`, body),
  /** Place a delivery order for a prescription (processes payment). */
  placeOrder: (prescriptionId: string, body: {
    deliveryAddress: { street?: string; city?: string; state?: string; country?: string; lat?: number; lng?: number };
    paymentMethod: 'wallet' | 'paystack' | 'flutterwave';
    pharmacyId?: string;
  }) => api.post<DeliveryOrderResult>(`/prescriptions/${prescriptionId}/delivery-order`, body),
};

// ── Preventive care API ───────────────────────────────────────────────────
export const preventiveApi = {
  /** Get AI-powered wellness screening recommendations for authenticated patient. */
  wellness: () => api.get<Record<string, unknown>>('/patients/preventive/wellness'),
  /** Get Nigeria NPI immunization status tracking for authenticated patient. */
  immunizations: () => api.get<Record<string, unknown>>('/patients/preventive/immunizations'),
  /** Get annual/biannual visit schedule and eligibility status. */
  visitSchedule: () => api.get<Record<string, unknown>>('/patients/preventive/visit-schedule'),
  /** Book free annual wellness visit. */
  /** Needs a day and time; books the chosen doctor or a free one at the facility (409 with a plain message if none). */
  bookAnnualVisit: (data: { date: string; startTime: string; doctorId?: string; facilityId?: string }) =>
    api.post<Record<string, unknown>>('/patients/preventive/book-annual-visit', data),
  /** Book routine screening (eye, dental, metabolic, etc.). */
  bookScreening: (data: { screeningType: string; preferredFacilityId?: string; date: string; startTime: string; doctorId?: string }) =>
    api.post<Record<string, unknown>>('/patients/preventive/book-screening', data),
};

// ── Support tickets (patient in-app support chat) ────────────────────────────
/** A support ticket created via POST /support/tickets. */
export interface SupportTicket {
  ticketId: string;
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed' | 'escalated';
  priority?: string;
  type?: string;
  channel?: string;
  assignedTo?: string | null;
  escalatedTo?: string;
  createdBy?: string;
  messages?: Array<{
    senderId: string;
    content: string;
    timestamp: string | { toDate?: () => Date } | unknown;
  }>;
  createdAt?: string | { toDate?: () => Date } | unknown;
  updatedAt?: string | { toDate?: () => Date } | unknown;
  [key: string]: unknown;
}

export const supportApi = {
  /** Create a new support ticket (POST /support/tickets). */
  createTicket: (body: { subject: string; description: string; channel?: string; priority?: string; facilityId?: string }) =>
    api.post<SupportTicket>('/support/tickets', body),
  /** Add a message to an existing ticket (POST /support/tickets/:ticketId/messages). */
  replyToTicket: (ticketId: string, message: string) =>
    api.post<{ success: boolean; message: string }>(`/support/tickets/${ticketId}/messages`, { content: message }),
  /** Fetch a single ticket by id (GET /support/tickets — filtered by createdBy for patients). */
  getTicket: (ticketId: string) =>
    api.get<SupportTicket[]>(`/support/tickets`, { status: undefined }).then((tickets) =>
      tickets.find((t) => t.ticketId === ticketId) ?? null,
    ),
};

// ── Care team messaging (patient → care team) ───────────────────────────────
/** A care-team message thread initiated by a patient. */
export interface CareTeamMessage {
  id: string;
  messageId?: string;
  patientId?: string;
  patientName?: string;
  consultationId?: string | null;
  subject: string;
  message: string;
  status: 'pending' | 'responded' | 'closed';
  routedTo?: string;
  assignedTo?: string | null;
  assignedToName?: string | null;
  replies?: Array<{
    id?: string;
    replyId?: string;
    authorId?: string;
    staffId?: string;
    patientId?: string;
    authorType?: 'patient' | 'staff';
    authorName?: string;
    staffName?: string;
    authorRole?: string;
    staffRole?: string;
    text: string;
    reply?: string;
    isInternal?: boolean;
    readAt?: string | null;
    readAtForViewer?: string | null;
    createdAt: string;
  }>;
  targetStaffIds?: string[];
  readAtForViewer?: string | null;
  deliveredAtForViewer?: string | null;
  patientReadCursorAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export const careTeamApi = {
  /** List the patient's care-team message threads. */
  list: () => api.get<CareTeamMessage[]>('/patients/care-team/messages'),
  /** Send a new message to the care team. */
  send: (body: { consultationId?: string; subject: string; message: string; routedTo?: string }) =>
    api.post<CareTeamMessage>('/patients/care-team/messages', { routedTo: 'doctor', ...body }),
  /** Get replies for a specific message thread. */
  getReplies: (messageId: string) =>
    api.get<CareTeamMessage>(`/patients/care-team/messages/${messageId}`),
  /** Continue an existing care-team thread. */
  reply: (messageId: string, reply: string) =>
    api.post<CareTeamMessage>(`/patients/care-team/messages/${messageId}/reply`, { reply }),
  /** Mark staff responses in a thread as read. */
  markRead: (messageId: string) =>
    api.post<{ updated: number; readAt: string }>(`/patients/care-team/messages/${messageId}/mark-read`),
};

// ── Staff care team inbox (pro app) ──────────────────────────────────────────
export const staffCareTeamApi = {
  /** List all patient care-team messages for the facility. */
  list: (query?: { status?: string }) =>
    api.get<CareTeamMessage[]>('/staff/care-team/messages', query),
  /** Reply to a patient's care-team message (or leave an internal note). */
  reply: (messageId: string, reply: string, isInternal?: boolean) =>
    api.post<Record<string, unknown>>(`/staff/care-team/messages/${messageId}/reply`, { reply, isInternal }),
  /** Assign a routed message to one active staff member. */
  assign: (messageId: string, staffUserId: string) =>
    api.patch<Record<string, unknown>>(`/staff/care-team/messages/${messageId}/assign`, { staffUserId }),
  /** Route a message to a different clinical discipline. */
  route: (messageId: string, routedTo: 'doctor' | 'pharmacist' | 'lab' | 'nurse' | 'admin', internalNote?: string) =>
    api.patch<Record<string, unknown>>(`/staff/care-team/messages/${messageId}/route`, { routedTo, internalNote }),
  /** Persist that this explicitly routed staff member opened the thread. */
  markRead: (messageId: string) =>
    api.post<{ changed: boolean; readAt: string; deliveredAt: string }>(
      `/staff/care-team/messages/${messageId}/mark-read`,
    ),
  /** Persist transport delivery without claiming that the thread was opened. */
  markDelivered: (messageId: string) =>
    api.patch<{ changed: boolean; deliveredAt: string }>(
      `/staff/care-team/messages/${messageId}/delivered`,
    ),
};

// ── Referral Marketplace API ──────────────────────────────────────────────
export const referralMarketplaceApi = {
  /** List facility-facing open and directed marketplace referrals. */
  marketplace: (query?: { specialty?: string; urgency?: string; status?: string }) =>
    api.get<Record<string, unknown>[]>('/referrals/marketplace', query),
  /** Facility marketplace stats & performance metrics. */
  stats: () => api.get<Record<string, unknown>>('/referrals/marketplace/stats'),
  /** Claim/accept a referral from marketplace. */
  accept: (referralId: string, data?: { facilityId?: string }) =>
    api.post<Record<string, unknown>>(`/referrals/${referralId}/accept`, data),
  /** Decline a referral. */
  decline: (referralId: string, data?: { facilityId?: string; reason?: string }) =>
    api.post<Record<string, unknown>>(`/referrals/${referralId}/decline`, data),
  /** Dual acceptance preferences (auto_accept vs review). */
  getPreferences: () =>
    api.get<{
      autoAccept?: boolean;
      auto_accept?: boolean;
      acceptanceMode?: 'auto' | 'review';
      autoAcceptSpecialties?: string[];
      referralFeeNgn?: number | null;
      notes?: string | null;
    }>('/referrals/preferences'),
  updatePreferences: (data: {
    auto_accept?: boolean;
    autoAccept?: boolean;
    acceptanceMode?: 'auto' | 'review';
    autoAcceptSpecialties?: string[];
    referralFeeNgn?: number | null;
    notes?: string | null;
  }) => api.patch<Record<string, unknown>>('/referrals/preferences', data),
  specialties: () => api.get<string[]>('/referrals/specialties'),
  getMessages: (referralId: string) =>
    api.get<Array<Record<string, unknown>>>(`/referrals/${referralId}/messages`),
  postMessage: (referralId: string, text: string) =>
    api.post<Record<string, unknown>>(`/referrals/${referralId}/messages`, { text }),
};

// ── Medication Reminder & Adherence Tracker ──────────────────────────────────
export interface MedicationReminder {
  reminderId: string;
  patientId?: string;
  source?: 'patient' | 'pharmacy';
  medicationName: string;
  dosage: string;
  frequency: 'once_daily' | 'twice_daily' | 'thrice_daily' | 'four_times_daily' | 'weekly' | 'as_needed' | 'custom';
  times: string[];
  startDate?: string;
  endDate?: string | null;
  prescriptionId?: string | null;
  instructions?: string | null;
  color?: string;
  adherenceLog?: Array<{ date: string; action: string; scheduledTime?: string | null; takenAt?: string; reason?: string | null; snoozedMinutes?: number; snoozedUntil?: string }>;
  streak?: number;
  longestStreak?: number;
  totalTaken?: number;
  totalMissed?: number;
  snoozedUntil?: string | null;
  status?: 'active' | 'paused' | 'completed' | 'cancelled';
  nextDose?: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface AdherenceReport {
  overallAdherence: number;
  totalTaken: number;
  totalMissed: number;
  activeMedications: number;
  bestStreak: number;
  medications: Array<{
    name: string;
    taken: number;
    missed: number;
    streak: number;
    adherenceRate: number;
  }>;
}

export const medicationReminderApi = {
  /** Create a medication reminder. */
  create: (body: {
    medicationName: string;
    dosage: string;
    frequency: MedicationReminder['frequency'];
    times: string[];
    startDate: string;
    endDate?: string;
    prescriptionId?: string;
    instructions?: string;
    color?: string;
  }) => api.post<MedicationReminder>('/patients/reminders', body),
  /** List the patient's reminders (optionally filter by status). */
  list: (status?: 'active' | 'paused' | 'completed' | 'cancelled') =>
    api.get<MedicationReminder[]>('/patients/reminders', status ? { status } : undefined),
  /** Update a reminder. */
  update: (reminderId: string, body: Partial<Pick<MedicationReminder, 'dosage' | 'frequency' | 'times' | 'endDate' | 'instructions' | 'status' | 'color'>>) =>
    api.patch(`/patients/reminders/${reminderId}`, body),
  /** Cancel (soft-delete) a reminder. */
  remove: (reminderId: string) => api.del(`/patients/reminders/${reminderId}`),
  /** Snooze a reminder for N minutes. */
  snooze: (reminderId: string, minutes: number) =>
    api.post<{ snoozedUntil: string }>(`/patients/reminders/${reminderId}/snooze`, { minutes }),
  /** Mark a dose as taken. */
  markTaken: (reminderId: string, time?: string) =>
    api.post<{ totalTaken: number; streak: number; longestStreak: number }>(`/patients/reminders/${reminderId}/taken`, { time }),
  /** Mark a dose as skipped. */
  markSkipped: (reminderId: string, reason?: string) =>
    api.post(`/patients/reminders/${reminderId}/skip`, { reason }),
  /** Get adherence report across all reminders. */
  adherence: () => api.get<AdherenceReport>('/patients/reminders/adherence'),
};

// ── Health Education Library ──────────────────────────────────────────────────
export interface HealthArticle {
  articleId: string;
  title: string;
  slug: string;
  summary: string;
  category: string;
  tags?: string[];
  readingTimeMinutes?: number;
  authorName?: string;
  authorRole?: string;
  coverImage?: string | null;
  content?: string;
  isBookmarked?: boolean;
  views?: number;
  publishedAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface HealthArticleCategory {
  categoryId: string;
  name: string;
  slug: string;
  description?: string;
  articleCount?: number;
  icon?: string;
  [key: string]: unknown;
}

export const healthEducationApi = {
  /** List published articles (with optional category / search / bookmark filter). */
  articles: (query?: { category?: string; search?: string; bookmarked?: boolean; limit?: number; offset?: number }) =>
    api.get<HealthArticle[]>('/health-education/articles', query),
  /** Get a single article by slug or id. */
  article: (idOrSlug: string) => api.get<HealthArticle>(`/health-education/articles/${idOrSlug}`),
  /** List article categories. */
  categories: () => api.get<HealthArticleCategory[]>('/health-education/categories'),
  /** Bookmark or unbookmark an article. */
  toggleBookmark: (articleId: string, bookmarked: boolean) =>
    api.post(`/health-education/articles/${articleId}/bookmark`, { bookmarked }),
  /** List bookmarked articles for the patient. */
  bookmarks: () => api.get<HealthArticle[]>('/health-education/bookmarks'),
};

// ── Second Opinion Request ────────────────────────────────────────────────────
export interface SecondOpinionRequest {
  requestId: string;
  patientId?: string;
  patientName?: string;
  consultationId?: string | null;
  specialty?: string;
  reason: string;
  symptoms?: string;
  currentDiagnosis?: string;
  currentTreatment?: string;
  questions?: string[];
  attachments?: Array<{ name: string; url?: string; type?: string }>;
  preferredFacilityId?: string | null;
  preferredDoctorId?: string | null;
  urgency?: 'routine' | 'urgent';
  status?: 'pending' | 'reviewing' | 'completed' | 'cancelled';
  assignedDoctorId?: string | null;
  assignedDoctorName?: string | null;
  opinion?: string | null;
  opinionAttachments?: Array<{ name: string; url?: string; type?: string }>;
  respondedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export const secondOpinionApi = {
  /** Create a second-opinion request. */
  create: (body: {
    consultationId?: string;
    specialty?: string;
    reason: string;
    symptoms?: string;
    currentDiagnosis?: string;
    currentTreatment?: string;
    questions?: string[];
    preferredFacilityId?: string;
    preferredDoctorId?: string;
    urgency?: 'routine' | 'urgent';
  }) => api.post<SecondOpinionRequest>('/second-opinions', body),
  /** List the patient's second-opinion requests. */
  list: (status?: SecondOpinionRequest['status']) =>
    api.get<SecondOpinionRequest[]>('/second-opinions', status ? { status } : undefined),
  /** Get a single second-opinion request by id. */
  get: (requestId: string) => api.get<SecondOpinionRequest>(`/second-opinions/${requestId}`),
  /** Cancel a pending second-opinion request. */
  cancel: (requestId: string, reason?: string) =>
    api.post(`/second-opinions/${requestId}/cancel`, { reason }),
  /** Available specialties for second opinions. */
  specialties: () => api.get<string[]>('/second-opinions/specialties'),
};

// ── HMO / Health Insurance (Nigerian providers) ──────────────────────────────
// Backed by /api/v1/insurance — the provider-agnostic NHIA/HMO eligibility +
// claims framework. Real HMO connectivity is pluggable via adapter keys
// (mock, nhia, hygeia, reliance, avon, axamansard). Today only 'mock' is wired.
export const insuranceApi = {
  // ── HMO Provider Registry ──
  /** List all registered HMO providers (optionally filter active). */
  providers: (activeOnly?: boolean) =>
    api.get<HmoProvider[]>('/insurance/providers', activeOnly ? { active: 'true' } : undefined),
  /** Register a new HMO provider (platform admin only). */
  createProvider: (body: {
    name: string;
    adapterKey: string;
    active?: boolean;
    logoUrl?: string;
    website?: string;
    phone?: string;
    email?: string;
    address?: string;
  }) => api.post<HmoProvider>('/insurance/providers', body),
  /** Update an HMO provider (platform admin only). */
  updateProvider: (hmoId: string, body: Partial<HmoProvider>) =>
    api.patch<HmoProvider>(`/insurance/providers/${hmoId}`, body),

  // ── Patient Insurance Policies ──
  /** List insurance policies (optionally filter by patientId). */
  policies: (patientId?: string) =>
    api.get<InsurancePolicy[]>('/insurance/policies', patientId ? { patientId } : undefined),
  /** Get a single policy by id. */
  policy: (policyId: string) => api.get<InsurancePolicy>(`/insurance/policies/${policyId}`),
  /** Attach an insurance policy to a patient. */
  createPolicy: (body: {
    patientId: string;
    hmoId: string;
    memberId: string;
    planName?: string;
    planId?: string;
    benefitModel?: 'fee_for_service' | 'capitation';
    copayPercent?: number;
    effectiveDate?: string;
    expiryDate?: string;
  }) => api.post<InsurancePolicy>('/insurance/policies', body),
  /** Update an insurance policy. */
  updatePolicy: (policyId: string, body: Partial<InsurancePolicy>) =>
    api.patch<InsurancePolicy>(`/insurance/policies/${policyId}`, body),

  // ── Eligibility ──
  /** Check coverage via the HMO adapter; caches onto the policy. */
  checkEligibility: (body: {
    policyId?: string;
    memberId?: string;
    hmoId?: string;
    serviceCode?: string;
    serviceDate?: string;
  }) => api.post<EligibilityResult>('/insurance/eligibility', body),

  // ── Pre-Authorization ──
  /** Request pre-authorization for a service. */
  requestPreAuth: (body: {
    policyId?: string;
    memberId?: string;
    hmoId?: string;
    serviceCode: string;
    diagnosisCode?: string;
    estimatedAmount: number;
    notes?: string;
  }) => api.post<PreAuthResult>('/insurance/pre-auth', body),

  // ── Claims ──
  /** List claims (facility-scoped; filter by status, patientId, hmoId). */
  claims: (query?: { status?: string; patientId?: string; hmoId?: string; limit?: number; offset?: number }) =>
    api.requestFull<InsuranceClaim[]>('/insurance/claims', { method: 'GET', query }) as Promise<{
      data?: InsuranceClaim[];
      pagination?: Pagination;
    }>,
  /** Get a single claim by id. */
  claim: (claimId: string) => api.get<InsuranceClaim>(`/insurance/claims/${claimId}`),
  /** Create a new claim (optionally seeded from a consultation). */
  createClaim: (body: {
    patientId: string;
    hmoId: string;
    policyId?: string;
    memberId?: string;
    consultationId?: string;
    encounterId?: string;
    encounterDate?: string;
    lineItems: ClaimLineItem[];
    notes?: string;
  }) => api.post<InsuranceClaim>('/insurance/claims', body),
  /** Edit a claim while in draft status. */
  updateClaim: (claimId: string, body: {
    memberId?: string;
    encounterDate?: string;
    notes?: string;
    lineItems?: ClaimLineItem[];
  }) => api.patch<InsuranceClaim>(`/insurance/claims/${claimId}`, body),
  /** Submit a claim to the HMO adapter for adjudication. */
  submitClaim: (claimId: string) => api.post<InsuranceClaim>(`/insurance/claims/${claimId}/submit`),
  /** Poll the adapter for claim status updates. */
  refreshClaimStatus: (claimId: string) =>
    api.post<InsuranceClaim>(`/insurance/claims/${claimId}/status/refresh`),
  /** Lodge an appeal on a denied/rejected claim. */
  appealClaim: (claimId: string, reason: string) =>
    api.post<InsuranceClaim>(`/insurance/claims/${claimId}/appeal`, { reason }),
};

// ── Independent Practice ──────────────────────────────────────────────────────
// A doctor's own single-seat practice. Backed by five routers that share the
// `/practice` base (onboarding + profile, invites, panel + folder, earnings),
// plus `/my-practices` (the patient's side) and the unauthenticated
// `/practice-invites/:token` verify+redeem pair.
//
// Every list endpoint returns `{ data, meta }` (NOT `pagination`), so the paged
// calls below use `requestFull` and expose `meta` — same cast idiom as
// `insuranceApi.claims`.
//
// The whole module ships behind a deployment flag: when it is off every
// `/practice*` route answers 503 `INDEPENDENT_PRACTICE_DISABLED`. Callers treat
// that as "no practice" rather than an error worth showing.

/** The deployment flag's error code — surfaced as "not enabled", not a failure. */
export const PRACTICE_DISABLED_CODE = 'INDEPENDENT_PRACTICE_DISABLED';

export type PracticeRecordScope = 'practice_only' | 'full_record';
export type PracticeGateKey = 'credential' | 'identity' | 'agreement' | 'payout';
export type PracticeStatus = 'draft' | 'pending_verification' | 'active' | 'suspended' | 'closed';
export type PracticeMembershipStatus = 'invited' | 'active' | 'archived' | 'revoked_by_patient';
export type PracticeInviteChannel = 'whatsapp' | 'sms' | 'link' | 'qr';

export interface PracticeGateState {
  satisfied: boolean;
  /** Server-authored why-not. Rendered VERBATIM — never re-worded client-side. */
  detail: string;
}

export type PracticeGateReport = Record<PracticeGateKey, PracticeGateState>;

export interface PracticeService {
  mode: string;
  label: string;
  price: number;
  currency: string;
}

/** The patient-safe projection (`toPublicPractice`). */
export interface PracticePublic {
  practiceId: string;
  type: 'private_practice';
  name: string;
  slug: string;
  specialty?: string | null;
  bio?: string | null;
  photo?: string | null;
  status: PracticeStatus;
  /** Verifiable by the patient against the MDCN register. */
  mdcnRegistrationNumber?: string | null;
  services?: PracticeService[];
}

export interface PracticePayoutView {
  bankCode: string;
  /** The API only ever returns the last 4 digits. */
  accountNumberMasked: string;
  accountName: string;
  verifiedAt?: string | null;
  nameMatch?: boolean | null;
}

/** The owner's view — adds fee schedule, wallet and the masked payout account. */
export interface PracticeOwnerView extends PracticePublic {
  feeSchedule?: Array<{ serviceCode: string; label: string; mode: string; price: number; currency: string; active: boolean }>;
  discoverable?: boolean;
  billingExempt?: boolean;
  plan?: string;
  enabledModules?: string[];
  licenceExpiresAt?: string | null;
  activatedAt?: string | null;
  walletId?: string | null;
  groupId?: string | null;
  payout?: PracticePayoutView | null;
}

export interface PracticeOnboardingView {
  onboardingId: string;
  userId: string;
  practiceId?: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'provisioned';
  draft?: { name?: string; slug?: string; specialty?: string | null; bio?: string | null; photo?: string | null };
  credentialId?: string | null;
  payout?: PracticePayoutView | null;
  contractId?: string | null;
  verificationId?: string | null;
  submittedAt?: string | null;
}

export interface PracticeCredentialView {
  credentialId: string;
  registrationNumber: string;
  authority: string;
  verificationStatus: string;
  verificationMethod?: string | null;
  expiresAt?: string | null;
}

export interface PracticeMe {
  practice: PracticeOwnerView | null;
  onboarding: PracticeOnboardingView | null;
  credential: PracticeCredentialView | null;
  gates: PracticeGateReport;
  unmet: PracticeGateKey[];
  canActivate: boolean;
  agreement?: { contractType: string; version: string };
}

export interface PracticeUpcomingConsult {
  consultationId: string;
  patientId?: string | null;
  type?: string | null;
  status?: string | null;
  scheduledAt?: string | null;
  createdAt?: string | null;
}

export interface PracticeDashboard {
  practice: PracticeOwnerView;
  panelCount: number;
  /** True when panelCount hit the server's bounded scan — display as "500+". */
  panelCountCapped?: boolean;
  upcomingConsults: PracticeUpcomingConsult[];
  upcomingConsultCount: number;
  unacknowledgedResults: number;
  wallet: { balance: number; currency: string };
}

export interface PracticePanelRow {
  membershipId: string;
  patientId: string;
  patientName?: string | null;
  status: PracticeMembershipStatus;
  recordScope: PracticeRecordScope;
  joinedVia?: string | null;
  joinedAt?: string | null;
  lastContactAt?: string | null;
  archivedAt?: string | null;
  revokedAt?: string | null;
  lastConsultAt?: string | null;
  consultCount?: number;
  outstandingResults?: number;
}

export interface PracticeFolderPatient {
  patientId: string;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  age?: number | null;
  gender?: string | null;
  phone?: string | null;
  address?: unknown;
  ninLast4?: string;
  mrn?: string | null;
  /** Only present on a `full_record` grant. */
  email?: string | null;
}

export interface PracticeTimelineEntry {
  type: 'consultation' | 'prescription' | 'lab_order' | 'vitals' | string;
  id: string;
  at?: string | null;
  title?: string | null;
  summary?: string | null;
}

export interface PracticeFolder {
  patient: PracticeFolderPatient;
  membership: PracticePanelRow;
  scope: { recordScope: PracticeRecordScope; badge: string; walled: boolean };
  timeline: PracticeTimelineEntry[];
  vitals: Array<Record<string, unknown>>;
  consults: Array<{
    consultationId: string;
    type?: string | null;
    status?: string | null;
    diagnosis?: string | null;
    chiefComplaint?: string | null;
    servicePrice?: number | null;
    scheduledAt?: string | null;
    createdAt?: string | null;
    outstandingResults?: number;
  }>;
  prescriptions: Array<{
    prescriptionId: string;
    status?: string | null;
    workflowStatus?: string | null;
    medicationCount?: number;
    createdAt?: string | null;
  }>;
  orders: Array<{
    orderId: string;
    status?: string | null;
    priority?: string | null;
    testCount?: number;
    createdAt?: string | null;
  }>;
  outstandingResults: number;
}

export interface PracticeResultRow {
  resultId: string;
  consultationId: string;
  testName: string;
  status?: string | null;
  abnormal?: boolean | null;
  criticalFlag?: boolean | null;
  releasedAt?: string | null;
  addedAt?: string | null;
  acknowledged: boolean;
}

export interface PracticeInviteRow {
  inviteId: string;
  practiceId: string;
  channelHint: PracticeInviteChannel;
  label?: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt?: string | null;
  revoked: boolean;
  revokedAt?: string | null;
  usable: boolean;
  unusableReason?: string | null;
  createdBy?: string;
  createdAt?: string | null;
}

export interface PracticeInviteCreated {
  invite: PracticeInviteRow;
  /** Returned EXACTLY once, at creation. Never retrievable again. */
  token: string;
  inviteUrl: string;
}

export interface PracticeInviteFunnel {
  sent: number;
  opened: number;
  joined: number;
  converted: number;
}

export interface PracticeEarnings {
  wallet: { balance: number; currency: string };
  totals: {
    settled: number;
    processorCost: number;
    withdrawn: number;
    refunded: number;
    otherCredits: number;
    otherDebits: number;
    netLedger: number;
    settledConsultations: number;
    refundedConsultations: number;
  };
  currency: string;
  /** Docarion's cut of a practice consultation fee. Zero, stated not implied. */
  platformFeePercentage: number;
}

/** What the settlement engine actually deducted, so a receipt can itemise it. */
export interface PracticeSettlementBreakdown {
  fee: number;
  platformFeePercentage: number;
  platformFeeAmount: number;
  processorCost: number;
  /** 'wallet' funding costs nothing to process — the money is already on-platform. */
  processorFundingMethod?: string | null;
  credited: number;
  currency?: string;
}

export interface PracticeLedgerRow {
  transactionId: string;
  type?: 'credit' | 'debit' | null;
  category?: string | null;
  amount: number;
  referenceId?: string | null;
  referenceType?: string | null;
  description?: string | null;
  balanceAfter?: number | null;
  billingScenario?: string | null;
  /** The processor cost passed through on this settlement. */
  processorCost?: number | null;
  settlementBreakdown?: PracticeSettlementBreakdown | null;
  createdAt?: string | null;
}

export interface PracticeWithdrawalRow {
  withdrawalId: string;
  amount: number;
  fee: number;
  netAmount: number;
  status?: string | null;
  bankCode?: string | null;
  accountNumberLast4?: string | null;
  accountName?: string | null;
  rejectionReason?: string | null;
  createdAt?: string | null;
  processedAt?: string | null;
  /** True once the wallet has actually been debited for this request. */
  walletDebited?: boolean;
}

export interface PracticeReceipt {
  invoiceNumber?: string | null;
  issuedAt?: string | null;
  practice: { practiceId: string; name: string; slug: string };
  consultation: { consultationId: string; patientId?: string | null; type?: string | null; status?: string | null; completedAt?: string | null };
  currency: string;
  /**
   * `platformFeePercentage` is 0 (the one publicly-statable figure) or null —
   * the server withholds any other rate (BUSINESS_MODEL.md). Never render a
   * percentage that is not literally 0.
   */
  amounts: { fee: number; platformFeePercentage: number | null; platformFeeAmount: number; processorCost: number; credited: number; refunded: number };
  lines: Array<{ key: string; label: string; amount: number; sign: 1 | -1 }>;
  settlement: { status: string; settledAt?: string | null; fundingMethod?: string | null; projected: boolean };
  /** Server-authored explanation lines. Rendered verbatim. */
  notes: string[];
}

export interface PracticeScopeOption {
  value: PracticeRecordScope;
  label: string;
  description: string;
  isDefault: boolean;
}

export interface PracticeInviteVerification {
  practice: PracticePublic;
  doctorName?: string | null;
  mdcnRegistrationNumber?: string | null;
  scopeOptions: PracticeScopeOption[];
  defaultRecordScope: PracticeRecordScope;
  /** Consent copy authored server-side (verified facts only). Render verbatim. */
  disclosure: {
    title: string;
    who: string;
    whatByDefault: string;
    whatIfFullRecord: string;
    revocable: string;
    consentDurationDays: number;
  };
  expiresAt?: string | null;
}

export interface PracticeRedemption {
  membershipId: string;
  practiceId: string;
  patientId: string;
  status: string;
  recordScope: PracticeRecordScope;
  accountCreated?: boolean;
  refreshed?: boolean;
  practice?: PracticePublic;
  /** Only issued when redemption CREATED the account. */
  tokens?: AuthTokens | null;
}

/** A patient's membership of one practice ("My doctors"). */
export interface PracticeMembership {
  membershipId: string;
  practiceId: string;
  status: PracticeMembershipStatus;
  recordScope: PracticeRecordScope;
  joinedVia?: string | null;
  joinedAt?: string | null;
  revokedAt?: string | null;
  archivedAt?: string | null;
  lastContactAt?: string | null;
  practice: PracticePublic | null;
}

/** The `meta` block the practice list endpoints return alongside `data`. */
export interface PracticeListMeta {
  limit?: number;
  offset?: number;
  count?: number;
  hasMore?: boolean;
  status?: string;
  /** The roll-ups are bounded scans; `*Truncated` says so honestly. */
  rollupScanned?: number;
  rollupTruncated?: boolean;
  searchScope?: string | null;
  countsByStatus?: Record<string, number>;
  eventsScanned?: number;
  truncated?: boolean;
  ledgerTruncated?: boolean;
  consultationsTruncated?: boolean;
  byStatusOnPage?: Record<string, { count: number; amount: number }>;
  unresolvedEntries?: number;
}

export interface PracticePage<T> {
  data?: T;
  meta?: PracticeListMeta;
  message?: string;
}

/** Paged GET returning the `{ data, meta }` envelope. */
function practicePage<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
  return api.requestFull<T>(path, { method: 'GET', query }) as Promise<PracticePage<T>>;
}

export const practiceApi = {
  // ── Doctor: onboarding + practice ──
  /**
   * The onboarding entry point AND the "do I have a practice" probe. Never 404s
   * for a doctor with no practice — it returns nulls plus the gate checklist.
   */
  me: () => api.get<PracticeMe>('/practice/me'),
  dashboard: (practiceId: string) => api.get<PracticeDashboard>(`/practice/${practiceId}/dashboard`),

  // ── Doctor: panel + patient folder ──
  panel: (practiceId: string, query?: { status?: string; q?: string; limit?: number; offset?: number }) =>
    practicePage<PracticePanelRow[]>(`/practice/${practiceId}/panel`, query),
  folder: (practiceId: string, patientId: string) =>
    api.get<PracticeFolder>(`/practice/${practiceId}/panel/${patientId}`),
  results: (practiceId: string, patientId: string) =>
    api.get<PracticeResultRow[]>(`/practice/${practiceId}/panel/${patientId}/results`),
  acknowledgeResult: (practiceId: string, patientId: string, resultId: string, note?: string) =>
    api.post<{ resultId: string; acknowledged: boolean; acknowledgedAt?: string | null; alreadyAcknowledged?: boolean }>(
      `/practice/${practiceId}/panel/${patientId}/results/${resultId}/acknowledge`,
      note ? { note } : undefined,
    ),
  archivePatient: (practiceId: string, patientId: string) =>
    api.requestFull<{ membershipId: string; patientId: string; status: string }>(
      `/practice/${practiceId}/panel/${patientId}/archive`,
      { method: 'POST' },
    ),

  // ── Doctor: invites ──
  /** Mints an invite. The raw `token` + `inviteUrl` come back ONCE — show them now. */
  createInvite: (practiceId: string, body?: { channelHint?: PracticeInviteChannel; label?: string; maxUses?: number; expiresInDays?: number }) =>
    api.post<PracticeInviteCreated>(`/practice/${practiceId}/invites`, body ?? {}),
  invites: (practiceId: string, query?: { limit?: number; offset?: number }) =>
    practicePage<PracticeInviteRow[]>(`/practice/${practiceId}/invites`, query),
  revokeInvite: (practiceId: string, inviteId: string) =>
    api.post<PracticeInviteRow>(`/practice/${practiceId}/invites/${inviteId}/revoke`),
  inviteFunnel: (practiceId: string) =>
    practicePage<PracticeInviteFunnel>(`/practice/${practiceId}/invites/analytics`),

  // ── Doctor: earnings ──
  earnings: (practiceId: string) => api.get<PracticeEarnings>(`/practice/${practiceId}/earnings`),
  ledger: (practiceId: string, query?: { limit?: number; offset?: number }) =>
    practicePage<PracticeLedgerRow[]>(`/practice/${practiceId}/earnings/ledger`, query),
  withdrawals: (practiceId: string, query?: { limit?: number; offset?: number }) =>
    practicePage<PracticeWithdrawalRow[]>(`/practice/${practiceId}/earnings/withdrawals`, query),
  receipt: (practiceId: string, consultationId: string) =>
    api.get<PracticeReceipt>(`/practice/${practiceId}/consultations/${consultationId}/receipt`),
  /**
   * Request a payout against the practice wallet. The shared withdrawal rail
   * requires the FULL account number; the practice only ever discloses the last
   * 4, so the doctor confirms it by typing it.
   */
  requestWithdrawal: (body: { facilityId: string; amount: number; bankCode: string; accountNumber: string; accountName: string }) =>
    api.post<PracticeWithdrawalRow>('/withdrawals', body),

  // ── Patient: "My doctors" ──
  myPractices: (query?: { status?: string; limit?: number; offset?: number }) =>
    practicePage<PracticeMembership[]>('/my-practices', query),
  /** Ends the doctor's access. Their records stay in the patient's own record. */
  revokeMembership: (membershipId: string) =>
    api.requestFull<{ membershipId: string; status: string; revokedAt?: string | null; alreadyRevoked?: boolean }>(
      `/my-practices/${membershipId}/revoke`,
      { method: 'POST' },
    ),
  setMembershipScope: (membershipId: string, recordScope: PracticeRecordScope) =>
    api.requestFull<{ membershipId: string; recordScope: PracticeRecordScope; previousScope?: PracticeRecordScope | null }>(
      `/my-practices/${membershipId}/scope`,
      { method: 'PATCH', body: { recordScope } },
    ),

  // ── Public: invite verify + redeem (no auth) ──
  verifyInvite: (token: string) =>
    api.get<PracticeInviteVerification>(`/practice-invites/${encodeURIComponent(token)}/verify`, undefined, { auth: false }),
  /** Redeem as an already-signed-in patient. */
  redeemInvite: (token: string, body: { recordScope: PracticeRecordScope; consentAccepted: true }) =>
    api.requestFull<PracticeRedemption>(`/practice-invites/${encodeURIComponent(token)}/redeem`, {
      method: 'POST',
      body,
    }),
  /** Redeem while creating the patient account in the same step. */
  redeemInviteWithNewAccount: (token: string, body: {
    recordScope: PracticeRecordScope;
    consentAccepted: true;
    email: string;
    phone: string;
    password: string;
    firstName: string;
    lastName: string;
  }) =>
    api.requestFull<PracticeRedemption>(`/practice-invites/${encodeURIComponent(token)}/redeem`, {
      method: 'POST',
      body,
      auth: false,
    }),
};

// ════════════════════════════════════════════════════════════════════════════
// Independent Practice — self-serve doctor SIGNUP + the onboarding wizard
//
// Appended (append-only convention) rather than folded into `practiceApi`
// above, because these are a different surface: `practiceApi` is the workspace
// of a doctor who already HAS a practice, while everything here belongs to
// someone who does not have one yet.
//
// The account `signup` creates is deliberately inert — no facility, no clinical
// permission, no place in any doctor pool — until a Docarion reviewer approves
// the Practice Verification. See backend/src/services/practice-signup.service.ts.
//
// Every route here answers 503 `INDEPENDENT_PRACTICE_DISABLED` while the module
// is dark; treat that as "not available on this deployment", not an error.
// ════════════════════════════════════════════════════════════════════════════

export type PracticeOnboardingState =
  | 'started' | 'email_verified' | 'in_progress' | 'submitted' | 'provisioned' | 'rejected';

export interface PracticeSignupResult {
  user: User;
  tokens: AuthTokens;
  expiresIn?: number;
  /** Always true: onboarding cannot proceed until the address is confirmed. */
  emailVerificationRequired: true;
  practiceOnboardingState: PracticeOnboardingState;
}

/** The MDCN registration as CAPTURED — a claim, until a reviewer checks it. */
export interface PracticeCredentialDraft {
  registrationNumber: string | null;
  authority: string | null;
  expiresAt?: string | null;
  folio?: string | null;
  capturedAt?: string | null;
  /** Always 'claimed' — deliberately not a verification status. */
  verificationStatus: 'claimed';
}

/** `GET /practice/me` for a self-serve applicant (superset of `PracticeMe`). */
export interface PracticeApplicantMe extends PracticeMe {
  credentialDraft?: PracticeCredentialDraft | null;
  applicant?: {
    isApplicant: boolean;
    emailVerified: boolean;
    practiceOnboardingState: PracticeOnboardingState;
  };
}

/** One priced consultation mode on the practice's fee schedule. */
export interface PracticeServiceFee {
  serviceCode: string;
  label: string;
  mode: 'chat' | 'video' | 'in_person' | 'home_visit' | 'follow_up';
  /** Naira. 0 is legal — a doctor may see friends and family free of charge. */
  price: number;
  currency: 'NGN';
  active: boolean;
}

export interface PracticeAgreementDoc {
  contractType: string;
  version: string;
  title: string;
  sections: Array<{ heading: string; body: string }>;
  signed?: boolean;
}

export interface PracticeSlugCheck {
  slug: string;
  valid: boolean;
  available: boolean;
  suggestion: string;
}

export const practiceSignupApi = {
  /**
   * Unauthenticated capability probe for the pre-login landing screen. Throws
   * an ApiError with `code === PRACTICE_DISABLED_CODE` while the module is dark
   * — the caller should then hide the practice path entirely rather than show
   * an error, exactly as `usePractice.ts` does for the authenticated 503.
   */
  availability: () => api.get<{ enabled: boolean }>('/practice/availability', undefined, { auth: false }),

  /** Create the (inert) applicant account. Unauthenticated by design. */
  signup: (body: {
    email: string;
    password: string;
    phone: string;
    profile: { firstName: string; lastName: string; middleName?: string };
    referralSource?: string;
  }) => api.post<PracticeSignupResult>('/auth/practice-signup', body, { auth: false }),

  /** Silent about whether the account exists. */
  resendVerification: (email: string) =>
    api.post<{ message?: string }>('/auth/practice-signup/resend-verification', { email }, { auth: false }),
};

export const practiceOnboardingApi = {
  /** Applicant-aware probe. Same path as `practiceApi.me`, wider shape. */
  me: () => api.get<PracticeApplicantMe>('/practice/me'),

  slugAvailable: (slug: string) =>
    api.get<PracticeSlugCheck>('/practice/slug-available', { slug }),

  /** Practice profile + fee schedule. Every field optional; merges server-side. */
  saveDraft: (body: {
    name?: string;
    slug?: string;
    specialty?: string | null;
    bio?: string | null;
    photo?: string | null;
    feeSchedule?: PracticeServiceFee[];
  }) => api.post<PracticeOnboardingView>('/practice/onboarding', body),

  /** Captures the MDCN number as a CLAIM; a reviewer verifies it later. */
  saveCredential: (body: { registrationNumber: string; expiresAt: string; folio?: string }) =>
    api.post<{ credentialDraft: PracticeCredentialDraft; note: string }>(
      '/practice/onboarding/credential', body,
    ),

  savePayout: (body: { bankCode: string; accountNumber: string }) =>
    api.post<{ payout: PracticePayoutView | null; note: string }>('/practice/onboarding/payout', body),

  agreement: () => api.get<PracticeAgreementDoc>('/practice/agreement'),

  signAgreement: (body: { version: string; accepted: true; fullName: string }) =>
    api.post<{ signatureId: string; version: string; signedAt: string }>('/practice/agreement/sign', body),

  /** Hands the application to the existing admin verification queue. */
  submit: () => api.post<{ verificationId: string; status: string }>('/practice/onboarding/submit', {}),
};

// ============================================================================
// Wallet hardening (Wave 2, 2026-07-30)
// Facility/practice money surfaces from `backend/docs/wallet-gap-analysis.md` §5.2.
// Additive: `walletApi` above is unchanged, and so is every existing caller.
// ============================================================================

export interface FacilityBankAccount {
  accountId: string;
  facilityId: string;
  bankCode: string;
  bankName?: string | null;
  /** The full number never leaves the server. */
  accountNumberMasked: string;
  accountName: string;
  verified: boolean;
  isDefault: boolean;
  createdAt?: string | null;
}

export interface FacilityWalletFunding {
  authorizationUrl: string;
  txRef: string;
  transactionId: string;
  amount: number;
  currency?: string;
}

export interface FacilityWalletFundingResult {
  status: 'successful' | 'failed' | 'pending' | string;
  amount: number;
  balance: number;
  currency?: string;
}

export interface FacilityWalletState {
  facilityId?: string;
  balance: number;
  currency?: string;
  totalCredits?: number;
  totalDebits?: number;
  [key: string]: unknown;
}

/**
 * Facility-admin money surface. A facility tops itself up (prepaid platform
 * services / add-on auto-collection float), saves payout accounts once, and
 * withdraws earnings against a saved account so the payout NAME always comes
 * from the bank rather than from whatever the client typed.
 */
export const facilityWalletApi = {
  get: (facilityId: string) => api.get<FacilityWalletState>(`/facility-wallets/${facilityId}`),
  transactions: (facilityId: string, params?: { limit?: number; category?: string }) =>
    api.get<WalletTransaction[]>(`/facility-wallets/${facilityId}/transactions`, params),

  /** Opens a Paystack checkout; verify after the browser session returns. */
  fund: (facilityId: string, amount: number) =>
    api.post<FacilityWalletFunding>(`/facility-wallets/${facilityId}/fund`, { amount }),
  /** Idempotent — safe to call even if the webhook already credited the wallet. */
  verifyFunding: (facilityId: string, txRef: string) =>
    api.get<FacilityWalletFundingResult>(
      `/facility-wallets/${facilityId}/fund/verify/${encodeURIComponent(txRef)}`,
    ),

  bankAccounts: (facilityId: string) =>
    api.get<FacilityBankAccount[]>(`/facility-wallets/${facilityId}/bank-accounts`),
  addBankAccount: (facilityId: string, body: { bankCode: string; accountNumber: string; bankName?: string; isDefault?: boolean }) =>
    api.post<FacilityBankAccount>(`/facility-wallets/${facilityId}/bank-accounts`, body),
  removeBankAccount: (facilityId: string, accountId: string) =>
    api.del<{ message?: string }>(`/facility-wallets/${facilityId}/bank-accounts/${accountId}`),
};

export interface FacilityWithdrawal {
  withdrawalId: string;
  facilityId?: string;
  amount: number;
  fee?: number;
  netAmount?: number;
  accountName?: string;
  bankCode?: string;
  accountNumber?: string;
  status: string;
  createdAt?: string;
}

export const facilityWithdrawalApi = {
  list: (facilityId: string) => api.get<FacilityWithdrawal[]>(`/withdrawals/facility/${facilityId}`),
  /**
   * `bankAccountId` (a saved, verified account) is preferred; the inline
   * bankCode/accountNumber/accountName trio remains supported unchanged.
   */
  request: (body: {
    facilityId?: string;
    amount: number;
    bankAccountId?: string;
    bankCode?: string;
    accountNumber?: string;
    accountName?: string;
  }) => api.post<FacilityWithdrawal>('/withdrawals', body),
  /**
   * Payout rules, read from the server rather than restated in the app.
   *
   * `withdraw.tsx` hard-coded "₦100 flat · Minimum ₦5,000" as client literals
   * that could drift silently from `withdrawal.routes.ts`, where the values
   * actually live and are actually enforced. `GET /withdrawals/config` returns
   * the same two constants the handler uses, so a change on the server can
   * never leave the app quoting a stale figure to a facility.
   */
  config: () =>
    api.get<{ minimum: number; fee: number; currency: string }>('/withdrawals/config'),
};

/**
 * `POST /wallet/pay` answers 402 `FUNDS_FROZEN` when a chargeback hold would be
 * broken by the debit. That is NOT "insufficient funds" — the money is there but
 * legally held — so it deserves its own message rather than "top up your wallet".
 */
export function frozenFundsMessage(err: unknown): string | null {
  const e = err as { status?: number; code?: string; data?: Record<string, unknown> } | null;
  if (!e || e.status !== 402 || e.code !== 'FUNDS_FROZEN') return null;
  const frozen = Number(e.data?.frozenAmount);
  const available = Number(e.data?.availableBalance);
  const money = (n: number) => `₦${n.toLocaleString('en-NG')}`;
  if (Number.isFinite(frozen) && Number.isFinite(available)) {
    return `${money(frozen)} of your balance is on hold pending a payment dispute. You can spend ${money(available)} right now.`;
  }
  return 'Part of your balance is on hold pending a payment dispute.';
}

// ── Facility group / site manager (W4.1) ────────────────────────────────────
//
// Multi-facility group console — the backend's `/facility-groups` routes
// (facility-group.routes.ts) are gated to platform admins (`admin`,
// `super_admin`) and group admins (platform admin with a `groupAdminOf`
// claim). A group admin can read/manage all facilities in their group and
// nothing outside it. Only full platform admins create groups / assign group
// admins. These mobile endpoints mirror that surface for the Pro app's
// facility console.

export interface FacilityGroup {
  groupId: string;
  name: string;
  type?: string;
  status?: string;
  billingRollup?: boolean;
  ownerUserId?: string;
  facilityIds?: string[];
  groupAdminIds?: string[];
  createdBy?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
}

export interface GroupRollup {
  groupId: string;
  name?: string;
  type?: string;
  status?: string;
  billingRollup?: boolean;
  totalFacilities?: number;
  totalStaff?: number;
  totalRevenue?: number;
  totalConsultations?: number;
  totalPatients?: number;
  claimsSubmitted?: number;
  claimsApproved?: number;
  claimsAmount?: number;
  perFacility?: Array<{
    facilityId: string;
    facilityName?: string;
    staff?: number;
    revenue?: number;
    consultations?: number;
    patients?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface GroupAlerts {
  groupId: string;
  lowStockItems: number;
  expiringItems: number;
  facilities: Array<{
    facilityId: string;
    facilityName?: string;
    lowStock?: number;
    expiring?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Facility group operations — multi-facility site/group manager console.
 *
 * All endpoints mirror `/facility-groups` on the backend, which is gated to
 * platform admins and group admins. The mobile client is defense-in-depth only;
 * server authorization remains authoritative.
 */
export const facilityGroupApi = {
  /** List facility groups (platform admin: all; group admin: own only). */
  list: (query?: { status?: string; limit?: number; offset?: number }) =>
    api.get<FacilityGroup[]>('/facility-groups', query),
  /** Get a single facility group by ID (scoped to caller's access). */
  get: (groupId: string) =>
    api.get<FacilityGroup>(`/facility-groups/${groupId}`),
  /** Update group metadata (name, type, billingRollup, status). */
  update: (groupId: string, body: Partial<Pick<FacilityGroup, 'name' | 'type' | 'billingRollup' | 'status'>>) =>
    api.patch<FacilityGroup>(`/facility-groups/${groupId}`, body),
  /** Add a member facility to a group (exclusivity checked server-side). */
  addFacility: (groupId: string, facilityId: string) =>
    api.post<Record<string, unknown>>(`/facility-groups/${groupId}/facilities`, { facilityId }),
  /** Remove a member facility from a group. */
  removeFacility: (groupId: string, facilityId: string) =>
    api.del(`/facility-groups/${groupId}/facilities/${facilityId}`),
  /** Combined totals + per-facility comparison rollup. */
  rollup: (groupId: string) =>
    api.get<GroupRollup>(`/facility-groups/${groupId}/rollup`),
  /** Low-stock + expiry alerts rollup across the group. */
  alerts: (groupId: string) =>
    api.get<GroupAlerts>(`/facility-groups/${groupId}/alerts`),
};

// ── W4: Who can see my records (patient-owned record transparency) ─────────
// Separate append-only block. Mirrors frontend `recordAccessApi`.
export interface MyRecordShare {
  shareId: string;
  status: string | null;
  /** `active` | `pending_patient_consent` | `revoked` | `declined` | `expired` */
  effectiveStatus: string;
  source: string;
  referralId: string | null;
  targetFacilityId: string | null;
  targetFacilityName: string | null;
  targetProviderId: string | null;
  targetProviderName: string | null;
  hasExplicitTarget: boolean;
  recordTypes: string[];
  createdAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  canRevoke: boolean;
  awaitingYourConsent: boolean;
}

export interface MyConsentGrant {
  requestId: string;
  status: string;
  facilityId: string | null;
  facilityName: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  purpose: string | null;
  source: string | null;
  requestedAt: string | null;
  respondedAt: string | null;
  expirationDate: string | null;
  manageVia: 'withdraw' | 'my_doctors';
}

export interface MyRecordAccessEvent {
  logId: string;
  action: string | null;
  accessorRole: string | null;
  accessedBy: string | null;
  accessorName: string | null;
  facilityId: string | null;
  facilityName: string | null;
  timestamp: string | null;
}

export interface MyRecordAccessOverview {
  shares: MyRecordShare[];
  approvedConsents: MyConsentGrant[];
  pendingConsents: MyConsentGrant[];
  standingAccess: {
    facilities: Array<{ facilityId: string; facilityName: string | null }>;
    notes: Record<'ownFacility' | 'platformDoctor' | 'platformAdmins' | 'privatePractice' | 'shares', string>;
  };
  recentAccess: MyRecordAccessEvent[];
  recentAccessScope: string;
}

export const recordAccessApi = {
  /** GET /ehr/me/access — shares, approvals, standing access, recent access. */
  getOverview: () => api.get<MyRecordAccessOverview>('/ehr/me/access'),
  /** Approve a referral share awaiting your consent (it becomes readable, expiry starts now). */
  approveShare: (shareId: string) => api.post(`/ehr/me/shares/${encodeURIComponent(shareId)}/approve`),
  /** Decline a referral share awaiting your consent. */
  declineShare: (shareId: string) => api.post(`/ehr/me/shares/${encodeURIComponent(shareId)}/decline`),
  /** Revoke a share you own (active or awaiting consent). */
  revokeShare: (patientId: string, shareId: string) =>
    api.del(`/ehr/patients/${encodeURIComponent(patientId)}/share/${encodeURIComponent(shareId)}`),
  /** Withdraw a facility access request you previously approved. */
  withdrawConsent: (requestId: string, reason?: string) =>
    api.post(`/consent/${encodeURIComponent(requestId)}/withdraw`, reason ? { reason } : {}),
};

// ── W6: independent-practice owner settings (append-only) ──────────────────
// Post-approval fee editing. Same server validator as onboarding
// (`sanitizeFeeSchedule`); consult billing always prices from what is stored.

export type PracticeFeeMode = 'chat' | 'video' | 'in_person' | 'home_visit' | 'follow_up';

export interface PracticeFeeScheduleEntry {
  serviceCode?: string;
  label: string;
  mode: PracticeFeeMode;
  /** Naira. 0 is allowed (free). */
  price: number;
  currency?: 'NGN';
  active: boolean;
}

export interface PracticeOwnerSettings {
  practiceId: string;
  name: string;
  slug: string;
  status: string;
  feeSchedule: PracticeFeeScheduleEntry[];
  operatingHours: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { open: string; close: string } | null>;
  appointmentDuration: number;
  canEdit: boolean;
}

export const practiceSettingsApi = {
  get: (practiceId: string) => api.get<PracticeOwnerSettings>(`/practice/${encodeURIComponent(practiceId)}/settings`),
  saveFeeSchedule: (practiceId: string, feeSchedule: PracticeFeeScheduleEntry[]) =>
    api.put<{ feeSchedule: PracticeFeeScheduleEntry[] }>(
      `/practice/${encodeURIComponent(practiceId)}/fee-schedule`,
      { feeSchedule },
    ),
};

// ════════════════════════════════════════════════════════════════════════════
// Mobile role-gap fixes (mobile role audit 2026-10-23, branch feat/mobilegaps).
// Kept together, one commented block per audit item, to ease merging.
// ════════════════════════════════════════════════════════════════════════════

// ── M-P2: support escalation summary (read-only, non-clinical) ─────────────
// GET /escalations/platform/summary — support + platform admins. Rows carry
// facility, status, age, tier and assignee ONLY (no summary text, alert type,
// patient or encounter ids).
export interface EscalationSupportSummaryRow {
  instanceId: string;
  facilityId: string;
  facilityName: string | null;
  status: 'open' | 'acknowledged';
  openedAt: string | null;
  ageMinutes: number | null;
  /** 1-based tier reached; null while no tier has fired yet. */
  tier: number | null;
  tierCount: number;
  assignee: { kind: string; label: string } | null;
}

export const escalationSummaryApi = {
  platform: () => api.get<EscalationSupportSummaryRow[]>('/escalations/platform/summary'),
};

// ── M-P3: customer service referral status lookup (read-only) ──────────────
// POST /referrals/status-lookup — customer_service, cs_admin, support and
// platform admins. Exactly one of reference / mrn / phone, sent in the BODY so
// it never enters a URL. Rows carry reference, status, facilities and dates
// only (no patient name, reason or clinical summary). Rate limited + audited.
export type ReferralLookupQuery = { reference: string } | { mrn: string } | { phone: string };

export interface ReferralStatusRow {
  referralId: string;
  reference: string | null;
  status: string;
  trackingStatus: string;
  fromFacilityName: string | null;
  toFacilityName: string | null;
  /** True for an open (marketplace) referral with no receiving facility yet. */
  openReferral: boolean;
  createdAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export const referralLookupApi = {
  lookup: (query: ReferralLookupQuery) => api.post<ReferralStatusRow[]>('/referrals/status-lookup', query),
};

// ── M-P12: care-team inbox assignable staff ────────────────────────────────
// GET /staff/care-team/assignable-staff — the roles that may assign a thread
// (nurse, facility admins, cs_admin, platform admins). Same-facility staff
// only; a cs_admin sees the customer service team only. No contact details.
export interface AssignableStaffMember {
  userId: string;
  displayName: string;
  role: string;
}

export const careTeamAssignApi = {
  assignableStaff: () => api.get<AssignableStaffMember[]>('/staff/care-team/assignable-staff'),
};

// ── M-P7 / M-P8: "choose a facility first" for platform principals ─────────
// Owner rule: a platform principal sees a facility's records only after
// picking that facility (POST /platform/facility-context, audited, 8 h).
// The facility directory is GET /admin/facilities (platform admins).
export interface PlatformFacilityContext {
  facilityId: string;
  facilityName?: string | null;
  facilityType?: string | null;
  reason: string;
  selectedAt: string;
  expiresAt: string;
}

export const platformFacilityContextApi = {
  get: () => api.get<PlatformFacilityContext | null>('/platform/facility-context'),
  select: (facilityId: string, reason: string) =>
    api.post<PlatformFacilityContext>('/platform/facility-context', { facilityId, reason }),
  clear: () => api.del<null>('/platform/facility-context'),
};

export const platformFacilityDirectoryApi = {
  list: (query: { type?: string; status?: string; limit?: number }) =>
    api.get<Record<string, unknown>[]>('/admin/facilities', query),
};

// ── M-P8: facility money screens for platform finance readers ──────────────
// GET /facility-wallets — every facility wallet (platform admins and the
// platform accountant only). Used as the "choose a facility" list for the
// accountant, who cannot read the admin facility directory.
export const facilityWalletDirectoryApi = {
  list: () => api.get<Array<Record<string, unknown>>>('/facility-wallets'),
};

// ── Docarion Training (/academy) — learner side ─────────────────────────────
// backend/src/routes/academy.routes.ts. Internal training for medicine store
// (PPMV) owners and staff. Only the learner calls live here: staff and admin
// academy work stays on the web console. Quiz and exam questions arrive
// WITHOUT answers; the server grades, rate-limits and times everything.

export type AcademyApplicationStatus =
  | 'applied'
  | 'intake_checked'
  | 'approved'
  | 'enrolled'
  | 'assessed'
  | 'certified'
  | 'rejected'
  | 'withdrawn'
  | 'expired'
  | 'revoked';

export interface AcademyCompletion {
  lessonsDone: number;
  lessonsTotal: number;
  quizzes: Array<{ moduleId: string; title: string; best: number | null; passMark: number; passed: boolean }>;
  finalExam: { best: number | null; passMark: number; passed: boolean };
  practicals: Array<{ moduleId: string; title: string; required: boolean; signedOff: boolean }>;
  readyForFinalExam: boolean;
  complete: boolean;
  missing: string[];
}

export interface AcademyApplication {
  applicationId: string;
  userId: string;
  learnerDisplayName: string;
  courseId: string;
  courseTitle: string;
  status: AcademyApplicationStatus;
  nominatedBy: string | null;
  nominatedByName: string | null;
  enrollmentId: string | null;
  certificateId: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcademyCourseCard {
  courseId: string;
  versionId: string;
  version: number;
  title: string;
  summary: string;
  level: string;
  audience: string[];
  disclaimer: string;
  passMark: number;
  certificateValidityMonths: number;
  moduleCount: number;
  lessonCount: number;
  totalMinutes: number;
}

export interface AcademyCertificate {
  certificateId: string;
  learnerDisplayName: string;
  courseTitle: string;
  courseId: string;
  courseVersion: number;
  issuedAt: string;
  expiresAt: string;
  status: string;
  text: string;
  /** Path on the web app, e.g. /academy/verify/DTC-… */
  verificationPath: string;
  revokedAt: string | null;
}

export interface AcademyEnrollmentSummary {
  enrollmentId: string;
  applicationId: string;
  courseId: string;
  courseTitle: string;
  versionId: string;
  cohort: string | null;
  status: string;
  enrolledAt: string;
  completion: AcademyCompletion | null;
}

export interface AcademyMe {
  learner: { eligible: boolean; reason?: string; code?: string };
  canNominate: boolean;
  staff: { isStaff: boolean; permissions: string[]; isSuperAdmin?: boolean };
  applications: AcademyApplication[];
  enrollments: AcademyEnrollmentSummary[];
  certificates: AcademyCertificate[];
}

export interface AcademyNominee {
  userId: string;
  displayName: string;
  role: string;
}

export interface AcademyModuleOutline {
  moduleId: string;
  order: number;
  title: string;
  outcomes: string[];
  lessons: Array<{ lessonId: string; order: number; title: string; minutes: number }>;
  quiz: { passMark: number; questionCount: number };
  practical: { required: boolean; checklist: string[] };
}

export interface AcademyCourseOutline extends AcademyCourseCard {
  modules: AcademyModuleOutline[];
  finalExam: { passMark: number; questionCount: number; timeLimitMinutes: number; attemptsPerDay: number };
}

export interface AcademyEnrollmentDetail {
  enrollment: {
    enrollmentId: string;
    applicationId: string;
    status: string;
    applicationStatus: AcademyApplicationStatus | null;
    cohort: string | null;
    enrolledAt: string;
    lessonsDone: string[];
    moduleQuizBest: Record<string, number>;
    finalExamBest: number | null;
    practicalSignoffs: Record<string, { at: string; byName: string | null }>;
    certificateId: string | null;
  };
  course: AcademyCourseOutline;
  completion: AcademyCompletion;
}

export interface AcademyLessonSource {
  title: string;
  publisher: string;
  year?: number;
  url?: string;
}

export interface AcademyLesson {
  lessonId: string;
  order: number;
  title: string;
  minutes: number;
  bodyMarkdown: string;
  keyPoints: string[];
  sources: AcademyLessonSource[];
}

export interface AcademyModuleContent {
  moduleId: string;
  order: number;
  title: string;
  outcomes: string[];
  lessons: AcademyLesson[];
  quiz: { passMark: number; questionCount: number };
  practical: { required: boolean; checklist: string[] };
}

/** A question as the learner sees it: never carries the answer or explanation. */
export interface AcademyQuestion {
  questionId: string;
  type: string;
  difficulty: string;
  stem: string;
  options: Array<{ id: string; text: string }>;
}

export interface AcademyAttemptResult {
  questionId: string;
  correct: boolean;
  /** Only on a PASSED module quiz. */
  chosenId?: string | null;
  answerId?: string;
  explanation?: string;
  lessonId?: string;
  moduleId?: string | null;
}

export interface AcademyAttempt {
  attemptId: string;
  enrollmentId: string;
  kind: 'module_quiz' | 'final_exam';
  moduleId: string | null;
  status: 'in_progress' | 'submitted' | 'expired';
  startedAt: string;
  /** Server deadline for a timed final exam. */
  deadlineAt: string | null;
  timeLimitMinutes: number | null;
  passMark: number;
  questionCount: number;
  questions?: AcademyQuestion[];
  submittedAt?: string | null;
  score?: number | null;
  passed?: boolean;
  correct?: number | null;
  results?: AcademyAttemptResult[];
  /** After a failed module quiz: when the next try opens. */
  retryAfter?: string | null;
  /** The server returned an attempt that was already open (no new attempt used). */
  resumed?: boolean;
  /** Set on submit when the learner has now met every course requirement. */
  assessed?: boolean;
}

const academySeg = (id: string) => encodeURIComponent(String(id ?? ''));

export const academyApi = {
  /** Eligibility, applications, enrolments and certificates for the caller. */
  me: () => api.get<AcademyMe>('/academy/me'),
  /** Courses open for applications (403 for accounts that are not eligible). */
  courses: () => api.get<AcademyCourseCard[]>('/academy/courses'),
  /** Shop owners only: staff at their medicine store they may nominate. */
  nominees: () => api.get<AcademyNominee[]>('/academy/nominees'),
  apply: (body: { courseId: string; motivation?: string; nomineeUserId?: string }) =>
    api.post<AcademyApplication>('/academy/applications', body),
  withdraw: (applicationId: string, note?: string) =>
    api.post<AcademyApplication>(`/academy/applications/${academySeg(applicationId)}/withdraw`, note ? { note } : {}),
  enrollment: (enrollmentId: string) =>
    api.get<AcademyEnrollmentDetail>(`/academy/enrollments/${academySeg(enrollmentId)}`),
  module: (enrollmentId: string, moduleId: string) =>
    api.get<AcademyModuleContent>(`/academy/enrollments/${academySeg(enrollmentId)}/modules/${academySeg(moduleId)}`),
  completeLesson: (enrollmentId: string, lessonId: string) =>
    api.post<{ lessonsDone: string[]; assessed: boolean }>(
      `/academy/enrollments/${academySeg(enrollmentId)}/lessons/${academySeg(lessonId)}/complete`,
    ),
  /** Starts (or resumes) a module quiz. 429 ACADEMY_QUIZ_COOLDOWN after a fail. */
  startQuiz: (enrollmentId: string, moduleId: string) =>
    api.post<AcademyAttempt>(`/academy/enrollments/${academySeg(enrollmentId)}/modules/${academySeg(moduleId)}/quiz`),
  /** Starts (or resumes) the timed final exam. 429 ACADEMY_ATTEMPT_LIMIT when used up. */
  startFinalExam: (enrollmentId: string) =>
    api.post<AcademyAttempt>(`/academy/enrollments/${academySeg(enrollmentId)}/final-exam`),
  attempt: (attemptId: string) => api.get<AcademyAttempt>(`/academy/attempts/${academySeg(attemptId)}`),
  submitAttempt: (attemptId: string, answers: Record<string, string>) =>
    api.post<AcademyAttempt>(`/academy/attempts/${academySeg(attemptId)}/submit`, { answers }),
  certificate: (certificateId: string) =>
    api.get<AcademyCertificate>(`/academy/certificates/${academySeg(certificateId)}`),
};
