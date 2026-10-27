import { chromium } from '/Users/gcole/Applications/docarion/frontend/node_modules/playwright/index.mjs';

const API_BASE = 'https://docarion.com/api/v1';
const WEB_BASE = 'https://docarion.com';
const PASSWORD = 'Password123!';

// 1x1 red PNG base64
const SAMPLE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const results = [];
function record(role, check, ok, detail) {
  results.push({ role, check, ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${role}] ${check} -> ${detail}`);
}

async function login(email) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const json = await res.json();
  const token = json?.data?.tokens?.accessToken || json?.data?.token || json?.token;
  const refreshToken = json?.data?.tokens?.refreshToken || json?.data?.refreshToken;
  const user = json?.data?.user || json?.user;
  if (!res.ok || !token) {
    throw new Error(`Login failed for ${email}: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return { token, refreshToken, user };
}

async function apiCall(token, method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

async function runApiSuite() {
  console.log('=== PART 1: MULTI-ROLE STAFF & PATIENT API ENDPOINT VERIFICATION ===');

  // 1. PPMV Attendant
  {
    const role = 'PPMV Attendant (attendant1@docarion.ppmv)';
    const { token } = await login('attendant1@docarion.ppmv');

    // 1a. OTC Allowed
    const otc = await apiCall(token, 'POST', '/ai-intake/nafdac/verify', {
      nafdacRegNo: 'A4-0192',
      drugName: 'Coartem 20/120',
      facilityLicenceClass: 'ppmv',
      hasActiveLinkedRx: false,
    });
    record(
      role,
      'NAFDAC OTC Verify (A4-0192)',
      otc.ok &&
        otc.json?.data?.authenticityStatus === 'verified_authentic' &&
        otc.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter === true,
      `status=${otc.json?.data?.authenticityStatus}, ppmvAllowed=${otc.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter}`
    );

    // 1b. POM Blocked without e-Rx
    const pomBlocked = await apiCall(token, 'POST', '/ai-intake/nafdac/verify', {
      nafdacRegNo: '04-1928',
      drugName: 'Augmentin 625mg',
      facilityLicenceClass: 'ppmv',
      hasActiveLinkedRx: false,
    });
    record(
      role,
      'NAFDAC POM Blocked without e-Rx (04-1928)',
      pomBlocked.ok &&
        pomBlocked.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter === false &&
        pomBlocked.json?.data?.ppmvCounterGate?.requiresActiveDoctorRx === true,
      `banner=${pomBlocked.json?.data?.ppmvCounterGate?.statusBanner}, ppmvAllowed=${pomBlocked.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter}`
    );

    // 1c. POM Unlocked with Active Physician e-Rx
    const pomUnlocked = await apiCall(token, 'POST', '/ai-intake/nafdac/verify', {
      nafdacRegNo: '04-1928',
      drugName: 'Augmentin 625mg',
      facilityLicenceClass: 'ppmv',
      hasActiveLinkedRx: true,
    });
    record(
      role,
      'NAFDAC POM Unlocked with Doctor e-Rx (04-1928)',
      pomUnlocked.ok && pomUnlocked.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter === true,
      `banner=${pomUnlocked.json?.data?.ppmvCounterGate?.statusBanner}, ppmvAllowed=${pomUnlocked.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter}`
    );

    // 1d. Controlled Substance Always Blocked
    const controlled = await apiCall(token, 'POST', '/ai-intake/nafdac/verify', {
      nafdacRegNo: '04-8800',
      drugName: 'Tramadol 100mg',
      facilityLicenceClass: 'ppmv',
      hasActiveLinkedRx: true,
    });
    record(
      role,
      'NAFDAC Controlled Substance Always Blocked (04-8800)',
      controlled.ok &&
        controlled.json?.data?.drugClass === 'controlled' &&
        controlled.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter === false,
      `drugClass=${controlled.json?.data?.drugClass}, ppmvAllowed=${controlled.json?.data?.ppmvCounterGate?.allowedAtPpmvCounter}`
    );

    // 1e. Unlisted Number Never Verified
    const unlisted = await apiCall(token, 'POST', '/ai-intake/nafdac/verify', {
      nafdacRegNo: 'FAKE-9999',
      drugName: 'Unknown Capsule',
      facilityLicenceClass: 'ppmv',
      hasActiveLinkedRx: false,
    });
    record(
      role,
      'NAFDAC Unlisted Never Verified (FAKE-9999)',
      unlisted.ok && unlisted.json?.data?.authenticityStatus !== 'verified_authentic',
      `authenticityStatus=${unlisted.json?.data?.authenticityStatus}`
    );

    // 1f. 1-Click Doctor Escalation from PPMV Counter
    const escalate = await apiCall(token, 'POST', '/telehealth-queue/notify-on-duty', {
      facilityId: 'docarion_ppmv',
      message: 'PPMV Counter Escalation: Patient requires e-Rx review for Augmentin 625mg',
    });
    record(
      role,
      '1-Click Doctor Escalation (POST /telehealth-queue/notify-on-duty)',
      escalate.ok && escalate.json?.success === true,
      `HTTP ${escalate.status} notifiedCount=${escalate.json?.data?.notifiedCount ?? 0}`
    );

    // 1g. Malaria RDT Strip Vision Scan at PPMV Counter
    const rdtVision = await apiCall(token, 'POST', '/ai-intake/vision/analyze', {
      type: 'rdt_strip',
      imageBase64: SAMPLE_PNG,
      facilityLicenceClass: 'ppmv',
    });
    record(
      role,
      'SAM 3.1 RDT Strip Vision Scan',
      rdtVision.ok && Boolean(rdtVision.json?.data?.modelUsed),
      `modelUsed=${rdtVision.json?.data?.modelUsed}`
    );

    // 1h. PPMV AI Summary & Dashboard AI Co-Pilot
    const summary = await apiCall(token, 'GET', '/pharmacies/docarion_ppmv/ai-summary?pending=3&lowStock=1');
    record(
      role,
      'PPMV AI Operational Summary (GET /pharmacies/:id/ai-summary)',
      summary.ok && Boolean(summary.json?.data?.summaryText),
      `summary="${String(summary.json?.data?.summaryText || '').slice(0, 60)}..."`
    );

    const chat = await apiCall(token, 'POST', '/ai/chat', {
      message: 'Role: medicine_store_attendant. User query: PCN Tier-1 OTC vs POM list',
      role: 'medicine_store_attendant',
    });
    record(
      role,
      'PPMV Counter Safety AI Co-Pilot (POST /ai/chat)',
      chat.ok && Boolean(chat.json?.reply) && !chat.json.reply.includes("couldn't identify specific symptoms"),
      `model=${chat.json?.modelUsed || 'ok'} reply="${String(chat.json?.reply || '').slice(0, 60)}..."`
    );
  }

  // 2. Pharmacist
  {
    const role = 'Pharmacist (pharm1@docarion.pharmacy)';
    const { token } = await login('pharm1@docarion.pharmacy');

    const drugPack = await apiCall(token, 'POST', '/ai-intake/vision/analyze', {
      type: 'drug_pack',
      imageBase64: SAMPLE_PNG,
      facilityLicenceClass: 'pharmacy',
    });
    const drugPackOk =
      drugPack.ok &&
      Boolean(
        drugPack.json?.data?.nafdacVerification ||
          drugPack.json?.data?.samSegmentation ||
          drugPack.json?.data?.findings?.length
      );
    record(
      role,
      'SAM 3.1 Drug Pack Vision Scan',
      drugPackOk,
      `status=${drugPack.json?.data?.nafdacVerification?.authenticityStatus}, seg=${Boolean(drugPack.json?.data?.samSegmentation)}`
    );

    const safety = await apiCall(token, 'POST', '/ai/drugs/check-safety', {
      medications: ['Artemether/Lumefantrine', 'Ciprofloxacin'],
    });
    record(
      role,
      'AI Drug Interaction Safety Check (POST /ai/drugs/check-safety)',
      safety.ok && Array.isArray(safety.json?.data?.warnings),
      `HTTP ${safety.status} warnings=${safety.json?.data?.warnings?.length ?? 0}`
    );

    const summary = await apiCall(token, 'GET', '/pharmacies/docarion_pharmacy/ai-summary?pending=4&lowStock=2');
    record(
      role,
      'Pharmacy AI Summary (GET /pharmacies/:id/ai-summary)',
      summary.ok && Boolean(summary.json?.data?.summaryText),
      `summary="${String(summary.json?.data?.summaryText || '').slice(0, 60)}..."`
    );

    const chat = await apiCall(token, 'POST', '/ai/chat', {
      message: 'Role: pharmacist. User query: Verify drug interactions for artemether-lumefantrine',
      role: 'pharmacist',
    });
    record(
      role,
      'Pharmacist AI Co-Pilot (POST /ai/chat)',
      chat.ok && Boolean(chat.json?.reply) && !chat.json.reply.includes("couldn't identify specific symptoms"),
      `model=${chat.json?.modelUsed || 'ok'} reply="${String(chat.json?.reply || '').slice(0, 60)}..."`
    );
  }

  // 3. Nurse / Care Station Operator
  {
    const role = 'Nurse / Care Station (nurse1@docarion.clinic)';
    const { token } = await login('nurse1@docarion.clinic');

    const wound = await apiCall(token, 'POST', '/ai-intake/vision/analyze', {
      type: 'wound',
      imageBase64: SAMPLE_PNG,
      referenceScaleMm: 25,
    });
    record(
      role,
      'SAM 3.1 Wound Planimetry Scan',
      wound.ok && Boolean(wound.json?.data?.samSegmentation),
      `modelUsed=${wound.json?.data?.modelUsed}, areaMm2=${wound.json?.data?.woundPlanimetry?.estimatedAreaMm2}`
    );

    const copilot = await apiCall(token, 'POST', '/ai-intake/care-station-demo-1/copilot-sync', {
      transcript: 'Patient walked into clinic complaining of high fever, chills, and bitter mouth for 3 days.',
      vitals: { temperature: 38.9, heartRate: 104, bloodPressure: '118/76', oxygenSaturation: 98 },
      language: 'pcm',
    });
    record(
      role,
      'Muse Wonder Clinical Co-Pilot Sync (POST /ai-intake/:id/copilot-sync)',
      copilot.ok && Array.isArray(copilot.json?.data?.differentials) && Boolean(copilot.json?.data?.soapDraft),
      `model=${copilot.json?.data?.telemetry?.modelUsed || 'muse-wonder'}, ddxCount=${copilot.json?.data?.differentials?.length}`
    );

    const vitalsParse = await apiCall(token, 'POST', '/ai/parse-text', {
      type: 'vitals',
      text: 'BP 128/82 mmHg, HR 88 bpm, Temp 38.4 C, SpO2 97%, Weight 68 kg',
    });
    record(
      role,
      'AI Vitals Dictation Parser (POST /ai/parse-text)',
      vitalsParse.ok && Boolean(vitalsParse.json?.data),
      `HTTP ${vitalsParse.status} parsed=${JSON.stringify(vitalsParse.json?.data || {}).slice(0, 60)}`
    );

    const chat = await apiCall(token, 'POST', '/ai/chat', {
      message: 'Role: nurse. User query: Check vital ranges for febrile adult triage',
      role: 'nurse',
    });
    record(
      role,
      'Nursing Flow AI Helper (POST /ai/chat)',
      chat.ok && Boolean(chat.json?.reply) && !chat.json.reply.includes("couldn't identify specific symptoms"),
      `model=${chat.json?.modelUsed || 'ok'} reply="${String(chat.json?.reply || '').slice(0, 60)}..."`
    );
  }

  // 4. Doctor
  {
    const role = 'Doctor (doc1@docarion.clinic)';
    const { token } = await login('doc1@docarion.clinic');

    const copilot = await apiCall(token, 'POST', '/ai-intake/consult-doc-verify-1/copilot-sync', {
      transcript: 'Doctor: How many days your body don dey hot? Patient: Since three days o, my head dey burst and I dey vomit.',
      vitals: { temperature: 39.1, heartRate: 110, bloodPressure: '115/74', oxygenSaturation: 97 },
      language: 'pcm',
    });
    record(
      role,
      'Doctor Muse Wonder Co-Pilot (DDx, SOAP & Pidgin Discharge)',
      copilot.ok &&
        Array.isArray(copilot.json?.data?.differentials) &&
        Boolean(copilot.json?.data?.soapDraft?.assessment) &&
        Boolean(copilot.json?.data?.vernacularPatientSummary),
      `model=${copilot.json?.data?.telemetry?.modelUsed || 'muse-wonder'}, ddx=${copilot.json?.data?.differentials?.[0]?.name}`
    );

    const diarize = await apiCall(token, 'POST', '/ai-intake/consult-doc-verify-1/call-diarize', {
      customDialogue:
        'Doctor: Good afternoon, wetin dey do you today?\nPatient: Doctor, my belle dey run and body dey hot since yesterday.',
      language: 'pcm',
      stripNoise: true,
    });
    record(
      role,
      '2-Way Call Voice Segregation & PHI Scrubbing (POST /:id/call-diarize)',
      diarize.ok && Array.isArray(diarize.json?.data?.turns) && diarize.json.data.turns.length >= 2,
      `model=${diarize.json?.data?.modelUsed}, turns=${diarize.json?.data?.turns?.length}, phiScrubbed=${diarize.json?.data?.phiScrubbed}`
    );

    const rlhf = await apiCall(token, 'POST', '/ai-intake/rlhf/feedback', {
      consultationId: 'consult-doc-verify-1',
      module: 'ddx',
      action: 'accepted',
      aiSuggestion: { condition: 'Acute Uncomplicated Malaria' },
      doctorAction: { diagnosis: 'Malaria' },
      timeTakenMs: 1450,
    });
    record(
      role,
      'Clinician RLHF Feedback Flywheel (POST /ai-intake/rlhf/feedback)',
      rlhf.ok && rlhf.json?.success === true,
      `HTTP ${rlhf.status}`
    );

    const prefill = await apiCall(token, 'GET', '/ai/prefill');
    record(
      role,
      'Doctor Quick AI Prefill (GET /ai/prefill)',
      prefill.ok && Boolean(prefill.json?.data?.suggestion),
      `suggestion="${prefill.json?.data?.suggestion}"`
    );

    const chat = await apiCall(token, 'POST', '/ai/chat', {
      message: 'Role: doctor. User query: Check dosage safe ranges for adult artemether-lumefantrine',
      role: 'doctor',
    });
    record(
      role,
      'MD Clinical Co-Pilot Chat (POST /ai/chat)',
      chat.ok && Boolean(chat.json?.reply) && !chat.json.reply.includes("couldn't identify specific symptoms"),
      `model=${chat.json?.modelUsed || 'ok'} reply="${String(chat.json?.reply || '').slice(0, 60)}..."`
    );
  }

  // 5. Lab Technician
  {
    const role = 'Lab Technician (tech1@docarion.laboratory)';
    const { token } = await login('tech1@docarion.laboratory');

    const labVision = await apiCall(token, 'POST', '/ai-intake/vision/analyze', {
      type: 'lab_sheet',
      imageBase64: SAMPLE_PNG,
    });
    record(
      role,
      'SAM 3.1 Lab Sheet Vision OCR & Segmentation',
      labVision.ok && Boolean(labVision.json?.data?.modelUsed),
      `modelUsed=${labVision.json?.data?.modelUsed}`
    );

    const qcParse = await apiCall(token, 'POST', '/ai/parse-text', {
      type: 'qc_record',
      text: 'Analyzer Sysmex-XN1000, Test Hemoglobin, Lot QC-2026-10, Level Normal, Result 13.8 g/dL, Expected Range 12.5-15.0 g/dL',
    });
    record(
      role,
      'Lab QC AI Text Parser (POST /ai/parse-text)',
      qcParse.ok && Boolean(qcParse.json?.data),
      `HTTP ${qcParse.status} parsed=${JSON.stringify(qcParse.json?.data || {}).slice(0, 60)}`
    );

    const chat = await apiCall(token, 'POST', '/ai/chat', {
      message: 'Role: lab_technician. User query: Verify control values and Westgard rules',
      role: 'lab_technician',
    });
    record(
      role,
      'Lab QC Analyzer AI Chat (POST /ai/chat)',
      chat.ok && Boolean(chat.json?.reply) && !chat.json.reply.includes("couldn't identify specific symptoms"),
      `model=${chat.json?.modelUsed || 'ok'} reply="${String(chat.json?.reply || '').slice(0, 60)}..."`
    );
  }

  // 6. Radiology Technician
  {
    const role = 'Radiology Technician (tech1@docarion.radiology)';
    const { token } = await login('tech1@docarion.radiology');

    const radVision = await apiCall(token, 'POST', '/ai-intake/vision/analyze', {
      type: 'dermatology',
      imageBase64: SAMPLE_PNG,
      referenceScaleMm: 20,
    });
    record(
      role,
      'SAM 3.1 Lesion / Imaging Segmentation',
      radVision.ok && Boolean(radVision.json?.data?.modelUsed),
      `modelUsed=${radVision.json?.data?.modelUsed}`
    );

    const radSummary = await apiCall(token, 'GET', '/radiology/docarion_radiology/ai-summary');
    record(
      role,
      'Radiology AI Operational Insight (GET /radiology/:id/ai-summary)',
      radSummary.ok && Boolean(radSummary.json?.insight),
      `insight="${String(radSummary.json?.insight || '').slice(0, 60)}..."`
    );

    const chat = await apiCall(token, 'POST', '/ai/chat', {
      message: 'Role: rad_technician. User query: IV contrast eGFR safety check protocol',
      role: 'rad_technician',
    });
    record(
      role,
      'Radiology Imaging AI Co-Pilot (POST /ai/chat)',
      chat.ok && Boolean(chat.json?.reply) && !chat.json.reply.includes("couldn't identify specific symptoms"),
      `model=${chat.json?.modelUsed || 'ok'} reply="${String(chat.json?.reply || '').slice(0, 60)}..."`
    );
  }

  // 7. Care Home Nurse
  {
    const role = 'Care Home Nurse (nurse1@docarion.carehome)';
    const { token } = await login('nurse1@docarion.carehome');

    const ulcerVision = await apiCall(token, 'POST', '/ai-intake/vision/analyze', {
      type: 'wound',
      imageBase64: SAMPLE_PNG,
      referenceScaleMm: 30,
    });
    record(
      role,
      'SAM 3.1 Pressure Ulcer Planimetry',
      ulcerVision.ok && Boolean(ulcerVision.json?.data?.samSegmentation || ulcerVision.json?.data?.samPlanimetry),
      `modelUsed=${ulcerVision.json?.data?.modelUsed}, areaCm2=${ulcerVision.json?.data?.samPlanimetry?.woundAreaCm2 ?? ulcerVision.json?.data?.samSegmentation?.planimetry?.totalAreaMm2}`
    );

    const chSummary = await apiCall(token, 'GET', '/care-homes/docarion_care_home/ai-summary');
    record(
      role,
      'Care Home Daily AI Summary (GET /care-homes/:id/ai-summary)',
      chSummary.ok && Boolean(chSummary.json?.data?.summary),
      `summary="${String(chSummary.json?.data?.summary || '').slice(0, 60)}..."`
    );

    const chat = await apiCall(token, 'POST', '/ai/chat', {
      message: 'Role: care_home_nurse. User query: Pressure ulcer protocol and Braden scale',
      role: 'care_home_nurse',
    });
    record(
      role,
      'Care Home Clinical AI Co-Pilot (POST /ai/chat)',
      chat.ok && Boolean(chat.json?.reply) && !chat.json.reply.includes("couldn't identify specific symptoms"),
      `model=${chat.json?.modelUsed || 'ok'} reply="${String(chat.json?.reply || '').slice(0, 60)}..."`
    );
  }

  // 8. Hospital & Clinic Admin
  {
    const role = 'Hospital & Clinic Admin (admin1@docarion.hospital / admin1@docarion.clinic)';
    const { token: hospToken } = await login('admin1@docarion.hospital');
    const { token: clinicToken } = await login('admin1@docarion.clinic');

    const coverage = await apiCall(hospToken, 'GET', '/telehealth-queue/coverage-status');
    record(
      role,
      'Live Doctor Coverage Status (GET /telehealth-queue/coverage-status)',
      coverage.ok && Boolean(coverage.json?.data?.summary),
      `totalDoctors=${coverage.json?.data?.summary?.totalCredentialedDoctors}`
    );

    const bookingPrefill = await apiCall(clinicToken, 'POST', '/clinics/docarion_clinic/ai-prefill', {
      type: 'booking',
      data: { notes: 'Follow up visit after 3-day antimalarial course' },
    });
    record(
      role,
      'Clinic Booking AI Note Refinement (POST /clinics/:id/ai-prefill)',
      bookingPrefill.ok && typeof bookingPrefill.json?.data?.notes === 'string',
      `notes="${String(bookingPrefill.json?.data?.notes || '').slice(0, 60)}..."`
    );
  }

  // 9. Patient
  {
    const role = 'Patient (patient1@docarion.clinic)';
    const { token } = await login('patient1@docarion.clinic');

    const triage = await apiCall(token, 'POST', '/ai/chat', {
      message: 'My body dey hot and I have fever, headache, and chills since three days',
      role: 'patient',
    });
    record(
      role,
      'Patient Multilingual Pidgin Symptom Triage (POST /ai/chat)',
      triage.ok && Boolean(triage.json?.reply),
      `HTTP ${triage.status} reply="${String(triage.json?.reply || '').slice(0, 70)}..."`
    );
  }
}

async function runBrowserSuite() {
  console.log('\n=== PART 2: HEADLESS CHROMIUM STAFF & PATIENT UI E2E VERIFICATION ===');
  const browser = await chromium.launch({ headless: true });

  const uiRoles = [
    {
      label: 'PPMV Attendant UI',
      email: 'attendant1@docarion.ppmv',
      url: `${WEB_BASE}/dashboard/pharmacy`,
      expectText: 'SAM 3.1 Vision & Planimetry',
    },
    {
      label: 'Nurse Care Station UI',
      email: 'nurse1@docarion.clinic',
      url: `${WEB_BASE}/care-station`,
      expectText: 'Meta Multimodal Scanner (SAM 3.1 & NAFDAC)',
    },
    {
      label: 'Doctor Dashboard UI',
      email: 'doc1@docarion.clinic',
      url: `${WEB_BASE}/dashboard/doctor`,
      expectText: 'SAM 3.1 Vision & Planimetry',
    },
    {
      label: 'Nurse Dashboard UI',
      email: 'nurse1@docarion.clinic',
      url: `${WEB_BASE}/dashboard/nurse`,
      expectText: 'SAM 3.1 Vision & Planimetry',
    },
    {
      label: 'Laboratory Dashboard UI',
      email: 'tech1@docarion.laboratory',
      url: `${WEB_BASE}/dashboard/laboratory`,
      expectText: 'SAM 3.1 Vision & Planimetry',
    },
    {
      label: 'Radiology Dashboard UI',
      email: 'tech1@docarion.radiology',
      url: `${WEB_BASE}/dashboard/radiology`,
      expectText: 'SAM 3.1 Vision & Planimetry',
    },
    {
      label: 'Patient Dashboard UI',
      email: 'patient1@docarion.clinic',
      url: `${WEB_BASE}/dashboard/patient`,
      expectText: 'Meta AI Scanner',
    },
  ];

  for (const item of uiRoles) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    try {
      await page.goto(`${WEB_BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.evaluate(
        async ({ email, password }) => {
          const res = await fetch('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password }),
          });
          const json = await res.json();
          const user = json?.data?.user || json?.user;
          const token = json?.data?.tokens?.accessToken || json?.data?.token;
          const refreshToken = json?.data?.tokens?.refreshToken || json?.data?.refreshToken;
          if (token) {
            localStorage.setItem('accessToken', token);
            localStorage.setItem('auth_token', token);
            localStorage.setItem('token', token);
          }
          if (refreshToken) {
            localStorage.setItem('refreshToken', refreshToken);
          }
          localStorage.setItem(
            'auth-storage',
            JSON.stringify({
              state: {
                user,
                isAuthenticated: true,
                mfaRequired: false,
                isSandbox: false,
                requiresOnboarding: false,
              },
              version: 0,
            })
          );
        },
        { email: item.email, password: PASSWORD }
      );

      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(4000);
      const bodyText = await page.locator('body').innerText();
      const found = bodyText.includes(item.expectText);
      record(
        item.label,
        `Render ${item.url} with "${item.expectText}" & 0 page errors`,
        found && pageErrors.length === 0,
        `found=${found}, pageErrors=${pageErrors.length}`
      );
    } catch (err) {
      record(item.label, `Render ${item.url}`, false, err.message);
    } finally {
      await context.close();
    }
  }

  await browser.close();
}

(async () => {
  await runApiSuite();
  await runBrowserSuite();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} CHECKS PASSED ===`);
  if (failed.length > 0) {
    console.error('Failed checks:', JSON.stringify(failed, null, 2));
    process.exit(1);
  }
})();
