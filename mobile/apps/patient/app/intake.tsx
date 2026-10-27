import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Text,
  ChatBubble,
  Chip,
  Button,
  Sheet,
  StatusBadge,
  KeyboardDoneBar,
  keyboardDoneProps,
  useTheme,
  useToast,
} from '@docarion/ui';
import { intakeApi, consultationsApi, queueApi, useActiveProfile, useAuthStore, type IntakeMessageResult, type Language, type TriageBand, getErrorMessage } from '@docarion/core';
import { TypingIndicator } from '../components/TypingIndicator';
import { EmergencyInterstitial } from '../components/EmergencyInterstitial';
import { FadeInView } from '../components/FadeInView';
import { LANGUAGES, languageLabel } from '../lib/i18n';
import { haptic } from '../lib/haptics';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** Persisted intake state — saved to AsyncStorage keyed by consultationId. */
interface PersistedIntake {
  messages: Msg[];
  triage: IntakeMessageResult['triage'] | null;
  isComplete: boolean;
  completeness: number;
}

let counter = 0;
const uid = () => `m${Date.now()}_${counter++}`;

const WELCOME =
  "Hi, I'm Docarion's care assistant. I'll ask a few quick questions to understand what's going on, then connect you to the right care. What's bothering you today?";

function sanitizeIntakeChatText(text: string): string {
  if (!text) return text;
  return text
    .replace(/(?:^|(?<=[.!?]\s+))\[NAME_REDACTED\]\s+(?=(?:is|was|has|had|are|were|can|could|will|would|do|does|did|brings|brought)\b)/gi, 'What ')
    .replace(/(?:^|(?<=[.!?]\s+))Is\s+(the\s+(?:main|primary)\s+(?:health\s+)?(?:problem|issue|symptom|reason|concern)\b)/g, 'What is $1')
    .replace(/\b(Hello|Hi|Dear|Hey|Welcome|Thank you|Thanks),?\s*\[NAME_REDACTED\]([!.,?]?)/gi, '$1$2')
    .replace(/\s*\[(?:NAME|PHONE|EMAIL|DOB|ID|MRN|NIN|BVN|ADDRESS|PASSPORT|INSURANCE|IP|SSN|POBOX)_REDACTED\]/g, '')
    .replace(/\s*\[REDACTED\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
}

function triageTone(band?: TriageBand | string): { bg: (t: ReturnType<typeof useTheme>) => string; text: (t: ReturnType<typeof useTheme>) => string; label: string } {
  if (band === 'emergency') return { bg: (t) => t.triage.emergency.soft, text: (t) => t.triage.emergency.text, label: 'Emergency' };
  if (band === 'urgent') return { bg: (t) => t.triage.urgent.soft, text: (t) => t.triage.urgent.text, label: 'Urgent' };
  return { bg: (t) => t.triage.routine.soft, text: (t) => t.triage.routine.text, label: 'Routine' };
}

export default function IntakeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ consultationId?: string }>();
  const existingConsultationId = params.consultationId ? String(params.consultationId) : null;
  const scrollRef = useRef<ScrollView>(null);

  const [consultationId, setConsultationId] = useState<string | null>(existingConsultationId);
  const [creating, setCreating] = useState(!existingConsultationId);
  const [messages, setMessages] = useState<Msg[]>([{ id: uid(), role: 'assistant', text: WELCOME }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  const [langSheet, setLangSheet] = useState(false);
  const [triage, setTriage] = useState<IntakeMessageResult['triage'] | null>(null);
  const [completeness, setCompleteness] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [completeSheet, setCompleteSheet] = useState(false);
  const [emergency, setEmergency] = useState<{ shown: boolean; reason?: string }>({ shown: false });
  const [joining, setJoining] = useState(false);

  // Meta Multimodal Assistant Sheet state (NAFDAC Medicine Check + SAM 3.1 Clinical Vision)
  const [multimodalSheet, setMultimodalSheet] = useState(false);
  const [mmMode, setMmMode] = useState<'nafdac' | 'vision'>('nafdac');
  const [nafdacRegInput, setNafdacRegInput] = useState('');
  const [drugNameInput, setDrugNameInput] = useState('');
  const [visionType, setVisionType] = useState<'wound' | 'dermatology' | 'rdt_strip' | 'lab_sheet'>('rdt_strip');
  const [mmBusy, setMmBusy] = useState(false);
  const [mmResult, setMmResult] = useState<Record<string, unknown> | null>(null);

  const skipBotForFutureBooking = useCallback(() => {
    haptic.select();
    if (consultationId) {
      void intakeApi.defer(consultationId, { reason: 'patient_skipped_live_bot_for_future_booking' }).catch(() => {});
    }
    router.replace('/booking');
  }, [consultationId, router]);

  // Create the telehealth consultation that anchors this intake session.
  // If an existing consultationId was passed via query params (e.g., completing
  // Hx intake at appointment time), bind directly to it instead of creating a new one.
  // If the user just completed a guest intake session and registered/logged in,
  // link their `intakeSessionId` and hydrate the conversation seamlessly.
  useEffect(() => {
    if (existingConsultationId) {
      setConsultationId(existingConsultationId);
      setCreating(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        let guestHandoff: {
          sessionId?: string;
          messages?: Msg[];
          triage?: IntakeMessageResult['triage'] | null;
          completeness?: number;
          isComplete?: boolean;
          language?: Language;
          chiefComplaint?: string;
          savedAt?: number;
        } | null = null;
        try {
          const rawHandoff = await AsyncStorage.getItem('guest_intake_handoff');
          if (rawHandoff) {
            const parsed = JSON.parse(rawHandoff);
            // Honor handoffs created within the last 2 hours
            if (parsed && (!parsed.savedAt || Date.now() - parsed.savedAt < 2 * 60 * 60 * 1000)) {
              guestHandoff = parsed;
            }
            await AsyncStorage.removeItem('guest_intake_handoff');
          }
        } catch {
          /* ignore */
        }

        const dep = useActiveProfile.getState().dependentId();
        const c = await consultationsApi.create({
          type: 'telehealth',
          reason: guestHandoff?.chiefComplaint || 'AI symptom check',
          ...(guestHandoff?.sessionId ? { intakeSessionId: guestHandoff.sessionId } : {}),
          ...(dep ? { dependentId: dep } : {}),
        });
        const id = (c?.consultationId as string) ?? (c?.id as string);
        if (!cancelled) {
          if (id) {
            setConsultationId(id);
            if (guestHandoff?.messages?.length) {
              setMessages(guestHandoff.messages);
              if (guestHandoff.triage) setTriage(guestHandoff.triage);
              if (typeof guestHandoff.completeness === 'number') setCompleteness(guestHandoff.completeness);
              if (guestHandoff.language) setLanguage(guestHandoff.language);
              if (guestHandoff.isComplete) {
                setIsComplete(true);
                setTimeout(() => setCompleteSheet(true), 400);
              }
              setRestored(true);
            }
          } else {
            toast.error('Could not start the visit. Please try again.');
          }
          setCreating(false);
        }
      } catch (e) {
        if (!cancelled) {
          setCreating(false);
          toast.error(getErrorMessage(e, 'Could not start the visit'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingConsultationId]);

  // Restore persisted intake state when consultationId becomes available.
  // This lets patients return to their conversation if the app is killed mid-triage.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!consultationId || restored) return;
    let cancelled = false;
    (async () => {
      try {
        const key = `intake_messages_${consultationId}`;
        const raw = await AsyncStorage.getItem(key);
        if (cancelled || !raw) return;
        const saved = JSON.parse(raw) as PersistedIntake;
        if (!cancelled && saved.messages?.length) {
          setMessages(saved.messages.map((m) => ({ ...m, text: sanitizeIntakeChatText(m.text) })));
          if (saved.triage) setTriage(saved.triage);
          if (typeof saved.completeness === 'number') setCompleteness(saved.completeness);
          if (saved.isComplete) {
            setIsComplete(true);
            setTimeout(() => setCompleteSheet(true), 400);
          }
        }
      } catch {
        /* ignore — fresh session */
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => { cancelled = true; };
  }, [consultationId, restored]);

  // Debounced persistence — saves messages, triage band, and AI assessment result
  // whenever they change (but not on every keystroke).
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!consultationId || !restored) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const payload: PersistedIntake = {
          messages,
          triage,
          isComplete,
          completeness,
        };
        await AsyncStorage.setItem(
          `intake_messages_${consultationId}`,
          JSON.stringify(payload),
        );
      } catch {
        /* ignore — persistence is best-effort */
      }
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [consultationId, restored, messages, triage, isComplete, completeness]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  useEffect(scrollToEnd, [messages, sending, scrollToEnd]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending || !consultationId) return;
      haptic.light();
      setInput('');
      setMessages((m) => [...m, { id: uid(), role: 'user', text }]);
      setSending(true);
      try {
        const res = await intakeApi.message({ message: text, consultationId, language });
        setMessages((m) => [...m, { id: uid(), role: 'assistant', text: res.message }]);
        if (res.triage) setTriage(res.triage);
        if (typeof res.completeness === 'number') setCompleteness(res.completeness);
        const isEmergency = res.emergencyEscalation === true || res.triage?.category === 'emergency';
        if (isEmergency) {
          setEmergency({ shown: true, reason: res.triage?.reason });
        }
        if (res.isComplete) {
          setIsComplete(true);
          setTimeout(() => setCompleteSheet(true), 400);
        }
      } catch (e) {
        setMessages((m) => [...m, { id: uid(), role: 'assistant', text: 'Sorry — I had trouble responding. Please try again.' }]);
        toast.error(getErrorMessage(e, 'Message failed'));
      } finally {
        setSending(false);
      }
    },
    [sending, consultationId, language, toast],
  );

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const showChips = !sending && !isComplete && !!lastAssistant && lastAssistant.text.trim().endsWith('?') && messages.length > 1;

  const runPatientNafdacCheck = useCallback(
    async (regNo?: string, name?: string) => {
      const reg = (regNo ?? nafdacRegInput).trim();
      const drug = (name ?? drugNameInput).trim();
      if (!reg && !drug) {
        toast.error('Enter a NAFDAC Reg No or Medicine Name');
        return;
      }
      setMmBusy(true);
      setMmResult(null);
      try {
        const res = await intakeApi.verifyNafdac({
          nafdacRegNo: reg || undefined,
          drugName: drug || undefined,
          facilityLicenceClass: 'patient_self_check',
        });
        const payload = ((res as Record<string, unknown>)?.data as Record<string, unknown>) ?? (res as Record<string, unknown>);
        setMmResult({ kind: 'nafdac', ...payload });
        haptic.success();
      } catch (e) {
        toast.error(getErrorMessage(e, 'Could not verify medicine'));
      } finally {
        setMmBusy(false);
      }
    },
    [nafdacRegInput, drugNameInput, toast],
  );

  const runPatientVisionCheck = useCallback(
    async (typeOverride?: 'wound' | 'dermatology' | 'rdt_strip' | 'lab_sheet') => {
      const target = typeOverride ?? visionType;
      setMmBusy(true);
      setMmResult(null);
      try {
        const res = await intakeApi.analyzeVision({
          type: target,
          consultationId: consultationId ?? undefined,
          referenceScaleMm: 20,
          clinicalContext: `Patient self-submitted ${target} during pre-consultation intake`,
        });
        const payload = ((res as Record<string, unknown>)?.data as Record<string, unknown>) ?? (res as Record<string, unknown>);
        setMmResult({ kind: 'vision', target, ...payload });
        haptic.success();
      } catch (e) {
        toast.error(getErrorMessage(e, 'Could not analyze clinical image'));
      } finally {
        setMmBusy(false);
      }
    },
    [visionType, consultationId, toast],
  );

  const joinQueue = useCallback(async () => {
    // Auth gate: must be authenticated + phone verified to connect with a doctor
    const authStatus = useAuthStore.getState().status;
    const authUser = useAuthStore.getState().user;
    if (authStatus !== 'authenticated' || !authUser) {
      haptic.warning();
      toast.info('Sign in or create an account to connect with a doctor');
      router.push('/landing?redirect=/intake');
      return;
    }
    if (!authUser.phoneVerified) {
      haptic.warning();
      toast.info('Verify your phone number to connect with a doctor');
      router.push('/profile/identity-verification');
      return;
    }
    setJoining(true);
    try {
      const symptoms = messages.find((m) => m.role === 'user')?.text;
      await queueApi.join({ symptoms, urgencyLevel: triage?.category, preferredLanguage: language });
      haptic.success();
      setCompleteSheet(false);
      router.replace('/queue');
    } catch (e) {
      const msg = getErrorMessage(e, 'Could not join the queue');
      // Already queued → go to queue anyway.
      if (/queue/i.test(msg)) {
        setCompleteSheet(false);
        router.replace('/queue');
        return;
      }
      toast.error(msg);
    } finally {
      setJoining(false);
    }
  }, [messages, triage, language, router, toast]);

  const tone = triageTone(triage?.category);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }} edges={['top', 'left', 'right']}>
      <KeyboardDoneBar />
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 }}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityLabel="Close" style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 26, color: theme.color.text }}>‹</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text variant="heading">Symptom check</Text>
          <Text variant="caption" muted>
            Meta Muse Spark + SAM 3.1 · PHI-Scrubbed
          </Text>
        </View>
        <Pressable
          onPress={() => setLangSheet(true)}
          accessibilityLabel="Change language"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: theme.color.surfaceAlt, paddingHorizontal: 12, height: 36, borderRadius: 999 }}
        >
          <Text style={{ fontSize: 14 }}>🌐</Text>
          <Text variant="caption" style={{ color: theme.color.text, fontFamily: theme.fontFamily.semibold }}>
            {languageLabel(language)}
          </Text>
        </Pressable>
      </View>

      {/* Skip Bot ONLY for Future Appointment Banner */}
      {!existingConsultationId && !isComplete ? (
        <View
          style={{
            backgroundColor: theme.color.surface,
            borderColor: theme.color.border,
            borderWidth: 1,
            paddingHorizontal: 12,
            paddingVertical: 10,
            marginHorizontal: 16,
            marginBottom: 8,
            borderRadius: theme.radii.md,
            gap: 8,
          }}
        >
          <Text variant="caption" muted>
            To join the live doctor queue right now, complete the quick AI History (Hx) Intake below (or have a Triage Nurse complete your intake at a walk-in facility). Prefer not to chat with the bot right now? Tap &apos;Book Future Appointment&apos; to schedule a future slot first — you&apos;ll complete Hx intake at appointment time.
          </Text>
          <Pressable
            onPress={skipBotForFutureBooking}
            accessibilityRole="button"
            accessibilityLabel="Book a Future Appointment Instead (Skip Bot for Now)"
            style={{
              alignSelf: 'flex-start',
              backgroundColor: theme.color.primarySoft,
              borderRadius: theme.radii.sm,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderWidth: 1,
              borderColor: theme.color.primary,
            }}
          >
            <Text variant="caption" style={{ color: theme.color.primaryStrong, fontFamily: theme.fontFamily.bold }}>
              Book a Future Appointment Instead (Skip Bot for Now) →
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Triage / progress banner */}
      {triage || completeness > 0 ? (
        <FadeInView style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: triage ? tone.bg(theme) : theme.color.surfaceAlt,
              borderRadius: theme.radii.md,
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            {triage ? (
              <>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone.text(theme) }} />
                <Text variant="caption" style={{ color: tone.text(theme), fontFamily: theme.fontFamily.bold }}>
                  {tone.label} priority
                </Text>
              </>
            ) : (
              <Text variant="caption" muted style={{ fontFamily: theme.fontFamily.semibold }}>
                Gathering your history
              </Text>
            )}
            <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
              <View style={{ width: `${Math.round(Math.max(0.05, completeness) * 100)}%`, height: 5, borderRadius: 3, backgroundColor: triage ? tone.text(theme) : theme.color.primary }} />
            </View>
          </View>
        </FadeInView>
      ) : null}

      {/* AI triage disclaimer banner — persistent */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: theme.color.warningSoft,
          paddingHorizontal: 12,
          paddingVertical: 8,
          marginHorizontal: 16,
          marginBottom: 4,
          borderRadius: theme.radii.sm,
        }}
      >
        <Text style={{ fontSize: 14 }}>⚠️</Text>
        <Text variant="caption" style={{ flex: 1, color: theme.color.warning, fontFamily: theme.fontFamily.semibold }}>
          This is not a medical diagnosis. For emergencies, call 112 or go to your nearest hospital.
        </Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={scrollToEnd}
        >
          {creating ? (
            <View style={{ paddingVertical: 24, alignItems: 'center', gap: 8 }}>
              <ActivityIndicator color={theme.color.primary} />
              <Text variant="caption" muted>
                Starting your visit…
              </Text>
            </View>
          ) : null}
          {messages.map((m) => (
            <ChatBubble key={m.id} message={m.text} sent={m.role === 'user'} />
          ))}
          {sending ? <TypingIndicator /> : null}

          {isComplete ? (
            <FadeInView style={{ marginTop: 8, alignItems: 'center', gap: 6 }}>
              <StatusBadge status="completed" label="Assessment complete" />
              <Button label="Choose next step" onPress={() => setCompleteSheet(true)} fullWidth={false} size="sm" style={{ marginTop: 6 }} />
            </FadeInView>
          ) : null}
        </ScrollView>

        {/* Initial Multilingual / Pidgin & Multimodal Quick Starters */}
        {!sending && !isComplete && messages.length === 1 ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 6 }}>
            <Text variant="caption" muted style={{ fontFamily: theme.fontFamily.semibold }}>
              Quick start (English, Naija Pidgin & SAM 3.1 Vision):
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              <Chip
                label="🇳🇬 Abeg my body dey hot & mouth bitter"
                onPress={() => {
                  setLanguage('pcm');
                  void send('Abeg my body dey hot well well since 2 days and my mouth dey bitter');
                }}
              />
              <Chip
                label="🤒 Fever, headache & body chills"
                onPress={() => void send('I have had a high fever, headache, and body chills for 2 days')}
              />
              <Chip
                label="💊 Verify NAFDAC Medicine Pack"
                onPress={() => {
                  setMmMode('nafdac');
                  setMmResult(null);
                  setMultimodalSheet(true);
                }}
              />
              <Chip
                label="🔬 Scan Wound / Rash / RDT / Lab"
                onPress={() => {
                  setMmMode('vision');
                  setMmResult(null);
                  setMultimodalSheet(true);
                }}
              />
            </ScrollView>
          </View>
        ) : null}

        {/* Quick replies */}
        {showChips ? (
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
            {['Yes', 'No', "I'm not sure"].map((c) => (
              <Chip key={c} label={c} onPress={() => send(c)} />
            ))}
          </View>
        ) : null}

        {/* Input bar */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: 10,
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: Platform.OS === 'ios' ? 8 : 12,
            borderTopWidth: 1,
            borderTopColor: theme.color.border,
            backgroundColor: theme.color.surface,
          }}
        >
          <Pressable
            onPress={() => {
              haptic.light();
              setMmResult(null);
              setMultimodalSheet(true);
            }}
            disabled={isComplete || creating}
            accessibilityLabel="Attach clinical photo or verify NAFDAC medicine"
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: theme.color.surfaceAlt,
              borderWidth: 1,
              borderColor: theme.color.border,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 18 }}>📷</Text>
          </Pressable>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={isComplete ? 'Assessment complete' : 'Describe your symptoms (English or Pidgin)…'}
            placeholderTextColor={theme.color.placeholder}
            editable={!isComplete && !creating}
            multiline
            {...keyboardDoneProps}
            style={{
              flex: 1,
              maxHeight: 120,
              minHeight: 44,
              backgroundColor: theme.color.surfaceAlt,
              borderRadius: theme.radii.lg,
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 12,
              color: theme.color.text,
              fontFamily: theme.fontFamily.regular,
              fontSize: 16,
            }}
          />
          <Pressable
            onPress={() => send(input)}
            disabled={!input.trim() || sending || isComplete || creating}
            accessibilityLabel="Send message"
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: !input.trim() || sending || isComplete ? theme.color.borderStrong : theme.color.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {sending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontSize: 20, marginTop: -2 }}>↑</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* Meta Multimodal Assistant Sheet (NAFDAC Medicine Check + SAM 3.1 Clinical Vision) */}
      <Sheet
        visible={multimodalSheet}
        onClose={() => setMultimodalSheet(false)}
        title="Meta Multimodal AI Assistant"
      >
        <View style={{ gap: 14, paddingBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={() => {
                setMmMode('nafdac');
                setMmResult(null);
              }}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: theme.radii.md,
                backgroundColor: mmMode === 'nafdac' ? theme.color.primary : theme.color.surfaceAlt,
                alignItems: 'center',
              }}
            >
              <Text variant="caption" style={{ color: mmMode === 'nafdac' ? '#fff' : theme.color.text, fontFamily: theme.fontFamily.bold }}>
                💊 NAFDAC Medicine Check
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setMmMode('vision');
                setMmResult(null);
              }}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: theme.radii.md,
                backgroundColor: mmMode === 'vision' ? theme.color.primary : theme.color.surfaceAlt,
                alignItems: 'center',
              }}
            >
              <Text variant="caption" style={{ color: mmMode === 'vision' ? '#fff' : theme.color.text, fontFamily: theme.fontFamily.bold }}>
                🔬 SAM 3.1 Clinical Vision
              </Text>
            </Pressable>
          </View>

          {mmMode === 'nafdac' ? (
            <View style={{ gap: 10 }}>
              <Text variant="caption" muted>
                Verify if a medicine pack is registered in the NAFDAC Registry or requires a doctor&apos;s e-Prescription (PCN Gate):
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                <Chip
                  label="Coartem 80/480 (OTC)"
                  onPress={() => {
                    setNafdacRegInput('A4-0192');
                    setDrugNameInput('Coartem 80/480mg');
                    void runPatientNafdacCheck('A4-0192', 'Coartem 80/480mg');
                  }}
                />
                <Chip
                  label="Amoxicillin 500mg (POM)"
                  onPress={() => {
                    setNafdacRegInput('04-2891');
                    setDrugNameInput('Amoxicillin 500mg');
                    void runPatientNafdacCheck('04-2891', 'Amoxicillin 500mg');
                  }}
                />
                <Chip
                  label="Fake Pack Alert"
                  onPress={() => {
                    setNafdacRegInput('FAKE-9999');
                    setDrugNameInput('Unknown Capsule');
                    void runPatientNafdacCheck('FAKE-9999', 'Unknown Capsule');
                  }}
                />
              </ScrollView>
              <TextInput
                value={nafdacRegInput}
                onChangeText={setNafdacRegInput}
                placeholder="NAFDAC Reg No (e.g. A4-0192 or 04-2891)"
                placeholderTextColor={theme.color.placeholder}
                {...keyboardDoneProps}
                style={{
                  backgroundColor: theme.color.surfaceAlt,
                  borderRadius: theme.radii.md,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: theme.color.text,
                  fontFamily: theme.fontFamily.regular,
                }}
              />
              <TextInput
                value={drugNameInput}
                onChangeText={setDrugNameInput}
                placeholder="Medicine Name (e.g. Amoxicillin 500mg)"
                placeholderTextColor={theme.color.placeholder}
                {...keyboardDoneProps}
                style={{
                  backgroundColor: theme.color.surfaceAlt,
                  borderRadius: theme.radii.md,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: theme.color.text,
                  fontFamily: theme.fontFamily.regular,
                }}
              />
              <Button label={mmBusy ? 'Verifying…' : 'Verify NAFDAC & Prescription Gate'} onPress={() => void runPatientNafdacCheck()} loading={mmBusy} />
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              <Text variant="caption" muted>
                Meta SAM 3.1 isolates the clinical region of interest (stripping personal name headers on lab sheets) and computes calibrated planimetry:
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {([
                  { key: 'rdt_strip', label: '🧪 Malaria RDT Strip' },
                  { key: 'lab_sheet', label: '📄 Lab Result Sheet' },
                  { key: 'dermatology', label: '🩹 Skin Rash' },
                  { key: 'wound', label: '📏 Wound / Ulcer' },
                ] as const).map((item) => (
                  <Chip
                    key={item.key}
                    label={item.label}
                    selected={visionType === item.key}
                    onPress={() => {
                      setVisionType(item.key);
                      void runPatientVisionCheck(item.key);
                    }}
                  />
                ))}
              </View>
              <Button label={mmBusy ? 'Analyzing with SAM 3.1…' : 'Run SAM 3.1 Vision Analysis'} onPress={() => void runPatientVisionCheck()} loading={mmBusy} />
            </View>
          )}

          {mmResult ? (
            <View
              style={{
                backgroundColor: theme.color.surfaceAlt,
                borderRadius: theme.radii.md,
                padding: 12,
                borderWidth: 1,
                borderColor: theme.color.border,
                gap: 6,
              }}
            >
              {mmResult.kind === 'nafdac' ? (
                <>
                  <Text variant="bodyMedium">
                    {String(mmResult.brandName || drugNameInput || 'Medicine Verification')} ({String(mmResult.nafdacRegNo || nafdacRegInput || 'N/A')})
                  </Text>
                  <Text variant="caption" style={{ fontFamily: theme.fontFamily.bold, color: mmResult.authenticityStatus === 'verified' || mmResult.authenticityStatus === 'verified_authentic' ? theme.color.success : theme.color.warning }}>
                    Registry Status: {String(mmResult.authenticityStatus || 'unverified_registry').toUpperCase()} · Drug Class: {String(mmResult.drugSchedule || 'UNKNOWN').toUpperCase()}
                  </Text>
                  <Text variant="caption" muted>
                    {String(mmResult.counterDispensingAction || mmResult.regulatoryNote || 'Consult a licensed doctor or pharmacist before use.')}
                  </Text>
                  <Button
                    label="Add Medicine Summary to Intake Chat"
                    size="sm"
                    onPress={() => {
                      const summaryMsg = `I checked medicine ${String(mmResult.brandName || drugNameInput || '')} (NAFDAC: ${String(mmResult.nafdacRegNo || nafdacRegInput || 'N/A')}, Status: ${String(mmResult.authenticityStatus || 'unverified')}, Class: ${String(mmResult.drugSchedule || 'unknown')}).`;
                      setMultimodalSheet(false);
                      void send(summaryMsg);
                    }}
                  />
                </>
              ) : (
                <>
                  <Text variant="bodyMedium">
                    SAM 3.1 Vision ({String(mmResult.target || visionType).toUpperCase()})
                  </Text>
                  <Text variant="caption" style={{ fontFamily: theme.fontFamily.semibold, color: theme.color.primary }}>
                    Model: {String(mmResult.modelUsed || 'meta-sam-3.1')} · PHI Header Stripped
                  </Text>
                  <Text variant="caption" muted>
                    {String(mmResult.visualFindingSummary || 'Clinical region segmented and prepared for doctor review.')}
                  </Text>
                  <Button
                    label="Attach Vision Summary to Intake Chat"
                    size="sm"
                    onPress={() => {
                      const summaryMsg = `[SAM 3.1 Vision — ${String(mmResult.target || visionType)}]: ${String(mmResult.visualFindingSummary || 'Clinical photo analyzed for physician review.')}`;
                      setMultimodalSheet(false);
                      void send(summaryMsg);
                    }}
                  />
                </>
              )}
            </View>
          ) : null}
        </View>
      </Sheet>

      {/* Language sheet */}
      <Sheet visible={langSheet} onClose={() => setLangSheet(false)} title="Language">
        <View style={{ gap: 4, paddingBottom: 8 }}>
          {LANGUAGES.map((l) => (
            <Pressable
              key={l.value}
              onPress={() => {
                setLanguage(l.value);
                setLangSheet(false);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 }}
            >
              <View>
                <Text variant="bodyMedium">{l.label}</Text>
                <Text variant="caption" muted>
                  {l.native}
                </Text>
              </View>
              {language === l.value ? <Text style={{ color: theme.color.primary, fontSize: 18 }}>✓</Text> : null}
            </Pressable>
          ))}
        </View>
      </Sheet>

      {/* Completion sheet */}
      <Sheet visible={completeSheet} onClose={() => setCompleteSheet(false)} title="What would you like to do?">
        <View style={{ gap: 12, paddingBottom: 8 }}>
          <Text variant="body" muted>
            {existingConsultationId
              ? 'Your pre-consultation History (Hx) Intake is complete. You can now enter your consultation room.'
              : 'Your assessment is ready. Connect with a doctor now, or book a time that suits you.'}
          </Text>
          {triage ? (
            <View style={{ alignSelf: 'flex-start' }}>
              <StatusBadge status={triage.category} label={`${tone.label} priority`} />
            </View>
          ) : null}
          {existingConsultationId ? (
            <Button
              label="Enter Consultation Room"
              size="lg"
              onPress={() => {
                setCompleteSheet(false);
                router.replace(`/consultations/${existingConsultationId}`);
              }}
            />
          ) : (
            <>
              <Button label="Join the queue now" onPress={joinQueue} loading={joining} size="lg" />
              <Button
                label="Book an appointment"
                variant="outline"
                size="lg"
                onPress={() => {
                  setCompleteSheet(false);
                  router.push('/booking');
                }}
              />
            </>
          )}
        </View>
      </Sheet>

      <EmergencyInterstitial
        visible={emergency.shown}
        reason={emergency.reason}
        onClose={() => setEmergency((e) => ({ ...e, shown: false }))}
        onFindFacilities={() => {
          setEmergency((e) => ({ ...e, shown: false }));
          router.push('/facilities');
        }}
      />
    </SafeAreaView>
  );
}
