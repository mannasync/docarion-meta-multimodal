'use client';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { MetricCard } from '@/components/ui/MetricCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useEffect, useState, useMemo, Suspense } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth.store';
import { withRoleGuard } from '@/components/shared/withRoleGuard';
import { PreConsultModal } from '@/components/dashboard/PreConsultModal';
import { api, doctorApi, consultationApi, messagingApi, practiceApi } from '@/services/api';
import { setIndependentPracticeHint } from '@/lib/roleHome';
import { isPracticeOrFacilitylessDoctor } from '@/lib/practiceContext';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/LoadingStates';
import { NotificationBell } from '@/components/shared/NotificationBell';
import { toast } from 'react-toastify';
import { DashboardAIAssistant } from '@/components/shared/DashboardAIAssistant';
import { MetaMultimodalScanner } from '@/components/ai/MetaMultimodalScanner';
import { ComplianceBadges } from '@/components/ui/TrustBadge';
import { AvailabilityPill, useDoctorAvailability } from '@/components/shared/AvailabilityPill';
import { CREDENTIAL_HOME } from '@/lib/credentialGate';

const WaitlistManager = dynamic(() => import('@/components/shared/WaitlistManager'), { ssr: false });

// Helper to parse Firestore timestamps (may arrive as { _seconds, _nanoseconds } or ISO string)
function parseTimestamp(val: any): Date | null {
  if (!val) return null;
  if (val._seconds) return new Date(val._seconds * 1000);
  if (val.seconds) return new Date(val.seconds * 1000);
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(val: any): string {
  const d = parseTimestamp(val);
  if (!d) return 'No date set';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Derive priority from wait time */
function getWaitPriority(scheduledAt: any): 'critical' | 'urgent' | 'routine' {
  const d = parseTimestamp(scheduledAt);
  if (!d) return 'routine';
  const waitMins = (Date.now() - d.getTime()) / 60000;
  if (waitMins > 60) return 'critical';
  if (waitMins > 30) return 'urgent';
  return 'routine';
}

function getPriorityColor(priority: 'critical' | 'urgent' | 'routine') {
  if (priority === 'critical') return { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500', border: 'border-l-red-500' };
  if (priority === 'urgent') return { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500', border: 'border-l-amber-500' };
  return { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500', border: 'border-l-green-500' };
}

function getPendingBadge(count: number) {
  if (count >= 16) return { color: 'bg-red-500', label: 'Overloaded' };
  if (count >= 6) return { color: 'bg-amber-500', label: 'Attention' };
  return { color: 'bg-green-500', label: 'Manageable' };
}

function DoctorDashboard() {
  const { user, logout } = useAuthStore();
  const [stats, setStats] = useState({
    todayConsultations: 0,
    pendingConsultations: 0,
    completedConsultations: 0,
    totalPatients: 0,
  });
  const [consultations, setConsultations] = useState<any[]>([]);
  const [outcomes, setOutcomes] = useState<any[]>([]);
  const [readinessData, setReadinessData] = useState<{ score: number; insights: string[] }>({ score: 0, insights: [] });
  const [results, setResults] = useState<{ labOrders: any[]; radiologyOrders: any[] }>({ labOrders: [], radiologyOrders: [] });
  // Availability is server truth, hydrated by `useDoctorAvailability`
  // (GET /doctors/me/profile). It starts UNKNOWN — never "Available" — so the
  // pill can no longer claim the doctor is online before/without hydration, and
  // it renders forced-off + disabled when the credential wall returns
  // 403 CREDENTIAL_REQUIRED.
  const availability = useDoctorAvailability(true);
  const isAvailable = availability.isAvailable;
  const profile = availability.profile;
  const [loading, setLoading] = useState(true);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [claimingIds, setClaimingIds] = useState<Set<string>>(new Set());
  const [selectedConsultation, setSelectedConsultation] = useState<any>(null);
  const router = useRouter();

  // V-P1-1. An independent practitioner has no facilityId, so this
  // facility-staff command centre is the wrong landing surface for them.
  // `GET /practice/me` is the only endpoint that answers "does this doctor own
  // a practice?"; it is called ONLY for facility-less doctors (a hospital
  // doctor never pays for the request) and the redirect fires at most once per
  // browser session so the drawer link back here keeps working.
  useEffect(() => {
    // A provisioned practice owner's selected appointment pins facilityId to the
    // practice (pp_…), so "facility-less" alone missed them — they were stuck on
    // this facility console. Hospital/clinic doctors still never probe.
    if (!user || !isPracticeOrFacilitylessDoctor(user)) return;
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem('practice-home-redirect') === 'done') return;
    let cancelled = false;
    practiceApi
      .me()
      .then((res) => {
        const owner = res.data?.data?.practice;
        setIndependentPracticeHint(!!owner);
        if (!cancelled && owner) {
          sessionStorage.setItem('practice-home-redirect', 'done');
          router.replace('/dashboard/practice');
        }
      })
      .catch(() => {
        // No practice / not permitted — stay here, never block the dashboard.
        sessionStorage.setItem('practice-home-redirect', 'done');
      });
    return () => { cancelled = true; };
  }, [user, router]);

  const [prefillSuggestion, setPrefillSuggestion] = useState<string | null>(null);
  const [prefillLoading, setPrefillLoading] = useState(false);
  const [prefillError, setPrefillError] = useState<string | null>(null);

  const handleMagicFill = async () => {
    setPrefillLoading(true);
    setPrefillError(null);
    setPrefillSuggestion(null);
    try {
      const res = await api.get('/ai/prefill');
      const data = res.data?.data;
      if (!data) {
        setPrefillError('Manual entry required');
        return;
      }
      if (res.data?.success === false || data.invalidFormat) {
        setPrefillError('AI Suggestion Failed');
        return;
      }
      if (data.confidence !== undefined && data.confidence < 0.5) {
        setPrefillError('Manual entry required');
        return;
      }
      if (data.unexpectedFields) {
        setPrefillError('Manual entry required');
        return;
      }
      if (data.suggestion) {
        setPrefillSuggestion(data.suggestion);
      } else {
        setPrefillError('Manual entry required');
      }
    } catch (err) {
      console.error('Error fetching AI prefill:', err);
      setPrefillError('AI Suggestion Failed');
    } finally {
      setPrefillLoading(false);
    }
  };


  useEffect(() => {
    loadDashboardData();
    loadOutcomes();
    loadResults();
    loadUnreadMessages();
  }, []);

  const loadDashboardData = async () => {
    try {
      const [allConsultations, pendingConsultations] = await Promise.all([
        doctorApi.getConsultations(),
        doctorApi.getConsultations({ status: 'pending' }),
      ]);

      const all = allConsultations.data.data || [];
      const pending = pendingConsultations.data.data || [];
      const today = all.filter((c: any) => {
        const d = parseTimestamp(c.scheduledAt);
        return d && d.toDateString() === new Date().toDateString();
      });

      setStats({
        todayConsultations: today.length,
        pendingConsultations: pending.length,
        completedConsultations: all.filter((c: any) => c.status === 'completed').length,
        totalPatients: new Set(all.map((c: any) => c.patientId).filter(Boolean)).size,
      });
      setConsultations(pending);
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadOutcomes = async () => {
    try {
      const res = await doctorApi.getOutcomes();
      setOutcomes(res.data.data || []);
      const readinessRes = await doctorApi.getReadiness();
      setReadinessData({
        score: readinessRes.data.data?.readinessScore || 0,
        insights: readinessRes.data.data?.insights || []
      });
    } catch (error) {
      console.error('Failed to load outcomes/readiness:', error);
    }
  };

  const loadResults = async () => {
    try {
      const res = await doctorApi.getResults();
      setResults(Array.isArray(res.data.data) ? { labOrders: [], radiologyOrders: [] } : (res.data.data || { labOrders: [], radiologyOrders: [] }));
    } catch {
      // Results endpoint may not exist yet
    }
  };

  const loadUnreadMessages = async () => {
    try {
      const res = await messagingApi.getConversations();
      const convos = res.data.data || [];
      const unread = convos.reduce((sum: number, c: any) => sum + (c.unreadCount || 0), 0);
      setUnreadMessages(unread);
    } catch {
      // Messaging may not be set up
    }
  };

  const handleAvailabilityToggle = availability.toggle;

  // Consultation type breakdown
  const typeBreakdown = useMemo(() => {
    const video = consultations.filter(c => c.type === 'video').length;
    const inPerson = consultations.length - video;
    return { video, inPerson };
  }, [consultations]);

  const readinessScore = readinessData.score;

  const pendingLabCount = results.labOrders?.filter(o => o.status === 'pending' || o.status === 'processing').length || 0;
  const pendingRadCount = results.radiologyOrders?.filter(o => o.status === 'pending' || o.status === 'scheduled').length || 0;
  const completedLabCount = results.labOrders?.filter(o => o.status === 'completed').length || 0;
  const completedRadCount = results.radiologyOrders?.filter(o => o.status === 'completed').length || 0;
  const pendingBadge = getPendingBadge(stats.pendingConsultations);

  if (loading) return <PageLoading message="Loading doctor dashboard..." />;

  // Header = honest indicator; the switch lives in the Availability card below
  // (one state object, so the two can never disagree).
  const headerActions = <AvailabilityPill state={availability} showSwitch={false} className="mr-4" />;

  return (
    <DashboardShell
      title="Clinical Command Center"
      actions={headerActions}
      subtitle={profile?.doctorType && (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${profile.doctorType === 'platform' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
          {profile.doctorType === 'platform' ? '🌐 Platform' : '🏥 Facility'}
        </span>
      )}
    >
      <div className="flex flex-col lg:flex-row gap-6">
        <aside className="w-full lg:w-80 xl:w-96 flex-shrink-0 order-1 lg:order-2">
        <div className="space-y-6">
          <DashboardAIAssistant />
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Link href="/consultations" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  📋 All Consultations
                </Button>
              </Link>
              <Link href="/patients" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  👥 My Patients
                </Button>
              </Link>
              <Link href="/prescriptions/write" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  💊 Write Prescription
                </Button>
              </Link>
              <Link href="/lab-orders/write" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  🧪 Order Lab Tests
                </Button>
              </Link>
              <Link href="/radiology-orders/write" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  🩻 Radiology Orders
                </Button>
              </Link>
              <Link href="/referrals/write" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  🏥 Write Referral
                </Button>
              </Link>
              <Link href="/schedule" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  📅 Manage Schedule
                </Button>
              </Link>
              <Link href="/messages" className="block">
                <Button className="w-full justify-start text-left relative" variant="outline">
                  💬 Messages
                  {unreadMessages > 0 && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                      {unreadMessages > 9 ? '9+' : unreadMessages}
                    </span>
                  )}
                </Button>
              </Link>
              <Link href="/medical-records" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  📁 Medical Records
                </Button>
              </Link>
              <Link href="/earnings" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  💰 Earnings & Wallet
                </Button>
              </Link>
              <Link href="/dashboard/rpm" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  ❤️ Remote Monitoring
                </Button>
              </Link>
              <Link href="/dashboard/doctor/analytics" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  📈 My Performance
                </Button>
              </Link>
              {/* V-P1-1: Only show the private practice link to independent
                  doctors (no facilityId). Facility-employed doctors do not
                  have a private practice workspace. */}
              {isPracticeOrFacilitylessDoctor(user) && (
                <Link href="/dashboard/practice" className="block">
                  <Button className="w-full justify-start text-left" variant="outline">
                    🩺 My Private Practice
                  </Button>
                </Link>
              )}
              <Link href="/dashboard/referrals" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  🔁 Referrals
                </Button>
              </Link>
              <Link href="/dashboard/admin/second-opinions" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  🧠 Second Opinion Queue
                </Button>
              </Link>
              <Link href="/dashboard/telehealth/queue" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  📊 Queue Board
                </Button>
              </Link>
              <Link href="/dashboard/review-requests" className="block">
                <Button className="w-full justify-start text-left" variant="outline">
                  🩺 Facility Review Requests
                </Button>
              </Link>
              {/* V-P1-1: facility-staff surface. A doctor with no facilityId
                  (independent practice) belongs to no hospital — offering them
                  the hospital module told them they were hospital staff. */}
              {user?.facilityId && !isPracticeOrFacilitylessDoctor(user) && (
                <>
                  <div className="border-t border-gray-200 dark:border-slate-700 pt-2 mt-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-2 dark:text-gray-400">Hospital</p>
                  </div>
                  <Link href="/dashboard/hospital" className="block">
                    <Button className="w-full justify-start text-left bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800" variant="outline">
                      🏥 Hospital Module
                    </Button>
                  </Link>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Availability</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Accept new consultations</p>
                  <p className="text-xs text-gray-500 mt-0.5 dark:text-gray-400">
                    {availability.credentialBlocked
                      ? availability.credentialMessage || 'Complete your credentials to go online.'
                      : isAvailable === null
                        ? 'Checking your availability with the server…'
                        : isAvailable
                          ? 'Patients can book you'
                          : "You won't receive new bookings"}
                  </p>
                </div>
                <button
                  onClick={handleAvailabilityToggle}
                  disabled={availability.saving || availability.credentialBlocked || isAvailable === null}
                  aria-label="Accept new consultations"
                  aria-pressed={isAvailable === true}
                  className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${availability.saving || availability.credentialBlocked || isAvailable === null ? 'opacity-50 cursor-not-allowed' : ''} ${isAvailable && !availability.credentialBlocked ? 'bg-green-500' : 'bg-gray-300'}`}
                >
                  <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform shadow ${isAvailable && !availability.credentialBlocked ? 'left-7' : 'left-1'}`} />
                </button>
              </div>
              {availability.credentialBlocked && (
                <Link href={CREDENTIAL_HOME} className="mt-3 block text-xs font-semibold text-amber-700 underline">
                  Complete your credentials
                </Link>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Results Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">🧪 Lab — Completed</span>
                <span className="font-medium text-green-600">{completedLabCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">🧪 Lab — Pending</span>
                <span className="font-medium text-yellow-600">{pendingLabCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">🩻 Radiology — Completed</span>
                <span className="font-medium text-green-600">{completedRadCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">🩻 Radiology — Pending</span>
                <span className="font-medium text-blue-600">{pendingRadCount}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>My Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center dark:bg-green-900/30">
                  <span className="text-green-700 font-bold">
                    {user?.profile?.firstName?.[0]}{user?.profile?.lastName?.[0]}
                  </span>
                </div>
                <div>
                  <p className="font-medium">Dr. {user?.profile?.firstName} {user?.profile?.lastName}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{profile?.specialization || 'General Practice'}</p>
                </div>
              </div>
              <Link href="/profile">
                <Button variant="outline" size="sm" className="w-full">Edit Profile</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </aside>
      <div className="flex-1 w-full order-2 lg:order-1 min-w-0 space-y-8">
        {/* Greeting */}
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-gray-800 dark:text-white">
            {getGreeting()}, Dr. {user?.profile?.lastName || user?.profile?.firstName} 👋
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {' · '}
            <span className="text-green-600 font-medium">
              {stats.pendingConsultations > 0 ? `${stats.pendingConsultations} patients waiting for your expertise` : 'All caught up — great work!'}
            </span>
          </p>
        </div>

        {/* Professional License & Credential Gate Banner (if blocked) */}
        {availability.credentialBlocked && (
          <div
            data-testid="doctor-credential-status-banner"
            className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">🛡️</span>
              <div>
                <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                  Professional License Verification Required to Claim New Patients
                </p>
                <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                  {availability.credentialMessage || 'Your MDCN / professional practicing license is currently pending verification or incomplete. You can view your dashboard, but claiming waiting patients requires a verified credential.'}
                </p>
              </div>
            </div>
            <Link href={CREDENTIAL_HOME} className="shrink-0">
              <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white whitespace-nowrap">
                Verify License &amp; Credentials →
              </Button>
            </Link>
          </div>
        )}

        {/* Stats — with metric contextualization */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <MetricCard
            title="Today"
            value={stats.todayConsultations}
            subtitle={`consultations · ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
            colorScheme="blue"
            icon={<span className="text-sm font-bold text-blue-700">{new Date().getDate()}</span>}
          />
          <MetricCard
            title="Pending"
            value={stats.pendingConsultations}
            subtitle={
              (typeBreakdown.video > 0 ? `${typeBreakdown.video} video` : '') +
              (typeBreakdown.video > 0 && typeBreakdown.inPerson > 0 ? ' · ' : '') +
              (typeBreakdown.inPerson > 0 ? `${typeBreakdown.inPerson} in-person` : '') || 'awaiting action'
            }
            colorScheme="yellow"
            icon={<span className={`w-2.5 h-2.5 rounded-full ${pendingBadge.color}`} title={pendingBadge.label} />}
          />
          <MetricCard title="Completed" value={stats.completedConsultations} subtitle="total" colorScheme="green" />
          <MetricCard title="Patients" value={stats.totalPatients} subtitle="unique" colorScheme="purple" />
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            {/* Magic Fill Card */}
            <Card>
              <CardHeader>
                <CardTitle>✨ Magic Fill Engine</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Generate AI recommendations and documentation pre-fills for your pending consultations.
                </p>
                <Button 
                  onClick={handleMagicFill} 
                  disabled={prefillLoading}
                >
                  {prefillLoading ? 'Generating...' : '✨ Magic Fill'}
                </Button>
                {prefillError && (
                  <p className="text-sm text-red-600 font-medium">{prefillError}</p>
                )}
                {prefillSuggestion && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl space-y-2 dark:bg-blue-900/20">
                    <p className="text-sm font-medium text-blue-900">AI Suggested Note:</p>
                    <p className="text-sm text-blue-800">{prefillSuggestion}</p>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={() => setPrefillSuggestion(null)}
                    >
                      Discard
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Queue Management Tools */}
            <Card>
              <CardHeader>
                <CardTitle>📊 Queue Management</CardTitle>
              </CardHeader>
              <CardContent>
                <Suspense fallback={
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
                    <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading queue...</span>
                  </div>
                }>
                  <WaitlistManager />
                </Suspense>
              </CardContent>
            </Card>

            {/* Lab/Radiology Results */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <CardTitle>📊 Patient Results</CardTitle>
                  <ComplianceBadges size="sm" />
                </div>
                <div className="flex gap-2">
                  {pendingLabCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 font-medium dark:bg-yellow-900/30 dark:text-yellow-300">
                      🧪 {pendingLabCount} pending lab
                    </span>
                  )}
                  {pendingRadCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-medium dark:bg-blue-900/30 dark:text-blue-300">
                      🩻 {pendingRadCount} pending radiology
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {((results.labOrders?.length || 0) + (results.radiologyOrders?.length || 0)) > 0 ? (
                  <div className="space-y-3">
                    {(results.labOrders || []).slice(0, 5).map((order: any) => (
                      <div key={order.orderId || order.labOrderId} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl dark:bg-slate-800">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">🧪</span>
                          <div>
                            <p className="text-sm font-medium">{order.tests?.map((t: any) => t.name || t.testName).join(', ') || 'Lab Order'}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">{order.patientName || order.patientId?.substring(0, 8)}</p>
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${order.status === 'completed' ? 'bg-green-100 text-green-700' :
                          order.status === 'processing' ? 'bg-yellow-100 text-yellow-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>{order.status}</span>
                      </div>
                    ))}
                    {(results.radiologyOrders || []).slice(0, 5).map((order: any) => (
                      <div key={order.orderId || order.radiologyOrderId} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl dark:bg-slate-800">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">🩻</span>
                          <div>
                            <p className="text-sm font-medium">{order.examType || order.studyType || 'Radiology Order'}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">{order.patientName || order.patientId?.substring(0, 8)}</p>
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${order.status === 'completed' ? 'bg-green-100 text-green-700' :
                          order.status === 'scheduled' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>{order.status}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500 text-center py-6 text-sm dark:text-gray-400">No patient results yet</p>
                )}
              </CardContent>
            </Card>

            {/* Outcomes Intelligence — Proactive */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
                <CardTitle>🧠 Outcomes Intelligence</CardTitle>
                <span className={`text-xs font-bold px-2 py-1 rounded ${outcomes.length > 0 ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                  {outcomes.length > 0 ? 'FEEDBACK LOOP ACTIVE' : 'LEARNING PHASE'}
                </span>
              </CardHeader>
              <CardContent>
                {outcomes.length > 0 ? (
                  <div className="space-y-4">
                    {outcomes.map((o: any) => (
                      <div key={o.outcomeId} className="p-4 border border-gray-100 rounded-xl bg-white shadow-card dark:bg-slate-800">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${o.improvementStatus === 'significant' ? 'bg-green-100 text-green-700' :
                              o.improvementStatus === 'moderate' ? 'bg-blue-100 text-blue-700' :
                                o.improvementStatus === 'worsened' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'
                              }`}>
                              {o.improvementStatus} improvement
                            </span>
                            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">Day {o.followUpDay}</span>
                          </div>
                          <Link href={`/consultations/${o.consultationId}`} className="text-xs text-green-600 hover:underline">
                            View Consultation
                          </Link>
                        </div>
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Diagnosis: {o.diagnosis}</p>
                        <p className="text-xs text-gray-500 mt-1 italic dark:text-gray-400">&quot;{o.patientNotes}&quot;</p>
                        <div className="mt-3 flex gap-4">
                          <div className="text-[10px] text-gray-500 dark:text-gray-400">
                            <span className="font-bold">INITIAL SYMPTOMS:</span> {o.initialSymptoms?.join(', ')}
                          </div>
                          <div className="text-[10px] text-gray-500 dark:text-gray-400">
                            <span className="font-bold">TREATMENT:</span> {o.treatment?.substring(0, 50)}...
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Readiness Score */}
                    <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">AI Readiness Score</p>
                        <span className="text-2xl font-bold text-blue-600">{readinessScore}%</span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2.5 dark:bg-slate-700">
                        <div
                          className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2.5 rounded-full transition-all duration-1000"
                          style={{ width: `${readinessScore}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-500 mt-2 dark:text-gray-400">
                        {readinessScore < 30 && 'Complete more consultations to unlock pattern analysis'}
                        {readinessScore >= 30 && readinessScore < 60 && 'Building patient history — analyzing patterns'}
                        {readinessScore >= 60 && readinessScore < 100 && 'Almost there — follow-up responses will activate the loop'}
                        {readinessScore === 100 && 'Fully active — outcomes are being tracked'}
                      </p>
                    </div>

                    {/* Learning Phase Timeline */}
                    <div className="flex items-center justify-between px-2">
                      {[
                        { day: 3, label: 'Initial Check', desc: 'Symptom reassessment' },
                        { day: 7, label: 'Follow-up', desc: 'Treatment efficacy' },
                        { day: 15, label: 'Outcome', desc: 'Final evaluation' },
                      ].map((step, idx) => (
                        <div key={step.day} className="flex items-center">
                          <div className="text-center">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${readinessScore > idx * 33 ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-500'
                              }`}>
                              D{step.day}
                            </div>
                            <p className="text-xs font-medium text-gray-700 mt-1 dark:text-gray-300">{step.label}</p>
                            <p className="text-[10px] text-gray-500 dark:text-gray-400">{step.desc}</p>
                          </div>
                          {idx < 2 && (
                            <div className={`w-16 h-0.5 mx-2 ${readinessScore > (idx + 1) * 33 ? 'bg-blue-400' : 'bg-gray-200'}`} />
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Actionable Insights */}
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 dark:bg-amber-900/20">
                      <p className="text-xs font-semibold text-amber-800 mb-1">📊 Actionable Insights</p>
                      <ul className="text-xs text-amber-700 space-y-1">
                        {(readinessData.insights || []).map((insight, idx) => (
                          <li key={idx}>• {insight}</li>
                        ))}
                      </ul>
                    </div>


                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          </div>
        </div>

        {/* Meta Multimodal Clinical AI Scanner (SAM 3.1 Vision, NAFDAC Gate & 2-Way Voice Segregation) */}
        <div className="mt-6">
          <MetaMultimodalScanner defaultTab="vision" />
        </div>
      </div>

        {/* Pre-Consult Modal */}
        {selectedConsultation && (
          <PreConsultModal
            consultation={selectedConsultation}
            onClose={() => setSelectedConsultation(null)}
            onJoin={async () => {
              const cid = selectedConsultation.consultationId;
              const isUnclaimed = !selectedConsultation.doctorId;
              setSelectedConsultation(null);
              if (isUnclaimed) {
                try {
                  await consultationApi.claim(cid);
                } catch (err: any) {
                  toast.error(err?.response?.data?.error || 'Could not claim this consultation');
                  return;
                }
              }
              router.push(`/consultations/${cid}`);
            }}
          />
        )}
    </DashboardShell>
  );
}

export default withRoleGuard(DoctorDashboard, ['doctor', 'super_admin']);
