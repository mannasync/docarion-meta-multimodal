import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MetaMultimodalScanner, getAuthHeaders } from '../MetaMultimodalScanner';

// ── Mock Helpers & Stubs ─────────────────────────────────────────────────────

const originalFetch = global.fetch;
const originalCreateObjectURL = global.URL.createObjectURL;
const originalRevokeObjectURL = global.URL.revokeObjectURL;

class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob) {
    this.result = `data:image/png;base64,mock_base64_data_for_${(blob as any).name || 'blob'}`;
    setTimeout(() => {
      if (this.onloadend) this.onloadend();
    }, 10);
  }
}

function createMockMediaStream() {
  const trackStopMock = jest.fn();
  const mockTrack = {
    stop: trackStopMock,
    kind: 'audio',
    enabled: true,
  };
  return {
    getTracks: () => [mockTrack],
    _trackStopMock: trackStopMock,
  };
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  stream: any;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(stream: any) {
    this.stream = stream;
    MockMediaRecorder.instances.push(this);
  }

  start(timeslice?: number) {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['mock audio chunks'], { type: 'audio/webm' }) });
    }
    if (this.onstop) {
      this.onstop();
    }
  }
}

describe('MetaMultimodalScanner Empirical Challenger Stress Suite', () => {
  let mockFetch: jest.Mock;
  let mockStream: ReturnType<typeof createMockMediaStream>;

  beforeAll(() => {
    (global as any).FileReader = MockFileReader;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    MockMediaRecorder.instances = [];

    global.URL.createObjectURL = jest.fn(() => 'blob:http://localhost/test-audio-uuid');
    global.URL.revokeObjectURL = jest.fn();

    mockFetch = jest.fn();
    global.fetch = mockFetch;

    (global as any).MediaRecorder = MockMediaRecorder;
    mockStream = createMockMediaStream();
    Object.defineProperty(global.navigator, 'mediaDevices', {
      value: {
        getUserMedia: jest.fn().mockResolvedValue(mockStream),
      },
      configurable: true,
      writable: true,
    });

    localStorage.clear();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    global.URL.createObjectURL = originalCreateObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. STRESS-TEST: CUSTOM INPUT STATE UPDATES & ENDPOINT PAYLOAD DISPATCH
  // ═══════════════════════════════════════════════════════════════════════════
  describe('1. Custom Input State Updates & API Payloads', () => {
    it('1.1 updates Tab 1 custom drug inputs, syncs visual preview card, and sends exact payload to /nafdac/verify', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            authenticityStatus: 'verified_authentic',
            productDetails: {
              nafdacRegNo: 'B2-9988',
              brandName: 'Amoxil 500mg',
              genericName: 'Amoxicillin',
              drugClass: 'pom',
            },
            ppmvCounterGate: {
              allowedAtPpmvCounter: true,
              statusBanner: 'APPROVED_FOR_PPMV_OTC_SALE',
              hasValidLinkedRx: true,
              actionableNextStep: 'Dispense under active physician e-Rx',
            },
          },
        }),
      });

      const onFindingsExtracted = jest.fn();
      render(
        <MetaMultimodalScanner
          consultationId="consult-test-101"
          facilityLicenceClass="ppmv"
          onFindingsExtracted={onFindingsExtracted}
        />
      );

      const regInput = screen.getByPlaceholderText('e.g. A4-0192 or 04-1928') as HTMLInputElement;
      const drugInput = screen.getByPlaceholderText('e.g. Coartem, Augmentin, Paracetamol') as HTMLInputElement;
      const rxCheckbox = screen.getByLabelText(/Active Physician e-Rx/i) as HTMLInputElement;

      expect(regInput.value).toBe('A4-0192');
      expect(drugInput.value).toBe('Coartem 20/120');
      expect(rxCheckbox.checked).toBe(false);

      // Mutate inputs with custom values
      fireEvent.change(regInput, { target: { value: 'B2-9988' } });
      fireEvent.change(drugInput, { target: { value: 'Amoxil 500mg' } });
      fireEvent.click(rxCheckbox);

      expect(regInput.value).toBe('B2-9988');
      expect(drugInput.value).toBe('Amoxil 500mg');
      expect(rxCheckbox.checked).toBe(true);

      // Verify the visual synthetic card preview reflects custom values
      expect(screen.getByText('B2-9988')).toBeInTheDocument();
      expect(screen.getByText('Amoxil 500mg')).toBeInTheDocument();

      // Click "Verify Drug Pack"
      const verifyBtn = screen.getByRole('button', { name: /Verify Drug Pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/ai-intake/nafdac/verify');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');

      const parsedBody = JSON.parse(options.body);
      expect(parsedBody).toEqual({
        nafdacRegNo: 'B2-9988',
        drugName: 'Amoxil 500mg',
        facilityLicenceClass: 'ppmv',
        hasActiveLinkedRx: true,
      });

      // Verify callback fired
      await waitFor(() => {
        expect(onFindingsExtracted).toHaveBeenCalledWith(
          expect.objectContaining({
            authenticityStatus: 'verified_authentic',
          })
        );
      });

      // Verify dynamic POM UNLOCKED badge renders
      await waitFor(() => {
        expect(screen.getByText('POM UNLOCKED (e-Rx)')).toBeInTheDocument();
      });
    });

    it('1.2 updates Tab 2 target modes, scale input, and sends payload to /vision/analyze', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            samSegmentation: {
              model: 'sam-3.1-modal-t4-gpu',
              planimetry: {
                areaCm2: 8.5,
                lengthCm: 3.2,
                widthCm: 2.7,
                suggestedStage: 'Stage II',
              },
              segments: [
                {
                  label: 'Ulcer Core',
                  confidence: 0.96,
                  bbox: [10, 15, 40, 50],
                  maskSvg: 'M10 15 L50 15 L50 65 L10 65 Z',
                },
              ],
            },
          },
        }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-vision-999"
          facilityLicenceClass="clinic"
        />
      );

      // Switch to Tab 2
      const tab2Btn = screen.getByRole('button', { name: /SAM 3\.1 Vision/i });
      fireEvent.click(tab2Btn);

      // Verify active mode selector pills
      const rdtPill = screen.getByRole('button', { name: /🔬 RDT Cassette/i });
      fireEvent.click(rdtPill);

      // Change scale calibration to 35mm
      const scaleInput = screen.getByRole('spinbutton') as HTMLInputElement;
      fireEvent.change(scaleInput, { target: { value: '35' } });
      expect(scaleInput.value).toBe('35');

      // Click Analyze with SAM 3.1
      const analyzeBtn = screen.getByRole('button', { name: /Analyze with SAM 3\.1/i });
      fireEvent.click(analyzeBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/ai-intake/vision/analyze');
      const parsedBody = JSON.parse(options.body);
      expect(parsedBody).toEqual({
        type: 'rdt_strip',
        imageBase64: 'placeholder_for_preset',
        referenceScaleMm: 35,
        consultationId: 'consult-vision-999',
        facilityLicenceClass: 'clinic',
      });

      // Verify both cm² and mm² planimetry metrics are rendered
      await waitFor(() => {
        expect(screen.getByText('8.5 cm²')).toBeInTheDocument();
        expect(screen.getByText('850 mm²')).toBeInTheDocument();
      });
    });

    it('1.3 updates Tab 3 custom dialogue, language select, stripNoise toggle, and sends payload to /call-diarize', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            turns: [
              {
                speaker: 'SPEAKER_DOCTOR',
                startSec: 0,
                endSec: 4.5,
                transcript: 'Ina kwana Mallam Musa?',
                scrubbedTranscript: 'Ina kwana Mallam [NAME_REDACTED]?',
              },
            ],
            phiInspection: { totalRedactions: 1, redactedCategories: ['NAME'] },
          },
        }),
      });

      render(
        <MetaMultimodalScanner
          consultationId="consult-hausa-42"
          facilityLicenceClass="hospital"
        />
      );

      // Switch to Tab 3
      const tab3Btn = screen.getByRole('button', { name: /2-Way Call Voice/i });
      fireEvent.click(tab3Btn);

      // Select Hausa language
      const langSelect = screen.getByRole('combobox') as HTMLSelectElement;
      fireEvent.change(langSelect, { target: { value: 'hausa' } });
      expect(langSelect.value).toBe('hausa');

      // Toggle off stripNoise checkbox
      const noiseCheckbox = screen.getByLabelText(/Strip Noise/i) as HTMLInputElement;
      expect(noiseCheckbox.checked).toBe(true);
      fireEvent.click(noiseCheckbox);
      expect(noiseCheckbox.checked).toBe(false);

      // Enter custom Hausa dialogue
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, {
        target: { value: 'Doctor: Sannu da aiki.\nPatient: Yauwa sannu.' },
      });

      // Run Diarization
      const runBtn = screen.getByRole('button', { name: /Run Diarization & Pre-LLM PHI Scrubbing/i });
      fireEvent.click(runBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/ai-intake/consult-hausa-42/call-diarize');
      const parsedBody = JSON.parse(options.body);
      expect(parsedBody).toEqual({
        dialogue: 'Doctor: Sannu da aiki.\nPatient: Yauwa sannu.',
        language: 'hausa',
        stripNoise: false,
      });
    });

    it('1.4 triggers onEscalateToDoctor when POM blocked medication is verified', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            authenticityStatus: 'verified_authentic',
            ppmvCounterGate: {
              allowedAtPpmvCounter: false,
              statusBanner: 'BLOCKED_POM_ESCALATE_TO_DOCTOR',
              actionableNextStep: 'Prescription-only medicine requires doctor consultation',
            },
          },
        }),
      });

      const onEscalateToDoctor = jest.fn();
      render(
        <MetaMultimodalScanner
          consultationId="consult-esc-1"
          facilityLicenceClass="ppmv"
          onEscalateToDoctor={onEscalateToDoctor}
        />
      );

      const verifyBtn = screen.getByRole('button', { name: /Verify Drug Pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('POM RESTRICTED')).toBeInTheDocument();
      });

      const escalateBtn = screen.getByRole('button', { name: /Escalate to On-Duty Doctor/i });
      fireEvent.click(escalateBtn);

      expect(onEscalateToDoctor).toHaveBeenCalledTimes(1);
      expect(onEscalateToDoctor).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticityStatus: 'verified_authentic',
        })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. STRESS-TEST: FILE UPLOAD BOUNDARY CONDITIONS & BASE64 CONVERSION
  // ═══════════════════════════════════════════════════════════════════════════
  describe('2. File Upload Boundary Conditions', () => {
    it('2.1 handles empty file input selection (user cancels file picker) without throwing or crashing', () => {
      const { container } = render(<MetaMultimodalScanner />);

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      // Trigger change with empty files array (simulating cancel)
      expect(() => {
        fireEvent.change(fileInput, { target: { files: [] } });
      }).not.toThrow();

      // Also trigger with null files
      expect(() => {
        fireEvent.change(fileInput, { target: { files: null } });
      }).not.toThrow();

      // Confirm no crash and default card still renders
      expect(screen.getByText('Coartem 20/120')).toBeInTheDocument();
    });

    it('2.2 converts uploaded image file to base64 and clears it when Clear Photo is clicked', async () => {
      const { container } = render(<MetaMultimodalScanner />);

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const mockFile = new File(['fake-png-binary-stream'], 'sample-pack.png', {
        type: 'image/png',
      });

      fireEvent.change(fileInput, { target: { files: [mockFile] } });

      // Wait for FileReader mock callback
      act(() => {
        jest.advanceTimersByTime(20);
      });

      await waitFor(() => {
        expect(screen.getByAltText('Drug pack preview')).toBeInTheDocument();
        expect(screen.getByText('Clear Photo')).toBeInTheDocument();
      });

      // Clear Photo
      const clearBtn = screen.getByText('Clear Photo');
      fireEvent.click(clearBtn);

      expect(screen.queryByAltText('Drug pack preview')).not.toBeInTheDocument();
      expect(screen.getByText('Upload / Capture Pack')).toBeInTheDocument();
    });

    it('2.3 captures network error or non-JSON 413 Payload Too Large response gracefully in error banner', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Payload Too Large: Entity length exceeds 10MB limit'));

      render(<MetaMultimodalScanner />);

      const verifyBtn = screen.getByRole('button', { name: /Verify Drug Pack/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText(/Payload Too Large: Entity length exceeds 10MB limit/i)).toBeInTheDocument();
      });

      // Dismiss error
      const dismissBtn = screen.getByRole('button', { name: '✕' });
      fireEvent.click(dismissBtn);

      expect(screen.queryByText(/Payload Too Large/i)).not.toBeInTheDocument();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. STRESS-TEST: MEDIARECORDER LIFECYCLE & AUDIO CAPTURE
  // ═══════════════════════════════════════════════════════════════════════════
  describe('3. MediaRecorder Lifecycle & Audio Capture', () => {
    it('3.1 manages complete recording cycle: start -> timer tick -> stop -> audio preview created', async () => {
      render(<MetaMultimodalScanner />);

      // Switch to Tab 3
      fireEvent.click(screen.getByRole('button', { name: /2-Way Call Voice/i }));

      const recordBtn = screen.getByRole('button', { name: /Record Live Audio/i });
      fireEvent.click(recordBtn);

      await waitFor(() => {
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
        expect(MockMediaRecorder.instances.length).toBe(1);
      });

      const recorder = MockMediaRecorder.instances[0];
      expect(recorder.state).toBe('recording');

      // Check recording UI appears with duration counter
      expect(screen.getByText(/Recording Active Call Audio/i)).toBeInTheDocument();
      expect(screen.getByText('00:00')).toBeInTheDocument();

      // Advance timer by 3 seconds
      act(() => {
        jest.advanceTimersByTime(3000);
      });

      expect(screen.getByText('00:03')).toBeInTheDocument();

      // Click Stop Recording
      const stopBtn = screen.getByRole('button', { name: /Stop Recording/i });
      fireEvent.click(stopBtn);

      expect(recorder.state).toBe('inactive');

      // Verify stream tracks were stopped
      expect(mockStream._trackStopMock).toHaveBeenCalled();

      // Advance timer for FileReader
      act(() => {
        jest.advanceTimersByTime(20);
      });

      // Verify audio player preview appears
      await waitFor(() => {
        expect(screen.getByText(/Recorded Microphone Preview/i)).toBeInTheDocument();
        expect(screen.getByText('Discard')).toBeInTheDocument();
      });

      // Discard audio
      const discardBtn = screen.getByText('Discard');
      fireEvent.click(discardBtn);

      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/test-audio-uuid');
      expect(screen.queryByText(/Recorded Microphone Preview/i)).not.toBeInTheDocument();
    });

    it('3.2 catches microphone access refusal/denial (NotAllowedError) and displays actionable error without crashing', async () => {
      (navigator.mediaDevices.getUserMedia as jest.Mock).mockRejectedValueOnce(
        new Error('Permission denied by user')
      );

      render(<MetaMultimodalScanner />);

      fireEvent.click(screen.getByRole('button', { name: /2-Way Call Voice/i }));

      const recordBtn = screen.getByRole('button', { name: /Record Live Audio/i });
      fireEvent.click(recordBtn);

      await waitFor(() => {
        expect(screen.getByText('Permission denied by user')).toBeInTheDocument();
      });

      // Verify isRecording remained false
      expect(screen.getByRole('button', { name: /Record Live Audio/i })).toBeInTheDocument();
    });

    it('3.3 handles unsupported browser environment (missing navigator.mediaDevices) gracefully', async () => {
      // Simulate non-secure HTTP or legacy browser
      Object.defineProperty(global.navigator, 'mediaDevices', {
        value: undefined,
        configurable: true,
      });

      render(<MetaMultimodalScanner />);

      fireEvent.click(screen.getByRole('button', { name: /2-Way Call Voice/i }));

      const recordBtn = screen.getByRole('button', { name: /Record Live Audio/i });
      fireEvent.click(recordBtn);

      await waitFor(() => {
        expect(
          screen.getByText(/Microphone access is not supported in this browser environment/i)
        ).toBeInTheDocument();
      });
    });

    it('3.4 cleans up active MediaRecorder and timer on component unmount', async () => {
      const { unmount } = render(<MetaMultimodalScanner />);

      fireEvent.click(screen.getByRole('button', { name: /2-Way Call Voice/i }));
      fireEvent.click(screen.getByRole('button', { name: /Record Live Audio/i }));

      await waitFor(() => {
        expect(MockMediaRecorder.instances.length).toBe(1);
      });

      const recorder = MockMediaRecorder.instances[0];
      expect(recorder.state).toBe('recording');

      // Unmount while recording
      unmount();

      // Verify recorder was stopped on unmount
      expect(recorder.state).toBe('inactive');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. STRESS-TEST: RAW VS PHI-SCRUBBED TRANSCRIPT TOGGLE
  // ═══════════════════════════════════════════════════════════════════════════
  describe('4. Raw vs PHI-Scrubbed Transcript Toggling', () => {
    const mockDiarizationPayload = {
      success: true,
      data: {
        model: 'meta-sam-audio-modal-gpu',
        turns: [
          {
            speaker: 'SPEAKER_DOCTOR',
            startSec: 0,
            endSec: 3.2,
            transcript: 'Good day Mama Chioma, wetin dey do you?',
            scrubbedTranscript: 'Good day Mama [NAME_REDACTED], wetin dey do you?',
          },
          {
            speaker: 'SPEAKER_PATIENT',
            startSec: 3.5,
            endSec: 8.0,
            transcript: 'Doctor my NIN is 2348012345678 and phone is 08031234567.',
            scrubbedTranscript: 'Doctor my NIN is [NIN_REDACTED] and phone is [PHONE_REDACTED].',
          },
        ],
        phiInspection: {
          totalRedactions: 3,
          redactedCategories: ['NAME', 'NIN', 'PHONE'],
        },
        extractedEntities: {
          symptoms: ['Fever', 'Body pain'],
          medications: [{ name: 'Paracetamol', dosage: '1g' }],
          diagnoses: ['Uncomplicated Malaria'],
          redFlags: [],
        },
      },
    };

    it('4.1 defaults to PHI-scrubbed transcript and toggles between scrubbed and raw unredacted text in turns display', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => mockDiarizationPayload,
      });

      render(<MetaMultimodalScanner consultationId="consult-phi-toggle" />);

      fireEvent.click(screen.getByRole('button', { name: /2-Way Call Voice/i }));
      fireEvent.click(
        screen.getByRole('button', { name: /Run Diarization & Pre-LLM PHI Scrubbing/i })
      );

      // Verify initial display is PHI-Scrubbed
      await waitFor(() => {
        expect(screen.getByText('Pre-LLM PHI: 3 PII items scrubbed')).toBeInTheDocument();
      });

      // Target the speaker turn text elements directly
      const turnParagraphs = screen.getAllByText((content, element) => {
        return element?.tagName.toLowerCase() === 'p' && content.includes('Doctor my NIN is');
      });
      expect(turnParagraphs.length).toBeGreaterThanOrEqual(1);
      const patientTurn = turnParagraphs[0];

      // In default view: scrubbed text is shown, unredacted NIN/Phone is hidden in the turn
      expect(patientTurn).toHaveTextContent('[NIN_REDACTED]');
      expect(patientTurn).toHaveTextContent('[PHONE_REDACTED]');
      expect(patientTurn).not.toHaveTextContent('2348012345678');
      expect(patientTurn).not.toHaveTextContent('08031234567');

      // Verify toggle button label
      const toggleBtn = screen.getByRole('button', { name: /PHI-Scrubbed/i });
      expect(toggleBtn).toBeInTheDocument();

      // CLICK TOGGLE -> Switch to Raw PII
      fireEvent.click(toggleBtn);

      // Raw PII should now be visible in the turn
      expect(patientTurn).toHaveTextContent('2348012345678');
      expect(patientTurn).toHaveTextContent('08031234567');
      expect(patientTurn).not.toHaveTextContent('[NIN_REDACTED]');

      // Verify button label switched
      expect(screen.getByRole('button', { name: /Raw PII \(Pre-Filter\)/i })).toBeInTheDocument();

      // CLICK TOGGLE AGAIN -> Switch back to PHI-Scrubbed
      fireEvent.click(screen.getByRole('button', { name: /Raw PII \(Pre-Filter\)/i }));

      expect(patientTurn).toHaveTextContent('[NIN_REDACTED]');
      expect(patientTurn).not.toHaveTextContent('2348012345678');
    });

    it('4.2 renders extracted clinical entities chips accurately', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => mockDiarizationPayload,
      });

      render(<MetaMultimodalScanner />);

      fireEvent.click(screen.getByRole('button', { name: /2-Way Call Voice/i }));
      fireEvent.click(
        screen.getByRole('button', { name: /Run Diarization & Pre-LLM PHI Scrubbing/i })
      );

      await waitFor(() => {
        expect(screen.getByText('Fever')).toBeInTheDocument();
        expect(screen.getByText('Body pain')).toBeInTheDocument();
        expect(screen.getByText('Paracetamol (1g)')).toBeInTheDocument();
        expect(screen.getByText('Uncomplicated Malaria')).toBeInTheDocument();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. STRESS-TEST: AUTH HEADERS HELPER & EMPIRICAL BUG VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════
  describe('5. getAuthHeaders Helper Resilience & Empirical Logic Edge Cases', () => {
    it('5.1 correctly retrieves token from auth-storage JSON in localStorage', () => {
      localStorage.setItem('auth-storage', JSON.stringify({ state: { token: 'jwt-auth-store-token' } }));
      const headers = getAuthHeaders();
      expect(headers['Authorization']).toBe('Bearer jwt-auth-store-token');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('5.2 falls back to accessToken when auth-storage key is absent', () => {
      localStorage.removeItem('auth-storage');
      localStorage.setItem('accessToken', 'fallback-access-token');
      const headers = getAuthHeaders();
      expect(headers['Authorization']).toBe('Bearer fallback-access-token');
    });

    it('5.3 EMPIRICAL FINDING: corrupted auth-storage JSON suppresses fallback to accessToken due to single outer try/catch', () => {
      // When auth-storage has malformed JSON, JSON.parse throws.
      // Because the outer try/catch encloses both JSON.parse AND the fallback check:
      // the fallback code is bypassed, returning no Authorization header.
      localStorage.setItem('auth-storage', 'CORRUPT_JSON{{{');
      localStorage.setItem('accessToken', 'fallback-access-token');

      const headers = getAuthHeaders();
      // Empirically documents that corrupted auth-storage bypasses fallback
      expect(headers['Authorization']).toBeUndefined();
    });

    it('5.4 returns base Content-Type header if no token is found', () => {
      localStorage.clear();
      const headers = getAuthHeaders();
      expect(headers).toEqual({ 'Content-Type': 'application/json' });
      expect(headers['Authorization']).toBeUndefined();
    });
  });
});
