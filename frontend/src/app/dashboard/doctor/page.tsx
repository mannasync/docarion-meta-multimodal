'use client';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { MetricCard } from '@/components/ui/MetricCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useEffect, useState, useMemo, Suspense } from 'react';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
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
  const { user } = useAuthStore();
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
  const [showScanner, setShowScanner] = useState(false);
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

  const hasFacility = !!user?.facilityId && !isPracticeOrFacilitylessDoctor(user);
  const primaryActions = [
    { href: '/prescriptions/write', label: 'Write Prescription' },
    { href: '/lab-orders/write', label: 'Order Lab Tests' },
    { href: '/radiology-orders/write', label: 'Radiology Order' },
    { href: '/referrals/write', label: 'Write Referral' },
  ];
  const moreLinks: { href: string; label: string; badge?: number }[] = [
    { href: '/consultations', label: 'All Consultations' },
    { href: '/patients', label: 'My Patients' },
    { href: '/schedule', label: 'Manage Schedule' },
    { href: '/messages', label: 'Messages', badge: unreadMessages },
    { href: '/medical-records', label: 'Medical Records' },
    { href: '/dashboard/telehealth/queue', label: 'Queue Board' },
    { href: '/dashboard/referrals', label: 'Referrals' },
    { href: '/dashboard/admin/second-opinions', label: 'Second Opinion Queue' },
    { href: '/dashboard/rpm', label: 'Remote Monitoring' },
    { href: '/dashboard/doctor/analytics', label: 'My Performance' },
    { href: '/earnings', label: 'Earnings & Wallet' },
    // V-P1-1: the private practice workspace is for independent doctors only;
    // facility review requests and the hospital module are facility-staff surfaces.
    ...(isPracticeOrFacilitylessDoctor(user) ? [{ href: '/dashboard/practice', label: 'My Private Practice' }] : []),
    ...(hasFacility ? [
      { href: '/dashboard/review-requests', label: 'Facility Review Requests' },
      { href: '/dashboard/hospital', label: 'Hospital Module' },
    ] : []),
  ];

  const patientLabel = (c: any): string =>
    c.patientName
    || [c.patient?.firstName, c.patient?.lastName].filter(Boolean).join(' ')
    || (c.consultationNumber ? `Consultation ${c.consultationNumber}` : 'Patient');

  return (
    <DashboardShell
      title="Clinical Command Center"
      actions={headerActions}
      subtitle={profile?.doctorType && (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${profile.doctorType === 'platform' ? 'bg-slate-100 text-slate-700' : 'bg-green-50 text-green-700'}`}>
          {profile.doctorType === 'platform' ? 'Platform' : 'Facility'}
        </span>
      )}
    >
      {/* Main work column comes first in the DOM so phones see the queue before
          the sidebar tools. */}
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 w-full min-w-0 space-y-6">
          {/* Greeting */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {getGreeting()}, Dr. {user?.profile?.lastName || user?.profile?.firstName}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              {' · '}
              <span className="font-medium text-gray-700 dark:text-gray-200">
                {stats.pendingConsultations > 0
                  ? `${stats.pendingConsultations} patient${stats.pendingConsultations === 1 ? '' : 's'} waiting`
                  : 'No patients waiting'}
              </span>
            </p>
          </div>

          {/* Professional License & Credential Gate Banner (if blocked) */}
          {availability.credentialBlocked && (
            <div
              data-testid="doctor-credential-status-banner"
              className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div>
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  Professional License Verification Required to Claim New Patients
                </p>
                <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                  {availability.credentialMessage || 'Your MDCN / professional practicing license is currently pending verification or incomplete. You can view your dashboard, but claiming waiting patients requires a verified credential.'}
                </p>
              </div>
              <Link href={CREDENTIAL_HOME} className="shrink-0">
                <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white whitespace-nowrap">
                  Verify License &amp; Credentials
                </Button>
              </Link>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              title="Today"
              value={stats.todayConsultations}
              subtitle="consultations today"
              colorScheme="blue"
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
            <MetricCard title="Completed" value={stats.completedConsultations} subtitle="all time" colorScheme="green" />
            <MetricCard title="Patients" value={stats.totalPatients} subtitle="unique, all time" colorScheme="purple" />
          </div>

          {/* My pending consultations — the doctor's own work list */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle>My Pending Consultations</CardTitle>
              <Link href="/consultations" className="text-sm font-medium text-green-700 hover:underline dark:text-green-400">
                View all
              </Link>
            </CardHeader>
            <CardContent>
              {consultations.length > 0 ? (
                <ul className="divide-y divide-gray-100 dark:divide-slate-800">
                  {consultations.slice(0, 8).map((c: any) => {
                    const colors = getPriorityColor(getWaitPriority(c.scheduledAt));
                    const complaint = Array.isArray(c.symptoms) ? c.symptoms.join(', ') : (c.chiefComplaint || c.reason || '');
                    return (
                      <li key={c.consultationId} className={`flex items-center justify-between gap-3 py-3 pl-3 border-l-4 ${colors.border}`}>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate dark:text-gray-100">{patientLabel(c)}</p>
                          <p className="text-xs text-gray-500 truncate dark:text-gray-400">
                            {formatDate(c.scheduledAt)}
                            {c.type ? ` · ${c.type === 'video' ? 'Video' : c.type === 'chat' ? 'Chat' : 'In-person'}` : ''}
                            {complaint ? ` · ${complaint}` : ''}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant={c.doctorId ? 'outline' : 'primary'}
                          disabled={!c.doctorId && availability.credentialBlocked}
                          onClick={() => setSelectedConsultation(c)}
                        >
                          {c.doctorId ? 'Open' : 'Claim'}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState
                  icon={<ClipboardList className="w-6 h-6 text-gray-400" aria-hidden="true" />}
                  title="No pending consultations"
                  description="New bookings and claimed queue patients will appear here."
                />
              )}
            </CardContent>
          </Card>

          {/* Queue Management */}
          <Card>
            <CardHeader>
              <CardTitle>Waiting Queue</CardTitle>
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
                <CardTitle>Patient Results</CardTitle>
                <ComplianceBadges size="sm" />
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-gray-300">
                  Lab: {completedLabCount} done · {pendingLabCount} pending
                </span>
                <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-gray-300">
                  Radiology: {completedRadCount} done · {pendingRadCount} pending
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {((results.labOrders?.length || 0) + (results.radiologyOrders?.length || 0)) > 0 ? (
                <ul className="divide-y divide-gray-100 dark:divide-slate-800">
                  {(results.labOrders || []).slice(0, 5).map((order: any) => (
                    <li key={order.orderId || order.labOrderId} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          <span className="text-xs font-semibold text-gray-500 mr-2 dark:text-gray-400">LAB</span>
                          {order.tests?.map((t: any) => t.name || t.testName).join(', ') || 'Lab Order'}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{order.patientName || order.patientId?.substring(0, 8)}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${order.status === 'completed' ? 'bg-green-100 text-green-700' :
                        order.status === 'processing' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>{order.status}</span>
                    </li>
                  ))}
                  {(results.radiologyOrders || []).slice(0, 5).map((order: any) => (
                    <li key={order.orderId || order.radiologyOrderId} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          <span className="text-xs font-semibold text-gray-500 mr-2 dark:text-gray-400">RAD</span>
                          {order.examType || order.studyType || 'Radiology Order'}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{order.patientName || order.patientId?.substring(0, 8)}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${order.status === 'completed' ? 'bg-green-100 text-green-700' :
                        order.status === 'scheduled' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>{order.status}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-gray-500 text-center py-6 text-sm dark:text-gray-400">No patient results yet</p>
              )}
            </CardContent>
          </Card>

          {/* Outcomes Intelligence */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
              <CardTitle>Outcomes Intelligence</CardTitle>
              <span className={`text-xs font-semibold px-2 py-1 rounded ${outcomes.length > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                {outcomes.length > 0 ? 'Feedback loop active' : 'Learning phase'}
              </span>
            </CardHeader>
            <CardContent>
              {outcomes.length > 0 ? (
                <div className="space-y-3">
                  {outcomes.map((o: any) => (
                    <div key={o.outcomeId} className="p-4 border border-gray-100 rounded-xl dark:border-slate-800">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded capitalize ${o.improvementStatus === 'significant' ? 'bg-green-100 text-green-700' :
                            o.improvementStatus === 'moderate' ? 'bg-blue-100 text-blue-700' :
                              o.improvementStatus === 'worsened' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'
                            }`}>
                            {o.improvementStatus} improvement
                          </span>
                          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">Day {o.followUpDay}</span>
                        </div>
                        <Link href={`/consultations/${o.consultationId}`} className="text-xs text-green-700 hover:underline dark:text-green-400">
                          View Consultation
                        </Link>
                      </div>
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Diagnosis: {o.diagnosis}</p>
                      {o.patientNotes && (
                        <p className="text-xs text-gray-500 mt-1 italic dark:text-gray-400">&quot;{o.patientNotes}&quot;</p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500 dark:text-gray-400">
                        <div><span className="font-semibold">Initial symptoms:</span> {o.initialSymptoms?.join(', ')}</div>
                        <div><span className="font-semibold">Treatment:</span> {o.treatment?.substring(0, 50)}{o.treatment?.length > 50 ? '…' : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      Follow-up outcomes appear here after the Day 3, 7 and 15 check-ins.
                    </p>
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">{readinessScore}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-slate-700">
                    <div className="bg-green-600 h-1.5 rounded-full transition-all" style={{ width: `${readinessScore}%` }} />
                  </div>
                  {(readinessData.insights || []).length > 0 && (
                    <ul className="text-xs text-gray-600 space-y-1 dark:text-gray-300">
                      {readinessData.insights.map((insight, idx) => (
                        <li key={idx}>• {insight}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* AI tools — on demand, not always expanded */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
              <CardTitle>AI Tools</CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={handleMagicFill} disabled={prefillLoading}>
                  {prefillLoading ? 'Generating…' : 'Magic Fill'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowScanner((v) => !v)} aria-expanded={showScanner}>
                  {showScanner ? 'Hide Clinical Scanner' : 'Clinical Scanner'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Magic Fill drafts documentation for your pending consultations. The Clinical Scanner reads images, lab papers and medicine packs.
              </p>
              {prefillError && (
                <p className="text-sm text-red-600 font-medium">{prefillError}</p>
              )}
              {prefillSuggestion && (
                <div className="p-3 bg-gray-50 border border-gray-200 rounded-xl space-y-2 dark:bg-slate-800 dark:border-slate-700">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">AI suggested note (review before use)</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{prefillSuggestion}</p>
                  <Button size="sm" variant="outline" onClick={() => setPrefillSuggestion(null)}>
                    Discard
                  </Button>
                </div>
              )}
              {showScanner && <MetaMultimodalScanner defaultTab="vision" />}
            </CardContent>
          </Card>
        </div>

        <aside className="w-full lg:w-80 xl:w-96 flex-shrink-0 space-y-6">
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
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                {primaryActions.map((a) => (
                  <Link key={a.href} href={a.href} className="block">
                    <Button className="w-full text-xs" variant="outline">{a.label}</Button>
                  </Link>
                ))}
              </div>
              <nav aria-label="Doctor tools" className="border-t border-gray-100 pt-2 dark:border-slate-800">
                {moreLinks.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="flex items-center justify-between rounded-lg px-2 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-slate-800"
                  >
                    <span>{l.label}</span>
                    {l.badge ? (
                      <span className="bg-red-500 text-white text-xs rounded-full min-w-5 h-5 px-1.5 flex items-center justify-center">
                        {l.badge > 9 ? '9+' : l.badge}
                      </span>
                    ) : (
                      <span aria-hidden="true" className="text-gray-400">›</span>
                    )}
                  </Link>
                ))}
              </nav>
            </CardContent>
          </Card>

          <DashboardAIAssistant />

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 bg-green-100 rounded-full flex items-center justify-center dark:bg-green-900/30">
                  <span className="text-green-700 font-semibold">
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
        </aside>
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
