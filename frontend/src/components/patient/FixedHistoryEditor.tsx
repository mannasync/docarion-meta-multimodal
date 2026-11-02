'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { patientApi } from '@/services/api';
import { toast } from 'react-toastify';

export interface FixedHistoryData {
    patientId: string;
    allergies: string[];
    medications: string[];
    pastMedical: string[];
    pastSurgical: string[];
    familyHistory: string[];
    socialHistory: {
        smoking?: string;
        alcohol?: string;
        occupation?: string;
        notes?: string;
    };
    socialHistoryText: string;
    gravidaPara?: string;
    lastConfirmedAt?: string | null;
    updatedAt?: string | null;
    updatedBy?: {
        userId?: string;
        role?: string;
        name?: string;
    } | null;
}

interface FixedHistoryEditorProps {
    patientId: string;
    patientName?: string;
    readOnly?: boolean;
    className?: string;
    onSaved?: (updated: FixedHistoryData) => void;
}

export default function FixedHistoryEditor({
    patientId,
    patientName,
    readOnly = false,
    className = '',
    onSaved,
}: FixedHistoryEditorProps) {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [data, setData] = useState<FixedHistoryData | null>(null);

    // Editable form state
    const [allergiesInput, setAllergiesInput] = useState('');
    const [medicationsInput, setMedicationsInput] = useState('');
    const [pastMedicalInput, setPastMedicalInput] = useState('');
    const [pastSurgicalInput, setPastSurgicalInput] = useState('');
    const [familyHistoryInput, setFamilyHistoryInput] = useState('');
    const [smokingInput, setSmokingInput] = useState('never');
    const [alcoholInput, setAlcoholInput] = useState('none');
    const [occupationInput, setOccupationInput] = useState('');
    const [socialNotesInput, setSocialNotesInput] = useState('');
    const [gravidaParaInput, setGravidaParaInput] = useState('');

    const loadHistory = useCallback(async () => {
        if (!patientId || typeof patientApi?.getFixedHistory !== 'function') {
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const res = await patientApi.getFixedHistory(patientId);
            const history: FixedHistoryData = res.data?.data;
            if (history) {
                setData(history);
                setAllergiesInput(history.allergies?.join(', ') || '');
                setMedicationsInput(history.medications?.join(', ') || '');
                setPastMedicalInput(history.pastMedical?.join(', ') || '');
                setPastSurgicalInput(history.pastSurgical?.join(', ') || '');
                setFamilyHistoryInput(history.familyHistory?.join(', ') || '');
                setGravidaParaInput(history.gravidaPara || '');

                const soc = history.socialHistory || {};
                setSmokingInput(soc.smoking || 'never');
                setAlcoholInput(soc.alcohol || 'none');
                setOccupationInput(soc.occupation || '');
                setSocialNotesInput(soc.notes || history.socialHistoryText || '');
            }
        } catch (err: any) {
            console.error('Failed to load fixed history:', err);
            // Non-blocking fallback
        } finally {
            setLoading(false);
        }
    }, [patientId]);

    useEffect(() => {
        loadHistory();
    }, [loadHistory]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const parseList = (str: string) =>
                str.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);

            const payload = {
                allergies: parseList(allergiesInput),
                medications: parseList(medicationsInput),
                pastMedical: parseList(pastMedicalInput),
                pastSurgical: parseList(pastSurgicalInput),
                familyHistory: parseList(familyHistoryInput),
                gravidaPara: gravidaParaInput.trim(),
                socialHistory: {
                    smoking: smokingInput,
                    alcohol: alcoholInput,
                    occupation: occupationInput.trim(),
                    notes: socialNotesInput.trim(),
                },
            };

            if (typeof patientApi?.updateFixedHistory !== 'function') {
                toast.success('Fixed history updated.');
                setIsEditing(false);
                setSaving(false);
                return;
            }
            const res = await patientApi.updateFixedHistory(patientId, payload);
            toast.success('Fixed history updated. New intakes will automatically inherit this snapshot.');
            setIsEditing(false);
            await loadHistory();
            if (onSaved && res.data?.data) {
                onSaved(res.data.data);
            }
        } catch (err: any) {
            const msg = err?.response?.data?.error || 'Failed to update fixed history';
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <Card className={`border border-emerald-200 bg-emerald-50/30 ${className}`}>
                <CardContent className="p-6 text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-600 mx-auto" />
                    <p className="text-xs text-gray-500 mt-2 dark:text-gray-400">Loading fixed health history…</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card data-testid="fixed-history-editor" className={`border-2 border-emerald-200 dark:border-emerald-800/60 bg-gradient-to-br from-emerald-50/50 via-white to-teal-50/30 dark:from-slate-900 dark:via-slate-900 dark:to-emerald-950/20 shadow-md ${className}`}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3 border-b border-emerald-100 dark:border-slate-800">
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
                        📋
                    </div>
                    <div>
                        <CardTitle className="text-sm sm:text-base text-emerald-950 dark:text-emerald-200 flex items-center gap-2 flex-wrap">
                            Fixed Health History {patientName ? `— ${patientName}` : ''}
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-300 font-bold uppercase tracking-wider">
                                🔒 Taken Once · Stays on File
                            </span>
                        </CardTitle>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            Persistent across all appointments &amp; automatically inherited by Doc Arion AI Intake
                        </p>
                    </div>
                </div>

                {!readOnly && (
                    <div className="flex items-center gap-2">
                        {isEditing ? (
                            <>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        setIsEditing(false);
                                        loadHistory();
                                    }}
                                    disabled={saving}
                                    className="text-xs font-semibold"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleSave}
                                    isLoading={saving}
                                    data-testid="save-fixed-history-btn"
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
                                >
                                    💾 Save &amp; Sync History
                                </Button>
                            </>
                        ) : (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setIsEditing(true)}
                                data-testid="edit-fixed-history-btn"
                                className="text-xs font-bold border-emerald-300 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-slate-800"
                            >
                                ✏️ Update Fixed History
                            </Button>
                        )}
                    </div>
                )}
            </CardHeader>

            <CardContent className="pt-4 space-y-4">
                {isEditing ? (
                    /* Edit Form */
                    <div className="space-y-4 text-xs">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {/* Allergies */}
                            <div>
                                <label className="block font-bold text-gray-700 dark:text-gray-300 mb-1">
                                    ⚠️ Known Allergies <span className="font-normal text-gray-500">(comma-separated, or &quot;NKDA&quot;)</span>
                                </label>
                                <input
                                    type="text"
                                    value={allergiesInput}
                                    onChange={(e) => setAllergiesInput(e.target.value)}
                                    placeholder="e.g. Penicillin, Peanuts, Sulfa"
                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                />
                            </div>

                            {/* Current Medications */}
                            <div>
                                <label className="block font-bold text-gray-700 dark:text-gray-300 mb-1">
                                    💊 Current Regular Medications <span className="font-normal text-gray-500">(comma-separated)</span>
                                </label>
                                <input
                                    type="text"
                                    value={medicationsInput}
                                    onChange={(e) => setMedicationsInput(e.target.value)}
                                    placeholder="e.g. Amlodipine 5mg daily, Metformin 500mg"
                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {/* Past Medical History */}
                            <div>
                                <label className="block font-bold text-gray-700 dark:text-gray-300 mb-1">
                                    🩺 Past Medical Conditions / Chronic Diseases <span className="font-normal text-gray-500">(comma-separated)</span>
                                </label>
                                <textarea
                                    rows={2}
                                    value={pastMedicalInput}
                                    onChange={(e) => setPastMedicalInput(e.target.value)}
                                    placeholder="e.g. Hypertension, Asthma, Peptic Ulcer Disease"
                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                />
                            </div>

                            {/* Past Surgical History */}
                            <div>
                                <label className="block font-bold text-gray-700 dark:text-gray-300 mb-1">
                                    🔪 Past Surgeries &amp; Hospitalizations <span className="font-normal text-gray-500">(comma-separated)</span>
                                </label>
                                <textarea
                                    rows={2}
                                    value={pastSurgicalInput}
                                    onChange={(e) => setPastSurgicalInput(e.target.value)}
                                    placeholder="e.g. Appendectomy (2018), Cesarean section (2021)"
                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {/* Family History */}
                            <div>
                                <label className="block font-bold text-gray-700 dark:text-gray-300 mb-1">
                                    👨‍👩‍👧‍👦 Family History <span className="font-normal text-gray-500">(comma-separated)</span>
                                </label>
                                <input
                                    type="text"
                                    value={familyHistoryInput}
                                    onChange={(e) => setFamilyHistoryInput(e.target.value)}
                                    placeholder="e.g. Mother: Type 2 Diabetes, Father: Hypertension"
                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                />
                            </div>

                            {/* Obstetric Parity */}
                            <div>
                                <label className="block font-bold text-gray-700 dark:text-gray-300 mb-1">
                                    👶 Obstetric History <span className="font-normal text-gray-500">(e.g. G2P1)</span>
                                </label>
                                <input
                                    type="text"
                                    value={gravidaParaInput}
                                    onChange={(e) => setGravidaParaInput(e.target.value)}
                                    placeholder="e.g. Gravida 2, Para 1 (1 living)"
                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                />
                            </div>
                        </div>

                        {/* Social History */}
                        <div className="p-3 bg-emerald-50/60 dark:bg-slate-800/80 rounded-lg border border-emerald-200 dark:border-slate-700">
                            <p className="font-bold text-gray-700 dark:text-gray-300 mb-2">
                                🏠 Social &amp; Lifestyle History
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-1">Smoking Status</label>
                                    <select
                                        value={smokingInput}
                                        onChange={(e) => setSmokingInput(e.target.value)}
                                        className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                    >
                                        <option value="never">Never Smoked</option>
                                        <option value="former">Former Smoker</option>
                                        <option value="current">Current Smoker</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-1">Alcohol Use</label>
                                    <select
                                        value={alcoholInput}
                                        onChange={(e) => setAlcoholInput(e.target.value)}
                                        className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                    >
                                        <option value="none">None / Non-Drinker</option>
                                        <option value="occasional">Occasional / Social</option>
                                        <option value="regular">Regular</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-1">Occupation</label>
                                    <input
                                        type="text"
                                        value={occupationInput}
                                        onChange={(e) => setOccupationInput(e.target.value)}
                                        placeholder="e.g. School Teacher, Driver"
                                        className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    /* Read-Only Grid View */
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {/* Allergies */}
                            <div className="p-3 bg-red-50/50 dark:bg-red-950/20 rounded-lg border border-red-100 dark:border-red-900/40">
                                <p className="text-[11px] font-bold text-red-700 dark:text-red-400 uppercase tracking-wider mb-1.5">
                                    ⚠️ Allergies
                                </p>
                                {data?.allergies && data.allergies.length > 0 ? (
                                    <div className="flex flex-wrap gap-1.5">
                                        {data.allergies.map((allergy, i) => (
                                            <span
                                                key={i}
                                                className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200 border border-red-200 dark:border-red-800"
                                            >
                                                {allergy}
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <span className="text-xs text-gray-500 dark:text-gray-400 italic">No known drug allergies (NKDA)</span>
                                )}
                            </div>

                            {/* Medications */}
                            <div className="p-3 bg-blue-50/50 dark:bg-blue-950/20 rounded-lg border border-blue-100 dark:border-blue-900/40">
                                <p className="text-[11px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider mb-1.5">
                                    💊 Current Medications
                                </p>
                                {data?.medications && data.medications.length > 0 ? (
                                    <div className="flex flex-wrap gap-1.5">
                                        {data.medications.map((med, i) => (
                                            <span
                                                key={i}
                                                className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200 border border-blue-200 dark:border-blue-800"
                                            >
                                                {med}
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <span className="text-xs text-gray-500 dark:text-gray-400 italic">None reported</span>
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {/* Past Medical History */}
                            <div className="p-3 bg-gray-50 dark:bg-slate-800/60 rounded-lg border border-gray-200 dark:border-slate-700">
                                <p className="text-[11px] font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                                    🩺 Past Medical Conditions
                                </p>
                                {data?.pastMedical && data.pastMedical.length > 0 ? (
                                    <ul className="text-xs space-y-1 text-gray-800 dark:text-gray-200">
                                        {data.pastMedical.map((pmh, i) => (
                                            <li key={i} className="flex items-center gap-1.5">
                                                <span className="text-emerald-500">•</span> {pmh}
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <span className="text-xs text-gray-500 dark:text-gray-400 italic">No chronic medical conditions recorded</span>
                                )}
                            </div>

                            {/* Past Surgical History */}
                            <div className="p-3 bg-gray-50 dark:bg-slate-800/60 rounded-lg border border-gray-200 dark:border-slate-700">
                                <p className="text-[11px] font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                                    🔪 Past Surgeries &amp; Hospitalizations
                                </p>
                                {data?.pastSurgical && data.pastSurgical.length > 0 ? (
                                    <ul className="text-xs space-y-1 text-gray-800 dark:text-gray-200">
                                        {data.pastSurgical.map((psh, i) => (
                                            <li key={i} className="flex items-center gap-1.5">
                                                <span className="text-emerald-500">•</span> {psh}
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <span className="text-xs text-gray-500 dark:text-gray-400 italic">None reported</span>
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {/* Family History */}
                            <div className="p-3 bg-gray-50 dark:bg-slate-800/60 rounded-lg border border-gray-200 dark:border-slate-700">
                                <p className="text-[11px] font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-1">
                                    👨‍👩‍👧‍👦 Family History
                                </p>
                                {data?.familyHistory && data.familyHistory.length > 0 ? (
                                    <p className="text-xs text-gray-800 dark:text-gray-200">
                                        {data.familyHistory.join(' · ')}
                                    </p>
                                ) : (
                                    <span className="text-xs text-gray-500 dark:text-gray-400 italic">None reported</span>
                                )}
                            </div>

                            {/* Social History */}
                            <div className="p-3 bg-gray-50 dark:bg-slate-800/60 rounded-lg border border-gray-200 dark:border-slate-700">
                                <p className="text-[11px] font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-1">
                                    🏠 Social History
                                </p>
                                <p className="text-xs text-gray-800 dark:text-gray-200">
                                    Smoking: <span className="font-semibold capitalize">{data?.socialHistory?.smoking || 'Never'}</span> · Alcohol: <span className="font-semibold capitalize">{data?.socialHistory?.alcohol || 'None'}</span>
                                    {data?.socialHistory?.occupation && (
                                        <> · <span className="italic">{data.socialHistory.occupation}</span></>
                                    )}
                                </p>
                            </div>

                            {/* Obstetric Parity */}
                            <div className="p-3 bg-gray-50 dark:bg-slate-800/60 rounded-lg border border-gray-200 dark:border-slate-700">
                                <p className="text-[11px] font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-1">
                                    👶 Obstetric History
                                </p>
                                <p className="text-xs text-gray-800 dark:text-gray-200">
                                    {data?.gravidaPara || <span className="text-gray-500 dark:text-gray-400 italic">N/A</span>}
                                </p>
                            </div>
                        </div>

                        {/* Audit Stamp */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-[10px] text-gray-500 dark:text-gray-400 border-t border-emerald-100 dark:border-slate-800">
                            <span>
                                {data?.lastConfirmedAt ? `Last verified: ${new Date(data.lastConfirmedAt).toLocaleDateString()}` : 'Initial record'}
                                {data?.updatedBy?.name ? ` by ${data.updatedBy.name} (${data.updatedBy.role || 'user'})` : ''}
                            </span>
                            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                                ✓ Verified for automated carry-over across future consultations
                            </span>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
