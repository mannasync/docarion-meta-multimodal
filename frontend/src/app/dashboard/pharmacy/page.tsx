'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth.store';
import { withRoleGuard } from '@/components/shared/withRoleGuard';
import api, { pharmacyApi } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { toast } from 'react-toastify';
import { ComplianceBadges } from '@/components/ui/TrustBadge';
import { DataTable, Column } from '@/components/ui/DataTable';
import { AdvancedFilterBar } from '@/components/shared/AdvancedFilterBar';
import { AISummaryWidget } from '@/components/shared/AISummaryWidget';
import { usePharmacyAiSummary, PHARMACY_AI_SUMMARY_ROLES } from '@/hooks/usePharmacyAiSummary';
import DashboardSkeleton from '@/components/ui/LoadingStates';
import { EmptyState } from '@/components/ui/EmptyState';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { MetricCard } from '@/components/ui/MetricCard';
import { DashboardAIAssistant } from '@/components/shared/DashboardAIAssistant';
import { WalkInModal, DrugInteractionModal, PatientMedHistoryModal, OtpModal, ReminderModal, TelepharmacyModal } from '@/components/modals/PharmacyModals';
import { MetaMultimodalScanner } from '@/components/ai/MetaMultimodalScanner';

interface Prescription {
    prescriptionId: string;
    patientId: string;
    patientName?: string;
    status: string;
    medications: { name: string; dosage: string; quantity: number }[];
    createdAt: string;
    workflowStatus?: string;
}

interface InteractionWarning {
    drug1: string;
    drug2: string;
    severity: 'low' | 'moderate' | 'high';
    message: string;
    aiAdvice?: string;
}

interface MedHistoryEntry {
    prescriptionId: string;
    medications: { name: string; dosage: string }[];
    status: string;
    dispensedAt?: string;
    createdAt: string;
}

import FacilityOnboardingChecklist from '@/components/onboarding/FacilityOnboardingChecklist';
import { usePharmacyLicence } from './_lib/usePharmacyLicence';

function PharmacyDashboard() {
    const { user } = useAuthStore();
    const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
    const [stats, setStats] = useState({ pending: 0, dispensed: 0, earnings: 0, lowStock: 0, expiring: 0 });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filters, setFilters] = useState<Record<string, string>>({});
    const [showWalkInModal, setShowWalkInModal] = useState(false);
    const [walkInData, setWalkInData] = useState({ firstName: '', lastName: '', phone: '', email: '' });

    // Interaction check
    const [interactionWarnings, setInteractionWarnings] = useState<InteractionWarning[]>([]);
    const [pendingDispenseId, setPendingDispenseId] = useState<string | null>(null);
    const [showInteractionModal, setShowInteractionModal] = useState(false);

    // Patient med history
    const [medHistory, setMedHistory] = useState<{ active: MedHistoryEntry[]; dispensed: MedHistoryEntry[]; expired: MedHistoryEntry[]; allergies: string[] } | null>(null);
    const [showMedHistory, setShowMedHistory] = useState(false);

    // OTP for controlled substances
    const [showOtpModal, setShowOtpModal] = useState(false);
    const [otpCode, setOtpCode] = useState('');
    const [otpPrescriptionId, setOtpPrescriptionId] = useState<string | null>(null);

    // Post-dispense reminder
    const [showReminderModal, setShowReminderModal] = useState(false);
    const [reminderData, setReminderData] = useState({ medicationName: '', patientName: '', prescriptionId: '', frequency: 'daily', duration: 30, method: 'push' });

    // Telepharmacy
    const [showTelepharmacyModal, setShowTelepharmacyModal] = useState(false);
    const [teleData, setTeleData] = useState({ patientName: '', reason: 'Medication counseling' });

    // Meta Multimodal Scanner & POM Escalation Modal
    const [escalateData, setEscalateData] = useState<any>(null);
    const [showEscalateModal, setShowEscalateModal] = useState(false);
    const [escalating, setEscalating] = useState(false);
    const [escalationPatientName, setEscalationPatientName] = useState('');
    const [escalationPatientPhone, setEscalationPatientPhone] = useState('');
    const [escalationNote, setEscalationNote] = useState('');
    const [pharmacyScannerTab, setPharmacyScannerTab] = useState<'prescriptions' | 'scanner'>('prescriptions');

    const facilityId = user?.facilityId || '';
    const canReview = user?.role === 'pharmacist' && !!user?.permissions?.includes('pharmacy.platform_review');
    // PPMV (patent medicine store): OTC-only — no Rx queue, controlled register or compliance.
    const { isPpmv } = usePharmacyLicence(facilityId);
    // Medicine store attendant: OTC till + stock role (PPMV or pharmacy). It
    // never sees the prescription queue or wallet — server-enforced; the UI
    // simply renders the till-focused view instead of calling those endpoints.
    const isAttendant = user?.role === 'medicine_store_attendant';
    const { summaryText, loading: aiLoading } = usePharmacyAiSummary(stats.pending, stats.lowStock);

    useEffect(() => {
        if (canReview || facilityId) loadData();
    }, [facilityId, canReview]);

    const loadData = async () => {
        try {
            if (canReview) {
                const reviewRes = await pharmacyApi.getPlatformReviewQueue('all');
                const allPrescriptions = reviewRes.data.data || [];
                setPrescriptions(allPrescriptions);
                setStats({
                    pending: allPrescriptions.filter((p: Prescription) => ['pending_pharmacist_review', 'changes_requested', 'stock_unavailable'].includes(p.workflowStatus || '')).length,
                    dispensed: allPrescriptions.filter((p: Prescription) => ['delivered', 'rejected', 'cancelled'].includes(p.workflowStatus || '')).length,
                    earnings: 0,
                    lowStock: 0,
                    expiring: 0,
                });
                setError(null);
                return;
            }
            if (isAttendant) {
                let lowStock = 0, expiring = 0;
                try {
                    const [lowRes, expRes] = await Promise.all([
                        pharmacyApi.getLowStockItems(facilityId),
                        pharmacyApi.getExpiringItems(facilityId, 30),
                    ]);
                    lowStock = (lowRes.data.data || []).length;
                    expiring = (expRes.data.data || []).length;
                } catch { /* stock alerts are best-effort on the till view */ }
                setStats({ pending: 0, dispensed: 0, earnings: 0, lowStock, expiring });
                setError(null);
                return;
            }
            const [prescRes, walletRes] = await Promise.all([
                pharmacyApi.getPrescriptions(facilityId),
                pharmacyApi.getWallet(facilityId),
            ]);

            const allPrescriptions = prescRes.data.data || [];
            setPrescriptions(allPrescriptions.filter((p: Prescription) =>
                ['sent_to_local_pharmacy', 'preparing', 'ready_for_pickup'].includes(p.workflowStatus || '')
                || (!p.workflowStatus && p.status === 'active')));

            let lowStock = 0, expiring = 0;
            try {
                const [lowRes, expRes] = await Promise.all([
                    pharmacyApi.getLowStockItems(facilityId),
                    pharmacyApi.getExpiringItems(facilityId, 30),
                ]);
                lowStock = (lowRes.data.data || []).length;
                expiring = (expRes.data.data || []).length;
            } catch { /* endpoints may not exist yet */ }

            setStats({
                pending: allPrescriptions.filter((p: Prescription) =>
                    ['sent_to_local_pharmacy', 'preparing', 'ready_for_pickup'].includes(p.workflowStatus || '')
                    || (!p.workflowStatus && p.status === 'active')).length,
                dispensed: allPrescriptions.filter((p: Prescription) => p.status === 'dispensed').length,
                earnings: walletRes.data.data?.balance || 0,
                lowStock,
                expiring,
            });
            setError(null);
        } catch (error) {
            console.error('Failed to load data:', error);
            setError('Failed to load dashboard data. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleDispense = async (prescriptionId: string) => {
        try {
            // Run interaction check first
            const checkRes = await pharmacyApi.checkInteractions(prescriptionId);
            const warnings = checkRes.data.data?.warnings || [];

            if (warnings.length > 0) {
                setInteractionWarnings(warnings);
                setPendingDispenseId(prescriptionId);
                setShowInteractionModal(true);
                return; // Wait for pharmacist acknowledgment
            }

            // No interactions — dispense directly
            await pharmacyApi.dispensePrescription(prescriptionId);
            toast.success('Prescription dispensed successfully');
            // Trigger reminder prompt
            const rx = prescriptions.find((p: any) => p.prescriptionId === prescriptionId || p.id === prescriptionId);
            if (rx) {
                setReminderData({ medicationName: (rx.medications || []).map((m: any) => m.name).join(', '), patientName: rx.patientName || 'Patient', prescriptionId, frequency: 'daily', duration: 30, method: 'push' });
                setShowReminderModal(true);
            }
            loadData();
        } catch (error: any) {
            if (error?.response?.data?.requiresOtp) {
                setOtpPrescriptionId(prescriptionId);
                setOtpCode('');
                setShowOtpModal(true);
                return;
            }
            toast.error('Failed to dispense prescription');
        }
    };

    const confirmDispenseWithWarnings = async () => {
        if (!pendingDispenseId) return;
        try {
            await pharmacyApi.dispensePrescription(pendingDispenseId);
            toast.success('Prescription dispensed (interaction acknowledged)');
            setShowInteractionModal(false);
            setPendingDispenseId(null);
            setInteractionWarnings([]);
            loadData();
        } catch (error: any) {
            if (error?.response?.data?.requiresOtp) {
                setShowInteractionModal(false);
                setOtpPrescriptionId(pendingDispenseId);
                setPendingDispenseId(null);
                setOtpCode('');
                setShowOtpModal(true);
                return;
            }
            toast.error('Failed to dispense prescription');
        }
    };

    const handleOtpDispense = async () => {
        if (!otpPrescriptionId || otpCode.length !== 6) return;
        try {
            await pharmacyApi.dispensePrescription(otpPrescriptionId, { otpCode });
            toast.success('Controlled substance dispensed (OTP verified)');
            setShowOtpModal(false);
            setOtpPrescriptionId(null);
            setOtpCode('');
            loadData();
        } catch (error: any) {
            toast.error(error?.response?.data?.error || 'Invalid OTP');
        }
    };

    const viewMedHistory = async (patientId: string) => {
        try {
            const res = await pharmacyApi.getPatientMedHistory(patientId);
            const data = res.data.data;
            if (data && !Array.isArray(data)) {
                setMedHistory({
                    active: data.active || [],
                    dispensed: data.dispensed || [],
                    expired: data.expired || [],
                    allergies: data.allergies || []
                });
            } else {
                setMedHistory({
                    active: [],
                    dispensed: [],
                    expired: [],
                    allergies: []
                });
            }
            setShowMedHistory(true);
        } catch (error) {
            toast.error('Failed to load medication history');
        }
    };

    const handleWalkInRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await pharmacyApi.registerWalkIn(facilityId, {
                profile: { firstName: walkInData.firstName, lastName: walkInData.lastName },
                phone: walkInData.phone,
                email: walkInData.email,
            });
            toast.success('Walk-in patient registered');
            setShowWalkInModal(false);
            setWalkInData({ firstName: '', lastName: '', phone: '', email: '' });
        } catch (error) {
            toast.error('Failed to register patient');
        }
    };

    const filteredPrescriptions = prescriptions.filter(p => {
        if (filters.search) {
            const term = filters.search.toLowerCase();
            const matchId = p.prescriptionId.toLowerCase().includes(term);
            const matchName = p.patientName?.toLowerCase().includes(term);
            if (!matchId && !matchName) return false;
        }
        if (filters.date) {
            const today = new Date();
            const pDate = new Date(p.createdAt);
            if (filters.date === 'today') {
                if (pDate.toDateString() !== today.toDateString()) return false;
            } else if (filters.date === 'week') {
                const diffTime = Math.abs(today.getTime() - pDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                if (diffDays > 7) return false;
            } else if (filters.date === 'month') {
                if (pDate.getMonth() !== today.getMonth() || pDate.getFullYear() !== today.getFullYear()) return false;
            }
        }
        if (filters.priority) {
            // Priority filtering logic if applicable. Currently status handles 'active'.
        }
        return true;
    });

    const columns: Column<Prescription>[] = [
        { header: 'Prescription ID', accessorKey: 'prescriptionId', cell: (p) => <span className="font-medium">#{p.prescriptionId.slice(0, 8)}</span> },
        { header: 'Patient', accessorKey: 'patientName', cell: (p) => p.patientName || 'Unknown' },
        { header: 'Medications', accessorKey: 'medications', cell: (p) => (
            <div className="flex flex-wrap gap-1">
                {p.medications.slice(0, 2).map((med, i) => (
                    <span key={i} className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded dark:bg-blue-900/30 dark:text-blue-300">
                        {med.name} × {med.quantity}
                    </span>
                ))}
                {p.medications.length > 2 && <span className="text-xs text-gray-500 dark:text-gray-400">+{p.medications.length - 2} more</span>}
            </div>
        )},
        { header: 'Date', accessorKey: 'createdAt', cell: (p) => new Date(p.createdAt).toLocaleDateString() },
        { header: 'Actions', accessorKey: 'actions', cell: (p) => (
            <div className="flex gap-2">
                <Button size="sm" variant="outline" className="text-xs" onClick={(e) => { e.stopPropagation(); viewMedHistory(p.patientId); }}>📋 History</Button>
                <Link href={`/prescriptions/${p.prescriptionId}`} onClick={e => e.stopPropagation()}>
                    <Button size="sm" variant="outline">View</Button>
                </Link>
                {(p.workflowStatus === 'ready_for_pickup' || (!p.workflowStatus && p.status === 'active')) && (
                    <Button size="sm" onClick={(e) => { e.stopPropagation(); handleDispense(p.prescriptionId); }}>Dispense</Button>
                )}
            </div>
        )}
    ];

    if (canReview) {
        return (
            <DashboardShell
                title="Platform Pharmacy Clinical Review"
                subtitle="Site-assigned review workspace for prescription safety and local pharmacy coordination"
            >
                <div className="grid grid-cols-2 gap-3 mb-6">
                    <div className="rounded-xl bg-slate-100 dark:bg-slate-700 p-4"><p className="text-xs text-gray-600 dark:text-gray-300">Needs review / coordination</p><p className="text-3xl font-bold">{stats.pending}</p></div>
                    <div className="rounded-xl bg-slate-100 dark:bg-slate-700 p-4"><p className="text-xs text-gray-600 dark:text-gray-300">Completed / closed</p><p className="text-3xl font-bold">{stats.dispensed}</p></div>
                </div>
                <Card>
                    <CardContent className="p-6">
                        <h2 className="text-xl font-semibold">Clinical review queue</h2>
                        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Review appropriateness, allergies, interactions, and dose; then choose the local dispensing pharmacy. Patients receive a live update after every transition.</p>
                        <Link href="/dashboard/pharmacy/prescriptions"><Button className="mt-5">Open review queue ({stats.pending})</Button></Link>
                    </CardContent>
                </Card>
            </DashboardShell>
        );
    }

    if (error) {
        return (
            <DashboardShell title="💊 Pharmacy Command Center">
                <EmptyState
                    icon="⚠️"
                    title="Error Loading Dashboard"
                    description={error}
                    actionLabel="Retry"
                    onAction={loadData}
                />
            </DashboardShell>
        );
    }

    const handleEscalateToDoctor = (data: any) => {
        setEscalateData(data);
        setShowEscalateModal(true);
        const drug = data?.productDetails?.brandName || data?.drugName || 'Prescription Medication';
        toast.warn(`🚨 Flagged Medication (${drug}): Escalation to Telehealth Doctor required.`);
    };

    const confirmEscalateToDoctor = async () => {
        if (!escalateData) return;
        setEscalating(true);
        try {
            const drug = escalateData?.productDetails?.brandName || escalateData?.drugName || 'Prescription Medication';
            const regNo = escalateData?.nafdacRegNo || 'N/A';
            const phoneStr = escalationPatientPhone ? ` Phone: ${escalationPatientPhone}.` : '';
            const msg = `🚨 Pharmacy Counter Escalation: Patient ${escalationPatientName || 'Walk-In'} requires physician e-Rx review for flagged POM medication "${drug}" (NAFDAC ${regNo}).${phoneStr} ${escalationNote ? `Note: ${escalationNote}` : ''}`.trim();

            await api.post('/telehealth-queue/notify-on-duty', {
                facilityId: facilityId || undefined,
                urgency: 'high',
                message: msg,
            });

            toast.success(`🩺 Successfully escalated ${drug} to on-duty telehealth doctors! Physician alerted.`);
            setShowEscalateModal(false);
            setEscalateData(null);
            setEscalationPatientName('');
            setEscalationPatientPhone('');
            setEscalationNote('');
        } catch {
            toast.error('Failed to alert on-duty doctor. Please notify via walk-in queue.');
        } finally {
            setEscalating(false);
        }
    };

    const renderEscalateModal = () => {
        if (!showEscalateModal || !escalateData) return null;
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-lg w-full border border-rose-200 dark:border-rose-900/50 overflow-hidden">
                    <div className="bg-gradient-to-r from-rose-600 to-rose-700 p-5 text-white flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <span className="text-2xl">🚨</span>
                            <div>
                                <h3 className="font-bold text-lg">Escalate Flagged Drug to On-Duty Doctor</h3>
                                <p className="text-xs text-rose-100">PCN Counter Scope Violation / POM Gate Review</p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => { setShowEscalateModal(false); setEscalateData(null); }}
                            className="text-white/80 hover:text-white text-xl font-bold leading-none"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                    <div className="p-6 space-y-4">
                        <div className="p-3.5 bg-rose-50 dark:bg-rose-950/30 rounded-xl border border-rose-200 dark:border-rose-900/30 space-y-1.5 text-xs">
                            <div className="flex justify-between items-center">
                                <span className="text-gray-500 dark:text-gray-400">Flagged Product:</span>
                                <span className="font-bold text-gray-900 dark:text-white text-sm">
                                    {escalateData.productDetails?.brandName || escalateData.drugName || 'Prescription Medication'}
                                </span>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-gray-500 dark:text-gray-400">NAFDAC Reg No:</span>
                                <span className="font-mono font-semibold text-gray-700 dark:text-gray-300">
                                    {escalateData.nafdacRegNo || 'N/A'}
                                </span>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-gray-500 dark:text-gray-400">Class & Gate Status:</span>
                                <span className="font-bold text-rose-600 dark:text-rose-400 uppercase">
                                    {escalateData.drugClass || 'POM'} • {escalateData.ppmvCounterGate?.reason || 'Prescription Required'}
                                </span>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                    Patient Full Name (Optional / Walk-In)
                                </label>
                                <input
                                    type="text"
                                    value={escalationPatientName}
                                    onChange={(e) => setEscalationPatientName(e.target.value)}
                                    placeholder="e.g. Chukwudi Okafor"
                                    className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-slate-800 dark:border-slate-700 dark:text-white focus:ring-2 focus:ring-rose-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                    Patient Phone Number
                                </label>
                                <input
                                    type="tel"
                                    value={escalationPatientPhone}
                                    onChange={(e) => setEscalationPatientPhone(e.target.value)}
                                    placeholder="e.g. 08012345678"
                                    className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-slate-800 dark:border-slate-700 dark:text-white focus:ring-2 focus:ring-rose-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                                    Clinical Triage Context / Note
                                </label>
                                <textarea
                                    value={escalationNote}
                                    onChange={(e) => setEscalationNote(e.target.value)}
                                    placeholder="Patient requesting unprescribed POM at counter; escalating for telehealth physician e-Rx review."
                                    rows={2}
                                    className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-slate-800 dark:border-slate-700 dark:text-white focus:ring-2 focus:ring-rose-500 resize-none"
                                />
                            </div>
                        </div>

                        <div className="flex items-center justify-end gap-3 pt-3 border-t dark:border-slate-800">
                            <Button
                                variant="outline"
                                onClick={() => { setShowEscalateModal(false); setEscalateData(null); }}
                                disabled={escalating}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={confirmEscalateToDoctor}
                                disabled={escalating}
                                className="bg-rose-600 hover:bg-rose-700 text-white font-bold flex items-center gap-2"
                            >
                                {escalating ? 'Escalating...' : '🩺 Alert On-Duty Telehealth Doctor'}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    if (isPpmv || isAttendant) {
        const ppmvActions: Array<{ href: string; icon: string; label: string; aria: string; adminOnly?: boolean }> = [
            { href: '/dashboard/pharmacy/billing', icon: '🧾', label: 'Till (POS)', aria: 'Open the till' },
            { href: '/dashboard/pharmacy/inventory', icon: '📦', label: 'Stock', aria: 'Manage stock' },
            { href: '/dashboard/pharmacy/scan', icon: '📷', label: 'Scan', aria: 'Scan product barcode' },
            { href: '/dashboard/pharmacy/suppliers', icon: '🏭', label: 'Suppliers', aria: 'Manage suppliers' },
            { href: '/dashboard/pharmacy/rota', icon: '📅', label: 'Shifts', aria: 'Staff shifts' },
            { href: '/dashboard/pharmacy/staff', icon: '👥', label: 'Staff', aria: 'Store staff', adminOnly: true },
        ];
        return (
            <DashboardShell
                title={isPpmv ? '🏪 Medicine Store' : '🧾 Till & Stock'}
                subtitle={isPpmv
                    ? 'Patent & proprietary medicine vendor (PPMV) — OTC sales, stock and suppliers'
                    : 'Medicine store attendant — over-the-counter sales, stock and suppliers'}
                bodyClassName="container mx-auto px-4 py-4 md:px-6 space-y-6"
            >
                {/* Setup checklist is for the pharmacy admin; pharmacists can't read staff/wallet data. */}
                {facilityId && user?.role === 'pharmacy_admin' && <FacilityOnboardingChecklist facilityId={facilityId} />}
                {isAttendant && !isPpmv ? (
                    <Card>
                        <CardContent className="py-4 space-y-2">
                            <p className="text-sm font-semibold text-gray-900 dark:text-white">Your role covers over-the-counter sales and stock</p>
                            <p className="text-sm text-gray-600 dark:text-gray-300">
                                You can sell OTC (patent and proprietary) items at the till and keep stock counts up to date.
                                Prescription-only medicines must be sold by a pharmacist, and controlled medicines are dispensed against a prescription — never at the till.
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                <Card>
                    <CardContent className="py-4 space-y-2">
                        <p className="text-sm font-semibold text-gray-900 dark:text-white">Your licence covers over-the-counter medicines only</p>
                        <p className="text-sm text-gray-600 dark:text-gray-300">
                            As a PCN-licensed patent medicine store you can stock and sell OTC (patent and proprietary) medicines.
                            Prescription-only and controlled medicines cannot be stocked or sold here, and prescriptions are never routed to your store —
                            refer patients who need them to a licensed pharmacy.
                        </p>
                    </CardContent>
                </Card>
                )}
                {(stats.lowStock > 0 || stats.expiring > 0) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {stats.lowStock > 0 && (
                            <Link href="/dashboard/pharmacy/inventory?tab=low-stock">
                                <Card className="border-orange-200 bg-orange-50 dark:bg-orange-900/20"><CardContent className="py-3 text-sm text-orange-700 dark:text-orange-300">⚠️ {stats.lowStock} item(s) need restocking</CardContent></Card>
                            </Link>
                        )}
                        {stats.expiring > 0 && (
                            <Link href="/dashboard/pharmacy/inventory?tab=expiring">
                                <Card className="border-red-200 bg-red-50 dark:bg-red-900/20"><CardContent className="py-3 text-sm text-red-700 dark:text-red-300">🕐 {stats.expiring} item(s) expiring within 30 days</CardContent></Card>
                            </Link>
                        )}
                    </div>
                )}
                {/* Meta Multimodal AI Scanner & PCN Counter Gate */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                            <span>🔬</span> Meta Multimodal AI Scanner (NAFDAC & SAM 3.1)
                        </h3>
                        <span className="text-xs px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 font-medium">
                            PCN Scope: {isPpmv ? 'PPMV Tier 1 (OTC Only)' : 'Store Attendant (OTC Only)'}
                        </span>
                    </div>
                    <MetaMultimodalScanner
                        facilityLicenceClass={isPpmv ? 'ppmv' : 'pharmacy'}
                        onEscalateToDoctor={handleEscalateToDoctor}
                    />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {ppmvActions.filter(a => !a.adminOnly || user?.role === 'pharmacy_admin').map(a => (
                        <Link key={a.href} href={a.href} aria-label={a.aria}>
                            <Button variant="outline" className="w-full h-16 flex-col">
                                <span className="text-xl" aria-hidden="true">{a.icon}</span>
                                <span className="text-xs">{a.label}</span>
                            </Button>
                        </Link>
                    ))}
                </div>
                {renderEscalateModal()}
            </DashboardShell>
        );
    }

    return (
        <DashboardShell
            title="💊 Pharmacy Command Center"
            subtitle="Manage prescriptions, inventory & compliance securely"
            headerExtra={
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3" role="region" aria-label="Pharmacy statistics">
                    <div className="bg-slate-100 dark:bg-slate-700 rounded-xl p-3 text-center" role="status" aria-label={`${stats.pending} pending prescriptions`}>
                        <p className="text-gray-600 dark:text-gray-300 text-xs">Pending Rx</p>
                        <p className="text-2xl font-bold">{stats.pending}</p>
                    </div>
                    <div className="bg-slate-100 dark:bg-slate-700 rounded-xl p-3 text-center" role="status">
                        <p className="text-gray-600 dark:text-gray-300 text-xs">Dispensed</p>
                        <p className="text-2xl font-bold">{stats.dispensed}</p>
                    </div>
                    <div className="bg-slate-100 dark:bg-slate-700 rounded-xl p-3 text-center" role="status">
                        <p className="text-gray-600 dark:text-gray-300 text-xs">Wallet</p>
                        <p className="text-2xl font-bold">₦{stats.earnings.toLocaleString()}</p>
                    </div>
                    {stats.lowStock > 0 && (
                        <div className="bg-orange-100 dark:bg-orange-900/30 rounded-xl p-3 text-center" role="alert" aria-label={`${stats.lowStock} items low stock`}>
                            <p className="text-orange-700 dark:text-orange-300 text-xs">⚠️ Low Stock</p>
                            <p className="text-2xl font-bold text-orange-700 dark:text-orange-300">{stats.lowStock}</p>
                        </div>
                    )}
                    {stats.expiring > 0 && (
                        <div className="bg-red-100 dark:bg-red-900/30 rounded-xl p-3 text-center" role="alert" aria-label={`${stats.expiring} items expiring soon`}>
                            <p className="text-red-700 dark:text-red-300 text-xs">🕐 Expiring</p>
                            <p className="text-2xl font-bold text-red-700 dark:text-red-300">{stats.expiring}</p>
                        </div>
                    )}
                </div>
            }
            bodyClassName="container mx-auto px-4 py-4 md:px-6 space-y-6"
        >
                {facilityId && user?.role === 'pharmacy_admin' && <FacilityOnboardingChecklist facilityId={facilityId} />}
                {PHARMACY_AI_SUMMARY_ROLES.includes(user?.role || '') && (
                    <AISummaryWidget
                        summaryText={summaryText}
                        isLoading={loading || aiLoading}
                    />
                )}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                    <div className="lg:col-span-8 space-y-6">
                        {/* Alert Cards */}
                {(stats.lowStock > 0 || stats.expiring > 0) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {stats.lowStock > 0 && (
                            <Link href="/dashboard/pharmacy/inventory?tab=low-stock">
                                <Card className="border-orange-200 bg-orange-50 hover:shadow-card-hover transition-shadow cursor-pointer dark:bg-orange-900/20">
                                    <CardContent className="py-3">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-orange-600">⚠️</span>
                                                <span className="text-orange-700 font-medium text-sm">{stats.lowStock} item(s) need restocking</span>
                                            </div>
                                            <span className="text-orange-400 text-sm">→</span>
                                        </div>
                                    </CardContent>
                                </Card>
                            </Link>
                        )}
                        {stats.expiring > 0 && (
                            <Link href="/dashboard/pharmacy/inventory?tab=expiring">
                                <Card className="border-red-200 bg-red-50 hover:shadow-card-hover transition-shadow cursor-pointer dark:bg-red-900/20">
                                    <CardContent className="py-3">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-red-600">🕐</span>
                                                <span className="text-red-700 font-medium text-sm">{stats.expiring} item(s) expiring within 30 days</span>
                                            </div>
                                            <span className="text-red-400 text-sm">→</span>
                                        </div>
                                    </CardContent>
                                </Card>
                            </Link>
                        )}
                    </div>
                )}

                {/* Quick Actions */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Link href="/dashboard/pharmacy/inventory" aria-label="Manage inventory">
                        <Button variant="outline" className="w-full h-16 flex-col">
                            <span className="text-xl" aria-hidden="true">📦</span>
                            <span className="text-xs">Inventory</span>
                        </Button>
                    </Link>
                    <Link href="/dashboard/pharmacy/scan" aria-label="Scan drug barcode">
                        <Button variant="outline" className="w-full h-16 flex-col">
                            <span className="text-xl" aria-hidden="true">📷</span>
                            <span className="text-xs">Scan</span>
                        </Button>
                    </Link>
                    <Link href="/dashboard/pharmacy/prescriptions" aria-label="View prescriptions">
                        <Button variant="outline" className="w-full h-16 flex-col">
                            <span className="text-xl" aria-hidden="true">💊</span>
                            <span className="text-xs">Prescriptions</span>
                        </Button>
                    </Link>
                    <Link href="/dashboard/pharmacy/billing" aria-label="Billing and invoices">
                        <Button variant="outline" className="w-full h-16 flex-col bg-emerald-50 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/20">
                            <span className="text-xl" aria-hidden="true">💰</span>
                            <span className="text-xs font-semibold text-emerald-700">Billing</span>
                        </Button>
                    </Link>
                    <Link href="/dashboard/pharmacy/patients" aria-label="View patients">
                        <Button variant="outline" className="w-full h-16 flex-col">
                            <span className="text-xl" aria-hidden="true">👥</span>
                            <span className="text-xs">Patients</span>
                        </Button>
                    </Link>
                    <Link href="/dashboard/pharmacy/earnings" aria-label="View earnings">
                        <Button variant="outline" className="w-full h-16 flex-col">
                            <span className="text-xl" aria-hidden="true">📊</span>
                            <span className="text-xs">Earnings</span>
                        </Button>
                    </Link>
                    <Link href="/dashboard/pharmacy/suppliers" aria-label="Manage suppliers">
                        <Button variant="outline" className="w-full h-16 flex-col bg-indigo-50 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/20">
                            <span className="text-xl" aria-hidden="true">🏭</span>
                            <span className="text-xs font-semibold text-indigo-700">Suppliers</span>
                        </Button>
                    </Link>
                    {/* Reports page is pharmacy_admin-only — don't show a link that bounces a pharmacist. */}
                    {user?.role !== 'pharmacist' && (
                    <Link href="/dashboard/pharmacy/reports" aria-label="Reports and compliance">
                        <Button variant="outline" className="w-full h-16 flex-col bg-teal-50 border-teal-200 hover:bg-teal-100 dark:bg-teal-900/20">
                            <span className="text-xl" aria-hidden="true">📈</span>
                            <span className="text-xs font-semibold text-teal-700">Reports</span>
                        </Button>
                    </Link>
                    )}
                    <Link href="/dashboard/pharmacy/walk-ins" aria-label="Walk-in queue">
                        <Button variant="outline" className="w-full h-16 flex-col">
                            <span className="text-xl" aria-hidden="true">🚶</span>
                            <span className="text-xs">Walk-in queue</span>
                        </Button>
                    </Link>
                    {user?.role === 'pharmacy_admin' && (
                        <Link href="/dashboard/pharmacy/staff" aria-label="Pharmacy staff">
                            <Button variant="outline" className="w-full h-16 flex-col">
                                <span className="text-xl" aria-hidden="true">👥</span>
                                <span className="text-xs">Staff</span>
                            </Button>
                        </Link>
                    )}
                    {user?.role === 'pharmacy_admin' && (
                        <Link href="/dashboard/pharmacy/settings" aria-label="Pharmacy settings">
                            <Button variant="outline" className="w-full h-16 flex-col bg-purple-50 border-purple-200 hover:bg-purple-100 dark:bg-purple-900/20">
                                <span className="text-xl" aria-hidden="true">⚙️</span>
                                <span className="text-xs font-semibold text-purple-700">Settings</span>
                            </Button>
                        </Link>
                    )}
                </div>

                {/* Telepharmacy + Walk-in buttons */}
                <div className="grid grid-cols-2 gap-3">
                    <Button className="bg-indigo-600 hover:bg-indigo-700 py-3" onClick={() => setShowTelepharmacyModal(true)}>
                        📹 Telepharmacy
                    </Button>
                    <Button className="bg-green-600 hover:bg-green-700 py-3" onClick={() => setShowWalkInModal(true)}>
                        + Walk-in Patient
                    </Button>
                </div>

                {/* View Tabs: Prescriptions Queue vs Meta Multimodal Scanner */}
                <div className="flex border-b border-gray-200 dark:border-slate-700 gap-3 pb-1">
                    <button
                        type="button"
                        onClick={() => setPharmacyScannerTab('prescriptions')}
                        className={`pb-2.5 px-4 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
                            pharmacyScannerTab === 'prescriptions'
                                ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400'
                                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
                        }`}
                    >
                        <span>💊</span> Prescriptions Queue ({prescriptions.length})
                    </button>
                    <button
                        type="button"
                        onClick={() => setPharmacyScannerTab('scanner')}
                        className={`pb-2.5 px-4 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
                            pharmacyScannerTab === 'scanner'
                                ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400'
                                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
                        }`}
                    >
                        <span>🔬</span> Multimodal AI Scanner (NAFDAC & SAM 3.1)
                    </button>
                </div>

                {pharmacyScannerTab === 'scanner' ? (
                    <Card className="border border-indigo-200 dark:border-indigo-900/40 shadow-sm overflow-hidden">
                        <CardHeader className="bg-gradient-to-r from-indigo-50/70 via-purple-50/50 to-white dark:from-indigo-950/20 dark:via-purple-950/10 dark:to-slate-900 border-b border-indigo-100 dark:border-indigo-900/30 flex flex-row items-center justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2 text-indigo-950 dark:text-indigo-200 text-lg">
                                    <span>🔬</span> Meta Multimodal AI Scanner
                                </CardTitle>
                                <p className="text-xs text-indigo-700/80 dark:text-indigo-300/70 mt-1">
                                    NAFDAC Drug-Pack Verification, SAM 3.1 Vision Planimetry & 2-Way Voice Diarization
                                </p>
                            </div>
                            <span className="text-xs px-3 py-1 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-semibold uppercase tracking-wider">
                                Licensed Pharmacy
                            </span>
                        </CardHeader>
                        <CardContent className="p-4 sm:p-6 bg-slate-950 rounded-b-xl">
                            <MetaMultimodalScanner
                                facilityLicenceClass="pharmacy"
                                onEscalateToDoctor={handleEscalateToDoctor}
                            />
                        </CardContent>
                    </Card>
                ) : (
                    /* Pending Prescriptions */
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle>Pending Prescriptions</CardTitle>
                            <Link href="/dashboard/pharmacy/prescriptions"><Button size="sm" variant="outline">View All</Button></Link>
                        </CardHeader>
                        <CardContent>
                            {loading ? (
                                <DashboardSkeleton statCards={1} />
                            ) : prescriptions.length > 0 ? (
                                <div className="space-y-4">
                                    <AdvancedFilterBar onFilterChange={setFilters} />
                                    {filteredPrescriptions.length > 0 ? (
                                        <DataTable
                                            data={filteredPrescriptions}
                                            columns={columns}
                                            keyExtractor={(p) => p.prescriptionId}
                                        />
                                    ) : (
                                        <EmptyState
                                            icon="🔍"
                                            title="No Matches Found"
                                            description="No prescriptions match your current filters."
                                        />
                                    )}
                                </div>
                            ) : (
                                <EmptyState
                                    icon="💊"
                                    title="No Pending Prescriptions"
                                    description="You have no pending prescriptions right now."
                                />
                            )}
                        </CardContent>
                    </Card>
                )}
                    </div>
                    <div className="lg:col-span-4 space-y-6">
                        <DashboardAIAssistant />
                    </div>
                    <div className="mt-6">
                        <ComplianceBadges />
                    </div>
                </div>

            <WalkInModal
                isOpen={showWalkInModal} 
                onClose={() => setShowWalkInModal(false)} 
                data={walkInData} 
                onChange={setWalkInData} 
                onSubmit={handleWalkInRegister} 
            />

            <DrugInteractionModal 
                isOpen={showInteractionModal} 
                onClose={() => { setShowInteractionModal(false); setPendingDispenseId(null); }} 
                warnings={interactionWarnings} 
                onConfirm={confirmDispenseWithWarnings} 
            />

            <PatientMedHistoryModal 
                isOpen={showMedHistory} 
                onClose={() => setShowMedHistory(false)} 
                medHistory={medHistory} 
            />

            <OtpModal 
                isOpen={showOtpModal} 
                onClose={() => { setShowOtpModal(false); setOtpPrescriptionId(null); }} 
                otpCode={otpCode} 
                onChange={setOtpCode} 
                onSubmit={handleOtpDispense} 
            />

            <ReminderModal 
                isOpen={showReminderModal} 
                onClose={() => setShowReminderModal(false)} 
                data={reminderData} 
                onChange={setReminderData} 
                onSubmit={async () => {
                    try {
                        await pharmacyApi.createReminder(facilityId, reminderData);
                        toast.success('Reminder set successfully');
                        setShowReminderModal(false);
                    } catch { toast.error('Failed to set reminder'); }
                }} 
            />

            <TelepharmacyModal 
                isOpen={showTelepharmacyModal} 
                onClose={() => setShowTelepharmacyModal(false)} 
                data={teleData} 
                onChange={setTeleData} 
                onSubmit={async () => {
                    try {
                        const res = await pharmacyApi.startTelepharmacy(facilityId, teleData);
                        toast.success('Telepharmacy session started!');
                        setShowTelepharmacyModal(false);
                        if (res.data.data?.joinUrl) window.open(res.data.data.joinUrl, '_blank');
                    } catch { toast.error('Failed to start session'); }
                }} 
            />

            {renderEscalateModal()}
        </DashboardShell>
    );
}

export default withRoleGuard(PharmacyDashboard, ['pharmacist', 'pharmacy_admin', 'medicine_store_attendant', 'pharmacy', 'super_admin']);
