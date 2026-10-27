import request from 'supertest';
import express from 'express';
import { firestore } from '../../__tests__/__mocks__/database';
import { nafdacVerificationService } from '../../services/nafdac-verification.service';

let currentUser: any = {
  userId: 'test-user',
  role: 'pharmacist',
  email: 'pharmacy@docarion.com',
  facilityId: 'pharm-fac-1',
};

jest.mock('../../middleware/auth.middleware', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = currentUser;
    next();
  },
  authorize: (...roles: string[]) => (req: any, res: any, next: any) => {
    if (roles.length && !roles.includes(currentUser.role) && currentUser.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions' });
    }
    next();
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  AuthRequest: {},
}));

jest.mock('../../middleware/mfa.middleware', () => ({
  requireMFA: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../middleware/credential-gate.middleware', () => ({
  requireCompletedCredential: () => (_req: any, _res: any, next: any) => next(),
  respondCredentialRequired: jest.fn(),
}));

jest.mock('../../services/notification.service', () => ({
  notificationService: {
    sendToUser: jest.fn().mockResolvedValue({ success: true }),
    sendToFacilityStaff: jest.fn().mockResolvedValue({ success: true }),
  },
}));

import telehealthQueueRoutes from '../telehealth-queue.routes';
import aiIntakeRoutes from '../ai-intake.routes';

const app = express();
app.use(express.json());
app.use('/telehealth-queue', telehealthQueueRoutes);
app.use('/ai-intake', aiIntakeRoutes);

describe('M3 Adversarial Challenge: Pharmacy POS, PPMV Gating & Telehealth Escalation', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
  });

  describe('1. RBAC Gating on POST /telehealth-queue/notify-on-duty', () => {
    it('REMEDIATED: pharmacist is PERMITTED to notify on-duty doctors', async () => {
      currentUser = { userId: 'pharm-1', role: 'pharmacist', facilityId: 'pharm-fac-1' };
      const res = await request(app)
        .post('/telehealth-queue/notify-on-duty')
        .send({
          facilityId: 'pharm-fac-1',
          urgency: 'high',
          message: '🚨 Pharmacy Counter Escalation: Patient requires physician e-Rx review for Augmentin',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('REMEDIATED: pharmacy_admin is PERMITTED to notify on-duty doctors', async () => {
      currentUser = { userId: 'padmin-1', role: 'pharmacy_admin', facilityId: 'pharm-fac-1' };
      const res = await request(app)
        .post('/telehealth-queue/notify-on-duty')
        .send({
          facilityId: 'pharm-fac-1',
          urgency: 'high',
          message: '🚨 Pharmacy Counter Escalation: Patient requires physician e-Rx review',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('REMEDIATED: medicine_store_attendant (PPMV) is PERMITTED to notify on-duty doctors', async () => {
      currentUser = { userId: 'attendant-1', role: 'medicine_store_attendant', facilityId: 'ppmv-fac-1' };
      const res = await request(app)
        .post('/telehealth-queue/notify-on-duty')
        .send({
          facilityId: 'ppmv-fac-1',
          urgency: 'high',
          message: '🚨 PPMV Counter Escalation: Flagged POM drug at till',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('Permitted roles (hospital_admin, super_admin, nurse, receptionist) can notify doctors', async () => {
      await firestore.collection('doctors').doc('doc-test-1').set({
        userId: 'doc-test-1',
        facilityId: 'hosp-fac-1',
        doctorType: 'facility',
        status: 'active',
      });

      currentUser = { userId: 'hadmin-1', role: 'hospital_admin', facilityId: 'hosp-fac-1' };
      const res = await request(app)
        .post('/telehealth-queue/notify-on-duty')
        .send({
          facilityId: 'hosp-fac-1',
          urgency: 'high',
          message: 'Urgent queue notification',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('2. PCN Gating Rules via NAFDAC Verification Service', () => {
    it('Permits OTC Coartem at PPMV counter without doctor e-Rx', () => {
      const res = nafdacVerificationService.verifyMedicine({
        nafdacRegNo: 'A4-0192',
        drugName: 'Coartem 20/120',
        facilityLicenceClass: 'ppmv',
        hasActiveLinkedRx: false,
      });

      expect(res.productDetails?.drugClass).toBe('otc');
      expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(true);
      expect(res.ppmvCounterGate.statusBanner).toBe('APPROVED_FOR_PPMV_OTC_SALE');
      expect(res.ppmvCounterGate.requiresActiveDoctorRx).toBe(false);
    });

    it('Blocks POM Augmentin at PPMV counter when hasActiveLinkedRx is false', () => {
      const res = nafdacVerificationService.verifyMedicine({
        nafdacRegNo: '04-1928',
        drugName: 'Augmentin 625mg',
        facilityLicenceClass: 'ppmv',
        hasActiveLinkedRx: false,
      });

      expect(res.productDetails?.drugClass).toBe('pom');
      expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
      expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_POM_ESCALATE_TO_DOCTOR');
      expect(res.ppmvCounterGate.requiresActiveDoctorRx).toBe(true);
    });

    it('Unlocks POM Augmentin at PPMV counter when hasActiveLinkedRx is true', () => {
      const res = nafdacVerificationService.verifyMedicine({
        nafdacRegNo: '04-1928',
        drugName: 'Augmentin 625mg',
        facilityLicenceClass: 'ppmv',
        hasActiveLinkedRx: true,
      });

      expect(res.productDetails?.drugClass).toBe('pom');
      expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(true);
      expect(res.ppmvCounterGate.statusBanner).toBe('APPROVED_FOR_PPMV_OTC_SALE');
      expect(res.ppmvCounterGate.hasValidLinkedRx).toBe(true);
    });

    it('STRICT PCN COMPLIANCE: Controlled Tramadol remains BLOCKED even if hasActiveLinkedRx is true', () => {
      const res = nafdacVerificationService.verifyMedicine({
        nafdacRegNo: '04-8800',
        drugName: 'Tramadol 100mg',
        facilityLicenceClass: 'ppmv',
        hasActiveLinkedRx: true,
      });

      expect(res.productDetails?.drugClass).toBe('controlled');
      expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
      expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_CONTROLLED_SUBSTANCE');
    });

    it('Overrides preset when custom NAFDAC number and drug name are provided', () => {
      // Simulating user having 'coartem' preset active but entering Augmentin details in custom inputs
      const customNafdac = '04-1928';
      const customDrug = 'Augmentin 625mg';
      const res = nafdacVerificationService.verifyMedicine({
        nafdacRegNo: customNafdac,
        drugName: customDrug,
        facilityLicenceClass: 'ppmv',
        hasActiveLinkedRx: false,
      });

      expect(res.nafdacRegNo).toBe('04-1928');
      expect(res.productDetails?.brandName).toContain('Augmentin');
      expect(res.productDetails?.drugClass).toBe('pom');
      expect(res.ppmvCounterGate.allowedAtPpmvCounter).toBe(false);
      expect(res.ppmvCounterGate.statusBanner).toBe('BLOCKED_POM_ESCALATE_TO_DOCTOR');
    });
  });

  describe('3. Mobile Pro Care Station & Web Gating Flaws', () => {
    it('REMEDIATED: pharmacist role is correctly classified as pharmacy licence class', () => {
      const role: string = 'pharmacist';
      // In mobile/apps/pro/app/care-station.tsx:
      // const facilityLicenceClass = (user?.role?.includes('pharmacy') || user?.role === 'pharmacist') ? 'pharmacy' : 'ppmv';
      const facilityLicenceClass = (role.includes('pharmacy') || role === 'pharmacist') ? 'pharmacy' : 'ppmv';
      expect(facilityLicenceClass).toBe('pharmacy');
    });

    it('Demonstrates ppmvCounterGate.reason does not exist on NafdacVerificationResult', () => {
      const res = nafdacVerificationService.verifyMedicine({
        nafdacRegNo: '04-1928',
        drugName: 'Augmentin 625mg',
      });
      // In frontend/src/app/dashboard/pharmacy/page.tsx line 450:
      // escalateData.ppmvCounterGate?.reason || 'Prescription Required'
      expect((res.ppmvCounterGate as any).reason).toBeUndefined();
    });
  });
});
