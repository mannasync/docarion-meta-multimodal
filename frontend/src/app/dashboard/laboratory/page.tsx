'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth.store';
import { LabValidationReadinessBanner } from '@/components/staff-identity/ResultReleaseReadinessBanner';
import FacilityOnboardingChecklist from '@/components/onboarding/FacilityOnboardingChecklist';
import { labApi, labDeskApi } from '@/services/api';
import PosTerminal from '@/components/pos/PosTerminal';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { toast } from 'react-toastify';
import { ComplianceBadges } from '@/components/ui/TrustBadge';
import { DataTable, Column } from '@/components/ui/DataTable';
import { AdvancedFilterBar } from '@/components/shared/AdvancedFilterBar';
import { LabOrderExpandedRow } from './LabOrderExpandedRow';
import { DashboardAIAssistant } from '@/components/shared/DashboardAIAssistant';
import { MetaMultimodalScanner } from '@/components/ai/MetaMultimodalScanner';
import {
    PatientSearchBeforeCreate,
    PatientSearchGateResult,
} from '@/components/identifier/PatientSearchBeforeCreate';
import { ErrorState } from '@/components/ui/ErrorState';
import { withRoleGuard } from '@/components/shared/withRoleGuard';

interface LabOrder {
    orderId: string; patientId?: string; patientName?: string; status: string;
    labRequestNumber?: string;
    tests?: { testId: string; name: string; code: string; price: number }[];
    testName?: string;
    priority?: string; createdAt?: string; referringFacilityId?: string;
}

const calculateTAT = (orders: LabOrder[], priority: string) => {
    // Only orders with both timestamps count: substituting "now" for a missing
    // completedAt inflated the average every time the page was opened.
    const relevant = orders.filter(o =>
        (o.priority || 'routine').toLowerCase() === priority.toLowerCase()
        && o.status === 'completed' && o.createdAt && (o as any).completedAt);
    if (relevant.length === 0) return '—';
    const totalMs = relevant.reduce(
        (sum, o) => sum + (new Date((o as any).completedAt).getTime() - new Date(o.createdAt as any).getTime()), 0);
    const avgMinutes = Math.max(0, totalMs / relevant.length / 60000);
    if (avgMinutes >= 60) return `${(avgMinutes / 60).toFixed(1)}h`;
    return `${Math.round(avgMinutes)}m`;
};

function LaboratoryDashboard() {
    const { user } = useAuthStore();
    const isAdmin = user?.role === 'lab_admin';
    const [orders, setOrders] = useState<LabOrder[]>([]);
    const [stats, setStats] = useState({ pending: 0, processing: 0, completed: 0, rejected: 0 });
    const [analytics, setAnalytics] = useState<any>(null);
    const [alerts, setAlerts] = useState<any[]>([]);
    const [filters, setFilters] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const facilityId = user?.facilityId || '';

    const load = useCallback(async () => {
        if (!facilityId) {
            setLoadError('This account is not linked to a laboratory yet.');
            setLoading(false);
            return;
        }
        setLoading(true);
        setLoadError('');
        try {
            const [ordersRes, ...extras] = await Promise.all([
                labApi.getOrders(facilityId),
                ...(isAdmin ? [labApi.getAnalytics(facilityId), labApi.getCriticalAlerts(facilityId)] : []),
            ]);
            const allOrders: LabOrder[] = ordersRes.data.data || [];
            setOrders(allOrders);
            setStats({
                pending: allOrders.filter(o => o.status === 'pending').length,
                processing: allOrders.filter(o => ['sample_collected', 'processing', 'awaiting_validation'].includes(o.status)).length,
                completed: allOrders.filter(o => o.status === 'completed').length,
                rejected: allOrders.filter(o => o.status === 'sample_rejected').length,
            });
            if (isAdmin && extras[0]) setAnalytics(extras[0].data.data);
            if (isAdmin && extras[1]) setAlerts((extras[1].data.data || []).filter((a: any) => !a.acknowledgedAt));
        } catch {
            setLoadError('Laboratory queues could not be loaded. No placeholder orders are shown.');
            toast.error('Failed to load data');
        }
        finally { setLoading(false); }
    }, [facilityId, isAdmin]);

    useEffect(() => { load(); }, [load]);

    const [updatingOrders, setUpdatingOrders] = useState<Set<string>>(new Set());

    const handleStatusUpdate = async (orderId: string, status: string) => {
        setUpdatingOrders(prev => new Set(prev).add(orderId));
        try {
            await labApi.updateOrderStatus(orderId, status);
            toast.success(status === 'sample_collected' ? 'Sample collected' : 'Status updated');
            load();
        } catch { toast.error('Failed to update order'); }
        finally {
            setUpdatingOrders(prev => {
                const next = new Set(prev);
                next.delete(orderId);
                return next;
            });
        }
    };

    const handleRejectSample = async (orderId: string) => {
        const reason = prompt('Rejection reason:');
        if (!reason) return;
        setUpdatingOrders(prev => new Set(prev).add(orderId));
        try {
            await labApi.rejectSample(orderId, reason);
            toast.success('Sample rejected');
            load();
        } catch { toast.error('Failed to reject sample'); }
        finally {
            setUpdatingOrders(prev => {
                const next = new Set(prev);
                next.delete(orderId);
                return next;
            });
        }
    };

    // ── Front-desk walk-in order intake + result validation gate ──
    const [showWalkIn, setShowWalkIn] = useState(false);
    const [walkInForm, setWalkInForm] = useState({ name: '', phone: '', email: '', tests: [{ name: '', price: '' }] });
    const [identityGate, setIdentityGate] = useState<PatientSearchGateResult>({
        ready: false,
        searched: false,
        selectedPatientId: null,
        candidateCount: 0,
    });
    const [creatingOrder, setCreatingOrder] = useState(false);
    const [chargeOrder, setChargeOrder] = useState<{ patientName: string; items: any[] } | null>(null);

    const handleCreateWalkInOrder = async (e: React.FormEvent) => {
        e.preventDefault();
        const tests = walkInForm.tests
            .filter(t => t.name.trim())
            .map(t => ({ name: t.name.trim(), price: Number(t.price) || 0 }));
        if (!walkInForm.name.trim() || tests.length === 0) { toast.error('Enter a patient name and at least one test'); return; }
        if (!identityGate.ready) { toast.error('Search existing patient records before creating this order'); return; }
        setCreatingOrder(true);
        try {
            const patient = identityGate.selectedPatientId
                ? { patientId: identityGate.selectedPatientId }
                : { walkIn: { name: walkInForm.name.trim(), phone: walkInForm.phone.trim(), email: walkInForm.email.trim() } };
            const res = await labDeskApi.createOrder(facilityId, { ...patient, tests });
            const suggested = res.data?.suggestedSale;
            toast.success('Walk-in order created');
            setShowWalkIn(false);
            setWalkInForm({ name: '', phone: '', email: '', tests: [{ name: '', price: '' }] });
            load();
            if (suggested) setChargeOrder({ patientName: walkInForm.name.trim(), items: suggested.items });
        } catch (err: any) {
            toast.error(err?.response?.data?.error || 'Failed to create order');
        } finally { setCreatingOrder(false); }
    };

    const [validatingId, setValidatingId] = useState<string | null>(null);
    const handleValidate = async (orderId: string) => {
        setValidatingId(orderId);
        try {
            await labDeskApi.validate(orderId);
            toast.success('Results validated and released');
            load();
        } catch (err: any) {
            toast.error(err?.response?.data?.error || 'Failed to validate results');
        } finally { setValidatingId(null); }
    };

    const priorityBadge: Record<string, string> = {
        routine: 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300', urgent: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300', stat: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    };
    const statusBadge: Record<string, string> = {
        pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300', sample_collected: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
        processing: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300', completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
        sample_rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
        awaiting_validation: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    };

    const filteredOrders = orders.filter(o => o.status !== 'completed').filter(o => {
        if (filters.search) {
            const term = filters.search.toLowerCase();
            if (!o.orderId.toLowerCase().includes(term) && !(o.patientName || '').toLowerCase().includes(term)) return false;
        }
        if (filters.priority && (o.priority || '').toLowerCase() !== filters.priority.toLowerCase()) return false;
        return true;
    });

    const columns: Column<LabOrder>[] = [
        { header: 'Order number', accessorKey: 'orderId', cell: (o) => <span className="font-medium">{o.labRequestNumber || `#${o.orderId.slice(0, 8)}`}</span> },
        { header: 'Patient', accessorKey: 'patientName', cell: (o) => o.patientName || 'Unknown' },
        { header: 'Priority', accessorKey: 'priority', cell: (o) => <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${priorityBadge[(o.priority || '').toLowerCase()] || priorityBadge.routine}`}>{o.priority}</span> },
        { header: 'Tests', accessorKey: 'tests', cell: (o) => <div className="flex flex-wrap gap-1">{(o.tests || (o.testName ? [{ testId: 'unknown', name: o.testName, code: 'N/A', price: 0 }] : [])).map((t, i) => <span key={i} className="text-xs bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 px-2.5 py-0.5 rounded-full">{t.name}</span>)}</div> },
        { header: 'Status', accessorKey: 'status', cell: (o) => <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${statusBadge[o.status] || 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300'}`}>{o.status.replace(/_/g, ' ')}</span> },
        { header: 'Actions', accessorKey: 'actions', cell: (o) => (
            <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                {o.status === 'pending' && (
                    <>
                        <Button size="sm" disabled={updatingOrders.has(o.orderId)} onClick={() => handleStatusUpdate(o.orderId, 'sample_collected')}>Collect Sample</Button>
                        <Button size="sm" variant="outline" disabled={updatingOrders.has(o.orderId)} className="text-red-600 border-red-200" onClick={() => handleRejectSample(o.orderId)}>Reject</Button>
                    </>
                )}
                {o.status === 'sample_collected' && (
                    <Button size="sm" disabled={updatingOrders.has(o.orderId)} onClick={() => handleStatusUpdate(o.orderId, 'processing')}>Start Processing</Button>
                )}
                {o.status === 'processing' && (
                    <Link href={`/lab-results/upload/${o.orderId}`}><Button size="sm" disabled={updatingOrders.has(o.orderId)}>Upload Results</Button></Link>
                )}
                {o.status === 'awaiting_validation' && (
                    <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white" disabled={validatingId === o.orderId} onClick={() => handleValidate(o.orderId)}>
                        {validatingId === o.orderId ? 'Validating…' : '✓ Validate & release'}
                    </Button>
                )}
                {o.status === 'sample_rejected' && (
                    <span className="text-xs text-red-500 italic">Rejected</span>
                )}
            </div>
        )}
    ];

    return (
        <DashboardShell
            bare
            title="🔬 Laboratory Operations Center"
            subtitle={<>Process orders, track TAT & ensure quality — {isAdmin ? 'Lab Admin' : 'Lab Technician'}</>}
            actions={
                <>
                    {/* Self-contained quick links (inventory + specimen scanning) */}
                    <span className="flex items-center gap-3 mr-1">
                        <a href="/dashboard/laboratory/scan" className="text-sm font-medium text-primary-700 dark:text-primary-400 hover:underline whitespace-nowrap">📷 Scan specimen</a>
                        <a href="/dashboard/laboratory/inventory" className="text-sm font-medium text-primary-700 dark:text-primary-400 hover:underline whitespace-nowrap">📦 Inventory</a>
                        {isAdmin && <a href="/staff" className="text-sm font-medium text-primary-700 dark:text-primary-400 hover:underline whitespace-nowrap">👥 Identity & Access</a>}
                    </span>
                    <Button size="sm" className="whitespace-nowrap" onClick={() => setShowWalkIn(true)}>➕ New walk-in order</Button>
                </>
            }
        >

            <div className="container mx-auto px-4 py-6 md:px-6 space-y-6">
                {/* Onboarding gate: who can release validated results at this lab. */}
                <LabValidationReadinessBanner facilityId={facilityId} role={user?.role || ''} />
                {isAdmin && facilityId && <FacilityOnboardingChecklist facilityId={facilityId} />}

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-6 gap-4 animate-fade-in-up">
                    <MetricCard title="Pending" value={stats.pending} colorScheme="yellow" />
                    <MetricCard title="Processing" value={stats.processing} colorScheme="purple" />
                    <MetricCard title="Completed" value={stats.completed} colorScheme="green" />
                    <MetricCard title={isAdmin ? 'Rejection Rate' : 'Rejected'} value={isAdmin && analytics ? `${analytics.rejectionRate}%` : stats.rejected} colorScheme="red" />
                    <MetricCard title="Routine TAT" value={calculateTAT(orders, 'routine')} colorScheme="blue" />
                    <MetricCard title="Stat TAT" value={calculateTAT(orders, 'stat')} colorScheme="red" />
                </div>

                {/* Critical Alerts Banner (Admin Only) */}
                {isAdmin && alerts.length > 0 && (
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-4 shadow-card animate-fade-in" role="alert">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">🚨</span>
                                <div>
                                    <p className="font-semibold text-red-800 dark:text-red-300">{alerts.length} Unacknowledged Critical Alert{alerts.length > 1 ? 's' : ''}</p>
                                    <p className="text-sm text-red-600 dark:text-red-400">{alerts[0]?.testName}: {alerts[0]?.value} {alerts[0]?.unit}</p>
                                </div>
                            </div>
                            <Link href="/lab-alerts"><Button size="sm" className="bg-red-600 hover:bg-red-700 text-white">View Alerts</Button></Link>
                        </div>
                    </div>
                )}

                {/* Quick Actions */}
                <div className={`grid grid-cols-2 ${isAdmin ? 'sm:grid-cols-6' : 'sm:grid-cols-3'} gap-3`}>
                    {/* /lab-results is the PATIENT results page; lab staff track critical values here. */}
                    <Link href="/lab-alerts"><Button variant="outline" className="w-full h-16 flex-col rounded-xl hover:shadow-card-hover hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-200">
                        <span className="text-xl" aria-hidden="true">🚨</span><span className="text-xs">Alerts</span>
                    </Button></Link>
                    <Link href="/patients"><Button variant="outline" className="w-full h-16 flex-col rounded-xl hover:shadow-card-hover hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-200">
                        <span className="text-xl" aria-hidden="true">👥</span><span className="text-xs">Patients</span>
                    </Button></Link>
                    {isAdmin && (
                        <>
                            <Link href="/lab-catalog"><Button variant="outline" className="w-full h-16 flex-col rounded-xl bg-blue-50 border-blue-200 hover:bg-blue-100 hover:shadow-card-hover hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-200 dark:bg-blue-900/20">
                                <span className="text-xl" aria-hidden="true">🧪</span><span className="text-xs font-semibold text-blue-700">Catalog</span>
                            </Button></Link>
                            <Link href="/lab-qc"><Button variant="outline" className="w-full h-16 flex-col rounded-xl hover:shadow-card-hover hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-200">
                                <span className="text-xl" aria-hidden="true">📊</span><span className="text-xs">QC</span>
                            </Button></Link>
                            <Link href="/lab-analytics"><Button variant="outline" className="w-full h-16 flex-col rounded-xl bg-purple-50 border-purple-200 hover:bg-purple-100 hover:shadow-card-hover hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-200 dark:bg-purple-900/20">
                                <span className="text-xl" aria-hidden="true">📈</span><span className="text-xs font-semibold text-purple-700">Analytics</span>
                            </Button></Link>
                        </>
                    )}
                    {!isAdmin && (
                        <Link href="/lab-qc"><Button variant="outline" className="w-full h-16 flex-col rounded-xl hover:shadow-card-hover hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-200">
                            <span className="text-xl" aria-hidden="true">📊</span><span className="text-xs">QC Run</span>
                        </Button></Link>
                    )}
                    {isAdmin && (
                        <Link href="/dashboard/facility/payments"><Button variant="outline" className="w-full h-16 flex-col rounded-xl hover:shadow-card-hover hover:-translate-y-0.5 active:scale-[0.98] transition-all duration-200">
                            <span className="text-xl" aria-hidden="true">💰</span><span className="text-xs">Earnings</span>
                        </Button></Link>
                    )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                    <div className="lg:col-span-8 space-y-6">
                        {/* Orders Queue */}
                        <Card>
                    <CardHeader>
                        <div className="flex justify-between items-center">
                            <CardTitle>Lab Orders Queue</CardTitle>
                            <Button size="sm" variant="ghost" onClick={load}>↻ Refresh</Button>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="skeleton h-24 rounded-xl" />)}</div>
                        ) : loadError ? (
                            <ErrorState
                                title="Lab queue unavailable"
                                message={loadError}
                                onRetry={load}
                            />
                        ) : orders.filter(o => o.status !== 'completed').length > 0 ? (
                            <div className="space-y-4">
                                <AdvancedFilterBar 
                                    onFilterChange={setFilters} 
                                    options={{ priorities: [{label: 'Routine', value: 'routine'}, {label: 'Urgent', value: 'urgent'}, {label: 'Stat', value: 'stat'}] }} 
                                />
                                {filteredOrders.length > 0 ? (
                                    <DataTable 
                                        data={filteredOrders} 
                                        columns={columns} 
                                        keyExtractor={o => o.orderId}
                                        renderExpandedRow={o => <LabOrderExpandedRow order={o} />}
                                    />
                                ) : (
                                    <div className="text-center py-8 animate-fade-in">
                                        <p className="text-gray-500 dark:text-gray-400">No lab orders match filters</p>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <EmptyState
                                icon={<span aria-hidden="true">🔬</span>}
                                title="No lab orders in queue"
                            />
                        )}
                    </CardContent>
                </Card>
                    </div>
                    <div className="lg:col-span-4 space-y-6">
                        <DashboardAIAssistant />
                    </div>
                    <div className="lg:col-span-12 mt-4">
                        <MetaMultimodalScanner defaultTab="vision" />
                    </div>
                    <div className="lg:col-span-12 mt-4">
                        <ComplianceBadges />
                    </div>
                </div>
            </div>

            {/* New walk-in order modal */}
            {showWalkIn && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-popup-overlay="true" onClick={() => setShowWalkIn(false)}>
                    <div role="dialog" className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 p-5 max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                        <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">New walk-in order</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Register a walk-in patient and the tests they need, then charge at the desk.</p>
                        <form onSubmit={handleCreateWalkInOrder} className="space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <input className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-slate-900/40 text-gray-900 dark:text-gray-100" placeholder="Patient name" value={walkInForm.name} onChange={e => setWalkInForm({ ...walkInForm, name: e.target.value })} required />
                                <input className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-slate-900/40 text-gray-900 dark:text-gray-100" placeholder="Phone" value={walkInForm.phone} onChange={e => setWalkInForm({ ...walkInForm, phone: e.target.value })} />
                                <input className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-slate-900/40 text-gray-900 dark:text-gray-100" placeholder="Email (optional)" value={walkInForm.email} onChange={e => setWalkInForm({ ...walkInForm, email: e.target.value })} />
                            </div>
                            <PatientSearchBeforeCreate
                                demographics={{
                                    firstName: walkInForm.name.trim().split(/\s+/)[0] || '',
                                    lastName: walkInForm.name.trim().split(/\s+/).slice(1).join(' '),
                                    phone: walkInForm.phone,
                                    email: walkInForm.email,
                                }}
                                onGateChange={setIdentityGate}
                                allowExistingSelection
                            />
                            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">Tests</p>
                            {walkInForm.tests.map((t, i) => (
                                <div key={i} className="flex gap-2">
                                    <input className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-slate-900/40 text-gray-900 dark:text-gray-100" placeholder="Test name" value={t.name} onChange={e => { const tests = [...walkInForm.tests]; tests[i].name = e.target.value; setWalkInForm({ ...walkInForm, tests }); }} />
                                    <input className="w-28 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-slate-900/40 text-gray-900 dark:text-gray-100" placeholder="Price" inputMode="decimal" value={t.price} onChange={e => { const tests = [...walkInForm.tests]; tests[i].price = e.target.value; setWalkInForm({ ...walkInForm, tests }); }} />
                                    {walkInForm.tests.length > 1 && <button type="button" className="text-gray-400 hover:text-red-500 dark:text-gray-500" onClick={() => setWalkInForm({ ...walkInForm, tests: walkInForm.tests.filter((_, idx) => idx !== i) })}>✕</button>}
                                </div>
                            ))}
                            <Button type="button" variant="outline" size="sm" onClick={() => setWalkInForm({ ...walkInForm, tests: [...walkInForm.tests, { name: '', price: '' }] })}>+ Add test</Button>
                            <div className="flex gap-2 justify-end pt-2">
                                <Button type="button" variant="ghost" onClick={() => setShowWalkIn(false)}>Cancel</Button>
                                <Button type="submit" isLoading={creatingOrder} disabled={!identityGate.ready}>Create order</Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Charge the created walk-in order via POS */}
            {chargeOrder && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-popup-overlay="true" onClick={() => setChargeOrder(null)}>
                    <div role="dialog" className="w-full max-w-4xl rounded-2xl bg-white dark:bg-slate-900 p-5 max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Charge order — {chargeOrder.patientName}</h2>
                            <button aria-label="Close" className="text-gray-400 hover:text-gray-700 dark:hover:text-white text-xl" onClick={() => setChargeOrder(null)}>✕</button>
                        </div>
                        <PosTerminal
                            customerName={chargeOrder.patientName}
                            seedItems={chargeOrder.items}
                            onComplete={() => { toast.success('Payment recorded'); setChargeOrder(null); }}
                        />
                    </div>
                </div>
            )}
        </DashboardShell>
    );
}

export default withRoleGuard(LaboratoryDashboard, ['lab_technician', 'lab_admin', 'super_admin']);
