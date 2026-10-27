import axios from 'axios';
import { samVisionService, stripBase64ImagePrefix } from '../sam-vision.service';
import { callVoiceDiarizationService, stripBase64AudioPrefix } from '../call-voice-diarization.service';
import { phiScrubberService, inspectAndScrubPHI } from '../phi-scrubber.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Adversarial Challenger 2 — Modal Vision Segmentation & Audio Diarization Stress Harness', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    // =========================================================================
    // 1. SAM Vision Segmentation Stress Testing
    // =========================================================================
    describe('1. SAM Vision Segmentation Stress Testing (samVisionService.segmentMedicalImage)', () => {
        it('1.1: Corrupt base64 string with Modal network failure falls back cleanly to local geometric engine', async () => {
            mockedAxios.post.mockRejectedValueOnce(new Error('Modal GPU Error: binascii.Error: Incorrect padding'));

            const corruptInput = {
                imageBase64: 'NOT_VALID_BASE64_STRING_@#$%^&*()_+~!',
                targetMode: 'wound' as const,
                referenceScaleMm: 20,
            };

            const result = await samVisionService.segmentMedicalImage(corruptInput);

            expect(result).toBeDefined();
            expect(result.model).toBe('Local Geometric Estimate — Offline Fallback');
            expect(result.telemetry.endpoint).toBe('local-engine');
            expect(result.segments.length).toBeGreaterThan(0);
            expect(result.planimetry).toBeDefined();
            expect(result.planimetry?.areaCm2).toBeGreaterThan(0);
        });

        it('1.2: Empty string imageBase64 bypasses network call and immediately uses local fallback', async () => {
            const emptyInput = {
                imageBase64: '',
                targetMode: 'wound' as const,
            };

            const result = await samVisionService.segmentMedicalImage(emptyInput);

            expect(mockedAxios.post).not.toHaveBeenCalled();
            expect(result.model).toBe('Local Geometric Estimate — Offline Fallback');
            expect(result.telemetry.endpoint).toBe('local-engine');
            expect(result.segments.length).toBeGreaterThan(0);
        });

        it('1.3: Data URIs with complex mime types — evaluate prefix stripping resilience', () => {
            // Standard webp
            const webpUri = 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA';
            const strippedWebp = stripBase64ImagePrefix(webpUri);
            expect(strippedWebp).toBe('UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA');

            // SVG XML with plus sign
            const svgXmlUri = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';
            const strippedSvg = stripBase64ImagePrefix(svgXmlUri);
            expect(strippedSvg).toBe('PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==');

            // Vendor MIME with dots
            const iconUri = 'data:image/vnd.microsoft.icon;base64,AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAA==';
            const strippedIcon = stripBase64ImagePrefix(iconUri);
            expect(strippedIcon).toBe('AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAA==');

            // Complex MIME with parameter e.g. ;charset=utf-8;
            const paramUri = 'data:image/png;charset=utf-8;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const strippedParam = stripBase64ImagePrefix(paramUri);
            expect(strippedParam).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
            expect(strippedParam.startsWith('data:')).toBe(false);
        });

        it('1.4: Adversarial negative and zero reference scales on wound planimetry', async () => {
            // Test negative reference scale (-25 mm)
            const negativeScaleResult = await samVisionService.segmentMedicalImage({
                targetMode: 'wound',
                referenceScaleMm: -25,
            });

            const planimetry = negativeScaleResult.planimetry;
            expect(planimetry).toBeDefined();

            // Negative scale is sanitized to standard calibration (fallback to 8.0cm frame width)
            expect(planimetry!.lengthCm).toBeGreaterThan(0);
            expect(planimetry!.widthCm).toBeGreaterThan(0);
            expect(planimetry!.areaCm2).toBeGreaterThan(0);

            // Test zero reference scale (0 mm): defaults to 8.0cm frame width because 0 is not positive
            const zeroScaleResult = await samVisionService.segmentMedicalImage({
                targetMode: 'wound',
                referenceScaleMm: 0,
            });
            expect(zeroScaleResult.planimetry).toBeDefined();
            expect(zeroScaleResult.planimetry!.lengthCm).toBeGreaterThan(0);
            expect(zeroScaleResult.planimetry!.widthCm).toBeGreaterThan(0);
            expect(zeroScaleResult.planimetry!.areaCm2).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // 2. Call Voice Diarization PII Scrubbing & Entity Extraction
    // =========================================================================
    describe('2. Diarization PII Scrubbing with Diverse Nigerian Formats', () => {
        it('2.1: Redaction of Nigerian phone numbers in contiguous, spaced, and international formats', () => {
            // Contiguous 11-digit local format
            const raw1 = 'Patient phone number is 08034567891.';
            const receipt1 = inspectAndScrubPHI(raw1);
            expect(receipt1.scrubbedText).not.toContain('08034567891');
            expect(receipt1.scrubbedText).toContain('[PHONE_REDACTED]');

            // Contiguous E.164 +234 format
            const rawIntl = 'Doctor call me on +2348034567891 please.';
            const receiptIntl = inspectAndScrubPHI(rawIntl);
            expect(receiptIntl.scrubbedText).not.toContain('+2348034567891');
            expect(receiptIntl.scrubbedText).toContain('[PHONE_REDACTED]');

            // Spaced phone numbers: "0803 456 7891" (Commonly dictated in Nigerian voice calls)
            const rawSpaced = 'My phone number is 0803 456 7891.';
            const receiptSpaced = inspectAndScrubPHI(rawSpaced);
            expect(receiptSpaced.scrubbedText).not.toContain('0803 456 7891');
            expect(receiptSpaced.scrubbedText).toContain('[PHONE_REDACTED]');

            // Hyphenated phone numbers: "0803-456-7891"
            const rawHyphen = 'Call me at 0803-456-7891.';
            const receiptHyphen = inspectAndScrubPHI(rawHyphen);
            expect(receiptHyphen.scrubbedText).not.toContain('0803-456-7891');
            expect(receiptHyphen.scrubbedText).toContain('[PHONE_REDACTED]');

            // Spaced with country code: "+234-803-123-4567"
            const rawIntlHyphen = 'Contact at +234-803-123-4567.';
            const receiptIntlHyphen = inspectAndScrubPHI(rawIntlHyphen);
            expect(receiptIntlHyphen.scrubbedText).not.toContain('+234-803-123-4567');
            expect(receiptIntlHyphen.scrubbedText).toContain('[PHONE_REDACTED]');
        });

        it('2.2: Redaction of 11-digit NINs and BVNs', () => {
            // Contiguous 11 digits
            const rawNIN = 'Patient NIN is 12345678901 and BVN is 22234567890.';
            const receipt = inspectAndScrubPHI(rawNIN);
            expect(receipt.scrubbedText).not.toContain('12345678901');
            expect(receipt.scrubbedText).not.toContain('22234567890');
            expect(receipt.redactionCount).toBeGreaterThanOrEqual(2);
            expect(receipt.redactedCategories).toContain('NIN/BVN');

            // Labelled with colon:
            const rawLabelled = 'NIN: 12345678901, BVN: 22234567890';
            const receiptLabelled = inspectAndScrubPHI(rawLabelled);
            expect(receiptLabelled.scrubbedText).not.toContain('12345678901');
            expect(receiptLabelled.scrubbedText).not.toContain('22234567890');
        });

        it('2.3: Redaction of emails (standard and complex/tagged)', () => {
            const rawEmail = 'Contact patient at emeka.okafor+telehealth@subdomain.hospital.gov.ng for follow up.';
            const receipt = inspectAndScrubPHI(rawEmail);
            expect(receipt.scrubbedText).not.toContain('emeka.okafor+telehealth@subdomain.hospital.gov.ng');
            expect(receipt.scrubbedText).toContain('[EMAIL_REDACTED]');
        });

        it('2.4: Redaction of Nigerian 10-digit bank account numbers (NUBAN)', () => {
            // In free text conversation:
            const rawBank = 'Patient says: Please transfer the refund to my Zenith bank account 0123456789.';
            const receipt = inspectAndScrubPHI(rawBank);
            expect(receipt.scrubbedText).not.toContain('0123456789');
            expect(receipt.scrubbedText).toContain('[ID_REDACTED]');

            // Labelled bank account:
            const rawLabelledBank = 'Account Number: 2048596031';
            const receiptLabelled = inspectAndScrubPHI(rawLabelledBank);
            expect(receiptLabelled.scrubbedText).not.toContain('2048596031');
            expect(receiptLabelled.scrubbedText).toContain('[ID_REDACTED]');
        });

        it('2.5: Full adversarial dialogue diarization with diverse PII and entity extraction', async () => {
            const adversarialDialogue = `Doctor: Good day, please state your full name and complaints.
Patient: My name is Emeka Nnamdi. My phone is 08034567891, NIN is 11223344556, BVN is 22334455667. My email is emeka@testmail.com. You can refund my consultation to Access bank 0123456789.
Doctor: I see. What symptoms are you experiencing?
Patient: I have severe high fever of 39.5 C, dry cough, and chest tightness for 3 days. I took Paracetamol and Amoxicillin without relief.`;

            const result = await callVoiceDiarizationService.diarizeConsultationAudio({
                dialogue: adversarialDialogue,
                language: 'english',
            });

            expect(result.speakersDetected).toBe(2);
            expect(result.turns.length).toBe(4);

            // Verified scrubbed items:
            expect(result.fullScrubbedTranscript).not.toContain('08034567891');
            expect(result.fullScrubbedTranscript).not.toContain('11223344556');
            expect(result.fullScrubbedTranscript).not.toContain('22334455667');
            expect(result.fullScrubbedTranscript).not.toContain('emeka@testmail.com');
            expect(result.fullScrubbedTranscript).not.toContain('0123456789');

            // Verified extracted clinical entities:
            expect(result.extractedEntities).toBeDefined();
            expect(result.extractedEntities?.symptoms.length).toBeGreaterThan(0);
            expect(result.extractedEntities?.medications.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // 3. Modal GPU Offline & Fallback Behavior
    // =========================================================================
    describe('3. Modal GPU Remote Offline, Unreachable & Timeout Fallback', () => {
        it('3.1: samVisionService handles Modal HTTP 500 error and returns local geometric fallback', async () => {
            mockedAxios.post.mockRejectedValueOnce({
                response: { status: 500, data: { detail: 'Internal Server Error in Modal SAM container' } },
                message: 'Request failed with status code 500',
            });

            const result = await samVisionService.segmentMedicalImage({
                imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                targetMode: 'rdt_strip',
            });

            expect(result.model).toBe('Local Geometric Estimate — Offline Fallback');
            expect(result.telemetry.endpoint).toBe('local-engine');
            expect(result.targetMode).toBe('rdt_strip');
            expect(result.segments.length).toBeGreaterThanOrEqual(3);
        });

        it('3.2: samVisionService handles ECONNREFUSED / timeout gracefully', async () => {
            mockedAxios.post.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'));

            const result = await samVisionService.segmentMedicalImage({
                imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                targetMode: 'lab_sheet',
            });

            expect(result.model).toBe('Local Geometric Estimate — Offline Fallback');
            expect(result.telemetry.endpoint).toBe('local-engine');
            expect(result.headerStripRedacted).toBe(true);
        });

        it('3.3: callVoiceDiarizationService handles Modal timeout on audio input and falls back to simulated turns', async () => {
            mockedAxios.post.mockRejectedValueOnce(new Error('timeout of 20000ms exceeded'));

            const result = await callVoiceDiarizationService.diarizeConsultationAudio({
                audioBase64: 'AAAAHGZ0eXBtcDQyAAAAAW1wNDJtcDQxaXNvbQ==',
                language: 'pidgin',
            });

            expect(result.model).toBe('meta-sam-audio-local-engine');
            expect(result.telemetry.endpoint).toBe('local-engine');
            expect(result.turns.length).toBeGreaterThan(0);
            expect(result.fullScrubbedTranscript).toBeTruthy();
        });

        it('3.4: callVoiceDiarizationService handles Modal HTTP 502 Bad Gateway gracefully', async () => {
            mockedAxios.post.mockRejectedValueOnce({
                response: { status: 502, data: 'Bad Gateway' },
                message: 'Request failed with status code 502',
            });

            const result = await callVoiceDiarizationService.diarizeConsultationAudio({
                audioBase64: 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA',
                language: 'english',
            });

            expect(result.model).toBe('meta-sam-audio-local-engine');
            expect(result.telemetry.endpoint).toBe('local-engine');
            expect(result.turns.length).toBeGreaterThan(0);
        });
    });
});
