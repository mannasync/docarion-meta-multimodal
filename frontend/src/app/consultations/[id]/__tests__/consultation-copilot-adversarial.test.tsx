/**
 * EMPIRICAL ADVERSARIAL CHALLENGER SUITE (Challenger 2 - Milestone 3)
 *
 * Scope of Empirical Adversarial Verification:
 * 1. Care Station (`frontend/src/app/care-station/page.tsx`):
 *    - Verify handleRunCopilotSync requests `/ai-intake/${targetId}/copilot-sync` (which with baseURL resolves to `/api/v1/ai-intake/...`).
 *    - Verify DDx rendering with likelihood badges (high=rose, medium=amber, low=emerald).
 *    - Verify red flag alerts filtering (high priority / alert type) and zero-alert fallback.
 *    - Verify vernacular summary rendering and copy-to-clipboard functionality.
 *    - Verify fallback behavior when activeSession/consultationId is absent or network throws.
 *
 * 2. Doctor Consultation Room (`frontend/src/app/consultations/[id]/page.tsx`):
 *    - Adversarial URL Path Challenge: empirical probe of `/api/v1/ai-intake/...` vs `/ai-intake/...` with Axios baseURL `/api/v1`.
 *    - Structured payload retention: verify differentials, suggestions, managementPlan, nafdacVerifiedRx, vernacularPatientSummary.
 *    - 1-Click adoption of DDx into SOAP assessment.
 *    - 1-Click adoption into e-Rx writer (+ Plan and Write e-Rx navigation).
 *    - 1-Click adoption of vernacular discharge instructions into patient discharge summary.
 */

import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import axios from 'axios';
import ConsultationDetailPage from '../page';
import CareStationPage from '@/app/care-station/page';
import { useAuthStore } from '@/store/auth.store';
import api, { consultationApi, doctorApi, aiIntakeApi, ehrApi, clinicalDocsApi, ddxApi } from '@/services/api';
import { toast } from 'react-toastify';

// ── Next.js Navigation Mocks ──────────────────────────────────────────────────
const mockReplace = jest.fn();
const mockPush = jest.fn();
let currentPathname = '/consultations/consult-test-101';

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: mockPush,
    back: jest.fn(),
  }),
  useParams: () => ({
    id: 'consult-test-101',
  }),
  usePathname: () => currentPathname,
  useSearchParams: () => ({
    get: (key: string) => (key === 'mode' ? 'assisted' : null),
  }),
}));

// ── Service & API Mocks ───────────────────────────────────────────────────────
jest.mock('@/services/api', () => {
  const mockApiInstance = {
    post: jest.fn(),
    get: jest.fn().mockResolvedValue({ data: { success: true } }),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  };

  return {
    __esModule: true,
    default: mockApiInstance,
    api: mockApiInstance,
    consultationApi: {
      getById: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue({ data: { success: true } }),
      addDiagnosis: jest.fn().mockResolvedValue({ data: { success: true } }),
      sendMessage: jest.fn().mockResolvedValue({ data: { success: true } }),
      addNote: jest.fn().mockResolvedValue({ data: { success: true } }),
    },
    doctorApi: {
      getById: jest.fn().mockResolvedValue({
        data: { success: true, data: { profile: { firstName: 'Chukwuma', lastName: 'Adebayo' } } },
      }),
    },
    patientApi: {
      addVitals: jest.fn().mockResolvedValue({ data: { success: true } }),
    },
    aiIntakeApi: {
      getStatus: jest.fn().mockResolvedValue({ data: { success: true, data: { isComplete: true } } }),
      getBrief: jest.fn().mockResolvedValue({ data: { success: true, data: { brief: {} } } }),
      careStationPatientLookup: jest.fn().mockResolvedValue({ data: { success: true, data: { patient: { fullName: 'Test Patient' } } } }),
      registerWalkIn: jest.fn().mockResolvedValue({ data: { success: true, data: { id: 'consult-walkin-888', code: 'WK-888' } } }),
      sendTerminalMessage: jest.fn().mockResolvedValue({ data: { success: true } }),
      getTerminalSession: jest.fn().mockResolvedValue({ data: { success: true, data: { messages: [] } } }),
      sendToDoctor: jest.fn().mockResolvedValue({ data: { success: true } }),
    },
    adminApi: {
      getCareStationConfig: jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: {
            careStationConfig: {
              enabled: true,
              assistedIntakeEnabled: true,
              kioskModeEnabled: true,
              allowedRoles: ['nurse', 'pharmacist', 'doctor', 'admin'],
            },
          },
        },
      }),
    },
    ehrApi: {
      getPatientRecords: jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: {
            patient: { profile: { firstName: 'Amara', lastName: 'Okafor', gender: 'female' } },
            medicalRecord: { allergies: ['Penicillin'] },
          },
        },
      }),
      getMedicalRecord: jest.fn().mockResolvedValue({
        data: { success: true, data: { allergies: ['Penicillin'] } },
      }),
    },
    clinicalDocsApi: {
      generateSoap: jest.fn().mockResolvedValue({
        data: { success: true, data: { note: { id: 'note-1', structured: {} } } },
      }),
      saveNote: jest.fn().mockResolvedValue({ data: { success: true } }),
      generateDischarge: jest.fn().mockResolvedValue({
        data: { success: true, data: { note: { id: 'disc-1', structured: {} } } },
      }),
    },
    ddxApi: {
      get: jest.fn(),
      compute: jest.fn(),
    },
  };
});

jest.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({
    socket: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
    connected: true,
    onReconnect: jest.fn().mockImplementation(() => () => {}),
  }),
}));

jest.mock('@/hooks/useOfflineTranscription', () => ({
  __esModule: true,
  default: () => ({
    isAvailable: true,
    isListening: false,
    transcript: '',
    start: jest.fn(),
    stop: jest.fn(),
    clear: jest.fn(),
  }),
}));

jest.mock('react-toastify', () => ({
  toast: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  },
}));

// Child component mocks
jest.mock('@/components/consultation/DoctorReadyPacketPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="doctor-ready-packet-panel">Doctor Ready Packet Panel</div>,
}));

jest.mock('@/components/consultation/LongitudinalSummaryCard', () => ({
  __esModule: true,
  default: () => <div data-testid="longitudinal-summary-card">Longitudinal Summary Card</div>,
}));

jest.mock('@/components/intake/PhysicianBrief', () => ({
  __esModule: true,
  default: () => <div data-testid="physician-brief-panel">Physician Brief Panel</div>,
}));

jest.mock('@/components/consultation/AIClinicalCopilot', () => ({
  __esModule: true,
  default: () => <div data-testid="ai-clinical-copilot">AI Clinical Copilot Panel</div>,
}));

jest.mock('@/components/chat/ConsultationChat', () => ({
  __esModule: true,
  default: () => <div data-testid="consultation-chat-component">Consultation Chat</div>,
}));

jest.mock('@/components/RatingSheet', () => ({
  __esModule: true,
  default: () => <div data-testid="rating-sheet-component">Rating Sheet</div>,
}));

jest.mock('@/components/ai/MetaMultimodalScanner', () => ({
  __esModule: true,
  MetaMultimodalScanner: () => <div data-testid="meta-multimodal-scanner">Meta Multimodal Scanner</div>,
}));

jest.mock('@/components/layout/DashboardShell', () => ({
  __esModule: true,
  DashboardShell: ({ children, title, actions }: any) => (
    <div data-testid="dashboard-shell">
      <div data-testid="dashboard-title">{title}</div>
      <div data-testid="dashboard-actions">{actions}</div>
      {children}
    </div>
  ),
}));

// ── Auth Store Mock ───────────────────────────────────────────────────────────
jest.mock('@/store/auth.store', () => {
  const mockPersist = {
    hasHydrated: jest.fn().mockReturnValue(true),
    onFinishHydration: jest.fn().mockImplementation((cb) => {
      cb();
      return () => {};
    }),
  };

  const store = {
    user: null,
    isAuthenticated: true,
    isLoading: false,
    setUser: jest.fn((u) => {
      store.user = u;
      store.isAuthenticated = !!u;
    }),
  };

  const useAuthStoreMock = (selector?: any) => {
    if (typeof selector === 'function') {
      return selector(store);
    }
    return store;
  };
  useAuthStoreMock.getState = () => store;
  useAuthStoreMock.setState = (partial: any) => {
    Object.assign(store, typeof partial === 'function' ? partial(store) : partial);
  };
  useAuthStoreMock.persist = mockPersist;

  return {
    useAuthStore: useAuthStoreMock,
  };
});

// ── Mock Copilot Data Payload ─────────────────────────────────────────────────
const mockCopilotPayload = {
  consultationId: 'consult-test-101',
  differentials: [
    {
      name: 'Plasmodium falciparum Malaria',
      likelihood: 'high',
      reasoning: 'High-grade fever with chills and endemic exposure.',
    },
    {
      name: 'Enteric (Typhoid) Fever',
      likelihood: 'medium',
      reasoning: 'Prolonged step-ladder fever and abdominal tenderness.',
    },
    {
      name: 'Viral Upper Respiratory Infection',
      likelihood: 'low',
      reasoning: 'Mild nasal congestion without focal chest findings.',
    },
  ],
  suggestions: [
    {
      type: 'alert',
      title: 'High Temperature Spike (39.5°C)',
      detail: 'Rule out cerebral malaria or severe bacterial sepsis.',
      priority: 'high',
    },
    {
      type: 'question',
      title: 'Previous Antimalarial Intake',
      detail: 'Ask if patient took Artemether-Lumefantrine within the last 14 days.',
      priority: 'medium',
    },
  ],
  soapDraft: {
    subjective: 'Patient reports 3-day history of high fever, rigors, and severe headaches.',
    objective: 'Temp 39.5°C, HR 105 bpm, BP 118/76 mmHg. Mild splenomegaly.',
    assessment: 'Acute Uncomplicated Malaria (B50.9)',
    plan: 'Initiate Artemether-Lumefantrine oral regimen. Push oral fluids.',
  },
  managementPlan: 'Artemisinin combination therapy with oral rehydration.',
  nafdacVerifiedRx: [
    {
      drugName: 'Coartem (Artemether/Lumefantrine 20/120mg)',
      dose: '4 tablets stat, then 4 at 8h, then 4 twice daily for 2 days',
      duration: '3 days',
      drugClass: 'otc',
      nafdacStatus: 'Verified (A4-0192)',
    },
    {
      drugName: 'Paracetamol 500mg',
      dose: '2 tablets 8-hourly for fever',
      duration: '3 days',
      drugClass: 'otc',
      nafdacStatus: 'Verified (04-1234)',
    },
  ],
  vernacularPatientSummary:
    'Take 4 tablets of Coartem with fatty food now, 4 tablets after 8 hours, and 4 tablets twice daily for the next two days. Mix ORS with clean water and drink plenty fluids. If fever no go down after 3 days, return to clinic quick quick.',
};

describe('EMPIRICAL ADVERSARIAL CHALLENGER: Clinical Co-Pilot Verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuthStore.getState() as any).setUser({
      userId: 'usr-doc-404',
      role: 'doctor',
      email: 'doctor@docarion.test',
      phone: '+2348000000002',
      profile: { firstName: 'Dr. Chidi', lastName: 'Eze' },
      contractSigned: true,
      facilityId: 'hosp-001',
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUITE 1: Care Station (`frontend/src/app/care-station/page.tsx`)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Suite 1: Care Station Clinical Co-Pilot Verification', () => {
    async function setupCareStationSession() {
      render(<CareStationPage />);

      await waitFor(() => {
        expect(screen.getByTestId('assisted-phone-input')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('assisted-phone-input'), {
        target: { value: '+2348012345678' },
      });
      fireEvent.change(screen.getByTestId('assisted-name-input'), {
        target: { value: 'Amaka Obi' },
      });

      fireEvent.click(screen.getByTestId('assisted-lookup-submit-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('launch-terminal-doctor-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('launch-terminal-doctor-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('muse-wonder-copilot-panel')).toBeInTheDocument();
      });
    }

    it('1.1 verifies handleRunCopilotSync correctly calls /ai-intake/${targetId}/copilot-sync with structured intake payload', async () => {
      (api.post as jest.Mock).mockResolvedValueOnce({
        data: { success: true, data: mockCopilotPayload },
      });

      await setupCareStationSession();

      const runCopilotBtn = screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i });
      expect(runCopilotBtn).toBeInTheDocument();

      fireEvent.click(runCopilotBtn);

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledWith(
          '/ai-intake/consult-walkin-888/copilot-sync',
          expect.objectContaining({
            language: 'en',
            intakeHistory: expect.any(String),
            vitals: expect.any(Object),
          })
        );
      });

      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('Meta Muse Wonder Co-Pilot synced')
      );
    });

    it('1.2 verifies DDx rendering with likelihood indicators, red flag alerts, and vernacular summary in Care Station', async () => {
      (api.post as jest.Mock).mockResolvedValueOnce({
        data: { success: true, data: mockCopilotPayload },
      });

      await setupCareStationSession();

      fireEvent.click(screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i }));

      // 1. Verify Top 3 DDx rendered
      await waitFor(() => {
        expect(screen.getByText('Plasmodium falciparum Malaria')).toBeInTheDocument();
        expect(screen.getByText('Enteric (Typhoid) Fever')).toBeInTheDocument();
        expect(screen.getByText('Viral Upper Respiratory Infection')).toBeInTheDocument();
      });

      // Verify likelihood badges
      const highBadge = screen.getByText('high');
      expect(highBadge).toBeInTheDocument();
      expect(highBadge.className).toContain('text-rose-400');

      const medBadge = screen.getByText('medium');
      expect(medBadge).toBeInTheDocument();
      expect(medBadge.className).toContain('text-amber-400');

      const lowBadge = screen.getByText('low');
      expect(lowBadge).toBeInTheDocument();
      expect(lowBadge.className).toContain('text-emerald-400');

      // 2. Verify Red Flag Alert rendered
      expect(screen.getByText(/High Temperature Spike \(39.5°C\):/i)).toBeInTheDocument();
      expect(screen.getByText(/Rule out cerebral malaria or severe bacterial sepsis/i)).toBeInTheDocument();

      // 3. Verify Vernacular Summary rendered
      expect(screen.getByText(new RegExp(mockCopilotPayload.vernacularPatientSummary.slice(0, 30), 'i'))).toBeInTheDocument();

      // 4. Verify Clipboard Copy
      const mockClipboardWrite = jest.fn();
      Object.assign(navigator, {
        clipboard: { writeText: mockClipboardWrite },
      });

      const copyBtn = screen.getByRole('button', { name: /Copy Instructions/i });
      fireEvent.click(copyBtn);
      expect(mockClipboardWrite).toHaveBeenCalledWith(mockCopilotPayload.vernacularPatientSummary);
      expect(toast.success).toHaveBeenCalledWith('Copied Vernacular Discharge Instructions!');
    });

    it('1.3 verifies fallback behavior when activeSession/consultationId is absent or network fails', async () => {
      // 1.3a: Absent activeSession - returns without throwing or calling api.post
      render(<CareStationPage />);

      await waitFor(() => {
        expect(screen.getByTestId('assisted-phone-input')).toBeInTheDocument();
      });

      // Prior to starting intake session, copilot panel is not rendered
      expect(screen.queryByTestId('muse-wonder-copilot-panel')).not.toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining('/copilot-sync'), expect.anything());

      // 1.3b: Network failure handling
      (api.post as jest.Mock).mockRejectedValueOnce(new Error('Network connection timeout'));

      fireEvent.change(screen.getByTestId('assisted-phone-input'), { target: { value: '+2348012345678' } });
      fireEvent.click(screen.getByTestId('assisted-lookup-submit-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('launch-terminal-doctor-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('launch-terminal-doctor-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('muse-wonder-copilot-panel')).toBeInTheDocument();
      });

      const runCopilotBtn = screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i });
      fireEvent.click(runCopilotBtn);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to sync with Muse Wonder Co-Pilot')
        );
      });

      expect(runCopilotBtn).not.toBeDisabled();
      expect(screen.queryByText(/Synthesizing clinical intake/i)).not.toBeInTheDocument();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUITE 2: Doctor Consultation Room (`frontend/src/app/consultations/[id]/page.tsx`)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Suite 2: Doctor Consultation Room Clinical Co-Pilot Verification', () => {
    const mockConsultation = {
      consultationId: 'consult-test-101',
      patientId: 'patient-test-001',
      doctorId: 'usr-doc-404',
      type: 'video',
      status: 'in_progress',
      symptoms: ['Fever', 'Headache', 'Joint Pain'],
      intakeCompleted: true,
      scheduledAt: new Date().toISOString(),
    };

    beforeEach(() => {
      (consultationApi.getById as jest.Mock).mockResolvedValue({
        data: { success: true, data: mockConsultation },
      });
    });

    it('2.1 ADVERSARIAL CHALLENGE: Proves that consultations/[id]/page.tsx line 591 prepends redundant /api/v1 prefix causing double-prefix resolution', () => {
      // In frontend/src/services/api.ts, the axios instance has baseURL: '/api/v1'.
      // An Axios instance prepends baseURL to all relative request paths.
      const testAxiosInstance = axios.create({ baseURL: '/api/v1' });

      // Path in care-station/page.tsx line 618: '/ai-intake/123/copilot-sync'
      const careStationResolvedUri = testAxiosInstance.getUri({ url: '/ai-intake/123/copilot-sync' });
      expect(careStationResolvedUri).toBe('/api/v1/ai-intake/123/copilot-sync');

      // Path in consultations/[id]/page.tsx line 591: '/api/v1/ai-intake/123/copilot-sync'
      const consultationResolvedUri = testAxiosInstance.getUri({ url: '/api/v1/ai-intake/123/copilot-sync' });
      expect(consultationResolvedUri).toBe('/api/v1/api/v1/ai-intake/123/copilot-sync');

      // Concrete defect proof: the path sent to the backend has duplicate '/api/v1/api/v1'
      expect(consultationResolvedUri).not.toBe('/api/v1/ai-intake/123/copilot-sync');
    });

    it('2.2 verifies handleCopilotSync retains full structured payload in copilotData state', async () => {
      (api.post as jest.Mock).mockResolvedValueOnce({
        data: { success: true, data: mockCopilotPayload },
      });

      render(<ConsultationDetailPage />);

      // Switch to Chart Notes tab
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Chart Notes/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /Chart Notes/i }));

      await waitFor(() => {
        expect(screen.getByText(/Meta Muse Wonder Clinical Co-Pilot/i)).toBeInTheDocument();
      });

      // Click "Run Muse Wonder Co-Pilot" button
      const syncBtn = screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i });
      fireEvent.click(syncBtn);

      await waitFor(() => {
        expect(api.post).toHaveBeenCalled();
      });

      // Verify that all structured elements are rendered and retained
      await waitFor(() => {
        expect(screen.getByText('Plasmodium falciparum Malaria')).toBeInTheDocument();
        expect(screen.getByText(/High Temperature Spike \(39.5°C\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Coartem \(Artemether\/Lumefantrine 20\/120mg\)/i)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(mockCopilotPayload.vernacularPatientSummary.slice(0, 30), 'i'))).toBeInTheDocument();
      });
    });

    it('2.3 verifies 1-click adoption of DDx into SOAP assessment', async () => {
      (api.post as jest.Mock).mockResolvedValueOnce({
        data: { success: true, data: mockCopilotPayload },
      });

      render(<ConsultationDetailPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Chart Notes/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /Chart Notes/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i }));

      // Wait for DDx cards to appear
      await waitFor(() => {
        expect(screen.getByText('Plasmodium falciparum Malaria')).toBeInTheDocument();
      });

      // Find the "+ Adopt into Assessment" button
      const adoptAssessmentBtns = screen.getAllByRole('button', { name: /\+ Adopt into Assessment/i });
      expect(adoptAssessmentBtns.length).toBeGreaterThan(0);

      // Click to adopt the first differential
      fireEvent.click(adoptAssessmentBtns[0]);

      // Check success toast
      expect(toast.success).toHaveBeenCalledWith(
        'Adopted Plasmodium falciparum Malaria into SOAP Assessment!'
      );

      // Check that the assessment textarea contains the adopted DDx
      const assessmentTextarea = screen.getByPlaceholderText(/Assessment \/ Diagnosis\.\.\./i) as HTMLTextAreaElement;
      expect(assessmentTextarea.value).toContain('• Plasmodium falciparum Malaria (Likelihood: HIGH): High-grade fever with chills');
    });

    it('2.4 verifies 1-click adoption into e-Rx writer (+ Plan and Write e-Rx navigation)', async () => {
      (api.post as jest.Mock).mockResolvedValueOnce({
        data: { success: true, data: mockCopilotPayload },
      });

      render(<ConsultationDetailPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Chart Notes/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /Chart Notes/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i }));

      await waitFor(() => {
        expect(screen.getByText(/Coartem \(Artemether\/Lumefantrine 20\/120mg\)/i)).toBeInTheDocument();
      });

      // 1. Test "+ Plan" button
      const addPlanBtns = screen.getAllByRole('button', { name: /\+ Plan/i });
      fireEvent.click(addPlanBtns[0]);

      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('Added Coartem (Artemether/Lumefantrine 20/120mg) to Plan!')
      );

      const planTextarea = screen.getByPlaceholderText(/Plan of care\.\.\./i) as HTMLTextAreaElement;
      expect(planTextarea.value).toContain('• Rx: Coartem (Artemether/Lumefantrine 20/120mg)');

      // 2. Test "Write e-Rx" navigation button
      const writeRxBtns = screen.getAllByRole('button', { name: /Write e-Rx/i });
      fireEvent.click(writeRxBtns[0]);

      expect(mockPush).toHaveBeenCalledWith(
        `/prescriptions/write?consultationId=consult-test-101&med=${encodeURIComponent(
          'Coartem (Artemether/Lumefantrine 20/120mg)'
        )}`
      );
    });

    it('2.5 verifies 1-click adoption of vernacular discharge instructions into patient discharge summary', async () => {
      (api.post as jest.Mock).mockResolvedValueOnce({
        data: { success: true, data: mockCopilotPayload },
      });

      render(<ConsultationDetailPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Chart Notes/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /Chart Notes/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Run Muse Wonder Co-Pilot/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Adopt into Discharge Summary/i })).toBeInTheDocument();
      });

      // 1. Click "Adopt into Discharge Summary" inside Co-Pilot card
      const adoptSummaryBtn = screen.getByRole('button', { name: /Adopt into Discharge Summary/i });
      fireEvent.click(adoptSummaryBtn);

      expect(toast.success).toHaveBeenCalledWith(
        '✨ Adopted Vernacular Summary into Discharge Instructions!'
      );

      // Verify the patient-friendly textarea in the discharge summary card is populated
      const dischargeTextarea = screen.getByText(/Patient-friendly version/i).nextElementSibling as HTMLTextAreaElement;
      expect(dischargeTextarea.value).toBe(mockCopilotPayload.vernacularPatientSummary);

      // 2. Also verify "Adopt Muse Wonder Instructions" in the Discharge Summary header
      const headerAdoptBtn = screen.getByRole('button', { name: /Adopt Muse Wonder Instructions/i });
      expect(headerAdoptBtn).toBeInTheDocument();
      fireEvent.click(headerAdoptBtn);

      expect(toast.success).toHaveBeenCalledWith(
        '✨ Adopted Muse Wonder Vernacular Instructions!'
      );
      expect(dischargeTextarea.value).toBe(mockCopilotPayload.vernacularPatientSummary);
    });
  });
});
