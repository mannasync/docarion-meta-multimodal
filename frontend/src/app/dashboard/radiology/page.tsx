'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { radiologyApi, radImagingApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { toast } from 'react-toastify';
import { ComplianceBadges } from '@/components/ui/TrustBadge';
import DashboardSkeleton from '@/components/ui/LoadingStates';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { withRoleGuard } from '@/components/shared/withRoleGuard';
import { useAuthStore } from '@/store/auth.store';
import FacilityOnboardingChecklist from '@/components/onboarding/FacilityOnboardingChecklist';
import { DashboardAIAssistant } from '@/components/shared/DashboardAIAssistant';
import { MetaMultimodalScanner } from '@/components/ai/MetaMultimodalScanner';

function RadiologyDashboardPage() {
    const router = useRouter();
    const user = useAuthStore((s) => s.user);
    const [analytics, setAnalytics] = useState<any>(null);
    const [orders, setOrders] = useState<any[]>([]);
    const [tatReport, setTatReport] = useState<any>(null);
    const [contrastStats, setContrastStats] = useState<any>(null);
    const [mwl, setMwl] = useState<any[]>([]);
    const [aiSummary, setAiSummary] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // Imaging upload + gallery (result images; not a full PACS)
    const [imgResultId, setImgResultId] = useState('');
    const [galleryImages, setGalleryImages] = useState<any[]>([]);
    const [uploadingImages, setUploadingImages] = useState(false);
    const [orthancConfigured, setOrthancConfigured] = useState(false);
    const facilityId = user?.facilityId || '';
    const role = user?.role || '';
    const isAdmin = role === 'rad_admin' || role === 'admin' || role === 'super_admin';
    // GET /radiology/:centerId/analytics and /ai-summary are authorized for
    // rad_admin only (super_admin bypasses role checks). Technicians would get
    // a 403 on every load, so skip those admin-only requests for them.
    const canViewCenterInsights = role === 'rad_admin' || role === 'super_admin';

    const load = useCallback(async () => {
        if (!facilityId) { setLoading(false); return; }
        setLoading(true);
        setError(false);
        try {
            const [analyticsRes, ordersRes, tatRes, contrastRes, mwlRes, aiSummaryRes] = await Promise.all([
                canViewCenterInsights ? radiologyApi.getAnalytics(facilityId).catch(() => null) : Promise.resolve(null),
                radiologyApi.getOrders(facilityId),
                isAdmin ? radiologyApi.getTatReport(facilityId).catch(() => null) : Promise.resolve(null),
                isAdmin ? radiologyApi.getContrastStats(facilityId).catch(() => null) : Promise.resolve(null),
                radiologyApi.getMwl(facilityId).catch(() => null),
                canViewCenterInsights ? radiologyApi.getAiSummary(facilityId).catch(() => null) : Promise.resolve(null),
            ]);
            if (analyticsRes) setAnalytics(analyticsRes.data.data);
            setOrders(ordersRes.data.data || []);
            if (tatRes) setTatReport(tatRes.data.data);
            if (contrastRes) setContrastStats(contrastRes.data.data);
            if (mwlRes) setMwl(mwlRes.data.data || []);
            if (aiSummaryRes && aiSummaryRes.data.insight) setAiSummary(aiSummaryRes.data.insight);
        } catch (err) {
            console.error('Failed to load radiology dashboard:', err);
            toast.error('Failed to load radiology dashboard');
            setError(true);
        } finally { setLoading(false); }
    }, [facilityId, isAdmin, canViewCenterInsights]);

    useEffect(() => { load(); }, [load]);

    const completedWithResults = orders.filter((o: any) => o.status === 'completed' && o.resultId);

    const loadGallery = useCallback(async (resultId: string) => {
        if (!resultId) { setGalleryImages([]); return; }
        try {
            const res = await radImagingApi.getImages(resultId);
            setGalleryImages(res.data.data.images || []);
            setOrthancConfigured(!!res.data.data.orthancConfigured);
        } catch {
            setGalleryImages([]);
        }
    }, []);

    useEffect(() => { if (imgResultId) loadGallery(imgResultId); }, [imgResultId, loadGallery]);

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0 || !imgResultId || !facilityId) return;
        setUploadingImages(true);
        try {
            await radImagingApi.uploadImages(facilityId, imgResultId, Array.from(files));
            toast.success('Images uploaded');
            await loadGallery(imgResultId);
        } catch {
            toast.error('Image upload failed');
        } finally {
            setUploadingImages(false);
            e.target.value = '';
        }
    };

    // Derived stats
    const criticalUnnotified = orders.filter((o: any) => {
        // Check if any linked results are critical and unnotified
        return o.status === 'completed' && o.priority === 'stat';
    });
    const pendingPeerReviews = orders.filter((o: any) => o.peerReviewStatus === 'pending').length;

    if (loading) return <div className="min-h-screen bg-gray-50 dark:bg-slate-900"><div className="container mx-auto p-6 space-y-6 pb-24"><DashboardSkeleton /></div></div>;
    if (error) return <div className="min-h-screen bg-gray-50 dark:bg-slate-900"><div className="container mx-auto p-6 space-y-6 pb-24"><ErrorState onRetry={load} /></div></div>;

    return (
        <DashboardShell
            bare
            title="📡 Radiology Imaging Center"
            subtitle="Manage orders, results & compliance across all modalities"
            actions={
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => router.push('/dashboard/radiology/orders')}>📋 Orders</Button>
                            <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/catalog')}>📖 Catalog</Button>
                            <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/results')}>📄 Results</Button>
                            <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/teleradiology')}>📡 Teleradiology</Button>
                            <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/patients')}>👤 Patients</Button>
                            <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/inventory')}>📦 Inventory</Button>
                            {isAdmin && <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/reports')}>📊 Reports</Button>}
                            {isAdmin && <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/staff')}>👥 Staff</Button>}
                            {isAdmin && <Button size="sm" variant="outline" onClick={() => router.push('/dashboard/radiology/settings')}>⚙️ Settings</Button>}
                        </div>
            }
        >

            <div className="container mx-auto px-4 py-6 md:px-6 space-y-6 pb-24">
                {/* Facility setup checklist — the centre's own admin only. */}
                {role === 'rad_admin' && facilityId && <FacilityOnboardingChecklist facilityId={facilityId} />}

                {/* AI Insights Banner */}
                {aiSummary && (
                    <Card className="bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-900/20 dark:to-indigo-900/20 ring-purple-100 dark:ring-purple-800/50 animate-fade-in">
                        <div className="flex items-start gap-3">
                            <span className="text-2xl">✨</span>
                            <div>
                                <h3 className="font-bold text-purple-900 dark:text-purple-300 text-sm">AI Insights</h3>
                                <p className="text-xs text-purple-700 dark:text-purple-300/80 mt-1">{aiSummary}</p>
                            </div>
                        </div>
                    </Card>
                )}

                {/* Alert Banners */}
                {criticalUnnotified.length > 0 && (
                    <Card className="bg-red-50 dark:bg-red-900/20 ring-red-200 dark:ring-red-800 animate-fade-in">
                        <p className="text-sm font-bold text-red-700 dark:text-red-300">🚨 {criticalUnnotified.length} STAT orders require critical notification — ACR compliance</p>
                    </Card>
                )}
                {pendingPeerReviews > 0 && (
                    <Card className="bg-amber-50 dark:bg-amber-900/20 ring-amber-200 dark:ring-amber-800 animate-fade-in">
                        <p className="text-sm font-bold text-amber-700 dark:text-amber-300">👥 {pendingPeerReviews} peer reviews pending</p>
                    </Card>
                )}

                {/* KPI Cards */}
                {analytics && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-in-up">
                        <MetricCard title="Total Orders" value={analytics.totalOrders} colorScheme="blue" />
                        <MetricCard title="Pending" value={analytics.pendingOrders} colorScheme="yellow" />
                        <MetricCard title="Completed Today" value={analytics.completedToday} colorScheme="green" />
                        <MetricCard title="Revenue" value={`₦${(analytics.totalRevenue || 0).toLocaleString()}`} colorScheme="purple" />
                    </div>
                )}

                {/* TAT Report */}
                {tatReport && tatReport.modalityStats?.length > 0 && (
                    <Card>
                        <h3 className="font-semibold text-gray-900 dark:text-white tracking-snug mb-3">⏱️ Turnaround Time (TAT) by Modality</h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            {tatReport.modalityStats.map((stat: any) => (
                                <div key={stat.modality} className="p-3 bg-gray-50 dark:bg-slate-700/50 rounded-xl text-center transition-all duration-200 hover:shadow-card">
                                    <p className="text-sm font-medium capitalize text-gray-700 dark:text-gray-200">{stat.modality.replace('_', ' ')}</p>
                                    <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stat.avgMinutes}<span className="text-xs text-gray-500 dark:text-gray-400">min</span></p>
                                    <div className="flex justify-between text-[10px] text-gray-500 mt-1 dark:text-gray-400">
                                        <span>Min: {stat.minMinutes}m</span>
                                        <span>Max: {stat.maxMinutes}m</span>
                                    </div>
                                    {stat.slaBreaches > 0 && (
                                        <span className="text-[10px] bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 px-2 py-0.5 rounded-full mt-1 inline-block">⚠️ {stat.slaBreaches} SLA breach{stat.slaBreaches > 1 ? 'es' : ''}</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </Card>
                )}

                {/* MWL Queue + Contrast Stats Row */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* MWL Queue */}
                    <Card>
                        <h3 className="font-semibold text-gray-900 dark:text-white tracking-snug mb-3">📡 Modality Worklist</h3>
                        {mwl.length === 0 ? (
                            <EmptyState title="No Worklist Entries" description="There are no items currently in the modality worklist." icon="📡" />
                        ) : (
                            <div className="space-y-2">
                                {mwl.slice(0, 5).map((entry: any) => (
                                    <div key={entry.accessionNumber} className="flex items-center justify-between p-2.5 bg-gray-50 dark:bg-slate-700/50 rounded-xl text-sm transition-all duration-200 hover:shadow-card">
                                        <div>
                                            <p className="font-medium text-gray-900 dark:text-white">{entry.accessionNumber}</p>
                                            <p className="text-xs text-gray-500 capitalize dark:text-gray-400">{entry.modality?.replace('_', ' ')} — {entry.studyDescription?.substring(0, 30)}</p>
                                        </div>
                                        <span className={`px-2 py-0.5 text-[10px] rounded-full ${entry.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : entry.status === 'in_progress' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-gray-100 text-gray-600 dark:bg-slate-600 dark:text-gray-300'}`}>{entry.status}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>

                    {/* Contrast Stats */}
                    {contrastStats && (
                        <Card>
                            <h3 className="font-semibold text-gray-900 dark:text-white tracking-snug mb-3">💉 Contrast Analytics</h3>
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm text-gray-700 dark:text-gray-200">
                                    <span>Total contrast studies</span>
                                    <span className="font-bold">{contrastStats.total}</span>
                                </div>
                                <div className="flex justify-between text-sm text-gray-700 dark:text-gray-200">
                                    <span>Reaction rate</span>
                                    <span className="font-bold text-amber-600 dark:text-amber-400">{contrastStats.reactionRate}</span>
                                </div>
                                {Object.entries(contrastStats.bySeverity || {}).map(([severity, count]) => (
                                    <div key={severity} className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                                        <span className="capitalize">{severity}</span>
                                        <span>{count as number}</span>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                </div>

                {/* Modality Breakdown */}
                {analytics?.modalityBreakdown && Object.keys(analytics.modalityBreakdown).length > 0 && (
                    <Card>
                        <h3 className="font-semibold text-gray-900 dark:text-white tracking-snug mb-3">Modality Distribution</h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            {Object.entries(analytics.modalityBreakdown).map(([mod, count]) => (
                                <div key={mod} className="flex justify-between items-center p-2.5 bg-gray-50 dark:bg-slate-700/50 rounded-xl transition-all duration-200 hover:shadow-card">
                                    <span className="text-sm font-medium capitalize text-gray-700 dark:text-gray-200">{mod.replace('_', ' ')}</span>
                                    <span className="text-sm font-bold text-purple-600 dark:text-purple-400">{count as number}</span>
                                </div>
                            ))}
                        </div>
                    </Card>
                )}

                {/* Recent Orders */}
                <Card>
                    <h3 className="font-semibold text-gray-900 dark:text-white tracking-snug mb-3">Recent Orders</h3>
                    {orders.length === 0 ? (
                        <EmptyState title="No Orders Yet" description="There are no recent orders to display." icon="📋" />
                    ) : (
                        <div className="space-y-2">
                            {orders.slice(0, 10).map((order: any) => (
                                <div key={order.orderId} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-700/50 rounded-xl transition-all duration-200 hover:shadow-card hover:-translate-y-0.5">
                                    <div>
                                        <p className="text-sm font-medium text-gray-900 dark:text-white">{order.patientName || 'Walk-in'}</p>
                                        <p className="text-xs text-gray-500 dark:text-gray-400">{(order.studies || []).map((s: any) => s.name).join(', ')}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {order.priority === 'stat' && <span className="px-2 py-0.5 text-[10px] bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 rounded-full font-bold">STAT</span>}
                                        {order.priority === 'urgent' && <span className="px-2 py-0.5 text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 rounded-full font-bold">URGENT</span>}
                                        {order.dicomMwlScheduled && <span className="px-2 py-0.5 text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 rounded-full">📡 MWL</span>}
                                        <span className={`px-2 py-0.5 text-[10px] rounded-full font-medium ${order.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' :
                                            order.status === 'in_progress' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' :
                                                order.status === 'scheduled' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' :
                                                    'bg-gray-100 text-gray-600 dark:bg-slate-600 dark:text-gray-300'
                                            }`}>{order.status}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>

                {/* Result Imaging (upload + gallery) */}
                <Card>
                    <h3 className="font-semibold text-gray-900 dark:text-white tracking-snug mb-1">🖼️ Result Imaging</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Attach imaging (JPEG/PNG/DICOM, up to 50MB each) to a completed study. Images are stored in Docarion, not in a PACS.{orthancConfigured ? ' An Orthanc URL is configured, but studies are not yet pushed to it — PACS not connected.' : ' PACS not connected.'}</p>
                    {completedWithResults.length === 0 ? (
                        <EmptyState title="No completed studies" description="Imaging can be attached once a study has a report." icon="🖼️" />
                    ) : (
                        <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <select
                                    className="border rounded-lg px-3 py-2 bg-white dark:bg-slate-700 dark:text-white dark:border-slate-600 text-sm"
                                    value={imgResultId}
                                    onChange={(e) => setImgResultId(e.target.value)}
                                >
                                    <option value="">Select a completed study…</option>
                                    {completedWithResults.map((o: any) => (
                                        <option key={o.resultId} value={o.resultId}>
                                            {(o.patientName || 'Walk-in')} — {(o.studies || []).map((s: any) => s.name).join(', ')}
                                        </option>
                                    ))}
                                </select>
                                {imgResultId && (
                                    <label className="inline-flex">
                                        <input type="file" accept="image/*,.dcm,application/dicom" multiple className="hidden" onChange={handleImageUpload} disabled={uploadingImages} />
                                        <span className={`px-3 py-2 rounded-lg text-sm cursor-pointer ${uploadingImages ? 'bg-gray-300 text-gray-500' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                                            {uploadingImages ? 'Uploading…' : '⬆️ Upload images'}
                                        </span>
                                    </label>
                                )}
                            </div>
                            {imgResultId && (
                                galleryImages.length === 0 ? (
                                    <p className="text-sm text-gray-500 dark:text-gray-400">No images attached to this study yet.</p>
                                ) : (
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                        {galleryImages.map((img: any) => (
                                            <a key={img.fileId} href={img.url} target="_blank" rel="noopener noreferrer" className="block group">
                                                {img.isDicom ? (
                                                    <div className="aspect-square rounded-xl bg-gray-900 text-gray-300 flex flex-col items-center justify-center text-xs">
                                                        <span className="text-2xl">🧠</span>
                                                        <span className="mt-1">DICOM</span>
                                                    </div>
                                                ) : (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={img.url} alt={img.fileName} className="aspect-square object-cover rounded-xl ring-1 ring-gray-200 dark:ring-slate-600 group-hover:ring-blue-400 transition-all" />
                                                )}
                                                <p className="text-[10px] text-gray-500 mt-1 truncate dark:text-gray-400">{img.fileName}</p>
                                            </a>
                                        ))}
                                    </div>
                                )
                            )}
                        </div>
                    )}
                </Card>

                <div className="space-y-6">
                    <DashboardAIAssistant />
                    <MetaMultimodalScanner defaultTab="vision" />
                </div>

                <ComplianceBadges />
            </div>
        </DashboardShell>
    );
}

export default withRoleGuard(RadiologyDashboardPage, ['rad_technician', 'rad_admin', 'super_admin']);
