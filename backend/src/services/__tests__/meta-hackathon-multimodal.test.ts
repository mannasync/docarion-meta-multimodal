import { samVisionService } from '../sam-vision.service';
import { nafdacVerificationService } from '../nafdac-verification.service';
import { callVoiceDiarizationService } from '../call-voice-diarization.service';
import { aiCopilotService } from '../ai-copilot.service';
import { aiCoreService } from '../ai-core.service';
import { phiScrubberService } from '../phi-scrubber.service';

describe('Meta Model API Hackathon Multimodal Engine', () => {
    describe('1. Task-Tier Cost Routing & SHA-256 Cache (ai-core.service)', () => {
        it('should inspect PII and generate telemetry with redactions', async () => {
            const rawMessage = 'Patient Chinedu Okafor with NIN 12345678901 and phone 08034567891 reports severe headache.';
            const receipt = phiScrubberService.inspectAndScrubPHI(rawMessage);

            expect(receipt.hasRedactions).toBe(true);
            expect(receipt.redactionCount).toBeGreaterThanOrEqual(2);
            expect(receipt.redactedCategories).toContain('NIN/BVN');
            expect(receipt.redactedCategories).toContain('PHONE');
            expect(receipt.scrubbedText).not.toContain('12345678901');
            expect(receipt.scrubbedText).not.toContain('08034567891');
        });
    });

    describe('2. SAM 3.1 Region of Interest (ROI) Segmentation (sam-vision.service)', () => {
        it('should segment drug pack with box and NAFDAC stamp', async () => {
            const result = await samVisionService.segmentMedicalImage({
                targetMode: 'drug_pack',
            });

            expect(result.privacyDeidentified).toBe(true);
            expect(result.backgroundMasked).toBe(true);
            expect(result.segments.length).toBeGreaterThanOrEqual(2);

            const labels = result.segments.map(s => s.label);
            expect(labels).toContain('drug_pack_outer');
            expect(labels).toContain('nafdac_reg_box');
        });

        it('should segment malaria RDT strip with C and Pf lines', async () => {
            const result = await samVisionService.segmentMedicalImage({
                targetMode: 'rdt_strip',
            });

            expect(result.targetMode).toBe('rdt_strip');
            const labels = result.segments.map(s => s.label);
            expect(labels).toContain('rdt_cassette');
            expect(labels).toContain('control_line_c');
            expect(labels).toContain('test_line_pf');
        });

        it('should segment wound bed and compute planimetry area and stage', async () => {
            const result = await samVisionService.segmentMedicalImage({
                targetMode: 'wound',
                referenceScaleMm: 20,
            });

            expect(result.planimetry).toBeDefined();
            expect(result.planimetry!.lengthCm).toBeGreaterThan(0);
            expect(result.planimetry!.widthCm).toBeGreaterThan(0);
            expect(result.planimetry!.areaCm2).toBeGreaterThan(0);
            expect(result.planimetry!.suggestedStage).toBeDefined();
        });

        it('should segment lab sheet while redacting identifying header', async () => {
            const result = await samVisionService.segmentMedicalImage({
                targetMode: 'lab_sheet',
            });

            expect(result.headerStripRedacted).toBe(true);
            const header = result.segments.find(s => s.label === 'redacted_patient_header');
            expect(header).toBeDefined();
        });

        it('should strip data:image/...;base64 prefix safely and process image segmentation', async () => {
            const dataUri = 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const result = await samVisionService.segmentMedicalImage({
                imageBase64: dataUri,
                targetMode: 'wound',
            });

            expect(result.privacyDeidentified).toBe(true);
            expect(result.backgroundMasked).toBe(true);
            expect(result.segments.length).toBeGreaterThanOrEqual(1);
        }, 25000);
    });

    describe('3. NAFDAC Drug-Pack Verification & PCN PPMV Scope Gate (nafdac-verification.service)', () => {
        it('should verify authentic OTC antimalarial (Coartem A4-0192) and permit PPMV counter sale', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'A4-0192',
                facilityLicenceClass: 'ppmv',
            });

            expect(result.formatValid).toBe(true);
            expect(result.authenticityStatus).toBe('verified_authentic');
            expect(result.drugClass).toBe('otc');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(true);
            expect(result.ppmvCounterGate.statusBanner).toBe('APPROVED_FOR_PPMV_OTC_SALE');
        });

        it('should verify custom unlisted OTC drug (Ibuprofen B4-9988) and permit PPMV counter sale with unverified_registry status', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'B4-9988',
                drugName: 'Ibuprofen 400mg',
                facilityLicenceClass: 'ppmv',
            });

            expect(result.formatValid).toBe(true);
            expect(result.authenticityStatus).toBe('unverified_registry');
            expect(result.drugClass).toBe('otc');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(true);
            expect(result.ppmvCounterGate.statusBanner).toBe('APPROVED_FOR_PPMV_OTC_SALE');
            expect(result.productDetails).toBeDefined();
            expect(result.productDetails?.genericName.toLowerCase()).toContain('ibuprofen');
            expect(result.ppmvCounterGate.actionableNextStep).toContain('manual pharmacist verification required');
        });

        it('should classify unlisted NAFDAC number with registered brand name as unverified_registry (counterfeit protection)', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-9999',
                drugName: 'Coartem',
                facilityLicenceClass: 'ppmv',
            });

            expect(result.formatValid).toBe(true);
            expect(result.authenticityStatus).toBe('unverified_registry');
            expect(result.productDetails?.nafdacRegNo).toBe('04-9999');
            expect(result.ppmvCounterGate.actionableNextStep).toContain('manual pharmacist verification required');
        });

        it('should BLOCK prescription-only antibiotic (Augmentin 04-1928) at PPMV counter and prompt doctor escalation', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-1928',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: false,
            });

            expect(result.authenticityStatus).toBe('verified_authentic');
            expect(result.drugClass).toBe('pom');
            expect(result.awareCategory).toBe('Access');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(result.ppmvCounterGate.statusBanner).toBe('BLOCKED_POM_ESCALATE_TO_DOCTOR');
        });

        it('should BLOCK unlisted POM antibiotic (Ceftriaxone 04-7123) at PPMV counter without e-Rx', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-7123',
                drugName: 'Ceftriaxone 1g Injection',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: false,
            });

            expect(result.formatValid).toBe(true);
            expect(result.authenticityStatus).toBe('unverified_registry');
            expect(result.drugClass).toBe('pom');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(result.ppmvCounterGate.statusBanner).toBe('BLOCKED_POM_ESCALATE_TO_DOCTOR');
        });

        it('should UNLOCK unlisted POM antibiotic at PPMV counter when active linked e-Rx exists', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-7123',
                drugName: 'Ceftriaxone 1g Injection',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true,
            });

            expect(result.drugClass).toBe('pom');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(true);
            expect(result.ppmvCounterGate.statusBanner).toBe('APPROVED_FOR_PPMV_OTC_SALE');
        });

        it('should UNLOCK prescription-only medicine at PPMV when a valid linked physician e-Rx exists', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-1928',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true,
            });

            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(true);
            expect(result.ppmvCounterGate.statusBanner).toBe('APPROVED_FOR_PPMV_OTC_SALE');
        });

        it('should strictly BLOCK controlled substances (Tramadol) at counter POS', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-8800',
                facilityLicenceClass: 'ppmv',
            });

            expect(result.drugClass).toBe('controlled');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(result.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
        });

        it('should strictly BLOCK controlled substances at counter POS even if e-Rx is passed', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-8800',
                drugName: 'Tramadol 100 SR',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true, // Attempting to bypass counter POS with an e-Rx
            });

            expect(result.drugClass).toBe('controlled');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(result.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
        });

        it('should reject invalid NAFDAC registration format as unvalidated risk', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'INVALID-9999',
                facilityLicenceClass: 'ppmv',
            });

            expect(result.formatValid).toBe(false);
            expect(result.authenticityStatus).toBe('unregistered_or_invalid');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(result.ppmvCounterGate.statusBanner).toBe('BLOCKED_UNREGISTERED_OR_EXPIRED');
        });

        it('should flag expired medicine batches as expired risk and block dispensing', () => {
            const result = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'A4-0192',
                expiryDate: '2020-01-01',
                facilityLicenceClass: 'ppmv',
            });

            expect(result.isExpired).toBe(true);
            expect(result.authenticityStatus).toBe('expired_batch');
            expect(result.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(result.ppmvCounterGate.statusBanner).toBe('BLOCKED_UNREGISTERED_OR_EXPIRED');
        });
    });

    describe('4. Two-Way Call Voice Segregation & Diarization (call-voice-diarization.service)', () => {
        it('should segregate doctor and patient dialogue, scrub PII, and extract entities', async () => {
            const result = await callVoiceDiarizationService.diarizeConsultationAudio({
                consultationId: 'test_consult_123',
                language: 'pidgin',
                stripNoise: true,
            });

            expect(result.noiseFiltered).toBe(true);
            expect(result.speakersDetected).toBe(2);
            expect(result.turns.length).toBeGreaterThanOrEqual(2);

            const speakers = result.turns.map(t => t.speaker);
            expect(speakers).toContain('SPEAKER_DOCTOR');
            expect(speakers).toContain('SPEAKER_PATIENT');

            // Verify PII scrubbing on dialogue
            expect(result.fullScrubbedTranscript).not.toContain('08034567891');

            // Verify clinical entity extraction
            expect(result.extractedEntities).toBeDefined();
            expect(result.extractedEntities!.symptoms.length).toBeGreaterThan(0);
            expect(result.extractedEntities!.medications.length).toBeGreaterThan(0);
        });

        it('should parse custom dialogue, scrub PII (phone & NIN), and extract clinical entities', async () => {
            const customDialogue = `Doctor: Good day, wetin dey worry you today?
Patient: Doctor, I have severe watery diarrhea since yesterday. My phone is 08023456789 and my NIN is 11223344556.
Doctor: Have you taken Oral Rehydration Salts or Zinc?
Patient: No doctor, I only took Ciprofloxacin earlier today.`;

            const result = await callVoiceDiarizationService.diarizeConsultationAudio({
                dialogue: customDialogue,
                language: 'pidgin',
                stripNoise: true,
            });

            expect(result.turns.length).toBeGreaterThanOrEqual(4);
            expect(result.fullScrubbedTranscript).not.toContain('08023456789');
            expect(result.fullScrubbedTranscript).not.toContain('11223344556');
            expect(result.fullScrubbedTranscript).toContain('[PHONE_REDACTED]');
            expect(result.fullScrubbedTranscript).toContain('[ID_REDACTED]');

            expect(result.extractedEntities).toBeDefined();
            expect(result.extractedEntities!.symptoms.length).toBeGreaterThanOrEqual(1);
            expect(result.extractedEntities!.medications.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('5. Live Serverless DDx & Automated SOAP Co-Pilot (ai-copilot.service)', () => {
        it('should synthesize consultation findings into DDx, SOAP draft, and Pidgin discharge advice', async () => {
            const result = await aiCopilotService.generateLiveConsultationCopilot({
                consultationId: 'test_consult_456',
                intakeHistory: { chiefComplaint: 'Fever for 3 days, headache, dark urine' },
                vitals: { temperature: 38.9, heartRate: 104, bloodPressure: { systolic: 120, diastolic: 80 } },
                visionFindings: [{ type: 'rdt_strip', result: 'positive', species: 'P. falciparum' }],
                language: 'pidgin',
            });

            expect(result.consultationId).toBe('test_consult_456');
            expect(result.soapDraft).toBeDefined();
            expect(result.soapDraft.subjective).toBeTruthy();
            expect(result.soapDraft.objective).toBeTruthy();
            expect(result.soapDraft.assessment).toBeTruthy();
            expect(result.soapDraft.plan).toBeTruthy();

            expect(result.differentials.length).toBeGreaterThanOrEqual(1);
            expect(result.nafdacVerifiedRx.length).toBeGreaterThanOrEqual(1);
            expect(result.vernacularPatientSummary).toBeTruthy();
        });
    });
});
