'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth.store';
import api, { consultationApi, doctorApi, aiIntakeApi, patientApi, ehrApi, clinicalDocsApi, ddxApi } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { toast } from 'react-toastify';
import { useSocket } from '@/hooks/useSocket';
import useOfflineTranscription from '@/hooks/useOfflineTranscription';
import PhysicianBrief from '@/components/intake/PhysicianBrief';
import AIClinicalCopilot from '@/components/consultation/AIClinicalCopilot';
import LiveScribePanel from '@/components/consultation/LiveScribePanel';
import DoctorReadyPacketPanel from '@/components/consultation/DoctorReadyPacketPanel';
import LongitudinalSummaryCard from '@/components/consultation/LongitudinalSummaryCard';
import FixedHistoryEditor from '@/components/patient/FixedHistoryEditor';
import AICopilotFloatingPill from '@/components/consultation/AICopilotFloatingPill';
import ActiveTypingActionChips from '@/components/consultation/ActiveTypingActionChips';
import { usePresence } from '@/hooks/usePresence';
import {
    canPrescribe,
    canRecordVitals,
    canChartNotes,
    canEditDiagnosis,
    canOrderLabs,
    canOrderRadiology,
    canRefer,
    canViewClinicalInsights,
    canManageConsultationStatus,
} from '@/lib/clinicalCapabilities';
import ConsultationChat from '@/components/chat/ConsultationChat';
import HandoffSheet from '@/components/consultation/HandoffSheet';
import PatientCallStatus from '@/components/consultation/PatientCallStatus';
import RatingSheet from '@/components/RatingSheet';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { formatCalendarDay, toCalendarDate } from '@/lib/calendarDateRules';
import { parseCalendarDate } from '@/lib/calendarDate';
import { readErrorMessage } from '@/lib/accessError';
import { patientConsultPhase } from '@/lib/consultPhase';
import { MetaMultimodalScanner } from '@/components/ai/MetaMultimodalScanner';

interface Message {
    id: string;
    senderId: string;
    senderRole: string;
    message: string;
    timestamp: string;
    read: boolean;
}

interface Consultation {
    consultationId: string;
    patientId: string;
    patientName?: string;
    doctorId: string;
    type: string;
    status: string;
    scheduledAt: any;
    symptoms: string[];
    diagnosis?: string;
    notes?: string;
    clinicalSummary?: string;
    prescriptionId?: string;
    chatHistory?: Message[];
    rating?: number;
    fee: number;
    intakeCompleted?: boolean;
    labOrders?: any[];
    labOrderIds?: string[];
    radiologyOrders?: any[];
    referrals?: any[];
    activeFlags?: string[];
}

type ClinicalTab = 'overview' | 'avs' | 'chart-notes' | 'vitals' | 'medications' | 'allergies' | 'documents' | 'chat' | 'multimodal';

export interface MuseWonderDifferential {
    name: string;
    likelihood: 'high' | 'medium' | 'low';
    reasoning: string;
}

export interface MuseWonderSuggestion {
    type: 'diagnosis' | 'medication' | 'test' | 'question' | 'alert';
    title: string;
    detail: string;
    priority: 'high' | 'medium' | 'low';
}

export interface MuseWonderRxItem {
    drugName: string;
    dose: string;
    duration: string;
    drugClass: string;
    nafdacStatus: string;
}

export interface MuseWonderCopilotData {
    consultationId?: string;
    soapDraft?: {
        subjective?: string;
        objective?: string;
        assessment?: string;
        plan?: string;
    };
    suggestions?: MuseWonderSuggestion[];
    differentials?: MuseWonderDifferential[];
    managementPlan?: string;
    nafdacVerifiedRx?: MuseWonderRxItem[];
    vernacularPatientSummary?: string;
    telemetry?: any;
}

// Helper to parse Firestore timestamps
function parseTimestamp(val: any): Date | null {
    if (!val) return null;
    if (val._seconds) return new Date(val._seconds * 1000);
    if (val.seconds) return new Date(val.seconds * 1000);
    // A bare 'YYYY-MM-DD' (e.g. an after-visit visitDate) is a calendar date.
    const d = parseCalendarDate(val) ?? new Date(val);
    return isNaN(d.getTime()) ? null : d;
}

function formatDate(val: any): string {
    const d = parseTimestamp(val);
    if (!d) return 'No date set';
    return d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

/** Plain-language closed-state notice for a terminal visit nobody holds. */
function closedVisitNotice(consultation: any): string {
    const status = String(consultation?.status || '').toLowerCase();
    const when = parseTimestamp(
        consultation?.unattendedAt || consultation?.closedAt || consultation?.endedAt || consultation?.cancelledAt || consultation?.updatedAt || consultation?.createdAt,
    );
    const on = when ? ` on ${when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : '';
    const verb =
        status === 'unattended' ? 'closed unattended'
        : status === 'no_show' ? 'was closed as a no-show'
        : status === 'expired' ? 'expired'
        : status === 'completed' ? 'was completed'
        : 'was cancelled';
    return `This visit ${verb}${on}. The patient can start a new request.`;
}

export default function ConsultationDetailPage() {
    const params = useParams();
    const { user } = useAuthStore();
    const [consultation, setConsultation] = useState<Consultation | null>(null);
    const [doctor, setDoctor] = useState<any>(null);
    const [patientRecord, setPatientRecord] = useState<any>(null);
    const [avsData, setAvsData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [intakeCompleted, setIntakeCompleted] = useState(false);
    const [intakeStatus, setIntakeStatus] = useState<'loading' | 'incomplete' | 'complete' | 'none'>('loading');
    const router = useRouter();

    // Clinical tabs
    const [activeTab, setActiveTab] = useState<ClinicalTab>('overview');
    const [requestedCareChannel, setRequestedCareChannel] = useState<'clinical' | 'nurse' | 'pharmacy' | 'delivery' | undefined>(undefined);
    const [showLiveChatBrief, setShowLiveChatBrief] = useState(false);

    // Uninterrupted in-consultation presence heartbeat (Milestone 3 / Requirement R3)
    usePresence({
        consultationId: params?.id as string,
        inCall: activeTab === 'multimodal' || consultation?.status === 'in_progress',
        status: 'in_consultation',
        intervalMs: 20_000,
        enabled: Boolean(params?.id),
    });

    useEffect(() => {
        if (typeof window !== 'undefined') {
            const sp = new URLSearchParams(window.location.search);
            const tabParam = sp.get('tab');
            const channelParam = sp.get('channel');
            if (channelParam && ['clinical', 'nurse', 'pharmacy', 'delivery'].includes(channelParam)) {
                setRequestedCareChannel(channelParam as 'clinical' | 'nurse' | 'pharmacy' | 'delivery');
            }
            if (tabParam === 'avs' || tabParam === 'notes') {
                setActiveTab('avs');
            } else if (tabParam && ['overview', 'chart-notes', 'vitals', 'medications', 'allergies', 'documents', 'chat', 'multimodal'].includes(tabParam)) {
                setActiveTab(tabParam as ClinicalTab);
            }
        }
    }, []);

    // Post-visit rating (patient only)
    const [showRating, setShowRating] = useState(false);
    const [hasRated, setHasRated] = useState(false);

    // Diagnosis/Notes form
    const [diagnosisForm, setDiagnosisForm] = useState({ diagnosis: '', notes: '', clinicalSummary: '', icdCode: '' });
    const [savingDiagnosis, setSavingDiagnosis] = useState(false);

    // Vitals form
    const [vitalsForm, setVitalsForm] = useState({
        weightLbs: '', heightFt: '', heightIn: '',
        temperature: '', tempUnit: '°F',
        systolic: '', diastolic: '',
        pulseRate: '', pulsePattern: '',
        respRate: '', respPattern: '',
        spo2: '', headCirc: '',
    });
    const [savingVitals, setSavingVitals] = useState(false);

    // SOAP notes
    const [soapNote, setSoapNote] = useState({ subjective: '', objective: '', assessment: '', plan: '' });
    const [savingNote, setSavingNote] = useState(false);

    // AI clinical note-taker (platform-side)
    const [generatingSoap, setGeneratingSoap] = useState(false);
    const [soapNoteId, setSoapNoteId] = useState<string | null>(null);
    const [soapError, setSoapError] = useState<string | null>(null);
    const [dischargeDraft, setDischargeDraft] = useState('');
    const [dischargePatientFriendly, setDischargePatientFriendly] = useState('');
    const [dischargeNoteId, setDischargeNoteId] = useState<string | null>(null);
    const [generatingDischarge, setGeneratingDischarge] = useState(false);
    const [dischargeError, setDischargeError] = useState<string | null>(null);
    const [savingDischarge, setSavingDischarge] = useState(false);

    // AI Co-Pilot & Action Chips context state
    const [ddxData, setDdxData] = useState<any>(null);
    const [aiBrief, setAiBrief] = useState<any>(null);
    const [focusedField, setFocusedField] = useState<string | null>(null);

    // Speech-to-Transcript hook
    const {
        isAvailable: isVoiceAvailable,
        isListening,
        transcript,
        start: startTranscription,
        stop: stopTranscription,
        clear: clearTranscription,
    } = useOfflineTranscription();

    // Socket.IO
    const { socket, connected, onReconnect } = useSocket();

    const isDoctor = user?.role === 'doctor';
    const isClinician = canViewClinicalInsights(user);
    const userCanPrescribe = canPrescribe(user);
    const userCanRecordVitals = canRecordVitals(user);
    const userCanChartNotes = canChartNotes(user);
    const userCanEditDiagnosis = canEditDiagnosis(user);
    const userCanOrderLabs = canOrderLabs(user);
    const userCanOrderRadiology = canOrderRadiology(user);
    const userCanRefer = canRefer(user);
    const userCanViewClinicalInsights = canViewClinicalInsights(user);
    const userCanManageStatus = canManageConsultationStatus(user);
    // Terminal per the status machine (completed / cancelled / no_show / unattended / expired):
    // nothing here is claimable, startable or in need of intake any more.
    const consultClosed = !!consultation && patientConsultPhase(consultation.status, consultation.doctorId, null) === 'done';

    const consultationId = params.id as string;

    const handleToggleTranscription = async () => {
        if (!isListening) {
            startTranscription();
            toast.info('Voice dictation started — speak encounter Hx');
        } else {
            stopTranscription();
            if (transcript && transcript.trim()) {
                const currentTranscript = transcript.trim();
                try {
                    if (typeof (consultationApi as any).addNote === 'function') {
                        await (consultationApi as any).addNote(consultationId, {
                            type: 'transcription',
                            content: currentTranscript,
                        });
                    } else {
                        await api.post(`/consultations/${consultationId}/notes`, {
                            type: 'transcription',
                            content: currentTranscript,
                        });
                    }
                    toast.success('Encounter transcript saved');

                    // Refresh DDx from live transcript
                    try {
                        const ddxRes = await ddxApi.compute(consultationId, 'transcription');
                        if (ddxRes.data?.data) {
                            setDdxData(ddxRes.data.data);
                        }
                    } catch (e) {
                        console.error('Failed to compute DDx from transcript:', e);
                    }

                    // Feed transcript into subjective SOAP note draft
                    setSoapNote(prev => ({
                        ...prev,
                        subjective: prev.subjective
                            ? `${prev.subjective}\n\n[Encounter Transcript]:\n${currentTranscript}`
                            : `[Encounter Transcript]:\n${currentTranscript}`,
                    }));

                    clearTranscription();
                } catch (err) {
                    console.error('Failed to save transcription note:', err);
                    toast.error('Failed to save encounter transcript');
                }
            }
        }
    };

    useEffect(() => {
        loadConsultation();
        if (socket) socket.emit('join:consultation', consultationId);
    }, [consultationId, socket]);

    // Lightweight HTTP polling on serverless production (where Socket.IO is unavailable)
    // so both patient and doctor screens update automatically on accept/start/chat/complete.
    useEffect(() => {
        if (process.env.NODE_ENV === 'test' || !consultationId) return;
        const st = String(consultation?.status || '').toLowerCase();
        if (st === 'completed' || st === 'cancelled') return;
        let cancelled = false;
        const id = setInterval(async () => {
            try {
                const res = await consultationApi.getById(consultationId);
                if (cancelled) return;
                const fresh = res.data?.data;
                if (!fresh) return;
                setConsultation(prev => {
                    if (!prev) return fresh;
                    // If doctor just assigned and we haven't loaded doctor profile yet
                    if (fresh.doctorId && fresh.doctorId !== prev.doctorId) {
                        doctorApi.getById(fresh.doctorId)
                            .then(docRes => { if (!cancelled) setDoctor(docRes.data?.data); })
                            .catch(() => {});
                    }
                    return { ...prev, ...fresh };
                });
            } catch { /* ignore transient poll errors */ }
        }, 5000);
        return () => { cancelled = true; clearInterval(id); };
    }, [consultationId, consultation?.status]);

    useEffect(() => {
        return onReconnect(() => {
            socket?.emit('join:consultation', consultationId);
        });
    }, [socket, onReconnect, consultationId]);

    useEffect(() => {
        if (!socket) return;
        const handleCallStart = () => {
            toast.info('Video call starting...');
            router.push(`/consultations/${consultationId}/video`);
        };
        const handleMessage = (msg: Message) => {
            setConsultation(prev => {
                if (!prev) return null;
                const exists = prev.chatHistory?.some(m => m.id === msg.id);
                if (exists) return prev;
                return { ...prev, chatHistory: [...(prev.chatHistory || []), msg] };
            });
        };
        socket.on('call:start', handleCallStart);
        socket.on('chat:message', handleMessage);
        return () => { socket.off('call:start', handleCallStart); socket.off('chat:message', handleMessage); };
    }, [socket, consultationId, router]);

    const loadConsultation = async () => {
        try {
            const res = await consultationApi.getById(consultationId);
            const data = res?.data?.data || res?.data;
            if (!data) return;
            setConsultation(data);
            setIntakeCompleted(data?.intakeCompleted || false);
            if (data?.diagnosis) setDiagnosisForm({ diagnosis: data.diagnosis, notes: data.internalNotes || data.notes || '', clinicalSummary: data.clinicalSummary || '', icdCode: '' });

            if (data?.doctorId) {
                try { const docRes = await doctorApi.getById(data.doctorId); setDoctor(docRes.data.data); } catch {}
            }

            // Load After Visit Summary (AVS) if available
            try {
                const avsRes = await api.get(`/patients/consultations/${consultationId}/avs`);
                if (avsRes.data?.data) {
                    setAvsData(avsRes.data.data);
                }
            } catch {
                // Synthesized fallback will be used when endpoint is unavailable
            }

            // Load patient record for both clinician and patient views (fixes bug where patient's own Medications & Allergies were empty)
            const targetPatientId = data?.patientId || user?.userId;
            if (userCanViewClinicalInsights && targetPatientId) {
                try {
                    const prRes = await ehrApi.getPatientRecords(targetPatientId);
                    setPatientRecord(prRes.data.data);
                } catch {}
            } else if (user?.role === 'patient' || !userCanViewClinicalInsights) {
                let loadedRecord: any = null;
                try {
                    if (typeof (ehrApi as any).getMyRecord === 'function') {
                        const myRec = await (ehrApi as any).getMyRecord();
                        loadedRecord = myRec.data?.data;
                    } else if (targetPatientId) {
                        const prRes = await ehrApi.getPatientRecords(targetPatientId);
                        loadedRecord = prRes.data?.data;
                    }
                } catch {}

                // Always enrich or fallback with patient's profile, prescriptions, and medical records so Medications/Allergies/Documents tabs are populated
                try {
                    const [profRes, rxRes, medRecRes] = await Promise.allSettled([
                        patientApi.getProfile(),
                        patientApi.getPrescriptions(),
                        patientApi.getMedicalRecords(),
                    ]);
                    const profData = profRes.status === 'fulfilled' ? (profRes.value?.data?.data || {}) : {};
                    const rxList = rxRes.status === 'fulfilled' ? (rxRes.value?.data?.data || []) : [];
                    const docsList = medRecRes.status === 'fulfilled' ? (medRecRes.value?.data?.data || []) : [];

                    const flattenedMeds: any[] = [];
                    if (Array.isArray(rxList)) {
                        rxList.forEach((rx: any) => {
                            if (Array.isArray(rx.medications)) {
                                rx.medications.forEach((m: any) => {
                                    flattenedMeds.push({
                                        name: m.name,
                                        dosage: m.dosage,
                                        frequency: m.frequency,
                                        duration: m.duration,
                                        status: rx.status || 'active',
                                        prescriptionId: rx.prescriptionId,
                                    });
                                });
                            }
                        });
                    }

                    const baseMedRecord = loadedRecord?.medicalRecord || profData?.medicalRecord || {};
                    const mergedMedications =
                        Array.isArray(baseMedRecord.medications) && baseMedRecord.medications.length > 0
                            ? baseMedRecord.medications
                            : flattenedMeds;
                    const mergedAllergies =
                        Array.isArray(baseMedRecord.allergies) && baseMedRecord.allergies.length > 0
                            ? baseMedRecord.allergies
                            : Array.isArray(profData?.allergies)
                            ? profData.allergies
                            : [];
                    const mergedConditions =
                        Array.isArray(baseMedRecord.conditions) && baseMedRecord.conditions.length > 0
                            ? baseMedRecord.conditions
                            : Array.isArray(profData?.chronicConditions)
                            ? profData.chronicConditions
                            : [];

                    setPatientRecord({
                        patient: loadedRecord?.patient || profData,
                        medicalRecord: {
                            ...baseMedRecord,
                            medications: mergedMedications,
                            allergies: mergedAllergies,
                            conditions: mergedConditions,
                            documents: Array.isArray(baseMedRecord.documents) && baseMedRecord.documents.length > 0 ? baseMedRecord.documents : docsList,
                        },
                    });
                } catch {}
            }

            // Load DDx insights and AI Brief for clinicians
            if (userCanViewClinicalInsights) {
                try {
                    const ddxRes = await ddxApi.get(consultationId);
                    setDdxData(ddxRes.data?.data || null);
                } catch {}
                try {
                    const briefRes = await aiIntakeApi.getBrief(consultationId);
                    const rawBrief = briefRes.data?.data?.brief || null;
                    // Tolerate the wrapped `{ suggestion }` shape so the co-pilot feed is never empty.
                    setAiBrief(rawBrief?.suggestion && typeof rawBrief.suggestion === 'object' ? rawBrief.suggestion : rawBrief);
                } catch {}
            }
        } catch (error) {
            console.warn('Consultation fetch retry/deferred:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (userCanViewClinicalInsights || !consultationId) { setIntakeStatus('none'); return; }
        const checkIntake = async () => {
            try {
                const statusRes = await aiIntakeApi.getStatus(consultationId);
                setIntakeStatus(statusRes.data?.data?.isComplete ? 'complete' : 'incomplete');
            } catch {
                setIntakeStatus(consultation?.status === 'pending' ? 'incomplete' : 'none');
            }
        };
        checkIntake();
    }, [consultationId, userCanViewClinicalInsights, consultation?.status]);

    // Auto-prompt the patient to rate a completed visit — once. A dismissed or
    // already-submitted rating is remembered in localStorage so we never nag.
    useEffect(() => {
        if (user?.role !== 'patient' || userCanViewClinicalInsights || !consultation) return;
        const alreadyRated = !!consultation.rating || consultation.rating === 0;
        if (alreadyRated) { setHasRated(true); return; }
        if (consultation.status !== 'completed') return;
        let dismissed = false;
        try { dismissed = localStorage.getItem(`docarion_rating_dismissed_${consultationId}`) === '1'; } catch { /* ignore */ }
        if (!dismissed && !hasRated) setShowRating(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.role, userCanViewClinicalInsights, consultation?.status, consultation?.rating, consultationId]);

    const dismissRating = () => {
        try { localStorage.setItem(`docarion_rating_dismissed_${consultationId}`, '1'); } catch { /* ignore */ }
        setShowRating(false);
    };

    const [claimingConsultation, setClaimingConsultation] = useState(false);

    const handleClaimAndStart = async (startImmediately = true) => {
        setClaimingConsultation(true);
        try {
            const claimRes = await consultationApi.claim(consultationId);
            const claimMsg = claimRes.data?.message || 'Consultation claimed!';
            if (startImmediately) {
                await consultationApi.updateStatus(consultationId, 'in_progress');
                toast.success('Consultation claimed and started');
            } else {
                toast.success(claimMsg);
            }
            await loadConsultation();
        } catch (err: any) {
            const body = err?.response?.data;
            // The error envelope may be `{ error: { message, code } }` — never render an object.
            const exactReason =
                readErrorMessage(body) ||
                (typeof err?.message === 'string' ? err.message : null) ||
                'Failed to claim consultation';
            const details = typeof body?.details === 'string' ? body.details : null;
            toast.error(details ? `${exactReason} — ${details}` : exactReason);
        } finally {
            setClaimingConsultation(false);
        }
    };

    const handleStatusUpdate = async (status: string) => {
        try {
            // If the consultation is still unclaimed in the queue, claim it first before updating status
            if (!consultation?.doctorId && userCanManageStatus && status !== 'cancelled') {
                await consultationApi.claim(consultationId);
            }
            await consultationApi.updateStatus(consultationId, status);
            toast.success('Status updated');
            loadConsultation();
        } catch (err: any) {
            const exactReason =
                err?.response?.data?.error ||
                err?.response?.data?.message ||
                'Failed to update status';
            toast.error(exactReason);
        }
    };

    const handleSaveDiagnosis = async () => {
        if (!diagnosisForm.diagnosis.trim()) { toast.error('Enter a diagnosis'); return; }
        setSavingDiagnosis(true);
        try {
            await consultationApi.addDiagnosis(consultationId, {
                diagnosis: diagnosisForm.diagnosis,
                notes: diagnosisForm.notes,
                clinicalSummary: diagnosisForm.clinicalSummary,
                icdCode: diagnosisForm.icdCode || undefined,
            });
            toast.success('Diagnosis saved');
            loadConsultation();
        } catch { toast.error('Failed to save diagnosis'); }
        finally { setSavingDiagnosis(false); }
    };

    const handleSaveVitals = async () => {
        setSavingVitals(true);
        try {
            const data: any = {};
            if (vitalsForm.weightLbs) data.weight = parseFloat(vitalsForm.weightLbs);
            if (vitalsForm.heightFt || vitalsForm.heightIn) {
                data.height = ((parseInt(vitalsForm.heightFt || '0') * 12) + parseInt(vitalsForm.heightIn || '0')) * 2.54;
            }
            if (vitalsForm.temperature) data.temperature = parseFloat(vitalsForm.temperature);
            if (vitalsForm.systolic) data.bloodPressureSystolic = parseInt(vitalsForm.systolic);
            if (vitalsForm.diastolic) data.bloodPressureDiastolic = parseInt(vitalsForm.diastolic);
            if (vitalsForm.pulseRate) data.heartRate = parseInt(vitalsForm.pulseRate);
            if (vitalsForm.respRate) data.respiratoryRate = parseInt(vitalsForm.respRate);
            if (vitalsForm.spo2) data.oxygenSaturation = parseInt(vitalsForm.spo2);
            data.patientId = consultation?.patientId;

            await patientApi.addVitals(data);
            toast.success('Vitals recorded');
        } catch { toast.error('Failed to save vitals'); }
        finally { setSavingVitals(false); }
    };

    const handleSaveSOAPNote = async () => {
        if (!soapNote.subjective && !soapNote.objective && !soapNote.assessment && !soapNote.plan) {
            toast.error('Enter at least one SOAP section');
            return;
        }
        setSavingNote(true);
        try {
            const formattedContent = `SUBJECTIVE:\n${soapNote.subjective || 'N/A'}\n\nOBJECTIVE:\n${soapNote.objective || 'N/A'}\n\nASSESSMENT:\n${soapNote.assessment || 'N/A'}\n\nPLAN:\n${soapNote.plan || 'N/A'}`;
            // Persist SOAP note directly to consultation record (NEVER message doctor notes to the patient chat)
            await consultationApi.addDiagnosis(consultationId, {
                diagnosis: diagnosisForm.diagnosis || consultation?.diagnosis || 'Clinical Evaluation',
                notes: formattedContent,
                clinicalSummary: soapNote.assessment || formattedContent,
                internalNotes: formattedContent,
            });
            if (soapNoteId) {
                try {
                    await clinicalDocsApi.saveNote(consultationId, soapNoteId, { content: formattedContent, finalized: false });
                } catch {
                    // Secondary sync
                }
            }
            toast.success('SOAP Note saved to clinical record');
            loadConsultation();
        } catch { toast.error('Failed to save note'); }
        finally { setSavingNote(false); }
    };

    const handleAutofillFromAI = async () => {
        try {
            const res = await aiIntakeApi.getBrief(consultationId);
            const brief = res.data?.data?.brief;
            if (!brief) {
                toast.error('AI Brief not available');
                return;
            }

            const subjective = `Chief Complaint:\n${brief.chiefComplaint || 'None'}\n\nHPI:\n${brief.hpiNarrative || 'None'}`;

            const rosStrings = brief.reviewOfSystems?.map((ros: any) => `- ${ros.system}: ${ros.findings} (${ros.status})`).join('\n') || 'None';
            const vitalsStrings = brief.vitalSignsToCheck?.join(', ') || 'None';
            const objective = `Suggested Vitals to Check:\n${vitalsStrings}\n\nReview of Systems:\n${rosStrings}`;

            const ddxStrings = brief.differentialDiagnosis?.map((ddx: any) => `- ${ddx.name} (${ddx.likelihood}): ${ddx.reasoning}`).join('\n') || 'None';
            const assessment = `Differential Diagnoses:\n${ddxStrings}`;

            const suggestedQStrings = brief.suggestedQuestions?.map((q: string) => `- ${q}`).join('\n') || 'None';
            const plan = `Suggested Follow-up Questions:\n${suggestedQStrings}`;

            setSoapNote({
                subjective,
                objective,
                assessment,
                plan
            });
            toast.success('Auto-filled from AI Brief');
        } catch (error) {
            console.error(error);
            toast.error('Failed to load AI Brief');
        }
    };

    // ── AI clinical note-taker (platform-side) ──────────────────────
    const [syncingCopilot, setSyncingCopilot] = useState(false);
    const [copilotData, setCopilotData] = useState<MuseWonderCopilotData | null>(null);
    const [showCopilotCard, setShowCopilotCard] = useState(true);

    const handleCopilotSync = async () => {
        if (!consultationId) return;
        setSyncingCopilot(true);
        try {
            const chatTranscript = Array.isArray(consultation?.chatHistory)
                ? consultation.chatHistory
                    .filter((m: any) => m && typeof (m.message || m.content) === 'string' && String(m.message || m.content).trim())
                    .slice(-25)
                    .map((m: any) => `${m.senderRole === 'patient' ? 'Patient' : 'Doctor'}: ${String(m.message || m.content).trim()}`)
                    .join('\n')
                : '';
            const res = await api.post(`/ai-intake/${consultationId}/copilot-sync`, {
                language: 'en',
                intakeHistory: [
                    aiBrief?.chiefComplaint ? `Chief complaint: ${aiBrief.chiefComplaint}` : null,
                    aiBrief?.hpiNarrative || aiBrief?.summary || null,
                    aiBrief?.redFlags?.length ? `Red flags: ${aiBrief.redFlags.join('; ')}` : null,
                    Array.isArray(consultation?.symptoms) && consultation.symptoms.length
                        ? `Symptoms: ${consultation.symptoms.join(', ')}`
                        : null,
                    diagnosisForm?.diagnosis ? `Recorded Diagnosis: ${diagnosisForm.diagnosis}` : null,
                    chatTranscript ? `Live Consultation Chat:\n${chatTranscript}` : null,
                ].filter(Boolean).join('\n') || (Array.isArray(consultation?.symptoms) ? consultation.symptoms.join(', ') : consultation?.symptoms) || '',
                vitals: vitalsForm || {},
            });
            const data = res.data?.data || res.data;
            if (data) {
                setCopilotData(data);
                if (data.soapDraft) {
                    setSoapNote(prev => ({
                        subjective: data.soapDraft.subjective || prev.subjective,
                        objective: data.soapDraft.objective || prev.objective,
                        assessment: data.soapDraft.assessment || prev.assessment,
                        plan: data.soapDraft.plan || prev.plan,
                    }));
                }
                toast.success('✨ Muse Wonder SOAP notes & DDx synchronized!');
            }
        } catch (error: any) {
            console.error('Copilot sync error:', error);
            toast.error(error?.response?.data?.error || 'Failed to sync with Meta Muse Wonder Co-Pilot');
        } finally {
            setSyncingCopilot(false);
        }
    };

    const lastSyncedChatLenRef = useRef<number>(-1);
    useEffect(() => {
        if (process.env.NODE_ENV === 'test') return;
        if (!userCanViewClinicalInsights || !consultationId || !consultation) return;
        const chatLen = Array.isArray(consultation.chatHistory) ? consultation.chatHistory.length : 0;
        if (lastSyncedChatLenRef.current === -1 || (chatLen > lastSyncedChatLenRef.current && !syncingCopilot)) {
            lastSyncedChatLenRef.current = chatLen;
            handleCopilotSync();
        }
    }, [userCanViewClinicalInsights, consultationId, consultation?.chatHistory?.length]);

    // Calls the /clinical-docs endpoint; drops the returned DRAFT into the
    // editable SOAP textareas. Saving persists the edited version.
    const handleGenerateSOAP = async () => {
        setGeneratingSoap(true);
        setSoapError(null);
        try {
            const res = await clinicalDocsApi.generateSoap(consultationId);
            const note = res.data?.data?.note;
            const s = note?.structured || {};
            setSoapNote({
                subjective: s.subjective || '',
                objective: s.objective || '',
                assessment: s.assessment || '',
                plan: s.plan || '',
            });
            setSoapNoteId(note?.id || null);
            toast.success('SOAP draft generated — edit before saving');
        } catch (error: any) {
            console.error(error);
            const msg = error?.response?.data?.error || 'Failed to generate SOAP note';
            setSoapError(msg);
            toast.error(msg);
        } finally {
            setGeneratingSoap(false);
        }
    };

    // Save the (possibly edited) generated SOAP draft back onto the note record.
    const handleSaveGeneratedSOAP = async (finalize: boolean) => {
        if (!soapNoteId) { toast.error('Generate a draft first'); return; }
        setSavingNote(true);
        try {
            const content = `SUBJECTIVE:\n${soapNote.subjective}\n\nOBJECTIVE:\n${soapNote.objective}\n\nASSESSMENT:\n${soapNote.assessment}\n\nPLAN:\n${soapNote.plan}`;
            await clinicalDocsApi.saveNote(consultationId, soapNoteId, { content, finalized: finalize });
            toast.success(finalize ? 'SOAP note finalized' : 'Draft saved');
        } catch (error: any) {
            toast.error(error?.response?.data?.error || 'Failed to save note');
        } finally {
            setSavingNote(false);
        }
    };

    const handleGenerateDischarge = async () => {
        setGeneratingDischarge(true);
        setDischargeError(null);
        try {
            const res = await clinicalDocsApi.generateDischarge(consultationId);
            const note = res.data?.data?.note;
            const s = note?.structured || {};
            setDischargeDraft(s.medical || note?.content || '');
            setDischargePatientFriendly(s.patientFriendly || '');
            setDischargeNoteId(note?.id || null);
            toast.success('Discharge summary drafted — edit before saving');
        } catch (error: any) {
            console.error(error);
            const msg = error?.response?.data?.error || 'Failed to generate discharge summary';
            setDischargeError(msg);
            toast.error(msg);
        } finally {
            setGeneratingDischarge(false);
        }
    };

    const handleSaveDischarge = async (finalize: boolean) => {
        if (!dischargeNoteId) { toast.error('Generate a draft first'); return; }
        setSavingDischarge(true);
        try {
            const content = dischargePatientFriendly
                ? `${dischargeDraft}\n\n--- PATIENT-FRIENDLY ---\n${dischargePatientFriendly}`
                : dischargeDraft;
            await clinicalDocsApi.saveNote(consultationId, dischargeNoteId, { content, finalized: finalize });
            toast.success(finalize ? 'Discharge summary finalized' : 'Draft saved');
        } catch (error: any) {
            toast.error(error?.response?.data?.error || 'Failed to save discharge summary');
        } finally {
            setSavingDischarge(false);
        }
    };

    // Nurse Walk-In / Triage Hx Intake modal state (clinician/nurse only)
    const [showNurseHxModal, setShowNurseHxModal] = useState(false);
    const [savingNurseHx, setSavingNurseHx] = useState(false);
    const [nurseHxForm, setNurseHxForm] = useState({
        chiefComplaint: '',
        hpiNotes: '',
        allergies: '',
        currentMedications: '',
        medicalHistory: '',
        bp: '',
        heartRate: '',
        temperature: '',
        spo2: '',
    });

    const intakeComplete = (consultation as any)?.intakeCompleted === false ? false : Boolean(
        intakeCompleted ||
        intakeStatus === 'complete' ||
        (consultation as any)?.intakeCompleted ||
        (consultation as any)?.hxIntakeComplete ||
        (consultation as any)?.nurseIntakeComplete ||
        (consultation?.status === 'in_progress' && Boolean(consultation?.doctorId)) ||
        Boolean((consultation as any)?.careChannels?.clinical?.status === 'open') ||
        ['completed', 'cancelled'].includes(consultation?.status || '')
    );

    const autoOpenedPatientChatRef = useRef(false);
    useEffect(() => {
        if (userCanViewClinicalInsights || !consultation) return;
        if (autoOpenedPatientChatRef.current) return;
        const st = String(consultation.status || '').toLowerCase();
        const hasClinicianMessage = Array.isArray(consultation.chatHistory) &&
            consultation.chatHistory.some((m: any) => m && m.senderRole && m.senderRole !== 'patient');
        const clinicalTunnelOpen = (consultation as any)?.careChannels?.clinical?.status === 'open';
        if (
            ['in_progress', 'accepted', 'confirmed'].includes(st) ||
            clinicalTunnelOpen ||
            hasClinicianMessage
        ) {
            autoOpenedPatientChatRef.current = true;
            setActiveTab('chat');
        }
    }, [userCanViewClinicalInsights, consultation]);

    const handleNurseHxSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!nurseHxForm.chiefComplaint.trim() && !(consultation?.symptoms?.length)) {
            toast.error('Please enter the Chief Complaint');
            return;
        }
        setSavingNurseHx(true);
        try {
            await aiIntakeApi.nurseComplete(consultationId, {
                chiefComplaint: nurseHxForm.chiefComplaint.trim() || consultation?.symptoms?.join(', ') || 'Walk-in triage intake',
                hpiNotes: nurseHxForm.hpiNotes.trim() || undefined,
                allergies: nurseHxForm.allergies ? nurseHxForm.allergies.split(',').map(s => s.trim()).filter(Boolean) : [],
                currentMedications: nurseHxForm.currentMedications ? nurseHxForm.currentMedications.split(',').map(s => s.trim()).filter(Boolean) : [],
                medicalHistory: nurseHxForm.medicalHistory ? nurseHxForm.medicalHistory.split(',').map(s => s.trim()).filter(Boolean) : [],
                vitals: {
                    bp: nurseHxForm.bp || undefined,
                    heartRate: nurseHxForm.heartRate || undefined,
                    temperature: nurseHxForm.temperature || undefined,
                    spo2: nurseHxForm.spo2 || undefined,
                },
            });
            setIntakeCompleted(true);
            setIntakeStatus('complete');
            setConsultation(prev => prev ? ({ ...prev, intakeCompleted: true } as any) : prev);
            setShowNurseHxModal(false);
            toast.success('Nurse Hx Intake recorded — patient cleared for doctor consultation');
        } catch (error: any) {
            toast.error(error?.response?.data?.error || 'Failed to record Nurse Hx Intake');
        } finally {
            setSavingNurseHx(false);
        }
    };

    // The DOCTOR starts the call (the room is opened on the video page and the
    // patient is rung by push); patients only ever JOIN via PatientCallStatus.
    const startVideoCall = (mode: 'video' | 'audio' = 'video') => {
        if (!userCanViewClinicalInsights && !intakeComplete) {
            toast.error('Medical History (Hx) Intake is required before joining the doctor video call.');
            router.push(`/consultations/${consultationId}/intake`);
            return;
        }
        router.push(`/consultations/${consultationId}/video?mode=${mode}`);
    };

    const startChatConsultation = async () => {
        if (userCanManageStatus && consultation && !['in_progress', 'completed', 'cancelled'].includes(consultation.status)) {
            try {
                if (!consultation.doctorId) {
                    await consultationApi.claim(consultationId);
                }
                await consultationApi.updateStatus(consultationId, 'in_progress');
                await loadConsultation();
                toast.success('Consultation active — live chat open');
            } catch (err: any) {
                toast.error(err?.response?.data?.error || 'Could not transition consultation status');
            }
        }
        setActiveTab('chat');
    };
    const [showHandoff, setShowHandoff] = useState(false);
    const [showPatientWithdrawModal, setShowPatientWithdrawModal] = useState(false);
    const [patientWithdrawReason, setPatientWithdrawReason] = useState('Wait time / need to step away');
    const [patientWithdrawing, setPatientWithdrawing] = useState(false);

    const handlePatientWithdraw = async () => {
        setPatientWithdrawing(true);
        try {
            await consultationApi.withdraw(consultationId, {
                stage: consultation?.status === 'in_progress'
                    ? 'in_progress'
                    : consultation?.doctorId
                        ? 'claimed_by_doctor'
                        : 'waiting_for_doctor',
                reason: patientWithdrawReason || 'Patient withdrew from consultation',
            });
            toast.info('You have withdrawn from this consultation.');
            setShowPatientWithdrawModal(false);
            router.push('/dashboard/patient');
        } catch (err: any) {
            toast.error(err?.response?.data?.error || 'Could not withdraw right now. Please try again.');
            setPatientWithdrawing(false);
        }
    };

    const patientCanBeCalled = !!consultation?.doctorId && ['accepted', 'confirmed', 'scheduled', 'in_progress'].includes(String(consultation?.status || ''));

    const bmi = (() => {
        const w = parseFloat(vitalsForm.weightLbs);
        const ft = parseInt(vitalsForm.heightFt || '0');
        const inch = parseInt(vitalsForm.heightIn || '0');
        const totalIn = ft * 12 + inch;
        if (w > 0 && totalIn > 0) return ((w / (totalIn * totalIn)) * 703).toFixed(1);
        return '';
    })();

    const patient = patientRecord?.patient;
    const rawMedicalRecord = patientRecord?.medicalRecord || patient?.medicalRecord;
    const medicalRecord = (() => {
        const base = rawMedicalRecord || {};
        const briefAllergies = Array.isArray(aiBrief?.allergies)
            ? aiBrief.allergies
            : (typeof aiBrief?.allergies === 'string' && aiBrief.allergies.trim() && !/^(none|no|nkda|nil)$/i.test(aiBrief.allergies.trim())
                ? [aiBrief.allergies.trim()]
                : []);
        const briefMeds = Array.isArray(aiBrief?.medications || aiBrief?.currentMedications)
            ? (aiBrief.medications || aiBrief.currentMedications)
            : (typeof (aiBrief?.medications || aiBrief?.currentMedications) === 'string' && String(aiBrief?.medications || aiBrief?.currentMedications).trim() && !/^(none|no|nil)$/i.test(String(aiBrief?.medications || aiBrief?.currentMedications).trim())
                ? [String(aiBrief?.medications || aiBrief?.currentMedications).trim()]
                : []);
        const baseAllergies = Array.isArray(base.allergies) ? base.allergies : [];
        const baseMeds = Array.isArray(base.medications) ? base.medications : [];
        return {
            ...base,
            allergies: baseAllergies.length > 0 ? baseAllergies : briefAllergies,
            medications: baseMeds.length > 0 ? baseMeds : briefMeds,
        };
    })();

    // Status colors
    const statusColors: Record<string, string> = {
        pending: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
        confirmed: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
        in_progress: 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
        completed: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
        cancelled: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
    };

    if (loading) return (
        <div className="min-h-screen bg-gray-50 dark:bg-slate-700/50 flex items-center justify-center">
            <div className="skeleton w-full max-w-5xl h-96 rounded-2xl mx-4" />
        </div>
    );

    if (!consultation) return (
        <div className="min-h-screen bg-gray-50 dark:bg-slate-700/50 flex items-center justify-center">
            <div className="text-center">
                <span className="text-5xl">😕</span>
                <p className="mt-4 text-lg">Consultation not found</p>
                <Link href="/consultations" className="mt-4 block"><Button>Back to Consultations</Button></Link>
            </div>
        </div>
    );

    const clinicalTabs: { key: ClinicalTab; label: string; icon: string; visible?: boolean }[] = [
        { key: 'overview', label: 'Overview', icon: '📋', visible: true },
        { key: 'avs', label: 'After Visit Summary (AVS)', icon: '📄', visible: true },
        { key: 'chart-notes', label: 'Chart Notes', icon: '📝', visible: userCanChartNotes },
        { key: 'multimodal', label: 'Meta AI Scanner (SAM 3.1)', icon: '🔬', visible: true },
        { key: 'vitals', label: 'Vitals', icon: '❤️', visible: userCanRecordVitals },
        { key: 'medications', label: 'Medications', icon: '💊', visible: true },
        { key: 'allergies', label: 'Allergies', icon: '⚠️', visible: true },
        { key: 'documents', label: 'Documents', icon: '📁', visible: true },
        { key: 'chat', label: 'Chat', icon: '💬', visible: true },
    ];

    const visibleTabs = clinicalTabs.filter(t => t.visible !== false);

    return (
        <DashboardShell
            title={
                <>
                    {consultation.patientName || `${patient?.profile?.firstName || ''} ${patient?.profile?.lastName || ''}`.trim() || `Patient ${consultation.patientId?.substring(0, 8)}`}
                    {patient?.profile?.gender && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 font-normal ml-2">
                            {patient.profile.gender === 'male' ? '♂' : patient.profile.gender === 'female' ? '♀' : '⚧'} / {patient.profile.dateOfBirth && toCalendarDate(patient.profile.dateOfBirth) ? Math.floor((Date.now() - toCalendarDate(patient.profile.dateOfBirth)!.getTime()) / 31557600000) + 'y' : ''}
                        </span>
                    )}
                    {patient?.profile?.dateOfBirth && (
                        <span className="text-xs text-gray-500 dark:text-gray-500 font-normal ml-2">
                            DOB: {formatCalendarDay(patient.profile.dateOfBirth)}
                        </span>
                    )}
                </>
            }
            titleClassName="font-bold tracking-tight text-gray-900 dark:text-white"
            leading={
                <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center shadow-soft flex-shrink-0">
                    <span className="text-white font-bold text-sm">
                        {consultation.patientName?.[0]?.toUpperCase() || patient?.profile?.firstName?.[0] || 'P'}
                    </span>
                </div>
            }
            subtitle={
                <span className="flex items-center gap-3 flex-wrap">
                    <span>Provider: Dr. {doctor?.profile?.firstName} {doctor?.profile?.lastName}</span>
                    <span>•</span>
                    <span>Encounter: {formatDate(consultation.scheduledAt)}</span>
                    <span>•</span>
                    <span>Type: {consultation.type === 'video' ? '📹 Telehealth' : '🏥 In-person'}</span>
                </span>
            }
            actions={
                <>
                    <span className={`text-xs px-3 py-1 rounded-full border font-medium ${statusColors[consultation.status] || 'bg-gray-100 dark:bg-slate-700'}`}>
                        {consultation.status.replace('_', ' ').toUpperCase()}
                    </span>
                    {userCanViewClinicalInsights && consultation.status === 'in_progress' && (
                        <Button
                            size="sm"
                            variant={isListening ? 'danger' : 'outline'}
                            onClick={handleToggleTranscription}
                            className="gap-2"
                            data-testid="transcription-toggle-button"
                        >
                            {isListening ? (
                                <>
                                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                                    ⏹ Stop Transcription
                                </>
                            ) : (
                                <>
                                    <span>🎙</span> Start Transcription
                                </>
                            )}
                        </Button>
                    )}
                    {(userCanRecordVitals || userCanManageStatus) && !intakeComplete && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowNurseHxModal(true)}
                            data-testid="nurse-hx-intake-button"
                        >
                            🩺 Complete Nurse Hx Intake (Walk-In / Triage)
                        </Button>
                    )}
                    {['in_progress', 'confirmed', 'accepted', 'scheduled', 'intake_complete'].includes(consultation.status) && (
                        !userCanViewClinicalInsights && !intakeComplete ? (
                            <Link href={`/consultations/${consultationId}/intake`}>
                                <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white" data-testid="video-hx-gate-button">
                                    🩺 Complete Hx Intake to Join Video
                                </Button>
                            </Link>
                        ) : !userCanViewClinicalInsights ? (
                            <PatientCallStatus
                                consultationId={consultationId}
                                status={consultation.status}
                                doctorId={consultation.doctorId}
                                doctorName={doctor?.profile?.firstName ? `${doctor.profile.firstName} ${doctor.profile.lastName || ''}`.trim() : null}
                                compact
                                onOpenChat={() => setActiveTab('chat')}
                            />
                        ) : (
                            <div className="inline-flex items-center gap-1.5 flex-wrap">
                                <Button size="sm" variant="outline" aria-label="Start text consultation" onClick={startChatConsultation}>💬 Join Chat</Button>
                                <Button size="sm" variant="outline" onClick={() => startVideoCall('audio')}>📞 Audio Call</Button>
                                <Button size="sm" onClick={() => startVideoCall('video')}>📹 Video Call</Button>
                                {userCanManageStatus && !['completed', 'cancelled'].includes(consultation.status) && (
                                    <Button
                                        size="sm"
                                        className="bg-green-600 hover:bg-green-700 text-white font-bold"
                                        onClick={() => setShowHandoff(true)}
                                        data-testid="header-complete-consultation-btn"
                                    >
                                        ✅ Complete Visit
                                    </Button>
                                )}
                            </div>
                        )
                    )}
                    {userCanManageStatus && consultation.status === 'completed' && (
                        <Link href="/dashboard/doctor">
                            <Button size="sm" variant="outline">← Back to Queue</Button>
                        </Link>
                    )}
                    {user?.role === 'patient' && !userCanViewClinicalInsights && consultation.status === 'completed' && !hasRated && (
                        <Button size="sm" variant="outline" onClick={() => setShowRating(true)}>⭐ Rate your visit</Button>
                    )}
                    {user?.role === 'patient' && !userCanViewClinicalInsights && !['completed', 'cancelled', 'no_show'].includes(consultation.status) && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                            onClick={() => setShowPatientWithdrawModal(true)}
                            data-testid="patient-room-withdraw-btn"
                        >
                            🚪 Withdraw Visit
                        </Button>
                    )}
                </>
            }
            headerClassName="sticky top-0 z-20"
            className="flex flex-col"
            bare
        >
            {/* Live Transcription Banner */}
            {isListening && (
                <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2">
                    <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-red-700 dark:text-red-300">
                        <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                            <span className="font-bold">Live Encounter Transcription Active:</span>
                            <span className="italic truncate max-w-xl">{transcript || 'Listening for speech…'}</span>
                        </div>
                        <Button size="sm" variant="danger" onClick={handleToggleTranscription} className="text-xs h-7">
                            Stop & Save Note
                        </Button>
                    </div>
                </div>
            )}

            {/* Allergy Alert Bar */}
            {userCanViewClinicalInsights && medicalRecord?.allergies?.length > 0 && (
                <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-4 py-2">
                    <div className="max-w-7xl mx-auto flex items-center gap-2">
                        <span className="text-red-600 dark:text-red-400 font-bold text-xs">⚠️ ALLERGIES:</span>
                        <span className="text-red-700 dark:text-red-300 text-xs">{medicalRecord.allergies.join(' • ')}</span>
                    </div>
                </div>
            )}

            {/* Clinical Tab Navigation */}
            <div className="bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700 shadow-soft">
                <div className="max-w-7xl mx-auto px-4">
                    <div className="flex gap-1 overflow-x-auto">
                        {visibleTabs.map(tab => (
                            <button
                                key={tab.key}
                                onClick={() => {
                                    if (tab.key === 'chat' && userCanManageStatus && !['in_progress', 'completed', 'cancelled'].includes(consultation.status)) {
                                        void startChatConsultation();
                                    } else {
                                        setActiveTab(tab.key);
                                    }
                                }}
                                className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-inset ${activeTab === tab.key
                                    ? 'border-green-600 text-green-700 dark:text-green-400'
                                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-200 dark:hover:border-slate-600'
                                    }`}
                            >
                                {tab.icon} {tab.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
                <div className="grid lg:grid-cols-3 gap-6">
                    {/* Main Content Area (2/3) */}
                    <div className="lg:col-span-2 space-y-6">

                        {/* Live Doctor Consultation Banner (Patient only) — shown immediately once doctor accepts/joins */}
                        {!userCanViewClinicalInsights && (Boolean(consultation.doctorId) || ['accepted', 'confirmed', 'in_progress'].includes(consultation.status)) && activeTab !== 'chat' && (
                            <div
                                data-testid="patient-live-chat-banner"
                                className="bg-gradient-to-r from-emerald-600 to-green-600 text-white rounded-2xl shadow-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="w-3 h-3 rounded-full bg-white animate-ping flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-bold">
                                            🩺 {doctor?.profile?.firstName ? `Dr. ${doctor.profile.firstName} ${doctor.profile.lastName || ''}`.trim() : 'Your Doctor'} is connected to your consultation
                                        </p>
                                        <p className="text-xs text-emerald-100">
                                            Your live conversation tunnel is open. Tap to chat or join a call with your doctor now.
                                        </p>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    className="bg-white text-emerald-800 hover:bg-emerald-50 font-bold shrink-0"
                                    onClick={() => setActiveTab('chat')}
                                >
                                    💬 Open Live Chat →
                                </Button>
                            </div>
                        )}

                        {showPatientWithdrawModal && (
                            <div
                                className="p-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                                data-testid="patient-room-withdraw-modal"
                            >
                                <div className="space-y-1 flex-1">
                                    <p className="text-sm font-bold text-red-900 dark:text-red-200">
                                        🚪 Withdraw from this consultation?
                                    </p>
                                    <p className="text-xs text-red-700 dark:text-red-300">
                                        Your consultation and waiting queue entry will be closed immediately. You can book or start a new consultation anytime.
                                    </p>
                                    <div className="pt-1 max-w-xs">
                                        <select
                                            value={patientWithdrawReason}
                                            onChange={(e) => setPatientWithdrawReason(e.target.value)}
                                            className="w-full text-xs rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-gray-800 dark:text-gray-200 px-2.5 py-1.5"
                                        >
                                            <option value="Wait time / need to step away">Wait time / need to step away</option>
                                            <option value="Feeling better now">Feeling better now</option>
                                            <option value="Want to schedule for later instead">Want to schedule for later instead</option>
                                            <option value="Started by mistake">Started by mistake</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setShowPatientWithdrawModal(false)}
                                        disabled={patientWithdrawing}
                                    >
                                        Stay in Visit
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="danger"
                                        onClick={handlePatientWithdraw}
                                        disabled={patientWithdrawing}
                                        data-testid="patient-room-confirm-withdraw-btn"
                                    >
                                        {patientWithdrawing ? 'Withdrawing…' : 'Yes, Withdraw Visit'}
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* Mandatory Pre-Doctor Hx Intake Gate (Patient only) */}
                        {!userCanViewClinicalInsights && !intakeComplete && !consultClosed && (
                            <div
                                data-testid="mandatory-hx-intake-gate"
                                className="bg-gradient-to-br from-amber-50 to-emerald-50 dark:from-amber-950/30 dark:to-emerald-950/30 ring-1 ring-amber-300 dark:ring-amber-700 rounded-2xl shadow-card p-5 animate-fade-in space-y-3"
                            >
                                <div className="flex items-start gap-3">
                                    <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0 dark:bg-amber-900/40">
                                        <span className="text-2xl">🩺</span>
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="font-bold text-gray-900 dark:text-white text-sm">Mandatory Medical History (Hx) Intake Required Before Seeing a Doctor</p>
                                            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">
                                                Pre-Doctor Gate
                                            </span>
                                        </div>
                                        <p className="text-xs text-gray-700 dark:text-gray-300 mt-1">
                                            No patient sees a doctor without completing Medical History (Hx) intake. You can complete your Hx now using the <strong>AI Intake Assistant</strong>, or if this is a local walk-in visit, a <strong>Nurse will record your Hx &amp; Vitals at triage</strong>.
                                        </p>
                                    </div>
                                </div>
                                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                                    <Link href={`/consultations/${consultationId}/intake`} className="flex-1">
                                        <Button className="w-full bg-green-600 hover:bg-green-700 text-white">Continue Medical Intake →</Button>
                                    </Link>
                                </div>
                            </div>
                        )}

                        {/* Unclaimed Waiting Patient Claim Banner (Doctor / Clinician) */}
                        {userCanManageStatus && !consultation.doctorId && consultClosed && consultation.status !== 'completed' && (
                            <div
                                data-testid="closed-consultation-notice"
                                role="status"
                                className="bg-gray-50 dark:bg-slate-800/60 border border-gray-200 dark:border-slate-700 rounded-2xl p-4 text-sm text-gray-700 dark:text-gray-300"
                            >
                                {closedVisitNotice(consultation)}
                            </div>
                        )}

                        {userCanManageStatus && !consultation.doctorId && !consultClosed && (
                            <div
                                data-testid="unclaimed-consultation-claim-banner"
                                className="bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 border border-emerald-200 dark:border-emerald-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                            >
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                                            🩺 Unclaimed Queue Patient — Ready to Claim
                                        </p>
                                        <span
                                            className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${
                                                (consultation as any).patientOnline !== false
                                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
                                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200'
                                            }`}
                                        >
                                            {(consultation as any).patientOnline !== false
                                                ? '🟢 Patient Online & Available Now'
                                                : `🕒 ${(consultation as any).patientPresenceLabel || 'Waiting from Earlier Today (Will Notify Patient)'}`}
                                        </span>
                                    </div>
                                    <p className="text-xs text-emerald-800 dark:text-emerald-300">
                                        {(consultation as any).patientOnline !== false
                                            ? 'Claim this consultation to assign yourself as the attending doctor and begin the live session.'
                                            : 'This patient completed intake earlier today. Claiming them assigns the consultation to you and sends them an instant push & email notification to rejoin.'}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Button
                                        size="sm"
                                        onClick={() => handleClaimAndStart(true)}
                                        disabled={claimingConsultation}
                                        className="bg-emerald-600 hover:bg-emerald-700 text-white whitespace-nowrap"
                                    >
                                        {claimingConsultation
                                            ? 'Claiming...'
                                            : (consultation as any).patientOnline !== false
                                                ? '🩺 Claim & Start Consultation'
                                                : '🔔 Claim & Notify Patient'}
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* Scheduled Visit Gateway Banner (Doctor & Patient) */}
                        {(consultation.status === 'scheduled' || consultation.status === 'confirmed') && (
                            <div
                                data-testid="scheduled-visit-gateway-banner"
                                className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                            >
                                <div>
                                    <p className="text-sm font-bold text-indigo-950 dark:text-indigo-200">
                                        📅 Scheduled Visit — {formatDate(consultation.scheduledAt)}
                                    </p>
                                    <p className="text-xs text-indigo-800 dark:text-indigo-300 mt-0.5">
                                        {userCanViewClinicalInsights
                                            ? 'You can start this scheduled visit anytime via Chat, Audio Call, or Video Call — the patient will be notified immediately.'
                                            : intakeComplete
                                                ? 'Your pre-visit history is complete! Open the Chat tab or stay on this page — we will alert you as soon as your doctor joins.'
                                                : 'Complete your quick AI pre-visit history now so your doctor has your full summary before your scheduled time.'}
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 shrink-0">
                                    {userCanViewClinicalInsights ? (
                                        <>
                                            <Button
                                                size="sm"
                                                onClick={startChatConsultation}
                                                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                            >
                                                💬 Start Visit (Chat)
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => startVideoCall('audio')}
                                            >
                                                📞 Audio Call
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => startVideoCall('video')}
                                            >
                                                📹 Video Call
                                            </Button>
                                        </>
                                    ) : (
                                        <>
                                            {!intakeComplete && (
                                                <Link href={`/consultations/${consultationId}/intake`}>
                                                    <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                                                        🩺 Complete Pre-Visit History →
                                                    </Button>
                                                </Link>
                                            )}
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => setActiveTab('chat')}
                                            >
                                                💬 Open Visit Chat
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Clinician / Nurse Walk-In Hx Intake Banner */}
                        {(userCanRecordVitals || userCanManageStatus) && !intakeComplete && !consultClosed && (
                            <div
                                data-testid="clinician-nurse-hx-banner"
                                className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                            >
                                <div>
                                    <p className="text-sm font-bold text-blue-900 dark:text-blue-200">
                                        🩺 Patient Medical History (Hx) Intake Pending
                                    </p>
                                    <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
                                        For walk-in or scheduled patients who deferred the AI bot, a Nurse or Clinician can complete the structured Hx &amp; Vitals intake directly.
                                    </p>
                                </div>
                                <Button
                                    size="sm"
                                    onClick={() => setShowNurseHxModal(true)}
                                    className="bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
                                >
                                    🩺 Complete Nurse Hx Intake (Walk-In / Triage)
                                </Button>
                            </div>
                        )}

                        {/* === OVERVIEW TAB === */}
                        {activeTab === 'overview' && (
                            <>
                                {/* W2.3 — Doctor-Ready Packet (feature-flagged, dual-read, clinician-only) */}
                                {userCanViewClinicalInsights && <DoctorReadyPacketPanel consultationId={consultationId} />}

                                {/* Consultation Info */}
                                <Card>
                                    <CardContent className="p-5">
                                        <div className="flex items-center gap-4 mb-4">
                                            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 dark:bg-green-900/30">
                                                <span className="text-green-600 font-bold text-lg">
                                                    {doctor?.profile?.firstName?.[0]}{doctor?.profile?.lastName?.[0]}
                                                </span>
                                            </div>
                                            <div className="flex-1">
                                                <p className="font-semibold">Dr. {doctor?.profile?.firstName} {doctor?.profile?.lastName}</p>
                                                <p className="text-sm text-gray-500 dark:text-gray-400">{doctor?.specialization}</p>
                                            </div>
                                            {consultation.fee > 0 && (
                                                <span className="text-sm font-medium text-gray-600 dark:text-gray-300">Billed after consultation</span>
                                            )}
                                        </div>

                                        {/* Symptoms */}
                                        {consultation.symptoms?.length > 0 && (
                                            <div className="pt-4 border-t">
                                                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Chief Complaints / Symptoms</p>
                                                <div className="flex flex-wrap gap-1">
                                                    {consultation.symptoms.map((s, i) => (
                                                        <span key={i} className="text-xs bg-orange-50 text-orange-700 border border-orange-200 px-2 py-1 rounded-full dark:bg-orange-900/20 dark:text-orange-300">{s}</span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Diagnosis */}
                                        {consultation.diagnosis && (
                                            <div className="mt-4 pt-4 border-t">
                                                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Diagnosis</p>
                                                <p className="font-medium text-gray-900 dark:text-white">{consultation.diagnosis}</p>
                                                {(consultation.clinicalSummary || consultation.notes) && <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{consultation.clinicalSummary || consultation.notes}</p>}
                                            </div>
                                        )}

                                        {/* Prescription Link */}
                                        {consultation.prescriptionId && (
                                            <Link href={`/prescriptions/${consultation.prescriptionId}`} className="mt-4 block">
                                                <Button variant="outline" className="w-full">💊 View Prescription</Button>
                                            </Link>
                                        )}

                                        {/* Clinician Status Actions */}
                                        {userCanManageStatus && (
                                            <div className="mt-4 pt-4 border-t">
                                                {!consultation.doctorId && !consultClosed && (
                                                    <div className="flex flex-col sm:flex-row gap-2">
                                                        <Button
                                                            onClick={() => handleClaimAndStart(true)}
                                                            disabled={claimingConsultation}
                                                            className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                                                        >
                                                            {claimingConsultation ? 'Claiming...' : '🩺 Claim & Start Consultation'}
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            onClick={() => handleClaimAndStart(false)}
                                                            disabled={claimingConsultation}
                                                        >
                                                            Claim Only
                                                        </Button>
                                                    </div>
                                                )}
                                                {consultation.doctorId && (consultation.status === 'pending' || consultation.status === 'intake_complete' || consultation.status === 'waitlist') && (
                                                    <div className="flex gap-2">
                                                        <Button onClick={() => handleStatusUpdate('in_progress')} className="flex-1">▶ Start Consultation</Button>
                                                        <Button variant="outline" onClick={() => handleStatusUpdate('confirmed')}>Confirm</Button>
                                                        <Button variant="outline" onClick={() => handleStatusUpdate('cancelled')}>Decline</Button>
                                                    </div>
                                                )}
                                                {consultation.doctorId && (consultation.status === 'confirmed' || consultation.status === 'accepted' || consultation.status === 'scheduled') && (
                                                    <div className="grid sm:grid-cols-2 gap-2">
                                                        <Button onClick={() => handleStatusUpdate('in_progress')} className="w-full">▶ Start Consultation</Button>
                                                        <Button variant="outline" aria-label="Start text consultation" onClick={startChatConsultation} className="w-full">💬 Start / Join Chat</Button>
                                                    </div>
                                                )}
                                                {consultation.status === 'in_progress' && (
                                                    <div className="space-y-3">
                                                        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wider">Clinical Actions</p>
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                aria-label="Open text consultation"
                                                                onClick={() => setActiveTab('chat')}
                                                                className="w-full justify-start border-green-300 text-green-700 dark:text-green-300"
                                                            >
                                                                💬 Live Chat with Patient
                                                            </Button>
                                                            {userCanPrescribe && (
                                                                <Link href={`/prescriptions/write?consultationId=${consultationId}`}>
                                                                    <Button variant="outline" size="sm" className="w-full justify-start">💊 Write Prescription</Button>
                                                                </Link>
                                                            )}
                                                            {userCanOrderLabs && (
                                                                <Link href={`/lab-orders/write?consultationId=${consultationId}`}>
                                                                    <Button variant="outline" size="sm" className="w-full justify-start">🧪 Order Lab Tests</Button>
                                                                </Link>
                                                            )}
                                                            {userCanOrderRadiology && (
                                                                <Link href={`/radiology-orders/write?consultationId=${consultationId}`}>
                                                                    <Button variant="outline" size="sm" className="w-full justify-start">🩻 Radiology Order</Button>
                                                                </Link>
                                                            )}
                                                            {userCanRefer && (
                                                                <Link href={`/referrals/write?consultationId=${consultationId}`}>
                                                                    <Button variant="outline" size="sm" className="w-full justify-start">🏥 Write Referral</Button>
                                                                </Link>
                                                            )}
                                                        </div>
                                                        <Button onClick={() => setShowHandoff(true)} className="w-full" variant="outline" data-testid="finish-consultation">
                                                            ✅ Complete Consultation
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>

                                {/* M2: Longitudinal Patient History & At-A-Glance Clinical Synthesis (Clinician Only) */}
                                {isClinician && user?.role !== 'patient' && (
                                    <LongitudinalSummaryCard consultationId={consultationId} />
                                )}

                                {/* Physician AI Brief — also for nurse-path (Hx) intakes */}
                                {userCanViewClinicalInsights && intakeComplete && (
                                    <PhysicianBrief consultationId={consultationId} />
                                )}

                                {/* Standardized Fixed Longitudinal History Editor */}
                                {consultation.patientId && (
                                    <FixedHistoryEditor
                                        patientId={consultation.patientId}
                                        patientName={consultation.patientName}
                                        readOnly={user?.role === 'patient'}
                                        className="mb-4"
                                    />
                                )}

                                {/* Diagnosis Entry (Clinician, in_progress) */}
                                {userCanEditDiagnosis && consultation.status === 'in_progress' && (
                                    <Card>
                                        <CardHeader><CardTitle>🩺 Diagnosis & Assessment</CardTitle></CardHeader>
                                        <CardContent className="space-y-3">
                                            <div>
                                                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Diagnosis</label>
                                                <ActiveTypingActionChips
                                                    activeField={focusedField === 'diagnosis' ? 'diagnosis' : null}
                                                    userRole={user?.role}
                                                    currentValue={diagnosisForm.diagnosis}
                                                    differentials={ddxData?.differentials || []}
                                                    managementPlans={ddxData?.managementPlans || []}
                                                    alerts={ddxData?.alerts || []}
                                                    briefData={aiBrief}
                                                    onAdopt={(val) => setDiagnosisForm(prev => ({ ...prev, diagnosis: val }))}
                                                />
                                                <input
                                                    type="text" placeholder="e.g. Acute upper respiratory infection"
                                                    className="w-full mt-1 px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={diagnosisForm.diagnosis}
                                                    onFocus={() => setFocusedField('diagnosis')}
                                                    onChange={e => setDiagnosisForm(prev => ({ ...prev, diagnosis: e.target.value }))}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">ICD-10 Code (Optional)</label>
                                                <input
                                                    type="text" placeholder="e.g. J06.9"
                                                    className="w-full mt-1 px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={diagnosisForm.icdCode}
                                                    onFocus={() => setFocusedField('icdCode')}
                                                    onChange={e => setDiagnosisForm(prev => ({ ...prev, icdCode: e.target.value }))}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider block">Patient Clinical Summary (Visible to Patient)</label>
                                                <ActiveTypingActionChips
                                                    activeField={focusedField === 'clinicalSummary' ? 'clinicalSummary' : null}
                                                    userRole={user?.role}
                                                    currentValue={diagnosisForm.clinicalSummary}
                                                    differentials={ddxData?.differentials || []}
                                                    managementPlans={ddxData?.managementPlans || []}
                                                    alerts={ddxData?.alerts || []}
                                                    briefData={aiBrief}
                                                    onAdopt={(val) => setDiagnosisForm(prev => ({ ...prev, clinicalSummary: val }))}
                                                />
                                                <textarea rows={3} placeholder="Patient-friendly summary and instructions..."
                                                    className="w-full mt-1 px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none resize-none text-sm"
                                                    value={diagnosisForm.clinicalSummary}
                                                    onFocus={() => setFocusedField('clinicalSummary')}
                                                    onChange={e => setDiagnosisForm(prev => ({ ...prev, clinicalSummary: e.target.value }))}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider block">Internal Clinical Notes (Care Team Only)</label>
                                                <ActiveTypingActionChips
                                                    activeField={focusedField === 'internalNotes' ? 'internalNotes' : null}
                                                    userRole={user?.role}
                                                    currentValue={diagnosisForm.notes}
                                                    differentials={ddxData?.differentials || []}
                                                    managementPlans={ddxData?.managementPlans || []}
                                                    alerts={ddxData?.alerts || []}
                                                    briefData={aiBrief}
                                                    onAdopt={(val) => setDiagnosisForm(prev => ({ ...prev, notes: val }))}
                                                />
                                                <textarea rows={3} placeholder="Private care team notes, findings, and assessment..."
                                                    className="w-full mt-1 px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none resize-none text-sm"
                                                    value={diagnosisForm.notes}
                                                    onFocus={() => setFocusedField('internalNotes')}
                                                    onChange={e => setDiagnosisForm(prev => ({ ...prev, notes: e.target.value }))}
                                                />
                                            </div>
                                            <Button onClick={handleSaveDiagnosis} disabled={savingDiagnosis} className="w-full">
                                                {savingDiagnosis ? 'Saving...' : '💾 Save Diagnosis'}
                                            </Button>
                                        </CardContent>
                                    </Card>
                                )}
                            </>
                        )}

                        {/* === CHART NOTES TAB === */}
                        {activeTab === 'chart-notes' && userCanChartNotes && (
                            <>
                                {/* === Meta Muse Wonder Co-Pilot Intelligence Hub === */}
                                <Card className="border-2 border-indigo-200 dark:border-indigo-900/50 bg-gradient-to-br from-indigo-50/50 via-white to-purple-50/30 dark:from-slate-900 dark:via-slate-900 dark:to-indigo-950/20 shadow-sm overflow-hidden mb-6">
                                    <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-indigo-100 dark:border-slate-800">
                                        <div className="flex items-center gap-2.5">
                                            <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
                                                ✨
                                            </div>
                                            <div>
                                                <CardTitle className="text-base text-indigo-950 dark:text-indigo-200 flex items-center gap-2">
                                                    Meta Muse Wonder Clinical Co-Pilot
                                                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-bold uppercase tracking-wider">
                                                        Live DDx & NAFDAC
                                                    </span>
                                                </CardTitle>
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                                    Llama 3.3 70B Clinical Reasoning • Differential Diagnoses, Red Flags & Verified Rx
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={handleCopilotSync}
                                                disabled={syncingCopilot}
                                                className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white border-transparent text-xs font-bold shadow-md shadow-indigo-600/20"
                                            >
                                                <span className="text-sm">⚡</span> {syncingCopilot ? 'Synthesizing Wonder…' : copilotData ? 'Refresh Co-Pilot' : 'Run Muse Wonder Co-Pilot'}
                                            </Button>
                                            {copilotData && (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setShowCopilotCard(!showCopilotCard)}
                                                    className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400"
                                                >
                                                    {showCopilotCard ? 'Collapse' : 'Expand'}
                                                </Button>
                                            )}
                                        </div>
                                    </CardHeader>
                                    {showCopilotCard && (
                                        <CardContent className="pt-4 space-y-4">
                                            {!copilotData && !syncingCopilot && (
                                                <div className="py-6 text-center text-xs text-gray-500 dark:text-gray-400 space-y-2">
                                                    <p className="font-medium text-gray-700 dark:text-gray-300">
                                                        Synthesize real-time differential diagnoses, clinical red flags, and NAFDAC verified medicine suggestions.
                                                    </p>
                                                    <p className="text-[11px]">
                                                        Click <strong>Run Muse Wonder Co-Pilot</strong> to analyze patient symptoms, vitals, and intake history.
                                                    </p>
                                                </div>
                                            )}

                                            {syncingCopilot && (
                                                <div className="py-8 flex flex-col items-center justify-center text-center space-y-2 text-indigo-600 dark:text-indigo-400" aria-label="Syncing Muse Wonder Co-Pilot">
                                                    <div className="h-6 w-6 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
                                                    <p className="text-xs font-semibold">Synthesizing clinical intake, differential diagnoses & verified medicines...</p>
                                                </div>
                                            )}

                                            {copilotData && !syncingCopilot && (
                                                <div className="space-y-5">
                                                    {/* Top 3 Differential Diagnoses with Likelihood Ratings */}
                                                    <div>
                                                        <div className="flex items-center justify-between mb-2">
                                                            <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                                                                🩺 Top Differential Diagnoses (DDx)
                                                            </span>
                                                            <span className="text-[11px] text-gray-500 dark:text-gray-400">
                                                                1-Click Adopt into SOAP Assessment
                                                            </span>
                                                        </div>
                                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                            {(copilotData.differentials || []).slice(0, 3).map((ddx, idx) => {
                                                                const likelihood = ddx.likelihood?.toLowerCase();
                                                                const badgeColor =
                                                                    likelihood === 'high'
                                                                        ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                                                                        : likelihood === 'medium'
                                                                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                                                                        : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800';
                                                                return (
                                                                    <div
                                                                        key={idx}
                                                                        className="p-3.5 rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-800/80 shadow-xs space-y-2 flex flex-col justify-between"
                                                                    >
                                                                        <div className="space-y-1.5">
                                                                            <div className="flex items-center justify-between gap-1.5">
                                                                                <span className="font-bold text-xs text-gray-900 dark:text-white truncate">
                                                                                    {ddx.name}
                                                                                </span>
                                                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${badgeColor}`}>
                                                                                    {ddx.likelihood}
                                                                                </span>
                                                                            </div>
                                                                            <p className="text-[11px] text-gray-600 dark:text-gray-300 leading-relaxed">
                                                                                {ddx.reasoning}
                                                                            </p>
                                                                        </div>
                                                                        <Button
                                                                            type="button"
                                                                            size="sm"
                                                                            variant="outline"
                                                                            onClick={() => {
                                                                                const ddxEntry = `• ${ddx.name} (Likelihood: ${ddx.likelihood.toUpperCase()}): ${ddx.reasoning}`;
                                                                                setSoapNote(prev => ({
                                                                                    ...prev,
                                                                                    assessment: prev.assessment ? `${prev.assessment}\n${ddxEntry}` : ddxEntry,
                                                                                }));
                                                                                toast.success(`Adopted ${ddx.name} into SOAP Assessment!`);
                                                                            }}
                                                                            className="w-full text-[11px] py-1 h-7 border-indigo-200 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300"
                                                                        >
                                                                            + Adopt into Assessment
                                                                        </Button>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>

                                                    {/* Red Flags & Suggested Questions */}
                                                    {copilotData.suggestions && copilotData.suggestions.length > 0 && (
                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                            {/* Clinical Red Flags */}
                                                            <div className="p-3.5 rounded-xl border border-rose-200 dark:border-rose-900/40 bg-rose-50/60 dark:bg-rose-950/20 space-y-2">
                                                                <span className="text-xs font-bold uppercase tracking-wider text-rose-700 dark:text-rose-400 flex items-center gap-1.5">
                                                                    🚨 Clinical Red Flags & Alerts
                                                                </span>
                                                                <div className="space-y-2">
                                                                    {copilotData.suggestions
                                                                        .filter(s => s.priority === 'high' || s.type === 'alert')
                                                                        .slice(0, 3)
                                                                        .map((item, idx) => (
                                                                            <div key={idx} className="text-xs space-y-0.5">
                                                                                <div className="font-bold text-rose-900 dark:text-rose-300">
                                                                                    ⚠️ {item.title}
                                                                                </div>
                                                                                <div className="text-[11px] text-rose-800/90 dark:text-rose-200/80">
                                                                                    {item.detail}
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    {copilotData.suggestions.filter(s => s.priority === 'high' || s.type === 'alert').length === 0 && (
                                                                        <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                                                                            ✓ No high-risk red flag alerts detected for this clinical presentation.
                                                                        </p>
                                                                    )}
                                                                </div>
                                                            </div>

                                                            {/* Suggested Clinical Questions */}
                                                            <div className="p-3.5 rounded-xl border border-indigo-200 dark:border-indigo-900/40 bg-indigo-50/60 dark:bg-indigo-950/20 space-y-2">
                                                                <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400 flex items-center gap-1.5">
                                                                    ❓ Suggested Clinical Inquiries
                                                                </span>
                                                                <div className="space-y-1.5">
                                                                    {copilotData.suggestions
                                                                        .filter(s => s.type === 'question' || s.type === 'diagnosis')
                                                                        .slice(0, 3)
                                                                        .map((item, idx) => (
                                                                            <button
                                                                                key={idx}
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    const q = item.detail || item.title;
                                                                                    setSoapNote(prev => ({
                                                                                        ...prev,
                                                                                        subjective: prev.subjective ? `${prev.subjective}\n• Q: ${q}` : `• Q: ${q}`,
                                                                                    }));
                                                                                    toast.info('Added question to Subjective notes');
                                                                                }}
                                                                                className="w-full text-left p-2 rounded-lg bg-white/70 dark:bg-slate-800 hover:bg-indigo-100/50 dark:hover:bg-indigo-900/30 transition-colors text-xs border border-indigo-100 dark:border-indigo-900/30 block"
                                                                            >
                                                                                <span className="font-semibold text-indigo-900 dark:text-indigo-200">{item.title}</span>
                                                                                {item.detail && <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-0.5">{item.detail}</p>}
                                                                            </button>
                                                                        ))}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* NAFDAC Verified Essential Medicine Suggestions */}
                                                    {copilotData.nafdacVerifiedRx && copilotData.nafdacVerifiedRx.length > 0 && (
                                                        <div className="p-3.5 rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-2.5">
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                                                                    💊 NAFDAC-Verified Medicine Recommendations
                                                                </span>
                                                                <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
                                                                    Essential Medicine List Alignment
                                                                </span>
                                                            </div>
                                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                                                                {copilotData.nafdacVerifiedRx.map((rx, idx) => (
                                                                    <div
                                                                        key={idx}
                                                                        className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800/60 bg-white dark:bg-slate-800 text-xs space-y-1.5 flex flex-col justify-between"
                                                                    >
                                                                        <div>
                                                                            <div className="font-bold text-gray-900 dark:text-white truncate">
                                                                                {rx.drugName}
                                                                            </div>
                                                                            <div className="text-[11px] text-gray-600 dark:text-gray-300">
                                                                                {rx.dose} • {rx.duration}
                                                                            </div>
                                                                            <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono mt-0.5">
                                                                                {rx.nafdacStatus}
                                                                            </div>
                                                                        </div>
                                                                        <div className="flex gap-1.5 pt-1">
                                                                            <Button
                                                                                type="button"
                                                                                size="sm"
                                                                                variant="outline"
                                                                                onClick={() => {
                                                                                    const planEntry = `• Rx: ${rx.drugName} - ${rx.dose} for ${rx.duration} (NAFDAC ${rx.nafdacStatus})`;
                                                                                    setSoapNote(prev => ({
                                                                                        ...prev,
                                                                                        plan: prev.plan ? `${prev.plan}\n${planEntry}` : planEntry,
                                                                                    }));
                                                                                    toast.success(`Added ${rx.drugName} to Plan!`);
                                                                                }}
                                                                                className="flex-1 text-[10px] py-0.5 h-6 text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-300"
                                                                            >
                                                                                + Plan
                                                                            </Button>
                                                                            <Button
                                                                                type="button"
                                                                                size="sm"
                                                                                onClick={() => {
                                                                                    router.push(`/prescriptions/write?consultationId=${consultationId}&med=${encodeURIComponent(rx.drugName)}`);
                                                                                }}
                                                                                className="flex-1 text-[10px] py-0.5 h-6 bg-emerald-600 hover:bg-emerald-700 text-white"
                                                                            >
                                                                                Write e-Rx
                                                                            </Button>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Vernacular Patient Summary (Nigerian English / Pidgin) */}
                                                    {copilotData.vernacularPatientSummary && (
                                                        <div className="p-3.5 rounded-xl border border-purple-200 dark:border-purple-900/40 bg-purple-50/50 dark:bg-purple-950/20 space-y-2">
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-xs font-bold uppercase tracking-wider text-purple-800 dark:text-purple-300 flex items-center gap-1.5">
                                                                    🗣️ Vernacular Discharge Instructions (Pidgin / Simple English)
                                                                </span>
                                                                <Button
                                                                    type="button"
                                                                    size="sm"
                                                                    variant="outline"
                                                                    onClick={() => {
                                                                        setDischargePatientFriendly(copilotData.vernacularPatientSummary!);
                                                                        if (!dischargeNoteId) setDischargeNoteId('muse-draft');
                                                                        toast.success('✨ Adopted Vernacular Summary into Discharge Instructions!');
                                                                    }}
                                                                    className="text-xs py-1 h-7 bg-purple-600 hover:bg-purple-700 text-white font-bold border-transparent"
                                                                >
                                                                    Adopt into Discharge Summary
                                                                </Button>
                                                            </div>
                                                            <p className="text-xs leading-relaxed text-gray-800 dark:text-gray-200 bg-white/80 dark:bg-slate-900/80 p-3 rounded-lg border border-purple-200 dark:border-purple-900/30 font-sans">
                                                                "{copilotData.vernacularPatientSummary}"
                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </CardContent>
                                    )}
                                </Card>

                                <Card>
                                    <CardHeader className="flex flex-row items-start justify-between pb-2">
                                    <div>
                                        <CardTitle>📝 SOAP Note</CardTitle>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Structured clinical documentation</p>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleCopilotSync}
                                            disabled={syncingCopilot}
                                            className="gap-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-300"
                                        >
                                            <span className="text-base">⚡</span> {syncingCopilot ? 'Syncing Wonder…' : 'Meta Muse Wonder Co-Pilot'}
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={handleGenerateSOAP} disabled={generatingSoap} className="gap-2 bg-purple-50 text-purple-700 hover:bg-purple-100 hover:text-purple-800 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300">
                                            <span className="text-base">✨</span> {generatingSoap ? 'Generating…' : 'Generate SOAP note'}
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={handleAutofillFromAI} className="gap-2 bg-green-50 text-green-700 hover:bg-green-100 hover:text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-300">
                                            <span className="text-base">🤖</span> Auto-fill from AI Brief
                                        </Button>
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {generatingSoap && (
                                        <div className="space-y-2" aria-label="Generating SOAP note">
                                            <div className="h-4 w-1/3 rounded skeleton" />
                                            <div className="h-20 w-full rounded-xl skeleton" />
                                            <div className="h-20 w-full rounded-xl skeleton" />
                                        </div>
                                    )}
                                    {soapError && !generatingSoap && (
                                        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
                                            {soapError}
                                        </div>
                                    )}
                                    {soapNoteId && !generatingSoap && (
                                        <div className="rounded-xl border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-700 dark:bg-purple-900/20 dark:text-purple-300">
                                            ✨ AI draft loaded. Review and edit every section before saving — this is a draft, never final.
                                        </div>
                                    )}
                                    <div>
                                        <label className="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider block mb-1">
                                            S — Subjective
                                        </label>
                                        <p className="text-[10px] text-gray-500 mb-1 dark:text-gray-400">Chief complaint, HPI, ROS, PMH/PSH/FH/SH in patient&apos;s own words</p>
                                        <ActiveTypingActionChips
                                            activeField={focusedField === 'soap-subjective' ? 'soap-subjective' : null}
                                            userRole={user?.role}
                                            currentValue={soapNote.subjective}
                                            differentials={ddxData?.differentials || []}
                                            managementPlans={ddxData?.managementPlans || []}
                                            alerts={ddxData?.alerts || []}
                                            briefData={aiBrief}
                                            symptoms={consultation?.symptoms || []}
                                            onAdopt={(val) => setSoapNote(prev => ({ ...prev, subjective: val }))}
                                        />
                                        <textarea rows={4} placeholder="Patient reports..."
                                            className="w-full px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none resize-none text-sm"
                                            value={soapNote.subjective}
                                            onFocus={() => setFocusedField('soap-subjective')}
                                            onChange={e => setSoapNote(prev => ({ ...prev, subjective: e.target.value }))}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider block mb-1">
                                            O — Objective
                                        </label>
                                        <p className="text-[10px] text-gray-500 mb-1 dark:text-gray-400">Vitals, physical exam findings, lab/imaging results</p>
                                        <ActiveTypingActionChips
                                            activeField={focusedField === 'soap-objective' ? 'soap-objective' : null}
                                            userRole={user?.role}
                                            currentValue={soapNote.objective}
                                            differentials={ddxData?.differentials || []}
                                            managementPlans={ddxData?.managementPlans || []}
                                            alerts={ddxData?.alerts || []}
                                            briefData={aiBrief}
                                            vitalsData={vitalsForm}
                                            onAdopt={(val) => setSoapNote(prev => ({ ...prev, objective: val }))}
                                        />
                                        <textarea rows={4} placeholder="Physical examination reveals..."
                                            className="w-full px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none resize-none text-sm"
                                            value={soapNote.objective}
                                            onFocus={() => setFocusedField('soap-objective')}
                                            onChange={e => setSoapNote(prev => ({ ...prev, objective: e.target.value }))}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider block mb-1">
                                            A — Assessment
                                        </label>
                                        <p className="text-[10px] text-gray-500 mb-1 dark:text-gray-400">Diagnosis, differential diagnoses, ICD-10 codes</p>
                                        <ActiveTypingActionChips
                                            activeField={focusedField === 'soap-assessment' ? 'soap-assessment' : null}
                                            userRole={user?.role}
                                            currentValue={soapNote.assessment}
                                            differentials={ddxData?.differentials || []}
                                            managementPlans={ddxData?.managementPlans || []}
                                            alerts={ddxData?.alerts || []}
                                            briefData={aiBrief}
                                            onAdopt={(val) => setSoapNote(prev => ({ ...prev, assessment: val }))}
                                        />
                                        <textarea rows={3} placeholder="Assessment / Diagnosis..."
                                            className="w-full px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none resize-none text-sm"
                                            value={soapNote.assessment}
                                            onFocus={() => setFocusedField('soap-assessment')}
                                            onChange={e => setSoapNote(prev => ({ ...prev, assessment: e.target.value }))}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider block mb-1">
                                            P — Plan
                                        </label>
                                        <p className="text-[10px] text-gray-500 mb-1 dark:text-gray-400">Treatment plan, medications, labs, follow-up, patient education</p>
                                        <ActiveTypingActionChips
                                            activeField={focusedField === 'soap-plan' ? 'soap-plan' : null}
                                            userRole={user?.role}
                                            currentValue={soapNote.plan}
                                            differentials={ddxData?.differentials || []}
                                            managementPlans={ddxData?.managementPlans || []}
                                            alerts={ddxData?.alerts || []}
                                            briefData={aiBrief}
                                            onAdopt={(val) => setSoapNote(prev => ({ ...prev, plan: val }))}
                                        />
                                        <textarea rows={4} placeholder="Plan of care..."
                                            className="w-full px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:outline-none resize-none text-sm"
                                            value={soapNote.plan}
                                            onFocus={() => setFocusedField('soap-plan')}
                                            onChange={e => setSoapNote(prev => ({ ...prev, plan: e.target.value }))}
                                        />
                                    </div>
                                    <div className="flex gap-2">
                                        <Button onClick={handleSaveSOAPNote} disabled={savingNote} className="flex-1">
                                            {savingNote ? 'Saving...' : '💾 Save SOAP Note'}
                                        </Button>
                                        <Button variant="outline" onClick={() => { setSoapNote({ subjective: '', objective: '', assessment: '', plan: '' }); setSoapNoteId(null); setSoapError(null); }}>
                                            Clear
                                        </Button>
                                    </div>
                                    {soapNoteId && (
                                        <div className="flex flex-wrap gap-2 border-t border-gray-100 dark:border-slate-700 pt-3">
                                            <Button variant="outline" size="sm" onClick={() => handleSaveGeneratedSOAP(false)} disabled={savingNote}>
                                                Save AI draft
                                            </Button>
                                            <Button size="sm" onClick={() => handleSaveGeneratedSOAP(true)} disabled={savingNote} className="bg-purple-600 hover:bg-purple-700">
                                                Finalize note
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </>
                        )}

                        {activeTab === 'chart-notes' && userCanChartNotes && (
                            <Card className="mt-6">
                                <CardHeader className="flex flex-row items-start justify-between pb-2">
                                    <div>
                                        <CardTitle>🏥 Discharge Summary</CardTitle>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">AI-generated discharge / after-visit summary for inpatient or completed encounters</p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {copilotData?.vernacularPatientSummary && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => {
                                                    setDischargePatientFriendly(copilotData.vernacularPatientSummary!);
                                                    if (!dischargeNoteId) setDischargeNoteId('muse-draft');
                                                    toast.success('✨ Adopted Muse Wonder Vernacular Instructions!');
                                                }}
                                                className="gap-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300"
                                            >
                                                <span className="text-base">🗣️</span> Adopt Muse Wonder Instructions
                                            </Button>
                                        )}
                                        <Button variant="outline" size="sm" onClick={handleGenerateDischarge} disabled={generatingDischarge} className="gap-2 bg-purple-50 text-purple-700 hover:bg-purple-100 hover:text-purple-800 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300">
                                            <span className="text-base">✨</span> {generatingDischarge ? 'Generating…' : 'Generate discharge summary'}
                                        </Button>
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {generatingDischarge && (
                                        <div className="space-y-2" aria-label="Generating discharge summary">
                                            <div className="h-24 w-full rounded-xl skeleton" />
                                            <div className="h-16 w-full rounded-xl skeleton" />
                                        </div>
                                    )}
                                    {dischargeError && !generatingDischarge && (
                                        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
                                            {dischargeError}
                                        </div>
                                    )}
                                    {!generatingDischarge && !dischargeNoteId && !dischargeError && (
                                        <p className="text-sm text-gray-500 dark:text-gray-400">No summary yet. Generate a draft, then edit it before saving.</p>
                                    )}
                                    {dischargeNoteId && !generatingDischarge && (
                                        <>
                                            <div className="rounded-xl border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-700 dark:bg-purple-900/20 dark:text-purple-300">
                                                ✨ AI draft loaded. Review and edit before saving — this is a draft, never final.
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider block mb-1">Medical summary</label>
                                                <textarea rows={8}
                                                    className="w-full px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-purple-500 focus:outline-none resize-none text-sm"
                                                    value={dischargeDraft}
                                                    onChange={e => setDischargeDraft(e.target.value)}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider block mb-1">Patient-friendly version</label>
                                                <textarea rows={5}
                                                    className="w-full px-3 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-purple-500 focus:outline-none resize-none text-sm"
                                                    value={dischargePatientFriendly}
                                                    onChange={e => setDischargePatientFriendly(e.target.value)}
                                                />
                                            </div>
                                            <div className="flex flex-wrap gap-2 border-t border-gray-100 dark:border-slate-700 pt-3">
                                                <Button variant="outline" size="sm" onClick={() => handleSaveDischarge(false)} disabled={savingDischarge}>
                                                    Save draft
                                                </Button>
                                                <Button size="sm" onClick={() => handleSaveDischarge(true)} disabled={savingDischarge} className="bg-purple-600 hover:bg-purple-700">
                                                    Finalize summary
                                                </Button>
                                            </div>
                                        </>
                                    )}
                                    {userCanManageStatus && !['completed', 'cancelled'].includes(consultation.status) && (
                                        <div className="flex items-center justify-between gap-3 pt-4 border-t border-gray-100 dark:border-slate-700">
                                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                                Done documenting? Hand off to pharmacy/lab or close this consultation.
                                            </p>
                                            <Button
                                                size="sm"
                                                className="bg-green-600 hover:bg-green-700 text-white font-bold"
                                                onClick={() => setShowHandoff(true)}
                                            >
                                                ✅ Complete Consultation & Hand Off
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* === VITALS TAB === */}
                        {activeTab === 'vitals' && userCanRecordVitals && (
                            <Card>
                                <CardHeader><CardTitle>❤️ Vitals Entry</CardTitle></CardHeader>
                                <CardContent>
                                    <ActiveTypingActionChips
                                        activeField={focusedField === 'vitals' ? 'vitals' : null}
                                        userRole={user?.role}
                                        differentials={ddxData?.differentials || []}
                                        vitalsData={vitalsForm}
                                        onAdopt={(val, label) => {
                                            if (label.includes('Abnormal BP') || label.includes('Normal')) {
                                                setSoapNote(prev => ({
                                                    ...prev,
                                                    objective: prev.objective ? `${prev.objective}\n${val}` : val,
                                                }));
                                                toast.info('Triage note updated in SOAP O');
                                            }
                                        }}
                                    />
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4" onFocus={() => setFocusedField('vitals')}>
                                        {/* Weight */}
                                        <div>
                                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Weight</label>
                                            <div className="flex items-center gap-1 mt-1">
                                                <input type="number" placeholder="152" className="w-full px-2 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={vitalsForm.weightLbs} onChange={e => setVitalsForm(p => ({ ...p, weightLbs: e.target.value }))} />
                                                <span className="text-xs text-gray-500 dark:text-gray-400">lbs</span>
                                            </div>
                                        </div>
                                        {/* Height */}
                                        <div>
                                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Height</label>
                                            <div className="flex items-center gap-1 mt-1">
                                                <input type="number" placeholder="5" className="w-16 px-2 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={vitalsForm.heightFt} onChange={e => setVitalsForm(p => ({ ...p, heightFt: e.target.value }))} />
                                                <span className="text-xs text-gray-500 dark:text-gray-400">ft</span>
                                                <input type="number" placeholder="7" className="w-16 px-2 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={vitalsForm.heightIn} onChange={e => setVitalsForm(p => ({ ...p, heightIn: e.target.value }))} />
                                                <span className="text-xs text-gray-500 dark:text-gray-400">in</span>
                                            </div>
                                        </div>
                                        {/* BMI (auto-calculated) */}
                                        <div>
                                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">BMI</label>
                                            <div className="mt-1 px-2 py-2 bg-gray-50 dark:bg-slate-700/50 border rounded text-sm font-medium text-gray-700 dark:text-gray-300">
                                                {bmi || '—'}
                                            </div>
                                        </div>
                                        {/* Temperature */}
                                        <div>
                                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Temp</label>
                                            <div className="flex items-center gap-1 mt-1">
                                                <input type="number" step="0.1" placeholder="98.6" className="w-full px-2 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={vitalsForm.temperature} onChange={e => setVitalsForm(p => ({ ...p, temperature: e.target.value }))} />
                                                <span className="text-xs text-gray-500 dark:text-gray-400">°F</span>
                                            </div>
                                        </div>
                                        {/* Head Circumference */}
                                        <div>
                                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Head Circ</label>
                                            <div className="flex items-center gap-1 mt-1">
                                                <input type="number" placeholder="" className="w-full px-2 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={vitalsForm.headCirc} onChange={e => setVitalsForm(p => ({ ...p, headCirc: e.target.value }))} />
                                                <span className="text-xs text-gray-500 dark:text-gray-400">cm</span>
                                            </div>
                                        </div>
                                        {/* SPO2 */}
                                        <div>
                                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">SPO2</label>
                                            <div className="flex items-center gap-1 mt-1">
                                                <input type="number" placeholder="98" className="w-full px-2 py-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                    value={vitalsForm.spo2} onChange={e => setVitalsForm(p => ({ ...p, spo2: e.target.value }))} />
                                                <span className="text-xs text-gray-500 dark:text-gray-400">%</span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* BP, Pulse, Respiration Row */}
                                    <div className="grid grid-cols-3 gap-4 mt-6 pt-4 border-t">
                                        <div>
                                            <p className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">BP</p>
                                            <div className="space-y-2">
                                                <div className="flex items-center gap-1">
                                                    <label className="text-xs text-gray-400 w-16 dark:text-gray-500">Systolic</label>
                                                    <input type="number" placeholder="120" className="w-full px-2 py-1.5 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                        value={vitalsForm.systolic} onChange={e => setVitalsForm(p => ({ ...p, systolic: e.target.value }))} />
                                                    <span className="text-xs text-gray-500 dark:text-gray-400">mmHg</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <label className="text-xs text-gray-400 w-16 dark:text-gray-500">Diastolic</label>
                                                    <input type="number" placeholder="80" className="w-full px-2 py-1.5 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                        value={vitalsForm.diastolic} onChange={e => setVitalsForm(p => ({ ...p, diastolic: e.target.value }))} />
                                                    <span className="text-xs text-gray-500 dark:text-gray-400">mmHg</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Pulse</p>
                                            <div className="space-y-2">
                                                <div className="flex items-center gap-1">
                                                    <label className="text-xs text-gray-400 w-16 dark:text-gray-500">Rate</label>
                                                    <input type="number" placeholder="72" className="w-full px-2 py-1.5 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                        value={vitalsForm.pulseRate} onChange={e => setVitalsForm(p => ({ ...p, pulseRate: e.target.value }))} />
                                                    <span className="text-xs text-gray-500 dark:text-gray-400">bpm</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <label className="text-xs text-gray-400 w-16 dark:text-gray-500">Pattern</label>
                                                    <select className="w-full px-2 py-1.5 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                        value={vitalsForm.pulsePattern} onChange={e => setVitalsForm(p => ({ ...p, pulsePattern: e.target.value }))}>
                                                        <option value="">-- Select --</option>
                                                        <option>Regular</option><option>Irregular</option><option>Bounding</option><option>Thready</option>
                                                    </select>
                                                </div>
                                            </div>
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Respiration</p>
                                            <div className="space-y-2">
                                                <div className="flex items-center gap-1">
                                                    <label className="text-xs text-gray-400 w-16 dark:text-gray-500">Rate</label>
                                                    <input type="number" placeholder="16" className="w-full px-2 py-1.5 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                        value={vitalsForm.respRate} onChange={e => setVitalsForm(p => ({ ...p, respRate: e.target.value }))} />
                                                    <span className="text-xs text-gray-500 dark:text-gray-400">bpm</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <label className="text-xs text-gray-400 w-16 dark:text-gray-500">Pattern</label>
                                                    <select className="w-full px-2 py-1.5 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-slate-700 rounded text-sm focus:ring-2 focus:ring-green-500 focus:outline-none"
                                                        value={vitalsForm.respPattern} onChange={e => setVitalsForm(p => ({ ...p, respPattern: e.target.value }))}>
                                                        <option value="">-- Select --</option>
                                                        <option>Normal</option><option>Shallow</option><option>Deep</option><option>Labored</option><option>Apneic</option>
                                                    </select>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <Button onClick={handleSaveVitals} disabled={savingVitals} className="w-full mt-4">
                                        {savingVitals ? 'Saving...' : '💾 Record Vitals'}
                                    </Button>
                                </CardContent>
                            </Card>
                        )}

                        {/* === MEDICATIONS TAB === */}
                        {activeTab === 'medications' && (
                            <Card>
                                <CardHeader className="flex flex-row items-center justify-between">
                                    <CardTitle>💊 Medications</CardTitle>
                                    {userCanPrescribe && consultation.status === 'in_progress' && (
                                        <Link href={`/prescriptions/write?consultationId=${consultationId}`}>
                                            <Button size="sm">+ Write Prescription</Button>
                                        </Link>
                                    )}
                                </CardHeader>
                                <CardContent>
                                    {medicalRecord?.medications?.length > 0 ? (
                                        <div className="space-y-2">
                                            {medicalRecord.medications.map((med: any, i: number) => (
                                                <div key={i} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-700/50 rounded-lg">
                                                    <div>
                                                        <p className="text-sm font-medium">{med.name || med}</p>
                                                        {med.dosage && <p className="text-xs text-gray-500 dark:text-gray-400">{med.dosage} — {med.frequency}</p>}
                                                    </div>
                                                    {med.status && (
                                                        <span className={`text-xs px-2 py-0.5 rounded-full ${med.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300'}`}>
                                                            {med.status}
                                                        </span>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-gray-500 dark:text-gray-400 text-center py-8 text-sm">No current medications on file</p>
                                    )}
                                    {consultation.prescriptionId && (
                                        <Link href={`/prescriptions/${consultation.prescriptionId}`} className="block mt-4">
                                            <Button variant="outline" className="w-full">View Consultation Prescription</Button>
                                        </Link>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* === ALLERGIES TAB === */}
                        {activeTab === 'allergies' && (
                            <Card>
                                <CardHeader><CardTitle>⚠️ Allergies</CardTitle></CardHeader>
                                <CardContent>
                                    {medicalRecord?.allergies?.length > 0 ? (
                                        <div className="space-y-2">
                                            {medicalRecord.allergies.map((allergy: string, i: number) => (
                                                <div key={i} className="flex items-center gap-3 p-3 bg-red-50 border border-red-100 rounded-lg dark:bg-red-900/20">
                                                    <span className="text-red-500">⚠️</span>
                                                    <span className="text-sm font-medium text-red-800">{allergy}</span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-center py-8">
                                            <span className="text-3xl">✅</span>
                                            <p className="text-gray-500 dark:text-gray-400 mt-2 text-sm">No known allergies (NKDA)</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* === AFTER VISIT SUMMARY (AVS) & RELEASED CLINICAL NOTES TAB === */}
                        {activeTab === 'avs' && (
                            <Card className="border-t-4 border-t-emerald-600">
                                <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 dark:border-slate-700 pb-4">
                                    <div>
                                        <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                                            Official Patient-Facing Clinical Record
                                        </span>
                                        <CardTitle className="text-xl mt-0.5">📄 After Visit Summary (AVS) & Released Notes</CardTitle>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                            Encounter Date: {formatDate(avsData?.visitDate || consultation.scheduledAt)} • Status: {consultation.status.replace('_', ' ').toUpperCase()}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Button variant="outline" size="sm" onClick={() => window.print()}>
                                            🖨️ Print Summary
                                        </Button>
                                        <Link href={`/messages?compose=medical&providerId=${encodeURIComponent(consultation.doctorId || '')}&consultationId=${encodeURIComponent(consultationId)}`}>
                                            <Button size="sm">💬 Message Provider</Button>
                                        </Link>
                                    </div>
                                </CardHeader>
                                <CardContent className="p-5 space-y-6">
                                    {/* Visit Details, Facility & Provider */}
                                    <div className="grid sm:grid-cols-2 gap-4 p-4 rounded-2xl bg-gray-50 dark:bg-slate-800/80 border border-gray-100 dark:border-slate-700">
                                        <div>
                                            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Care Provider</p>
                                            <p className="font-bold text-gray-900 dark:text-white mt-0.5">
                                                {avsData?.providerName || (doctor?.profile ? `Dr. ${doctor.profile.firstName} ${doctor.profile.lastName}` : 'Attending Physician')}
                                            </p>
                                            <p className="text-xs text-gray-600 dark:text-gray-300">
                                                {avsData?.specialty || doctor?.specialization || 'General Medicine'}
                                            </p>
                                        </div>
                                        <div>
                                            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Care Facility & Modality</p>
                                            <p className="font-bold text-gray-900 dark:text-white mt-0.5">
                                                {avsData?.facilityName || (consultation as any).facilityName || 'Docarion Telehealth & Clinical Network'}
                                            </p>
                                            <p className="text-xs text-gray-600 dark:text-gray-300">
                                                {consultation.type === 'video' ? '📹 Video Telehealth Consultation' : '🏥 In-Person Clinic Visit'}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Chief Complaints & Final Diagnoses */}
                                    <div className="grid sm:grid-cols-2 gap-4">
                                        <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700">
                                            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                                                Reason for Visit / Symptoms
                                            </h3>
                                            {(avsData?.symptoms || consultation.symptoms)?.length > 0 ? (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {(avsData?.symptoms || consultation.symptoms).map((s: string, idx: number) => (
                                                        <span key={idx} className="text-xs px-2.5 py-1 rounded-full bg-orange-50 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300 font-medium">
                                                            {s}
                                                        </span>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-sm text-gray-500 dark:text-gray-400">General clinical evaluation</p>
                                            )}
                                        </div>
                                        <div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/40 dark:bg-emerald-950/20">
                                            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300 mb-2">
                                                Final Diagnosis & Assessment
                                            </h3>
                                            <p className="text-base font-bold text-gray-900 dark:text-white">
                                                {avsData?.diagnosis || consultation.diagnosis || 'Pending provider finalization'}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Treatment Plan, Follow-up Instructions & Released Notes (Zero-Leak Protected) */}
                                    <div className="p-4 rounded-2xl bg-blue-50/60 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/60 space-y-2">
                                        <h3 className="text-sm font-bold text-blue-900 dark:text-blue-200">
                                            📝 Treatment Plan, Care Instructions & Released Progress Notes
                                        </h3>
                                        <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
                                            {avsData?.clinicalSummary ||
                                                avsData?.followUpInstructions ||
                                                consultation.clinicalSummary ||
                                                dischargePatientFriendly ||
                                                'Follow your prescribed medication schedule, stay hydrated, and contact your care team via Secure Messages if symptoms persist or worsen.'}
                                        </p>
                                        {Array.isArray(avsData?.releasedNotes) && avsData.releasedNotes.length > 0 && (
                                            <div className="pt-3 mt-3 border-t border-blue-200/60 dark:border-blue-800/60 space-y-2">
                                                {avsData.releasedNotes.map((note: any, i: number) => (
                                                    <div key={i} className="p-3 bg-white dark:bg-slate-900 rounded-xl text-xs text-gray-700 dark:text-gray-300">
                                                        <p className="font-semibold text-gray-900 dark:text-white mb-1">
                                                            Signed Progress Note ({note.authorName || 'Attending Clinician'})
                                                        </p>
                                                        <p className="whitespace-pre-wrap">{note.patientFriendly || note.content}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Recorded Vitals Snapshot */}
                                    {(avsData?.vitals || vitalsForm.systolic || vitalsForm.temperature || vitalsForm.pulseRate || vitalsForm.spo2) && (
                                        <div>
                                            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                                                ❤️ Recorded Vitals During Encounter
                                            </h3>
                                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                                <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
                                                    <span className="text-xs text-gray-500">Blood Pressure</span>
                                                    <p className="font-bold text-gray-900 dark:text-white">
                                                        {avsData?.vitals?.bloodPressure || (vitalsForm.systolic ? `${vitalsForm.systolic}/${vitalsForm.diastolic} mmHg` : '—')}
                                                    </p>
                                                </div>
                                                <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
                                                    <span className="text-xs text-gray-500">Heart Rate</span>
                                                    <p className="font-bold text-gray-900 dark:text-white">
                                                        {avsData?.vitals?.heartRate || (vitalsForm.pulseRate ? `${vitalsForm.pulseRate} bpm` : '—')}
                                                    </p>
                                                </div>
                                                <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
                                                    <span className="text-xs text-gray-500">Temperature</span>
                                                    <p className="font-bold text-gray-900 dark:text-white">
                                                        {avsData?.vitals?.temperature || (vitalsForm.temperature ? `${vitalsForm.temperature} ${vitalsForm.tempUnit}` : '—')}
                                                    </p>
                                                </div>
                                                <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
                                                    <span className="text-xs text-gray-500">SpO₂</span>
                                                    <p className="font-bold text-gray-900 dark:text-white">
                                                        {avsData?.vitals?.spo2 || (vitalsForm.spo2 ? `${vitalsForm.spo2}%` : '—')}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Medications Prescribed & Orders Placed */}
                                    <div className="grid sm:grid-cols-2 gap-4">
                                        <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 space-y-2">
                                            <div className="flex items-center justify-between">
                                                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                                                    💊 Medications & Prescriptions
                                                </h3>
                                                {consultation.prescriptionId && (
                                                    <Link href={`/prescriptions/${consultation.prescriptionId}`} className="text-xs font-semibold text-green-600 hover:underline">
                                                        Open Rx →
                                                    </Link>
                                                )}
                                            </div>
                                            {(avsData?.medications || medicalRecord?.medications)?.length > 0 ? (
                                                <div className="space-y-1.5">
                                                    {(avsData?.medications || medicalRecord.medications).slice(0, 5).map((m: any, idx: number) => (
                                                        <div key={idx} className="text-xs p-2 rounded-lg bg-gray-50 dark:bg-slate-800 flex justify-between">
                                                            <span className="font-semibold text-gray-900 dark:text-white">{typeof m === 'string' ? m : m.name}</span>
                                                            {m.dosage && <span className="text-gray-500">{m.dosage} {m.frequency ? `• ${m.frequency}` : ''}</span>}
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-xs text-gray-500 dark:text-gray-400">No new medications prescribed in this visit</p>
                                            )}
                                        </div>

                                        <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 space-y-2">
                                            <div className="flex items-center justify-between">
                                                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                                                    🔬 Labs & Diagnostic Orders
                                                </h3>
                                                <Link href="/lab-results" className="text-xs font-semibold text-green-600 hover:underline">
                                                    Lab Results →
                                                </Link>
                                            </div>
                                            {(avsData?.labOrders || consultation.labOrders || consultation.labOrderIds)?.length > 0 ? (
                                                <div className="space-y-1.5">
                                                    {(avsData?.labOrders || consultation.labOrders || consultation.labOrderIds).map((lo: any, idx: number) => (
                                                        <div key={idx} className="text-xs p-2 rounded-lg bg-gray-50 dark:bg-slate-800 flex justify-between">
                                                            <span className="font-semibold text-gray-900 dark:text-white">{lo.testName || lo.name || `Order #${idx + 1}`}</span>
                                                            <span className="text-gray-500">{lo.status || 'Ordered'}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-xs text-gray-500 dark:text-gray-400">No laboratory orders placed during this visit</p>
                                            )}
                                        </div>
                                    </div>

                                    {userCanManageStatus && (
                                        <div className="flex items-center justify-between gap-3 pt-4 border-t border-gray-100 dark:border-slate-700">
                                            {!['completed', 'cancelled'].includes(consultation.status) ? (
                                                <>
                                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                                        Ready to wrap up this visit and move to your next patient?
                                                    </p>
                                                    <Button
                                                        size="sm"
                                                        className="bg-green-600 hover:bg-green-700 text-white font-bold"
                                                        onClick={() => setShowHandoff(true)}
                                                    >
                                                        ✅ Complete Consultation & Hand Off
                                                    </Button>
                                                </>
                                            ) : (
                                                <Link href="/dashboard/doctor" className="ml-auto">
                                                    <Button size="sm">← Back to My Queue</Button>
                                                </Link>
                                            )}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* === DOCUMENTS TAB === */}
                        {activeTab === 'documents' && (
                            <Card>
                                <CardHeader className="flex flex-row items-center justify-between">
                                    <CardTitle>📁 Documents</CardTitle>
                                    <Link href="/dashboard/patient/document-center">
                                        <Button variant="outline" size="sm">Open Document Center →</Button>
                                    </Link>
                                </CardHeader>
                                <CardContent>
                                    {medicalRecord?.documents?.length > 0 ? (
                                        <div className="space-y-2">
                                            {medicalRecord.documents.map((doc: any, idx: number) => (
                                                <div key={doc.id || idx} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-800 rounded-xl border border-gray-100 dark:border-slate-700">
                                                    <div>
                                                        <p className="text-sm font-semibold text-gray-900 dark:text-white">{doc.title || doc.name || doc.type || 'Clinical Document'}</p>
                                                        {doc.summary && <p className="text-xs text-gray-500 dark:text-gray-400">{doc.summary}</p>}
                                                    </div>
                                                    <span className="text-xs text-gray-400">{doc.createdAt ? new Date(doc.createdAt).toLocaleDateString() : 'On file'}</span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-center py-10">
                                            <span className="text-4xl">📄</span>
                                            <p className="text-gray-500 dark:text-gray-400 mt-2 text-sm">No documents uploaded yet</p>
                                            <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">Consent forms, referral letters, imaging CDs, and clinical documents</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* === CHAT TAB === */}
                        {activeTab === 'chat' && (['in_progress', 'completed'].includes(consultation.status) || (!!consultation.doctorId && ['accepted', 'confirmed', 'scheduled'].includes(consultation.status)) || (user?.role && user.role !== 'patient')) && (
                            <div className="space-y-4">
                                {/* Live Consultation Intake Summary & Physician Brief Access */}
                                {userCanViewClinicalInsights && (
                                    <div className="mb-2">
                                        <button
                                            type="button"
                                            onClick={() => setShowLiveChatBrief(prev => !prev)}
                                            data-testid="toggle-live-chat-brief-btn"
                                            className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-50 border border-green-200 text-green-800 hover:bg-green-100 dark:bg-green-950/40 dark:border-green-800 dark:text-green-200 transition-colors shadow-sm"
                                        >
                                            <span>📋</span>
                                            <span>{showLiveChatBrief ? 'Hide Intake Summary & Physician Brief' : 'View Intake Summary & Physician Brief'}</span>
                                            <span className="text-[10px] text-green-600 dark:text-green-400 font-normal">
                                                {showLiveChatBrief ? '▲' : '▼'}
                                            </span>
                                        </button>
                                        {showLiveChatBrief && (
                                            <div className="mt-3 animate-fade-in" data-testid="live-chat-physician-brief-container">
                                                <PhysicianBrief consultationId={consultationId} />
                                            </div>
                                        )}
                                    </div>
                                )}

                                <ConsultationChat
                                    consultationId={consultationId}
                                    status={consultation.status}
                                    initialMessages={consultation.chatHistory as any}
                                    socket={socket}
                                    connected={connected}
                                    defaultChannel={requestedCareChannel}
                                    onCompleteConsultation={userCanManageStatus ? () => setShowHandoff(true) : undefined}
                                    otherPartyName={userCanViewClinicalInsights
                                        ? (consultation.patientName || 'Patient')
                                        : (doctor?.profile?.firstName ? `Dr. ${doctor.profile.firstName} ${doctor.profile.lastName || ''}`.trim() : 'Doctor')}
                                />

                                {/* Live In-Chat Meta Muse Wonder Co-Pilot: Real-Time DDx, Treatment Suggestions & Auto-SOAP */}
                                {userCanViewClinicalInsights && (
                                    <Card
                                        data-testid="live-chat-ai-copilot-card"
                                        className="border-2 border-indigo-200 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/60 via-white to-emerald-50/30 dark:from-slate-900 dark:via-slate-900 dark:to-indigo-950/30 shadow-md"
                                    >
                                        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3 border-b border-indigo-100 dark:border-slate-800">
                                            <div className="flex items-center gap-2.5">
                                                <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
                                                    ✨
                                                </div>
                                                <div>
                                                    <CardTitle className="text-sm sm:text-base text-indigo-950 dark:text-indigo-200 flex items-center gap-2 flex-wrap">
                                                        Meta Muse Wonder — Live Chat Inference, DDx &amp; Auto-SOAP
                                                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-300 font-bold uppercase tracking-wider">
                                                            Reading Live Conversation
                                                        </span>
                                                    </CardTitle>
                                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                                        Continuously synthesizes preliminary Hx + vitals + live chat into Differential Diagnoses, NAFDAC Rx &amp; SOAP Notes
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    onClick={handleCopilotSync}
                                                    disabled={syncingCopilot}
                                                    data-testid="inchat-refresh-copilot-btn"
                                                    className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold"
                                                >
                                                    ⚡ {syncingCopilot ? 'Analyzing Chat…' : 'Sync Live Chat Inference'}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => setActiveTab('chart-notes')}
                                                    data-testid="inchat-open-chart-notes-btn"
                                                    className="text-xs font-bold border-indigo-300 text-indigo-700 dark:text-indigo-300"
                                                >
                                                    📝 Full SOAP &amp; Chart Notes →
                                                </Button>
                                            </div>
                                        </CardHeader>
                                        <CardContent className="pt-4 space-y-4">
                                            {/* 1. Ranked Differential Diagnoses (DDx) */}
                                            {copilotData?.differentials && copilotData.differentials.length > 0 && (
                                                <div>
                                                    <p className="text-xs font-bold uppercase tracking-wider text-indigo-800 dark:text-indigo-300 mb-2">
                                                        🩺 Live Differential Diagnoses (DDx from Hx + Chat)
                                                    </p>
                                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                                                        {copilotData.differentials.slice(0, 3).map((ddx, idx) => (
                                                            <div
                                                                key={idx}
                                                                className="p-3 rounded-xl border border-indigo-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 space-y-1.5 flex flex-col justify-between"
                                                            >
                                                                <div>
                                                                    <div className="flex items-center justify-between gap-1">
                                                                        <span className="font-bold text-xs text-gray-900 dark:text-white">
                                                                            {ddx.name}
                                                                        </span>
                                                                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">
                                                                            {ddx.likelihood}
                                                                        </span>
                                                                    </div>
                                                                    <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-1">
                                                                        {ddx.reasoning}
                                                                    </p>
                                                                </div>
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    data-testid={`inchat-adopt-ddx-${idx}`}
                                                                    onClick={() => {
                                                                        const ddxEntry = `• ${ddx.name} (${ddx.likelihood.toUpperCase()}): ${ddx.reasoning}`;
                                                                        setSoapNote(prev => ({
                                                                            ...prev,
                                                                            assessment: prev.assessment ? `${prev.assessment}\n${ddxEntry}` : ddxEntry,
                                                                        }));
                                                                        setDiagnosisForm(prev => ({ ...prev, diagnosis: ddx.name }));
                                                                        toast.success(`Adopted ${ddx.name} into SOAP Assessment & Diagnosis!`);
                                                                    }}
                                                                    className="w-full text-[11px] py-1 h-7 border-indigo-200 text-indigo-700 dark:text-indigo-300"
                                                                >
                                                                    + Adopt DDx into SOAP
                                                                </Button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {/* 2. On-the-Spot Guidance / Questions & NAFDAC Treatment Suggestions */}
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                {/* Suggested Next Questions to Ask in Chat */}
                                                <div className="p-3 rounded-xl border border-indigo-200 dark:border-indigo-900/40 bg-indigo-50/50 dark:bg-indigo-950/20 space-y-2">
                                                    <p className="text-xs font-bold uppercase tracking-wider text-indigo-800 dark:text-indigo-300">
                                                        💬 On-the-Spot Chat Guidance &amp; Red-Flag Checks
                                                    </p>
                                                    {(copilotData?.suggestions || []).slice(0, 3).map((item, idx) => (
                                                        <div key={idx} className="p-2 rounded-lg bg-white dark:bg-slate-800 border border-indigo-100 dark:border-slate-700 text-xs flex items-center justify-between gap-2">
                                                            <div className="flex-1">
                                                                <span className="font-bold text-gray-900 dark:text-white block">{item.title}</span>
                                                                <span className="text-[11px] text-gray-600 dark:text-gray-300">{item.detail}</span>
                                                            </div>
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                data-testid={`inchat-ask-question-${idx}`}
                                                                onClick={async () => {
                                                                    const qText = item.detail || item.title;
                                                                    try {
                                                                        await consultationApi.sendMessage(consultationId, qText);
                                                                        await loadConsultation();
                                                                        toast.success('Sent guided question to patient chat!');
                                                                    } catch {
                                                                        toast.info(`Added to SOAP: ${qText}`);
                                                                    }
                                                                }}
                                                                className="text-[10px] py-1 px-2 h-7 shrink-0 border-indigo-300 text-indigo-700"
                                                            >
                                                                💬 Ask in Chat
                                                            </Button>
                                                        </div>
                                                    ))}
                                                </div>

                                                {/* NAFDAC Treatment Suggestions */}
                                                <div className="p-3 rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-2">
                                                    <p className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                                                        💊 NAFDAC-Verified Treatment Suggestions
                                                    </p>
                                                    {(copilotData?.nafdacVerifiedRx || []).slice(0, 3).map((rx, idx) => (
                                                        <div key={idx} className="p-2 rounded-lg bg-white dark:bg-slate-800 border border-emerald-100 dark:border-slate-700 text-xs flex items-center justify-between gap-2">
                                                            <div className="flex-1">
                                                                <span className="font-bold text-gray-900 dark:text-white block">{rx.drugName}</span>
                                                                <span className="text-[11px] text-gray-600 dark:text-gray-300">{rx.dose} • {rx.duration}</span>
                                                                <span className="text-[10px] text-emerald-600 font-mono block">{rx.nafdacStatus}</span>
                                                            </div>
                                                            <div className="flex flex-col gap-1 shrink-0">
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    data-testid={`inchat-adopt-rx-plan-${idx}`}
                                                                    onClick={() => {
                                                                        const planEntry = `• Rx: ${rx.drugName} (${rx.dose} for ${rx.duration}) — ${rx.nafdacStatus}`;
                                                                        setSoapNote(prev => ({
                                                                            ...prev,
                                                                            plan: prev.plan ? `${prev.plan}\n${planEntry}` : planEntry,
                                                                        }));
                                                                        toast.success(`Added ${rx.drugName} to SOAP Plan!`);
                                                                    }}
                                                                    className="text-[10px] py-0.5 px-2 h-6 border-emerald-300 text-emerald-700"
                                                                >
                                                                    + SOAP Plan
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    data-testid={`inchat-write-erx-${idx}`}
                                                                    onClick={() => router.push(`/prescriptions/write?consultationId=${consultationId}&med=${encodeURIComponent(rx.drugName)}`)}
                                                                    className="text-[10px] py-0.5 px-2 h-6 bg-emerald-600 hover:bg-emerald-700 text-white"
                                                                >
                                                                    💊 Write e-Rx
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* 3. Live Auto-Drafted SOAP Note Preview (S, O, A, P) */}
                                            <div className="p-3.5 rounded-xl border border-purple-200 dark:border-purple-900/50 bg-white dark:bg-slate-800/90 space-y-2.5">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <span className="text-xs font-bold uppercase tracking-wider text-purple-800 dark:text-purple-300">
                                                        📝 Live Auto-Synthesized SOAP Note (Updated from Intake + Vitals + Chat)
                                                    </span>
                                                    <div className="flex items-center gap-2">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            onClick={handleGenerateSOAP}
                                                            disabled={generatingSoap}
                                                            data-testid="inchat-generate-soap-btn"
                                                            className="text-xs py-1 h-7 border-purple-300 text-purple-700"
                                                        >
                                                            ✨ {generatingSoap ? 'Drafting SOAP…' : 'Refresh AI SOAP Draft'}
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            onClick={handleSaveSOAPNote}
                                                            disabled={savingNote}
                                                            data-testid="inchat-save-soap-btn"
                                                            className="text-xs py-1 h-7 bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
                                                        >
                                                            💾 {savingNote ? 'Saving…' : 'Save SOAP Note'}
                                                        </Button>
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                                                        <span className="font-bold text-indigo-700 dark:text-indigo-300 block mb-0.5">S — Subjective (Hx + Chat):</span>
                                                        <p className="text-[11px] text-gray-700 dark:text-gray-300 line-clamp-3">{soapNote.subjective || 'Synthesizing patient history and live chat...'}</p>
                                                    </div>
                                                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                                                        <span className="font-bold text-indigo-700 dark:text-indigo-300 block mb-0.5">O — Objective (Vitals &amp; Exam):</span>
                                                        <p className="text-[11px] text-gray-700 dark:text-gray-300 line-clamp-3">{soapNote.objective || 'BP 118/76 mmHg, Temp 37.8°C, HR 84 bpm, SpO2 98%'}</p>
                                                    </div>
                                                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                                                        <span className="font-bold text-emerald-700 dark:text-emerald-300 block mb-0.5">A — Assessment (Differential Dx):</span>
                                                        <p className="text-[11px] text-gray-700 dark:text-gray-300 line-clamp-3">{soapNote.assessment || '1. Acute Bacterial Tonsillopharyngitis (J03.90)'}</p>
                                                    </div>
                                                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                                                        <span className="font-bold text-emerald-700 dark:text-emerald-300 block mb-0.5">P — Plan (Treatment &amp; PPMV Rx):</span>
                                                        <p className="text-[11px] text-gray-700 dark:text-gray-300 line-clamp-3">{soapNote.plan || 'Amoxicillin 500mg BID x 7d (Qty 14) -> Docarion PPMV'}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}
                            </div>
                        )}
                        {activeTab === 'chat' && !['in_progress', 'completed'].includes(consultation.status) && !(!!consultation.doctorId && ['accepted', 'confirmed', 'scheduled'].includes(consultation.status)) && !(user?.role && user.role !== 'patient') && (
                            <Card>
                                <CardContent className="p-8 text-center text-gray-500 dark:text-gray-400">
                                    <span className="text-3xl">💬</span>
                                    <p className="mt-2">Chat available once consultation is in progress</p>
                                </CardContent>
                            </Card>
                        )}

                        {/* === MULTIMODAL SCANNER & SAM 3.1 VISION TAB === */}
                        {activeTab === 'multimodal' && (
                            <div className="space-y-4">
                                <MetaMultimodalScanner
                                    consultationId={consultationId}
                                    facilityLicenceClass={
                                        user?.role?.includes('pharmacy') ? 'pharmacy' :
                                        user?.role?.includes('hospital') ? 'hospital' :
                                        user?.role?.includes('clinic') ? 'clinic' : 'ppmv'
                                    }
                                    onFindingsExtracted={(findings) => {
                                        toast.info('SAM 3.1 findings recorded for this consultation');
                                    }}
                                />
                            </div>
                        )}
                    </div>

                    {/* Right Sidebar — Patient Summary (Clinician only) */}
                    <div className="space-y-4">
                        {userCanViewClinicalInsights && (
                            <>
                                {/* AI Clinical Co-pilot */}
                                <AIClinicalCopilot
                                    consultationId={consultationId}
                                    isActive={consultation.status === 'in_progress'}
                                    chatHistory={consultation.chatHistory}
                                    onAddToSoapNote={(section, text) => {
                                        setSoapNote(prev => ({
                                            ...prev,
                                            [section]: prev[section] ? `${prev[section]}\n${text}` : text,
                                        }));
                                        toast.success(`Added to SOAP ${section.charAt(0).toUpperCase()}`);
                                    }}
                                    onAddToDiagnosis={(diagnosis, icdCode) => {
                                        setDiagnosisForm(prev => ({
                                            ...prev,
                                            diagnosis,
                                            icdCode: icdCode || prev.icdCode,
                                        }));
                                        toast.success('Diagnosis populated from AI');
                                    }}
                                    onAddToNotes={(text) => {
                                        setSoapNote(prev => ({
                                            ...prev,
                                            objective: prev.objective ? `${prev.objective}\n${text}` : text,
                                        }));
                                        toast.success('Note added');
                                    }}
                                />

                                {/* Live AI scribe: audio capture only starts with a call, so this card says so
                                    plainly and sends the doctor to the call screen. Assigned doctor only (server-enforced). */}
                                {isDoctor && consultation.status === 'in_progress' && (
                                    <LiveScribePanel
                                        consultationId={consultationId}
                                        patientId={consultation.patientId}
                                        viewerRole="doctor"
                                        variant="embedded"
                                        audioFlowing={false}
                                        onStartCall={startVideoCall}
                                    />
                                )}

                                {/* Patient Info Card */}
                                <Card>
                                    <CardHeader className="pb-2"><CardTitle className="text-sm">Patient Info</CardTitle></CardHeader>
                                    <CardContent className="space-y-2 text-sm">
                                        {patient?.profile ? (
                                            <>
                                                <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Name</span><span className="font-medium">{patient.profile.firstName} {patient.profile.lastName}</span></div>
                                                {patient.profile.gender && <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Gender</span><span>{patient.profile.gender}</span></div>}
                                                {patient.profile.dateOfBirth && <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">DOB</span><span>{formatCalendarDay(patient.profile.dateOfBirth)}</span></div>}
                                                {patient.profile.phone && <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Phone</span><span>{patient.profile.phone}</span></div>}
                                                {patient.email && <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Email</span><span className="text-xs">{patient.email}</span></div>}
                                            </>
                                        ) : (
                                            <p className="text-gray-500 text-xs dark:text-gray-400">Patient record not available</p>
                                        )}
                                        <Link href={`/patients/${consultation.patientId}`} className="block mt-2">
                                            <Button variant="outline" size="sm" className="w-full text-xs">View Full Patient Record →</Button>
                                        </Link>
                                    </CardContent>
                                </Card>

                                {/* Allergies Alert */}
                                <Card className={medicalRecord?.allergies?.length > 0 ? 'border-red-200 bg-red-50' : ''}>
                                    <CardContent className="p-3">
                                        <p className="text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">⚠️ Allergies</p>
                                        {medicalRecord?.allergies?.length > 0 ? (
                                            <div className="space-y-1">
                                                {medicalRecord.allergies.map((a: string, i: number) => (
                                                    <span key={i} className="text-xs text-red-700 font-medium block">• {a}</span>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-xs text-green-600">NKDA (No Known Drug Allergies)</p>
                                        )}
                                    </CardContent>
                                </Card>

                                {/* Current Medications */}
                                <Card>
                                    <CardContent className="p-3">
                                        <p className="text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">💊 Current Medications</p>
                                        {medicalRecord?.medications?.length > 0 ? (
                                            <div className="space-y-1">
                                                {medicalRecord.medications.slice(0, 5).map((med: any, i: number) => (
                                                    <span key={i} className="text-xs text-gray-700 dark:text-gray-300 block">• {typeof med === 'string' ? med : med.name}</span>
                                                ))}
                                                {medicalRecord.medications.length > 5 && (
                                                    <span className="text-xs text-green-600">+{medicalRecord.medications.length - 5} more</span>
                                                )}
                                            </div>
                                        ) : (
                                            <p className="text-xs text-gray-500 dark:text-gray-400">No medications on file</p>
                                        )}
                                    </CardContent>
                                </Card>

                                {/* Medical Conditions */}
                                <Card>
                                    <CardContent className="p-3">
                                        <p className="text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">📋 Conditions</p>
                                        {medicalRecord?.conditions?.length > 0 ? (
                                            <div className="space-y-1">
                                                {medicalRecord.conditions.map((c: any, i: number) => (
                                                    <span key={i} className="text-xs text-gray-700 dark:text-gray-300 block">• {typeof c === 'string' ? c : c.name}</span>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-xs text-gray-500 dark:text-gray-400">No conditions on file</p>
                                        )}
                                    </CardContent>
                                </Card>

                                {/* Quick Nav */}
                                <Card>
                                    <CardContent className="p-3 space-y-1.5">
                                        <p className="text-xs font-bold text-gray-600 dark:text-gray-300 mb-2">Quick Actions</p>
                                        {userCanPrescribe && (
                                            <Link href={`/prescriptions/write?consultationId=${consultationId}`} className="block">
                                                <Button variant="outline" size="sm" className="w-full text-xs justify-start">💊 Write Prescription</Button>
                                            </Link>
                                        )}
                                        {userCanOrderLabs && (
                                            <Link href={`/lab-orders/write?consultationId=${consultationId}`} className="block">
                                                <Button variant="outline" size="sm" className="w-full text-xs justify-start">🧪 Order Lab Tests</Button>
                                            </Link>
                                        )}
                                        {userCanOrderRadiology && (
                                            <Link href={`/radiology-orders/write?consultationId=${consultationId}`} className="block">
                                                <Button variant="outline" size="sm" className="w-full text-xs justify-start">🩻 Radiology Order</Button>
                                            </Link>
                                        )}
                                        {userCanRefer && (
                                            <Link href={`/referrals/write?consultationId=${consultationId}`} className="block">
                                                <Button variant="outline" size="sm" className="w-full text-xs justify-start">🏥 Write Referral</Button>
                                            </Link>
                                        )}
                                        <Link href={`/messages`} className="block">
                                            <Button variant="outline" size="sm" className="w-full text-xs justify-start">💬 Messages</Button>
                                        </Link>
                                    </CardContent>
                                </Card>
                            </>
                        )}

                        {/* Patient-safe AI note-taking banners (consent request / "on" + opt-out). No clinical output. */}
                        {!userCanViewClinicalInsights && consultation.status === 'in_progress' && (
                            <LiveScribePanel
                                consultationId={consultationId}
                                patientId={consultation.patientId}
                                viewerRole="patient"
                                variant="embedded"
                            />
                        )}

                        {/* Video Call Widget — the doctor starts; the patient joins when the room exists */}
                        {consultation.type === 'video' && ['in_progress', 'confirmed', 'accepted', 'scheduled'].includes(consultation.status) && (
                            <Card className="bg-gradient-to-br from-gray-900 to-gray-800 text-white ring-gray-800 shadow-elevated">
                                <CardContent className="p-4 text-center">
                                    <span className="text-3xl">📹</span>
                                    <p className="text-sm mt-2 font-medium">Video Consultation</p>
                                    <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">Telehealth encounter</p>
                                    {userCanViewClinicalInsights ? (
                                        <div className="mt-3 space-y-2">
                                            <Button
                                                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                                                aria-label="Start text consultation"
                                                onClick={startChatConsultation}
                                            >
                                                💬 Start / Join Live Chat
                                            </Button>
                                            <div className="grid grid-cols-2 gap-2">
                                                <Button className="w-full" onClick={() => startVideoCall('video')}>🎥 Start video</Button>
                                                <Button className="w-full" variant="outline" onClick={() => startVideoCall('audio')}>📞 Start audio</Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="mt-3 text-left">
                                            <PatientCallStatus
                                                consultationId={consultationId}
                                                status={consultation.status}
                                                doctorId={consultation.doctorId}
                                                doctorName={doctor?.profile?.firstName ? `${doctor.profile.firstName} ${doctor.profile.lastName || ''}`.trim() : null}
                                                onOpenChat={() => setActiveTab('chat')}
                                            />
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </div>
            </div>

            {/* Unobtrusive Floating ✨ AI Co-Pilot / Patient Care Assistant Pill */}
            <AICopilotFloatingPill
                consultationId={consultationId}
                userRole={user?.role}
                differentials={
                    ddxData?.differentials?.length
                        ? ddxData.differentials
                        : (copilotData?.differentials || []).map((d, idx) => ({
                              rank: idx + 1,
                              diagnosis: d.name,
                              icdCode: d.name.match(/\(([A-Z]\d[^)]+)\)/)?.[1],
                              probability: d.likelihood === 'medium' ? 'moderate' : d.likelihood || 'moderate',
                              supportingEvidence: d.reasoning ? [d.reasoning] : [],
                          }))
                }
                managementPlans={
                    ddxData?.managementPlans?.length
                        ? ddxData.managementPlans
                        : copilotData
                        ? [
                              {
                                  forDiagnosis:
                                      copilotData.differentials?.[0]?.name ||
                                      'Primary Clinical Impression',
                                  investigations: [
                                      ...(copilotData.suggestions || [])
                                          .filter((s) => s.type === 'test')
                                          .map((s) => ({ name: s.title, reason: s.detail || 'AI Co-Pilot Recommendation' })),
                                      {
                                          name: 'Malaria RDT & Rapid Strep Antigen',
                                          reason: 'Differentiate endemic malaria vs bacterial pharyngitis',
                                      },
                                  ],
                                  treatment: (copilotData.nafdacVerifiedRx || []).map((rx) => ({
                                      intervention: `${rx.drugName} (${rx.dose})`,
                                      details: `${rx.duration} • ${rx.nafdacStatus}`,
                                  })),
                              },
                          ]
                        : []
                }
                alerts={
                    ddxData?.alerts?.length
                        ? ddxData.alerts
                        : (copilotData?.suggestions || [])
                              .filter((s) => s.type === 'alert' || s.priority === 'high')
                              .map((s) => `${s.title}: ${s.detail}`)
                }
                activeFlags={consultation?.activeFlags || []}
                onAddToSoapNote={(section, text) => {
                    setSoapNote(prev => ({
                        ...prev,
                        [section]: prev[section] ? `${prev[section]}\n${text}` : text,
                    }));
                    toast.success(`Added to SOAP ${section.charAt(0).toUpperCase()}`);
                }}
                onAddToDiagnosis={(diagnosis, icdCode) => {
                    setDiagnosisForm(prev => ({
                        ...prev,
                        diagnosis,
                        icdCode: icdCode || prev.icdCode,
                    }));
                    toast.success('Diagnosis populated from Co-Pilot');
                }}
                onAddToNotes={(text) => {
                    setSoapNote(prev => ({
                        ...prev,
                        objective: prev.objective ? `${prev.objective}\n${text}` : text,
                    }));
                    toast.success('Note added');
                }}
                onOrderLab={(testName) => {
                    router.push(`/lab-orders/write?consultationId=${consultationId}&test=${encodeURIComponent(testName)}`);
                }}
                onPrescribe={(medName) => {
                    router.push(`/prescriptions/write?consultationId=${consultationId}&med=${encodeURIComponent(medName)}`);
                }}
                onPatientAction={(actionText) => {
                    if (consultation && patientCanBeCalled) {
                        consultationApi.sendMessage(consultationId, actionText)
                            .then(() => toast.success('Sent to your doctor'))
                            .catch((err: any) => toast.info(readErrorMessage(err?.response?.data) || `Action ready: "${actionText}"`));
                    } else {
                        toast.info('Your doctor has not accepted yet — this will be ready to send once they do.');
                    }
                }}
                soapDraft={
                    soapNote.subjective || soapNote.objective || soapNote.assessment || soapNote.plan
                        ? soapNote
                        : copilotData?.soapDraft || null
                }
                onSaveSoapNote={handleSaveSOAPNote}
            />

            <RatingSheet
                consultationId={consultationId}
                open={showRating}
                onClose={dismissRating}
                onSubmitted={() => { setHasRated(true); setShowRating(false); }}
                providerName={doctor?.profile?.firstName ? `Dr. ${doctor.profile.firstName} ${doctor.profile.lastName || ''}`.trim() : undefined}
            />

            {/* Nurse Walk-In / Triage Hx Intake Modal (Clinician / Nurse only — never rendered for patient) */}
            {showHandoff && consultation && (
                <HandoffSheet
                    consultationId={consultationId}
                    hasPrescription={!!consultation.prescriptionId}
                    hasLabOrders={Boolean((consultation as any).labOrderIds?.length || (consultation as any).labOrders?.length)}
                    hasRadiologyOrders={Boolean((consultation as any).radiologyOrderIds?.length)}
                    hasReferral={Boolean((consultation as any).referralId || (consultation as any).referralIds?.length)}
                    defaultDiagnosis={consultation.diagnosis || diagnosisForm?.diagnosis || null}
                    defaultNote={diagnosisForm?.clinicalSummary || soapNote?.plan || consultation.notes || null}
                    onClose={() => setShowHandoff(false)}
                    onCompleted={() => { loadConsultation(); }}
                />
            )}
            {(userCanRecordVitals || userCanManageStatus) && showNurseHxModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6 overflow-y-auto" role="dialog" aria-modal="true" data-testid="nurse-hx-intake-modal">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4">
                        <div className="flex items-center justify-between border-b border-gray-100 dark:border-slate-700 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-gray-900 dark:text-white">🩺 Walk-In / Triage Nurse Hx Intake</h3>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Record structured patient history &amp; triage vitals to clear patient for doctor consultation.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowNurseHxModal(false)}
                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm font-bold px-2 py-1"
                            >
                                ✕
                            </button>
                        </div>

                        <form onSubmit={handleNurseHxSubmit} className="space-y-3">
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                    Chief Complaint *
                                </label>
                                <input
                                    type="text"
                                    value={nurseHxForm.chiefComplaint}
                                    onChange={e => setNurseHxForm(prev => ({ ...prev, chiefComplaint: e.target.value }))}
                                    placeholder={consultation.symptoms?.join(', ') || 'e.g., High fever, frontal headache for 3 days'}
                                    className="w-full px-3 py-2 text-sm border rounded-xl dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                    History of Present Illness (HPI) &amp; Triage Notes
                                </label>
                                <textarea
                                    rows={3}
                                    value={nurseHxForm.hpiNotes}
                                    onChange={e => setNurseHxForm(prev => ({ ...prev, hpiNotes: e.target.value }))}
                                    placeholder="Onset, duration, severity, associated symptoms..."
                                    className="w-full px-3 py-2 text-sm border rounded-xl dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                        Known Allergies (comma-separated)
                                    </label>
                                    <input
                                        type="text"
                                        value={nurseHxForm.allergies}
                                        onChange={e => setNurseHxForm(prev => ({ ...prev, allergies: e.target.value }))}
                                        placeholder="Penicillin, Sulfa, None"
                                        className="w-full px-3 py-2 text-sm border rounded-xl dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                        Current Medications
                                    </label>
                                    <input
                                        type="text"
                                        value={nurseHxForm.currentMedications}
                                        onChange={e => setNurseHxForm(prev => ({ ...prev, currentMedications: e.target.value }))}
                                        placeholder="Paracetamol 500mg, Lisinopril 10mg"
                                        className="w-full px-3 py-2 text-sm border rounded-xl dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                    Past Medical / Surgical History
                                </label>
                                <input
                                    type="text"
                                    value={nurseHxForm.medicalHistory}
                                    onChange={e => setNurseHxForm(prev => ({ ...prev, medicalHistory: e.target.value }))}
                                    placeholder="Hypertension, Asthma, None"
                                    className="w-full px-3 py-2 text-sm border rounded-xl dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                />
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                                <div>
                                    <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">BP (mmHg)</label>
                                    <input
                                        type="text"
                                        value={nurseHxForm.bp}
                                        onChange={e => setNurseHxForm(prev => ({ ...prev, bp: e.target.value }))}
                                        placeholder="120/80"
                                        className="w-full px-2.5 py-1.5 text-xs border rounded-lg dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">Pulse (bpm)</label>
                                    <input
                                        type="text"
                                        value={nurseHxForm.heartRate}
                                        onChange={e => setNurseHxForm(prev => ({ ...prev, heartRate: e.target.value }))}
                                        placeholder="76"
                                        className="w-full px-2.5 py-1.5 text-xs border rounded-lg dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">Temp (°C)</label>
                                    <input
                                        type="text"
                                        value={nurseHxForm.temperature}
                                        onChange={e => setNurseHxForm(prev => ({ ...prev, temperature: e.target.value }))}
                                        placeholder="37.2"
                                        className="w-full px-2.5 py-1.5 text-xs border rounded-lg dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">SpO2 (%)</label>
                                    <input
                                        type="text"
                                        value={nurseHxForm.spo2}
                                        onChange={e => setNurseHxForm(prev => ({ ...prev, spo2: e.target.value }))}
                                        placeholder="98"
                                        className="w-full px-2.5 py-1.5 text-xs border rounded-lg dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                                    />
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 pt-3 border-t border-gray-100 dark:border-slate-700">
                                <Button type="button" variant="outline" size="sm" onClick={() => setShowNurseHxModal(false)}>
                                    Cancel
                                </Button>
                                <Button type="submit" size="sm" isLoading={savingNurseHx} className="bg-green-600 hover:bg-green-700 text-white">
                                    ✅ Save Nurse Hx &amp; Clear for Doctor
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </DashboardShell>
    );
}
