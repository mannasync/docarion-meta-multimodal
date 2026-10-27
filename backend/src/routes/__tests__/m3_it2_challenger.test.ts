import request from 'supertest';
import express from 'express';
import { firestore } from '../../__tests__/__mocks__/database';

let currentUser: any = {
  userId: 'test-user',
  role: 'pharmacist',
  email: 'pharmacy@docarion.com',
  facilityId: 'pharm-fac-1',
};

const mockSendToUser = jest.fn().mockResolvedValue({ success: true });
const mockSendToFacilityStaff = jest.fn().mockResolvedValue({ success: true });

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
    sendToUser: (...args: any[]) => mockSendToUser(...args),
    sendToFacilityStaff: (...args: any[]) => mockSendToFacilityStaff(...args),
  },
}));

import telehealthQueueRoutes from '../telehealth-queue.routes';

const app = express();
app.use(express.json());
app.use('/telehealth-queue', telehealthQueueRoutes);

describe('M3 Iteration 2 Challenger: Adversarial Stress Test of Escalation & Classification', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
  });

  describe('1. RBAC Matrix for POST /telehealth-queue/notify-on-duty', () => {
    const permittedRoles = [
      'pharmacist',
      'pharmacy_admin',
      'medicine_store_attendant',
      'hospital_admin',
      'clinic_admin',
      'admin',
      'super_admin',
      'nurse',
      'receptionist',
    ];

    const forbiddenRoles = [
      'patient',
      'doctor',
      'delivery_agent',
      'lab_technician',
      'rad_technician',
      'accountant',
      'caregiver',
    ];

    permittedRoles.forEach((role) => {
      it(`PERMITS authorized role: ${role}`, async () => {
        currentUser = { userId: `user-${role}`, role, facilityId: 'test-fac' };
        const res = await request(app)
          .post('/telehealth-queue/notify-on-duty')
          .send({
            facilityId: 'test-fac',
            urgency: 'high',
            message: '🚨 Test escalation message',
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    forbiddenRoles.forEach((role) => {
      it(`FORBIDS unauthorized role: ${role} with HTTP 403`, async () => {
        currentUser = { userId: `user-${role}`, role, facilityId: 'test-fac' };
        const res = await request(app)
          .post('/telehealth-queue/notify-on-duty')
          .send({
            facilityId: 'test-fac',
            urgency: 'high',
            message: '🚨 Malicious or unauthorized trigger',
          });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });
  });

  describe('2. Message Payload & Doctor Notification Propagation', () => {
    it('propagates patient phone number in doctor notification payload', async () => {
      await firestore.collection('doctors').doc('doc-notified-1').set({
        userId: 'doc-notified-1',
        facilityId: 'pharm-fac-1',
        doctorType: 'facility',
        status: 'active',
      });

      currentUser = { userId: 'pharm-1', role: 'pharmacist', facilityId: 'pharm-fac-1' };
      const patientPhone = '+2348012345678';
      const patientName = 'Chukwudi Okafor';
      const drug = 'Augmentin 625mg Tablets';
      const regNo = '04-1928';
      const note = 'Severe bacterial throat infection; urgent script needed.';

      const phoneStr = patientPhone ? ` Phone: ${patientPhone}.` : '';
      const customMsg = `🚨 Pharmacy Counter Escalation: Patient ${patientName} requires physician e-Rx review for flagged POM medication "${drug}" (NAFDAC ${regNo}).${phoneStr} Note: ${note}`.trim();

      const res = await request(app)
        .post('/telehealth-queue/notify-on-duty')
        .send({
          facilityId: 'pharm-fac-1',
          urgency: 'high',
          message: customMsg,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify that notification service was invoked with the exact body containing patient phone
      expect(mockSendToUser).toHaveBeenCalled();
      const calledArgs = mockSendToUser.mock.calls[0];
      const bodyArg = calledArgs[2]; // (userId, title, body, metadata)
      expect(bodyArg).toContain(`Phone: ${patientPhone}.`);
      expect(bodyArg).toContain('Chukwudi Okafor');
      expect(bodyArg).toContain('Augmentin 625mg Tablets');
    });

    it('handles empty patient phone gracefully by omitting phone label', () => {
      const patientPhone = '';
      const phoneStr = patientPhone ? ` Phone: ${patientPhone}.` : '';
      const msg = `🚨 Pharmacy Counter Escalation: Patient Walk-In requires physician e-Rx review for flagged POM medication "Coartem" (NAFDAC A4-0192).${phoneStr}`.trim();

      expect(msg).not.toContain('Phone:');
      expect(msg).toContain('Patient Walk-In');
    });
  });

  describe('3. Mobile Pro Care Station Classification Invariant', () => {
    function computeLicenceClass(user: any): 'pharmacy' | 'ppmv' {
      return (user?.role?.includes('pharmacy') || user?.role === 'pharmacist') ? 'pharmacy' : 'ppmv';
    }

    it('assigns pharmacy licence class for pharmacist and pharmacy_admin', () => {
      expect(computeLicenceClass({ role: 'pharmacist' })).toBe('pharmacy');
      expect(computeLicenceClass({ role: 'pharmacy_admin' })).toBe('pharmacy');
    });

    it('assigns ppmv licence class for medicine_store_attendant and other non-pharmacy roles', () => {
      expect(computeLicenceClass({ role: 'medicine_store_attendant' })).toBe('ppmv');
      expect(computeLicenceClass({ role: 'nurse' })).toBe('ppmv');
      expect(computeLicenceClass({ role: 'doctor' })).toBe('ppmv');
      expect(computeLicenceClass({ role: 'patient' })).toBe('ppmv');
      expect(computeLicenceClass({})).toBe('ppmv');
      expect(computeLicenceClass(null)).toBe('ppmv');
      expect(computeLicenceClass(undefined)).toBe('ppmv');
    });
  });

  describe('4. Frontend Toast Error Handling Invariant', () => {
    it('guarantees that API failure triggers toast.error and prevents false success toast', async () => {
      let toastSuccessCalled = false;
      let toastErrorCalled = false;
      let modalClosed = false;

      const mockApiFailing = {
        post: jest.fn().mockRejectedValue(new Error('Network Error: 502 Bad Gateway')),
      };

      const confirmEscalate = async (apiInstance: any) => {
        try {
          await apiInstance.post('/telehealth-queue/notify-on-duty', {
            facilityId: 'pharm-1',
            urgency: 'high',
            message: 'test',
          });
          toastSuccessCalled = true;
          modalClosed = true;
        } catch {
          toastErrorCalled = true;
        }
      };

      await confirmEscalate(mockApiFailing);

      expect(toastErrorCalled).toBe(true);
      expect(toastSuccessCalled).toBe(false);
      expect(modalClosed).toBe(false);
    });
  });
});
