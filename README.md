# Docarion — Meta Multimodal Clinical Intelligence & Support Engine
> **Cerebral Valley × Meta Global AI Developer Hackathon (Startups Track — Team #468)**
> - **🔑 Direct Judge Sign-In Page (Start Here First):** **[https://docarion.com/auth/login](https://docarion.com/auth/login)**
> - **👨‍⚕️ Dedicated Judge Credentials:** **Email:** `judge@docarion.clinic` | **Password:** `Password123!`
> - **🩺 Pre-Seeded Judge Consultation Room (Open After Logging In):** **[https://docarion.com/consultations/consult-meta-judge-demo](https://docarion.com/consultations/consult-meta-judge-demo)**
> - **🗣️ Bilingual Pidgin & English Symptom Intake (Open After Logging In):** **[https://docarion.com/symptom-checker](https://docarion.com/symptom-checker)**
> - **🎬 3-Minute Judge Walkthrough Video:** **[https://www.youtube.com/watch?v=-dXTo4Eb28M](https://www.youtube.com/watch?v=-dXTo4Eb28M)**
> - **🌐 Public Pre-Launch & Pioneer Partner Portal:** [https://docarion.com](https://docarion.com)

---

## 🔑 Judge Quick-Start: How to Log In & Test Live (`https://docarion.com/auth/login`)

> **⚠️ Important Note for Judges:** Our public root homepage (`https://docarion.com`) is currently in **Pre-Launch Waitlist & Pioneer Partner LOI Mode** for the general public and does **not** display a public login button on the homepage. **Please use the direct Judge Sign-In URL below to log directly into the live production clinical platform:**

### Step 1 — Log In at the Direct Sign-In Page
1. Open **[https://docarion.com/auth/login](https://docarion.com/auth/login)** in your browser.
2. Enter the dedicated Judge credentials in the **Email** and **Password** fields:
   - **Email:** `judge@docarion.clinic`
   - **Password:** `Password123!`
3. Click **"Sign In Securely"**.
   - *MFA and clinical credential checks are pre-verified for all Judge and Demo accounts—you will land immediately on the **Physician Clinical Command Center** (`https://docarion.com/dashboard/doctor`).*

### Step 2 — Open the Pre-Seeded Judge Consultation Room
Once logged in as `judge@docarion.clinic`, click or paste this direct room link:
- **[https://docarion.com/consultations/consult-meta-judge-demo](https://docarion.com/consultations/consult-meta-judge-demo)** *(Patient: Chioma Okafor — Walk-in Escalation)*
- Inside this live consultation room, you can immediately test:
  1. **Pre-Claim Physician Brief & Longitudinal Fixed History Editor (`📋 Overview` tab):** View the 15-second synthesized HPI, red-flag checks, and the Once-Only Longitudinal Fixed History Editor (`allergies`, `medications`, `pastMedical`, `pastSurgical`, `familyHistory`, `socialHistory`).
  2. **Live In-Chat Meta Muse Wonder Clinical Co-Pilot (`💬 Chat` tab):** Click **"Run Muse Wonder Co-Pilot"** (or send a chat message) to see real-time:
     - **Ranked ICD-10 Differential Diagnoses (`DDx`)** with 1-click **`+ Adopt DDx into SOAP`**
     - **On-the-Spot Follow-Up & Red-Flag Prompts** with 1-click **`💬 Ask in Chat`**
     - **NAFDAC-Verified Treatment Suggestions & WHO AWaRe Antibiotic Stewardship Alerts**
     - **Grounded 4-Part Auto-SOAP Note Synthesis (`S`, `O`, `A`, `P`)**
  3. **Meta Multimodal AI Scanner (`🔬 Meta AI Scanner (SAM 3.1)` tab):**
     - **Tab 1 (`Medicine Pack Check — NAFDAC Authenticity & PCN Gatekeeper`):** Uses **Meta SAM 3.1 + Meta Muse Spark OCR** to scan **any** medication carton, blister pack, bottle, or sachet, isolate the NAFDAC registration panel, batch number, and expiry date, and validate original vs. counterfeit medications against NAFDAC's verification registry/API pipeline while enforcing PCN OTC vs. Prescription-Only Medicine (`POM`) dispensing scope and 1-click telehealth physician escalation *(includes 1-click quick-test examples like `Coartem ACT`, `Augmentin 625mg`, and `Ciprotab 500mg` plus live camera/photo upload for any medication)*.
     - **Tab 2 (`SAM 3.1 Clinical Vision — Remote Lesion/Wound Sizing, Point-of-Care Rapid Tests & Universal Lab/Medical Report Intake`):** A **general-purpose zero-shot clinical visual intake engine** on **Modal Serverless NVIDIA T4 GPUs** (`~450ms`) enabling pharmacists in local medicine stores, nurses, lab techs, and patients to capture **any** physical finding or diagnostic artifact with our in-app camera for remote physician review *(the 3 UI preset buttons are provided purely as 1-click examples; the scanner accepts any uploaded or camera-captured clinical image)*:
       - **Camera-Calibrated Cutaneous Lesion, Blister, Rash & Wound Sizing (`mm` / `mm²` / `cm²` Planimetry):** In remote telehealth, a flat photo alone cannot tell a distant doctor whether a skin lesion, blister, abscess, burn, rash, or ulcer is `4 mm` or `4 cm`, or whether it is shrinking or expanding. By capturing the finding through our camera with **Meta SAM 3.1** pixel boundary isolation and millimeter reference-scale calibration, Docarion calculates realistic estimated physical dimensions (`length × width` in `cm` and surface area in `mm²` / `cm²`) plus tissue-bed breakdown—sizing any cutaneous or anatomical finding accurately for the remote reviewing physician.
       - **Any Point-of-Care Rapid Diagnostic Test (RDT) & Strip/Meter Capture:** Captures **any** rapid test performed at local pharmacies/PPMVs, clinics, or home (*e.g., Malaria, HIV, Hepatitis B/C, Syphilis, Typhoid, Pregnancy hCG, Urine Dipsticks, Glucometer readouts, etc.*), isolating Control (`C`) and Test (`T`) bands/readouts for objective doctor verification.
       - **Any Paper Laboratory Result, Diagnostic Report & Clinical Document Intake:** Captures **any** printed or handwritten lab result sheet, external hospital/diagnostic report, ultrasound/ECG summary, or referral slip—using **Meta SAM 3.1** to automatically detect and mask out patient-identifying demographic header strips (`[HEADER STRIP REDACTED]`) before **Meta Muse Spark** digitizes results into structured `LOINC`-coded clinical tables for the physician.
     - **Tab 3 (`2-Way Call Voice`):** Run **Meta MMS-1B + Pyannote 3.1** 2-way bilingual (`English` + `Naija Pidgin`) doctor-patient call audio diarization (`SPEAKER_DOCTOR` vs. `SPEAKER_PATIENT`) with a live Pre-LLM Nigerian PHI Scrubbing Receipt.

### Step 3 — Test the Bilingual Pidgin & Multilingual Symptom Intake
While logged in (as `judge@docarion.clinic` or `patient1@docarion.clinic`), open:
- **[https://docarion.com/symptom-checker](https://docarion.com/symptom-checker)**
- Click the **`Naija Pidgin`** prompt chip (or type in English, Nigerian Pidgin, Hausa, Yoruba, or Igbo) to test our concise 3-turn adaptive symptom intake powered by **Meta Muse Spark Open (`meta-models/muse-spark-open-1026` on Baseten)** with strict zero-leak patient safety guardrails.

---

## 🧪 Complete Verified Multi-Role Judge & Demo Credentials (`100% Live Verified`)

To test any of the 10 clinical, pharmacy, community medicine store (PPMV), lab, radiology, care home, or patient workflows, log in at **[https://docarion.com/auth/login](https://docarion.com/auth/login)** using the universal password **`Password123!`**:

| Role / Facility Persona | Login Email (at `https://docarion.com/auth/login`) | Password | Post-Login Dashboard URL | Key Meta AI & Multimodal Features to Test |
| :--- | :--- | :--- | :--- | :--- |
| **Dedicated Hackathon Judge (Doctor)** | `judge@docarion.clinic` | `Password123!` | `/dashboard/doctor` & `/consultations/consult-meta-judge-demo` | Full **Muse Wonder Clinical Co-Pilot** (Live ICD-10 DDx + Auto-SOAP), **SAM 3.1 Universal Clinical & NAFDAC Scanner**, **2-Way MMS-1B Call Diarization**, and **Floating Talk-Through AI Assistant**. |
| **PPMV Counter Attendant (Tier-1 Store)** | `attendant1@docarion.ppmv` | `Password123!` | `/dashboard/pharmacy` | **NAFDAC Medication Authenticity & PCN Scope Gatekeeper** (validates any drug pack + 1-click doctor escalation) and **Point-of-Care Rapid Test & Skin Lesion Capture** for remote physician review. |
| **Walk-In Nurse / Care Station** | `nurse1@docarion.clinic` | `Password123!` | `/care-station` & `/dashboard/nurse` | Walk-in phone lookup/creation, **Assisted Bilingual Pidgin AI Intake**, **SAM 3.1 Camera-Calibrated Lesion/Blister/Wound Sizing (`cm²`) & Paper Report Intake**, and **6-Char QR Phone Handoff**. |
| **Clinic Doctor** | `doc1@docarion.clinic` | `Password123!` | `/dashboard/doctor` | **Pre-Claim Physician Brief**, **Live In-Chat Muse Wonder Co-Pilot**, **Flexible e-Rx Dosing Engine**, and **RLHF Feedback Flywheel**. |
| **Licensed Pharmacist** | `pharm1@docarion.pharmacy` | `Password123!` | `/dashboard/pharmacy` | Full pharmacy **NAFDAC Registry/API Drug Pack Verification**, point-of-care rapid test capture, e-Rx fulfillment, and WHO AWaRe antibiotic stewardship checks. |
| **Lab Technician** | `tech1@docarion.laboratory` | `Password123!` | `/dashboard/laboratory` | **SAM 3.1 Point-of-Care Rapid Test Reader** (any RDT cassette/strip) and **Universal Paper Lab Result & Diagnostic Report OCR** with automatic pre-OCR PHI header redaction. |
| **Radiology Technician** | `tech1@docarion.radiology` | `Password123!` | `/dashboard/radiology` | **SAM 3.1 Clinical Imaging ROI Segmentation** and structured imaging/report findings extraction. |
| **Care Home Nurse** | `nurse1@docarion.carehome` | `Password123!` | `/dashboard/care-home` | Bedside **SAM 3.1 Cutaneous Lesion / Pressure Ulcer / Wound Planimetry (`cm²`)**, external paper report intake, resident vitals (`/residents/[id]/vitals`), and assisted intake. |
| **Hospital Admin** | `admin1@docarion.hospital` | `Password123!` | `/dashboard/hospital` | **Live Doctor Coverage & `<10m` SLA Board**, facility-wide AI telemetry, and 1-click on-duty doctor paging. |
| **Docarion Central Support / Phone Desk** | `support1@docarion.central` | `Password123!` | `/dashboard/support` | **Assisted Phone-Line Patient Scheduling**, Central SLA Queue Monitoring, and Floating Talk-Through AI Support Assistant. |
| **Authenticated Patient** | `patient1@docarion.clinic` | `Password123!` | `/dashboard/patient` & `/symptom-checker` | **Consumer NAFDAC Original Medication Checker**, **SAM 3.1 Home Camera Sizing for Skin Lesions/Blisters/Wounds & Lab/Rapid-Test Scanner**, **Once-Only Fixed History Editor**, and **Bilingual Pidgin AI Intake**. |

---

## 👨‍⚕️ Hackathon Builder & Solo Contributor Disclosure (`Team #468 — Docarion`)

- **Approved Hackathon Participant & 100% Solo Hackathon Builder:** **Dr. Godswill Olemgbe, MBBS** — Founder & CEO ([@evidencechecked](https://x.com/evidencechecked) · Cerebral Valley: `dr_gee`).
- **100% Solo Hackathon Build (Rule 7 Compliance):** This entire Meta Global AI Developer Hackathon project—including 100% of the **Meta Muse Spark & Muse Wonder** clinical intelligence engine, **Hypothesis-Driven AI History-Taking (HDHT)** & longitudinal fixed-history intake, **Meta SAM 3.1** clinical vision & NAFDAC/PCN gatekeeper, **Meta MMS-1B** 2-way call audio diarization, and the **In-Consultation Clinical Co-Pilot & Unified SOAP workflow**—was architected, coded, and built **100% solo by Dr. Godswill Olemgbe** as the sole approved hackathon participant on this submission. No other individuals or company team members contributed to or worked on this hackathon segment.
- **Official Brand & Waitlist Portal:** [@docarion_hq](https://x.com/docarion_hq) · [https://docarion.com](https://docarion.com)

---

## ⚡ What Was Newly Built During This Hackathon (Startup Track Rule 4 Disclosure)

While Docarion provides the underlying multi-facility EMR foundation, **100% of the Meta AI clinical intelligence, history-taking, diagnosis support, and multi-role care-line support systems** in this repository and demonstrated in our walkthrough video were built from scratch during the hackathon (Oct 26 – Nov 4, 2026) across **three core pillars**:

### 1. Adaptive AI History-Taking, Longitudinal Fixed-History & Universal SAM 3.1 Multimodal Intake Engine (`Meta Muse Spark` + `Meta SAM 3.1`)
- **Concise 3-Turn Adaptive Symptom Intake (`backend/src/services/ai-intake.service.ts`, `intake-history.service.ts`):** Plain-language conversational history-taking across English, Nigerian Pidgin (`pcm`), Hausa, Yoruba, and Igbo that adapts to patient literacy while enforcing a strict zero-leak boundary (differential diagnoses never leak into patient chat).
- **Once-Only Longitudinal Fixed History Editor (`frontend/src/components/patient/FixedHistoryEditor.tsx`):** Permanently stores static history domains (`allergies`, `medications`, `pastMedical`, `pastSurgical`, `familyHistory`, `socialHistory`) so returning patients are never re-asked baseline questions.
- **2-Hour Incomplete Session Resumption & Two-Phase Doctor Notifications:** Automatically resumes incomplete check-ins within 2 hours and dispatches two-phase alerts (`history_started` → `ready_to_claim`) to on-duty doctors.
- **Universal Multimodal Intake, NAFDAC Drug Validation & Camera-Calibrated Clinical Vision (`Meta SAM 3.1` on Modal T4 GPU + `Meta Muse Spark`):** A general-purpose clinical vision pipeline (`sam-vision.service.ts`, `nafdac-verification.service.ts`, `MetaMultimodalScanner.tsx`) supporting:
  1. **NAFDAC Original Medication Verification & PCN Scope Gatekeeper (`drug_pack`):** Uses **SAM 3.1** to segment any pharmaceutical packaging and isolate NAFDAC registration boxes (`A4-xxxx`, `04-xxxx`, etc.), paired with **Muse Spark** OCR and NAFDAC registry/API verification to authenticate original medications and enforce OTC vs. Prescription-Only Medicine (`POM`) dispensing rules.
  2. **Camera-Calibrated Cutaneous Lesion, Blister, Rash & Wound Sizing (`wound`, `dermatology`, `ophthalmology`):** When a remote telehealth physician reviews a skin lesion, blister, rash, burn, swelling, or ulcer from a distance, a standard photo provides no reliable sense of physical size. Using our camera capture with **SAM 3.1** boundary isolation and millimeter reference-scale calibration, Docarion calculates realistic estimated physical dimensions (`length × width` in `cm` and surface area in `mm²` / `cm²`) plus tissue-bed composition—sizing any cutaneous or anatomical lesion accurately for remote clinical assessment and longitudinal tracking.
  3. **Any Point-of-Care Rapid Diagnostic Test Capture (`rdt_strip`):** Enables pharmacists in local medicine stores (PPMVs), nurses, lab techs, and patients to capture **any** rapid test cassette or dipstick (*e.g., Malaria, HIV, Hepatitis B/C, Typhoid, Syphilis, Pregnancy hCG, Urine Dipsticks, Glucometer readouts*), isolating Control (`C`) and Test (`T`) bands for physician review.
  4. **Any Paper Lab Result & Medical Report Intake with Pre-OCR PHI Redaction (`lab_sheet`):** Uses **SAM 3.1** to detect and mask out patient-identifying demographic header strips on **any** printed or handwritten laboratory sheet, diagnostic report, or referral letter before **Muse Spark** extracts structured `LOINC`-mapped clinical values for the doctor.

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

## 🧠 4-Model Meta AI Architecture (`Meta Model API` + `Baseten` + `Modal T4 GPU`)

1. **Meta Muse Spark & Muse Spark Open (`meta-models/muse-spark-open-1026` on Baseten + `meta-muse-spark` via Meta Model API):**
   - Powers real-time, low-latency multilingual intake routing across English, Nigerian Pidgin (`pcm`), Hausa, Yoruba, and Igbo, asking concise follow-up questions to organize patient history for the receiving nurse or doctor.
   - Powers structured OCR extraction on SAM 3.1-segmented pharmaceutical packaging (extracting NAFDAC registration numbers, batch codes, dosage forms, and expiry dates for NAFDAC registry/API validation) and **any** paper laboratory or diagnostic report (mapping printed/handwritten results into structured `LOINC`-coded lab tables after PHI header redaction).
   - Generates bilingual (English + Nigerian Pidgin) post-visit medication instructions and follow-up checklists from the clinician's signed treatment plan.
2. **Meta Muse Wonder (`meta-muse-wonder` / Llama 4 Maverick):**
   - Powers the Clinician Documentation & Stewardship Co-Pilot (`/api/v1/ai-intake/:consultationId/copilot-sync`). Synthesizes the patient's intake transcript, nursing vitals, and SAM 3.1 visual measurements into structured SOAP note drafts, ICD-10-CM coding suggestions, and WHO AWaRe 2023 antibiotic stewardship alerts.
3. **Meta SAM 3.1 (`Segment Anything Model 3.1` deployed on Modal Serverless NVIDIA T4 GPU):**
   - Powers `/api/v1/ai-intake/vision/analyze` and `/api/v1/ai-intake/nafdac/verify` (`sam-vision.service.ts`) as a **general-purpose clinical & pharmaceutical visual segmentation engine** in `~200–650ms` *(with quick-test UI presets provided as examples alongside live upload/camera capture for any clinical or pharmaceutical image)*:
     - `drug_pack` (**NAFDAC Original Medication Validation**): Isolates pharmaceutical carton/blister panels and NAFDAC registration bounding boxes (`[x, y, w, h]`) on any drug pack for NAFDAC registry/API authenticity validation and PCN dispensing scope verification.
     - `wound`, `dermatology`, `ophthalmology` (**Camera-Calibrated Cutaneous Lesion, Blister, Rash & Wound Sizing for Remote Doctors**): Solves one of remote telehealth's hardest physical-exam blind spots—sizing a skin lesion, blister, rash, swelling, burn, or ulcer accurately from a camera image. By isolating exact lesion/wound pixel boundaries against a millimeter reference scale, SAM 3.1 calculates realistic estimated dimensions (`cm` length × width and `mm²` / `cm²` surface area) and tissue-bed breakdown so a remote physician knows the true size of what they are reviewing.
     - `rdt_strip` (**Point-of-Care Rapid Test Capture**): Segments **any** rapid diagnostic test cassette, dipstick, or point-of-care meter performed at local pharmacies/PPMVs, clinics, or home (*e.g., Malaria, HIV, Hepatitis B/C, Syphilis, Typhoid, Pregnancy hCG, Urine Dipsticks, etc.*), isolating Control (`C`) and Test (`T`) bands so doctors can review objective point-of-care test evidence.
     - `lab_sheet` (**Universal Paper Lab Result & Medical Report Intake**): Detects and masks out the patient-identifying demographic header strip on **any** printed or handwritten laboratory result sheet, external diagnostic report, or referral document before OCR digitization, enforcing privacy-by-design.
4. **Meta MMS-1B (`facebook/mms-1b-all` deployed on Modal Serverless NVIDIA T4 GPU with Pyannote 3.1):**
   - Powers `/api/v1/ai-intake/call-diarize` (`call-voice-diarization.service.ts`) and live consultation transcription (`live-scribe-asr.service.ts` + `backend/modal/modal_mms_asr_app.py`) for 2-way telehealth consultation audio, separating `SPEAKER_DOCTOR` and `SPEAKER_PATIENT` turns across West African accented English and Nigerian Pidgin, Hausa, Yoruba, and Igbo.
