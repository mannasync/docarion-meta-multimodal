import { nafdacVerificationService } from '../nafdac-verification.service';

describe('NAFDAC Verification & PCN PPMV Scope Gate — Adversarial Stress Suite', () => {
    describe('1. Controlled Substance Counter POS Bypass Resistance', () => {
        it('should strictly BLOCK generic Tramadol even with hasActiveLinkedRx: true', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: '04-8800',
                drugName: 'Tramadol 100 SR',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true,
            });

            expect(res.drugClass).toBe('controlled');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
        });

        it('should strictly BLOCK unlisted generic Tramadol formulations with hasActiveLinkedRx: true', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'B4-1122',
                drugName: 'Tramadol Hydrochloride 50mg Capsule',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true,
            });

            expect(res.drugClass).toBe('controlled');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
        });

        it('should strictly BLOCK Codeine formulations with hasActiveLinkedRx: true', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'B4-3344',
                drugName: 'Codeine Phosphate 30mg Tablet',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true,
            });

            expect(res.drugClass).toBe('controlled');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
        });

        it('should strictly BLOCK Morphine, Pentazocine, Fentanyl, Ketamine, and Benzodiazepines', () => {
            const drugs = ['Morphine 10mg', 'Pentazocine 30mg', 'Fentanyl 25mcg', 'Ketamine 50mg/ml', 'Diazepam 5mg'];
            for (const drug of drugs) {
                const res = nafdacVerificationService.verifyMedicine({
                    drugName: drug,
                    facilityLicenceClass: 'ppmv',
                    hasActiveLinkedRx: true,
                });
                expect(res.drugClass).toBe('controlled');
                expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
                expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
            }
        });
    });

    describe('2. Unlisted NAFDAC Numbers and Format Boundaries', () => {
        it('should classify unlisted registered format (B4-9988) alone as unverified_registry', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'B4-9988',
                facilityLicenceClass: 'ppmv',
            });

            expect(res.formatValid).toBe(true);
            expect(res.authenticityStatus).toBe('unverified_registry');
        });

        it('should classify arbitrary 2-char format (ZZ-0000) alone as unverified_registry', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'ZZ-0000',
                facilityLicenceClass: 'ppmv',
            });

            expect(res.formatValid).toBe(true);
            expect(res.authenticityStatus).toBe('unverified_registry');
        });

        it('should classify invalid format string (XYZ-123) alone as unregistered_or_invalid', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'XYZ-123',
                facilityLicenceClass: 'ppmv',
            });

            expect(res.formatValid).toBe(false);
            expect(res.authenticityStatus).toBe('unregistered_or_invalid');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_UNREGISTERED_OR_EXPIRED');
        });
    });

    describe('3. Adversarial Attack Scenarios (Vulnerability Verification)', () => {
        // Attack Vector 1: Unlisted NAFDAC number claiming a registered drug name
        it('VULNERABILITY TEST: Unlisted NAFDAC number B4-9988 with drugName Paracetamol MUST NOT be verified_authentic', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'B4-9988',
                drugName: 'Paracetamol',
                facilityLicenceClass: 'ppmv',
            });

            // According to the NAFDAC Registry Safety Rule:
            // "An unlisted NAFDAC registration number MUST NEVER receive 'verified' from LLM/fallback alone.
            // Only a deterministic registry hit can return 'verified'."
            // Since B4-9988 is NOT 04-0123 (Emzor Paracetamol), it should be 'unverified_registry'
            expect(res.authenticityStatus).toBe('unverified_registry');
        });

        // Attack Vector 2: Invalid NAFDAC format XYZ-123 with a registered drug name
        it('VULNERABILITY TEST: Invalid format XYZ-123 with drugName Paracetamol MUST be unregistered_or_invalid and BLOCKED', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'XYZ-123',
                drugName: 'Paracetamol',
                facilityLicenceClass: 'ppmv',
            });

            expect(res.formatValid).toBe(false);
            expect(res.authenticityStatus).toBe('unregistered_or_invalid');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_UNREGISTERED_OR_EXPIRED');
        });

        // Attack Vector 3: Invalid NAFDAC format INVALID-9999 with an unlisted OTC drug name
        it('VULNERABILITY TEST: Invalid format INVALID-9999 with drugName Vitamin C MUST be unregistered_or_invalid and BLOCKED', () => {
            const res = nafdacVerificationService.verifyMedicine({
                nafdacRegNo: 'INVALID-9999',
                drugName: 'Vitamin C 100mg',
                facilityLicenceClass: 'ppmv',
            });

            expect(res.formatValid).toBe(false);
            expect(res.authenticityStatus).toBe('unregistered_or_invalid');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_UNREGISTERED_OR_EXPIRED');
        });

        // Attack Vector 4: Controlled drug brand names bypassing counter gate
        it('VULNERABILITY TEST: Tramadol brand name Tramal 50mg with e-Rx MUST NOT be approved for PPMV OTC sale', () => {
            const res = nafdacVerificationService.verifyMedicine({
                drugName: 'Tramal 50mg',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true,
            });

            expect(res.drugClass).toBe('controlled');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
        });

        // Attack Vector 5: Combination controlled drug Co-codamol bypassing counter gate
        it('VULNERABILITY TEST: Codeine combination Co-codamol with e-Rx MUST NOT be approved for PPMV OTC sale', () => {
            const res = nafdacVerificationService.verifyMedicine({
                drugName: 'Co-codamol',
                facilityLicenceClass: 'ppmv',
                hasActiveLinkedRx: true,
            });

            expect(res.drugClass).toBe('controlled');
            expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
            expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
        });
    });
});
