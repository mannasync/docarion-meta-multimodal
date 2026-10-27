import React, { useState, useCallback } from 'react';
import { View, Pressable, Image, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
// Guarded native load — keep the route's default export intact even if the
// image-picker native module isn't linked in this build.
let ImagePicker: typeof import('expo-image-picker') | null = null;
try { ImagePicker = require('expo-image-picker'); } catch { ImagePicker = null; }
import {
  Screen,
  Text,
  Card,
  Button,
  Input,
  Sheet,
  EmptyState,
  SkeletonCard,
  StatusBadge,
  SegmentedTabs,
  Chip,
  useTheme,
  useToast,
  keyboardDoneProps,
} from '@docarion/ui';
import {
  documentsApi,
  intakeApi,
  useCachedQuery,
  getErrorMessage,
  useNetworkState,
  type ScannedDocument,
} from '@docarion/core';
import { BackButton } from '../components/BackButton';
import { HeaderBell } from '../components/HeaderBell';
import { FadeInView } from '../components/FadeInView';
import { useScreenFocus } from '../hooks/useScreenFocus';
import { haptic } from '../lib/haptics';
import { formatDate } from '../lib/format';

const DOC_TYPES = [
  { value: 'lab_result', label: 'Lab result' },
  { value: 'prescription', label: 'Prescription' },
  { value: 'medical_record', label: 'Medical record' },
  { value: 'imaging', label: 'Imaging / X-ray' },
  { value: 'insurance', label: 'Insurance card' },
  { value: 'id_document', label: 'ID document' },
  { value: 'referral', label: 'Referral letter' },
  { value: 'other', label: 'Other' },
];

export default function DocumentScannerScreen() {
  const theme = useTheme();
  const toast = useToast();
  const router = useRouter();
  const focused = useScreenFocus();
  const netState = useNetworkState();

  const [uploadSheet, setUploadSheet] = useState(false);
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [docType, setDocType] = useState('lab_result');
  const [docTitle, setDocTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<ScannedDocument | null>(null);

  // Consumer Meta Multimodal Scanner state (NAFDAC Medicine Check + SAM 3.1 Clinical Vision)
  const [activeTab, setActiveTab] = useState<'documents' | 'nafdac' | 'vision'>('documents');
  const [nafdacRegNo, setNafdacRegNo] = useState('');
  const [drugName, setDrugName] = useState('');
  const [nafdacBusy, setNafdacBusy] = useState(false);
  const [nafdacResult, setNafdacResult] = useState<Record<string, unknown> | null>(null);

  const [visionMode, setVisionMode] = useState<'rdt_strip' | 'lab_sheet' | 'dermatology' | 'wound'>('rdt_strip');
  const [scaleMm, setScaleMm] = useState('20');
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionResult, setVisionResult] = useState<Record<string, unknown> | null>(null);

  const verifyConsumerMedicine = useCallback(
    async (regOverride?: string, nameOverride?: string) => {
      const reg = (regOverride ?? nafdacRegNo).trim();
      const name = (nameOverride ?? drugName).trim();
      if (!reg && !name) {
        toast.error('Enter a NAFDAC Reg Number or Medicine Name');
        return;
      }
      setNafdacBusy(true);
      setNafdacResult(null);
      haptic.select();
      try {
        const res = await intakeApi.verifyNafdac({
          nafdacRegNo: reg || undefined,
          drugName: name || undefined,
          facilityLicenceClass: 'patient_self_check',
        });
        const payload = ((res as Record<string, unknown>)?.data as Record<string, unknown>) ?? (res as Record<string, unknown>);
        setNafdacResult(payload);
        haptic.success();
      } catch (e) {
        toast.error(getErrorMessage(e, 'Could not verify medicine'));
      } finally {
        setNafdacBusy(false);
      }
    },
    [nafdacRegNo, drugName, toast],
  );

  const analyzeConsumerVision = useCallback(
    async (modeOverride?: 'rdt_strip' | 'lab_sheet' | 'dermatology' | 'wound') => {
      const target = modeOverride ?? visionMode;
      const numericScale = Number(scaleMm) > 0 ? Number(scaleMm) : 20;
      setVisionBusy(true);
      setVisionResult(null);
      haptic.select();
      try {
        const res = await intakeApi.analyzeVision({
          type: target,
          referenceScaleMm: numericScale,
          clinicalContext: `Patient mobile app pre-visit ${target} scan`,
        });
        const payload = ((res as Record<string, unknown>)?.data as Record<string, unknown>) ?? (res as Record<string, unknown>);
        setVisionResult({ target, ...payload });
        haptic.success();
      } catch (e) {
        toast.error(getErrorMessage(e, 'Could not run SAM 3.1 vision analysis'));
      } finally {
        setVisionBusy(false);
      }
    },
    [visionMode, scaleMm, toast],
  );

  const docs = useCachedQuery<ScannedDocument[]>(
    'patient.documents',
    async () => {
      try {
        const res = await documentsApi.list();
        return Array.isArray(res) ? res : [];
      } catch (e) {
        const msg = getErrorMessage(e, '');
        if (/404|not found|empty|no documents/i.test(msg)) return [];
        throw e;
      }
    },
    { interval: 120000, focused },
  );

  const onTakePhoto = useCallback(async () => {
    haptic.light();
    if (!ImagePicker) { toast.error('Camera not available on this build. Please update the app.'); return; }
    try {
      const result = await ImagePicker!.launchCameraAsync({
        mediaTypes: ImagePicker!.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [4, 5],
        quality: 0.85,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      setSelectedUri(result.assets[0].uri);
      setUploadSheet(true);
    } catch {
      toast.error('Camera not available. Check your permissions.');
    }
  }, [toast]);

  const onPickFromGallery = useCallback(async () => {
    haptic.light();
    if (!ImagePicker) { toast.error('Photo library not available on this build. Please update the app.'); return; }
    try {
      const result = await ImagePicker!.launchImageLibraryAsync({
        mediaTypes: ImagePicker!.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [4, 5],
        quality: 0.85,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      setSelectedUri(result.assets[0].uri);
      setUploadSheet(true);
    } catch {
      toast.error('Could not open photo library');
    }
  }, [toast]);

  const onUpload = async () => {
    if (!selectedUri) {
      toast.error('Take a photo or pick an image first');
      return;
    }
    if (!docTitle.trim()) {
      toast.error('Enter a title for this document');
      return;
    }
    setUploading(true);
    haptic.select();
    try {
      await documentsApi.upload(selectedUri, {
        type: docType,
        title: docTitle.trim(),
      });
      haptic.success();
      toast.success('Document uploaded');
      setUploadSheet(false);
      setSelectedUri(null);
      setDocTitle('');
      docs.refresh();
    } catch (e) {
      haptic.error();
      // The offline queue replays JSON only; a photo needs a real multipart
      // upload, so "will upload when you reconnect" could never come true.
      // Keep the photo and title here and let the patient retry.
      if (!netState.online) {
        toast.error("You're offline — your photo is kept here. Tap Upload again when you're back online.");
      } else {
        toast.error(getErrorMessage(e, 'Upload failed — your photo is kept here, please try again.'));
      }
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (documentId: string) => {
    haptic.warning();
    try {
      await documentsApi.remove(documentId);
      toast.success('Document deleted');
      docs.refresh();
    } catch (e) {
      toast.error(getErrorMessage(e, 'Could not delete document'));
    }
  };

  const docList = docs.data ?? [];

  const docIcon = (type: string): string => {
    if (type === 'lab_result') return '🔬';
    if (type === 'prescription') return '💊';
    if (type === 'imaging') return '🩻';
    if (type === 'insurance') return '🏥';
    if (type === 'id_document') return '🪪';
    if (type === 'referral') return '📋';
    return '📄';
  };

  return (
    <Screen
      scroll
      title="AI Scanner & Documents"
      headerLeft={<BackButton />}
      headerRight={<HeaderBell focused={focused} />}
      refreshing={docs.loading && !!docs.data}
      onRefresh={docs.refresh}
    >
      <View style={{ marginBottom: 16 }}>
        <SegmentedTabs
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'documents', label: '📄 Documents' },
            { value: 'nafdac', label: '💊 NAFDAC Check' },
            { value: 'vision', label: '🔬 SAM 3.1 Vision' },
          ]}
        />
      </View>

      {activeTab === 'nafdac' ? (
        <View style={{ gap: 14, marginBottom: 20 }}>
          <Card>
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="heading">NAFDAC Medicine Checker</Text>
                <StatusBadge status="active" label="Meta Muse Spark" />
              </View>
              <Text variant="caption" muted>
                Verify if a medicine pack is registered in the verified NAFDAC Registry or requires a licensed doctor&apos;s e-Prescription (PCN Gate). Advisory only — consult a doctor or pharmacist.
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Chip
                  label="✅ Coartem 80/480 (OTC)"
                  onPress={() => {
                    setNafdacRegNo('A4-0192');
                    setDrugName('Coartem 80/480mg');
                    void verifyConsumerMedicine('A4-0192', 'Coartem 80/480mg');
                  }}
                />
                <Chip
                  label="⚠️ Amoxicillin 500mg (POM)"
                  onPress={() => {
                    setNafdacRegNo('04-2891');
                    setDrugName('Amoxicillin 500mg');
                    void verifyConsumerMedicine('04-2891', 'Amoxicillin 500mg');
                  }}
                />
                <Chip
                  label="🚨 Fake Reg Alert"
                  onPress={() => {
                    setNafdacRegNo('FAKE-9999');
                    setDrugName('Counterfeit Pack');
                    void verifyConsumerMedicine('FAKE-9999', 'Counterfeit Pack');
                  }}
                />
              </View>
              <Input
                label="NAFDAC Registration Number"
                value={nafdacRegNo}
                onChangeText={setNafdacRegNo}
                placeholder="e.g. A4-0192 or 04-2891"
                {...keyboardDoneProps}
              />
              <Input
                label="Medicine / Brand Name"
                value={drugName}
                onChangeText={setDrugName}
                placeholder="e.g. Coartem 80/480mg or Amoxicillin 500mg"
                {...keyboardDoneProps}
              />
              <Button
                label={nafdacBusy ? 'Checking NAFDAC Registry…' : 'Verify Medicine Pack'}
                onPress={() => void verifyConsumerMedicine()}
                loading={nafdacBusy}
              />
            </View>
          </Card>

          {nafdacResult ? (
            <Card>
              <View style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text variant="bodyMedium">
                    {String(nafdacResult.brandName || drugName || 'Medicine Result')}
                  </Text>
                  <StatusBadge
                    status={nafdacResult.authenticityStatus === 'verified' || nafdacResult.authenticityStatus === 'verified_authentic' ? 'completed' : 'warning'}
                    label={String(nafdacResult.authenticityStatus || 'unverified_registry').toUpperCase()}
                  />
                </View>
                <Text variant="caption" muted>
                  NAFDAC Reg No: {String(nafdacResult.nafdacRegNo || nafdacRegNo || 'N/A')} · Schedule: {String(nafdacResult.drugSchedule || 'UNKNOWN').toUpperCase()}
                </Text>
                <Text variant="body">
                  {String(nafdacResult.regulatoryNote || nafdacResult.counterDispensingAction || 'Manual pharmacist verification recommended.')}
                </Text>
                {String(nafdacResult.drugSchedule || '').toUpperCase() === 'POM' ? (
                  <Button
                    label="🩺 Need an e-Prescription? Start AI Intake & See a Doctor"
                    onPress={() => router.push('/intake')}
                  />
                ) : null}
              </View>
            </Card>
          ) : null}
        </View>
      ) : activeTab === 'vision' ? (
        <View style={{ gap: 14, marginBottom: 20 }}>
          <Card>
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="heading">SAM 3.1 Clinical Vision</Text>
                <StatusBadge status="active" label="Meta SAM 3.1 • Modal GPU" />
              </View>
              <Text variant="caption" muted>
                Segment Malaria RDT strips, paper lab result sheets (automatically stripping patient name headers for privacy), skin rashes, and wounds with calibrated mm²/cm² planimetry.
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {([
                  { key: 'rdt_strip', label: '🧪 Malaria RDT Strip' },
                  { key: 'lab_sheet', label: '📄 Lab Sheet (PHI Strip)' },
                  { key: 'dermatology', label: '🩹 Skin Rash' },
                  { key: 'wound', label: '📏 Wound / Ulcer' },
                ] as const).map((item) => (
                  <Chip
                    key={item.key}
                    label={item.label}
                    selected={visionMode === item.key}
                    onPress={() => {
                      setVisionMode(item.key);
                      void analyzeConsumerVision(item.key);
                    }}
                  />
                ))}
              </View>
              <Input
                label="Calibration Reference Scale (mm)"
                value={scaleMm}
                onChangeText={setScaleMm}
                keyboardType="numeric"
                placeholder="20"
                {...keyboardDoneProps}
              />
              <Button
                label={visionBusy ? 'Running SAM 3.1 Segmentation…' : 'Analyze with Meta SAM 3.1'}
                onPress={() => void analyzeConsumerVision()}
                loading={visionBusy}
              />
            </View>
          </Card>

          {visionResult ? (
            <Card>
              <View style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text variant="bodyMedium">
                    SAM 3.1 ROI ({String(visionResult.target || visionMode).toUpperCase()})
                  </Text>
                  <StatusBadge status="completed" label={String(visionResult.modelUsed || 'meta-sam-3.1')} />
                </View>
                <Text variant="body">
                  {String(visionResult.visualFindingSummary || 'Clinical region isolated and ready for physician review.')}
                </Text>
                {(visionResult.structuredExtraction as Record<string, unknown> | undefined)?.estimatedSurfaceAreaCm2 != null ? (
                  <Text variant="caption" style={{ fontFamily: theme.fontFamily.bold, color: theme.color.primary }}>
                    Calibrated Area: {String((visionResult.structuredExtraction as Record<string, unknown>).estimatedSurfaceAreaCm2)} cm² (
                    {Math.round(Number((visionResult.structuredExtraction as Record<string, unknown>).estimatedSurfaceAreaCm2) * 100)} mm²)
                  </Text>
                ) : null}
                <Button
                  label="🩺 Discuss Finding with a Doctor (Start AI Intake)"
                  onPress={() => router.push('/intake')}
                />
              </View>
            </Card>
          ) : null}
        </View>
      ) : null}

      {/* Scanner action cards */}
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 20 }}>
        <Pressable
          onPress={onTakePhoto}
          style={({ pressed }) => [
            styles.scanCard,
            {
              backgroundColor: theme.color.primary,
              opacity: pressed ? 0.88 : 1,
            },
          ]}
        >
          <Text style={{ fontSize: 36, marginBottom: 8 }}>📷</Text>
          <Text variant="label" style={{ color: '#fff' }}>Scan</Text>
          <Text variant="caption" style={{ color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>
            Take a photo
          </Text>
        </Pressable>
        <Pressable
          onPress={onPickFromGallery}
          style={({ pressed }) => [
            styles.scanCard,
            {
              backgroundColor: theme.color.surfaceAlt,
              borderColor: theme.color.border,
              borderWidth: 1,
              opacity: pressed ? 0.88 : 1,
            },
          ]}
        >
          <Text style={{ fontSize: 36, marginBottom: 8 }}>🖼️</Text>
          <Text variant="label">Gallery</Text>
          <Text variant="caption" muted style={{ marginTop: 2 }}>
            Pick from photos
          </Text>
        </Pressable>
      </View>

      {/* Document list */}
      {docs.loading && !docs.data ? (
        <View style={{ gap: 12 }}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : docs.error && !docs.data ? (
        <EmptyState
          emoji="📡"
          title="Couldn't load documents"
          description={getErrorMessage(docs.error, 'Check your connection and try again.')}
          actionLabel="Retry"
          onAction={docs.refresh}
        />
      ) : docList.length === 0 ? (
        <EmptyState
          emoji="📄"
          title="No documents yet"
          description="Scan lab results, prescriptions, insurance cards, and more. Your documents are securely stored and shareable with your care team."
          actionLabel="Scan a document"
          onAction={onTakePhoto}
        />
      ) : (
        <View style={{ gap: 12 }}>
          {docList.map((doc, i) => {
            const docTypeLabel = DOC_TYPES.find((t) => t.value === doc.type)?.label ?? doc.type ?? 'Document';
            return (
              <FadeInView key={doc.documentId ?? i} delay={i * 40}>
                <Card onPress={() => setPreviewDoc(doc)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                    <View
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 14,
                        backgroundColor: theme.color.surfaceAlt,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 1,
                        borderColor: theme.color.border,
                      }}
                    >
                      <Text style={{ fontSize: 24 }}>{docIcon(doc.type)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyMedium" numberOfLines={1}>
                        {doc.title}
                      </Text>
                      <Text variant="caption" muted style={{ marginTop: 2 }}>
                        {docTypeLabel} · {formatDate(doc.uploadedAt)}
                      </Text>
                    </View>
                    <StatusBadge status={doc.status ?? 'completed'} />
                  </View>
                </Card>
              </FadeInView>
            );
          })}
        </View>
      )}

      {/* Upload sheet */}
      <Sheet
        visible={uploadSheet}
        onClose={() => {
          setUploadSheet(false);
          setSelectedUri(null);
          setDocTitle('');
        }}
        title="Upload document"
      >
        <View style={{ gap: 16, paddingBottom: 8 }}>
          {selectedUri ? (
            <View style={{ alignItems: 'center' }}>
              <Image
                source={{ uri: selectedUri }}
                style={{
                  width: 200,
                  height: 250,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: theme.color.border,
                }}
                resizeMode="contain"
              />
            </View>
          ) : null}

          <View>
            <Text variant="label" muted style={{ marginBottom: 8 }}>
              Document type
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {DOC_TYPES.map((t) => (
                <Pressable
                  key={t.value}
                  onPress={() => {
                    haptic.select();
                    setDocType(t.value);
                  }}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 20,
                    backgroundColor: docType === t.value ? theme.color.primary : theme.color.surfaceAlt,
                    borderWidth: 1,
                    borderColor: docType === t.value ? theme.color.primary : theme.color.border,
                  }}
                >
                  <Text
                    variant="caption"
                    style={{
                      color: docType === t.value ? '#fff' : theme.color.text,
                      fontFamily: theme.fontFamily.semibold,
                    }}
                  >
                    {t.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <Input
            label="Title"
            value={docTitle}
            onChangeText={setDocTitle}
            placeholder="e.g. Blood test results — Jan 2026"
            {...keyboardDoneProps}
          />

          <Button
            label={uploading ? 'Uploading…' : 'Upload document'}
            onPress={onUpload}
            loading={uploading}
            size="lg"
          />
          <Button
            label="Cancel"
            variant="ghost"
            onPress={() => {
              setUploadSheet(false);
              setSelectedUri(null);
              setDocTitle('');
            }}
          />
        </View>
      </Sheet>

      {/* Document preview sheet */}
      <Sheet
        visible={!!previewDoc}
        onClose={() => setPreviewDoc(null)}
        title={previewDoc?.title ?? 'Document'}
      >
        <View style={{ gap: 16, paddingBottom: 8 }}>
          {previewDoc?.fileUrl ? (
            <View style={{ alignItems: 'center' }}>
              <Image
                source={{ uri: previewDoc.fileUrl }}
                style={{
                  width: '100%',
                  height: 300,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: theme.color.border,
                }}
                resizeMode="contain"
              />
            </View>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: 20 }}>
              <Text style={{ fontSize: 56 }}>📄</Text>
              <Text variant="body" muted style={{ marginTop: 12 }}>
                Preview not available
              </Text>
            </View>
          )}

          <Card padded={false} style={{ paddingHorizontal: 16 }}>
            <View style={{ paddingVertical: 12 }}>
              <Text variant="caption" muted>Type</Text>
              <Text variant="bodyMedium" style={{ marginTop: 2 }}>
                {DOC_TYPES.find((t) => t.value === previewDoc?.type)?.label ?? previewDoc?.type ?? 'Document'}
              </Text>
            </View>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.color.divider }} />
            <View style={{ paddingVertical: 12 }}>
              <Text variant="caption" muted>Uploaded</Text>
              <Text variant="bodyMedium" style={{ marginTop: 2 }}>
                {previewDoc ? formatDate(previewDoc.uploadedAt) : ''}
              </Text>
            </View>
          </Card>

          <Button
            label="Delete document"
            variant="danger"
            onPress={() => {
              if (previewDoc) {
                onDelete(previewDoc.documentId);
                setPreviewDoc(null);
              }
            }}
          />
          <Button
            label="Close"
            variant="ghost"
            onPress={() => setPreviewDoc(null)}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scanCard: {
    flex: 1,
    borderRadius: 20,
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});