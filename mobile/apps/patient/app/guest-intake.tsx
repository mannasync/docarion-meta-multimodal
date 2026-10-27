import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ScrollView, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { Text, ChatBubble, Chip, Button, Sheet, KeyboardDoneBar, keyboardDoneProps, useTheme, useToast } from '@docarion/ui';
import { intakeApi, type IntakeMessageResult, type Language, type TriageBand, getErrorMessage } from '@docarion/core';
import { TypingIndicator } from '../components/TypingIndicator';
import { EmergencyInterstitial } from '../components/EmergencyInterstitial';
import { FadeInView } from '../components/FadeInView';
import { LANGUAGES, languageLabel } from '../lib/i18n';
import { haptic } from '../lib/haptics';

export const GUEST_INTAKE_HANDOFF_KEY = 'guest_intake_handoff';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

let counter = 0;
const uid = () => `g${Date.now()}_${counter++}`;

const WELCOME =
  "Hi, I'm Docarion's care assistant. Tell me what's bothering you and I'll ask a few quick questions — no account needed to start. What's going on today?";

function triageTone(band?: TriageBand | string) {
  if (band === 'emergency') return { bg: (t: ReturnType<typeof useTheme>) => t.triage.emergency.soft, text: (t: ReturnType<typeof useTheme>) => t.triage.emergency.text, label: 'Emergency' };
  if (band === 'urgent') return { bg: (t: ReturnType<typeof useTheme>) => t.triage.urgent.soft, text: (t: ReturnType<typeof useTheme>) => t.triage.urgent.text, label: 'Urgent' };
  return { bg: (t: ReturnType<typeof useTheme>) => t.triage.routine.soft, text: (t: ReturnType<typeof useTheme>) => t.triage.routine.text, label: 'Routine' };
}

export default function GuestIntakeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const scrollRef = useRef<ScrollView>(null);
  // Stable guest session id, kept across turns.
  const sessionId = useRef(`guest_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`).current;

  const [messages, setMessages] = useState<Msg[]>([{ id: uid(), role: 'assistant', text: WELCOME }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  const [langSheet, setLangSheet] = useState(false);
  const [triage, setTriage] = useState<IntakeMessageResult['triage'] | null>(null);
  const [completeness, setCompleteness] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [ctaSheet, setCtaSheet] = useState(false);
  const [emergency, setEmergency] = useState<{ shown: boolean; reason?: string }>({ shown: false });

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);
  useEffect(scrollToEnd, [messages, sending, scrollToEnd]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      haptic.light();
      setInput('');
      setMessages((m) => [...m, { id: uid(), role: 'user', text }]);
      setSending(true);
      try {
        const res = await intakeApi.guest({ message: text, sessionId, language });
        setMessages((m) => [...m, { id: uid(), role: 'assistant', text: res.message }]);
        if (res.triage) setTriage(res.triage);
        if (typeof res.completeness === 'number') setCompleteness(res.completeness);
        const isEmergency = res.emergencyEscalation === true || res.triage?.category === 'emergency';
        if (isEmergency) setEmergency({ shown: true, reason: res.triage?.reason });
        if (res.isComplete || res.triage) {
          setIsComplete(res.isComplete === true);
          setTimeout(() => setCtaSheet(true), 400);
        }
      } catch (e) {
        setMessages((m) => [...m, { id: uid(), role: 'assistant', text: 'Sorry — I had trouble responding. Please try again.' }]);
        toast.error(getErrorMessage(e, 'Message failed'));
      } finally {
        setSending(false);
      }
    },
    [sending, sessionId, language, toast],
  );

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const showChips = !sending && !!lastAssistant && lastAssistant.text.trim().endsWith('?') && messages.length > 1;
  const tone = triageTone(triage?.category);

  const persistGuestHandoff = useCallback(async () => {
    try {
      const firstUserMsg = messages.find((m) => m.role === 'user')?.text;
      await AsyncStorage.setItem(
        GUEST_INTAKE_HANDOFF_KEY,
        JSON.stringify({
          sessionId,
          messages,
          triage,
          completeness,
          isComplete: isComplete || !!triage,
          language,
          chiefComplaint: firstUserMsg ?? 'AI symptom check',
          savedAt: Date.now(),
        }),
      );
    } catch {
      /* best-effort persistence */
    }
  }, [sessionId, messages, triage, completeness, isComplete, language]);

  // Continue into the real, authenticated queue flow after sign-up.
  const goCreateAccount = async () => {
    setCtaSheet(false);
    haptic.medium();
    await persistGuestHandoff();
    router.push({ pathname: '/(auth)/register', params: { redirect: '/intake' } });
  };

  const goSignIn = async () => {
    setCtaSheet(false);
    haptic.medium();
    await persistGuestHandoff();
    router.push({ pathname: '/(auth)/login', params: { redirect: '/intake' } });
  };

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
            Free · private · no account needed
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
                Understanding your symptoms
              </Text>
            )}
            <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
              <View style={{ width: `${Math.round(Math.max(0.05, completeness) * 100)}%`, height: 5, borderRadius: 3, backgroundColor: triage ? tone.text(theme) : theme.color.primary }} />
            </View>
          </View>
        </FadeInView>
      ) : null}

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
          {messages.map((m) => (
            <ChatBubble key={m.id} message={m.text} sent={m.role === 'user'} />
          ))}
          {sending ? <TypingIndicator /> : null}

          {triage || isComplete ? (
            <FadeInView style={{ marginTop: 8, alignItems: 'center' }}>
              <Button label="See next steps" onPress={() => setCtaSheet(true)} fullWidth={false} size="sm" />
            </FadeInView>
          ) : null}
        </ScrollView>

        {/* Initial Multilingual / Pidgin Quick Starters */}
        {!sending && !isComplete && messages.length === 1 ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 6 }}>
            <Text variant="caption" muted style={{ fontFamily: theme.fontFamily.semibold }}>
              Quick start (English & Naija Pidgin — Meta Muse Spark):
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
                label="🤧 Cough & sore throat since 3 days"
                onPress={() => void send('I have had a dry cough and sore throat for 3 days')}
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
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Describe your symptoms…"
            placeholderTextColor={theme.color.placeholder}
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
            disabled={!input.trim() || sending}
            accessibilityLabel="Send message"
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: !input.trim() || sending ? theme.color.borderStrong : theme.color.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {sending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontSize: 20, marginTop: -2 }}>↑</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

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

      {/* Sign-up CTA sheet */}
      <Sheet visible={ctaSheet} onClose={() => setCtaSheet(false)} title="See a doctor now">
        <View style={{ gap: 14, paddingBottom: 8 }}>
          {triage ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                alignSelf: 'flex-start',
                backgroundColor: tone.bg(theme),
                borderRadius: 999,
                paddingHorizontal: 12,
                paddingVertical: 6,
              }}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone.text(theme) }} />
              <Text variant="caption" style={{ color: tone.text(theme), fontFamily: theme.fontFamily.bold }}>
                {tone.label} priority
              </Text>
            </View>
          ) : null}
          <Text variant="body" muted>
            Create a free account to connect with a doctor and keep your assessment, prescriptions and records in one place.
          </Text>
          <Button label="Create a free account" onPress={goCreateAccount} size="lg" />
          <Button
            label="I already have an account"
            variant="outline"
            size="lg"
            onPress={goSignIn}
          />
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
