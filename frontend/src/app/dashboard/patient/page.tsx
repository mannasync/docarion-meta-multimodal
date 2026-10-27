'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth.store';
import { RoleNavDrawer } from '@/components/layout/RoleNavDrawer';
import { withRoleGuard } from '@/components/shared/withRoleGuard';
import {
  patientApi,
  doctorApi,
  schedulingApi,
  walletApi,
  aiIntakeApi,
  aiPrefillApi,
  authApi,
} from '@/services/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/LoadingStates';
import { ErrorState } from '@/components/ui/ErrorState';
import { NotificationBell } from '@/components/shared/NotificationBell';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import BottomNav from '@/components/BottomNav';
import { toast } from 'react-toastify';
import {
  User,
  MessageSquare,
  Pill,
  Beaker,
  Calendar,
  Clock,
  CreditCard,
  ChevronRight,
  Activity,
  Zap,
  FileText,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Building2,
  MapPin,
  Gift,
  Stethoscope,
  Settings,
  Star,
  Globe,
  Link2,
  Share2,
  HeartPulse,
  Sparkles,
  Check,
  RefreshCw,
} from 'lucide-react';
import { ComplianceBadges } from '@/components/ui/TrustBadge';
import { BrandLogoMark } from '@/components/ui/BrandLogo';
import {
  PatientFacilityContextBar,
  getStoredActiveFacilityId,
  type LinkedFacilityItem,
} from '@/components/patient/PatientFacilityContextBar';
import { AICopilotDrawer } from './components/AICopilotDrawer';
import { BookingDrawer } from './components/BookingDrawer';
import { QuickChatWidget } from './components/QuickChatWidget';
import { RecordPreviewModal } from './components/RecordPreviewModal';
import { ClinicalProfile } from '@/components/patient/ClinicalProfile';
import { parseDateValue } from '@/lib/calendarDate';

// Lazy-loaded feature components (explicit loading UI so tabs never sit blank)
const FeatureTabLoading = () => (
  <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500 dark:text-gray-400" role="status">
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" aria-hidden="true" />
    Loading…
  </div>
);
const FamilyManager = dynamic(() => import('@/components/patient/FamilyManager'), {
  ssr: false,
  loading: FeatureTabLoading,
});
const MedicationReminders = dynamic(() => import('@/components/patient/MedicationReminders'), {
  ssr: false,
  loading: FeatureTabLoading,
});
const VitalsTrend = dynamic(() => import('@/components/patient/VitalsTrend'), {
  ssr: false,
  loading: FeatureTabLoading,
});
const LabBooking = dynamic(() => import('@/components/patient/LabBooking'), {
  ssr: false,
  loading: FeatureTabLoading,
});
const DeliveryTracker = dynamic(() => import('@/components/patient/DeliveryTracker'), {
  ssr: false,
  loading: FeatureTabLoading,
});
const MetaMultimodalScanner = dynamic(
  () => import('@/components/ai/MetaMultimodalScanner').then((m) => m.MetaMultimodalScanner),
  { ssr: false, loading: FeatureTabLoading }
);

interface Consultation {
  consultationId: string;
  doctorId: string;
  doctorName?: string;
  facilityId?: string;
  facilityName?: string;
  type: string;
  status: string;
  scheduledAt: string;
  specialtyName?: string;
  symptoms?: string[];
}

interface CareTeamMember {
  providerId: string;
  userId?: string;
  name: string;
  specialty?: string;
  facilityId?: string;
  facilityName?: string;
  isPrimary?: boolean;
  isPrimaryCareProvider?: boolean;
  hiddenOnHome?: boolean;
  isOnline?: boolean;
  visitCount?: number;
  lastVisitAt?: string;
  profile?: { firstName?: string; lastName?: string };
  specialization?: string;
}

interface Appointment {
  appointmentId: string;
  doctorName?: string;
  facilityId?: string;
  facilityName?: string;
  date: string;
  startTime: string;
  endTime: string;
  type: 'video' | 'in_person' | 'chat';
  status: string;
  specialtyName?: string;
}

interface ShortcutItem {
  id: string;
  label: string;
  href: string;
  icon: string;
  badgeColor?: string;
}

const ALL_SHORTCUT_CATALOG: ShortcutItem[] = [
  { id: 'visits', label: 'Visits & Appointments', href: '/consultations', icon: '📅' },
  { id: 'test-results', label: 'Test Results', href: '/lab-results', icon: '🧪' },
  { id: 'medications', label: 'Medications & Refills', href: '/prescriptions', icon: '💊' },
  { id: 'messages', label: 'Messages', href: '/messages', icon: '💬' },
  { id: 'health-summary', label: 'Health Summary', href: '/dashboard/patient/health-summary', icon: '❤️‍🩹' },
  { id: 'preventive-care', label: 'Preventive Care', href: '/dashboard/patient/preventive-care', icon: '🛡️' },
  { id: 'book-care', label: 'Schedule Appointment', href: '/consultations/new', icon: '➕' },
  { id: 'symptom-checker', label: 'Symptom Checker', href: '/symptom-checker', icon: '🩺' },
  { id: 'care-journeys', label: 'To Do & Care Journeys', href: '/dashboard/patient/care-journeys', icon: '🗺️' },
  { id: 'track-vitals', label: 'Track My Health', href: '/patient-vitals', icon: '📈' },
  { id: 'document-center', label: 'Document Center', href: '/dashboard/patient/document-center', icon: '📂' },
  { id: 'billing', label: 'Billing & Estimates', href: '/wallet', icon: '💳' },
  { id: 'link-accounts', label: 'Link My Accounts', href: '/dashboard/patient/facilities', icon: '🏥' },
  { id: 'share-everywhere', label: 'Share Everywhere', href: '/dashboard/patient/access', icon: '🔗' },
  { id: 'eyeglass-rx', label: 'Eyeglass Rx', href: '/dashboard/patient/eyeglass-prescriptions', icon: '👓' },
];

const DEFAULT_SHORTCUT_IDS = [
  'visits',
  'test-results',
  'medications',
  'messages',
  'health-summary',
  'preventive-care',
];

const getGreeting = (): string => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
};

// Timeline Item Interface for Unified Feed
interface TimelineItem {
  id: string;
  type: 'appointment' | 'consultation' | 'lab' | 'prescription';
  date: Date;
  title: string;
  subtitle: string;
  status: string;
  icon: React.ReactNode;
  actionUrl?: string;
  actionText?: string;
}

function PatientDashboard() {
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const [activeFacilityId, setActiveFacilityId] = useState<string>('all');
  const [linkedFacilities, setLinkedFacilities] = useState<LinkedFacilityItem[]>([]);
  const [stats, setStats] = useState({ consultations: 0, prescriptions: 0, labResults: 0, upcoming: 0 });
  const [careTeam, setCareTeam] = useState<CareTeamMember[]>([]);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [prescriptions, setPrescriptions] = useState<any[]>([]);
  const [labs, setLabs] = useState<any[]>([]);
  const [healthFeedItems, setHealthFeedItems] = useState<any[]>([]);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);

  // Customizable 6 Hero Shortcuts
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>(() =>
    ALL_SHORTCUT_CATALOG.filter((s) => DEFAULT_SHORTCUT_IDS.includes(s.id))
  );
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [selectedShortcutIds, setSelectedShortcutIds] = useState<string[]>(DEFAULT_SHORTCUT_IDS);
  const [savingShortcuts, setSavingShortcuts] = useState(false);
  const [refillingId, setRefillingId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingIntake, setPendingIntake] = useState<{ consultationId: string; specialtyName?: string } | null>(null);

  // Vitals State
  const [showVitalsModal, setShowVitalsModal] = useState(false);
  const [vitalsForm, setVitalsForm] = useState({
    systolic: '',
    diastolic: '',
    heartRate: '',
    temperature: '',
    oxygenSaturation: '',
  });
  const [latestVitals, setLatestVitals] = useState<any>(null);
  const [aiText, setAiText] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  const handlePrefill = async () => {
    if (!aiText.trim()) return;
    setAiLoading(true);
    try {
      const res = await aiPrefillApi.parseText({ text: aiText, type: 'vitals' });
      const data = res.data?.data;
      if (data) {
        setVitalsForm((prev) => ({
          ...prev,
          systolic: data.systolicBP?.toString() || data.systolic?.toString() || prev.systolic,
          diastolic: data.diastolicBP?.toString() || data.diastolic?.toString() || prev.diastolic,
          heartRate: data.heartRate?.toString() || prev.heartRate,
          temperature: data.temperature?.toString() || prev.temperature,
          oxygenSaturation: data.oxygenSaturation?.toString() || prev.oxygenSaturation,
        }));
        toast.success('AI pre-filled successfully');
      }
    } catch {
      toast.error('AI pre-fill failed');
    } finally {
      setAiLoading(false);
    }
  };

  // AI Copilot State
  const [copilotQuery, setCopilotQuery] = useState('');

  // Modals/Drawers State
  const [aiCopilotOpen, setAiCopilotOpen] = useState(false);
  const [aiCopilotMode, setAiCopilotMode] = useState<'triage' | 'intake'>('triage');
  const [bookingOpen, setBookingOpen] = useState(false);
  const [kycStatus, setKycStatus] = useState<string | null>(null);
  const [quickChatDoc, setQuickChatDoc] = useState<{ id: string; name: string } | null>(null);

  const handleBookClick = () => {
    if (stats.consultations >= 1 && kycStatus !== 'verified' && kycStatus !== 'successful') {
      toast.warning('KYC verification is required to book subsequent consultations.');
      router.push('/dashboard/patient/kyc');
      return;
    }
    setBookingOpen(true);
  };
  const [previewRecord, setPreviewRecord] = useState<{
    type: 'prescription' | 'lab' | 'consultation' | 'appointment';
    id: string;
    data: any;
  } | null>(null);

  // Feature Tabs State
  type FeatureTab = 'ai-scanner' | 'family' | 'medications' | 'vitals' | 'labs' | 'delivery';
  const [activeFeatureTab, setActiveFeatureTab] = useState<FeatureTab | null>(null);

  const FEATURE_TABS: { id: FeatureTab; label: string; icon: string }[] = [
    { id: 'ai-scanner', label: 'Meta AI Scanner (NAFDAC & SAM 3.1)', icon: '🔬' },
    { id: 'family', label: 'My Family', icon: '👨‍👩‍👧‍👦' },
    { id: 'medications', label: 'Medications', icon: '💊' },
    { id: 'vitals', label: 'Vitals', icon: '📈' },
    { id: 'labs', label: 'Lab Tests', icon: '🧪' },
    { id: 'delivery', label: 'Delivery', icon: '📦' },
  ];

  // Preventive Care State
  const [wellnessCheck, setWellnessCheck] = useState<any>(null);
  const [immunizationCheck, setImmunizationCheck] = useState<any>(null);
  const [refillSuggestions, setRefillSuggestions] = useState<any[] | null>(null);
  const [preventiveError, setPreventiveError] = useState<string | null>(null);
  const [immunizationError, setImmunizationError] = useState(false);
  const [refillError, setRefillError] = useState<string | null>(null);

  useEffect(() => {
    setActiveFacilityId(getStoredActiveFacilityId());
  }, []);

  const loadDashboardData = useCallback(async (facilityFilter?: string) => {
    const effectiveFacility = facilityFilter ?? getStoredActiveFacilityId();
    setLoading(true);
    setLoadError(null);
    try {
      const facilityParam = effectiveFacility && effectiveFacility !== 'all' ? { facilityId: effectiveFacility } : undefined;
      const [
        consultRes,
        prescRes,
        labRes,
        careTeamRes,
        doctorsFallbackRes,
        meRes,
        feedRes,
        shortcutsRes,
        linkedFacRes,
      ] = await Promise.allSettled([
        patientApi.getConsultations(),
        patientApi.getPrescriptions(),
        patientApi.getLabResults(),
        patientApi.getCareTeam(facilityParam),
        doctorApi.getAll({ limit: 6 }),
        authApi.me(),
        patientApi.getHealthFeed(facilityParam),
        patientApi.getShortcuts(),
        patientApi.getLinkedFacilities(),
      ]);

      const allConsultations: Consultation[] =
        consultRes.status === 'fulfilled' ? consultRes.value.data?.data || [] : [];
      const freshUser = meRes.status === 'fulfilled' ? meRes.value.data?.data : null;
      if (freshUser) {
        setKycStatus(freshUser.kycStatus || null);
      }
      const allPrescriptions = prescRes.status === 'fulfilled' ? prescRes.value.data?.data || [] : [];
      const allLabs = labRes.status === 'fulfilled' ? labRes.value.data?.data || [] : [];

      // Filter by active facility when a specific facility is chosen
      const loadedConsultations =
        effectiveFacility && effectiveFacility !== 'all'
          ? allConsultations.filter((c: any) => !c.facilityId || c.facilityId === effectiveFacility)
          : allConsultations;
      const loadedPrescriptions =
        effectiveFacility && effectiveFacility !== 'all'
          ? allPrescriptions.filter((p: any) => !p.facilityId || p.facilityId === effectiveFacility)
          : allPrescriptions;
      const loadedLabs =
        effectiveFacility && effectiveFacility !== 'all'
          ? allLabs.filter((l: any) => !l.facilityId || l.facilityId === effectiveFacility)
          : allLabs;

      // Care Team resolution: prefer patientApi.getCareTeam(), fallback to doctorApi.getAll()
      let resolvedCareTeam: CareTeamMember[] = [];
      if (careTeamRes.status === 'fulfilled') {
        const rawTeam = careTeamRes.value.data?.data ?? careTeamRes.value.data;
        const list = Array.isArray(rawTeam)
          ? rawTeam
          : Array.isArray(rawTeam?.providers)
          ? rawTeam.providers
          : Array.isArray(rawTeam?.careTeam)
          ? rawTeam.careTeam
          : [];
        resolvedCareTeam = list
          .filter((p: any) => !p.hiddenOnHome)
          .map((p: any) => ({
            providerId: p.providerId || p.doctorId || p.userId || p.id,
            userId: p.userId || p.providerId || p.doctorId || p.id,
            name:
              p.name ||
              p.doctorName ||
              `Dr. ${p.profile?.firstName || p.firstName || ''} ${p.profile?.lastName || p.lastName || ''}`.trim(),
            specialty: p.specialty || p.specialization || 'General Practice',
            facilityId: p.facilityId,
            facilityName: p.facilityName || p.practiceName,
            isPrimary: Boolean(p.isPrimary || p.isPrimaryCareProvider || p.role === 'PCP'),
            isOnline: p.isOnline,
            visitCount: p.visitCount,
            lastVisitAt: p.lastVisitAt,
            profile: p.profile,
          }));
      }
      if (resolvedCareTeam.length === 0 && doctorsFallbackRes.status === 'fulfilled') {
        const fallbackList = doctorsFallbackRes.value.data?.data || [];
        resolvedCareTeam = fallbackList.map((d: any) => ({
          providerId: d.userId || d.id,
          userId: d.userId || d.id,
          name: `Dr. ${d.profile?.lastName || d.profile?.firstName || 'Physician'}`,
          specialty: d.specialization || 'General Practice',
          facilityName: d.facilityName || 'Docarion Network',
          isPrimary: false,
          isOnline: d.isOnline,
          profile: d.profile,
        }));
      }
      setCareTeam(resolvedCareTeam);

      if (feedRes.status === 'fulfilled') {
        const rawFeed = feedRes.value.data?.data ?? feedRes.value.data;
        const feedArr = Array.isArray(rawFeed)
          ? rawFeed
          : Array.isArray(rawFeed?.items)
          ? rawFeed.items
          : Array.isArray(rawFeed?.updates)
          ? rawFeed.updates
          : [];
        setHealthFeedItems(feedArr);
      }

      if (shortcutsRes.status === 'fulfilled') {
        const rawSc = shortcutsRes.value.data?.data ?? shortcutsRes.value.data;
        const scList = Array.isArray(rawSc) ? rawSc : rawSc?.shortcuts;
        if (Array.isArray(scList) && scList.length > 0) {
          const resolved: ShortcutItem[] = scList
            .map((item: any) => {
              if (typeof item === 'string') {
                return ALL_SHORTCUT_CATALOG.find((c) => c.id === item);
              }
              return (
                ALL_SHORTCUT_CATALOG.find((c) => c.id === item.id || c.href === item.href) || {
                  id: item.id || item.href,
                  label: item.label || 'Shortcut',
                  href: item.href || '/dashboard/patient',
                  icon: item.icon || '⚡',
                }
              );
            })
            .filter(Boolean) as ShortcutItem[];
          if (resolved.length > 0) {
            setShortcuts(resolved.slice(0, 6));
            setSelectedShortcutIds(resolved.slice(0, 6).map((s) => s.id));
          }
        }
      }

      if (linkedFacRes.status === 'fulfilled') {
        const rawFac = linkedFacRes.value.data?.data ?? linkedFacRes.value.data ?? {};
        const facList: LinkedFacilityItem[] = Array.isArray(rawFac)
          ? rawFac
          : Array.isArray(rawFac.facilities)
          ? rawFac.facilities
          : Array.isArray(rawFac.linkedFacilities)
          ? rawFac.linkedFacilities
          : [];
        setLinkedFacilities(facList);
      }

      const upcoming = loadedConsultations.filter(
        (c: Consultation) => ['pending', 'confirmed'].includes(c.status) && new Date(c.scheduledAt) > new Date()
      ).length;

      setStats({
        consultations: loadedConsultations.length,
        prescriptions: loadedPrescriptions.length,
        labResults: loadedLabs.length,
        upcoming,
      });

      setConsultations(loadedConsultations);
      setPrescriptions(loadedPrescriptions);
      setLabs(loadedLabs);

      // Fetch actual latest vitals for the dashboard
      try {
        const vitalsRes = await patientApi.getVitalsHistory(1);
        const vitalsData = vitalsRes.data?.data;
        if (vitalsData && vitalsData.length > 0) {
          setLatestVitals(vitalsData[0]);
        } else {
          setLatestVitals(null);
        }
      } catch {
        setLatestVitals(null);
      }

      // Fetch Preventive Care
      Promise.allSettled([patientApi.getPreventiveWellness(), patientApi.getPreventiveImmunizations()]).then(
        ([wellRes, immRes]) => {
          let wellnessFailed = false;
          let immunizationFailed = false;

          if (wellRes.status === 'fulfilled') {
            const wellnessData = wellRes.value.data?.data;
            if (wellnessData && wellnessData.screenings && !Array.isArray(wellnessData.screenings)) {
              wellnessFailed = true;
            } else {
              setWellnessCheck(wellnessData || null);
            }
          } else {
            wellnessFailed = true;
          }

          if (immRes.status === 'fulfilled') {
            const immData = immRes.value.data?.data;
            if (immData && immData.catchUpSchedule && !Array.isArray(immData.catchUpSchedule)) {
              immunizationFailed = true;
            } else {
              setImmunizationCheck(immData || null);
            }
          } else {
            immunizationFailed = true;
          }

          setPreventiveError(wellnessFailed ? 'Error loading preventive care' : null);
          setImmunizationError(immunizationFailed);
        }
      );

      // Fetch Refill Suggestions
      patientApi
        .getRefillSuggestions()
        .then((res) => {
          const refillData = res.data?.data;
          if (refillData && !Array.isArray(refillData)) {
            setRefillError('Error loading refills');
          } else {
            setRefillSuggestions(refillData || []);
            setRefillError(null);
          }
        })
        .catch(() => {
          setRefillError('Error loading refills');
        });

      // Check for incomplete intakes
      const pendingConsults = loadedConsultations.filter((c: Consultation) =>
        ['pending', 'confirmed'].includes(c.status)
      );
      for (const c of pendingConsults) {
        try {
          const statusRes = await aiIntakeApi.getStatus(c.consultationId);
          if (statusRes.data?.data && !statusRes.data.data.isComplete) {
            setPendingIntake({ consultationId: c.consultationId, specialtyName: c.specialtyName });
            break;
          }
        } catch {
          setPendingIntake({ consultationId: c.consultationId, specialtyName: c.specialtyName });
          break;
        }
      }

      Promise.allSettled([schedulingApi.getAppointments({ status: 'confirmed' }), walletApi.getBalance()]).then(
        ([apptRes, walletRes]) => {
          if (apptRes.status === 'fulfilled') setAppointments(apptRes.value.data?.data || []);
          if (walletRes.status === 'fulfilled') setWalletBalance(walletRes.value.data?.data?.balance ?? null);
        }
      );
    } catch {
      setLoadError("We couldn't load your health portal. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  // Listen to both family-profile-changed and docarion-facility-changed events
  useEffect(() => {
    const handleProfileOrFacilityChange = (e: Event) => {
      const custom = e as CustomEvent;
      const nextFacilityId = custom.detail?.facilityId || getStoredActiveFacilityId();
      setActiveFacilityId(nextFacilityId);
      loadDashboardData(nextFacilityId);
    };
    window.addEventListener('family-profile-changed', handleProfileOrFacilityChange);
    window.addEventListener('docarion-facility-changed', handleProfileOrFacilityChange);
    return () => {
      window.removeEventListener('family-profile-changed', handleProfileOrFacilityChange);
      window.removeEventListener('docarion-facility-changed', handleProfileOrFacilityChange);
    };
  }, [loadDashboardData]);

  const handleSaveShortcuts = async () => {
    if (selectedShortcutIds.length === 0) {
      toast.warning('Please select at least 1 shortcut');
      return;
    }
    setSavingShortcuts(true);
    const chosen = ALL_SHORTCUT_CATALOG.filter((s) => selectedShortcutIds.includes(s.id)).slice(0, 6);
    try {
      await patientApi.updateShortcuts(chosen);
      setShortcuts(chosen);
      setShowShortcutsModal(false);
      toast.success('Homepage shortcuts updated');
    } catch {
      // Persist locally even if backend is offline
      setShortcuts(chosen);
      setShowShortcutsModal(false);
      toast.success('Homepage shortcuts updated');
    } finally {
      setSavingShortcuts(false);
    }
  };

  const handleRequestRefill = async (item: any) => {
    const prescId = item.prescriptionId || item.id || prescriptions[0]?.prescriptionId;
    if (!prescId) {
      router.push('/prescriptions');
      return;
    }
    setRefillingId(prescId);
    try {
      await patientApi.requestRefill(prescId, {
        notes: `Refill requested for ${item.medication || item.name || 'medication'} from Patient Home`,
      });
      toast.success(`Refill request sent for ${item.medication || item.name || 'medication'}`);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error ||
          'We could not send your refill request. Please try again or contact your pharmacy.'
      );
    } finally {
      setRefillingId(null);
    }
  };

  const submitVitals = async () => {
    if (!vitalsForm.systolic && !vitalsForm.heartRate && !vitalsForm.temperature) {
      toast.error('Please enter at least one vital reading');
      return;
    }
    try {
      const data: any = { recordedAt: new Date() };
      if (vitalsForm.systolic && vitalsForm.diastolic)
        data.bloodPressure = { systolic: +vitalsForm.systolic, diastolic: +vitalsForm.diastolic };
      if (vitalsForm.heartRate) data.heartRate = +vitalsForm.heartRate;
      if (vitalsForm.temperature) data.temperature = +vitalsForm.temperature;
      if (vitalsForm.oxygenSaturation) data.oxygenSaturation = +vitalsForm.oxygenSaturation;

      await patientApi.addVitals(data);
      setLatestVitals(data);
      toast.success('Vitals recorded successfully');
      setShowVitalsModal(false);
      setVitalsForm({ systolic: '', diastolic: '', heartRate: '', temperature: '', oxygenSaturation: '' });
    } catch {
      toast.error('Failed to record vitals');
    }
  };

  const parseDate = (val: any): Date => {
    if (!val) return new Date();
    if (val._seconds) return new Date(val._seconds * 1000);
    if (val.seconds) return new Date(val.seconds * 1000);
    // A bare 'YYYY-MM-DD' is a calendar date in any zone.
    return parseDateValue(val);
  };

  // Actionable "Your Updates" Health Feed (MyChart style)
  const actionableUpdates = useMemo(() => {
    const updates: Array<{
      id: string;
      category: 'visit' | 'result' | 'refill' | 'wellness' | 'feed';
      badge: string;
      badgeCls: string;
      title: string;
      subtitle: string;
      primaryHref?: string;
      primaryLabel: string;
      onPrimaryClick?: () => void;
    }> = [];

    // 1. Server health-feed items
    healthFeedItems.slice(0, 4).forEach((f, idx) => {
      updates.push({
        id: f.id || `feed-${idx}`,
        category: 'feed',
        badge: f.type ? String(f.type).toUpperCase() : 'HEALTH UPDATE',
        badgeCls: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
        title: f.title || f.summary || 'New Health Update',
        subtitle: f.description || f.subtitle || f.facilityName || 'Docarion Central',
        primaryHref: f.actionUrl || f.href || '/dashboard/patient/health-summary',
        primaryLabel: f.actionLabel || 'View Update',
      });
    });

    // 2. Preventive Wellness Check Screenings (previously unused state!)
    const screenings = Array.isArray(wellnessCheck?.screenings)
      ? wellnessCheck.screenings
      : Array.isArray(wellnessCheck?.recommendations)
      ? wellnessCheck.recommendations
      : [];
    screenings.slice(0, 2).forEach((sc: any, idx: number) => {
      updates.push({
        id: `well-${idx}`,
        category: 'wellness',
        badge: sc.status === 'overdue' ? 'OVERDUE CARE' : 'PREVENTIVE CARE',
        badgeCls:
          sc.status === 'overdue'
            ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
        title: sc.name || sc.title || 'Recommended Health Screening',
        subtitle: sc.reason || sc.frequency || sc.description || 'Due based on your age & clinical profile',
        primaryHref: '/dashboard/patient/preventive-care',
        primaryLabel: 'Review & Schedule',
      });
    });

    // 3. New / Recent Lab Results
    labs.slice(0, 2).forEach((l: any) => {
      const labId = l.resultId || l.orderId || l.id;
      updates.push({
        id: `upd-lab-${labId}`,
        category: 'result',
        badge: l.abnormal || l.isAbnormal ? 'ABNORMAL RESULT' : 'TEST RESULT',
        badgeCls:
          l.abnormal || l.isAbnormal
            ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
            : 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
        title: `Lab Result: ${l.testName || l.tests?.map((t: any) => t.name || t).join(', ') || 'Diagnostic Panel'}`,
        subtitle: `${l.facilityName || 'Diagnostic Laboratory'} · ${
          l.providerComment ? 'Includes Doctor Note' : 'Ready to view'
        }`,
        primaryHref: `/lab-results/${labId}`,
        primaryLabel: 'View Result & Range',
      });
    });

    // 4. Medication Refill Alerts
    (refillSuggestions || []).slice(0, 2).forEach((r: any, idx: number) => {
      updates.push({
        id: `upd-refill-${idx}`,
        category: 'refill',
        badge: 'MEDICATION REFILL',
        badgeCls: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
        title: `${r.medication || r.name || 'Prescription'} due for refill`,
        subtitle: `Remaining supply: ${r.remainingDays ?? r.daysRemaining ?? 5} days`,
        primaryLabel: 'Request Refill',
        onPrimaryClick: () => handleRequestRefill(r),
      });
    });

    return updates.slice(0, 6);
  }, [healthFeedItems, wellnessCheck, labs, refillSuggestions]);

  // Build Unified Timeline
  const unifiedTimeline = useMemo(() => {
    const items: TimelineItem[] = [];

    appointments.forEach((a) => {
      const d = new Date(`${a.date}T${a.startTime}`);
      items.push({
        id: `appt-${a.appointmentId}`,
        type: 'appointment',
        date: d,
        title: `Appointment with ${a.doctorName || 'Doctor'}`,
        subtitle: `${a.type === 'video' ? 'Video' : 'In-person'} · ${a.specialtyName || 'General'}`,
        status: a.status,
        icon: <Calendar className="w-5 h-5" />,
        actionUrl: d > new Date() ? `/consultations/${a.appointmentId}/video` : undefined,
        actionText: d > new Date() && a.type === 'video' ? 'Join Call' : undefined,
      });
    });

    consultations.forEach((c) => {
      if (!appointments.some((a) => a.appointmentId === c.consultationId)) {
        items.push({
          id: `cons-${c.consultationId}`,
          type: 'consultation',
          date: parseDate(c.scheduledAt),
          title: c.specialtyName || 'Consultation Request',
          subtitle: c.symptoms ? `Symptoms: ${c.symptoms.join(', ')}` : 'Awaiting review',
          status: c.status,
          icon: <MessageSquare className="w-5 h-5" />,
          actionUrl: `/consultations/${c.consultationId}`,
          actionText: 'View Details',
        });
      }
    });

    prescriptions.forEach((p) => {
      items.push({
        id: `presc-${p.prescriptionId}`,
        type: 'prescription',
        date: parseDate(p.issuedAt || p.createdAt),
        title: `Prescription Issued`,
        subtitle: `${p.medications?.length || 0} medication(s)`,
        status: p.status || 'active',
        icon: <Pill className="w-5 h-5" />,
        actionUrl: `/prescriptions/${p.prescriptionId}`,
        actionText: 'View Details',
      });
    });

    labs.forEach((l) => {
      items.push({
        id: `lab-${l.orderId || l.id}`,
        type: 'lab',
        date: parseDate(l.orderedAt || l.createdAt),
        title: `Lab Order: ${l.tests?.map((t: any) => t.name).join(', ') || 'Tests'}`,
        subtitle: l.facilityName || 'Laboratory',
        status: l.status || 'pending',
        icon: <Beaker className="w-5 h-5" />,
        actionUrl: `/lab-results/${l.orderId || l.id}`,
        actionText: l.status === 'completed' ? 'View Results' : undefined,
      });
    });

    return items.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 10);
  }, [appointments, consultations, prescriptions, labs]);

  // Role guard
  if (user?.role && user.role !== 'patient') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div className="text-center p-8">
          <span className="text-5xl block mb-4">🔒</span>
          <p className="text-gray-500 mb-4 dark:text-gray-400">This dashboard is for patients only</p>
          <button
            onClick={() => (window.location.href = '/dashboard')}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            ← Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <PageLoading message="Loading your health portal..." />;

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] dark:bg-slate-900 pb-20 font-sans">
        <div className="max-w-lg mx-auto px-4 py-16">
          <ErrorState title="Could not load your dashboard" message={loadError} onRetry={() => loadDashboardData()} />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-slate-950 pb-20 font-sans">
      {/* HERO SECTION: AI Copilot, 6 Customizable Shortcuts & Glassmorphism */}
      <div className="relative bg-gradient-to-br from-green-600 to-emerald-700 dark:from-green-800 dark:to-emerald-900 pb-12 pt-6 px-4 sm:px-6 lg:px-8">
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none" aria-hidden="true">
          <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-white/10 blur-3xl"></div>
          <div className="absolute top-32 -left-24 w-72 h-72 rounded-full bg-emerald-300/20 blur-3xl"></div>
        </div>

        <div className="relative max-w-5xl mx-auto">
          {/* Top Nav Area */}
          <div className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-3">
              <BrandLogoMark className="w-10 h-10 rounded-xl shadow-md" />
              <div>
                <span className="text-white font-semibold tracking-wide block leading-tight">Docarion MyChart</span>
                <span className="text-white/80 text-[11px] block">Unified Multi-Facility Patient Portal</span>
              </div>
            </div>
            <div className="flex items-center gap-3 sm:gap-4">
              {walletBalance !== null && (
                <Link
                  href="/wallet"
                  className="flex items-center gap-2 bg-white/10 backdrop-blur border border-white/20 rounded-full px-4 py-1.5 hover:bg-white/20 transition cursor-pointer"
                >
                  <CreditCard className="w-4 h-4 text-white" />
                  <span className="text-white text-sm font-medium">₦{walletBalance.toLocaleString()}</span>
                </Link>
              )}
              <RoleNavDrawer className="text-white hover:bg-white/20" />
              <NotificationBell />
              <ThemeToggle className="text-white hover:bg-white/20" />
              <button
                onClick={logout}
                aria-label="Sign out"
                className="flex items-center gap-2 rounded-full bg-white/10 backdrop-blur border border-white/20 px-3 py-2 hover:bg-white/20 transition text-white text-sm font-medium"
              >
                <User className="w-4 h-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </div>

          {/* Multi-Tenant Facility & Family Proxy Context Bar */}
          <div className="mb-6">
            <PatientFacilityContextBar
              activeFacilityId={activeFacilityId}
              onFacilityChange={(facId) => setActiveFacilityId(facId)}
            />
          </div>

          {/* Greeting */}
          <div className="mb-6">
            <h1 className="text-3xl sm:text-5xl font-light text-white tracking-tight">
              Your Health, <span className="font-semibold">At Your Fingertips</span>
            </h1>
            <p className="text-white/95 mt-2 text-base sm:text-lg">
              {getGreeting()}, {user?.profile?.firstName || 'Patient'} — manage appointments, records, and prescriptions
              across all your linked healthcare organizations.
            </p>
          </div>

          {/* MYCHART 6 CUSTOMIZABLE HERO SHORTCUTS BAR */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-xs font-bold uppercase tracking-wider text-white/90 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> Quick Shortcuts
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedShortcutIds(shortcuts.map((s) => s.id));
                  setShowShortcutsModal(true);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/95 hover:text-white bg-white/15 hover:bg-white/25 border border-white/20 px-3 py-1 rounded-full transition"
              >
                <Settings className="w-3.5 h-3.5" />
                Change Shortcuts
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5">
              {shortcuts.slice(0, 6).map((sc) => (
                <Link
                  key={sc.id}
                  href={sc.href}
                  className="group flex flex-col items-center justify-center p-3 rounded-2xl bg-white/15 hover:bg-white/25 backdrop-blur-md border border-white/20 text-white text-center transition-all hover:-translate-y-0.5 shadow-sm"
                >
                  <span className="text-2xl mb-1.5 group-hover:scale-110 transition-transform" aria-hidden="true">
                    {sc.icon}
                  </span>
                  <span className="text-xs font-semibold leading-snug line-clamp-1">{sc.label}</span>
                </Link>
              ))}
            </div>
          </div>

          {/* AI COPILOT SEARCH BLOCK */}
          <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-2 shadow-2xl">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-0 sm:relative">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Zap className="h-6 w-6 text-white animate-pulse" />
                </div>
                <input
                  type="text"
                  value={copilotQuery}
                  onChange={(e) => setCopilotQuery(e.target.value)}
                  placeholder="Describe a symptom, request a refill, or ask a health question..."
                  className="w-full bg-transparent border-none text-white placeholder-white/80 pl-14 pr-4 sm:pr-32 py-5 text-lg focus:ring-0 focus:outline-none"
                />
              </div>
              <div className="px-2 pb-2 sm:p-0 sm:absolute sm:inset-y-0 sm:right-2 flex items-center">
                <Button
                  onClick={() => {
                    setAiCopilotMode('triage');
                    setAiCopilotOpen(true);
                  }}
                  className="w-full sm:w-auto bg-white text-green-700 hover:bg-green-50 rounded-xl px-6 py-4 h-auto font-semibold shadow-elevated dark:bg-slate-800 dark:text-green-300"
                >
                  Ask AI Copilot
                </Button>
              </div>
            </div>

            {/* Contextual Prompts */}
            <div className="flex flex-wrap gap-2 px-4 pb-3 pt-2">
              <span className="text-xs text-white/90 uppercase tracking-wider font-semibold mr-2 self-center">
                Suggestions:
              </span>
              {[
                '"I have a severe headache"',
                '"Abeg my body dey hot & mouth bitter"',
                '"Refill Amoxicillin"',
                '"Schedule general checkup"',
              ].map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => setCopilotQuery(prompt.replace(/"/g, ''))}
                  className="text-xs text-white bg-white/15 hover:bg-white/25 border border-white/20 rounded-full px-3 py-1.5 transition"
                >
                  {prompt}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setActiveFeatureTab('ai-scanner')}
                className="text-xs font-semibold text-emerald-950 bg-emerald-300 hover:bg-emerald-200 border border-emerald-200 rounded-full px-3.5 py-1.5 transition shadow-sm"
              >
                🔬 Verify NAFDAC Drug &amp; Scan Lab/Wound (Meta SAM 3.1)
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 -mt-6 relative z-10 space-y-8">
        {/* KYC Pending Banner */}
        {kycStatus !== 'verified' && kycStatus !== 'successful' && (
          <div className="bg-amber-50 rounded-2xl p-5 shadow-card border border-amber-100 hover:shadow-card-hover flex items-center justify-between group hover:border-amber-300 transition-colors dark:bg-amber-900/20">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center rotate-3 group-hover:rotate-6 transition-transform shrink-0 dark:bg-amber-900/30">
                <AlertCircle className="w-6 h-6 text-amber-600 animate-pulse" />
              </div>
              <div>
                <h3 className="text-amber-900 dark:text-amber-200 font-bold">
                  Action Required: KYC Verification Pending
                </h3>
                <p className="text-amber-700/80 dark:text-amber-300/80 text-sm mt-0.5">
                  Please verify your NIN number to enable booking of future consultations.
                </p>
              </div>
            </div>
            <Link href="/dashboard/patient/kyc">
              <Button className="bg-amber-500 hover:bg-amber-600 text-white rounded-xl shadow-md shrink-0">
                Verify Identity <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
        )}

        {/* Pending Intake Banner */}
        {pendingIntake && (
          <div
            onClick={() => {
              setAiCopilotMode('intake');
              setAiCopilotOpen(true);
            }}
            className="bg-white rounded-2xl p-5 shadow-card border border-amber-100 hover:shadow-card-hover flex items-center justify-between group hover:border-amber-300 transition-colors cursor-pointer dark:bg-slate-800"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center rotate-3 group-hover:rotate-6 transition-transform dark:bg-amber-900/30">
                <Activity className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <h3 className="text-amber-900 dark:text-amber-200 font-bold">Action Required: Complete AI Intake</h3>
                <p className="text-amber-700/80 dark:text-amber-300/80 text-sm mt-0.5">
                  Your doctor needs this information before your {pendingIntake.specialtyName || 'upcoming'}{' '}
                  consultation.
                </p>
              </div>
            </div>
            <Button className="bg-amber-500 hover:bg-amber-600 text-white rounded-xl shadow-md">
              Resume Intake <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        )}

        {/* ═══ Quick Access Feature Tabs ═══ */}
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
          {FEATURE_TABS.map((tab) => (
            <button
              key={tab.id}
              id={`feature-tab-${tab.id}-btn`}
              onClick={() => setActiveFeatureTab((prev) => (prev === tab.id ? null : tab.id))}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold transition-all duration-200 border whitespace-nowrap shrink-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 ${
                activeFeatureTab === tab.id
                  ? 'bg-green-600 text-white border-green-600 shadow-glow-primary'
                  : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-200 border-gray-200 dark:border-slate-700 shadow-soft hover:border-green-300 hover:text-green-700 hover:bg-green-50'
              }`}
            >
              <span className="text-base" role="img" aria-hidden="true">
                {tab.icon}
              </span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeFeatureTab && (
          <div className="bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-6 animate-fade-in-up dark:bg-slate-800">
            {activeFeatureTab === 'ai-scanner' && (
              <MetaMultimodalScanner
                facilityLicenceClass="patient_self_check"
                onEscalateToDoctor={() => {
                  toast.info('Opening Doctor Consultation Booking for e-Prescription review…');
                  router.push('/consultations/new');
                }}
              />
            )}
            {activeFeatureTab === 'family' && <FamilyManager />}
            {activeFeatureTab === 'medications' && <MedicationReminders />}
            {activeFeatureTab === 'vitals' && <VitalsTrend />}
            {activeFeatureTab === 'labs' && <LabBooking />}
            {activeFeatureTab === 'delivery' && <DeliveryTracker />}
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main Column: Your Updates Actionable Feed + Health Timeline */}
          <div className="lg:col-span-2 space-y-6">
            {/* MYCHART "YOUR UPDATES" ACTIONABLE HEALTH FEED */}
            <div className="bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-6 dark:bg-slate-800">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-bold tracking-tight text-gray-900 dark:text-white flex items-center gap-2">
                    <HeartPulse className="w-5 h-5 text-emerald-600" />
                    Your Updates & Recommended Actions
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Due preventive screenings, lab result alerts, and prescription refills
                  </p>
                </div>
                <Link
                  href="/dashboard/patient/care-journeys"
                  className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
                >
                  To Do & Journeys <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </div>

              {preventiveError && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">{preventiveError}</p>
              )}

              {actionableUpdates.length === 0 ? (
                <div className="rounded-xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50 p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">
                        You&apos;re all caught up on health updates!
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        View your Health Summary or Preventive Care schedule anytime.
                      </p>
                    </div>
                  </div>
                  <Link href="/dashboard/patient/health-summary">
                    <Button size="sm" variant="outline" className="rounded-xl text-xs">
                      Health Summary
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-3">
                  {actionableUpdates.map((upd) => (
                    <div
                      key={upd.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-slate-100 dark:border-slate-700 hover:border-emerald-200 dark:hover:border-emerald-800 bg-slate-50/50 dark:bg-slate-800/60 transition"
                    >
                      <div className="min-w-0">
                        <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${upd.badgeCls}`}>
                          {upd.badge}
                        </span>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white mt-1 truncate">{upd.title}</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{upd.subtitle}</p>
                      </div>
                      <div className="shrink-0">
                        {upd.onPrimaryClick ? (
                          <Button
                            size="sm"
                            onClick={upd.onPrimaryClick}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs"
                          >
                            {upd.primaryLabel}
                          </Button>
                        ) : (
                          <Link href={upd.primaryHref || '/dashboard/patient/health-summary'}>
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-xl text-xs border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
                            >
                              {upd.primaryLabel} <ChevronRight className="w-3.5 h-3.5 ml-1" />
                            </Button>
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold tracking-tight text-gray-900 dark:text-white">Your Health Timeline</h2>
              <button
                onClick={() => (window.location.href = '/medical-records')}
                className="px-4 py-2 text-base inline-flex items-center justify-center font-medium rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed text-green-700 hover:text-green-800 hover:bg-green-50"
              >
                View Full History
              </button>
            </div>

            <div className="bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-6 relative dark:bg-slate-800">
              {unifiedTimeline.length > 0 ? (
                <div className="relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-200 before:to-transparent">
                  {unifiedTimeline.map((item, idx) => (
                    <div
                      key={item.id}
                      className={`relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active ${
                        idx !== unifiedTimeline.length - 1 ? 'mb-8' : ''
                      }`}
                    >
                      <div className="flex items-center justify-center w-10 h-10 rounded-full border-4 border-white bg-slate-100 text-slate-500 shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10 transition-transform group-hover:scale-110 dark:bg-slate-700">
                        {item.icon}
                      </div>

                      <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] bg-white p-4 rounded-2xl ring-1 ring-gray-100 shadow-card hover:shadow-card-hover transition-shadow dark:bg-slate-800">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-gray-400">
                            {item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                              item.status === 'confirmed' || item.status === 'completed'
                                ? 'bg-emerald-50 text-emerald-600'
                                : item.status === 'pending'
                                ? 'bg-amber-50 text-amber-600'
                                : 'bg-slate-50 text-slate-600'
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>
                        <h3 className="text-sm font-bold text-slate-800 dark:text-gray-100">{item.title}</h3>
                        <p className="text-xs text-slate-500 mt-1 line-clamp-2 dark:text-gray-400">{item.subtitle}</p>

                        {item.actionUrl && item.actionText && (
                          <div className="mt-3 pt-3 border-t border-slate-50">
                            {item.type === 'appointment' ? (
                              <Link
                                href={item.actionUrl}
                                className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex items-center"
                              >
                                {item.actionText} <ChevronRight className="w-3 h-3 ml-0.5" />
                              </Link>
                            ) : (
                              <button
                                onClick={() => {
                                  let data: any = null;
                                  const realId = item.id.replace(/^[^-]+-/, '');
                                  if (item.type === 'prescription')
                                    data = prescriptions.find((p) => p.prescriptionId === realId);
                                  if (item.type === 'lab')
                                    data = labs.find((l) => (l.orderId || l.id) === realId);
                                  if (item.type === 'consultation')
                                    data = consultations.find((c) => c.consultationId === realId);
                                  setPreviewRecord({ type: item.type as any, id: realId, data });
                                }}
                                className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex items-center"
                              >
                                {item.actionText} <ChevronRight className="w-3 h-3 ml-0.5" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4 dark:bg-slate-800">
                    <Activity className="w-8 h-8 text-slate-300 dark:text-gray-600" />
                  </div>
                  <h3 className="text-lg font-medium text-slate-900 dark:text-white">No activity yet</h3>
                  <p className="text-slate-500 text-sm mt-1 max-w-sm mx-auto dark:text-gray-400">
                    Your health journey starts here. Book a consultation or chat with our AI Copilot to get started.
                  </p>
                </div>
              )}
            </div>

            {/* Destination Cards Grid */}
            <div className="grid sm:grid-cols-2 gap-4">
              <Link
                href="/facilities/nearby"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-green-900/30">
                      <MapPin className="w-5 h-5 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">Facilities Near You</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        Find clinics, hospitals & pharmacies nearby
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-green-500 shrink-0" />
                </div>
              </Link>

              <Link
                href="/telehealth/queue-status"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-blue-900/30">
                      <Clock className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">Your Place in Line</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        Live queue position, wait time & SLA
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-blue-500 shrink-0" />
                </div>
              </Link>

              <Link
                href="/settings/whatsapp"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-emerald-900/30">
                      <MessageSquare className="w-5 h-5 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">Connect WhatsApp</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">Continue your care over WhatsApp</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-emerald-500 shrink-0" />
                </div>
              </Link>

              <Link
                href="/dashboard/patient/monitoring"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-rose-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-rose-900/30">
                      <Activity className="w-5 h-5 text-rose-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">My Monitoring</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        Record readings & track your health trends
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-rose-500 shrink-0" />
                </div>
              </Link>

              <Link
                href="/dashboard/patient/my-doctors"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-teal-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-teal-900/30">
                      <Stethoscope className="w-5 h-5 text-teal-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">My doctors</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        Practices you joined — change or withdraw their access any time
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-teal-500 shrink-0" />
                </div>
              </Link>

              <Link
                href="/dashboard/patient/access"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-indigo-900/30">
                      <ShieldCheck className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">Who can see my records</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        See who has access, revoke shares, withdraw approvals
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-indigo-500 shrink-0" />
                </div>
              </Link>

              <Link
                href="/dashboard/patient/invite"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-emerald-900/30">
                      <Gift className="w-5 h-5 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">Invite & Earn</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        Share your code — you both earn after their first visit
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-emerald-500 shrink-0" />
                </div>
              </Link>

              <Link
                href="/dashboard/patient/health-summary"
                className="block bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 hover:shadow-card-hover transition-shadow duration-300 group dark:bg-slate-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-cyan-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-cyan-900/30">
                      <HeartPulse className="w-5 h-5 text-cyan-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 dark:text-white">Health Summary</p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">
                        Conditions, allergies, immunizations & health goals
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-cyan-500 shrink-0" />
                </div>
              </Link>
            </div>
          </div>

          {/* Right Column: Vitals, Care Team, Linked Accounts (Docarion Central), Refills, Document Vault */}
          <div className="space-y-6">
            {/* Clinical AI Profile (Vitals, Vaccines, Screenings) */}
            {(user?.profile as any)?.dateOfBirth ? (
              <ClinicalProfile
                demographics={{
                  dob: (user?.profile as any).dateOfBirth,
                  gender: (user?.profile as any)?.gender || 'unknown',
                }}
                latestVitals={latestVitals}
                immunizationAssessment={immunizationCheck}
                immunizationError={immunizationError}
              />
            ) : (
              <Card className="border-amber-200 bg-amber-50 dark:bg-amber-900/20">
                <CardContent className="p-6 text-center">
                  <User className="w-8 h-8 mx-auto text-amber-600 mb-2" />
                  <p className="font-semibold text-amber-900 dark:text-amber-200">Date of birth not recorded</p>
                  <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                    Add your verified date of birth before age-based screening or vaccination guidance is shown.
                  </p>
                  <Link href="/profile">
                    <Button size="sm" variant="outline" className="mt-4 border-amber-300 text-amber-800">
                      Update profile
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 rounded-xl border-rose-200 text-rose-700 hover:bg-rose-50"
                onClick={() => setShowVitalsModal(true)}
              >
                Record vitals
              </Button>
              <Link href="/patient-vitals">
                <Button type="button" variant="outline" className="rounded-xl border-rose-200 text-rose-700 hover:bg-rose-50">
                  View all vitals
                </Button>
              </Link>
            </div>

            {/* Refill Suggestions */}
            <div className="bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 dark:bg-slate-800">
              <div className="flex items-center justify-between mb-4 border-b border-slate-50 dark:border-slate-700 pb-3">
                <div className="flex items-center gap-2">
                  <Pill className="w-5 h-5 text-indigo-600" />
                  <h2 className="font-bold tracking-tight text-gray-900 dark:text-white">Refill Suggestions</h2>
                </div>
                <Link href="/prescriptions" className="text-xs font-semibold text-indigo-600 hover:underline">
                  All Meds
                </Link>
              </div>
              <div className="space-y-3">
                {refillError ? (
                  <div className="text-center py-6">
                    <p className="text-sm text-red-500 font-semibold">{refillError}</p>
                  </div>
                ) : !refillSuggestions || refillSuggestions.length === 0 ? (
                  <div className="text-center py-6">
                    <p className="text-sm text-slate-500 dark:text-gray-400">No refill suggestions</p>
                  </div>
                ) : (
                  refillSuggestions.map((item: any, i: number) => (
                    <div
                      key={`refill-${i}`}
                      className="flex items-center justify-between p-2 hover:bg-slate-50 dark:hover:bg-slate-700/40 rounded-xl transition"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center shrink-0 dark:bg-indigo-900/20">
                          <Pill className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-800 dark:text-gray-100">
                            {item.medication || item.name}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-gray-400">
                            Remaining: {item.remainingDays ?? item.daysRemaining ?? '--'} days
                          </p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        disabled={refillingId === (item.prescriptionId || item.id)}
                        onClick={() => handleRequestRefill(item)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl"
                      >
                        {refillingId === (item.prescriptionId || item.id) ? 'Sending...' : 'Refill'}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Care Team and Recent Providers (Upgraded with PCP badge & Care Team API) */}
            <div className="bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 dark:bg-slate-800">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-bold tracking-tight text-gray-900 dark:text-white">My Care Team</h2>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Primary Care & Recent Providers</p>
                </div>
                <Link
                  href="/dashboard/patient/my-doctors"
                  className="text-xs font-semibold text-emerald-600 hover:text-emerald-700"
                >
                  View All Care Team
                </Link>
              </div>
              <div className="space-y-3">
                {careTeam.length === 0 ? (
                  <div className="text-center py-6 px-2">
                    <p className="text-sm font-medium text-slate-600 dark:text-gray-300">No care team members yet</p>
                    <p className="text-xs text-slate-500 dark:text-gray-400 mt-1">
                      Doctors you book with appear here. Availability is only shown when the server reports it — we
                      never invent an &quot;online&quot; status.
                    </p>
                  </div>
                ) : (
                  careTeam.slice(0, 4).map((member) => (
                    <div
                      key={member.providerId}
                      className="p-2.5 hover:bg-slate-50 rounded-xl transition border border-transparent hover:border-slate-100 dark:hover:bg-slate-700/50 dark:hover:border-slate-700"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="relative shrink-0">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-emerald-100 to-teal-100 flex items-center justify-center border border-emerald-200 dark:from-emerald-900/40 dark:to-teal-900/40 dark:border-emerald-800">
                              <span className="text-emerald-700 font-bold text-sm dark:text-emerald-300">
                                {(member.name.replace(/^Dr\.\s*/i, '') || 'D')[0]}
                              </span>
                            </div>
                            {member.isOnline === true && (
                              <div
                                className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full dark:border-slate-800"
                                title="Online"
                                aria-label="Online"
                              />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-sm font-bold text-slate-800 dark:text-gray-100 truncate">
                                {member.name}
                              </p>
                              {member.isPrimary && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-[10px] font-bold">
                                  <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" /> PCP
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 dark:text-gray-400 truncate">
                              {member.specialty || 'General Practice'}
                              {member.facilityName ? ` · ${member.facilityName}` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            onClick={() =>
                              setQuickChatDoc({
                                id: member.userId || member.providerId,
                                name: member.name,
                              })
                            }
                            size="sm"
                            variant="ghost"
                            title="Send Message"
                            className="w-8 h-8 p-0 rounded-full hover:bg-emerald-50 text-emerald-600"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </Button>
                          <Link
                            href={`/consultations/new?doctorId=${encodeURIComponent(member.providerId)}`}
                            title="Schedule Appointment"
                            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-teal-50 text-teal-600"
                          >
                            <Calendar className="w-4 h-4" />
                          </Link>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <Button
                onClick={handleBookClick}
                className="w-full mt-4 bg-green-600 text-white hover:bg-green-700 hover:shadow-glow-primary rounded-xl text-sm font-semibold shadow-md transition-all"
              >
                Book a Specialist
              </Button>
            </div>

            {/* Explore More & Linked Accounts (Docarion Central) Card */}
            <div className="bg-gradient-to-br from-teal-900 to-slate-900 text-white rounded-2xl shadow-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Globe className="w-5 h-5 text-teal-400" />
                  <h2 className="font-bold tracking-tight text-sm">Docarion Central · Linked Accounts</h2>
                </div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-300 border border-teal-400/30">
                  {linkedFacilities.length || 'Unified'} Linked
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed mb-4">
                Connect hospitals, clinics, pharmacies, and diagnostic labs into one longitudinal chart or generate a
                one-time Share Everywhere clinician code.
              </p>

              {linkedFacilities.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.setItem('docarion-active-facility', 'all');
                      window.dispatchEvent(
                        new CustomEvent('docarion-facility-changed', {
                          detail: { facilityId: 'all', name: 'Docarion Central' },
                        })
                      );
                    }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition ${
                      activeFacilityId === 'all'
                        ? 'bg-teal-500 text-white'
                        : 'bg-white/10 text-slate-200 hover:bg-white/20'
                    }`}
                  >
                    🌐 All Facilities
                  </button>
                  {linkedFacilities.slice(0, 3).map((fac) => (
                    <button
                      key={fac.facilityId}
                      type="button"
                      onClick={() => {
                        localStorage.setItem('docarion-active-facility', fac.facilityId);
                        window.dispatchEvent(
                          new CustomEvent('docarion-facility-changed', {
                            detail: { ...fac, facilityId: fac.facilityId },
                          })
                        );
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold truncate max-w-[140px] transition ${
                        activeFacilityId === fac.facilityId
                          ? 'bg-teal-500 text-white'
                          : 'bg-white/10 text-slate-200 hover:bg-white/20'
                      }`}
                    >
                      {fac.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Link
                  href="/dashboard/patient/facilities"
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-semibold text-white transition"
                >
                  <Link2 className="w-3.5 h-3.5 text-teal-300" />
                  Link Accounts
                </Link>
                <Link
                  href="/dashboard/patient/access"
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-teal-500 hover:bg-teal-400 text-xs font-semibold text-slate-950 transition"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Share Everywhere
                </Link>
              </div>
            </div>

            {/* Document Vault */}
            <div className="bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 dark:bg-slate-800">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold tracking-tight text-gray-900 dark:text-white">Document Vault</h2>
                <Link
                  href="/dashboard/patient/document-center"
                  className="text-xs font-semibold text-emerald-600 hover:underline"
                >
                  Document Center
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Link
                  href="/prescriptions"
                  className="p-3 bg-blue-50/50 rounded-2xl border border-blue-100 hover:bg-blue-50 transition text-center group"
                >
                  <Pill className="w-6 h-6 text-blue-500 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-semibold text-blue-900">Prescriptions</p>
                </Link>
                <Link
                  href="/lab-results"
                  className="p-3 bg-purple-50/50 rounded-2xl border border-purple-100 hover:bg-purple-50 transition text-center group"
                >
                  <Beaker className="w-6 h-6 text-purple-500 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-semibold text-purple-900">Lab Results</p>
                </Link>
                <Link
                  href="/dashboard/patient/radiology-results"
                  className="p-3 bg-teal-50/50 rounded-2xl border border-teal-100 hover:bg-teal-50 transition text-center group"
                >
                  <Activity className="w-6 h-6 text-teal-500 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-semibold text-teal-900">Scans (PACS)</p>
                </Link>
                <Link
                  href="/dashboard/patient/document-center"
                  className="p-3 bg-slate-50/50 rounded-2xl border border-slate-100 hover:bg-slate-50 transition text-center group"
                >
                  <FileText className="w-6 h-6 text-slate-500 mx-auto mb-2 group-hover:scale-110 transition-transform dark:text-gray-400" />
                  <p className="text-xs font-semibold text-slate-900 dark:text-white">Letters & AVS</p>
                </Link>
                <Link
                  href="/dashboard/second-opinion"
                  className="p-3 bg-indigo-50/50 rounded-2xl border border-indigo-100 hover:bg-indigo-50 transition text-center group"
                >
                  <MessageSquare className="w-6 h-6 text-indigo-500 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-semibold text-indigo-900">Second Opinion</p>
                </Link>
                <Link
                  href="/dashboard/patient/eyeglass-prescriptions"
                  className="p-3 bg-amber-50/50 rounded-2xl border border-amber-100 hover:bg-amber-50 transition text-center group"
                >
                  <FileText className="w-6 h-6 text-amber-600 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-semibold text-amber-900">Eyeglass Rx</p>
                </Link>
              </div>

              {/* Recent Documents */}
              <div className="border-t border-slate-50 pt-4 mt-5">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 dark:text-gray-400">
                  Recent Documents
                </h3>
                <div className="space-y-2">
                  {prescriptions.slice(0, 1).map((p) => (
                    <div
                      key={`rec-p-${p.prescriptionId}`}
                      onClick={() => setPreviewRecord({ type: 'prescription', id: p.prescriptionId, data: p })}
                      className="flex items-center justify-between p-2 hover:bg-slate-50 rounded-xl cursor-pointer transition"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-500 dark:bg-blue-900/20">
                          <Pill className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-800 dark:text-gray-100">Prescription</p>
                          <p className="text-[10px] text-slate-500 dark:text-gray-400">
                            {new Date(p.issuedAt || p.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-400 dark:text-gray-500" />
                    </div>
                  ))}
                  {labs.slice(0, 1).map((l) => (
                    <div
                      key={`rec-l-${l.orderId || l.id}`}
                      onClick={() => setPreviewRecord({ type: 'lab', id: l.orderId || l.id, data: l })}
                      className="flex items-center justify-between p-2 hover:bg-slate-50 rounded-xl cursor-pointer transition"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center text-purple-500 dark:bg-purple-900/20">
                          <Beaker className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-800 dark:text-gray-100">Lab Result</p>
                          <p className="text-[10px] text-slate-500 dark:text-gray-400">
                            {new Date(l.orderedAt || l.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-400 dark:text-gray-500" />
                    </div>
                  ))}
                  {prescriptions.length === 0 && labs.length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-2 dark:text-gray-400">No recent documents</p>
                  )}
                </div>
              </div>
            </div>

            {/* Compliance & Security */}
            <div className="bg-white rounded-2xl shadow-card ring-1 ring-gray-100 p-5 dark:bg-slate-800">
              <h2 className="font-bold tracking-tight text-gray-900 mb-4 dark:text-white">Compliance & Security</h2>
              <div className="space-y-3">
                <Link
                  href="/dashboard/patient/kyc"
                  className="flex items-center justify-between p-3 bg-amber-50/50 rounded-2xl border border-amber-100 hover:bg-amber-50 transition group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-amber-900/30">
                      <ShieldCheck className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-amber-900">KYC Verification</p>
                      <p className="text-[10px] text-amber-700/70">
                        {kycStatus === 'verified' || kycStatus === 'successful' ? 'Verified ✓' : 'Action required'}
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-amber-400" />
                </Link>
                <Link
                  href="/dashboard/patient/facilities"
                  className="flex items-center justify-between p-3 bg-indigo-50/50 rounded-2xl border border-indigo-100 hover:bg-indigo-50 transition group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform dark:bg-indigo-900/30">
                      <Building2 className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-indigo-900">My Facilities</p>
                      <p className="text-[10px] text-indigo-700/70">Manage data access consents</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-indigo-400" />
                </Link>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-50 flex justify-center">
                <ComplianceBadges />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Change Your Shortcuts Modal (MyChart Screen 14) */}
      {showShortcutsModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-full max-w-lg shadow-2xl border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Change Your Shortcuts</h3>
              <button
                type="button"
                onClick={() => setShowShortcutsModal(false)}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Choose up to 6 shortcuts to pin to the top of your Docarion Home screen ({selectedShortcutIds.length}/6
              selected).
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-80 overflow-y-auto pr-1">
              {ALL_SHORTCUT_CATALOG.map((item) => {
                const isSelected = selectedShortcutIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedShortcutIds((prev) => {
                        if (prev.includes(item.id)) return prev.filter((id) => id !== item.id);
                        if (prev.length >= 6) {
                          toast.info('Maximum 6 shortcuts — uncheck one first');
                          return prev;
                        }
                        return [...prev, item.id];
                      });
                    }}
                    className={`p-3 rounded-xl border text-left flex items-center justify-between transition ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-lg shrink-0">{item.icon}</span>
                      <span className="text-xs font-semibold truncate">{item.label}</span>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-emerald-600 shrink-0" />}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setSelectedShortcutIds(DEFAULT_SHORTCUT_IDS)}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-400"
              >
                Reset to Default
              </button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowShortcutsModal(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={savingShortcuts}
                  onClick={handleSaveShortcuts}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {savingShortcuts ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Vitals Update Modal */}
      {showVitalsModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-elevated animate-scale-in dark:bg-slate-800">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold tracking-tight text-gray-900 dark:text-white">Record Vitals</h3>
              <button
                onClick={() => setShowVitalsModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 dark:text-gray-400 dark:bg-slate-700"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div className="mb-4 p-3 bg-green-50/60 rounded-xl border border-green-100">
                <label className="block text-xs font-semibold text-emerald-800 mb-2">✨ AI Vitals Parsing</label>
                <textarea
                  className="w-full text-sm p-2.5 rounded-xl border border-green-200 mb-2 focus:outline-none focus:ring-2 focus:ring-green-500/30 focus:border-green-500 transition-all"
                  rows={2}
                  placeholder="Paste vitals dictation here..."
                  value={aiText}
                  onChange={(e) => setAiText(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  className="w-full bg-green-600 hover:bg-green-700 text-white rounded-xl"
                  onClick={handlePrefill}
                  disabled={aiLoading || !aiText.trim()}
                >
                  {aiLoading ? 'Extracting...' : 'Auto-fill from Text'}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider dark:text-gray-400">
                    Systolic
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      placeholder="120"
                      value={vitalsForm.systolic}
                      onChange={(e) => setVitalsForm((p) => ({ ...p, systolic: e.target.value }))}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-rose-500 focus:border-rose-500 transition-all outline-none dark:text-gray-100 dark:bg-slate-800"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium dark:text-gray-400">
                      mmHg
                    </span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider dark:text-gray-400">
                    Diastolic
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      placeholder="80"
                      value={vitalsForm.diastolic}
                      onChange={(e) => setVitalsForm((p) => ({ ...p, diastolic: e.target.value }))}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-rose-500 focus:border-rose-500 transition-all outline-none dark:text-gray-100 dark:bg-slate-800"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium dark:text-gray-400">
                      mmHg
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider dark:text-gray-400">
                  Heart Rate
                </label>
                <div className="relative">
                  <input
                    type="number"
                    placeholder="72"
                    value={vitalsForm.heartRate}
                    onChange={(e) => setVitalsForm((p) => ({ ...p, heartRate: e.target.value }))}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-rose-500 focus:border-rose-500 transition-all outline-none dark:text-gray-100 dark:bg-slate-800"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium dark:text-gray-400">
                    bpm
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider dark:text-gray-400">
                    Temperature
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      placeholder="36.8"
                      value={vitalsForm.temperature}
                      onChange={(e) => setVitalsForm((p) => ({ ...p, temperature: e.target.value }))}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-rose-500 focus:border-rose-500 transition-all outline-none dark:text-gray-100 dark:bg-slate-800"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium dark:text-gray-400">
                      °C
                    </span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider dark:text-gray-400">
                    SpO2
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      placeholder="98"
                      value={vitalsForm.oxygenSaturation}
                      onChange={(e) => setVitalsForm((p) => ({ ...p, oxygenSaturation: e.target.value }))}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-rose-500 focus:border-rose-500 transition-all outline-none dark:text-gray-100 dark:bg-slate-800"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium dark:text-gray-400">
                      %
                    </span>
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <Button
                  onClick={submitVitals}
                  className="w-full bg-rose-600 hover:bg-rose-700 text-white rounded-xl py-6 text-base font-bold shadow-lg shadow-rose-600/20"
                >
                  Save Vitals to Record
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <BottomNav />
      {/* Drawers and Modals */}
      <AICopilotDrawer
        isOpen={aiCopilotOpen}
        onClose={() => setAiCopilotOpen(false)}
        mode={aiCopilotMode}
        consultationId={pendingIntake?.consultationId}
        initialQuery={copilotQuery}
      />

      <BookingDrawer isOpen={bookingOpen} onClose={() => setBookingOpen(false)} />

      {quickChatDoc && (
        <QuickChatWidget
          isOpen={!!quickChatDoc}
          onClose={() => setQuickChatDoc(null)}
          doctorId={quickChatDoc.id}
          doctorName={quickChatDoc.name}
          isOnline={careTeam.find((d) => (d.userId || d.providerId) === quickChatDoc.id)?.isOnline}
        />
      )}

      <RecordPreviewModal
        isOpen={!!previewRecord}
        onClose={() => setPreviewRecord(null)}
        recordType={previewRecord?.type || null}
        recordId={previewRecord?.id || null}
        recordData={previewRecord?.data}
      />
    </div>
  );
}

export default withRoleGuard(PatientDashboard, ['patient', 'super_admin']);
