'use client';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { useEffect, useState, useMemo, Suspense } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth.store';
import { withRoleGuard } from '@/components/shared/withRoleGuard';
import { PreConsultModal } from '@/components/dashboard/PreConsultModal';
import DoctorClaimQueue from '@/components/dashboard/DoctorClaimQueue';
import AgendaList from '@/components/scheduling/AgendaList';
import { DoctorActionBar } from '@/components/dashboard/DoctorActionBar';
import { DoctorQuickActions } from '@/components/dashboard/DoctorQuickActions';
import { DoctorCoPilotCard } from '@/components/dashboard/DoctorCoPilotCard';
import { MagicFillInline } from '@/components/dashboard/MagicFillInline';
import { DoctorResultsSection } from '@/components/dashboard/DoctorResultsSection';
import { OutcomesIntelligenceCard } from '@/components/dashboard/OutcomesIntelligenceCard';
import { AIClinicalToolsSection } from '@/components/dashboard/AIClinicalToolsSection';
import { initialsOf, summarizeDoctorWork, type ConsultationRow } from '@/components/dashboard/doctorDashboardSummary';
import { doctorApi, consultationApi, messagingApi, practiceApi } from '@/services/api';
import { setIndependentPracticeHint } from '@/lib/roleHome';
import { isPracticeOrFacilitylessDoctor } from '@/lib/practiceContext';
import { readErrorMessage } from '@/lib/accessError';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/LoadingStates';
import { toast } from 'react-toastify';
import { AvailabilityPill, useDoctorAvailability } from '@/components/shared/AvailabilityPill';
import { CREDENTIAL_HOME } from '@/lib/credentialGate';

const WaitlistManager = dynamic(() => import('@/components/shared/WaitlistManager'), { ssr: false });
// The hackathon scanner is large and no longer part of the default flow: it is
// loaded only when the "AI clinical tools" section is opened.
const MetaMultimodalScanner = dynamic(
  () => import('@/components/ai/MetaMultimodalScanner').then((m) => m.MetaMultimodalScanner),
  { ssr: false },
);

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function DoctorDashboard() {
  const { user } = useAuthStore();
  const [allConsultations, setAllConsultations] = useState<ConsultationRow[]>([]);
  const [pendingConsultations, setPendingConsultations] = useState<ConsultationRow[]>([]);
  const [outcomes, setOutcomes] = useState<any[]>([]);
  const [readinessData, setReadinessData] = useState<{ score: number; insights: string[] }>({ score: 0, insights: [] });
  const [results, setResults] = useState<{ labOrders: any[]; radiologyOrders: any[] }>({ labOrders: [], radiologyOrders: [] });
  // Availability is server truth, hydrated by `useDoctorAvailability`
  // (GET /doctors/me/profile). It starts UNKNOWN — never "Available" — so the
  // pill can no longer claim the doctor is online before/without hydration, and
  // it renders forced-off + disabled when the credential wall returns
  // 403 CREDENTIAL_REQUIRED.
  const availability = useDoctorAvailability(true);
  const profile = availability.profile;
  const [loading, setLoading] = useState(true);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [claimingNext, setClaimingNext] = useState(false);
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

  useEffect(() => {
    loadDashboardData();
    loadOutcomes();
    loadResults();
    loadUnreadMessages();
  }, []);

  const loadDashboardData = async () => {
    try {
      const [all, pending] = await Promise.all([
        doctorApi.getConsultations(),
        doctorApi.getConsultations({ status: 'pending' }),
      ]);
      setAllConsultations(all.data.data || []);
      setPendingConsultations(pending.data.data || []);
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

  // Real workload: only this doctor's own consultations count as "mine".
  const summary = useMemo(
    () => summarizeDoctorWork(allConsultations, pendingConsultations, user?.userId),
    [allConsultations, pendingConsultations, user?.userId],
  );

  const handleNextPatient = async () => {
    const cid = summary.next?.consultationId;
    if (!cid) return;
    setClaimingNext(true);
    try {
      await consultationApi.claim(cid);
      router.push(`/consultations/${cid}`);
    } catch (err: any) {
      toast.error(readErrorMessage(err?.response?.data) || 'Could not claim this consultation');
    } finally {
      setClaimingNext(false);
    }
  };

  if (loading) return <PageLoading message="Loading doctor dashboard..." />;

  // Header = honest indicator; the switch lives in the action bar below
  // (one state object, so the two can never disagree).
  const headerActions = <AvailabilityPill state={availability} showSwitch={false} className="mr-4" />;
  const lastName = user?.profile?.lastName || user?.profile?.firstName || '';

  return (
    <DashboardShell
      title="Clinical Command Center"
      actions={headerActions}
      subtitle={profile?.doctorType && (
        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-200">
          {profile.doctorType === 'platform' ? 'Platform doctor' : 'Facility doctor'}
        </span>
      )}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          {/* Professional License & Credential Gate Banner (if blocked) */}
          {availability.credentialBlocked && (
            <div
              data-testid="doctor-credential-status-banner"
              className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div>
                <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                  Professional License Verification Required to Claim New Patients
                </p>
                <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                  {availability.credentialMessage || 'Your MDCN / professional practicing license is currently pending verification or incomplete. You can view your dashboard, but claiming waiting patients requires a verified credential.'}
                </p>
              </div>
              <Link href={CREDENTIAL_HOME} className="shrink-0">
                <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white whitespace-nowrap">
                  Verify License &amp; Credentials →
                </Button>
              </Link>
            </div>
          )}

          <DoctorActionBar
            greeting={`${getGreeting()}, Dr. ${lastName}`}
            dateLabel={new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            summary={summary}
            availability={availability}
            onNextPatient={handleNextPatient}
            claiming={claimingNext}
          />

          {/* Queue: patients this doctor can claim, then the telehealth queue board. */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">📊 Queue Management</h2>
              <MagicFillInline className="sm:text-right" />
            </div>
            <div className="mb-6">
              <DoctorClaimQueue />
            </div>
            <Suspense fallback={
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
                <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading queue...</span>
              </div>
            }>
              <WaitlistManager />
            </Suspense>
          </Card>

          {/* Agenda: booked visits for the day — the booked doctor serves them; the
              bridge lands them here as `accepted` at T-0 with "Start consultation". */}
          <section className="rounded-2xl bg-white dark:bg-slate-800 ring-1 ring-gray-100 dark:ring-slate-700 px-4 py-3">
            <AgendaList title="Booked visits" showDoctor={false} emptyText="No booked visits for the day." compact />
          </section>

          <DoctorResultsSection results={results} />

          <OutcomesIntelligenceCard
            outcomes={outcomes}
            readinessScore={readinessData.score}
            insights={readinessData.insights}
            completedConsultations={summary.completed}
          />

          {/* Meta Multimodal Clinical AI Scanner (SAM 3.1 Vision, NAFDAC Gate & 2-Way
              Voice Segregation). Kept INSIDE the main clinical column (as a third
              flex child it once collapsed this column to 0px) but collapsed by
              default so it is reachable without being the first thing seen. */}
          <AIClinicalToolsSection>
            <MetaMultimodalScanner defaultTab="vision" />
          </AIClinicalToolsSection>
        </div>

        <aside className="min-w-0 space-y-4">
          <DoctorCoPilotCard />
          <DoctorQuickActions
            unreadMessages={unreadMessages}
            showPractice={isPracticeOrFacilitylessDoctor(user)}
            showHospital={!!user?.facilityId && !isPracticeOrFacilitylessDoctor(user)}
          />
          <div className="rounded-2xl bg-white dark:bg-slate-800 ring-1 ring-gray-100 dark:ring-slate-700 shadow-card p-4 flex items-center gap-3">
            <div
              aria-hidden="true"
              className="w-10 h-10 shrink-0 bg-green-100 rounded-full flex items-center justify-center text-sm font-bold leading-none text-green-700 dark:bg-green-900/30 dark:text-green-300"
            >
              {initialsOf(user?.profile?.firstName, user?.profile?.lastName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">Dr. {user?.profile?.firstName} {user?.profile?.lastName}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{profile?.specialization || 'General Practice'}</p>
            </div>
            <Link href="/profile" className="text-xs font-medium text-green-700 dark:text-green-400 hover:underline">
              Profile
            </Link>
          </div>
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
                toast.error(readErrorMessage(err?.response?.data) || 'Could not claim this consultation');
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
