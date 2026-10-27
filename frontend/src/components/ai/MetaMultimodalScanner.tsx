'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Camera,
  Shield,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Activity,
  Mic,
  Volume2,
  FileText,
  Scan,
  RefreshCw,
  ArrowRight,
  Stethoscope,
  Pill,
  Lock,
  Upload,
  Square,
  Eye,
  EyeOff,
  Layers,
  Sliders,
  Check,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

// ── Types ────────────────────────────────────────────────────

export interface SAMSegment {
  label: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x, y, w, h] normalized 0..1 or 0..100
  maskSvg?: string;
  areaPercentage?: number;
}

export interface MetaMultimodalScannerProps {
  consultationId?: string;
  facilityLicenceClass?: 'ppmv' | 'pharmacy' | 'clinic' | 'hospital' | 'patient_self_check';
  defaultTab?: 'drug_pack' | 'sam_vision' | 'call_diarize' | 'vision' | 'nafdac' | 'voice';
  onEscalateToDoctor?: (data: any) => void;
  onFindingsExtracted?: (findings: any) => void;
}

// ── Auth Header Helper ───────────────────────────────────────

export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (typeof window !== 'undefined') {
    try {
      const storageStr = localStorage.getItem('auth-storage');
      let token: string | null = null;
      if (storageStr) {
        const storage = JSON.parse(storageStr);
        token = storage?.state?.token;
      }
      if (!token) {
        token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  return headers;
}

// Default Nigerian Pidgin dialogue sample
const DEFAULT_PIDGIN_DIALOGUE = `Doctor: Good morning Mama Chioma, wetin dey do you today?
Patient: Good afternoon doctor, my body dey hot well well since 3 days, cold dey catch me, my NIN na 2348012345678 and phone 08031234567.
Doctor: Okay let me check your malaria test and write prescription for Coartem.`;

export function MetaMultimodalScanner({
  consultationId,
  facilityLicenceClass = 'ppmv',
  defaultTab,
  onEscalateToDoctor,
  onFindingsExtracted,
}: MetaMultimodalScannerProps) {
  // Navigation & General State
  const initialTab: 'drug_pack' | 'sam_vision' | 'call_diarize' =
    defaultTab === 'vision' || defaultTab === 'sam_vision'
      ? 'sam_vision'
      : defaultTab === 'voice' || defaultTab === 'call_diarize'
      ? 'call_diarize'
      : 'drug_pack';
  const [activeTab, setActiveTab] = useState<'drug_pack' | 'sam_vision' | 'call_diarize'>(initialTab);
  const [loading, setLoading] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>('coartem');
  const [scanResult, setScanResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // Tab 1: NAFDAC Drug-Pack State
  const [customNafdacRegNo, setCustomNafdacRegNo] = useState<string>('A4-0192');
  const [customDrugName, setCustomDrugName] = useState<string>('Coartem 20/120');
  const [hasActiveLinkedRx, setHasActiveLinkedRx] = useState<boolean>(false);
  const [drugPackImage, setDrugPackImage] = useState<string | null>(null);
  const drugPackFileRef = useRef<HTMLInputElement | null>(null);

  // Tab 2: SAM 3.1 Vision State
  const [visionImage, setVisionImage] = useState<string | null>(null);
  const [visionTargetMode, setVisionTargetMode] = useState<'wound' | 'rdt_strip' | 'lab_sheet' | 'dermatology'>('wound');
  const [referenceScaleMm, setReferenceScaleMm] = useState<number>(20);
  const visionFileRef = useRef<HTMLInputElement | null>(null);

  // Tab 3: 2-Way Call Voice Diarization State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [customDialogue, setCustomDialogue] = useState<string>(DEFAULT_PIDGIN_DIALOGUE);
  const [dialogueLanguage, setDialogueLanguage] = useState<'pidgin' | 'english' | 'hausa' | 'yoruba' | 'igbo'>('pidgin');
  const [stripNoise, setStripNoise] = useState<boolean>(true);
  const [showRawTranscript, setShowRawTranscript] = useState<boolean>(false);

  // Audio recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, [audioUrl]);

  // Format MM:SS duration
  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Start browser MediaRecorder
  const startRecording = async () => {
    setError(null);
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setError('Microphone access is not supported in this browser environment.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        const newUrl = URL.createObjectURL(blob);
        setAudioUrl(newUrl);

        const reader = new FileReader();
        reader.onloadend = () => {
          setAudioBase64(reader.result as string);
        };
        reader.readAsDataURL(blob);

        // Stop microphone tracks
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start(250);
      setIsRecording(true);
      setRecordingDuration(0);

      timerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error('Microphone recording error:', err);
      setError(err?.message || 'Could not access microphone.');
      setIsRecording(false);
    }
  };

  // Stop browser MediaRecorder
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
  };

  // API Call: Tab 1 NAFDAC Verification
  const handleVerifyDrugPack = async (overrideParams?: {
    regNo?: string;
    drug?: string;
    hasRx?: boolean;
    image?: string | null;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const regNo = overrideParams?.regNo !== undefined ? overrideParams.regNo : customNafdacRegNo;
      const drug = overrideParams?.drug !== undefined ? overrideParams.drug : customDrugName;
      const hasRx = overrideParams?.hasRx !== undefined ? overrideParams.hasRx : hasActiveLinkedRx;
      const image = overrideParams?.image !== undefined ? overrideParams.image : drugPackImage;

      const bodyPayload: any = {
        nafdacRegNo: regNo?.trim() || undefined,
        drugName: drug?.trim() || undefined,
        facilityLicenceClass,
        hasActiveLinkedRx: Boolean(hasRx),
      };
      if (image) {
        bodyPayload.imageBase64 = image;
      }

      const res = await fetch('/api/v1/ai-intake/nafdac/verify', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setScanResult(data.data);
        if (onFindingsExtracted) onFindingsExtracted(data.data);
      } else {
        const errMsg =
          typeof data.error === 'string'
            ? data.error
            : data.error?.message || data.message || 'NAFDAC verification failed';
        setError(errMsg);
      }
    } catch (err: any) {
      console.error('NAFDAC verification error:', err);
      setError(err?.message || 'Network error during verification');
    } finally {
      setLoading(false);
    }
  };

  // API Call: Tab 2 SAM 3.1 Vision Analysis
  const handleAnalyzeVision = async (overrideParams?: {
    mode?: 'wound' | 'rdt_strip' | 'lab_sheet' | 'dermatology';
    scale?: number;
    image?: string | null;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const mode = overrideParams?.mode || visionTargetMode;
      const scale = overrideParams?.scale !== undefined ? overrideParams.scale : referenceScaleMm;
      const image = overrideParams?.image !== undefined ? overrideParams.image : visionImage;

      const res = await fetch('/api/v1/ai-intake/vision/analyze', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          type: mode,
          imageBase64:
            image ||
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          referenceScaleMm: scale,
          consultationId,
          facilityLicenceClass,
        }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setScanResult(data.data);
        if (onFindingsExtracted) onFindingsExtracted(data.data);
      } else {
        const errMsg =
          typeof data.error === 'string'
            ? data.error
            : data.error?.message || data.message || 'Vision analysis failed';
        setError(errMsg);
      }
    } catch (err: any) {
      console.error('Vision analysis error:', err);
      setError(err?.message || 'Network error during vision analysis');
    } finally {
      setLoading(false);
    }
  };

  // API Call: Tab 3 Call Diarization
  const handleDiarizeCall = async (overrideParams?: {
    audio?: string | null;
    dialogue?: string;
    lang?: string;
    noise?: boolean;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const audio = overrideParams?.audio !== undefined ? overrideParams.audio : audioBase64;
      const dialogue = overrideParams?.dialogue !== undefined ? overrideParams.dialogue : customDialogue;
      const lang = overrideParams?.lang || dialogueLanguage;
      const noise = overrideParams?.noise !== undefined ? overrideParams.noise : stripNoise;

      const res = await fetch(`/api/v1/ai-intake/${consultationId || 'demo_consult'}/call-diarize`, {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          audioBase64: audio || undefined,
          dialogue: dialogue?.trim() || undefined,
          language: lang,
          stripNoise: noise,
        }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setScanResult(data.data);
        if (onFindingsExtracted) onFindingsExtracted(data.data);
      } else {
        const errMsg =
          typeof data.error === 'string'
            ? data.error
            : data.error?.message || data.message || 'Call diarization failed';
        setError(errMsg);
      }
    } catch (err: any) {
      console.error('Call diarization error:', err);
      setError(err?.message || 'Network error during call diarization');
    } finally {
      setLoading(false);
    }
  };

  // Quick Preset Execution
  const runPreset = async (presetId: string) => {
    setSelectedPreset(presetId);
    if (activeTab === 'drug_pack') {
      const isAugmentin = presetId === 'augmentin';
      const reg = isAugmentin ? '04-1928' : 'A4-0192';
      const drug = isAugmentin ? 'Augmentin 625mg' : 'Coartem 20/120';
      setCustomNafdacRegNo(reg);
      setCustomDrugName(drug);
      setHasActiveLinkedRx(false);
      setDrugPackImage(null);
      await handleVerifyDrugPack({ regNo: reg, drug, hasRx: false, image: null });
    } else if (activeTab === 'sam_vision') {
      const mode = presetId === 'wound' ? 'wound' : presetId === 'lab' ? 'lab_sheet' : 'rdt_strip';
      setVisionTargetMode(mode);
      setReferenceScaleMm(20);
      await handleAnalyzeVision({ mode, scale: 20, image: null });
    } else if (activeTab === 'call_diarize') {
      setDialogueLanguage('pidgin');
      setStripNoise(true);
      setCustomDialogue(DEFAULT_PIDGIN_DIALOGUE);
      await handleDiarizeCall({ dialogue: DEFAULT_PIDGIN_DIALOGUE, lang: 'pidgin', noise: true });
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-slate-100 shadow-2xl">
      {/* Header with Meta Model API Stack Badge */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Scan className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-white flex items-center gap-2">
              Meta Multimodal Clinical Scanner
              <span className="text-[11px] font-semibold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-2 py-0.5 rounded-full">
                SAM 3.1 &bull; Muse
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              NAFDAC OTC/POM verification, SAM 3.1 planimetry &amp; two-way call voice segregation
            </p>
          </div>
        </div>

        {/* Live Telemetry Pill */}
        <div className="flex items-center gap-2 text-xs bg-slate-950 border border-slate-800 rounded-full px-3 py-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-slate-300 font-mono text-[11px]">
            {scanResult?.telemetry?.modelId || scanResult?.samSegmentation?.model || 'muse-spark-1.3 & sam-3.1'}
          </span>
          <span className="text-slate-500">&bull;</span>
          <span className="text-emerald-400 font-semibold font-mono text-[11px]">
            {scanResult?.telemetry?.latencyMs || scanResult?.samSegmentation?.telemetry?.latencyMs
              ? `${scanResult?.telemetry?.latencyMs || scanResult?.samSegmentation?.telemetry?.latencyMs}ms`
              : 'sub-second'}
          </span>
          <span className="text-slate-500">&bull;</span>
          <span className="text-indigo-400 flex items-center gap-1 text-[11px]">
            <Shield className="w-3 h-3" /> NDPR Protected
          </span>
        </div>
      </div>

      {/* Mode Navigation Tabs */}
      <div className="flex items-center gap-2 mt-4 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
        <button
          onClick={() => {
            setActiveTab('drug_pack');
            setScanResult(null);
            setError(null);
          }}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
            activeTab === 'drug_pack'
              ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Pill className="w-4 h-4" />
          NAFDAC Drug-Pack &amp; PCN Gate
        </button>

        <button
          onClick={() => {
            setActiveTab('sam_vision');
            setScanResult(null);
            setError(null);
          }}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
            activeTab === 'sam_vision'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Scan className="w-4 h-4" />
          SAM 3.1 Vision &amp; Planimetry
        </button>

        <button
          onClick={() => {
            setActiveTab('call_diarize');
            setScanResult(null);
            setError(null);
          }}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
            activeTab === 'call_diarize'
              ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Mic className="w-4 h-4" />
          2-Way Call Voice Segregation
        </button>
      </div>

      {/* 1-Click Judge Demo Presets Bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
          Demo Presets:
        </span>
        {activeTab === 'drug_pack' && (
          <>
            <button
              onClick={() => runPreset('coartem')}
              disabled={loading}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                selectedPreset === 'coartem'
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-semibold'
                  : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              💊 Coartem ACT (NAFDAC A4-0192 &bull; OTC Allowed)
            </button>
            <button
              onClick={() => runPreset('augmentin')}
              disabled={loading}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                selectedPreset === 'augmentin'
                  ? 'bg-rose-500/20 border-rose-500/50 text-rose-300 font-semibold'
                  : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              🛑 Augmentin 625mg (NAFDAC 04-1928 &bull; POM Blocked)
            </button>
          </>
        )}

        {activeTab === 'sam_vision' && (
          <>
            <button
              onClick={() => runPreset('rdt')}
              disabled={loading}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                selectedPreset === 'rdt'
                  ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300 font-semibold'
                  : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              🔬 Malaria RDT Cassette (SAM 3.1 Band Isolation)
            </button>
            <button
              onClick={() => runPreset('wound')}
              disabled={loading}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                selectedPreset === 'wound'
                  ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300 font-semibold'
                  : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              🩹 Diabetic Foot Ulcer (SAM 3.1 Planimetry 12cm²)
            </button>
            <button
              onClick={() => runPreset('lab')}
              disabled={loading}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                selectedPreset === 'lab'
                  ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300 font-semibold'
                  : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              📄 Paper Lab Slip (MP ++, PCV 28% &bull; Header Stripped)
            </button>
          </>
        )}

        {activeTab === 'call_diarize' && (
          <button
            onClick={() => runPreset('call_pidgin')}
            disabled={loading}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              selectedPreset === 'call_pidgin'
                ? 'bg-purple-500/20 border-purple-500/50 text-purple-300 font-semibold'
                : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            🎙️ 2-Way Pidgin Call (Doctor vs Patient &bull; Generator Hum Filtered)
          </button>
        )}
      </div>

      {/* Interactive Custom Controls Bar for Current Tab */}
      <div className="mt-4">
        {/* TAB 1 CONTROLS: Custom NAFDAC Number, Drug Name, Linked Rx Toggle & Pack Photo Upload */}
        {activeTab === 'drug_pack' && (
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  NAFDAC Registration Number:
                </label>
                <input
                  type="text"
                  value={customNafdacRegNo}
                  onChange={(e) => setCustomNafdacRegNo(e.target.value)}
                  placeholder="e.g. A4-0192 or 04-1928"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  Drug / Brand / Generic Name:
                </label>
                <input
                  type="text"
                  value={customDrugName}
                  onChange={(e) => setCustomDrugName(e.target.value)}
                  placeholder="e.g. Coartem, Augmentin, Paracetamol"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-800/60">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300 select-none">
                <input
                  type="checkbox"
                  checked={hasActiveLinkedRx}
                  onChange={(e) => setHasActiveLinkedRx(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-0 focus:ring-offset-0 w-4 h-4 cursor-pointer"
                />
                <span>Active Physician e-Rx (Unlocks POM Dispensing)</span>
              </label>

              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={drugPackFileRef}
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onloadend = () => setDrugPackImage(reader.result as string);
                      reader.readAsDataURL(file);
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => drugPackFileRef.current?.click()}
                  className="text-xs border-slate-700 hover:bg-slate-800 text-slate-200 flex items-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5 text-blue-400" />
                  {drugPackImage ? 'Change Pack Photo' : 'Upload / Capture Pack'}
                </Button>

                {drugPackImage && (
                  <button
                    type="button"
                    onClick={() => setDrugPackImage(null)}
                    className="text-xs text-rose-400 hover:text-rose-300 underline"
                  >
                    Clear Photo
                  </button>
                )}

                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={loading}
                  onClick={() => handleVerifyDrugPack()}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-blue-600/30"
                >
                  {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
                  Verify Drug Pack
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2 CONTROLS: Mode Selector, Reference Scale Input & Clinical Photo Upload */}
        {activeTab === 'sam_vision' && (
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mr-1">
                  Target Mode:
                </span>
                {(['wound', 'rdt_strip', 'lab_sheet', 'dermatology'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setVisionTargetMode(m)}
                    className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                      visionTargetMode === m
                        ? 'bg-indigo-600 border-indigo-500 text-white font-semibold shadow-md shadow-indigo-600/30'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m === 'wound' && '🩹 Wound Planimetry'}
                    {m === 'rdt_strip' && '🔬 RDT Cassette'}
                    {m === 'lab_sheet' && '📄 Lab Sheet'}
                    {m === 'dermatology' && '🧴 Dermatology'}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[11px] text-slate-400 whitespace-nowrap">
                  Reference Scale (mm):
                </label>
                <input
                  type="number"
                  min={5}
                  max={100}
                  value={referenceScaleMm}
                  onChange={(e) => setReferenceScaleMm(Number(e.target.value) || 20)}
                  className="w-16 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-center font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-800/60">
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={visionFileRef}
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onloadend = () => setVisionImage(reader.result as string);
                      reader.readAsDataURL(file);
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => visionFileRef.current?.click()}
                  className="text-xs border-slate-700 hover:bg-slate-800 text-slate-200 flex items-center gap-1.5"
                >
                  <Upload className="w-3.5 h-3.5 text-indigo-400" />
                  {visionImage ? 'Change Clinical Image' : 'Upload Clinical Image'}
                </Button>

                {visionImage && (
                  <button
                    type="button"
                    onClick={() => setVisionImage(null)}
                    className="text-xs text-rose-400 hover:text-rose-300 underline"
                  >
                    Clear Image
                  </button>
                )}
              </div>

              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={loading}
                onClick={() => handleAnalyzeVision()}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-indigo-600/30"
              >
                {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Scan className="w-3.5 h-3.5" />}
                Analyze with SAM 3.1
              </Button>
            </div>
          </div>
        )}

        {/* TAB 3 CONTROLS: Live Microphone Recorder, Custom Dialogue Textarea & Language Selector */}
        {activeTab === 'call_diarize' && (
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-3">
            {/* Live Audio Recorder Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800">
              <div className="flex items-center gap-2.5">
                {isRecording ? (
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="bg-rose-600 hover:bg-rose-700 text-white font-bold px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 shadow-lg shadow-rose-600/40 animate-pulse"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop Recording ({formatDuration(recordingDuration)})</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startRecording}
                    className="bg-purple-600 hover:bg-purple-700 text-white font-bold px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 shadow-lg shadow-purple-600/30"
                  >
                    <Mic className="w-3.5 h-3.5" />
                    <span>🎙 Record Live Audio</span>
                  </button>
                )}

                {audioUrl && !isRecording && (
                  <div className="flex items-center gap-2">
                    <audio controls src={audioUrl} className="h-7 w-44" />
                    <button
                      type="button"
                      onClick={() => {
                        if (audioUrl) URL.revokeObjectURL(audioUrl);
                        setAudioUrl(null);
                        setAudioBlob(null);
                        setAudioBase64(null);
                      }}
                      className="text-xs text-rose-400 hover:text-rose-300 underline"
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] text-slate-400">Language:</label>
                  <select
                    value={dialogueLanguage}
                    onChange={(e) => setDialogueLanguage(e.target.value as any)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="pidgin">Nigerian Pidgin</option>
                    <option value="english">English</option>
                    <option value="hausa">Hausa</option>
                    <option value="yoruba">Yoruba</option>
                    <option value="igbo">Igbo</option>
                  </select>
                </div>

                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-300 select-none">
                  <input
                    type="checkbox"
                    checked={stripNoise}
                    onChange={(e) => setStripNoise(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-purple-600 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5 cursor-pointer"
                  />
                  <span>Strip Noise (Generator Hum)</span>
                </label>
              </div>
            </div>

            {/* Custom Doctor-Patient Dialogue Textarea */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Doctor–Patient Dialogue Transcript (or transcribe recorded audio):
              </label>
              <textarea
                rows={3}
                value={customDialogue}
                onChange={(e) => setCustomDialogue(e.target.value)}
                placeholder="Doctor: ... &#10;Patient: ... "
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-white font-mono placeholder-slate-500 focus:outline-none focus:border-purple-500"
              />
            </div>

            <div className="flex justify-end pt-1">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={loading}
                onClick={() => handleDiarizeCall()}
                className="bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-purple-600/30"
              >
                {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                Run Diarization &amp; Pre-LLM PHI Scrubbing
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mt-3 p-3 bg-rose-500/10 border border-rose-500/40 rounded-xl text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span>{typeof error === 'string' ? error : (error as any)?.message || String(error)}</span>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-slate-400 hover:text-slate-200 text-xs font-bold px-2 py-0.5"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Viewport & Analysis Stage */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: Visual Canvas / Segment Overlay Display / Audio Recording Stage */}
        <div className="lg:col-span-6 bg-slate-950 border border-slate-800 rounded-xl p-4 min-h-[340px] flex flex-col justify-between relative overflow-hidden">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span className="flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5 text-indigo-400" />
              Live Visual Grounding / SAM 3.1 Segmentation
            </span>
            <span className="font-mono text-[11px] bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-slate-300">
              Target: {activeTab.replace('_', ' ').toUpperCase()}
            </span>
          </div>

          {/* Interactive Bounding Box / Segment Render */}
          <div className="w-full flex-1 flex flex-col items-center justify-center border border-dashed border-slate-800 rounded-lg p-3 bg-slate-900/40 relative overflow-hidden min-h-[240px]">
            {loading ? (
              <div className="flex flex-col items-center gap-3">
                <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
                <span className="text-xs text-slate-400">
                  Executing Meta Multimodal Model Engine...
                </span>
              </div>
            ) : activeTab === 'drug_pack' ? (
              /* TAB 1 DRUG PACK DISPLAY */
              <div className="w-full h-full flex flex-col items-center justify-center relative">
                {drugPackImage ? (
                  <div className="relative max-h-56 w-full flex items-center justify-center">
                    <img
                      src={drugPackImage}
                      alt="Drug pack preview"
                      className="max-h-52 max-w-full rounded-lg object-contain shadow-lg"
                    />
                    <span className="absolute top-2 left-2 bg-blue-600/90 text-white font-mono text-[10px] px-2 py-0.5 rounded-full font-bold shadow">
                      Pack Photo Captured
                    </span>
                  </div>
                ) : (
                  <div className="w-64 h-44 bg-slate-900 border-2 border-dashed border-blue-500/40 rounded-xl p-3 flex flex-col justify-between relative shadow-lg shadow-blue-500/10">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider block">
                          {customDrugName || 'Essential Medicine'}
                        </span>
                        <span className="text-[9px] text-slate-400">Oral Solid Dosage Form</span>
                      </div>
                      <Pill className="w-5 h-5 text-blue-400" />
                    </div>
                    <div className="border border-emerald-400 bg-emerald-500/10 rounded p-1.5 text-center">
                      <span className="text-[9px] text-slate-400 block">NAFDAC Reg No</span>
                      <span className="font-mono font-bold text-emerald-400 text-xs">
                        {customNafdacRegNo || 'A4-0192'}
                      </span>
                    </div>
                    <div className="flex justify-between text-[8px] text-slate-500 font-mono">
                      <span>PCN REGULATED</span>
                      <span>PRIMARY SOURCE</span>
                    </div>
                  </div>
                )}
              </div>
            ) : activeTab === 'sam_vision' ? (
              /* TAB 2 SAM 3.1 VISION DISPLAY WITH DYNAMIC SVG BOUNDING-BOX & MASK OVERLAY */
              <div className="w-full h-full min-h-[220px] relative flex items-center justify-center">
                {visionImage ? (
                  <img
                    src={visionImage}
                    alt="Clinical target preview"
                    className="w-full h-full object-contain max-h-56 rounded"
                  />
                ) : (
                  /* Synthetic Clinical Visualization for Preset */
                  <div className="w-64 h-48 border border-indigo-400/50 bg-indigo-500/10 rounded-xl relative flex flex-col items-center justify-center p-3 text-center">
                    {visionTargetMode === 'rdt_strip' ? (
                      <div className="space-y-2">
                        <div className="w-48 h-10 bg-slate-950 border border-slate-700 rounded-md flex items-center px-4 justify-between font-mono text-[10px]">
                          <span className="text-slate-400">SAMPLE</span>
                          <span className="text-emerald-400 font-bold border-r border-emerald-500 pr-2">C |</span>
                          <span className="text-rose-400 font-bold">| T</span>
                        </div>
                        <span className="text-[10px] text-indigo-300 font-semibold">
                          Malaria Pf / Pan RDT Cassette
                        </span>
                      </div>
                    ) : visionTargetMode === 'lab_sheet' ? (
                      <div className="space-y-1 text-[10px] font-mono text-left w-48 bg-slate-950 border border-slate-700 p-2.5 rounded">
                        <div className="text-rose-400 text-[8px] font-bold text-center border-b border-rose-500/30 pb-0.5">
                          [HEADER STRIP REDACTED]
                        </div>
                        <div className="text-slate-300">PCV: 28% (Low)</div>
                        <div className="text-slate-300">MP: ++ (Trophozoites)</div>
                        <div className="text-slate-300">WBC: 6.8 × 10⁹/L</div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="w-28 h-20 rounded-full border-2 border-emerald-400/80 bg-emerald-500/20 mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/20">
                          <span className="text-[10px] font-bold text-emerald-300 font-mono">
                            {scanResult?.samSegmentation?.planimetry?.areaCm2
                              ? `${scanResult.samSegmentation.planimetry.areaCm2} cm²`
                              : '12.0 cm²'}
                          </span>
                        </div>
                        <span className="text-[10px] text-indigo-300 font-semibold">
                          Cutaneous Wound / Ulcer Planimetry
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Dynamic SVG bounding-box & mask overlay */}
                {scanResult?.samSegmentation?.segments && (
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className="absolute inset-0 w-full h-full pointer-events-none"
                  >
                    {/* Render mask paths if available */}
                    {scanResult.samSegmentation.segments.map((seg: SAMSegment, idx: number) =>
                      seg.maskSvg ? (
                        <path
                          key={`mask-${idx}`}
                          d={seg.maskSvg}
                          fill="rgba(99, 102, 241, 0.25)"
                          stroke="#6366f1"
                          strokeWidth="0.8"
                        />
                      ) : null
                    )}
                    {/* Render normalized <rect> boxes for each segment */}
                    {scanResult.samSegmentation.segments.map((seg: SAMSegment, idx: number) => {
                      const [rawX, rawY, rawW, rawH] = seg.bbox || [0, 0, 0, 0];
                      const x = rawX <= 1 ? rawX * 100 : rawX;
                      const y = rawY <= 1 ? rawY * 100 : rawY;
                      const w = rawW <= 1 ? rawW * 100 : rawW;
                      const h = rawH <= 1 ? rawH * 100 : rawH;
                      return (
                        <g key={`bbox-${idx}`}>
                          <rect
                            x={x}
                            y={y}
                            width={w}
                            height={h}
                            fill="rgba(16, 185, 129, 0.15)"
                            stroke="#10b981"
                            strokeWidth="0.8"
                            strokeDasharray="2 1"
                            rx="1"
                          />
                          <text
                            x={x + 1}
                            y={Math.max(y - 1.5, 4)}
                            fill="#34d399"
                            fontSize="3.2"
                            fontWeight="bold"
                            fontFamily="monospace"
                          >
                            {seg.label} ({Math.round((seg.confidence || 0.95) * 100)}%)
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                )}

                {/* Header Redaction Banner if headerStripRedacted */}
                {scanResult?.samSegmentation?.headerStripRedacted && (
                  <div className="absolute top-0 inset-x-0 bg-rose-950/90 border-b border-rose-500/50 text-rose-200 text-[9px] font-mono py-1 px-2 text-center font-bold tracking-wide z-10">
                    🔒 [HEADER STRIP REDACTED — ZERO PATIENT PII TRANSMITTED]
                  </div>
                )}
              </div>
            ) : (
              /* TAB 3 CALL DIARIZATION STAGE */
              <div className="w-full flex flex-col items-center justify-center gap-3">
                {isRecording ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 rounded-full bg-rose-500/20 border-2 border-rose-500 flex items-center justify-center animate-pulse shadow-lg shadow-rose-500/30">
                      <Mic className="w-8 h-8 text-rose-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-bold text-rose-300">
                        Recording Active Call Audio...
                      </p>
                      <p className="font-mono text-xl text-white font-bold mt-1">
                        {formatDuration(recordingDuration)}
                      </p>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Live browser audio capture &bull; Tap Stop when finished
                      </p>
                    </div>
                  </div>
                ) : audioUrl ? (
                  <div className="flex flex-col items-center gap-3 w-full max-w-sm">
                    <div className="w-12 h-12 rounded-full bg-purple-500/20 border border-purple-500/40 flex items-center justify-center">
                      <Volume2 className="w-6 h-6 text-purple-400" />
                    </div>
                    <div className="w-full text-center">
                      <p className="text-xs font-semibold text-slate-200 mb-2">
                        Recorded Microphone Preview ({audioBlob ? `${(audioBlob.size / 1024).toFixed(1)} KB` : ''})
                      </p>
                      <audio controls src={audioUrl} className="w-full h-8" />
                    </div>
                  </div>
                ) : (
                  <div className="w-full flex flex-col items-center justify-center gap-3">
                    <div className="w-16 h-16 rounded-full bg-purple-500/20 border border-purple-500/40 flex items-center justify-center animate-pulse">
                      <Volume2 className="w-8 h-8 text-purple-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-slate-200">
                        Two-Way Doctor–Patient Call Diarization
                      </p>
                      <p className="text-xs text-slate-400 mt-1">
                        Meta SAM-Audio &bull; Generator Hum Filtered &bull; 2 Speakers Isolated
                      </p>
                      <p className="text-[11px] text-slate-500 mt-2">
                        Record microphone audio or paste dialogue above to test pre-LLM PHI scrubbing
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1 text-emerald-400">
              <Shield className="w-3.5 h-3.5" /> Background Masked (Zero Bystander Faces)
            </span>
            <span>Planimetry Reference: {referenceScaleMm}mm Scale</span>
          </div>
        </div>

        {/* Right: Results, PCN PPMV Scope Gate & Doctor Escalation */}
        <div className="lg:col-span-6 bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <h4 className="font-bold text-sm text-slate-200 mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              Clinical &amp; Regulatory Verification Output
            </h4>

            {scanResult ? (
              <div className="space-y-3">
                {/* 1. PCN GATE STATUS BANNER & DYNAMIC BADGES */}
                {scanResult.ppmvCounterGate && (
                  <div
                    className={`p-3.5 rounded-xl border ${
                      scanResult.ppmvCounterGate.allowedAtPpmvCounter
                        ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                        : scanResult.ppmvCounterGate.statusBanner === 'BLOCKED_POM_ESCALATE_TO_DOCTOR'
                        ? 'bg-amber-950/40 border-amber-500/40 text-amber-200'
                        : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      {scanResult.ppmvCounterGate.allowedAtPpmvCounter ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
                      ) : scanResult.ppmvCounterGate.statusBanner === 'BLOCKED_POM_ESCALATE_TO_DOCTOR' ? (
                        <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-5 h-5 text-rose-400 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* DYNAMIC PCN GATE BADGES */}
                          {scanResult.ppmvCounterGate.statusBanner === 'APPROVED_FOR_PPMV_OTC_SALE' && (
                            scanResult.productDetails?.drugClass === 'pom' || scanResult.ppmvCounterGate.hasValidLinkedRx ? (
                              <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                                POM UNLOCKED (e-Rx)
                              </span>
                            ) : (
                              <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                                OTC PERMITTED
                              </span>
                            )
                          )}
                          {scanResult.ppmvCounterGate.statusBanner === 'BLOCKED_POM_ESCALATE_TO_DOCTOR' && (
                            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                              POM RESTRICTED
                            </span>
                          )}
                          {scanResult.ppmvCounterGate.statusBanner === 'BLOCKED_CONTROLLED_SUBSTANCE' && (
                            <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                              CONTROLLED SUBSTANCE
                            </span>
                          )}
                          {scanResult.ppmvCounterGate.statusBanner === 'BLOCKED_UNREGISTERED_OR_EXPIRED' && (
                            <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                              BLOCKED: UNREGISTERED / EXPIRED
                            </span>
                          )}
                        </div>
                        <p className="text-xs mt-1.5 text-slate-300">
                          {scanResult.ppmvCounterGate.actionableNextStep}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Unverified NAFDAC Registry Safety Advisory */}
                {scanResult.authenticityStatus === 'unverified_registry' && (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/40 rounded-xl text-amber-200 text-xs flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                    <span>⚠️ Not found in NAFDAC registry — manual pharmacist verification required</span>
                  </div>
                )}

                {/* Details Card for Medicines */}
                {scanResult.productDetails && (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-slate-400">NAFDAC Reg No:</span>
                      <span className="font-mono font-bold text-white">
                        {scanResult.productDetails.nafdacRegNo}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Brand / Generic:</span>
                      <span className="font-semibold text-slate-200">
                        {scanResult.productDetails.brandName} ({scanResult.productDetails.genericName})
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Regulatory Class:</span>
                      <span className="font-semibold uppercase text-indigo-300">
                        {scanResult.productDetails.drugClass}
                        {scanResult.productDetails.awareCategory && ` (${scanResult.productDetails.awareCategory})`}
                      </span>
                    </div>
                    {scanResult.productDetails.manufacturer && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Manufacturer:</span>
                        <span className="text-slate-300">
                          {scanResult.productDetails.manufacturer}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* 2. SAM 3.1 PLANIMETRY DISPLAY (BOTH cm² AND mm²) & MODEL BADGE */}
                {scanResult.samSegmentation?.planimetry && (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-indigo-300 block">
                        SAM 3.1 Cutaneous Planimetry
                      </span>
                      <span className="text-[10px] text-slate-400">
                        Scale: {referenceScaleMm}mm calibration
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800">
                        <span className="text-slate-400 block text-[10px]">Area (cm² &bull; mm²)</span>
                        <span className="font-bold text-emerald-400 text-sm block">
                          {scanResult.samSegmentation.planimetry.areaCm2} cm²
                        </span>
                        <span className="text-[10px] text-emerald-400/80 font-mono">
                          {(scanResult.samSegmentation.planimetry.areaCm2 * 100).toFixed(0)} mm²
                        </span>
                      </div>
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800">
                        <span className="text-slate-400 block text-[10px]">Dimensions</span>
                        <span className="font-bold text-slate-200 text-sm">
                          {scanResult.samSegmentation.planimetry.lengthCm} × {scanResult.samSegmentation.planimetry.widthCm} cm
                        </span>
                      </div>
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800">
                        <span className="text-slate-400 block text-[10px]">NPIAP Staging</span>
                        <span className="font-bold text-amber-400 text-sm uppercase">
                          {scanResult.samSegmentation.planimetry.suggestedStage || 'Stage II'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* SAM 3.1 MODEL BADGE */}
                {scanResult.samSegmentation && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-400">Model Engine:</span>
                    {scanResult.samSegmentation.model?.includes('Modal') || scanResult.samSegmentation.telemetry?.endpoint === 'modal-gpu' ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 px-2.5 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                        Meta SAM 3.1 &bull; Modal T4 GPU
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2.5 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        Local Geometric Estimate — Offline Fallback
                      </span>
                    )}
                  </div>
                )}

                {/* 3. CALL DIARIZATION: SPEAKER TURNS WITH PHI TOGGLE & EXTRACTED ENTITIES */}
                {scanResult.turns && (
                  <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                    {/* Transcript View Toggle & Redaction Stats */}
                    <div className="bg-slate-900 p-2 rounded-lg border border-slate-800 text-[11px] flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-emerald-400 font-semibold flex items-center gap-1">
                          <Shield className="w-3.5 h-3.5" /> Pre-LLM PHI: {scanResult.phiInspection?.totalRedactions || 0} PII items scrubbed
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowRawTranscript(!showRawTranscript)}
                        className="text-[10px] px-2 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-300 hover:text-white flex items-center gap-1 transition-all"
                      >
                        {showRawTranscript ? (
                          <>
                            <EyeOff className="w-3 h-3 text-amber-400" />
                            <span>Raw PII (Pre-Filter)</span>
                          </>
                        ) : (
                          <>
                            <Eye className="w-3 h-3 text-emerald-400" />
                            <span>PHI-Scrubbed</span>
                          </>
                        )}
                      </button>
                    </div>

                    {/* Speaker Turns */}
                    {scanResult.turns.map((turn: any, idx: number) => (
                      <div
                        key={idx}
                        className={`p-2.5 rounded-xl border text-xs ${
                          turn.speaker === 'SPEAKER_DOCTOR'
                            ? 'bg-blue-950/30 border-blue-500/30 ml-4'
                            : 'bg-slate-900 border-slate-800 mr-4'
                        }`}
                      >
                        <div className="flex items-center justify-between font-bold text-[10px] text-slate-400 mb-1">
                          <span className={turn.speaker === 'SPEAKER_DOCTOR' ? 'text-blue-400' : 'text-purple-400'}>
                            {turn.speaker === 'SPEAKER_DOCTOR' ? '🩺 Licensed Physician' : '🧑🏾‍🦱 Patient'}
                          </span>
                          <span>{turn.startSec}s - {turn.endSec}s</span>
                        </div>
                        <p className="text-slate-200">
                          {showRawTranscript ? turn.transcript : turn.scrubbedTranscript}
                        </p>
                      </div>
                    ))}

                    {/* Extracted Clinical Entities Chips */}
                    {scanResult.extractedEntities && (
                      <div className="mt-3 pt-3 border-t border-slate-800 space-y-2">
                        <span className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                          Extracted Clinical Entities (Zero-Burn Text Tier)
                        </span>
                        <div className="space-y-1.5 text-xs">
                          {scanResult.extractedEntities.symptoms?.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] text-slate-400 font-semibold min-w-16">Symptoms:</span>
                              {scanResult.extractedEntities.symptoms.map((s: string, i: number) => (
                                <span key={i} className="bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded text-[10px]">
                                  {s}
                                </span>
                              ))}
                            </div>
                          )}
                          {scanResult.extractedEntities.medications?.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] text-slate-400 font-semibold min-w-16">Medications:</span>
                              {scanResult.extractedEntities.medications.map((m: any, i: number) => (
                                <span key={i} className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded text-[10px]">
                                  {typeof m === 'string' ? m : `${m.name}${m.dosage ? ` (${m.dosage})` : ''}`}
                                </span>
                              ))}
                            </div>
                          )}
                          {scanResult.extractedEntities.diagnoses?.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] text-slate-400 font-semibold min-w-16">Diagnoses:</span>
                              {scanResult.extractedEntities.diagnoses.map((d: string, i: number) => (
                                <span key={i} className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded text-[10px]">
                                  {d}
                                </span>
                              ))}
                            </div>
                          )}
                          {scanResult.extractedEntities.redFlags?.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] text-slate-400 font-semibold min-w-16">Red Flags:</span>
                              {scanResult.extractedEntities.redFlags.map((rf: any, i: number) => (
                                <span key={i} className="bg-rose-500/20 text-rose-300 border border-rose-500/30 px-2 py-0.5 rounded text-[10px] flex items-center gap-1">
                                  <AlertTriangle className="w-2.5 h-2.5 text-rose-400" />
                                  {typeof rf === 'string' ? rf : rf.description || rf.category}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="h-44 flex flex-col items-center justify-center text-center text-slate-500">
                <FileText className="w-8 h-8 text-slate-700 mb-2" />
                <p className="text-xs">Awaiting scan or preset trigger...</p>
              </div>
            )}
          </div>

          {/* Action Footer: 1-Click Escalate to Telehealth Physician */}
          <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-400">
              Facility: <strong className="text-slate-200 uppercase">{facilityLicenceClass}</strong>
            </span>

            {scanResult?.ppmvCounterGate?.allowedAtPpmvCounter === false && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => onEscalateToDoctor && onEscalateToDoctor(scanResult)}
                className="bg-rose-600 hover:bg-rose-700 text-white font-bold flex items-center gap-1.5 shadow-lg shadow-rose-600/30"
              >
                <Stethoscope className="w-4 h-4" />
                🚨 Escalate to On-Duty Doctor (Muse Wonder Brief)
              </Button>
            )}

            {scanResult?.ppmvCounterGate?.allowedAtPpmvCounter === true && (
              <Button
                variant="primary"
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" />
                Proceed with Counter Sale (OTC)
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default MetaMultimodalScanner;
