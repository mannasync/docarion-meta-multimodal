import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Screen,
  Text,
  Card,
  Button,
  Input,
  Sheet,
  StatusBadge,
  SegmentedTabs,
  ChatBubble,
  useTheme,
  useToast,
  keyboardScrollProps,
} from '@docarion/ui';
import {
  intakeApi,
  adminApi,
  useAuthStore,
  usePoll,
  getErrorMessage,
} from '@docarion/core';
import { BackNav } from '../components/BackNav';
import { VitalInput } from '../components/VitalInput';
import { vitalLevel } from '../lib/vitals';
import { haptic } from '../lib/haptics';

type StationMode = 'assisted' | 'kiosk';
type IntakeSubMode = 'chat' | 'structured' | 'scan';
type KioskStep = 'welcome' | 'intake' | 'terminal';

interface StationChatTurn {
  id: string;
  sender: 'patient' | 'ai' | 'doctor' | 'staff';
  senderName?: string;
  text: string;
  timestamp: string;
}

interface PatientSessionState {
  sessionId: string;
  consultationId: string;
  patientId?: string;
  patientName: string;
  maskedName?: string;
  phone: string;
  isReturningPatient?: boolean;
  createdNewAccount?: boolean;
  status: string;
}

interface HandoffState {
  sessionId: string;
  consultationId?: string;
  handoffCode: string;
  handoffToken: string;
  handoffUrl: string;
  expiresAt: string;
}

function maskPatientGreeting(name: string, phone: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || 'Patient';
  const lastInitial = parts.length > 1 ? ` ${parts[parts.length - 1][0]}.` : '';
  const cleanPhone = phone.replace(/\D/g, '');
  const tail = cleanPhone.slice(-4);
  return tail ? `${first}${lastInitial} (•••${tail})` : `${first}${lastInitial}`;
}

export default function CareStationScreen() {
  const theme = useTheme();
  const toast = useToast();
  const router = useRouter();
  const params = useLocalSearchParams<{
    mode?: string;
    sessionId?: string;
    consultationId?: string;
    patientName?: string;
    openTerminal?: string;
  }>();

  const user = useAuthStore((s) => s.user);
  const facilityId = (user?.facilityId as string | undefined) ?? undefined;

  // ── Mode & Kiosk PIN Lock State ───────────────────────────────────────────
  const [stationMode, setStationMode] = useState<StationMode>(
    params.mode === 'kiosk' ? 'kiosk' : 'assisted',
  );
  // PIN chosen by staff when locking this kiosk (this session only). Empty
  // means "use the facility's saved Station PIN", checked with the server.
  const [configuredPin, setConfiguredPin] = useState<string>('');
  const [facilityHasPin, setFacilityHasPin] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [pinEntry, setPinEntry] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockSheetOpen, setUnlockSheetOpen] = useState(false);
  const [unlockPinInput, setUnlockPinInput] = useState('');
  const [unlockError, setUnlockError] = useState('');

  // Hydrate facility Care Station PIN config if available
  useEffect(() => {
    if (!facilityId) return;
    adminApi
      .getCareStationConfig(facilityId)
      .then((cfg) => {
        setFacilityHasPin(cfg?.hasStationPin === true);
      })
      .catch(() => {
        // Offline / not permitted: staff must choose a PIN when locking.
      });
  }, [facilityId]);

  // Intercept Android hardware back when locked in Shared Care Station Kiosk Mode
  useEffect(() => {
    if (stationMode !== 'kiosk') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setUnlockSheetOpen(true);
      return true;
    });
    return () => sub.remove();
  }, [stationMode]);

  // ── Patient Lookup & Session State ────────────────────────────────────────
  const [phone, setPhone] = useState('');
  const [patientName, setPatientName] = useState(
    params.patientName ? decodeURIComponent(String(params.patientName)) : '',
  );
  const [age, setAge] = useState('');
  const [gender, setGender] = useState('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [triageCategory, setTriageCategory] = useState<'routine' | 'urgent' | 'emergency'>('routine');
  const [lookingUp, setLookingUp] = useState(false);

  const [activeSession, setActiveSession] = useState<PatientSessionState | null>(() => {
    if (params.sessionId || params.consultationId) {
      const sid = String(params.sessionId ?? params.consultationId ?? '');
      const cid = String(params.consultationId ?? params.sessionId ?? '');
      const nm = params.patientName ? decodeURIComponent(String(params.patientName)) : 'Walk-In Patient';
      return {
        sessionId: sid,
        consultationId: cid,
        patientName: nm,
        maskedName: maskPatientGreeting(nm, ''),
        phone: '',
        status: params.openTerminal === '1' ? 'in_queue' : 'intake_in_progress',
      };
    }
    return null;
  });

  // ── Assisted / Station Intake State ───────────────────────────────────────
  const [intakeSubMode, setIntakeSubMode] = useState<IntakeSubMode>('chat');
  const [chatTurns, setChatTurns] = useState<StationChatTurn[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [intakeCompleteness, setIntakeCompleteness] = useState<number>(0);
  const [intakeCompleted, setIntakeCompleted] = useState(false);

  // Structured Hx & Vitals
  const [presentingComplaint, setPresentingComplaint] = useState('');
  const [symptomDuration, setSymptomDuration] = useState('');
  const [severity, setSeverity] = useState<'mild' | 'moderate' | 'severe'>('moderate');
  const [hxNotes, setHxNotes] = useState('');
  const [bp, setBp] = useState('');
  const [temp, setTemp] = useState('');
  const [hr, setHr] = useState('');
  const [spo2, setSpo2] = useState('');
  const [weight, setWeight] = useState('');
  const [savingStructured, setSavingStructured] = useState(false);

  // Meta Multimodal Scanner State (SAM 3.1 & NAFDAC)
  const [selectedScanPreset, setSelectedScanPreset] = useState<'coartem' | 'augmentin' | 'tramadol' | 'wound' | 'rdt'>('coartem');
  const [customNafdacRegNo, setCustomNafdacRegNo] = useState('A4-0192');
  const [customDrugName, setCustomDrugName] = useState('Coartem 20/120mg Tablets');
  const [hasActiveLinkedRx, setHasActiveLinkedRx] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);

  const selectPreset = (preset: 'coartem' | 'augmentin' | 'tramadol' | 'wound' | 'rdt') => {
    setSelectedScanPreset(preset);
    if (preset === 'coartem') {
      setCustomNafdacRegNo('A4-0192');
      setCustomDrugName('Coartem 20/120mg Tablets');
      setHasActiveLinkedRx(false);
    } else if (preset === 'augmentin') {
      setCustomNafdacRegNo('04-1928');
      setCustomDrugName('Augmentin 625mg Tablets');
      setHasActiveLinkedRx(false);
    } else if (preset === 'tramadol') {
      setCustomNafdacRegNo('04-8800');
      setCustomDrugName('Tramadol 100mg Capsules');
      setHasActiveLinkedRx(false);
    }
  };

  const handleRunMetaScan = async () => {
    setScanning(true);
    try {
      if (selectedScanPreset === 'wound') {
        const res = (await intakeApi.analyzeVision({
          type: 'wound',
          imageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          clinicalContext: 'Diabetic foot ulcer right plantar surface with granulation tissue',
          consultationId: activeSession?.consultationId,
        })) as any;
        setScanResult(res.data?.data || res.data || res);
        toast.success('SAM 3.1: Wound Bed Area Segmented (10.0 cm²)');
      } else if (selectedScanPreset === 'rdt') {
        const res = (await intakeApi.analyzeVision({
          type: 'rdt_strip',
          imageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          clinicalContext: 'Pf HRP2 malaria rapid test dual line observed',
          consultationId: activeSession?.consultationId,
        })) as any;
        setScanResult(res.data?.data || res.data || res);
        toast.success('SAM 3.1: Dual Line Malaria Positive (P. falciparum)');
      } else {
        const targetRegNo = customNafdacRegNo.trim() || (selectedScanPreset === 'coartem' ? 'A4-0192' : selectedScanPreset === 'augmentin' ? '04-1928' : '04-8800');
        const targetDrug = customDrugName.trim() || (selectedScanPreset === 'coartem' ? 'Coartem 20/120mg Tablets' : selectedScanPreset === 'augmentin' ? 'Augmentin 625mg Tablets' : 'Tramadol 100mg Capsules');
        const facilityLicenceClass = (user?.role?.includes('pharmacy') || user?.role === 'pharmacist') ? 'pharmacy' : 'ppmv';

        const res = (await intakeApi.verifyNafdac({
          nafdacRegNo: targetRegNo,
          drugName: targetDrug,
          facilityLicenceClass,
          hasActiveLinkedRx,
        })) as any;
        const resultData = res.data?.data || res.data || res;
        setScanResult(resultData);

        const allowed = resultData?.ppmvCounterGate?.allowedAtPpmvCounter;
        const drugClass = resultData?.productDetails?.drugClass || resultData?.drugClass;

        if (allowed === false) {
          if (drugClass === 'controlled') {
            toast.error('CONTROLLED SUBSTANCE: Illegal at PPMV Counter!');
          } else {
            toast.error('POM Restricted: Doctor Prescription Required!');
          }
        } else {
          if (hasActiveLinkedRx && drugClass === 'pom') {
            toast.success(`NAFDAC Verified: ${targetDrug} (POM Unlocked via e-Rx)`);
          } else {
            toast.success(`NAFDAC Verified: ${targetDrug} (Permitted OTC)`);
          }
        }
      }
      haptic.success();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Scan analysis failed'));
    } finally {
      setScanning(false);
    }
  };

  // ── Handoff & In-Station Terminal State ───────────────────────────────────
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  const [generatingHandoff, setGeneratingHandoff] = useState(false);
  const [claimCodeInput, setClaimCodeInput] = useState('');
  const [claimingHandoff, setClaimingHandoff] = useState(false);

  const [terminalOpen, setTerminalOpen] = useState(params.openTerminal === '1');
  const [kioskStep, setKioskStep] = useState<KioskStep>(
    params.openTerminal === '1' ? 'terminal' : 'welcome',
  );
  const [sendingToDoctor, setSendingToDoctor] = useState(false);
  const [terminalMsgInput, setTerminalMsgInput] = useState('');
  const [sendingTerminalMsg, setSendingTerminalMsg] = useState(false);

  const activeConsultationId = activeSession?.consultationId || activeSession?.sessionId || '';
  const shouldPollTerminal =
    Boolean(activeConsultationId) &&
    (terminalOpen || (stationMode === 'kiosk' && kioskStep === 'terminal'));

  const terminalPoll = usePoll(
    () => intakeApi.getTerminalSession(activeConsultationId),
    {
      interval: 5000,
      focused: shouldPollTerminal,
      enabled: shouldPollTerminal,
      immediate: true,
    },
  );

  // ── Reset / Wipe Station for Next Patient ─────────────────────────────────
  const clearStationState = useCallback(
    async (notifyBackend = false) => {
      if (notifyBackend && activeConsultationId) {
        try {
          await intakeApi.sendTerminalMessage(activeConsultationId, {
            action: 'end_terminal_session',
          });
        } catch {
          // Best-effort session close notification
        }
      }
      setPhone('');
      setPatientName('');
      setAge('');
      setGender('');
      setChiefComplaint('');
      setTriageCategory('routine');
      setActiveSession(null);
      setChatTurns([]);
      setChatInput('');
      setIntakeCompleteness(0);
      setIntakeCompleted(false);
      setPresentingComplaint('');
      setSymptomDuration('');
      setSeverity('moderate');
      setHxNotes('');
      setBp('');
      setTemp('');
      setHr('');
      setSpo2('');
      setWeight('');
      setHandoff(null);
      setClaimCodeInput('');
      setTerminalOpen(false);
      setTerminalMsgInput('');
      setKioskStep('welcome');
      haptic.select();
    },
    [activeConsultationId],
  );

  // ── Step 1: Patient Phone Lookup / Account Link ───────────────────────────
  const handlePatientLookup = async () => {
    const cleanPhone = phone.trim();
    if (!cleanPhone) {
      toast.error('Enter the patient phone number to look up or create their record');
      return;
    }
    setLookingUp(true);
    try {
      const res = await intakeApi.careStationPatientLookup({
        phone: cleanPhone,
        patientName: patientName.trim() || undefined,
        age: age.trim() ? Number(age) : undefined,
        gender: gender.trim() || undefined,
        chiefComplaint: chiefComplaint.trim() || undefined,
        triageCategory,
        createIfMissing: true,
      });

      const resolvedSessionId = String(
        res?.sessionId ?? res?.walkInId ?? res?.id ?? `cs-${Date.now()}`,
      );
      const resolvedConsultId = String(
        res?.consultationId ?? res?.sessionId ?? resolvedSessionId,
      );
      const patientObj = (res?.patient as Record<string, unknown> | undefined) ?? res;
      const resolvedName = String(
        patientObj?.name ??
          patientObj?.patientName ??
          patientName.trim() ??
          'Walk-In Patient',
      );
      const isReturning = Boolean(
        res?.isReturningPatient ?? res?.existingAccount ?? patientObj?.isReturningPatient,
      );
      const createdNew = Boolean(res?.createdNewAccount ?? !isReturning);

      const sessionState: PatientSessionState = {
        sessionId: resolvedSessionId,
        consultationId: resolvedConsultId,
        patientId: patientObj?.patientId ? String(patientObj.patientId) : undefined,
        patientName: resolvedName,
        maskedName: String(
          res?.maskedName ?? maskPatientGreeting(resolvedName, cleanPhone),
        ),
        phone: cleanPhone,
        isReturningPatient: isReturning,
        createdNewAccount: createdNew,
        status: String(res?.status ?? 'intake_in_progress'),
      };

      setActiveSession(sessionState);
      if (chiefComplaint.trim() && !presentingComplaint) {
        setPresentingComplaint(chiefComplaint.trim());
      }

      const greetingText = isReturning
        ? `Welcome back, ${sessionState.maskedName}. Let's complete your pre-consultation History (Hx) intake so your doctor is ready.`
        : `Account linked for ${sessionState.maskedName}. Let's complete your History (Hx) intake before connecting to the doctor.`;

      setChatTurns([
        {
          id: `ai-init-${Date.now()}`,
          sender: 'ai',
          senderName: 'Docarion Hx Intake Assistant',
          text:
            typeof res?.greeting === 'string' && res.greeting
              ? res.greeting
              : greetingText,
          timestamp: 'Just now',
        },
      ]);

      if (stationMode === 'kiosk') {
        setKioskStep('intake');
      }
      haptic.success();
      toast.success(
        isReturning
          ? `Matched returning patient: ${sessionState.maskedName}`
          : `Created & linked account for ${resolvedName}`,
      );
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not look up or create patient session'));
    } finally {
      setLookingUp(false);
    }
  };

  // ── Step 2A: Assisted / Station AI Intake Chat ────────────────────────────
  const handleSendIntakeChat = async () => {
    if (!activeSession) return;
    const text = chatInput.trim();
    if (!text) return;

    const userTurn: StationChatTurn = {
      id: `p-${Date.now()}`,
      sender: stationMode === 'kiosk' ? 'patient' : 'staff',
      senderName: stationMode === 'kiosk' ? activeSession.maskedName : 'Assisted Intake',
      text,
      timestamp: 'Now',
    };
    setChatTurns((prev) => [...prev, userTurn]);
    setChatInput('');
    setSendingChat(true);

    try {
      const vitalsPayload =
        bp || temp || hr || spo2 || weight
          ? {
              ...(bp ? { bp: bp.trim() } : {}),
              ...(temp ? { temp: Number(temp) } : {}),
              ...(hr ? { hr: Number(hr) } : {}),
              ...(spo2 ? { spo2: Number(spo2) } : {}),
              ...(weight ? { weight: Number(weight) } : {}),
            }
          : undefined;

      const res = await intakeApi.walkInChat(activeSession.sessionId, {
        message: text,
        vitals: vitalsPayload,
      });

      const replyText = String(
        res?.aiResponse ??
          res?.message ??
          res?.reply ??
          'Thank you. I have recorded that in the clinical Hx brief.',
      );
      const rawComp = res?.completeness;
      const pct =
        typeof rawComp === 'number'
          ? rawComp <= 1
            ? Math.round(rawComp * 100)
            : Math.round(rawComp)
          : typeof (rawComp as { percent?: number } | undefined)?.percent === 'number'
            ? Math.round((rawComp as { percent: number }).percent)
            : Math.min(100, intakeCompleteness + 35);

      setIntakeCompleteness(pct);
      if (res?.isComplete === true || pct >= 100) {
        setIntakeCompleted(true);
      }

      setChatTurns((prev) => [
        ...prev,
        {
          id: `ai-${Date.now()}`,
          sender: 'ai',
          senderName: 'Docarion Hx Intake Assistant',
          text: replyText,
          timestamp: 'Now',
        },
      ]);
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not send intake message'));
    } finally {
      setSendingChat(false);
    }
  };

  // ── Step 2B: Structured Hx & Vitals Save ──────────────────────────────────
  const handleSaveStructuredAndVitals = async () => {
    if (!activeSession) return;
    const complaint = presentingComplaint.trim() || chiefComplaint.trim();
    if (!complaint) {
      toast.error('Presenting complaint is required to complete Hx intake');
      return;
    }

    setSavingStructured(true);
    try {
      const hasAnyVitals = Boolean(bp.trim() || temp.trim() || hr.trim() || spo2.trim() || weight.trim());
      if (hasAnyVitals) {
        await intakeApi.walkInVitals(activeSession.sessionId, {
          ...(bp.trim() ? { bp: bp.trim() } : {}),
          ...(temp.trim() ? { temp: Number(temp) } : {}),
          ...(hr.trim() ? { hr: Number(hr) } : {}),
          ...(spo2.trim() ? { spo2: Number(spo2) } : {}),
          ...(weight.trim() ? { weight: Number(weight) } : {}),
        });
      }

      const structuredPayload = {
        presentingComplaint: complaint,
        symptomDuration: symptomDuration.trim() || 'Not specified',
        severity,
        notes: hxNotes.trim() || undefined,
        vitals: hasAnyVitals
          ? {
              bp: bp.trim() || undefined,
              temp: temp.trim() ? Number(temp) : undefined,
              hr: hr.trim() ? Number(hr) : undefined,
              spo2: spo2.trim() ? Number(spo2) : undefined,
              weight: weight.trim() ? Number(weight) : undefined,
            }
          : undefined,
      };

      if (activeSession.consultationId) {
        await intakeApi.nurseComplete(activeSession.consultationId, structuredPayload);
      } else {
        await intakeApi.walkInChat(activeSession.sessionId, {
          message: `Chief complaint: ${complaint} (${symptomDuration.trim() || 'duration unspecified'}, ${severity}). ${hxNotes.trim()}`,
          structuredHx: structuredPayload,
        });
      }

      setIntakeCompleteness(100);
      setIntakeCompleted(true);
      haptic.success();
      toast.success('Hx intake & bedside vitals recorded');
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not save structured Hx & vitals'));
    } finally {
      setSavingStructured(false);
    }
  };

  // ── Step 3A: Generate Phone Handoff Code / QR URL ─────────────────────────
  const handleCreateHandoff = async () => {
    if (!activeSession) return;
    setGeneratingHandoff(true);
    try {
      const res = await intakeApi.createHandoffToken(activeSession.sessionId);
      setHandoff(res);
      haptic.success();
      toast.success(`Phone handoff code generated: ${res.handoffCode}`);
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not generate phone handoff code'));
    } finally {
      setGeneratingHandoff(false);
    }
  };

  // ── Claim Handoff Code Helper ─────────────────────────────────────────────
  const handleClaimHandoffCode = async () => {
    const code = claimCodeInput.trim().toUpperCase();
    if (!code) {
      toast.error('Enter the 6-character handoff code');
      return;
    }
    setClaimingHandoff(true);
    try {
      const res = await intakeApi.claimHandoff({
        code,
        phone: phone.trim() || activeSession?.phone || undefined,
      });
      const sid = String(res?.sessionId ?? activeSession?.sessionId ?? code);
      const cid = String(res?.consultationId ?? sid);
      const nm = String(res?.patientName ?? activeSession?.patientName ?? 'Walk-In Patient');
      setActiveSession({
        sessionId: sid,
        consultationId: cid,
        patientName: nm,
        maskedName: maskPatientGreeting(nm, phone.trim()),
        phone: String(res?.phone ?? phone.trim()),
        status: String(res?.status ?? 'in_queue'),
      });
      toast.success(`Handoff session ${code} claimed`);
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not claim handoff code'));
    } finally {
      setClaimingHandoff(false);
    }
  };

  // ── Step 3B & 3C: Send to Doctor Queue / Open Station Terminal ────────────
  const handleSendToDoctor = async (openStationTerminal: boolean) => {
    if (!activeSession) return;
    setSendingToDoctor(true);
    try {
      const res = (await intakeApi.walkInSend(activeSession.sessionId)) as
        | Record<string, unknown>
        | undefined;
      const cid = String(
        res?.consultationId ?? activeSession.consultationId ?? activeSession.sessionId,
      );
      setActiveSession((prev) =>
        prev
          ? {
              ...prev,
              consultationId: cid,
              status: 'in_queue',
            }
          : prev,
      );
      haptic.success();

      if (openStationTerminal) {
        setTerminalOpen(true);
        if (stationMode === 'kiosk') {
          setKioskStep('terminal');
        }
        toast.success('Connected to Station Consultation Terminal');
      } else {
        toast.success(`${activeSession.patientName} sent to doctor queue`);
        await clearStationState(false);
      }
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not send patient to doctor queue'));
    } finally {
      setSendingToDoctor(false);
    }
  };

  // ── In-Station Terminal Message Send ──────────────────────────────────────
  const handleSendTerminalMessage = async () => {
    if (!activeConsultationId) return;
    const content = terminalMsgInput.trim();
    if (!content) return;
    setSendingTerminalMsg(true);
    try {
      await intakeApi.sendTerminalMessage(activeConsultationId, { content });
      setTerminalMsgInput('');
      await terminalPoll.refresh();
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not send message to doctor'));
    } finally {
      setSendingTerminalMsg(false);
    }
  };

  // ── Launch & Unlock Kiosk Mode ────────────────────────────────────────────
  const confirmLaunchKiosk = () => {
    const cleanPin = pinEntry.trim();
    if (cleanPin.length < 4 && !facilityHasPin) {
      toast.error('Enter a 4-digit Staff Exit PIN to lock the kiosk');
      return;
    }
    setConfiguredPin(cleanPin.length >= 4 ? cleanPin : '');
    setPinSetupOpen(false);
    setStationMode('kiosk');
    setKioskStep(activeSession ? (terminalOpen ? 'terminal' : 'intake') : 'welcome');
    haptic.success();
    toast.success('Shared Care Station Kiosk Mode locked');
  };

  const confirmStaffUnlock = async () => {
    const attempt = unlockPinInput.trim();
    if (configuredPin) {
      if (attempt !== configuredPin) {
        setUnlockError('Incorrect 4-digit Staff PIN');
        return;
      }
    } else if (facilityId && facilityHasPin) {
      setUnlocking(true);
      try {
        await adminApi.verifyCareStationPin(facilityId, attempt);
      } catch (e) {
        setUnlockError(getErrorMessage(e, 'Incorrect Staff PIN'));
        return;
      } finally {
        setUnlocking(false);
      }
    } else {
      setUnlockError('No Staff PIN is set for this station. Ask a site admin to unlock it.');
      return;
    }
    setUnlockError('');
    setUnlockPinInput('');
    setUnlockSheetOpen(false);
    setStationMode('assisted');
    haptic.success();
    toast.success('Staff mode unlocked');
  };

  const systolic = bp.split('/')[0];
  const terminalData = (terminalPoll.data ?? {}) as Record<string, unknown>;
  const terminalMessages = Array.isArray(terminalData.messages)
    ? (terminalData.messages as Array<Record<string, unknown>>)
    : [];
  const assignedDoctorName = String(
    terminalData.doctorName ??
      (terminalData.doctor as Record<string, unknown> | undefined)?.name ??
      '',
  );
  const terminalStatus = String(
    terminalData.status ?? activeSession?.status ?? 'waiting_for_doctor',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER: CONSULTATION TERMINAL CARD (Shared by Assisted Terminal & Kiosk)
  // ══════════════════════════════════════════════════════════════════════════
  const renderTerminalSurface = () => (
    <Card style={{ marginTop: 12 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text variant="heading">🖥️ Station Consultation Terminal</Text>
          <Text variant="caption" muted style={{ marginTop: 2 }}>
            {assignedDoctorName
              ? `Connected with Dr. ${assignedDoctorName}`
              : 'Waiting in priority queue — next available doctor will join here'}
          </Text>
        </View>
        <StatusBadge status={terminalStatus} />
      </View>

      <View
        style={{
          backgroundColor: theme.color.surfaceAlt,
          borderRadius: theme.radii.lg,
          padding: 12,
          minHeight: 220,
          maxHeight: 360,
          marginBottom: 12,
        }}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          {terminalMessages.length === 0 ? (
            <View style={{ paddingVertical: 32, alignItems: 'center' }}>
              <Text variant="bodyMedium" center>
                🩺 Doctor Queue Active for {activeSession?.maskedName || activeSession?.patientName}
              </Text>
              <Text variant="caption" muted center style={{ marginTop: 6 }}>
                Your pre-consultation Hx intake & vitals have been delivered to the doctor. You can send additional notes below while you wait.
              </Text>
            </View>
          ) : (
            terminalMessages.map((m, idx) => {
              const senderRole = String(m.senderRole ?? m.role ?? '');
              const isPatientSide = senderRole === 'patient' || m.sentByPatient === true;
              return (
                <ChatBubble
                  key={String(m.id ?? m.messageId ?? idx)}
                  message={String(m.content ?? m.message ?? '')}
                  sent={isPatientSide}
                  senderName={
                    isPatientSide
                      ? activeSession?.maskedName
                      : String(m.senderName ?? (assignedDoctorName || 'Doctor'))
                  }
                  timestamp={m.createdAt ? String(m.createdAt).slice(11, 16) : undefined}
                />
              );
            })
          )}
        </ScrollView>
      </View>

      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Input
            label="Message doctor"
            value={terminalMsgInput}
            onChangeText={setTerminalMsgInput}
            placeholder="Type a message or question for the doctor..."
          />
        </View>
        <Button
          label="Send"
          fullWidth={false}
          loading={sendingTerminalMsg}
          onPress={handleSendTerminalMessage}
        />
      </View>

      <View style={{ height: 14 }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Button
          label="📱 Transfer to My Phone (Get 6-Digit Code)"
          variant="outline"
          size="sm"
          fullWidth={false}
          loading={generatingHandoff}
          onPress={handleCreateHandoff}
        />
        <Button
          label="Finish & Clear Station for Next Patient"
          variant="danger"
          size="sm"
          fullWidth={false}
          onPress={() => void clearStationState(true)}
        />
      </View>
    </Card>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER: HANDOFF CODE / QR LINK BANNER
  // ══════════════════════════════════════════════════════════════════════════
  const renderHandoffBanner = () => {
    if (!handoff) return null;
    return (
      <Card
        style={{
          marginTop: 12,
          borderWidth: 2,
          borderColor: theme.color.primary,
          backgroundColor: theme.color.primarySoft,
        }}
      >
        <Text variant="label" style={{ color: theme.color.primary }}>
          📱 Phone Handoff Code Ready
        </Text>
        <Text variant="caption" muted style={{ marginTop: 4 }}>
          Patient can enter this 6-character code or open the link on their phone to continue their consultation:
        </Text>
        <View
          style={{
            marginVertical: 12,
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderRadius: theme.radii.lg,
            backgroundColor: theme.color.surface,
            alignItems: 'center',
          }}
        >
          <Text
            style={{
              fontSize: 30,
              letterSpacing: 6,
              fontFamily: theme.fontFamily.bold,
              color: theme.color.primary,
            }}
          >
            {handoff.handoffCode}
          </Text>
          <Text variant="caption" subtle style={{ marginTop: 6 }} numberOfLines={1}>
            {handoff.handoffUrl}
          </Text>
        </View>
        <Text variant="caption" muted>
          Expires: {handoff.expiresAt}
        </Text>
      </Card>
    );
  };

  // ══════════════════════════════════════════════════════════════════════════
  // MODE 2: SHARED CARE STATION KIOSK MODE (PIN-Locked Multi-Patient Terminal)
  // ══════════════════════════════════════════════════════════════════════════
  if (stationMode === 'kiosk') {
    return (
      <Screen back={false} edges={['top']} keyboardAware={false}>
        {/* Kiosk Top Bar — Hides all staff navigation, requires 4-digit PIN to exit */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingBottom: 12,
            marginBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.color.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
            <Text style={{ fontSize: 24 }}>🖥️</Text>
            <View style={{ flex: 1 }}>
              <Text variant="heading" numberOfLines={1}>
                Docarion Care Station Kiosk
              </Text>
              <Text variant="caption" muted numberOfLines={1}>
                Self-Service Check-In, Hx Intake & Doctor Consultation Terminal
              </Text>
            </View>
          </View>
          <Button
            label="Staff Unlock 🔒"
            variant="outline"
            size="sm"
            fullWidth={false}
            onPress={() => {
              setUnlockError('');
              setUnlockPinInput('');
              setUnlockSheetOpen(true);
            }}
          />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={80}
        >
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 32 }}
            {...keyboardScrollProps}
          >
            {/* Kiosk Step 1: Phone Check-In */}
            {kioskStep === 'welcome' || !activeSession ? (
              <Card>
                <Text variant="heading" style={{ marginBottom: 6 }}>
                  Welcome — Start Your Visit
                </Text>
                <Text variant="body" muted style={{ marginBottom: 16 }}>
                  Enter your phone number to pull up your existing account or register a new walk-in visit at this station.
                </Text>

                <View style={{ gap: 12 }}>
                  <Input
                    label="Phone Number *"
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="0801 234 5678 or +234..."
                    keyboardType="phone-pad"
                  />
                  <Input
                    label="Full Name (if new patient)"
                    value={patientName}
                    onChangeText={setPatientName}
                    placeholder="First & Last Name"
                  />
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Input
                      label="Age (optional)"
                      value={age}
                      onChangeText={setAge}
                      placeholder="32"
                      keyboardType="numeric"
                      containerStyle={{ flex: 1 }}
                    />
                    <Input
                      label="Gender (optional)"
                      value={gender}
                      onChangeText={setGender}
                      placeholder="M / F"
                      containerStyle={{ flex: 1 }}
                    />
                  </View>
                  <Input
                    label="Main Symptom / Reason for Visit"
                    value={chiefComplaint}
                    onChangeText={setChiefComplaint}
                    placeholder="e.g. Fever and headache for 2 days"
                  />

                  <Button
                    label="Continue to Hx Intake →"
                    size="lg"
                    loading={lookingUp}
                    onPress={handlePatientLookup}
                  />
                </View>
              </Card>
            ) : null}

            {/* Kiosk Step 2: Hx Intake & Station Vitals */}
            {activeSession && kioskStep === 'intake' ? (
              <View style={{ gap: 12 }}>
                <Card
                  style={{
                    backgroundColor: theme.color.primarySoft,
                    borderColor: theme.color.primary,
                    borderWidth: 1,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyMedium" style={{ color: theme.color.primary }}>
                        {activeSession.isReturningPatient
                          ? `Welcome back, ${activeSession.maskedName}`
                          : `Checked in: ${activeSession.maskedName}`}
                      </Text>
                      <Text variant="caption" muted style={{ marginTop: 2 }}>
                        Complete your short History (Hx) intake below before speaking with the doctor.
                      </Text>
                    </View>
                    <Button
                      label="Clear Station"
                      variant="ghost"
                      size="sm"
                      fullWidth={false}
                      onPress={() => void clearStationState(false)}
                    />
                  </View>
                </Card>

                <SegmentedTabs
                  value={intakeSubMode}
                  onChange={setIntakeSubMode}
                  options={[
                    { value: 'chat', label: '🤖 AI Intake Chat' },
                    { value: 'structured', label: '📋 Quick Form & Vitals' },
                  ]}
                />

                {intakeSubMode === 'chat' ? (
                  <Card>
                    <Text variant="label" style={{ marginBottom: 8 }}>
                      AI History (Hx) Intake ({intakeCompleteness}% complete)
                    </Text>
                    <View
                      style={{
                        backgroundColor: theme.color.surfaceAlt,
                        borderRadius: theme.radii.lg,
                        padding: 12,
                        minHeight: 180,
                        maxHeight: 280,
                        marginBottom: 12,
                      }}
                    >
                      <ScrollView showsVerticalScrollIndicator={false}>
                        {chatTurns.map((turn) => (
                          <ChatBubble
                            key={turn.id}
                            message={turn.text}
                            sent={turn.sender !== 'ai'}
                            senderName={turn.senderName}
                            timestamp={turn.timestamp}
                          />
                        ))}
                      </ScrollView>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                      <View style={{ flex: 1 }}>
                        <Input
                          label="Your reply"
                          value={chatInput}
                          onChangeText={setChatInput}
                          placeholder="Describe your symptoms, duration, medications..."
                        />
                      </View>
                      <Button
                        label="Send"
                        fullWidth={false}
                        loading={sendingChat}
                        onPress={handleSendIntakeChat}
                      />
                    </View>
                  </Card>
                ) : (
                  <Card>
                    <Text variant="label" style={{ marginBottom: 10 }}>
                      Quick Symptoms & Station Vitals
                    </Text>
                    <View style={{ gap: 10 }}>
                      <Input
                        label="Main Symptom / Complaint *"
                        value={presentingComplaint}
                        onChangeText={setPresentingComplaint}
                        placeholder="What brings you in today?"
                      />
                      <Input
                        label="How long has this been happening?"
                        value={symptomDuration}
                        onChangeText={setSymptomDuration}
                        placeholder="e.g. 3 days"
                      />
                      <View style={{ flexDirection: 'row', gap: 10 }}>
                        <View style={{ flex: 1 }}>
                          <VitalInput
                            label="BP (optional)"
                            unit="mmHg"
                            value={bp}
                            onChangeText={setBp}
                            placeholder="120/80"
                            level={vitalLevel('systolic', systolic)}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <VitalInput
                            label="Temp (optional)"
                            unit="°C"
                            value={temp}
                            onChangeText={setTemp}
                            keyboard="decimal-pad"
                            placeholder="36.8"
                            level={vitalLevel('temperature', temp)}
                          />
                        </View>
                      </View>
                      <Button
                        label="Save Intake Details"
                        variant="secondary"
                        loading={savingStructured}
                        onPress={handleSaveStructuredAndVitals}
                      />
                    </View>
                  </Card>
                )}

                <Card>
                  <Text variant="label" style={{ marginBottom: 8 }}>
                    Ready to See the Doctor?
                  </Text>
                  <View style={{ gap: 10 }}>
                    <Button
                      label="🖥️ Join Queue & Talk to Doctor on This Station"
                      size="lg"
                      loading={sendingToDoctor}
                      onPress={() => void handleSendToDoctor(true)}
                    />
                    <Button
                      label="📱 Continue on My Own Phone (Get 6-Digit Code)"
                      variant="outline"
                      loading={generatingHandoff}
                      onPress={handleCreateHandoff}
                    />
                  </View>
                </Card>

                {renderHandoffBanner()}
              </View>
            ) : null}

            {/* Kiosk Step 3: Live Station Consultation Terminal */}
            {activeSession && kioskStep === 'terminal' ? (
              <View>
                {renderTerminalSurface()}
                {renderHandoffBanner()}
              </View>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>

        {/* Staff PIN Unlock Modal */}
        <Sheet
          visible={unlockSheetOpen}
          onClose={() => setUnlockSheetOpen(false)}
          title="Staff Unlock — Exit Kiosk Mode"
          scroll={false}
        >
          <View style={{ gap: 12, paddingBottom: 8 }}>
            <Text variant="body" muted>
              Enter the 4-digit Staff Exit PIN to unlock this station and return to Docarion Pro staff navigation.
            </Text>
            <Input
              label="4-Digit Staff PIN"
              value={unlockPinInput}
              onChangeText={(v) => {
                setUnlockPinInput(v);
                setUnlockError('');
              }}
              placeholder="••••"
              keyboardType="number-pad"
              secureTextEntry
              error={unlockError || undefined}
            />
            <Button label="Unlock Staff Mode" size="lg" loading={unlocking} onPress={() => { void confirmStaffUnlock(); }} />
            <Button label="Cancel" variant="ghost" onPress={() => setUnlockSheetOpen(false)} />
          </View>
        </Sheet>
      </Screen>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODE 1: STAFF-ASSISTED INTAKE, PHONE HANDOFF & CONSULTATION TERMINAL
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <Screen
      scroll
      title="Care Station & Outpost"
      subtitle="Assisted Intake, Phone Handoff & Shared Kiosk Terminal"
      headerLeft={<BackNav />}
    >
      {/* Kiosk Launcher Banner */}
      <Card
        style={{
          marginBottom: 14,
          borderWidth: 1,
          borderColor: theme.color.primary,
          backgroundColor: theme.color.primarySoft,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium" style={{ color: theme.color.primary }}>
              🖥️ Shared Care Station Kiosk Mode
            </Text>
            <Text variant="caption" muted style={{ marginTop: 2 }}>
              Lock this tablet/phone at a nursing bay or pharmacy counter so walk-in patients can check in by phone number, complete Hx intake, and consult with a doctor.
            </Text>
          </View>
          <Button
            label="Launch Shared Care Station Kiosk"
            size="sm"
            fullWidth={false}
            onPress={() => setPinSetupOpen(true)}
          />
        </View>
      </Card>

      {/* Step 1: Patient Phone Lookup / Account Link */}
      <Card style={{ marginBottom: 14 }}>
        <Text variant="label" style={{ marginBottom: 4 }}>
          1. Patient Phone Lookup & Walk-In Account Link
        </Text>
        <Text variant="caption" muted style={{ marginBottom: 12 }}>
          Enter the patient’s phone number to pull up their existing Docarion account or create a phone-linked walk-in profile.
        </Text>

        <View style={{ gap: 10 }}>
          <Input
            label="Patient Phone Number *"
            value={phone}
            onChangeText={setPhone}
            placeholder="0801 234 5678 or +234..."
            keyboardType="phone-pad"
          />
          <Input
            label="Patient Name (optional if existing)"
            value={patientName}
            onChangeText={setPatientName}
            placeholder="Full name"
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Input
              label="Age"
              value={age}
              onChangeText={setAge}
              placeholder="35"
              keyboardType="numeric"
              containerStyle={{ flex: 1 }}
            />
            <Input
              label="Gender"
              value={gender}
              onChangeText={setGender}
              placeholder="M / F / Other"
              containerStyle={{ flex: 1 }}
            />
          </View>
          <Input
            label="Chief Complaint"
            value={chiefComplaint}
            onChangeText={setChiefComplaint}
            placeholder="Reason for visit"
          />
          <View>
            <Text variant="caption" muted style={{ marginBottom: 6 }}>
              Triage Priority
            </Text>
            <SegmentedTabs
              value={triageCategory}
              onChange={setTriageCategory}
              options={[
                { value: 'routine', label: 'Routine' },
                { value: 'urgent', label: 'Urgent' },
                { value: 'emergency', label: 'Emergency' },
              ]}
            />
          </View>

          <Button
            label={activeSession ? 'Re-Link / Switch Patient' : 'Look Up / Link Patient Account'}
            loading={lookingUp}
            onPress={handlePatientLookup}
          />
        </View>
      </Card>

      {/* Active Patient Session Banner */}
      {activeSession ? (
        <View style={{ gap: 14 }}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text variant="heading">{activeSession.patientName}</Text>
                <Text variant="caption" muted style={{ marginTop: 2 }}>
                  {activeSession.isReturningPatient
                    ? 'Returning Patient Account Matched'
                    : 'Phone-Linked Walk-In Account Ready'}{' '}
                  · Session {activeSession.sessionId}
                </Text>
              </View>
              <StatusBadge status={activeSession.status} />
            </View>
          </Card>

          {/* Step 2: Staff-Assisted Hx Intake & Vitals */}
          <Card>
            <Text variant="label" style={{ marginBottom: 8 }}>
              2. Staff-Assisted Hx Intake & Bedside Vitals
            </Text>
            <SegmentedTabs
              value={intakeSubMode}
              onChange={setIntakeSubMode}
              options={[
                { value: 'chat', label: '🤖 Assisted AI Chat' },
                { value: 'structured', label: '📋 Structured Hx' },
                { value: 'scan', label: '🔬 Meta AI Scanner' },
              ]}
              style={{ marginBottom: 12 }}
            />

            {intakeSubMode === 'chat' ? (
              <View>
                <View
                  style={{
                    backgroundColor: theme.color.surfaceAlt,
                    borderRadius: theme.radii.lg,
                    padding: 12,
                    minHeight: 160,
                    maxHeight: 260,
                    marginBottom: 10,
                  }}
                >
                  <ScrollView showsVerticalScrollIndicator={false}>
                    {chatTurns.map((turn) => (
                      <ChatBubble
                        key={turn.id}
                        message={turn.text}
                        sent={turn.sender !== 'ai'}
                        senderName={turn.senderName}
                        timestamp={turn.timestamp}
                      />
                    ))}
                  </ScrollView>
                </View>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Input
                      label="Enter patient's response"
                      value={chatInput}
                      onChangeText={setChatInput}
                      placeholder="Type patient's symptom history..."
                    />
                  </View>
                  <Button
                    label="Send"
                    fullWidth={false}
                    loading={sendingChat}
                    onPress={handleSendIntakeChat}
                  />
                </View>
              </View>
            ) : intakeSubMode === 'structured' ? (
              <View style={{ gap: 10 }}>
                <Input
                  label="Presenting Complaint *"
                  value={presentingComplaint}
                  onChangeText={setPresentingComplaint}
                  placeholder="Primary symptom & reason for visit"
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Input
                    label="Duration"
                    value={symptomDuration}
                    onChangeText={setSymptomDuration}
                    placeholder="e.g. 2 days"
                    containerStyle={{ flex: 1 }}
                  />
                  <Input
                    label="Clinical Notes / HPI"
                    value={hxNotes}
                    onChangeText={setHxNotes}
                    placeholder="Allergies, meds, notes"
                    containerStyle={{ flex: 1 }}
                  />
                </View>
                <SegmentedTabs
                  value={severity}
                  onChange={setSeverity}
                  options={[
                    { value: 'mild', label: 'Mild' },
                    { value: 'moderate', label: 'Moderate' },
                    { value: 'severe', label: 'Severe' },
                  ]}
                />

                <Text variant="label" style={{ marginTop: 6 }}>
                  Bedside Vitals
                </Text>
                <VitalInput
                  label="Blood pressure"
                  unit="mmHg"
                  value={bp}
                  onChangeText={setBp}
                  placeholder="120/80"
                  level={vitalLevel('systolic', systolic)}
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <VitalInput
                      label="Temperature"
                      unit="°C"
                      value={temp}
                      onChangeText={setTemp}
                      keyboard="decimal-pad"
                      placeholder="36.8"
                      level={vitalLevel('temperature', temp)}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <VitalInput
                      label="Heart rate"
                      unit="bpm"
                      value={hr}
                      onChangeText={setHr}
                      keyboard="numeric"
                      placeholder="72"
                      level={vitalLevel('heartRate', hr)}
                    />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <VitalInput
                      label="SpO₂"
                      unit="%"
                      value={spo2}
                      onChangeText={setSpo2}
                      keyboard="numeric"
                      placeholder="98"
                      level={vitalLevel('oxygenSaturation', spo2)}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <VitalInput
                      label="Weight"
                      unit="kg"
                      value={weight}
                      onChangeText={setWeight}
                      keyboard="decimal-pad"
                      placeholder="70"
                      level="normal"
                    />
                  </View>
                </View>

                <Button
                  label={intakeCompleted ? 'Update Hx & Vitals' : 'Save Vitals & Complete Hx Intake'}
                  variant={intakeCompleted ? 'secondary' : 'primary'}
                  loading={savingStructured}
                  onPress={handleSaveStructuredAndVitals}
                />
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                <Text variant="caption" muted>
                  Select a clinical or pharmaceutical preset to test Meta Model API (SAM 3.1 & Muse Spark) with NAFDAC & PCN verification:
                </Text>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {[
                    { id: 'coartem', label: 'Coartem (OTC)' },
                    { id: 'augmentin', label: 'Augmentin (POM)' },
                    { id: 'tramadol', label: 'Tramadol (Controlled)' },
                    { id: 'wound', label: 'Wound Bed Area' },
                    { id: 'rdt', label: 'Malaria RDT Strip' },
                  ].map((p) => (
                    <Pressable
                      key={p.id}
                      onPress={() => selectPreset(p.id as any)}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: theme.radii.md,
                        backgroundColor: selectedScanPreset === p.id ? theme.color.primary : theme.color.surfaceAlt,
                      }}
                    >
                      <Text
                        variant="caption"
                        style={{
                          color: selectedScanPreset === p.id ? '#ffffff' : theme.color.text,
                          fontWeight: selectedScanPreset === p.id ? '700' : '400',
                        }}
                      >
                        {p.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {selectedScanPreset !== 'wound' && selectedScanPreset !== 'rdt' && (
                  <View style={{ gap: 8 }}>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <Input
                        label="NAFDAC Reg No"
                        value={customNafdacRegNo}
                        onChangeText={setCustomNafdacRegNo}
                        placeholder="e.g. A4-0192, 04-1928"
                        containerStyle={{ flex: 1 }}
                      />
                      <Input
                        label="Drug Name / Strength"
                        value={customDrugName}
                        onChangeText={setCustomDrugName}
                        placeholder="e.g. Coartem 20/120mg"
                        containerStyle={{ flex: 1 }}
                      />
                    </View>

                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        backgroundColor: theme.color.surface,
                        padding: 10,
                        borderRadius: theme.radii.md,
                        borderWidth: 1,
                        borderColor: theme.color.border,
                      }}
                    >
                      <View style={{ flex: 1, marginRight: 10 }}>
                        <Text variant="caption" style={{ fontWeight: '600' }}>
                          Active Physician e-Rx Linked
                        </Text>
                        <Text variant="caption" muted style={{ fontSize: 11 }}>
                          Unlocks POM counter dispensing per PCN regulation
                        </Text>
                      </View>
                      <Switch
                        value={hasActiveLinkedRx}
                        onValueChange={setHasActiveLinkedRx}
                        trackColor={{ false: theme.color.border, true: theme.color.primary }}
                      />
                    </View>
                  </View>
                )}

                <Button
                  label={
                    scanning
                      ? 'Analyzing via Meta AI...'
                      : selectedScanPreset === 'wound' || selectedScanPreset === 'rdt'
                      ? '⚡ Run SAM 3.1 Planimetry Inspection'
                      : '⚡ Run NAFDAC & PCN Gate Inspection'
                  }
                  variant="primary"
                  loading={scanning}
                  onPress={handleRunMetaScan}
                />

                {scanResult && (
                  <View
                    style={{
                      backgroundColor: theme.color.surfaceAlt,
                      borderRadius: theme.radii.lg,
                      padding: 12,
                      gap: 8,
                      borderLeftWidth: 4,
                      borderLeftColor:
                        scanResult?.ppmvCounterGate?.allowedAtPpmvCounter === false || scanResult?.authenticityStatus === 'counterfeit_flagged'
                          ? theme.color.danger
                          : theme.color.success,
                    }}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text variant="caption" style={{ fontWeight: '700' }}>
                        {scanResult?.productDetails?.brandName || scanResult?.type?.toUpperCase() || 'SCAN COMPLETED'}
                      </Text>
                      <StatusBadge
                        status={
                          scanResult?.ppmvCounterGate?.allowedAtPpmvCounter === false
                            ? 'urgent'
                            : 'active'
                        }
                        label={
                          scanResult?.ppmvCounterGate?.allowedAtPpmvCounter === false
                            ? (scanResult?.productDetails?.drugClass === 'controlled' || scanResult?.drugClass === 'controlled' ? 'CONTROLLED SUBSTANCE' : 'POM RESTRICTED')
                            : (hasActiveLinkedRx && (scanResult?.productDetails?.drugClass === 'pom' || scanResult?.drugClass === 'pom') ? 'POM UNLOCKED (e-Rx)' : 'OTC PERMITTED')
                        }
                      />
                    </View>

                    {scanResult?.nafdacRegNo && (
                      <Text variant="caption">
                        NAFDAC Reg No: <Text variant="caption" style={{ fontWeight: '700' }}>{scanResult.nafdacRegNo}</Text> ({scanResult.authenticityStatus})
                      </Text>
                    )}

                    {scanResult?.ppmvCounterGate?.statusBanner && (
                      <Text variant="caption" style={{ color: theme.color.textMuted }}>
                        {scanResult.ppmvCounterGate.statusBanner}
                      </Text>
                    )}

                    {scanResult?.samPlanimetry && (
                      <Text variant="caption" style={{ color: theme.color.primary, fontWeight: '700' }}>
                        📐 SAM 3.1 Wound Planimetry: {scanResult.samPlanimetry.woundAreaCm2} cm² (Tissue: {scanResult.samPlanimetry.granulationPercentage}% granulation)
                      </Text>
                    )}

                    {scanResult?.rdtResult && (
                      <Text variant="caption" style={{ color: theme.color.primary, fontWeight: '700' }}>
                        🧪 Malaria RDT: {scanResult.rdtResult.controlBandPresent ? 'Valid Test' : 'Invalid'} · Parasite: {scanResult.rdtResult.speciesDetected}
                      </Text>
                    )}

                    {scanResult?.telemetry && (
                      <Text variant="caption" style={{ fontSize: 10, color: theme.color.textMuted }}>
                        ⚡ Meta Model: {scanResult.telemetry.model} · {scanResult.telemetry.latencyMs}ms · Cached: {scanResult.telemetry.cached ? 'Yes' : 'No'}
                      </Text>
                    )}

                    {scanResult?.ppmvCounterGate?.allowedAtPpmvCounter === false && (
                      <Button
                        label="🚨 Escalate to Telehealth Physician"
                        variant="danger"
                        onPress={() => void handleSendToDoctor(false)}
                      />
                    )}
                  </View>
                )}
              </View>
            )}
          </Card>

          {/* Step 3: Select How the Patient Continues */}
          <Card>
            <Text variant="label" style={{ marginBottom: 4 }}>
              3. Patient Handoff or Station Consultation
            </Text>
            <Text variant="caption" muted style={{ marginBottom: 12 }}>
              Choose how {activeSession.patientName} will see the doctor after intake:
            </Text>

            <View style={{ gap: 10 }}>
              <Button
                label="📱 Phone Handoff (Code / QR Link)"
                variant="outline"
                loading={generatingHandoff}
                onPress={handleCreateHandoff}
              />
              <Button
                label="🖥️ Open Station Consultation Terminal"
                variant="secondary"
                loading={sendingToDoctor && terminalOpen}
                onPress={() => void handleSendToDoctor(true)}
              />
              <Button
                label="🩺 Send Straight to Doctor Queue"
                loading={sendingToDoctor && !terminalOpen}
                onPress={() => void handleSendToDoctor(false)}
              />
            </View>
          </Card>

          {renderHandoffBanner()}
          {terminalOpen ? renderTerminalSurface() : null}
        </View>
      ) : null}

      {/* Claim Existing Handoff Code Card */}
      <Card style={{ marginTop: 14, marginBottom: 24 }}>
        <Text variant="label" style={{ marginBottom: 4 }}>
          Resume via 6-Character Handoff Code
        </Text>
        <Text variant="caption" muted style={{ marginBottom: 10 }}>
          Have a patient handoff code from front desk or another bay? Enter it to resume their session here.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Input
              label="6-Character Code"
              value={claimCodeInput}
              onChangeText={(v) => setClaimCodeInput(v.toUpperCase())}
              placeholder="e.g. K9M4X2"
              autoCapitalize="characters"
            />
          </View>
          <Button
            label="Claim"
            variant="outline"
            fullWidth={false}
            loading={claimingHandoff}
            onPress={handleClaimHandoffCode}
          />
        </View>
      </Card>

      {/* Sheet to confirm Staff Exit PIN before launching Kiosk Mode */}
      <Sheet
        visible={pinSetupOpen}
        onClose={() => setPinSetupOpen(false)}
        title="Launch Shared Care Station Kiosk"
        scroll={false}
      >
        <View style={{ gap: 12, paddingBottom: 8 }}>
          <Text variant="body" muted>
            {facilityHasPin
              ? 'Choose a Staff Exit PIN for this session, or leave it blank to use your facility\'s saved Station PIN. Staff navigation will be hidden and consecutive walk-in patients can check in, complete Hx intake, and consult with a doctor on this terminal.'
              : 'Choose a 4-digit Staff Exit PIN. Staff navigation will be hidden and consecutive walk-in patients can check in, complete Hx intake, and consult with a doctor on this terminal.'}
          </Text>
          <Input
            label="4-Digit Staff Exit PIN"
            value={pinEntry}
            onChangeText={setPinEntry}
            placeholder={facilityHasPin ? 'Blank = facility Station PIN' : 'Choose a PIN'}
            keyboardType="number-pad"
            maxLength={8}
          />
          <Button
            label="Lock & Launch Kiosk Mode"
            size="lg"
            onPress={confirmLaunchKiosk}
          />
          <Button
            label="Cancel"
            variant="ghost"
            onPress={() => setPinSetupOpen(false)}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
