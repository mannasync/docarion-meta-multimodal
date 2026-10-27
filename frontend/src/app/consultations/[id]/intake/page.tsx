'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { aiIntakeApi, consultationApi } from '@/services/api';
import { useAuthStore } from '@/store/auth.store';
import IntakeChat from '@/components/intake/IntakeChat';
import IntakeWaiting from '@/components/intake/IntakeWaiting';
import { MetaMultimodalScanner } from '@/components/ai/MetaMultimodalScanner';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { DashboardShell } from '@/components/layout/DashboardShell';

type IntakePhase = 'loading' | 'chat' | 'waiting' | 'redirect';

export default function IntakePage() {
    const params = useParams();
    const router = useRouter();
    const { user } = useAuthStore();
    const consultationId = params.id as string;

    const [phase, setPhase] = useState<IntakePhase>('loading');
    const [language, setLanguage] = useState('en');
    const [showLeaveDialog, setShowLeaveDialog] = useState(false);
    const [showMultimodalScanner, setShowMultimodalScanner] = useState(false);

    useEffect(() => {
        checkIntakeStatus();
    }, [consultationId]);

    // Prevent accidental browser close / tab close during active intake
    useEffect(() => {
        if (phase !== 'chat') return;

        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = 'Your medical intake is not complete. Are you sure you want to leave?';
            return e.returnValue;
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [phase]);

    const checkIntakeStatus = async () => {
        try {
            const statusRes = await aiIntakeApi.getStatus(consultationId);
            const status = statusRes.data?.data;

            if (status?.isComplete) {
                setPhase('waiting');
            } else {
                setPhase('chat');
            }
        } catch (err: any) {
            // If status check fails, start fresh
            setPhase('chat');
        }
    };

    const handleIntakeComplete = () => {
        setPhase('waiting');
    };

    const handleBackClick = useCallback(() => {
        if (phase === 'chat') {
            setShowLeaveDialog(true);
        } else {
            router.push('/consultations');
        }
    }, [phase, router]);

    const handleConfirmLeave = async () => {
        setShowLeaveDialog(false);
        try {
            await aiIntakeApi?.defer?.(consultationId);
        } catch {
            // Non-blocking fallback
        }
        router.push(`/consultations/${consultationId}`);
    };

    const handleDeferForFutureAppointment = async () => {
        setShowLeaveDialog(false);
        try {
            await aiIntakeApi?.defer?.(consultationId);
        } catch {
            // Non-blocking fallback
        }
        router.push(`/consultations/new?mode=scheduled&deferConsultationId=${consultationId}`);
    };

    if (phase === 'loading') {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-slate-900 flex items-center justify-center">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500 mx-auto" />
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">Preparing your intake session...</p>
                </div>
            </div>
        );
    }

    return (
        <DashboardShell
            title="Medical Intake"
            titleClassName="text-lg font-bold text-gray-900 dark:text-white"
            headerClassName="sticky top-0 z-10"
            bodyClassName="max-w-2xl mx-auto px-4 py-6"
            actions={
                <>
                    <button onClick={handleBackClick}>
                        <Button variant="ghost" size="sm">← Back</Button>
                    </button>
                    {phase === 'chat' && (
                        <select
                            value={language}
                            onChange={(e) => setLanguage(e.target.value)}
                            className="text-xs border border-gray-200 dark:border-slate-700 rounded-lg px-2 py-1.5 bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300"
                        >
                            <option value="en">English</option>
                            <option value="pcm">Pidgin</option>
                            <option value="ha">Hausa</option>
                            <option value="yo">Yoruba</option>
                            <option value="ig">Igbo</option>
                            <option value="fr">French</option>
                        </select>
                    )}
                </>
            }
        >
            {phase === 'chat' && (
                <div className="space-y-4">
                    <div className="flex items-center justify-between bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 rounded-xl px-4 py-2.5">
                        <div className="text-xs text-emerald-900 dark:text-emerald-200">
                            <span className="font-bold">🔬 Meta Multimodal Assistant:</span> Attach a skin/wound photo, Malaria RDT strip, lab result sheet, or verify a NAFDAC medicine pack for your doctor.
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowMultimodalScanner((prev) => !prev)}
                            className="shrink-0 ml-3 text-xs border-emerald-300 text-emerald-800 dark:text-emerald-200"
                        >
                            {showMultimodalScanner ? 'Hide Scanner' : '📷 Open AI Scanner'}
                        </Button>
                    </div>
                    {showMultimodalScanner && (
                        <MetaMultimodalScanner
                            consultationId={consultationId}
                            facilityLicenceClass="patient_self_check"
                        />
                    )}
                    <IntakeChat
                        consultationId={consultationId}
                        onComplete={handleIntakeComplete}
                        language={language}
                        onDeferForFutureAppointment={() => setShowLeaveDialog(true)}
                    />
                </div>
            )}

            {phase === 'waiting' && (
                <IntakeWaiting consultationId={consultationId} />
            )}

            {/* Leave / Defer Confirmation Dialog */}
            {showLeaveDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4 animate-in fade-in slide-in-from-bottom-4">
                        <div className="text-center">
                            <span className="text-4xl block mb-3">🩺</span>
                            <h3 className="text-lg font-bold text-gray-900 dark:text-white">Medical History (Hx) Intake Required Before Seeing a Doctor</h3>
                            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
                                Every patient must complete Medical History (Hx) intake before a doctor joins — either with the <strong>AI Intake Assistant</strong> or with a <strong>Nurse at a walk-in clinic</strong>.
                            </p>
                            <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-2.5 mt-3">
                                Skipping the live AI bot now <strong>only allows you to book a future scheduled appointment</strong>. You cannot join a live instant doctor consultation until Hx intake is complete.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <button
                                onClick={() => setShowLeaveDialog(false)}
                                className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition-colors"
                            >
                                Stay & Complete AI Hx Intake Now
                            </button>
                            <button
                                onClick={handleDeferForFutureAppointment}
                                className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl transition-colors"
                            >
                                📅 Skip Live AI Bot & Book a Future Scheduled Appointment
                            </button>
                            <button
                                onClick={handleConfirmLeave}
                                className="w-full py-2.5 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-600 dark:text-gray-300 text-xs rounded-xl transition-colors"
                            >
                                Pause & Return to Consultation Page (Hx Required Before Doctor Joins)
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </DashboardShell>
    );
}

