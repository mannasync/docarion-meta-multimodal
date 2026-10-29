'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Monitor,
  Smartphone,
  QrCode,
  Stethoscope,
  UserPlus,
  Send,
  ShieldCheck,
  Lock,
  Unlock,
  RefreshCw,
  CheckCircle2,
  Activity,
  MessageSquare,
  FileText,
  Settings,
  Video,
  Copy,
  ArrowRight,
  Phone,
  Sparkles,
  AlertCircle,
  HeartPulse,
  Thermometer,
  Wind,
  Weight,
} from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { withRoleGuard } from '@/components/shared/withRoleGuard';
import { useAuthStore } from '@/store/auth.store';
import api, { aiIntakeApi, adminApi } from '@/services/api';
import { toast } from 'react-toastify';
import { actionErrorMessage } from '@/lib/accessError';
import { MetaMultimodalScanner } from '@/components/ai/MetaMultimodalScanner';

type StationMode = 'assisted' | 'kiosk' | 'settings';
type IntakeMethod = 'ai_chat' | 'structured_hx' | 'multimodal_scan';

interface ChatMessage {
  id: string;
  sender: 'patient' | 'ai' | 'doctor' | 'staff' | 'system';
  text: string;
  timestamp: string;
}

interface ActiveStationSession {
  sessionId: string;
  consultationId: string;
  patientId?: string;
  patientName: string;
  maskedName: string;
  phone: string;
  walkInCode: string;
  isExistingAccount: boolean;
  intakeComplete: boolean;
  sentToDoctor: boolean;
}

interface CopilotData {
  differentials?: Array<{ name: string; likelihood: string; reasoning: string }>;
  suggestions?: Array<{ type: string; title: string; detail: string; priority: string }>;
  soapDraft?: { subjective: string; objective: string; assessment: string; plan: string };
  managementPlan?: string;
  nafdacVerifiedRx?: Array<{ drugName: string; dose: string; duration: string; drugClass: string; nafdacStatus: string }>;
  vernacularPatientSummary?: string;
}

interface CareStationConfig {
  enabled: boolean;
  assistedIntakeEnabled: boolean;
  kioskModeEnabled: boolean;
  allowedRoles: string[];
  /** PIN typed this session (sent on save; never returned by the server). */
  stationPin: string;
  /** Whether the facility has a saved Station Exit PIN (server never returns the PIN itself). */
  hasStationPin?: boolean;
  stationName?: string;
}

const SITE_ADMIN_ROLES = new Set([
  'pharmacy_admin',
  'clinic_admin',
  'hospital_admin',
  'care_home_admin',
  'admin',
  'super_admin',
]);

const CONFIGURABLE_ROLES = [
  { role: 'pharmacist', label: 'Pharmacist', desc: 'Pharmacy counter & clinical consultation booth' },
  { role: 'receptionist', label: 'Front Desk / Receptionist', desc: 'Outpatient check-in & assisted triage' },
  { role: 'nurse', label: 'Nurse / Triage Officer', desc: 'Nursing station vitals & Hx intake' },
  { role: 'midwife', label: 'Midwife', desc: 'Maternity & antenatal intake station' },
  { role: 'care_home_nurse', label: 'Care Home Nurse', desc: 'Resident assisted telehealth terminal' },
  { role: 'medicine_store_attendant', label: 'Counter Attendant', desc: 'PPMV / pharmacy walk-in assistance' },
];

function maskPatientName(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'P***';
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  const maskedFirst = first.charAt(0).toUpperCase() + '***';
  if (parts.length > 1) {
    return `${maskedFirst} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
  }
  return maskedFirst;
}

function CareStationPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  // No fake fallback facility: a station with no facility must not read or
  // write another tenant's config under a placeholder id.
  const facilityId = user?.facilityId || '';
  const isSiteAdmin = Boolean(user?.role && SITE_ADMIN_ROLES.has(user.role));

  // Mode state
  const [activeMode, setActiveMode] = useState<StationMode>('assisted');
  const [intakeMethod, setIntakeMethod] = useState<IntakeMethod>('ai_chat');

  // Admin & Kiosk Configuration state
  const [stationConfig, setStationConfig] = useState<CareStationConfig>({
    enabled: true,
    assistedIntakeEnabled: true,
    kioskModeEnabled: true,
    allowedRoles: ['pharmacist', 'receptionist', 'nurse', 'midwife', 'care_home_nurse', 'medicine_store_attendant'],
    stationPin: '',
    stationName: 'Care Station Terminal #1',
  });
  const [savingConfig, setSavingConfig] = useState(false);

  // Kiosk Lock State
  const [kioskPinSetup, setKioskPinSetup] = useState('');
  const [kioskLocked, setKioskLocked] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [unlockPinAttempt, setUnlockPinAttempt] = useState('');
  const [unlockError, setUnlockError] = useState('');

  // Step 1: Patient Lookup / Registration Form
  const [lookupForm, setLookupForm] = useState({
    phone: '',
    patientName: '',
    age: '',
    gender: 'female',
    chiefComplaint: '',
    triageCategory: 'routine',
  });
  const [lookingUp, setLookingUp] = useState(false);
  const [activeSession, setActiveSession] = useState<ActiveStationSession | null>(null);

  // Step 2: AI Chat & Structured Hx / Vitals State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);

  const [vitalsForm, setVitalsForm] = useState({
    bp: '',
    temp: '',
    hr: '',
    spo2: '',
    weight: '',
  });
  const [structuredHxForm, setStructuredHxForm] = useState({
    chiefComplaint: '',
    hpi: '',
    pmh: '',
    allergies: '',
    currentMedications: '',
  });
  const [savingHxVitals, setSavingHxVitals] = useState(false);

  // Step 3: Handoff & In-Terminal Doctor Session State
  const [handoffData, setHandoffData] = useState<{
    code: string;
    handoffToken?: string;
    handoffUrl: string;
    expiresAt?: string;
  } | null>(null);
  const [generatingHandoff, setGeneratingHandoff] = useState(false);

  const [terminalDoctorOpen, setTerminalDoctorOpen] = useState(false);
  const [terminalMessages, setTerminalMessages] = useState<ChatMessage[]>([]);
  const [terminalDoctorName, setTerminalDoctorName] = useState('On-Duty Telehealth Physician');
  const [terminalStatus, setTerminalStatus] = useState('waiting_doctor');
  const [terminalInput, setTerminalInput] = useState('');
  const [sendingTerminalMsg, setSendingTerminalMsg] = useState(false);

  // Meta Muse Wonder Co-Pilot State
  const [copilotData, setCopilotData] = useState<CopilotData | null>(null);
  const [loadingCopilot, setLoadingCopilot] = useState(false);

  // Sync mode with URL query parameter if provided
  useEffect(() => {
    const requestedMode = searchParams?.get('mode');
    if (requestedMode === 'kiosk') {
      setActiveMode('kiosk');
      setKioskLocked(true);
    } else if (requestedMode === 'settings' && isSiteAdmin) {
      setActiveMode('settings');
    }
  }, [searchParams, isSiteAdmin]);

  // Load facility Care Station configuration
  useEffect(() => {
    if (!facilityId || typeof adminApi?.getCareStationConfig !== 'function') return;
    let cancelled = false;
    Promise.resolve(adminApi.getCareStationConfig(facilityId))
      .then((res) => {
        if (cancelled || !res) return;
        const envelope = res.data?.data ?? res.data;
        // The server nests the settings under careStationConfig.
        const data = envelope?.careStationConfig ?? envelope;
        if (data && typeof data === 'object') {
          setStationConfig((prev) => ({
            ...prev,
            enabled: data.careStationEnabled ?? data.enabled ?? prev.enabled,
            assistedIntakeEnabled: data.assistedIntakeEnabled ?? prev.assistedIntakeEnabled,
            kioskModeEnabled: data.allowPatientTerminal ?? data.kioskModeEnabled ?? prev.kioskModeEnabled,
            allowedRoles: Array.isArray(data.enabledRoles) ? data.enabledRoles : (Array.isArray(data.allowedRoles) ? data.allowedRoles : prev.allowedRoles),
            hasStationPin: data.hasStationPin === true,
            stationName: data.stationName || prev.stationName,
          }));
        }
      })
      .catch(() => {
        // Keep safe defaults when offline or unconfigured
      });
    return () => {
      cancelled = true;
    };
  }, [facilityId]);

  // Reset all patient PHI state (used when ending a Kiosk session or starting a new patient)
  const resetPatientSessionState = () => {
    setLookupForm({
      phone: '',
      patientName: '',
      age: '',
      gender: 'female',
      chiefComplaint: '',
      triageCategory: 'routine',
    });
    setActiveSession(null);
    setChatMessages([]);
    setChatInput('');
    setVitalsForm({ bp: '', temp: '', hr: '', spo2: '', weight: '' });
    setStructuredHxForm({
      chiefComplaint: '',
      hpi: '',
      pmh: '',
      allergies: '',
      currentMedications: '',
    });
    setHandoffData(null);
    setTerminalDoctorOpen(false);
    setTerminalMessages([]);
    setTerminalInput('');
    setTerminalStatus('waiting_doctor');
    // AI differentials / red flags belong to the patient they were generated for.
    setCopilotData(null);
  };

  // Step 1 Handler: Patient Lookup by Phone / Walk-In Account Creation
  const handlePatientLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lookupForm.phone.trim()) {
      toast.warning('Please enter the patient phone number');
      return;
    }
    setLookingUp(true);
    try {
      const res = await aiIntakeApi.careStationPatientLookup({
        phone: lookupForm.phone.trim(),
        patientName: lookupForm.patientName.trim() || undefined,
        age: lookupForm.age ? Number(lookupForm.age) : undefined,
        gender: lookupForm.gender || undefined,
        chiefComplaint: lookupForm.chiefComplaint.trim() || undefined,
        triageCategory: lookupForm.triageCategory,
        createIfMissing: true,
      });
      const payload = res?.data?.data ?? res?.data ?? {};
      const resolvedName =
        payload.patientName ||
        payload.patient?.fullName ||
        (payload.patient?.firstName
          ? `${payload.patient.firstName} ${payload.patient.lastName || ''}`.trim()
          : '') ||
        lookupForm.patientName.trim() ||
        'Walk-In Patient';
      // The lookup only finds/creates the patient. Open the real intake
      // session on the server; its id (also the consultation id) and desk
      // code are what every later step must use.
      const walkInRes = await aiIntakeApi.registerWalkIn({
        patientName: resolvedName,
        phone: lookupForm.phone.trim(),
        age: lookupForm.age ? Number(lookupForm.age) : undefined,
        gender: lookupForm.gender || undefined,
        chiefComplaint: lookupForm.chiefComplaint.trim() || undefined,
        triageCategory: lookupForm.triageCategory,
      });
      const walkIn = walkInRes?.data?.data ?? {};
      if (!walkIn.id) throw new Error('intake session was not created');
      const sessionId: string = walkIn.id;
      const consultationId: string = walkIn.id;
      const masked = maskPatientName(resolvedName);
      const isExisting = Boolean(walkIn.isExistingAccount ?? payload.found);
      const walkInCode: string = walkIn.code || '';

      setActiveSession({
        sessionId,
        consultationId,
        patientId: walkIn.patientId || payload.patient?.userId,
        patientName: resolvedName,
        maskedName: masked,
        phone: lookupForm.phone.trim(),
        walkInCode,
        isExistingAccount: isExisting,
        intakeComplete: Boolean(payload.intakeComplete),
        sentToDoctor: false,
      });

      setStructuredHxForm((prev) => ({
        ...prev,
        chiefComplaint: lookupForm.chiefComplaint.trim() || prev.chiefComplaint,
      }));

      const greetingMsg =
        walkIn.greeting ||
        (activeMode === 'kiosk'
          ? `Welcome back, ${masked}! I am Doc Arion, your medical intake assistant. What symptoms brought you in today?`
          : `Patient session initialized for ${resolvedName}${walkInCode ? ` (${walkInCode})` : ''}. Describe the patient's symptoms to begin the Hx intake.`);

      setChatMessages([
        {
          id: `msg-init-${Date.now()}`,
          sender: 'ai',
          text: greetingMsg,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      toast.success(
        activeMode === 'kiosk'
          ? `Session ready — ${masked}`
          : `Patient session opened${walkInCode ? ` (${walkInCode})` : ''}`
      );
    } catch (err) {
      setActiveSession(null);
      toast.error(actionErrorMessage(err, 'The patient session could not be opened. Nothing was saved; please try again.'));
    } finally {
      setLookingUp(false);
    }
  };

  // Step 2A: AI Symptom Chat inside Care Station
  const handleSendIntakeChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession || !chatInput.trim()) return;
    const messageText = chatInput.trim();
    setChatInput('');
    const userMsg: ChatMessage = {
      id: `msg-u-${Date.now()}`,
      sender: activeMode === 'kiosk' ? 'patient' : 'staff',
      text: messageText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setSendingChat(true);

    try {
      const res = await aiIntakeApi.walkInChat(activeSession.sessionId, {
        message: messageText,
        vitals: vitalsForm.bp ? vitalsForm : undefined,
        structuredHx: structuredHxForm.chiefComplaint ? structuredHxForm : undefined,
      });
      const data = res?.data?.data ?? res?.data ?? {};
      const aiReply =
        data.reply ||
        data.message ||
        data.response ||
        'Thank you. I have recorded those clinical details in the pre-consultation Hx summary.';
      const isComplete = Boolean(data.isComplete ?? data.intakeComplete ?? false);

      setChatMessages((prev) => [
        ...prev,
        {
          id: `msg-ai-${Date.now()}`,
          sender: 'ai',
          text: aiReply,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setActiveSession((prev) => (prev ? { ...prev, intakeComplete: isComplete } : prev));
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `msg-ai-${Date.now()}`,
          sender: 'ai',
          text: `⚠️ ${actionErrorMessage(err, 'That message did not reach the intake assistant and was NOT recorded. Please send it again.')}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setSendingChat(false);
    }
  };

  // Step 2B: Save Structured Hx & Vitals
  const handleSaveStructuredHxAndVitals = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession) return;
    setSavingHxVitals(true);
    try {
      if (vitalsForm.bp || vitalsForm.temp || vitalsForm.hr || vitalsForm.spo2 || vitalsForm.weight) {
        await aiIntakeApi.saveVitals(activeSession.sessionId, vitalsForm);
      }
      await aiIntakeApi.nurseComplete(activeSession.consultationId, {
        chiefComplaint: structuredHxForm.chiefComplaint || lookupForm.chiefComplaint || 'Walk-in consultation',
        hpi: structuredHxForm.hpi,
        pmh: structuredHxForm.pmh,
        allergies: structuredHxForm.allergies,
        currentMedications: structuredHxForm.currentMedications,
        vitals: vitalsForm,
      });
      setActiveSession((prev) => (prev ? { ...prev, intakeComplete: true } : prev));
      toast.success('Structured Hx & Vitals saved — Patient cleared for Doctor!');
    } catch (err) {
      toast.error(actionErrorMessage(err, 'Vitals and history were NOT saved. Please try again.'));
    } finally {
      setSavingHxVitals(false);
    }
  };

  // Kiosk (patient-operated): record booth vitals only. Clearing the patient for
  // the doctor is a nurse decision, so the kiosk never calls nurseComplete.
  const handleSaveKioskVitals = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession) return;
    if (!(vitalsForm.bp || vitalsForm.temp || vitalsForm.hr || vitalsForm.spo2 || vitalsForm.weight)) {
      toast.error('Enter at least one reading.');
      return;
    }
    setSavingHxVitals(true);
    try {
      await aiIntakeApi.saveVitals(activeSession.sessionId, vitalsForm);
      toast.success('Vitals recorded — a nurse will review them shortly.');
    } catch (err) {
      toast.error(actionErrorMessage(err, 'Vitals were NOT saved. Please try again.'));
    } finally {
      setSavingHxVitals(false);
    }
  };

  // Step 3A: Generate QR Code / 6-Char Phone Handoff Token
  const handleGenerateHandoff = async () => {
    if (!activeSession) return;
    setGeneratingHandoff(true);
    try {
      const res = await aiIntakeApi.createHandoffToken(activeSession.sessionId);
      const data = res?.data?.data ?? res?.data ?? {};
      const rawCode = data.code || data.handoffCode;
      if (!rawCode) throw new Error('no handoff code returned');
      const code = String(rawCode).toUpperCase();
      const handoffUrl = data.handoffUrl || `/care-station/handoff?code=${code}`;
      setHandoffData({
        code,
        handoffToken: data.handoffToken || data.token,
        handoffUrl,
        expiresAt: data.expiresAt,
      });
      toast.success(`Phone Handoff Code ${code} generated!`);
    } catch (err) {
      setHandoffData(null);
      toast.error(actionErrorMessage(err, 'A phone handoff code could not be created. Please try again.'));
    } finally {
      setGeneratingHandoff(false);
    }
  };

  // Step 3B: Launch In-Terminal Doctor Session
  const handleLaunchTerminalDoctorSession = async () => {
    if (!activeSession) return;
    if (!activeSession.sentToDoctor) {
      try {
        await aiIntakeApi.sendToDoctor(activeSession.sessionId);
      } catch (err) {
        toast.error(actionErrorMessage(err, 'The patient could not be sent to a doctor. Please try again.'));
        return;
      }
    }
    setActiveSession((prev) => (prev ? { ...prev, sentToDoctor: true } : prev));
    setTerminalDoctorOpen(true);

    try {
      const res = await aiIntakeApi.getTerminalSession(activeSession.consultationId);
      const data = res?.data?.data ?? res?.data ?? {};
      if (data.doctorName) setTerminalDoctorName(data.doctorName);
      if (data.status) setTerminalStatus(data.status);
      if (Array.isArray(data.messages) && data.messages.length > 0) {
        setTerminalMessages(
          data.messages.map((m: any, idx: number) => ({
            id: m.id || `term-${idx}`,
            sender: m.sender || 'doctor',
            text: m.content || m.text || '',
            timestamp: m.timestamp || 'Just now',
          }))
        );
      } else {
        // No doctor message yet: say so plainly (a system note, not a
        // message attributed to a doctor).
        setTerminalMessages([
          {
            id: 'term-welcome',
            sender: 'system',
            text: 'You are in the doctor queue. A doctor will join this screen shortly.',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
    } catch (err) {
      setTerminalMessages([
        {
          id: 'term-welcome',
          sender: 'system',
          text: `⚠️ ${actionErrorMessage(err, 'This screen could not connect to the doctor session. Staff: please check the doctor queue.')}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    }
  };

  // Step 3C: Send Straight to Doctor Queue
  const handleSendStraightToQueue = async () => {
    if (!activeSession) return;
    try {
      await aiIntakeApi.sendToDoctor(activeSession.sessionId);
      setActiveSession((prev) => (prev ? { ...prev, sentToDoctor: true } : prev));
      toast.success(`${activeSession.patientName} sent to the live Doctor Queue!`);
    } catch (err) {
      toast.error(actionErrorMessage(err, 'The patient was NOT added to the doctor queue. Please try again.'));
    }
  };

  const facilityLicenceClass: 'ppmv' | 'pharmacy' | 'clinic' | 'hospital' =
    user?.role?.includes('pharmacy') ? 'pharmacy' :
    user?.role?.includes('hospital') ? 'hospital' :
    user?.role?.includes('clinic') ? 'clinic' : 'ppmv';

  const handleMultimodalEscalate = async (data: any) => {
    if (!activeSession) {
      toast.info('Step 1 (Patient Lookup) required before live physician queue escalation.');
      return;
    }
    try {
      await aiIntakeApi.sendToDoctor(activeSession.sessionId);
      setActiveSession((prev) => (prev ? { ...prev, sentToDoctor: true } : prev));
      toast.success(`Escalated ${activeSession.patientName} to the live Doctor Queue with SAM 3.1 & NAFDAC triage findings!`);
    } catch (err) {
      toast.error(actionErrorMessage(err, 'Failed to escalate patient to doctor queue.'));
    }
  };

  const handleMultimodalFindings = (findings: any) => {
    const summary = findings?.summary || findings?.notes || 'Multimodal scan completed.';
    setChatMessages((prev) => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        sender: 'system',
        text: `🔬 [Meta Multimodal Scanner Findings]: ${summary}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  // Send message inside In-Terminal Doctor Consultation
  const handleSendTerminalMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession || !terminalInput.trim()) return;
    const content = terminalInput.trim();
    setTerminalInput('');
    setTerminalMessages((prev) => [
      ...prev,
      {
        id: `tmsg-${Date.now()}`,
        sender: 'patient',
        text: content,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    setSendingTerminalMsg(true);
    try {
      const res = await aiIntakeApi.sendTerminalMessage(activeSession.consultationId, {
        content,
        action: 'message',
      });
      const data = res?.data?.data ?? res?.data ?? {};
      if (data.reply) {
        setTerminalMessages((prev) => [
          ...prev,
          {
            id: `tmsg-doc-${Date.now()}`,
            sender: 'doctor',
            text: data.reply,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
    } catch (err) {
      setTerminalMessages((prev) => [
        ...prev,
        {
          id: `tmsg-err-${Date.now()}`,
          sender: 'system',
          text: `⚠️ ${actionErrorMessage(err, 'Your last message was not delivered. Please send it again.')}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setSendingTerminalMsg(false);
    }
  };

  const handleRunCopilotSync = async () => {
    if (!activeSession) return;
    const targetId = activeSession.consultationId || activeSession.sessionId;
    setLoadingCopilot(true);
    try {
      const intakeContext =
        chatMessages.filter(m => m.sender !== 'system').map(m => `${m.sender}: ${m.text}`).join('\n') ||
        structuredHxForm.chiefComplaint ||
        'Patient presenting at Care Station outpost for clinical consultation.';
      const res = await api.post(`/ai-intake/${targetId}/copilot-sync`, {
        language: 'en',
        intakeHistory: intakeContext,
        vitals: vitalsForm || {},
      });
      const data = res.data?.data || res.data;
      setCopilotData(data);
      toast.success('✨ Meta Muse Wonder Co-Pilot synced (DDx, Red Flags & Discharge Instructions)!');
    } catch (err) {
      toast.error(actionErrorMessage(err, 'Failed to sync with Muse Wonder Co-Pilot.'));
    } finally {
      setLoadingCopilot(false);
    }
  };

  const renderCopilotPanel = (isKiosk: boolean) => (
    <div
      data-testid="muse-wonder-copilot-panel"
      className={`mt-4 rounded-xl border p-4 space-y-4 ${
        isKiosk
          ? 'bg-slate-950/80 border-indigo-500/40 text-slate-100'
          : 'bg-indigo-50/40 dark:bg-slate-900 border-indigo-200 dark:border-indigo-900/50 text-gray-900 dark:text-slate-100'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 border-indigo-200/40 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
          <div>
            <h4 className="text-sm font-bold flex items-center gap-1.5">
              <span>Meta Muse Wonder Clinical Co-Pilot</span>
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 font-mono">
                Llama 3.3 70B
              </span>
            </h4>
            <p className="text-[11px] opacity-75">
              Real-time Differential Diagnoses, Clinical Red Flags & Vernacular Discharge Support
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={handleRunCopilotSync}
          disabled={loadingCopilot}
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-indigo-600/30"
        >
          {loadingCopilot ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Analyzing Encounter...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              <span>{copilotData ? '⚡ Refresh Muse Wonder' : '⚡ Run Muse Wonder Co-Pilot'}</span>
            </>
          )}
        </Button>
      </div>

      {loadingCopilot && (
        <div className="py-6 flex flex-col items-center justify-center text-center space-y-2 text-indigo-300">
          <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
          <p className="text-xs font-semibold">Synthesizing clinical intake, vitals & differential diagnoses...</p>
        </div>
      )}

      {!loadingCopilot && !copilotData && (
        <div className="py-4 text-center text-xs opacity-70">
          Click <strong>Run Muse Wonder Co-Pilot</strong> to generate real-time DDx, clinical red flags, and patient-friendly discharge instructions.
        </div>
      )}

      {!loadingCopilot && copilotData && (
        <div className="space-y-4">
          {/* Top 3 Differential Diagnoses */}
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400 flex items-center gap-1 mb-2">
              <Stethoscope className="w-3.5 h-3.5" />
              Top Differential Diagnoses (DDx)
            </span>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              {(copilotData.differentials || []).slice(0, 3).map((ddx, idx) => {
                const likelihood = ddx.likelihood?.toLowerCase();
                const badgeColor =
                  likelihood === 'high'
                    ? 'bg-rose-500/20 text-rose-400 border-rose-500/40'
                    : likelihood === 'medium'
                    ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                    : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40';
                return (
                  <div
                    key={idx}
                    className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                      isKiosk
                        ? 'bg-slate-900 border-slate-800'
                        : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-800 shadow-sm'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-bold truncate">{ddx.name}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${badgeColor}`}>
                        {ddx.likelihood}
                      </span>
                    </div>
                    <p className="text-[11px] opacity-80 leading-relaxed">{ddx.reasoning}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Red Flags & Clinical Suggestions */}
          {copilotData.suggestions && copilotData.suggestions.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Red Flags / Priority Alerts */}
              <div
                className={`p-3 rounded-xl border space-y-2 ${
                  isKiosk
                    ? 'bg-rose-950/20 border-rose-500/30'
                    : 'bg-rose-50/70 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/40'
                }`}
              >
                <span className="text-[11px] font-bold uppercase tracking-wider text-rose-500 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Clinical Red Flags & Priority Alerts
                </span>
                <div className="space-y-1.5">
                  {copilotData.suggestions
                    .filter((s) => s.priority === 'high' || s.type === 'alert')
                    .slice(0, 3)
                    .map((item, idx) => (
                      <div key={idx} className="text-xs">
                        <span className="font-semibold text-rose-400">• {item.title}:</span>{' '}
                        <span className="opacity-90">{item.detail}</span>
                      </div>
                    ))}
                  {copilotData.suggestions.filter((s) => s.priority === 'high' || s.type === 'alert').length === 0 && (
                    <p className="text-xs text-emerald-500 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Zero high-risk red flags flagged for this presentation.
                    </p>
                  )}
                </div>
              </div>

              {/* Suggested Questions for Clinician */}
              <div
                className={`p-3 rounded-xl border space-y-2 ${
                  isKiosk
                    ? 'bg-indigo-950/20 border-indigo-500/30'
                    : 'bg-indigo-50/70 dark:bg-indigo-950/20 border-indigo-200 dark:border-indigo-900/40'
                }`}
              >
                <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400 flex items-center gap-1">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Suggested Clinical Questions
                </span>
                <div className="space-y-1.5">
                  {copilotData.suggestions
                    .filter((s) => s.type === 'question' || s.type === 'diagnosis')
                    .slice(0, 3)
                    .map((item, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setTerminalInput(item.detail || item.title);
                          toast.info('Copied suggestion to terminal message bar');
                        }}
                        className="text-left w-full text-xs block p-1.5 rounded hover:bg-indigo-500/10 transition-colors"
                      >
                        <span className="font-semibold text-indigo-300">❓ {item.title}</span>
                        {item.detail && <p className="opacity-80 text-[11px] mt-0.5">{item.detail}</p>}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          )}

          {/* Vernacular Pidgin / English Discharge Instructions */}
          {copilotData.vernacularPatientSummary && (
            <div
              className={`p-3.5 rounded-xl border space-y-2 ${
                isKiosk
                  ? 'bg-emerald-950/20 border-emerald-500/40'
                  : 'bg-emerald-50/70 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5" />
                  Vernacular Discharge Instructions (Nigerian English / Pidgin)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(copilotData.vernacularPatientSummary || '');
                    toast.success('Copied Vernacular Discharge Instructions!');
                  }}
                  className="text-xs text-emerald-400 hover:text-emerald-300 font-bold flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" /> Copy Instructions
                </button>
              </div>
              <p className="text-xs leading-relaxed font-sans bg-black/20 p-2.5 rounded-lg border border-emerald-500/20">
                "{copilotData.vernacularPatientSummary}"
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Kiosk Mode: End Patient Session & Clear Screen for Next Patient
  const handleKioskEndPatientSession = async () => {
    if (activeSession && terminalDoctorOpen) {
      try {
        await aiIntakeApi.sendTerminalMessage(activeSession.consultationId, {
          action: 'end_session',
        });
      } catch {
        // Ignore cleanup network errors
      }
    }
    resetPatientSessionState();
    toast.info('Session ended and screen cleared for the next patient.');
  };

  // Enter Kiosk Mode with PIN Lock
  const handleEnterKioskMode = () => {
    // No default PIN: kiosk mode needs a PIN chosen by staff, otherwise anyone
    // at the kiosk could unlock the staff console with a well-known code. A
    // facility with a saved Station PIN may lock without typing one — unlock
    // then checks the PIN with the server.
    const cleanPin = (kioskPinSetup || stationConfig.stationPin || '').trim();
    if (cleanPin.length < 4 && !stationConfig.hasStationPin) {
      toast.warning('Please set a 4-digit Station Exit PIN');
      return;
    }
    setStationConfig((prev) => ({ ...prev, stationPin: cleanPin }));
    resetPatientSessionState();
    setActiveMode('kiosk');
    setKioskLocked(true);
    setShowUnlockModal(false);
    setUnlockPinAttempt('');
    setUnlockError('');
  };

  // Staff Unlock from Kiosk Mode
  const handleConfirmStaffUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const attempt = unlockPinAttempt.trim();
    const sessionPin = (stationConfig.stationPin || kioskPinSetup || '').trim();
    if (sessionPin) {
      if (attempt !== sessionPin) {
        setUnlockError('Incorrect Station PIN. Kiosk remains locked.');
        return;
      }
    } else if (stationConfig.hasStationPin && facilityId) {
      try {
        await adminApi.verifyCareStationPin(facilityId, attempt);
      } catch (error) {
        setUnlockError(actionErrorMessage(error, 'Incorrect Station PIN. Kiosk remains locked.'));
        return;
      }
    } else {
      setUnlockError('No Station PIN is set. Ask a site admin to unlock this station.');
      return;
    }
    setKioskLocked(false);
    setShowUnlockModal(false);
    setUnlockPinAttempt('');
    setUnlockError('');
    setActiveMode('assisted');
    toast.success('Care Station unlocked — returned to Staff Console.');
  };

  // Site Admin: Save Care Station Configuration
  const handleSaveStationConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!facilityId) {
      toast.error('This account is not linked to a facility, so station settings cannot be saved.');
      return;
    }
    setSavingConfig(true);
    try {
      const pin = (stationConfig.stationPin || '').trim();
      await adminApi.updateCareStationConfig(facilityId, {
        careStationEnabled: stationConfig.enabled,
        assistedIntakeEnabled: stationConfig.assistedIntakeEnabled,
        allowPatientTerminal: stationConfig.kioskModeEnabled,
        enabledRoles: stationConfig.allowedRoles,
        stationName: stationConfig.stationName,
        ...(pin ? { stationPin: pin } : {}),
      });
      if (pin) {
        setKioskPinSetup(pin);
        setStationConfig((prev) => ({ ...prev, hasStationPin: true }));
      }
      toast.success('Care Station & Role Access settings saved!');
    } catch (error) {
      toast.error(actionErrorMessage(error, 'Care Station settings were not saved. Please try again.'));
    } finally {
      setSavingConfig(false);
    }
  };

  const toggleAllowedRole = (roleCode: string) => {
    setStationConfig((prev) => {
      const exists = prev.allowedRoles.includes(roleCode);
      return {
        ...prev,
        allowedRoles: exists
          ? prev.allowedRoles.filter((r) => r !== roleCode)
          : [...prev.allowedRoles, roleCode],
      };
    });
  };

  // ============================================================================
  // RENDER: SHARED CARE STATION KIOSK MODE (FULL-SCREEN PIN-LOCKED TERMINAL)
  // ============================================================================
  if (activeMode === 'kiosk' && kioskLocked) {
    return (
      <div
        data-testid="kiosk-mode-container"
        className="min-h-screen bg-slate-950 text-white flex flex-col justify-between p-4 md:p-8 select-none"
      >
        {/* Top Kiosk Header Bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-teal-500/20 border border-teal-500/40 flex items-center justify-center text-2xl">
              🖥️
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl md:text-2xl font-bold text-white">
                  {stationConfig.stationName || 'Docarion Shared Care Station'}
                </h1>
                <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-teal-500/20 text-teal-300 border border-teal-500/30">
                  Self-Service & Booth Kiosk
                </span>
              </div>
              <p className="text-xs md:text-sm text-slate-400">
                Enter your phone number to pull up your account, complete Hx intake, and speak with a doctor.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {activeSession && (
              <button
                type="button"
                data-testid="kiosk-end-session-btn"
                onClick={handleKioskEndPatientSession}
                className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm shadow-lg shadow-rose-600/25 flex items-center gap-2 transition-all"
              >
                <CheckCircle2 className="w-4 h-4" />
                ✅ End My Session & Clear Screen for Next Patient
              </button>
            )}
            <button
              type="button"
              data-testid="kiosk-staff-unlock-btn"
              onClick={() => {
                setShowUnlockModal(true);
                setUnlockPinAttempt('');
                setUnlockError('');
              }}
              className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold border border-slate-700 flex items-center gap-1.5"
            >
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              🔒 Staff Unlock
            </button>
          </div>
        </header>

        {/* Main Kiosk Body */}
        <main className="flex-1 max-w-4xl w-full mx-auto my-6 space-y-6">
          {!activeSession ? (
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 md:p-10 shadow-2xl space-y-6">
              <div className="text-center space-y-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-teal-500/10 text-teal-300 border border-teal-500/20">
                  <Sparkles className="w-3.5 h-3.5" /> Welcome to the Care Station Booth
                </span>
                <h2 className="text-2xl md:text-3xl font-bold text-white">
                  Check In with Your Phone Number
                </h2>
                <p className="text-slate-400 text-sm max-w-lg mx-auto">
                  Have an existing account? Enter your phone number to connect smoothly. First time here? Enter your details below to join the doctor queue.
                </p>
              </div>

              <form onSubmit={handlePatientLookup} className="space-y-4 max-w-xl mx-auto">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Mobile Phone Number *
                  </label>
                  <input
                    type="tel"
                    data-testid="kiosk-phone-input"
                    placeholder="e.g. +234 803 123 4567"
                    value={lookupForm.phone}
                    onChange={(e) => setLookupForm({ ...lookupForm, phone: e.target.value })}
                    className="w-full px-4 py-3.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-lg placeholder-slate-500 focus:outline-none focus:border-teal-400"
                    required
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Full Name (If new patient)
                    </label>
                    <input
                      type="text"
                      data-testid="kiosk-name-input"
                      placeholder="e.g. Amina Bello"
                      value={lookupForm.patientName}
                      onChange={(e) => setLookupForm({ ...lookupForm, patientName: e.target.value })}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Age (Years)
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 34"
                      value={lookupForm.age}
                      onChange={(e) => setLookupForm({ ...lookupForm, age: e.target.value })}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">
                    Main Symptom / Reason for Visit
                  </label>
                  <input
                    type="text"
                    data-testid="kiosk-complaint-input"
                    placeholder="e.g. Fever and headache for 2 days"
                    value={lookupForm.chiefComplaint}
                    onChange={(e) => setLookupForm({ ...lookupForm, chiefComplaint: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm"
                  />
                </div>

                <button
                  type="submit"
                  data-testid="kiosk-start-session-btn"
                  disabled={lookingUp}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-400 hover:to-emerald-400 text-slate-950 font-bold text-base shadow-xl shadow-teal-500/20 transition-all"
                >
                  {lookingUp ? 'Finding Your Account...' : 'Continue to Medical Intake →'}
                </button>
              </form>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Privacy-Masked Greeting Banner */}
              <div
                data-testid="kiosk-masked-greeting"
                className="bg-slate-900 border border-teal-500/30 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-teal-300">
                      Welcome back, {activeSession.maskedName}
                    </span>
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">
                      Ticket: {activeSession.walkInCode}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Privacy Mode Active: Your full name and history are masked on this shared screen.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="kiosk-talk-to-doctor-btn"
                    onClick={handleLaunchTerminalDoctorSession}
                    className="px-4 py-2.5 rounded-xl bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-xs flex items-center gap-1.5"
                  >
                    <Stethoscope className="w-4 h-4" />
                    Talk to Doctor Here
                  </button>
                  <button
                    type="button"
                    data-testid="kiosk-qr-handoff-btn"
                    onClick={handleGenerateHandoff}
                    className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 flex items-center gap-1.5"
                  >
                    <QrCode className="w-4 h-4 text-teal-400" />
                    Continue on My Phone
                  </button>
                </div>
              </div>

              {/* Kiosk AI Intake & Booth Vitals */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col h-[420px]">
                  <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
                    <h3 className="font-bold text-sm text-white flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-teal-400" />
                      Step 1: Quick Symptom & History Intake
                    </h3>
                    {activeSession.intakeComplete && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                        ✓ Intake Ready
                      </span>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                    {chatMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`p-3 rounded-xl text-sm max-w-[88%] ${
                          msg.sender === 'ai'
                            ? 'bg-slate-800 text-slate-100 self-start'
                            : 'bg-teal-600 text-white ml-auto'
                        }`}
                      >
                        <p>{msg.text}</p>
                      </div>
                    ))}
                  </div>

                  <form onSubmit={handleSendIntakeChat} className="mt-3 flex gap-2">
                    <input
                      type="text"
                      data-testid="kiosk-chat-input"
                      placeholder="Describe your symptoms, duration, or allergies..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm"
                    />
                    <button
                      type="submit"
                      data-testid="kiosk-chat-send-btn"
                      disabled={sendingChat}
                      className="px-4 py-2.5 rounded-xl bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-sm"
                    >
                      Send
                    </button>
                  </form>
                </div>

                {/* Booth Vitals Entry */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                  <h3 className="font-bold text-sm text-white flex items-center gap-2">
                    <Activity className="w-4 h-4 text-rose-400" />
                    Step 2: Station Booth Vitals
                  </h3>
                  <form onSubmit={handleSaveKioskVitals} className="space-y-3">
                    <div>
                      <label className="text-xs text-slate-400">Blood Pressure (mmHg)</label>
                      <input
                        type="text"
                        placeholder="120/80"
                        value={vitalsForm.bp}
                        onChange={(e) => setVitalsForm({ ...vitalsForm, bp: e.target.value })}
                        className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-slate-400">Temp (°C)</label>
                        <input
                          type="text"
                          placeholder="36.8"
                          value={vitalsForm.temp}
                          onChange={(e) => setVitalsForm({ ...vitalsForm, temp: e.target.value })}
                          className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-400">SpO2 (%)</label>
                        <input
                          type="text"
                          placeholder="98"
                          value={vitalsForm.spo2}
                          onChange={(e) => setVitalsForm({ ...vitalsForm, spo2: e.target.value })}
                          className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={savingHxVitals}
                      className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-teal-300 font-semibold text-xs border border-teal-500/30"
                    >
                      {savingHxVitals ? 'Saving...' : 'Save Booth Vitals'}
                    </button>
                  </form>
                </div>
              </div>

              {/* QR Handoff Card in Kiosk */}
              {handoffData && (
                <div
                  data-testid="handoff-qr-display"
                  className="bg-slate-900 border border-teal-500/40 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4"
                >
                  <div>
                    <h4 className="text-sm font-bold text-teal-300">
                      📱 Scan or Enter Code on Your Personal Phone
                    </h4>
                    <p className="text-xs text-slate-400 mt-1">
                      Open <span data-testid="handoff-claim-url" className="font-mono text-white">{handoffData.handoffUrl}</span> and enter your 6-character code:
                    </p>
                  </div>
                  <div
                    data-testid="handoff-six-char-code"
                    className="px-5 py-3 rounded-xl bg-slate-950 border border-teal-500/50 font-mono text-2xl font-bold tracking-widest text-teal-300"
                  >
                    {handoffData.code}
                  </div>
                </div>
              )}

              {/* Live In-Terminal Doctor Consultation Panel inside Kiosk */}
              {terminalDoctorOpen && (
                <div
                  data-testid="terminal-doctor-session-panel"
                  className="bg-slate-900 border-2 border-emerald-500/50 rounded-2xl p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                    <div>
                      <span className="text-xs uppercase tracking-wider text-emerald-400 font-bold">
                        🖥️ Live Care Station Doctor Terminal
                      </span>
                      <h3 className="text-base font-bold text-white">
                        {terminalDoctorName} · Status: {terminalStatus}
                      </h3>
                    </div>
                    {/* No link out of the kiosk: navigating to /consultations would
                        leave the PIN lock and hand the patient the staff session. */}
                  </div>

                  <div className="max-h-52 overflow-y-auto space-y-2">
                    {terminalMessages.map((tm) => (
                      <div
                        key={tm.id}
                        className={`p-3 rounded-xl text-sm ${
                          tm.sender === 'doctor'
                            ? 'bg-slate-800 text-emerald-200'
                            : tm.sender === 'system'
                            ? 'bg-amber-500/20 text-amber-100 text-center'
                            : 'bg-emerald-600/30 text-white ml-auto max-w-[85%]'
                        }`}
                      >
                        <span className="text-[11px] font-bold uppercase block opacity-75">
                          {tm.sender === 'doctor' ? 'Doctor' : tm.sender === 'system' ? 'Care Station' : 'You'}
                        </span>
                        {tm.text}
                      </div>
                    ))}
                  </div>

                  <form onSubmit={handleSendTerminalMessage} className="flex gap-2">
                    <input
                      type="text"
                      data-testid="terminal-message-input"
                      placeholder="Type a message to the Doctor on this terminal..."
                      value={terminalInput}
                      onChange={(e) => setTerminalInput(e.target.value)}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm"
                    />
                    <button
                      type="submit"
                      data-testid="terminal-message-send-btn"
                      disabled={sendingTerminalMsg}
                      className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm"
                    >
                      Send to Doctor
                    </button>
                  </form>

                  {/* The Co-Pilot (DDx / red flags) is clinician-only — never on the patient-facing kiosk. */}
                </div>
              )}
            </div>
          )}
        </main>

        {/* Staff PIN Unlock Modal */}
        {showUnlockModal && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Unlock className="w-5 h-5 text-amber-400" />
                  Staff Kiosk Unlock
                </h3>
                <button
                  type="button"
                  onClick={() => setShowUnlockModal(false)}
                  className="text-slate-400 hover:text-white text-sm"
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-slate-400">
                Enter the 4-digit Station Exit PIN to leave Shared Patient Kiosk Mode and return to the Staff Console.
              </p>
              <form onSubmit={handleConfirmStaffUnlock} className="space-y-3">
                <input
                  type="password"
                  data-testid="kiosk-unlock-pin-input"
                  maxLength={6}
                  placeholder="Enter 4-digit PIN"
                  value={unlockPinAttempt}
                  onChange={(e) => setUnlockPinAttempt(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-center font-mono text-xl tracking-widest text-white"
                />
                {unlockError && (
                  <p data-testid="kiosk-unlock-error" className="text-xs text-rose-400 font-medium">
                    {unlockError}
                  </p>
                )}
                <button
                  type="submit"
                  data-testid="kiosk-unlock-confirm-btn"
                  className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm"
                >
                  Unlock Station
                </button>
              </form>
            </div>
          </div>
        )}

        <footer className="text-center text-xs text-slate-500 pt-4 border-t border-slate-900">
          Docarion Care Station Terminal · Zero-PHI Shared Session Protection Active
        </footer>
      </div>
    );
  }

  // ============================================================================
  // RENDER: STAFF CONSOLE (MODE 1: ASSISTED INTAKE & HANDOFF + MODE 3: ADMIN SETTINGS)
  // ============================================================================
  return (
    <DashboardShell
      title="🖥️ Care Station & Assisted Intake Hub"
      subtitle="Help walk-in patients complete mandatory Hx intake, hand off to their personal phone via QR, or launch a shared Care Station Kiosk terminal."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700">
            <Lock className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Kiosk PIN:</span>
            <input
              type="text"
              data-testid="kiosk-pin-input"
              maxLength={6}
              value={kioskPinSetup}
              onChange={(e) => setKioskPinSetup(e.target.value)}
              className="w-16 px-2 py-0.5 text-xs font-mono font-bold rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-white"
              aria-label="Kiosk Exit PIN"
            />
          </div>
          <Button
            data-testid="enter-kiosk-mode-btn"
            onClick={handleEnterKioskMode}
            className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold gap-1.5"
          >
            <Monitor className="w-4 h-4" />
            🖥️ Enter Shared Care Station Kiosk Mode
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Mode Switcher Tabs */}
        <div className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-slate-800 pb-3">
          <button
            type="button"
            data-testid="tab-assisted-intake"
            onClick={() => setActiveMode('assisted')}
            className={`px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 transition-all ${
              activeMode === 'assisted'
                ? 'bg-teal-600 text-white shadow-sm'
                : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700'
            }`}
          >
            <UserPlus className="w-4 h-4" />
            1. Staff-Assisted Intake & Handoff
          </button>

          <button
            type="button"
            data-testid="tab-kiosk-launch"
            onClick={handleEnterKioskMode}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700 hover:border-teal-500"
          >
            <Monitor className="w-4 h-4 text-teal-500" />
            2. Shared Care Station Kiosk Mode (Multi-Patient Booth)
          </button>

          {isSiteAdmin && (
            <button
              type="button"
              data-testid="tab-care-station-settings"
              onClick={() => setActiveMode('settings')}
              className={`px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 transition-all ${
                activeMode === 'settings'
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700'
              }`}
            >
              <Settings className="w-4 h-4" />
              3. Site Admin Care Station & Role Toggles
            </button>
          )}
        </div>

        {/* ====================================================================
            MODE 3: SITE ADMIN CARE STATION & ROLE TOGGLE SETTINGS
            ==================================================================== */}
        {activeMode === 'settings' && isSiteAdmin && (
          <Card data-testid="care-station-admin-settings-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-purple-500" />
                Care Station Module & Staff Role Access Configuration
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveStationConfig} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <label className="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-slate-700 cursor-pointer bg-gray-50/60 dark:bg-slate-800/40">
                    <input
                      type="checkbox"
                      data-testid="toggle-care-station-enabled"
                      checked={stationConfig.enabled}
                      onChange={(e) =>
                        setStationConfig({ ...stationConfig, enabled: e.target.checked })
                      }
                      className="mt-1 rounded text-teal-600"
                    />
                    <div>
                      <span className="font-semibold text-sm block text-gray-900 dark:text-white">
                        Enable Care Station Module
                      </span>
                      <span className="text-xs text-gray-500 dark:text-slate-400">
                        Master switch for facility Care Station & walk-in terminal
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-slate-700 cursor-pointer bg-gray-50/60 dark:bg-slate-800/40">
                    <input
                      type="checkbox"
                      data-testid="toggle-assisted-intake"
                      checked={stationConfig.assistedIntakeEnabled}
                      onChange={(e) =>
                        setStationConfig({
                          ...stationConfig,
                          assistedIntakeEnabled: e.target.checked,
                        })
                      }
                      className="mt-1 rounded text-teal-600"
                    />
                    <div>
                      <span className="font-semibold text-sm block text-gray-900 dark:text-white">
                        Staff-Assisted Intake & QR Handoff
                      </span>
                      <span className="text-xs text-gray-500 dark:text-slate-400">
                        Allow staff to enter Hx for patients without phones or hand off via QR
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-slate-700 cursor-pointer bg-gray-50/60 dark:bg-slate-800/40">
                    <input
                      type="checkbox"
                      data-testid="toggle-kiosk-mode"
                      checked={stationConfig.kioskModeEnabled}
                      onChange={(e) =>
                        setStationConfig({
                          ...stationConfig,
                          kioskModeEnabled: e.target.checked,
                        })
                      }
                      className="mt-1 rounded text-teal-600"
                    />
                    <div>
                      <span className="font-semibold text-sm block text-gray-900 dark:text-white">
                        Shared Patient Kiosk Terminal Mode
                      </span>
                      <span className="text-xs text-gray-500 dark:text-slate-400">
                        Enable PIN-locked booth mode for multiple walk-in patients
                      </span>
                    </div>
                  </label>
                </div>

                <div>
                  <h4 className="text-sm font-bold text-gray-900 dark:text-white mb-2">
                    Roles Permitted to Operate Care Station & Assisted Intake
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {CONFIGURABLE_ROLES.map((item) => (
                      <label
                        key={item.role}
                        className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 dark:border-slate-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50"
                      >
                        <input
                          type="checkbox"
                          data-testid={`toggle-role-${item.role}`}
                          checked={stationConfig.allowedRoles.includes(item.role)}
                          onChange={() => toggleAllowedRole(item.role)}
                          className="mt-1 rounded text-purple-600"
                        />
                        <div>
                          <span className="text-sm font-semibold text-gray-900 dark:text-white block">
                            {item.label}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-slate-400">
                            {item.desc}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
                  <div>
                    <label className="block text-xs font-semibold uppercase text-gray-600 dark:text-slate-300 mb-1">
                      4-Digit Station Exit PIN
                    </label>
                    <input
                      type="text"
                      data-testid="admin-station-pin-input"
                      maxLength={6}
                      value={stationConfig.stationPin}
                      placeholder={stationConfig.hasStationPin ? 'PIN set — type a new one to change it' : 'Not set'}
                      onChange={(e) =>
                        setStationConfig({ ...stationConfig, stationPin: e.target.value })
                      }
                      className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase text-gray-600 dark:text-slate-300 mb-1">
                      Terminal Display Label
                    </label>
                    <input
                      type="text"
                      value={stationConfig.stationName || ''}
                      onChange={(e) =>
                        setStationConfig({ ...stationConfig, stationName: e.target.value })
                      }
                      className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    data-testid="save-care-station-config-btn"
                    disabled={savingConfig}
                    className="bg-purple-600 hover:bg-purple-700 text-white"
                  >
                    {savingConfig ? 'Saving Settings...' : 'Save Care Station Settings'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ====================================================================
            MODE 1: STAFF-ASSISTED INTAKE & HANDOFF WORKFLOW
            ==================================================================== */}
        {activeMode === 'assisted' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Step 1 Column: Patient Phone Lookup / Registration */}
            <div className="lg:col-span-4 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Phone className="w-4 h-4 text-teal-600" />
                      Step 1: Patient Phone Lookup
                    </span>
                    {activeSession && (
                      <button
                        type="button"
                        data-testid="assisted-new-patient-btn"
                        onClick={resetPatientSessionState}
                        className="text-xs text-teal-600 hover:underline font-medium"
                      >
                        + New Patient
                      </button>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handlePatientLookup} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 dark:text-slate-300 mb-1">
                        Patient Phone Number *
                      </label>
                      <input
                        type="tel"
                        data-testid="assisted-phone-input"
                        placeholder="+234 803 000 0000"
                        value={lookupForm.phone}
                        onChange={(e) => setLookupForm({ ...lookupForm, phone: e.target.value })}
                        className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">
                        Patient Full Name (Optional if existing)
                      </label>
                      <input
                        type="text"
                        data-testid="assisted-name-input"
                        placeholder="e.g. Chukwudi Okafor"
                        value={lookupForm.patientName}
                        onChange={(e) =>
                          setLookupForm({ ...lookupForm, patientName: e.target.value })
                        }
                        className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">
                          Age
                        </label>
                        <input
                          type="number"
                          placeholder="e.g. 42"
                          value={lookupForm.age}
                          onChange={(e) => setLookupForm({ ...lookupForm, age: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">
                          Gender
                        </label>
                        <select
                          value={lookupForm.gender}
                          onChange={(e) => setLookupForm({ ...lookupForm, gender: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                        >
                          <option value="female">Female</option>
                          <option value="male">Male</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">
                        Chief Complaint / Presenting Symptom
                      </label>
                      <input
                        type="text"
                        data-testid="assisted-complaint-input"
                        placeholder="e.g. Persistent cough & fever for 3 days"
                        value={lookupForm.chiefComplaint}
                        onChange={(e) =>
                          setLookupForm({ ...lookupForm, chiefComplaint: e.target.value })
                        }
                        className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                      />
                    </div>

                    <Button
                      type="submit"
                      data-testid="assisted-lookup-submit-btn"
                      disabled={lookingUp}
                      className="w-full bg-teal-600 hover:bg-teal-700 text-white"
                    >
                      {lookingUp ? 'Matching Account...' : 'Match or Create Patient Session'}
                    </Button>
                  </form>

                  {activeSession && (
                    <div
                      data-testid="active-station-session-badge"
                      className="mt-4 p-3.5 rounded-xl bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-800 space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-teal-900 dark:text-teal-200">
                          {activeSession.patientName}
                        </span>
                        <span className="font-mono text-xs px-2 py-0.5 rounded bg-teal-600 text-white">
                          {activeSession.walkInCode}
                        </span>
                      </div>
                      <p className="text-xs text-teal-700 dark:text-teal-300">
                        Phone: {activeSession.phone} ·{' '}
                        {activeSession.isExistingAccount ? 'Linked Account' : 'New Walk-In Profile'}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Step 2 & Step 3 Column: Assisted Hx Intake + Handoff Options */}
            <div className="lg:col-span-8 space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Stethoscope className="w-4 h-4 text-teal-600" />
                      Step 2: Mandatory Pre-Consultation Hx Intake & Vitals
                    </CardTitle>
                    <div className="flex gap-1.5 flex-wrap">
                      <button
                        type="button"
                        data-testid="switch-ai-chat-btn"
                        onClick={() => setIntakeMethod('ai_chat')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                          intakeMethod === 'ai_chat'
                            ? 'bg-teal-600 text-white'
                            : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300'
                        }`}
                      >
                        🤖 AI Symptom Intake Chat
                      </button>
                      <button
                        type="button"
                        data-testid="switch-structured-hx-btn"
                        onClick={() => setIntakeMethod('structured_hx')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                          intakeMethod === 'structured_hx'
                            ? 'bg-teal-600 text-white'
                            : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300'
                        }`}
                      >
                        📋 Structured Hx & Vitals Form
                      </button>
                      <button
                        type="button"
                        data-testid="switch-multimodal-scan-btn"
                        onClick={() => setIntakeMethod('multimodal_scan')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
                          intakeMethod === 'multimodal_scan'
                            ? 'bg-purple-600 text-white shadow-sm'
                            : 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 hover:bg-purple-100'
                        }`}
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        🔬 Meta Multimodal Scanner (SAM 3.1 & NAFDAC)
                      </button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {!activeSession && intakeMethod !== 'multimodal_scan' ? (
                    <div className="py-10 text-center text-sm text-gray-500 dark:text-slate-400">
                      Complete Step 1 (Patient Phone Lookup) on the left to start assisted intake.
                    </div>
                  ) : intakeMethod === 'multimodal_scan' ? (
                    <div className="space-y-4 pt-1">
                      <MetaMultimodalScanner
                        consultationId={activeSession?.consultationId}
                        facilityLicenceClass={facilityLicenceClass}
                        onEscalateToDoctor={handleMultimodalEscalate}
                        onFindingsExtracted={handleMultimodalFindings}
                      />
                    </div>
                  ) : intakeMethod === 'ai_chat' ? (
                    <div className="space-y-4">
                      <div className="h-64 overflow-y-auto p-4 rounded-xl bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-800 space-y-3">
                        {chatMessages.map((m) => (
                          <div
                            key={m.id}
                            className={`p-3 rounded-xl text-sm max-w-[85%] ${
                              m.sender === 'ai'
                                ? 'bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-100 border border-gray-200 dark:border-slate-700'
                                : 'bg-teal-600 text-white ml-auto'
                            }`}
                          >
                            <p>{m.text}</p>
                          </div>
                        ))}
                      </div>
                      <form onSubmit={handleSendIntakeChat} className="flex gap-2">
                        <input
                          type="text"
                          data-testid="assisted-chat-input"
                          placeholder="Enter patient's symptoms, duration, severity, or medication history..."
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          className="flex-1 px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                        />
                        <Button
                          type="submit"
                          data-testid="assisted-chat-send-btn"
                          disabled={sendingChat}
                          className="bg-teal-600 hover:bg-teal-700 text-white"
                        >
                          {sendingChat ? 'Sending...' : 'Send'}
                        </Button>
                      </form>
                    </div>
                  ) : (
                    <form onSubmit={handleSaveStructuredHxAndVitals} className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">
                            Chief Complaint *
                          </label>
                          <input
                            type="text"
                            data-testid="structured-cc-input"
                            value={structuredHxForm.chiefComplaint}
                            onChange={(e) =>
                              setStructuredHxForm({
                                ...structuredHxForm,
                                chiefComplaint: e.target.value,
                              })
                            }
                            placeholder="Primary reason for visit"
                            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">
                            History of Present Illness (HPI)
                          </label>
                          <input
                            type="text"
                            data-testid="structured-hpi-input"
                            value={structuredHxForm.hpi}
                            onChange={(e) =>
                              setStructuredHxForm({ ...structuredHxForm, hpi: e.target.value })
                            }
                            placeholder="Onset, duration, associated symptoms"
                            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">
                            Allergies
                          </label>
                          <input
                            type="text"
                            value={structuredHxForm.allergies}
                            onChange={(e) =>
                              setStructuredHxForm({
                                ...structuredHxForm,
                                allergies: e.target.value,
                              })
                            }
                            placeholder="e.g. Penicillin, None known"
                            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">
                            Current Medications
                          </label>
                          <input
                            type="text"
                            value={structuredHxForm.currentMedications}
                            onChange={(e) =>
                              setStructuredHxForm({
                                ...structuredHxForm,
                                currentMedications: e.target.value,
                              })
                            }
                            placeholder="e.g. Amlodipine 5mg"
                            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-gray-100 dark:border-slate-800">
                        <div>
                          <label className="text-xs text-gray-500">BP (mmHg)</label>
                          <input
                            type="text"
                            data-testid="structured-bp-input"
                            placeholder="120/80"
                            value={vitalsForm.bp}
                            onChange={(e) => setVitalsForm({ ...vitalsForm, bp: e.target.value })}
                            className="w-full mt-1 px-2.5 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Temp (°C)</label>
                          <input
                            type="text"
                            placeholder="37.0"
                            value={vitalsForm.temp}
                            onChange={(e) => setVitalsForm({ ...vitalsForm, temp: e.target.value })}
                            className="w-full mt-1 px-2.5 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Pulse (bpm)</label>
                          <input
                            type="text"
                            placeholder="76"
                            value={vitalsForm.hr}
                            onChange={(e) => setVitalsForm({ ...vitalsForm, hr: e.target.value })}
                            className="w-full mt-1 px-2.5 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">SpO2 (%)</label>
                          <input
                            type="text"
                            placeholder="99"
                            value={vitalsForm.spo2}
                            onChange={(e) => setVitalsForm({ ...vitalsForm, spo2: e.target.value })}
                            className="w-full mt-1 px-2.5 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Weight (kg)</label>
                          <input
                            type="text"
                            placeholder="70"
                            value={vitalsForm.weight}
                            onChange={(e) =>
                              setVitalsForm({ ...vitalsForm, weight: e.target.value })
                            }
                            className="w-full mt-1 px-2.5 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                          />
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          type="submit"
                          data-testid="save-structured-hx-btn"
                          disabled={savingHxVitals}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          {savingHxVitals
                            ? 'Saving Hx & Vitals...'
                            : 'Save Structured Hx & Vitals'}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>

              {/* Step 3 Card: Handoff & Consultation Launch */}
              {activeSession && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-teal-600" />
                      Step 3: Choose Patient Handoff or Terminal Doctor Session
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <button
                        type="button"
                        data-testid="generate-qr-handoff-btn"
                        onClick={handleGenerateHandoff}
                        disabled={generatingHandoff}
                        className="p-4 rounded-xl border border-teal-200 dark:border-teal-800 bg-teal-50/50 dark:bg-teal-950/30 hover:bg-teal-100/60 text-left space-y-1 transition-all"
                      >
                        <div className="font-bold text-sm text-teal-900 dark:text-teal-200 flex items-center gap-1.5">
                          <QrCode className="w-4 h-4" />
                          📱 Generate QR / 6-Char Code
                        </div>
                        <p className="text-xs text-gray-600 dark:text-slate-400">
                          Patient scans QR or enters code to continue chat/video on their own phone.
                        </p>
                      </button>

                      <button
                        type="button"
                        data-testid="launch-terminal-doctor-btn"
                        onClick={handleLaunchTerminalDoctorSession}
                        className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/30 hover:bg-indigo-100/60 text-left space-y-1 transition-all"
                      >
                        <div className="font-bold text-sm text-indigo-900 dark:text-indigo-200 flex items-center gap-1.5">
                          <Monitor className="w-4 h-4" />
                          🖥️ Launch In-Terminal Session
                        </div>
                        <p className="text-xs text-gray-600 dark:text-slate-400">
                          Queue patient and open the live doctor consultation right on this station.
                        </p>
                      </button>

                      <button
                        type="button"
                        data-testid="send-straight-to-doctor-btn"
                        onClick={handleSendStraightToQueue}
                        className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 hover:bg-emerald-100/60 text-left space-y-1 transition-all"
                      >
                        <div className="font-bold text-sm text-emerald-900 dark:text-emerald-200 flex items-center gap-1.5">
                          <Stethoscope className="w-4 h-4" />
                          🩺 Send Straight to Doctor Queue
                        </div>
                        <p className="text-xs text-gray-600 dark:text-slate-400">
                          Route completed intake directly to the facility/telehealth doctor queue.
                        </p>
                      </button>
                    </div>

                    {/* Handoff Token Display */}
                    {handoffData && (
                      <div
                        data-testid="handoff-qr-display"
                        className="p-4 rounded-2xl bg-slate-900 text-white flex flex-wrap items-center justify-between gap-4"
                      >
                        <div className="space-y-1">
                          <span className="text-xs uppercase tracking-wider text-teal-400 font-bold">
                            Patient Phone Handoff Ready
                          </span>
                          <p className="text-sm font-semibold">
                            Scan QR or visit{' '}
                            <Link
                              href={handoffData.handoffUrl}
                              data-testid="handoff-claim-url"
                              className="underline text-teal-300 font-mono"
                            >
                              {handoffData.handoffUrl}
                            </Link>
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div
                            data-testid="handoff-six-char-code"
                            className="px-4 py-2.5 rounded-xl bg-slate-950 border border-teal-500/40 font-mono text-2xl font-bold tracking-widest text-teal-300"
                          >
                            {handoffData.code}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* In-Terminal Doctor Session View */}
                    {terminalDoctorOpen && (
                      <div
                        data-testid="terminal-doctor-session-panel"
                        className="p-4 rounded-2xl border-2 border-indigo-500/40 bg-indigo-950/10 space-y-3"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="text-sm font-bold text-gray-900 dark:text-white">
                              🖥️ Active Station Doctor Terminal — {activeSession.patientName}
                            </h4>
                            <p className="text-xs text-gray-500 dark:text-slate-400">
                              {terminalDoctorName} · Status: {terminalStatus}
                            </p>
                          </div>
                          <Link
                            href={`/consultations/${activeSession.consultationId}`}
                            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center gap-1.5"
                          >
                            <Video className="w-3.5 h-3.5" />
                            Video Call Room
                          </Link>
                        </div>

                        <div className="max-h-48 overflow-y-auto space-y-2 p-3 rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800">
                          {terminalMessages.map((tm) => (
                            <div
                              key={tm.id}
                              className={`p-2.5 rounded-lg text-xs ${
                                tm.sender === 'doctor'
                                  ? 'bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-slate-100'
                                  : tm.sender === 'system'
                                  ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-center'
                                  : 'bg-indigo-600 text-white ml-auto max-w-[80%]'
                              }`}
                            >
                              {tm.text}
                            </div>
                          ))}
                        </div>

                        <form onSubmit={handleSendTerminalMessage} className="flex gap-2">
                          <input
                            type="text"
                            data-testid="terminal-message-input"
                            placeholder="Send message to Doctor from Care Station..."
                            value={terminalInput}
                            onChange={(e) => setTerminalInput(e.target.value)}
                            className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                          />
                          <Button
                            type="submit"
                            data-testid="terminal-message-send-btn"
                            size="sm"
                            disabled={sendingTerminalMsg}
                          >
                            Send
                          </Button>
                        </form>

                        {/* Meta Muse Wonder Co-Pilot Panel */}
                        {renderCopilotPanel(false)}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}

export default withRoleGuard(CareStationPage, [
  'pharmacist',
  'pharmacy_admin',
  'medicine_store_attendant',
  'receptionist',
  'nurse',
  'midwife',
  'care_home_nurse',
  'doctor',
  'clinic_admin',
  'hospital_admin',
  'care_home_admin',
  'admin',
  'super_admin',
]);
