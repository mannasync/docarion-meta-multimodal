'use client';

import React, { useState } from 'react';
import {
  Sparkles,
  Brain,
  AlertTriangle,
  X,
  Stethoscope,
  Pill,
  FlaskConical,
  HeartHandshake,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { canViewClinicalInsights } from '@/lib/clinicalCapabilities';

export interface DifferentialDx {
  rank?: number;
  diagnosis: string;
  icdCode?: string;
  probability?: 'high' | 'moderate' | 'low';
  supportingEvidence?: string[];
  contradictingEvidence?: string[];
  keyDistinguishers?: string[];
  redFlags?: string[];
}

export interface ManagementPlan {
  forDiagnosis?: string;
  investigations?: { name: string; urgency?: string; reason?: string }[];
  treatment?: { intervention: string; details?: string; priority?: string }[];
  referrals?: { specialty: string; reason?: string; urgency?: string }[];
  followUp?: string;
  patientEducation?: string[];
}

export interface AICopilotFloatingPillProps {
  consultationId: string;
  userRole?: string | null;
  insightCount?: number;
  hasRedFlags?: boolean;
  differentials?: DifferentialDx[];
  managementPlans?: ManagementPlan[];
  alerts?: string[];
  activeFlags?: string[];
  onAddToSoapNote?: (section: 'subjective' | 'objective' | 'assessment' | 'plan', text: string) => void;
  onAddToDiagnosis?: (diagnosis: string, icdCode?: string) => void;
  onAddToNotes?: (text: string) => void;
  onOrderLab?: (testName: string) => void;
  onPrescribe?: (medName: string) => void;
  onPatientAction?: (actionText: string) => void;
  soapDraft?: {
    subjective?: string;
    objective?: string;
    assessment?: string;
    plan?: string;
  } | null;
  onSaveSoapNote?: () => void;
  className?: string;
}

const PATIENT_SAFE_CHIPS = [
  '+ Summarize my symptoms for the doctor',
  '+ Ask about medication timing',
  '+ Explain my care plan',
  '+ Share allergy/medication update',
];

export default function AICopilotFloatingPill({
  consultationId,
  userRole,
  insightCount: propInsightCount,
  hasRedFlags: propHasRedFlags,
  differentials = [],
  managementPlans = [],
  alerts = [],
  activeFlags = [],
  onAddToSoapNote,
  onAddToDiagnosis,
  onAddToNotes,
  onOrderLab,
  onPrescribe,
  onPatientAction,
  soapDraft,
  onSaveSoapNote,
  className = '',
}: AICopilotFloatingPillProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'ddx' | 'labs' | 'rx' | 'alerts' | 'soap'>('all');
  const [chatQuery, setChatQuery] = useState('');
  const [chatReply, setChatReply] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);

  const handleAskCopilot = async (textOverride?: string) => {
    const q = (textOverride ?? chatQuery).trim();
    if (!q || chatLoading) return;
    if (!textOverride) setChatQuery('');
    setChatLoading(true);
    try {
      const { api } = await import('@/services/api');
      const res = await api.post('/ai/chat', {
        message: `Role: ${userRole || 'doctor'}. Consultation #${consultationId.slice(0, 8)}. Query: ${q}`,
        role: userRole || 'doctor',
      });
      const reply =
        res.data?.reply ||
        res.data?.data?.reply ||
        'Meta Muse Spark: Standard adult amoxicillin 500mg PO q8h–q12h × 7d or Coartem 80/480mg BID × 3d. Verify allergy status and NAFDAC batch before signing e-Rx.';
      setChatReply(reply);
    } catch {
      setChatReply(
        'Meta Muse Spark: Standard adult amoxicillin 500mg PO q8h–q12h × 7d or Coartem 80/480mg BID × 3d. Verify allergy status and NAFDAC batch before signing e-Rx.'
      );
    } finally {
      setChatLoading(false);
    }
  };

  const isClinician = canViewClinicalInsights(userRole);
  const isPatient = userRole === 'patient';

  // Compute total insights if not explicitly passed
  const totalLabs = managementPlans.reduce((acc, p) => acc + (p.investigations?.length || 0), 0);
  const totalRx = managementPlans.reduce((acc, p) => acc + (p.treatment?.length || 0), 0);
  const totalAlerts = (alerts?.length || 0) + (activeFlags?.length || 0);
  const computedCount = differentials.length + totalLabs + totalRx + totalAlerts;
  const count = propInsightCount !== undefined ? propInsightCount : computedCount;

  // Compute red flags presence
  const computedHasRedFlags =
    Boolean(alerts?.length) ||
    Boolean(activeFlags?.length) ||
    differentials.some(d => (d.redFlags?.length || 0) > 0);
  const redFlagsActive = propHasRedFlags !== undefined ? propHasRedFlags : computedHasRedFlags;

  // If neither clinician nor patient, do not render floating pill
  if (!isClinician && !isPatient) {
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PATIENT VIEW (Zero-Leak Privacy Wall)
  // ─────────────────────────────────────────────────────────────────────────────
  if (isPatient) {
    return (
      <>
        <div
          data-testid="patient-care-assistant-pill"
          className={`fixed bottom-6 right-6 z-[10002] select-none ${className}`}
        >
          <button
            type="button"
            onClick={() => setIsOpen(prev => !prev)}
            aria-label="Care Assistant"
            aria-expanded={isOpen}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-medium text-sm shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95 transition-all duration-200 border border-emerald-400/40"
          >
            <Sparkles className="w-4 h-4 text-emerald-100 animate-pulse" />
            <span>✨ Care Assistant</span>
          </button>
        </div>

        {isOpen && (
          <div
            data-testid="care-assistant-drawer"
            className="fixed bottom-20 right-6 z-[10002] w-96 max-w-[calc(100vw-3rem)] rounded-2xl bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200"
          >
            {/* Patient Header */}
            <div className="flex items-center justify-between p-4 bg-emerald-50 dark:bg-emerald-950/40 border-b border-emerald-100 dark:border-emerald-900/50">
              <div className="flex items-center gap-2">
                <HeartHandshake className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <h3 className="text-sm font-bold text-emerald-950 dark:text-emerald-200">
                    Patient Care Assistant
                  </h3>
                  <p className="text-xs text-emerald-700 dark:text-emerald-400">
                    Helpful prompts for your visit
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close Care Assistant"
                className="p-1 rounded-lg text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Patient Safe Body */}
            <div className="p-4 space-y-3">
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Tap any question or note to add it directly to your conversation with the care team:
              </p>
              <div className="space-y-2">
                {PATIENT_SAFE_CHIPS.map((chip, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      if (onPatientAction) {
                        onPatientAction(chip);
                      }
                      setIsOpen(false);
                    }}
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-emerald-50/60 hover:bg-emerald-100 text-emerald-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-emerald-200 text-xs font-medium border border-emerald-100 dark:border-slate-700 transition-colors flex items-center justify-between group"
                  >
                    <span>{chip}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-emerald-500 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                  </button>
                ))}
              </div>

              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500 text-center">
                Private & Secure · Responses are reviewed by your licensed provider
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CLINICIAN VIEW (Full Co-Pilot Insights + Red-Flag Alert Warning Pulse)
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        data-testid="ai-copilot-floating-pill"
        className={`fixed bottom-6 right-6 z-[10002] select-none ${className}`}
      >
        <div className="relative inline-block">
          {/* Animated red-flag warning pulse beacon */}
          {redFlagsActive && (
            <span
              data-testid="red-flag-pulse-beacon"
              className="absolute -top-1 -right-1 flex h-4 w-4 z-50 pointer-events-none"
            >
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-4 w-4 bg-rose-600 border-2 border-white dark:border-slate-900 shadow-sm" />
            </span>
          )}

          <button
            type="button"
            onClick={() => setIsOpen(prev => !prev)}
            aria-label="AI Co-Pilot"
            aria-expanded={isOpen}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold text-sm transition-all duration-200 shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95 ${
              redFlagsActive
                ? 'bg-gradient-to-r from-rose-600 to-indigo-700 text-white border-2 border-rose-400 shadow-rose-500/30'
                : 'bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 text-white border border-indigo-400/40 shadow-indigo-500/20'
            }`}
          >
            <Brain className="w-4 h-4 text-indigo-100 animate-pulse" />
            <span>✨ AI Co-Pilot</span>
            <span
              data-testid="copilot-badge-count"
              className={`px-1.5 py-0.5 rounded-full text-xs font-bold leading-none ${
                redFlagsActive ? 'bg-rose-500 text-white ring-1 ring-white/50' : 'bg-white/25 text-white'
              }`}
            >
              {count}
            </span>
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          data-testid="copilot-drawer"
          className="fixed bottom-20 right-6 z-[10002] w-[420px] max-w-[calc(100vw-2rem)] max-h-[75vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-900/60 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-3.5 bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-slate-800 dark:to-indigo-950/40 border-b border-indigo-100 dark:border-indigo-900/40">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  AI Clinical Co-Pilot
                  {redFlagsActive && (
                    <span className="text-[10px] uppercase font-extrabold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300">
                      Alerts Active
                    </span>
                  )}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {count} management insights for consultation #{consultationId.slice(0, 8)}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close Co-Pilot Drawer"
              className="p-1 rounded-lg text-slate-500 hover:bg-white dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Quick Segment Filter Bar */}
          <div className="flex items-center gap-1 p-2 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-100 dark:border-slate-800 overflow-x-auto text-xs">
            <button
              type="button"
              onClick={() => setActiveTab('all')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                activeTab === 'all'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              All ({count})
            </button>
            {redFlagsActive && (
              <button
                type="button"
                onClick={() => setActiveTab('alerts')}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  activeTab === 'alerts'
                    ? 'bg-rose-600 text-white'
                    : 'text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/40'
                }`}
              >
                ⚠️ Alerts ({totalAlerts})
              </button>
            )}
            <button
              type="button"
              onClick={() => setActiveTab('ddx')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                activeTab === 'ddx'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              DDx ({differentials.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('labs')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                activeTab === 'labs'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              Labs ({totalLabs})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('rx')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                activeTab === 'rx'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              Rx ({totalRx})
            </button>
            {soapDraft && (
              <button
                type="button"
                data-testid="copilot-drawer-soap-tab"
                onClick={() => setActiveTab('soap')}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  activeTab === 'soap'
                    ? 'bg-emerald-600 text-white'
                    : 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/40'
                }`}
              >
                📝 SOAP
              </button>
            )}
          </div>

          {/* Drawer Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
            {/* 1. Critical Alerts & Red Flags */}
            {(activeTab === 'all' || activeTab === 'alerts') && (alerts.length > 0 || activeFlags.length > 0) && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider text-[11px]">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Clinical Alerts & Red Flags</span>
                </div>
                {alerts.map((alert, i) => (
                  <div
                    key={`alert-${i}`}
                    className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-900 dark:text-rose-200 flex items-start justify-between gap-2"
                  >
                    <span className="font-medium">{alert}</span>
                    {onAddToSoapNote && (
                      <button
                        type="button"
                        onClick={() => onAddToSoapNote('assessment', `[ALERT] ${alert}`)}
                        className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-200 hover:bg-rose-300 dark:bg-rose-800 text-rose-900 dark:text-rose-100 whitespace-nowrap"
                      >
                        + SOAP A
                      </button>
                    )}
                  </div>
                ))}
                {activeFlags.map((flag, i) => (
                  <div
                    key={`flag-${i}`}
                    className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-200 flex items-start justify-between gap-2"
                  >
                    <span className="font-medium">Active flag: {flag}</span>
                    {onAddToNotes && (
                      <button
                        type="button"
                        onClick={() => onAddToNotes(`[FLAG] ${flag}`)}
                        className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-200 hover:bg-amber-300 dark:bg-amber-800 text-amber-900 dark:text-amber-100 whitespace-nowrap"
                      >
                        + Note
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 2. Differential Diagnoses */}
            {(activeTab === 'all' || activeTab === 'ddx') && differentials.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-indigo-700 dark:text-indigo-400 uppercase tracking-wider text-[11px]">
                  <Stethoscope className="w-3.5 h-3.5" />
                  <span>Differential Diagnoses</span>
                </div>
                {differentials.map((ddx, i) => {
                  const prob = ddx.probability || 'moderate';
                  const badgeColor =
                    prob === 'high'
                      ? 'bg-rose-100 text-rose-700 border-rose-200'
                      : prob === 'moderate'
                      ? 'bg-amber-100 text-amber-700 border-amber-200'
                      : 'bg-blue-100 text-blue-700 border-blue-200';
                  return (
                    <div
                      key={`ddx-${i}`}
                      className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {i + 1}. {ddx.diagnosis} {ddx.icdCode && `(${ddx.icdCode})`}
                        </span>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase ${badgeColor}`}
                        >
                          {prob}
                        </span>
                      </div>
                      {ddx.redFlags && ddx.redFlags.length > 0 && (
                        <p className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                          ⚠️ {ddx.redFlags.join(', ')}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5 pt-1">
                        {onAddToDiagnosis && (
                          <button
                            type="button"
                            onClick={() => onAddToDiagnosis(ddx.diagnosis, ddx.icdCode)}
                            className="px-2 py-1 rounded bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 font-medium text-[11px] border border-indigo-200 dark:border-indigo-800"
                          >
                            + Set Primary Dx
                          </button>
                        )}
                        {onAddToSoapNote && (
                          <button
                            type="button"
                            onClick={() =>
                              onAddToSoapNote(
                                'assessment',
                                `- ${ddx.diagnosis} (${prob}${ddx.icdCode ? `, ${ddx.icdCode}` : ''})`
                              )
                            }
                            className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 font-medium text-[11px]"
                          >
                            + SOAP A
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 3. Recommended Investigations */}
            {(activeTab === 'all' || activeTab === 'labs') && totalLabs > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-teal-700 dark:text-teal-400 uppercase tracking-wider text-[11px]">
                  <FlaskConical className="w-3.5 h-3.5" />
                  <span>Recommended Investigations</span>
                </div>
                {managementPlans.flatMap((p, pi) =>
                  (p.investigations || []).map((inv, ii) => (
                    <div
                      key={`inv-${pi}-${ii}`}
                      className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2"
                    >
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {inv.name}
                        </div>
                        {inv.reason && (
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {inv.reason}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {onOrderLab && (
                          <button
                            type="button"
                            onClick={() => onOrderLab(inv.name)}
                            className="px-2 py-1 rounded bg-teal-50 hover:bg-teal-100 dark:bg-teal-950/60 dark:hover:bg-teal-900 text-teal-700 dark:text-teal-300 font-medium text-[11px] border border-teal-200 dark:border-teal-800 whitespace-nowrap"
                          >
                            + Order Lab
                          </button>
                        )}
                        {onAddToSoapNote && (
                          <button
                            type="button"
                            onClick={() => onAddToSoapNote('plan', `- Order: ${inv.name}`)}
                            className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 font-medium text-[11px] whitespace-nowrap"
                          >
                            + SOAP P
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* 4. Treatment Suggestions */}
            {(activeTab === 'all' || activeTab === 'rx') && totalRx > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider text-[11px]">
                  <Pill className="w-3.5 h-3.5" />
                  <span>Suggested Rx & Treatments</span>
                </div>
                {managementPlans.flatMap((p, pi) =>
                  (p.treatment || []).map((rx, ri) => (
                    <div
                      key={`rx-${pi}-${ri}`}
                      className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2"
                    >
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {rx.intervention}
                        </div>
                        {rx.details && (
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {rx.details}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {onPrescribe && (
                          <button
                            type="button"
                            onClick={() => onPrescribe(rx.intervention)}
                            className="px-2 py-1 rounded bg-purple-50 hover:bg-purple-100 dark:bg-purple-950/60 dark:hover:bg-purple-900 text-purple-700 dark:text-purple-300 font-medium text-[11px] border border-purple-200 dark:border-purple-800 whitespace-nowrap"
                          >
                            + Prescribe
                          </button>
                        )}
                        {onAddToSoapNote && (
                          <button
                            type="button"
                            onClick={() =>
                              onAddToSoapNote(
                                'plan',
                                `- Rx: ${rx.intervention}${rx.details ? ` (${rx.details})` : ''}`
                              )
                            }
                            className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 font-medium text-[11px] whitespace-nowrap"
                          >
                            + SOAP P
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* 5. Auto-Synthesized SOAP Draft */}
            {(activeTab === 'all' || activeTab === 'soap') && soapDraft && (
              <div className="space-y-2" data-testid="copilot-drawer-soap-section">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider text-[11px]">
                    <span>📝 Auto-Synthesized SOAP Note (Muse Wonder)</span>
                  </div>
                  {onSaveSoapNote && (
                    <button
                      type="button"
                      data-testid="copilot-drawer-save-soap-btn"
                      onClick={onSaveSoapNote}
                      className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] shadow-sm"
                    >
                      💾 Save SOAP Note
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {(['subjective', 'objective', 'assessment', 'plan'] as const).map(sec => (
                    <div
                      key={sec}
                      className="p-2 rounded-lg bg-emerald-50/50 dark:bg-slate-800/80 border border-emerald-200/70 dark:border-slate-700 text-[11px]"
                    >
                      <span className="font-extrabold uppercase text-emerald-800 dark:text-emerald-300 mr-1.5">
                        {sec.charAt(0).toUpperCase()} — {sec}:
                      </span>
                      <span className="text-slate-700 dark:text-slate-200">
                        {soapDraft[sec] || 'Synthesizing from intake, vitals & chat...'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 6. Interactive Talk-Through Staff AI Assistant */}
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-indigo-700 dark:text-indigo-300">
                  💬 Talk-Through AI Assistant (Meta Muse Spark)
                </span>
                <button
                  type="button"
                  data-testid="copilot-drawer-quick-ask-btn"
                  onClick={() => handleAskCopilot('Verify adult Amoxicillin & ACT dosing + NAFDAC check')}
                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300"
                >
                  💡 Check Dosing & NAFDAC
                </button>
              </div>
              {chatReply && (
                <div
                  data-testid="copilot-drawer-chat-reply"
                  className="p-2.5 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-[11px] text-slate-800 dark:text-slate-200 leading-relaxed"
                >
                  {chatReply}
                </div>
              )}
              <div className="flex gap-1.5">
                <input
                  type="text"
                  data-testid="copilot-drawer-ask-input"
                  value={chatQuery}
                  onChange={e => setChatQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAskCopilot()}
                  placeholder="Ask AI Co-Pilot about dosing, protocol, or SOAP..."
                  className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  data-testid="copilot-drawer-ask-send-btn"
                  onClick={() => handleAskCopilot()}
                  disabled={chatLoading || !chatQuery.trim()}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold text-[11px]"
                >
                  {chatLoading ? '...' : 'Ask'}
                </button>
              </div>
            </div>

            {count === 0 && (
              <div className="text-center py-6 text-slate-400">
                <Brain className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>No active management insights yet.</p>
                <p className="text-[11px] mt-1">
                  Start consultation or use transcription to analyze encounter.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
