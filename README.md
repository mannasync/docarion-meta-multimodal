# Docarion — Meta Multimodal Clinical Intelligence & Support Engine
> **Cerebral Valley × Meta Global AI Developer Hackathon (Startups Track — Team #468)**
> - **Live Production Platform:** [https://docarion.com](https://docarion.com) ([Login](https://docarion.com/auth/login))
> - **Dedicated Judge Login:** `judge@docarion.clinic` | **Password:** `Password123!`
> - **Pre-Seeded Judge Consultation Room:** [https://docarion.com/consultations/consult-meta-judge-demo](https://docarion.com/consultations/consult-meta-judge-demo)
> - **3-Minute Judge Walkthrough Video:** [https://www.youtube.com/watch?v=-dXTo4Eb28M](https://www.youtube.com/watch?v=-dXTo4Eb28M)
> - **Public Launch Post on X:** [https://x.com/silverpenydr/status/2117309534528028848](https://x.com/silverpenydr/status/2117309534528028848)

---

## 👨‍⚕️ Founding Team & Clinical Leadership (`Team #468 — Docarion`)

- **Dr. Godswill Olemgbe, MBBS** — Founder & CEO ([@evidencechecked](https://x.com/evidencechecked))
- **Dr. Ayotomiwa Ayilola, MBBS** — Co-Founder & CMO ([@silverpenydr](https://x.com/silverpenydr))
- **Yusuf Alani Olayode** — Co-Founder & CTO ([@Doctware](https://x.com/Doctware))
- **Divya** — Co-Founder & Docarion Central Admin ([@KunnujiC](https://x.com/KunnujiC)) — Leads Docarion Central Command, `<10-minute` SLA queue dispatch, assisted patient phone-desk scheduling, and facility network administration.
- **Official Brand & Partner Inquiries:** [@docarion_hq](https://x.com/docarion_hq) · [https://docarion.com](https://docarion.com)

---

## ⚡ What Was Newly Built During This Hackathon (Startup Track Rule 4 Disclosure)

While Docarion provides the underlying multi-facility EMR foundation, **100% of the Meta AI clinical intelligence, history-taking, diagnosis support, and multi-role care-line support systems** in this repository and demonstrated in our walkthrough video were built from scratch during the hackathon across **three core pillars**:

### 1. Adaptive AI History-Taking & Longitudinal Fixed-History Engine (`Meta Muse Spark` + `Meta SAM 3.1`)
- **Concise 3-Turn Adaptive Symptom Intake (`backend/src/services/ai-intake.service.ts`, `intake-history.service.ts`):** Plain-language conversational history-taking across English, Nigerian Pidgin (`pcm`), Hausa, Yoruba, and Igbo that adapts to patient literacy while enforcing a strict zero-leak boundary (differential diagnoses never leak into patient chat).
- **Once-Only Longitudinal Fixed History Editor (`frontend/src/components/patient/FixedHistoryEditor.tsx`):** Permanently stores static history domains (`allergies`, `medications`, `pastMedical`, `pastSurgical`, `familyHistory`, `socialHistory`) so returning patients are never re-asked baseline questions.
- **2-Hour Incomplete Session Resumption & Two-Phase Doctor Notifications:** Automatically resumes incomplete check-ins within 2 hours and dispatches two-phase alerts (`history_started` → `ready_to_claim`) to on-duty doctors.
- **Multimodal Intake & Care-Station Scanning (`Meta SAM 3.1` on Modal T4 GPU):** Zero-shot pixel segmentation for Malaria RDT strips (`rdt_strip`), calibrated wound planimetry (`wound`, cm²), pre-OCR paper lab header redaction (`lab_sheet`), and NAFDAC drug packaging verification (`drug_pack`).

### 2. Clinical Diagnosis, Differential (`DDx`) & Auto-SOAP Decision Support System (`Meta Muse Wonder`)
- **Pre-Claim Physician Brief (`PhysicianBrief.tsx`):** Synthesizes a 15-second clinical brief (HPI, red flags, vitals, allergies, and SAM 3.1 findings) directly on the telehealth queue row before a doctor claims the visit.
- **Live In-Chat Clinical Co-Pilot (`[data-testid="live-chat-ai-copilot-card"]`):** Continuously reads preliminary AI history, nurse vitals, and live doctor-patient conversation to generate:
  1. **Ranked ICD-10 Differential Diagnoses (`DDx`)** with 1-click adoption into the chart (`+ Adopt DDx into SOAP`).
  2. **On-the-Spot Chat Guidance & Red-Flag Prompts** with 1-click insertion into chat (`💬 Ask in Chat`).
  3. **NAFDAC-Verified Treatment Suggestions & WHO AWaRe Antibiotic Stewardship Alerts** with 1-click plan adoption.
  4. **Grounded 4-Part Auto-SOAP Note Synthesis (`S`, `O`, `A`, `P`)** with live refresh and save.
- **Flexible e-Prescription Dosing Engine:** Supports `fixed`, `variable`, `tapering`, `prn`, and `range` regimens with automated quantity calculation.

### 3. Multi-Role Care-Line Support, Talk-Through AI Assistant & Call Diarization (`Meta MMS-1B` + `Muse Spark`)
- **Stage-Scoped Care-Line Conversation Tunnel (`ConsultationChat.tsx`):** Least-privilege episode channels (`clinical`, `nurse`, `pharmacy`, `delivery`) with open/pause/close controls and seamless in-call Audio/Video/Chat modality switching.
- **Floating Talk-Through AI Support Assistant (`AICopilotFloatingPill.tsx`, `DashboardAIAssistant.tsx`):** Context-aware lower-right AI assistant deployed across all 9 facility dashboards (Care Homes, Clinics, Hospitals, Pharmacies, PPMVs, Diagnostic Labs, Radiology Centers, and Customer Care / Phone Desk) plus staff-assisted phone-line visit scheduling.
- **2-Way Call Audio Diarization & Multilingual ASR (`Meta MMS-1B` + `Pyannote 3.1` on Modal GPU):** Separates `SPEAKER_DOCTOR` and `SPEAKER_PATIENT` audio across English, Nigerian Pidgin, Hausa, Yoruba, and Igbo directly into the consultation EHR.

---

## 🏗️ Repository Structure

```text
├── ARCHITECTURE.md                                     # System architecture & model routing diagram
├── backend/
│   └── src/
│       ├── routes/
│       │   └── ai-intake.routes.ts                     # REST endpoints for intake, SAM 3.1, NAFDAC, diarization & Muse Wonder Co-Pilot
│       └── services/
│           ├── ai-core.service.ts                      # Multi-provider Meta Model API / Baseten / Modal router + SHA-256 cache
│           ├── ai-intake.service.ts                    # Adaptive multilingual history-taking & Pre-Claim Physician Brief
│           ├── ai-copilot.service.ts                   # Muse Wonder DDx, Red-Flag, WHO AWaRe & Auto-SOAP synthesis
│           ├── sam-vision.service.ts                   # Meta SAM 3.1 ROI segmentation & calibrated wound planimetry
│           ├── nafdac-verification.service.ts          # Deterministic NAFDAC registry lookup & PCN PPMV scope gatekeeper
│           ├── call-voice-diarization.service.ts       # Meta MMS-1B + Pyannote 3.1 2-way clinical audio diarization
│           ├── live-scribe-asr.service.ts              # Real-time consultation ASR & transcription pipeline
│           ├── drug-class.service.ts                   # OTC / POM / Controlled substance classification engine
│           ├── phi-scrubber.service.ts                 # 14-category Nigerian PHI/PII pre-LLM redaction engine
│           └── __tests__/                              # Automated unit & adversarial clinical safety test suites
├── frontend/
│   └── src/
│       └── components/
│           └── ai/
│               ├── MetaMultimodalScanner.tsx           # Interactive web scanner for NAFDAC, SAM 3.1 & 2-Way Diarization
│               └── AICopilotDrawer.tsx                 # Clinician Muse Wonder Co-Pilot & Talk-Through AI Assistant
├── mobile/
│   └── apps/
│       ├── patient/app/
│       │   ├── intake.tsx                              # Mobile patient adaptive AI intake & longitudinal history
│       │   └── scan.tsx                                # Mobile patient NAFDAC & SAM 3.1 camera scanner
│       └── pro/app/
│           └── care-station.tsx                        # Mobile Pro Care-Station kiosk & nurse/PPMV scanner
└── scripts/
    ├── modal_meta_open_weights.py                      # Modal Serverless T4 GPU deployment for Meta SAM 3.1 & MMS-1B
    ├── setup-hackathon-providers.sh                    # Live endpoint health & provider verification script
    └── verify-meta-hackathon-live.ts                   # End-to-end live verification across all 4 Meta models
```

---

## 🧪 Quick Verification & Judge Testing

### 1. Instant Browser Testing (No Local Setup Required)
1. Open [https://docarion.com/auth/login](https://docarion.com/auth/login)
2. Sign in with the dedicated Judge Physician account:
   - **Email:** `judge@docarion.clinic`
   - **Password:** `Password123!`
3. Navigate directly to the pre-hydrated consultation room:
   - [https://docarion.com/consultations/consult-meta-judge-demo](https://docarion.com/consultations/consult-meta-judge-demo)
4. Test the **Live In-Chat Muse Wonder Co-Pilot** (`+ Adopt DDx into SOAP`, `💬 Ask in Chat`, `Adopt Plan`, `🔄 Refresh SOAP`), the **Meta Multimodal Clinical Scanner** (`NAFDAC & PCN Gate`, `SAM 3.1 Planimetry`, `2-Way Call Voice Diarization`), and the **Stage-Scoped Care-Line Tunnel** (`🩺 Doctor`, `👩‍⚕️ Nurse`, `💊 Pharmacy`, `🚚 Delivery`).

### 2. Automated Verification Suite
```bash
# Run live verification across Meta Muse Spark, Muse Wonder, SAM 3.1 (Modal GPU), and MMS-1B
npx ts-node scripts/verify-meta-hackathon-live.ts
```
