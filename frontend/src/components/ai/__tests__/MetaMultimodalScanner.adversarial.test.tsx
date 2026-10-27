import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
  MetaMultimodalScanner,
  getAuthHeaders,
  SAMSegment,
} from '../MetaMultimodalScanner';

describe('Milestone 2 Challenger 2: MetaMultimodalScanner Adversarial Verification', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    global.fetch = jest.fn();

    // Mock URL object methods for jsdom
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = jest.fn(() => 'blob:mock-audio-url');
    }
    if (!window.URL.revokeObjectURL) {
      window.URL.revokeObjectURL = jest.fn();
    }
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  // =========================================================================
  // SUITE 1: NAFDAC & PCN Gate UI States
  // =========================================================================
  describe('Suite 1: NAFDAC & PCN Gate UI States & Authenticity Banners', () => {
    it('1.1 renders OTC PERMITTED badge and Proceed with Counter Sale button when APPROVED_FOR_PPMV_OTC_SALE (standard OTC)', async () => {
      const mockOtcResult = {
        nafdacRegNo: 'A4-0192',
        authenticityStatus: 'verified_authentic',
        drugClass: 'otc',
        productDetails: {
          brandName: 'Coartem 20/120',
          genericName: 'Artemether / Lumefantrine',
          drugClass: 'otc',
          nafdacRegNo: 'A4-0192',
          manufacturer: 'Novartis Pharma',
        },
        ppmvCounterGate: {
          allowedAtPpmvCounter: true,
          requiresActiveDoctorRx: false,
          hasValidLinkedRx: false,
          statusBanner: 'APPROVED_FOR_PPMV_OTC_SALE',
          actionableNextStep: 'Verified authentic medicine. Permitted for PPMV counter sale.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockOtcResult }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-test-1"
          facilityLicenceClass="ppmv"
        />
      );

      // Trigger verification via preset or verify button
      const verifyBtn = screen.getByRole('button', { name: /verify drug pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('OTC PERMITTED')).toBeInTheDocument();
      });

      // Verify badge styling and green status icon
      const otcBadge = screen.getByText('OTC PERMITTED');
      expect(otcBadge.className).toContain('text-emerald-300');

      // Verify actionable text
      expect(
        screen.getByText('Verified authentic medicine. Permitted for PPMV counter sale.')
      ).toBeInTheDocument();

      // Verify Counter Sale button is present
      expect(
        screen.getByRole('button', { name: /proceed with counter sale \(otc\)/i })
      ).toBeInTheDocument();

      // Escalation button should NOT be present
      expect(
        screen.queryByRole('button', { name: /escalate to on-duty doctor/i })
      ).not.toBeInTheDocument();

      // Unverified registry banner should NOT be present
      expect(
        screen.queryByText(/not found in nafdac registry/i)
      ).not.toBeInTheDocument();
    });

    it('1.2 renders POM UNLOCKED (e-Rx) badge when APPROVED_FOR_PPMV_OTC_SALE with active linked e-Rx', async () => {
      const mockPomUnlockedResult = {
        nafdacRegNo: '04-1928',
        authenticityStatus: 'verified_authentic',
        drugClass: 'pom',
        productDetails: {
          brandName: 'Augmentin 625mg',
          genericName: 'Amoxicillin + Clavulanic Acid',
          drugClass: 'pom',
          awareCategory: 'Access',
          nafdacRegNo: '04-1928',
        },
        ppmvCounterGate: {
          allowedAtPpmvCounter: true,
          requiresActiveDoctorRx: true,
          hasValidLinkedRx: true,
          statusBanner: 'APPROVED_FOR_PPMV_OTC_SALE',
          actionableNextStep: 'POM sale unlocked by valid linked physician telehealth prescription.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockPomUnlockedResult }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-test-2"
          facilityLicenceClass="ppmv"
        />
      );

      // Check the e-Rx checkbox
      const rxCheckbox = screen.getByRole('checkbox', {
        name: /active physician e-rx/i,
      });
      fireEvent.click(rxCheckbox);
      expect(rxCheckbox).toBeChecked();

      // Trigger verification
      const verifyBtn = screen.getByRole('button', { name: /verify drug pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('POM UNLOCKED (e-Rx)')).toBeInTheDocument();
      });

      const pomUnlockedBadge = screen.getByText('POM UNLOCKED (e-Rx)');
      expect(pomUnlockedBadge.className).toContain('text-emerald-300');

      // OTC PERMITTED badge should NOT be rendered when unlocked by e-Rx
      expect(screen.queryByText('OTC PERMITTED')).not.toBeInTheDocument();

      // Counter sale action allowed
      expect(
        screen.getByRole('button', { name: /proceed with counter sale \(otc\)/i })
      ).toBeInTheDocument();
    });

    it('1.3 renders POM RESTRICTED badge when BLOCKED_POM_ESCALATE_TO_DOCTOR (POM without e-Rx)', async () => {
      const mockPomBlockedResult = {
        nafdacRegNo: '04-1928',
        authenticityStatus: 'verified_authentic',
        drugClass: 'pom',
        productDetails: {
          brandName: 'Augmentin 625mg',
          genericName: 'Amoxicillin + Clavulanic Acid',
          drugClass: 'pom',
          awareCategory: 'Access',
          nafdacRegNo: '04-1928',
        },
        ppmvCounterGate: {
          allowedAtPpmvCounter: false,
          requiresActiveDoctorRx: true,
          hasValidLinkedRx: false,
          statusBanner: 'BLOCKED_POM_ESCALATE_TO_DOCTOR',
          actionableNextStep:
            'Prescription-Only Medicine (POM / WHO AWaRe). PCN rules prohibit PPMV sale without a doctor order. 1-click escalate to on-duty physician for telehealth e-Prescription.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockPomBlockedResult }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-test-3"
          facilityLicenceClass="ppmv"
        />
      );

      const verifyBtn = screen.getByRole('button', { name: /verify drug pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('POM RESTRICTED')).toBeInTheDocument();
      });

      const pomRestrictedBadge = screen.getByText('POM RESTRICTED');
      expect(pomRestrictedBadge.className).toContain('text-amber-300');

      // Escalation button MUST be present
      expect(
        screen.getByRole('button', { name: /escalate to on-duty doctor/i })
      ).toBeInTheDocument();

      // Proceed with counter sale button MUST NOT be present
      expect(
        screen.queryByRole('button', { name: /proceed with counter sale \(otc\)/i })
      ).not.toBeInTheDocument();
    });

    it('1.4 renders CONTROLLED SUBSTANCE badge when BLOCKED_CONTROLLED_SUBSTANCE', async () => {
      const mockControlledResult = {
        nafdacRegNo: '04-8899',
        authenticityStatus: 'verified_authentic',
        drugClass: 'controlled',
        productDetails: {
          brandName: 'Tramadol HCl 100mg',
          genericName: 'Tramadol',
          drugClass: 'controlled',
          nafdacRegNo: '04-8899',
        },
        ppmvCounterGate: {
          allowedAtPpmvCounter: false,
          requiresActiveDoctorRx: true,
          hasValidLinkedRx: false,
          statusBanner: 'BLOCKED_CONTROLLED_SUBSTANCE',
          actionableNextStep:
            'NDLEA & NAFDAC Controlled Substance. Strictly prohibited from counter sale.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockControlledResult }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-test-4"
          facilityLicenceClass="ppmv"
        />
      );

      const verifyBtn = screen.getByRole('button', { name: /verify drug pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('CONTROLLED SUBSTANCE')).toBeInTheDocument();
      });

      const controlledBadge = screen.getByText('CONTROLLED SUBSTANCE');
      expect(controlledBadge.className).toContain('text-rose-300');

      // Escalation button MUST be present
      expect(
        screen.getByRole('button', { name: /escalate to on-duty doctor/i })
      ).toBeInTheDocument();

      // Proceed with counter sale button MUST NOT be present
      expect(
        screen.queryByRole('button', { name: /proceed with counter sale \(otc\)/i })
      ).not.toBeInTheDocument();
    });

    it('1.5 renders unverified registry warning banner when authenticityStatus === "unverified_registry"', async () => {
      const mockUnverifiedResult = {
        nafdacRegNo: 'B2-9999',
        authenticityStatus: 'unverified_registry',
        drugClass: 'otc',
        productDetails: {
          brandName: 'Custom Generic Paracetamol',
          genericName: 'Paracetamol 500mg',
          drugClass: 'otc',
          nafdacRegNo: 'B2-9999',
        },
        ppmvCounterGate: {
          allowedAtPpmvCounter: true,
          requiresActiveDoctorRx: false,
          hasValidLinkedRx: false,
          statusBanner: 'APPROVED_FOR_PPMV_OTC_SALE',
          actionableNextStep:
            'Not found in NAFDAC registry — manual pharmacist verification required. Permitted for PPMV OTC counter sale.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockUnverifiedResult }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-test-5"
          facilityLicenceClass="ppmv"
        />
      );

      const verifyBtn = screen.getByRole('button', { name: /verify drug pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(
          screen.getByText('⚠️ Not found in NAFDAC registry — manual pharmacist verification required')
        ).toBeInTheDocument();
      });

      // Still renders OTC PERMITTED since drugClass is OTC
      expect(screen.getByText('OTC PERMITTED')).toBeInTheDocument();
    });

    it('1.6 suppresses unverified registry banner when authenticityStatus === "verified_authentic"', async () => {
      const mockVerifiedResult = {
        nafdacRegNo: 'A4-0192',
        authenticityStatus: 'verified_authentic',
        drugClass: 'otc',
        ppmvCounterGate: {
          allowedAtPpmvCounter: true,
          requiresActiveDoctorRx: false,
          hasValidLinkedRx: false,
          statusBanner: 'APPROVED_FOR_PPMV_OTC_SALE',
          actionableNextStep: 'Verified authentic medicine.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockVerifiedResult }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-test-6"
          facilityLicenceClass="ppmv"
        />
      );

      const verifyBtn = screen.getByRole('button', { name: /verify drug pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('OTC PERMITTED')).toBeInTheDocument();
      });

      expect(
        screen.queryByText(/not found in nafdac registry/i)
      ).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // SUITE 2: SAM 3.1 Vision & SVG Planimetry
  // =========================================================================
  describe('Suite 2: SAM 3.1 Vision & SVG Planimetry', () => {
    it('2.1 renders SVG with viewBox="0 0 100 100", correct percentage bounding box coordinates, and label positioning', async () => {
      const mockVisionResult = {
        samSegmentation: {
          model: 'Meta SAM 3.1 • Modal T4 GPU',
          targetMode: 'wound',
          segments: [
            {
              label: 'wound_bed',
              confidence: 0.94,
              bbox: [0.25, 0.25, 0.5, 0.5], // normalized 0..1
              maskSvg: 'M 25 50 Q 50 25 75 50 Q 50 75 25 50 Z',
              areaPercentage: 25.0,
            },
            {
              label: 'granulation_tissue',
              confidence: 0.89,
              bbox: [0.32, 0.32, 0.36, 0.36], // normalized 0..1
              areaPercentage: 13.0,
            },
          ],
          privacyDeidentified: true,
          backgroundMasked: true,
          headerStripRedacted: false,
          planimetry: {
            lengthCm: 4.0,
            widthCm: 3.8,
            areaCm2: 12.0,
            suggestedStage: 'stage_3',
            granulatingPct: 65,
            sloughyPct: 25,
            necroticPct: 10,
          },
          telemetry: {
            latencyMs: 340,
            endpoint: 'modal-gpu',
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockVisionResult }),
      });

      const { container } = render(
        <MetaMultimodalScanner
          consultationId="consult-vision-1"
          facilityLicenceClass="clinic"
        />
      );

      // Switch to SAM 3.1 Vision tab
      const visionTab = screen.getByRole('button', {
        name: /sam 3\.1 vision & planimetry/i,
      });
      fireEvent.click(visionTab);

      // Trigger vision analysis
      const analyzeBtn = screen.getByRole('button', {
        name: /analyze with sam 3\.1/i,
      });
      fireEvent.click(analyzeBtn);

      await waitFor(() => {
        expect(screen.getByText(/SAM 3\.1 Cutaneous Planimetry/i)).toBeInTheDocument();
      });

      // 1. Verify SVG viewBox
      const svg = container.querySelector('svg[viewBox="0 0 100 100"]');
      expect(svg).toBeInTheDocument();
      expect(svg?.getAttribute('preserveAspectRatio')).toBe('none');

      // 2. Verify rects for wound_bed: 0.25 -> 25, 0.5 -> 50
      const rects = container.querySelectorAll('svg rect');
      expect(rects.length).toBe(2);

      const woundRect = rects[0];
      expect(woundRect.getAttribute('x')).toBe('25');
      expect(woundRect.getAttribute('y')).toBe('25');
      expect(woundRect.getAttribute('width')).toBe('50');
      expect(woundRect.getAttribute('height')).toBe('50');

      // 3. Verify text label and confidence
      const texts = container.querySelectorAll('svg text');
      expect(texts.length).toBe(2);
      expect(texts[0].textContent).toContain('wound_bed (94%)');
      expect(texts[0].getAttribute('x')).toBe('26'); // x + 1 = 25 + 1 = 26
      expect(texts[0].getAttribute('y')).toBe('23.5'); // Math.max(25 - 1.5, 4) = 23.5

      // 4. Verify rects for granulation_tissue: 0.32 -> 32, 0.36 -> 36
      const granRect = rects[1];
      expect(granRect.getAttribute('x')).toBe('32');
      expect(granRect.getAttribute('y')).toBe('32');
      expect(granRect.getAttribute('width')).toBe('36');
      expect(granRect.getAttribute('height')).toBe('36');
      expect(texts[1].textContent).toContain('granulation_tissue (89%)');
    });

    it('2.2 correctly handles raw percentage coordinates (>1) and clamps text y for top-edge boxes', async () => {
      const mockEdgeResult = {
        samSegmentation: {
          model: 'Meta SAM 3.1 • Modal T4 GPU',
          targetMode: 'rdt_strip',
          segments: [
            {
              label: 'top_edge_box',
              confidence: 0.99,
              bbox: [10, 0, 80, 20], // Already percentage coordinates (>1), y = 0
              areaPercentage: 16.0,
            },
          ],
          telemetry: { endpoint: 'modal-gpu' },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEdgeResult }),
      });

      const { container } = render(
        <MetaMultimodalScanner consultationId="consult-vision-edge" />
      );

      fireEvent.click(screen.getByRole('button', { name: /sam 3\.1 vision/i }));
      fireEvent.click(screen.getByRole('button', { name: /analyze with sam 3\.1/i }));

      await waitFor(() => {
        expect(container.querySelector('svg rect')).toBeInTheDocument();
      });

      const rect = container.querySelector('svg rect');
      expect(rect?.getAttribute('x')).toBe('10');
      expect(rect?.getAttribute('y')).toBe('0');
      expect(rect?.getAttribute('width')).toBe('80');
      expect(rect?.getAttribute('height')).toBe('20');

      // For y = 0, y - 1.5 = -1.5. Math.max(-1.5, 4) MUST clamp to 4!
      const text = container.querySelector('svg text');
      expect(text?.getAttribute('y')).toBe('4');
      expect(text?.textContent).toContain('top_edge_box (99%)');
    });

    it('2.3 renders SVG mask <path> elements with accurate path data', async () => {
      const mockMaskResult = {
        samSegmentation: {
          model: 'Meta SAM 3.1 • Modal T4 GPU',
          targetMode: 'rdt_strip',
          segments: [
            {
              label: 'rdt_cassette',
              confidence: 0.98,
              bbox: [0.3, 0.1, 0.4, 0.8],
              maskSvg: 'M 30 10 L 70 10 L 70 90 L 30 90 Z',
              areaPercentage: 32.0,
            },
            {
              label: 'control_line_c',
              confidence: 0.96,
              bbox: [0.42, 0.38, 0.16, 0.04],
              // no maskSvg
              areaPercentage: 0.64,
            },
          ],
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockMaskResult }),
      });

      const { container } = render(
        <MetaMultimodalScanner consultationId="consult-mask-test" />
      );

      fireEvent.click(screen.getByRole('button', { name: /sam 3\.1 vision/i }));
      fireEvent.click(screen.getByRole('button', { name: /analyze with sam 3\.1/i }));

      await waitFor(() => {
        expect(container.querySelector('svg[viewBox="0 0 100 100"]')).toBeInTheDocument();
      });

      // Exactly 1 mask path inside the SAM 3.1 overlay SVG (viewBox="0 0 100 100")
      const overlaySvg = container.querySelector('svg[viewBox="0 0 100 100"]');
      expect(overlaySvg).toBeInTheDocument();
      const maskPaths = overlaySvg?.querySelectorAll('path') || [];
      expect(maskPaths.length).toBe(1);
      expect(maskPaths[0].getAttribute('d')).toBe('M 30 10 L 70 10 L 70 90 L 30 90 Z');
      expect(maskPaths[0].getAttribute('fill')).toBe('rgba(99, 102, 241, 0.25)');
    });

    it('2.4 calculates and displays planimetry metrics in both cm² and mm² (areaCm2 * 100)', async () => {
      const mockPlanimetryResult = {
        samSegmentation: {
          model: 'Meta SAM 3.1 • Modal T4 GPU',
          targetMode: 'wound',
          segments: [],
          planimetry: {
            lengthCm: 4.5,
            widthCm: 3.2,
            areaCm2: 11.3,
            suggestedStage: 'stage_3',
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockPlanimetryResult }),
      });

      render(<MetaMultimodalScanner consultationId="consult-planimetry-test" />);

      fireEvent.click(screen.getByRole('button', { name: /sam 3\.1 vision/i }));
      fireEvent.click(screen.getByRole('button', { name: /analyze with sam 3\.1/i }));

      await waitFor(() => {
        expect(screen.getAllByText(/11\.3\s*cm²/i).length).toBeGreaterThanOrEqual(1);
      });

      // 11.3 * 100 = 1130 mm²
      expect(screen.getByText('1130 mm²')).toBeInTheDocument();
      expect(screen.getByText('4.5 × 3.2 cm')).toBeInTheDocument();
      expect(screen.getByText(/stage_3/i)).toBeInTheDocument();
    });

    it('2.5 accurately renders Model Engine badges for Modal GPU vs Local Offline Fallback', async () => {
      // 1. Modal GPU model
      const mockModalGpuResult = {
        samSegmentation: {
          model: 'Meta SAM 3.1 • Modal T4 GPU',
          telemetry: { endpoint: 'modal-gpu' },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockModalGpuResult }),
      });

      render(
        <MetaMultimodalScanner consultationId="consult-model-test" />
      );

      fireEvent.click(screen.getByRole('button', { name: /sam 3\.1 vision/i }));
      fireEvent.click(screen.getByRole('button', { name: /analyze with sam 3\.1/i }));

      await waitFor(() => {
        expect(screen.getAllByText(/Meta SAM 3\.1 • Modal T4 GPU/i).length).toBeGreaterThanOrEqual(1);
      });

      // 2. Local Offline Fallback model
      const mockFallbackResult = {
        samSegmentation: {
          model: 'Local Geometric Estimate — Offline Fallback',
          telemetry: { endpoint: 'local-engine' },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockFallbackResult }),
      });

      fireEvent.click(screen.getByRole('button', { name: /analyze with sam 3\.1/i }));

      await waitFor(() => {
        expect(
          screen.getAllByText(/Local Geometric Estimate — Offline Fallback/i).length
        ).toBeGreaterThanOrEqual(1);
      });
    });

    it('2.6 renders header strip redaction banner when headerStripRedacted is true', async () => {
      const mockLabResult = {
        samSegmentation: {
          model: 'Meta SAM 3.1 • Modal T4 GPU',
          targetMode: 'lab_sheet',
          headerStripRedacted: true,
          segments: [],
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockLabResult }),
      });

      render(<MetaMultimodalScanner consultationId="consult-lab-test" />);

      fireEvent.click(screen.getByRole('button', { name: /sam 3\.1 vision/i }));
      fireEvent.click(screen.getByRole('button', { name: /analyze with sam 3\.1/i }));

      await waitFor(() => {
        expect(
          screen.getByText('🔒 [HEADER STRIP REDACTED — ZERO PATIENT PII TRANSMITTED]')
        ).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // SUITE 3: Doctor Escalation Trigger
  // =========================================================================
  describe('Suite 3: Doctor Escalation Trigger & Action Buttons', () => {
    it('3.1 fires onEscalateToDoctor with complete scanResult when POM is blocked and user clicks escalate', async () => {
      const handleEscalate = jest.fn();

      const mockBlockedPom = {
        nafdacRegNo: '04-1928',
        authenticityStatus: 'verified_authentic',
        drugClass: 'pom',
        productDetails: {
          brandName: 'Augmentin 625mg',
          genericName: 'Amoxicillin + Clavulanic Acid',
          drugClass: 'pom',
        },
        ppmvCounterGate: {
          allowedAtPpmvCounter: false,
          requiresActiveDoctorRx: true,
          hasValidLinkedRx: false,
          statusBanner: 'BLOCKED_POM_ESCALATE_TO_DOCTOR',
          actionableNextStep: 'Prescription-Only Medicine. 1-click escalate to doctor.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockBlockedPom }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-esc-1"
          facilityLicenceClass="ppmv"
          onEscalateToDoctor={handleEscalate}
        />
      );

      const verifyBtn = screen.getByRole('button', { name: /verify drug pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('POM RESTRICTED')).toBeInTheDocument();
      });

      const escalateBtn = screen.getByRole('button', {
        name: /escalate to on-duty doctor/i,
      });
      expect(escalateBtn).toBeInTheDocument();

      fireEvent.click(escalateBtn);

      expect(handleEscalate).toHaveBeenCalledTimes(1);
      expect(handleEscalate).toHaveBeenCalledWith(mockBlockedPom);
    });

    it('3.2 does not crash if onEscalateToDoctor callback is undefined', async () => {
      const mockBlockedControlled = {
        ppmvCounterGate: {
          allowedAtPpmvCounter: false,
          statusBanner: 'BLOCKED_CONTROLLED_SUBSTANCE',
          actionableNextStep: 'Controlled Substance.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockBlockedControlled }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-esc-no-prop"
          facilityLicenceClass="ppmv"
          // onEscalateToDoctor omitted
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /verify drug pack/i }));

      await waitFor(() => {
        expect(screen.getByText('CONTROLLED SUBSTANCE')).toBeInTheDocument();
      });

      const escalateBtn = screen.getByRole('button', {
        name: /escalate to on-duty doctor/i,
      });

      // Should not throw when clicked
      expect(() => fireEvent.click(escalateBtn)).not.toThrow();
    });

    it('3.3 hides doctor escalation button when item is allowed at counter (allowedAtPpmvCounter: true)', async () => {
      const mockAllowedOtc = {
        ppmvCounterGate: {
          allowedAtPpmvCounter: true,
          statusBanner: 'APPROVED_FOR_PPMV_OTC_SALE',
          actionableNextStep: 'Permitted for counter sale.',
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockAllowedOtc }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-no-esc"
          facilityLicenceClass="ppmv"
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /verify drug pack/i }));

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /proceed with counter sale \(otc\)/i })
        ).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('button', { name: /escalate to on-duty doctor/i })
      ).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // SUITE 4: Interactive Preset Execution, Auth Headers & Diarization
  // =========================================================================
  describe('Suite 4: Interactive Preset Execution & Diarization Flow', () => {
    it('4.1 getAuthHeaders() extracts Bearer token from auth-storage or localStorage token keys', () => {
      // 1. Zustand persisted storage
      localStorage.setItem(
        'auth-storage',
        JSON.stringify({ state: { token: 'jwt-zustand-token-xyz' } })
      );
      expect(getAuthHeaders()['Authorization']).toBe('Bearer jwt-zustand-token-xyz');

      // 2. Direct accessToken fallback
      localStorage.removeItem('auth-storage');
      localStorage.setItem('accessToken', 'jwt-access-token-123');
      expect(getAuthHeaders()['Authorization']).toBe('Bearer jwt-access-token-123');

      // 3. Direct token fallback
      localStorage.removeItem('accessToken');
      localStorage.setItem('token', 'jwt-token-456');
      expect(getAuthHeaders()['Authorization']).toBe('Bearer jwt-token-456');

      // 4. No token in storage
      localStorage.removeItem('token');
      expect(getAuthHeaders()['Authorization']).toBeUndefined();
    });

    it('4.2 1-click preset triggers Augmentin and updates form state fields and API call', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            nafdacRegNo: '04-1928',
            ppmvCounterGate: {
              allowedAtPpmvCounter: false,
              statusBanner: 'BLOCKED_POM_ESCALATE_TO_DOCTOR',
            },
          },
        }),
      });

      render(<MetaMultimodalScanner facilityLicenceClass="ppmv" />);

      const augmentinPresetBtn = screen.getByRole('button', {
        name: /augmentin 625mg/i,
      });
      fireEvent.click(augmentinPresetBtn);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/v1/ai-intake/nafdac/verify',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"nafdacRegNo":"04-1928"'),
          })
        );
      });

      // State inputs updated
      expect(screen.getByDisplayValue('04-1928')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Augmentin 625mg')).toBeInTheDocument();
    });

    it('4.3 Tab 3 2-Way Call Diarization toggles between PHI-scrubbed transcript and raw PII', async () => {
      const mockDiarizeResult = {
        turns: [
          {
            speaker: 'SPEAKER_DOCTOR',
            startSec: 0,
            endSec: 4.5,
            transcript: 'Good morning Mama Chioma, wetin dey do you today?',
            scrubbedTranscript: 'Good morning Mama Chioma, wetin dey do you today?',
          },
          {
            speaker: 'SPEAKER_PATIENT',
            startSec: 5.0,
            endSec: 12.0,
            transcript:
              'My body dey hot, NIN na 2348012345678 and phone 08031234567.',
            scrubbedTranscript:
              'My body dey hot, NIN na [NIN_REDACTED] and phone [PHONE_REDACTED].',
          },
        ],
        phiInspection: {
          totalRedactions: 2,
        },
        extractedEntities: {
          symptoms: ['Fever', 'Chills'],
          medications: ['Coartem 20/120'],
          diagnoses: ['Uncomplicated Malaria'],
          redFlags: ['High fever > 3 days'],
        },
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockDiarizeResult }),
      });

      render(<MetaMultimodalScanner consultationId="consult-diarize-1" />);

      // Navigate to Call Diarize tab
      fireEvent.click(
        screen.getByRole('button', { name: /2-way call voice segregation/i })
      );

      // Run diarization
      fireEvent.click(
        screen.getByRole('button', { name: /run diarization/i })
      );

      await waitFor(() => {
        expect(screen.getByText(/Pre-LLM PHI: 2 PII items scrubbed/i)).toBeInTheDocument();
      });

      // Default: PHI-scrubbed transcript is displayed in speaker turn
      expect(screen.getByText(/\[NIN_REDACTED\]/i)).toBeInTheDocument();
      expect(screen.getByText(/\[PHONE_REDACTED\]/i)).toBeInTheDocument();

      // Click toggle button to view Raw PII
      const toggleBtn = screen.getByRole('button', { name: /phi-scrubbed/i });
      fireEvent.click(toggleBtn);

      // Now Raw PII toggle button changes to Raw PII (Pre-Filter) and raw transcript is rendered in speaker turn
      expect(screen.getByText('Raw PII (Pre-Filter)')).toBeInTheDocument();
      expect(screen.getAllByText(/2348012345678/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/08031234567/i).length).toBeGreaterThanOrEqual(1);

      // Extracted entity chips verified
      expect(screen.getByText('Fever')).toBeInTheDocument();
      expect(screen.getByText('Chills')).toBeInTheDocument();
      expect(screen.getByText('Coartem 20/120')).toBeInTheDocument();
      expect(screen.getByText('Uncomplicated Malaria')).toBeInTheDocument();
      expect(screen.getByText('High fever > 3 days')).toBeInTheDocument();
    });
  });
});
