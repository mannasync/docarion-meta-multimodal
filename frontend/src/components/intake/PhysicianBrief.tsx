'use client';

import { useEffect, useState } from 'react';
import { aiIntakeApi } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';

interface DDx {
    name: string;
    likelihood: string;
    reasoning: string;
}

interface ROSEntry {
    system: string;
    findings: string;
    status: 'positive' | 'negative' | 'not_assessed';
}

interface Brief {
    hpiNarrative: string;
    chiefComplaint: string;
    differentialDiagnosis: DDx[];
    reviewOfSystems: ROSEntry[];
    suggestedQuestions: string[];
    redFlags: string[];
    medicationList: string[];
    allergyList: string[];
    vitalSignsToCheck: string[];
    suggestedPlan?: { investigations?: string[]; initialManagement?: string[]; safetyNetting?: string[] };
    explicitNegatives?: string[];
    contextNotes?: string;
    structuredHistory?: Record<string, any>;
    completeness?: { percent?: number; missingRequired?: string[]; complete?: boolean } | null;
    triage?: { category?: string; esiLevel?: number; reason?: string; confidence?: number } | null;
    historyProvenance?: Record<string, string>;
    changesSinceLastVisit?: { domain: string; previous: string; current: string }[];
    carryOverSource?: { consultationId: string; completedAt: string } | null;
}

interface BriefSafety {
    risk_level?: string;
    safety_flags?: string[];
    requires_human_review?: boolean;
    audit_id?: string;
}

/**
 * The server now returns the brief UNWRAPPED, but older responses (and any
 * cached payload) carry the AIResponseWrapper `{ suggestion, risk_level, … }`.
 * Accept both so the card never renders empty.
 */
export function unwrapBriefPayload(raw: any): { brief: Brief | null; safety: BriefSafety | null } {
    if (!raw || typeof raw !== 'object') return { brief: null, safety: null };
    if (raw.suggestion && typeof raw.suggestion === 'object') {
        const { suggestion, ...rest } = raw;
        return { brief: suggestion as Brief, safety: rest as BriefSafety };
    }
    return { brief: raw as Brief, safety: null };
}

const HISTORY_LABELS: Record<string, string> = {
    chiefComplaint: 'Chief complaint',
    hpi: 'HPI (OLD-CARTS)',
    pastMedicalHistory: 'Past medical history',
    pastSurgicalHistory: 'Past surgical history',
    medications: 'Medications',
    allergies: 'Allergies',
    familyHistory: 'Family history',
    socialHistory: 'Social history',
    reviewOfSystems: 'Review of systems',
    pediatric: 'Paediatric',
    obstetric: 'Obstetric',
    mentalHealth: 'Mental health',
    chronicFollowUp: 'Chronic follow-up',
};

function summariseHistoryValue(value: any): string | null {
    if (value == null || value === '') return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const items = value.map(summariseHistoryValue).filter(Boolean);
        return items.length ? items.join('; ') : null;
    }
    if (typeof value === 'object') {
        const parts = Object.entries(value)
            .map(([k, v]) => {
                const s = summariseHistoryValue(v);
                return s ? `${k}: ${s}` : null;
            })
            .filter(Boolean);
        return parts.length ? parts.join(' · ') : null;
    }
    return null;
}

interface PhysicianBriefProps {
    consultationId: string;
}

const MAX_GENERATING_POLLS = 6;

export default function PhysicianBrief({ consultationId }: PhysicianBriefProps) {
    const [brief, setBrief] = useState<Brief | null>(null);
    const [safety, setSafety] = useState<BriefSafety | null>(null);
    const [generatedAt, setGeneratedAt] = useState<string | null>(null);
    const [transcript, setTranscript] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isPending, setIsPending] = useState(false);
    const [isForbidden, setIsForbidden] = useState(false);
    const [expanded, setExpanded] = useState(true);
    const [showTranscript, setShowTranscript] = useState(false);
    const [showHistory, setShowHistory] = useState(false);

    useEffect(() => {
        let cancelled = false;
        let polls = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const load = async () => {
            try {
                const res = await aiIntakeApi.getBrief(consultationId);
                if (cancelled) return;
                const payload = res.data?.data || {};
                if (res.status === 202 || res.data?.status === 'generating') {
                    setGenerating(true);
                    setTranscript(payload.transcript ?? null);
                    if (polls < MAX_GENERATING_POLLS) {
                        polls += 1;
                        timer = setTimeout(load, (payload.retryAfterSeconds || 5) * 1000);
                    } else {
                        setError('The physician brief is still being prepared. Open the transcript below.');
                        setGenerating(false);
                    }
                    return;
                }
                const unwrapped = unwrapBriefPayload(payload.brief);
                setBrief(unwrapped.brief);
                setSafety(payload.safety ?? unwrapped.safety);
                setGeneratedAt(payload.generatedAt ?? null);
                setTranscript(payload.transcript ?? null);
                setGenerating(false);
                if (res.data?.code === 'BRIEF_NOT_READY' || res.data?.status === 'pending' || (!unwrapped.brief && !payload.brief)) {
                    setIsPending(true);
                    setError(null);
                } else {
                    setIsPending(false);
                    setError(null);
                }
            } catch (err: any) {
                if (cancelled) return;
                const body = err?.response?.data;
                setTranscript(body?.data?.transcript ?? null);
                if (err.response?.status === 404) {
                    if (body?.code === 'BRIEF_GENERATION_FAILED') {
                        setError('The AI brief could not be generated for this intake. The transcript is still available.');
                        setIsPending(false);
                    } else {
                        setError('Intake not yet completed');
                        setIsPending(true);
                    }
                } else if (err.response?.status === 403) {
                    setIsForbidden(true);
                    setError(null);
                    setIsPending(false);
                } else {
                    setError('Failed to load physician brief');
                    setIsPending(false);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        setLoading(true);
        load();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [consultationId]);

    if (loading || generating) {
        return (
            <Card className="border-2 border-green-200 bg-green-50/50">
                <CardContent className="p-6 text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-green-500 mx-auto" />
                    <p className="text-sm text-gray-500 mt-2 dark:text-gray-400">
                        {generating ? 'Preparing the physician brief from the intake…' : 'Loading physician brief...'}
                    </p>
                </CardContent>
            </Card>
        );
    }

    if (!brief) {
        if (isForbidden) {
            return null;
        }

        const isInProgress = isPending || error === 'Intake not yet completed' || (!error && !brief);

        if (isInProgress) {
            return (
                <Card className="border border-amber-200 bg-amber-50/60 dark:bg-amber-900/10" data-testid="physician-brief-in-progress">
                    <CardContent className="p-4 space-y-2">
                        <div className="flex items-center gap-2">
                            <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                                Patient intake is currently in progress — physician brief will be available once intake is completed.
                            </p>
                        </div>
                        <p className="text-xs text-amber-700/80 dark:text-amber-300/80">
                            Intake not yet completed
                        </p>
                        {transcript && (
                            <details className="mt-2">
                                <summary className="text-xs text-amber-700 cursor-pointer dark:text-amber-300 font-medium hover:underline">
                                    View intake transcript
                                </summary>
                                <pre className="mt-2 text-xs text-gray-600 whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto dark:text-gray-300 p-2 bg-white/70 dark:bg-slate-900/50 rounded border border-amber-100 dark:border-amber-900/30">
                                    {transcript}
                                </pre>
                            </details>
                        )}
                    </CardContent>
                </Card>
            );
        }

        if (error) {
            return (
                <Card className="border border-amber-200 bg-amber-50/60 dark:bg-amber-900/10" data-testid="physician-brief-error">
                    <CardContent className="p-4 space-y-2">
                        <p className="text-sm text-amber-800 dark:text-amber-200">{error}</p>
                        {transcript && (
                            <details className="mt-2">
                                <summary className="text-xs text-amber-700 cursor-pointer dark:text-amber-300 font-medium hover:underline">
                                    View intake transcript
                                </summary>
                                <pre className="mt-2 text-xs text-gray-600 whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto dark:text-gray-300 p-2 bg-white/70 dark:bg-slate-900/50 rounded border border-amber-100 dark:border-amber-900/30">
                                    {transcript}
                                </pre>
                            </details>
                        )}
                    </CardContent>
                </Card>
            );
        }

        return null;
    }

    const triage = brief.triage || null;
    const triageTone: Record<string, string> = {
        emergency: 'bg-red-600 text-white',
        urgent: 'bg-amber-500 text-white',
        routine: 'bg-emerald-600 text-white',
    };
    const completenessPct = typeof brief.completeness?.percent === 'number' ? Math.round(brief.completeness.percent) : null;
    const historyEntries = brief.structuredHistory
        ? Object.entries(brief.structuredHistory)
            .filter(([k]) => k in HISTORY_LABELS)
            .map(([k, v]) => ({ key: k, label: HISTORY_LABELS[k], value: summariseHistoryValue(v), provenance: brief.historyProvenance?.[k] }))
            .filter((e) => e.value)
        : [];

    const likelihoodColors: Record<string, string> = {
        high: 'bg-red-100 text-red-700',
        moderate: 'bg-yellow-100 text-yellow-700',
        low: 'bg-blue-100 text-blue-700',
    };

    const rosStatusColors: Record<string, string> = {
        positive: 'text-red-600',
        negative: 'text-green-600',
        not_assessed: 'text-gray-400',
    };

    return (
        <Card className="border-2 border-green-300 bg-gradient-to-r from-green-50 to-emerald-50 shadow-lg">
            {/* Header */}
            <CardHeader
                className="cursor-pointer py-3"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">🤖</span>
                        <CardTitle className="text-green-800 text-base">
                            Doc Arion — Physician Brief
                        </CardTitle>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-200 text-green-700 font-medium">
                            AI Generated
                        </span>
                    </div>
                    <span className="text-gray-500 text-sm dark:text-gray-400">
                        {expanded ? '▲' : '▼'}
                    </span>
                </div>
            </CardHeader>

            {expanded && (
                <CardContent className="space-y-5 pt-0">
                    {/* Triage + completeness at a glance */}
                    {(triage || completenessPct !== null || generatedAt) && (
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            {triage?.category && (
                                <span className={`px-2.5 py-1 rounded-full font-bold uppercase tracking-wide ${triageTone[triage.category] || 'bg-gray-200 text-gray-800'}`}>
                                    {triage.category}{typeof triage.esiLevel === 'number' ? ` · ESI ${triage.esiLevel}` : ''}
                                </span>
                            )}
                            {triage?.reason && (
                                <span className="text-gray-600 dark:text-gray-300">{triage.reason}</span>
                            )}
                            {completenessPct !== null && (
                                <span className="ml-auto inline-flex items-center gap-1.5 text-gray-600 dark:text-gray-300" title={brief.completeness?.missingRequired?.length ? `Missing: ${brief.completeness.missingRequired.join(', ')}` : 'All required history domains captured'}>
                                    <span className="relative inline-block h-2 w-20 rounded-full bg-gray-200 overflow-hidden dark:bg-slate-700">
                                        <span className="absolute left-0 top-0 h-full bg-green-500" style={{ width: `${completenessPct}%` }} />
                                    </span>
                                    History {completenessPct}% complete
                                </span>
                            )}
                            {generatedAt && (
                                <span className="text-gray-500 dark:text-gray-400">Generated {new Date(generatedAt).toLocaleString()}</span>
                            )}
                        </div>
                    )}

                    {/* Changes since last visit (carry-over) */}
                    {brief.changesSinceLastVisit && brief.changesSinceLastVisit.length > 0 && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 dark:bg-blue-900/20">
                            <p className="text-xs font-bold text-blue-700 uppercase tracking-wider mb-1.5">
                                🔁 Changes since last visit
                            </p>
                            <ul className="space-y-1">
                                {brief.changesSinceLastVisit.map((c, i) => (
                                    <li key={i} className="text-xs text-blue-900 dark:text-blue-100">
                                        <span className="font-medium">{HISTORY_LABELS[c.domain] || c.domain}:</span>{' '}
                                        <span className="line-through text-blue-700/70">{c.previous}</span> → {c.current}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Red Flags */}
                    {brief.redFlags && brief.redFlags.length > 0 && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 dark:bg-red-900/20">
                            <p className="text-xs font-bold text-red-700 uppercase tracking-wider mb-1.5">
                                🚩 Red Flags
                            </p>
                            <ul className="space-y-1">
                                {brief.redFlags.map((flag, i) => (
                                    <li key={i} className="text-sm text-red-600 flex gap-1.5">
                                        <span>⚠</span> {flag}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Chief Complaint */}
                    <div>
                        <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400">
                            Chief Complaint
                        </p>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">{brief.chiefComplaint}</p>
                    </div>

                    {/* HPI */}
                    <div>
                        <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400">
                            History of Present Illness
                        </p>
                        <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line dark:text-gray-300">
                            {brief.hpiNarrative}
                        </p>
                    </div>

                    {/* Differential Diagnosis */}
                    {brief.differentialDiagnosis && brief.differentialDiagnosis.length > 0 && (
                        <div>
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 dark:text-gray-400">
                                Differential Diagnosis
                            </p>
                            <div className="space-y-2">
                                {brief.differentialDiagnosis.map((dx, i) => (
                                    <div key={i} className="bg-white rounded-lg p-3 border border-gray-100 dark:bg-slate-800">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-medium text-sm text-gray-900 dark:text-white">
                                                {i + 1}. {dx.name}
                                            </span>
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                                                likelihoodColors[dx.likelihood] || 'bg-gray-100 text-gray-600'
                                            }`}>
                                                {dx.likelihood}
                                            </span>
                                        </div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400">{dx.reasoning}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ROS */}
                    {brief.reviewOfSystems && brief.reviewOfSystems.length > 0 && (
                        <div>
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 dark:text-gray-400">
                                Review of Systems
                            </p>
                            <div className="bg-white rounded-lg border border-gray-100 overflow-hidden dark:bg-slate-800">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-gray-50 dark:bg-slate-800">
                                            <th className="text-left px-3 py-2 font-medium text-gray-500 dark:text-gray-400">System</th>
                                            <th className="text-left px-3 py-2 font-medium text-gray-500 dark:text-gray-400">Findings</th>
                                            <th className="text-center px-3 py-2 font-medium text-gray-500 dark:text-gray-400">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {brief.reviewOfSystems.map((ros, i) => (
                                            <tr key={i} className="border-t border-gray-50">
                                                <td className="px-3 py-2 font-medium text-gray-700 dark:text-gray-300">{ros.system}</td>
                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{ros.findings}</td>
                                                <td className={`px-3 py-2 text-center font-medium ${rosStatusColors[ros.status]}`}>
                                                    {ros.status === 'positive' ? '(+)' : ros.status === 'negative' ? '(-)' : 'N/A'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Medications & Allergies */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400">
                                💊 Medications
                            </p>
                            {brief.medicationList && brief.medicationList.length > 0 ? (
                                <ul className="space-y-0.5">
                                    {brief.medicationList.map((med, i) => (
                                        <li key={i} className="text-xs text-gray-700 dark:text-gray-300">• {med}</li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-xs text-gray-500 dark:text-gray-400">None reported</p>
                            )}
                        </div>
                        <div>
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400">
                                ⚠️ Allergies
                            </p>
                            {brief.allergyList && brief.allergyList.length > 0 ? (
                                <ul className="space-y-0.5">
                                    {brief.allergyList.map((allergy, i) => (
                                        <li key={i} className="text-xs text-red-600">• {allergy}</li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-xs text-gray-500 dark:text-gray-400">NKDA</p>
                            )}
                        </div>
                    </div>

                    {/* Suggested Questions */}
                    {brief.suggestedQuestions && brief.suggestedQuestions.length > 0 && (
                        <div>
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400">
                                💡 Suggested Follow-Up Questions
                            </p>
                            <ul className="space-y-1">
                                {brief.suggestedQuestions.map((q, i) => (
                                    <li key={i} className="text-xs text-gray-700 flex gap-2 dark:text-gray-300">
                                        <span className="text-green-500 flex-shrink-0">{i + 1}.</span> {q}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Suggested plan */}
                    {brief.suggestedPlan && (
                        (brief.suggestedPlan.investigations?.length || brief.suggestedPlan.initialManagement?.length || brief.suggestedPlan.safetyNetting?.length) ? (
                            <div className="grid sm:grid-cols-3 gap-3">
                                {([
                                    ['Investigations', brief.suggestedPlan.investigations],
                                    ['Initial management', brief.suggestedPlan.initialManagement],
                                    ['Safety netting', brief.suggestedPlan.safetyNetting],
                                ] as [string, string[] | undefined][]).map(([label, items]) => items && items.length ? (
                                    <div key={label} className="bg-white rounded-lg p-3 border border-gray-100 dark:bg-slate-800">
                                        <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400">{label}</p>
                                        <ul className="space-y-0.5">
                                            {items.map((it, i) => (
                                                <li key={i} className="text-xs text-gray-700 dark:text-gray-300">• {it}</li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null)}
                            </div>
                        ) : null
                    )}

                    {/* Structured history (OLD-CARTS + domains) */}
                    {historyEntries.length > 0 && (
                        <div>
                            <button
                                type="button"
                                onClick={() => setShowHistory(!showHistory)}
                                className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400 hover:text-gray-700"
                            >
                                {showHistory ? '▼' : '▶'} Structured history ({historyEntries.length} domains)
                            </button>
                            {showHistory && (
                                <dl className="bg-white rounded-lg border border-gray-100 divide-y divide-gray-50 dark:bg-slate-800">
                                    {historyEntries.map((e) => (
                                        <div key={e.key} className="px-3 py-2 grid grid-cols-[9rem_1fr] gap-2 text-xs">
                                            <dt className="font-medium text-gray-700 dark:text-gray-300">
                                                {e.label}
                                                {e.provenance && e.provenance !== 'newly_taken' && (
                                                    <span className="ml-1 text-[10px] text-gray-400">({e.provenance.replace(/_/g, ' ')})</span>
                                                )}
                                            </dt>
                                            <dd className="text-gray-600 dark:text-gray-300 break-words">{e.value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            )}
                        </div>
                    )}

                    {/* Explicit negatives / context */}
                    {(brief.explicitNegatives?.length || brief.contextNotes) && (
                        <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
                            {brief.explicitNegatives && brief.explicitNegatives.length > 0 && (
                                <p><span className="font-medium">Denies:</span> {brief.explicitNegatives.join(', ')}</p>
                            )}
                            {brief.contextNotes && <p><span className="font-medium">Context:</span> {brief.contextNotes}</p>}
                        </div>
                    )}

                    {/* Vitals to Check */}
                    {brief.vitalSignsToCheck && brief.vitalSignsToCheck.length > 0 && (
                        <div>
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1 dark:text-gray-400">
                                🩺 Recommended Vitals
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {brief.vitalSignsToCheck.map((vital, i) => (
                                    <span key={i} className="text-xs px-2 py-1 bg-white border border-gray-200 rounded-full text-gray-600 dark:text-gray-300 dark:bg-slate-800">
                                        {vital}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Transcript Toggle */}
                    {transcript && (
                        <div className="border-t border-green-200 pt-3">
                            <button
                                onClick={() => setShowTranscript(!showTranscript)}
                                className="text-xs text-green-600 font-medium hover:text-green-800 transition-colors"
                            >
                                {showTranscript ? '▼ Hide Intake Transcript' : '▶ View Full Intake Transcript'}
                            </button>
                            {showTranscript && (
                                <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4 max-h-80 overflow-y-auto dark:bg-slate-800">
                                    <pre className="text-xs text-gray-600 whitespace-pre-wrap font-sans leading-relaxed dark:text-gray-300">
                                        {transcript}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Disclaimer */}
                    <p className="text-[10px] text-gray-500 text-center pt-2 border-t border-green-100 dark:text-gray-400">
                        ⚕️ AI-generated summary — verify all information independently. Not a substitute for clinical judgment.
                        {safety?.risk_level && <> · Safety review: {safety.risk_level} risk{safety.safety_flags?.length ? ` (${safety.safety_flags.join(', ')})` : ''}</>}
                    </p>
                </CardContent>
            )}
        </Card>
    );
}
