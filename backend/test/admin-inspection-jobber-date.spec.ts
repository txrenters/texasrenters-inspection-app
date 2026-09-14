import { UserRole } from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { PresenceService } from '../src/realtime/presence.service';
import { ZERO_EVIDENCE } from './support/prisma-evidence';

/**
 * A Jobber visit is rescheduled in Jobber.
 *
 * Jobber is the scheduling source of record, and its sync copies the visit's
 * date over any inspection still scheduled here whose date differs. So a date
 * changed in the console did not stay changed. 10118 Mariposa Green Ct's move-in
 * was re-dated at 1:28 PM and was back on Jobber's date at 1:30, with nothing on
 * the page to say that would happen.
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-property-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Property Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const visit = (overrides: Record<string, unknown> = {}) => ({
  id: 'inspection-1',
  status: 'SCHEDULED',
  propertywareBuildingId: 'property-1',
  propertywareUnitId: null,
  inspectionType: 'MOVE_IN',
  scheduledAt: new Date('2026-10-02T00:00:00.000Z'),
  jobberVisitId: 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzE=',
  ...overrides,
});

function build(existing: ReturnType<typeof visit>) {
  const tx = {
    inspection: {
      // No clashing booking on the new day.
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(existing),
    },
    inspectionAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...ZERO_EVIDENCE,
    inspection: { findFirst: jest.fn().mockResolvedValue(existing) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const service = new AdminService(prisma as never, new PresenceService());
  return { service, prisma, tx };
}

describe('changing the date of an inspection from the console', () => {
  it('refuses a new date for a Jobber visit, and says where to change it', async () => {
    const { service, prisma, tx } = build(visit());

    await expect(
      service.updateInspection(user, 'inspection-1', { scheduledAt: '2023-08-21T00:00:00.000Z' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'SCHEDULED_IN_JOBBER',
      message: expect.stringContaining('Change its date in Jobber'),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.inspection.update).not.toHaveBeenCalled();
  });

  it('accepts the same day, which the edit form sends back with every save', async () => {
    // The form always posts the date. Refusing an unchanged one would make a
    // Jobber visit's notes and priority impossible to edit.
    const { service, tx } = build(visit());

    await service.updateInspection(user, 'inspection-1', {
      scheduledAt: '2026-10-02T00:00:00.000Z',
      priority: 'HIGH',
    });

    expect(tx.inspection.update).toHaveBeenCalledTimes(1);
  });

  it('still reschedules an inspection this app scheduled itself', async () => {
    const { service, tx } = build(visit({ jobberVisitId: null }));

    await service.updateInspection(user, 'inspection-1', { scheduledAt: '2026-10-09T00:00:00.000Z' });

    expect(tx.inspection.update.mock.calls[0][0].data.scheduledAt).toEqual(
      new Date('2026-10-09T00:00:00.000Z'),
    );
  });
});

describe('the inspection detail', () => {
  const detail = (jobberVisitId: string | null) => ({
    id: 'inspection-1',
    status: 'SCHEDULED',
    inspectionType: 'MOVE_IN',
    scheduledAt: new Date('2026-10-02T00:00:00.000Z'),
    jobberVisitId,
    propertywareBuilding: null,
    propertywareUnit: null,
    propertywareLease: null,
    assignments: [],
    _count: { areas: 0, findings: 0 },
  });

  it('says whether the date is Jobber’s, without handing over Jobber’s identifier', async () => {
    const { service } = build(visit());
    const prisma = (service as unknown as { prisma: { inspection: { findFirst: jest.Mock } } }).prisma;
    prisma.inspection.findFirst.mockResolvedValue(detail('Z2lkOi8vSm9iYmVyL1Zpc2l0LzE='));

    const scheduledInJobber = await service.inspection(user, 'inspection-1');

    expect(scheduledInJobber).toMatchObject({ scheduledInJobber: true });
    expect(scheduledInJobber).not.toHaveProperty('jobberVisitId');
    expect(prisma.inspection.findFirst.mock.calls[0][0].select).toMatchObject({ jobberVisitId: true });
  });

  it('is false for an inspection scheduled here', async () => {
    const { service } = build(visit());
    const prisma = (service as unknown as { prisma: { inspection: { findFirst: jest.Mock } } }).prisma;
    prisma.inspection.findFirst.mockResolvedValue(detail(null));

    await expect(service.inspection(user, 'inspection-1')).resolves.toMatchObject({
      scheduledInJobber: false,
    });
  });
});
