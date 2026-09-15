import { UserRole } from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { PresenceService } from '../src/realtime/presence.service';
import { ZERO_EVIDENCE } from './support/prisma-evidence';

/**
 * Changes made in the console to a visit Jobber already has are queued for
 * Jobber, when the console's edits are pushed. People and ids invented.
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-coordinator',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Coordinator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const JOBBER_VISIT = { jobberVisitId: 'visit-9', jobberJobId: 'job-9' };

const existing = (overrides: Record<string, unknown> = {}) => ({
  id: 'inspection-1',
  status: 'SCHEDULED',
  propertywareBuildingId: 'property-1',
  propertywareUnitId: null,
  inspectionType: 'MOVE_IN',
  scheduledAt: new Date('2026-10-02T00:00:00.000Z'),
  // 9:00 to 10:30 in Texas (CDT) on the 2nd.
  scheduledStartAt: new Date('2026-10-02T14:00:00.000Z'),
  scheduledEndAt: new Date('2026-10-02T15:30:00.000Z'),
  jobberVisitId: 'visit-9',
  ...overrides,
});

function build(inspection: ReturnType<typeof existing>) {
  const tx = {
    inspection: {
      // The reschedule clash check first (no clash), then the push's own read.
      findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(JOBBER_VISIT),
      update: jest.fn().mockResolvedValue(inspection),
    },
    inspectionAssignment: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    jobberOutboundTask: {
      upsert: jest.fn().mockResolvedValue({ id: 'task-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    ...ZERO_EVIDENCE,
    inspection: { findFirst: jest.fn().mockResolvedValue(inspection) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  return { service: new AdminService(prisma as never, new PresenceService()), tx, prisma };
}

const queuedKinds = (tx: ReturnType<typeof build>['tx']) =>
  tx.jobberOutboundTask.upsert.mock.calls.map((call) => call[0].where.organizationId_inspectionId_kind.kind);

describe('console changes to a Jobber visit, when they are pushed', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.JOBBER_BOOKING_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('moves the visit to a new day at the same Texas times, and queues it for Jobber', async () => {
    const { service, tx } = build(existing());

    await service.updateInspection(user, 'inspection-1', { scheduledAt: '2026-10-09T00:00:00.000Z' });

    const data = tx.inspection.update.mock.calls[0][0].data;
    expect(data.scheduledAt).toEqual(new Date('2026-10-09T00:00:00.000Z'));
    expect(data.scheduledStartAt).toEqual(new Date('2026-10-09T14:00:00.000Z'));
    expect(data.scheduledEndAt).toEqual(new Date('2026-10-09T15:30:00.000Z'));
    expect(queuedKinds(tx)).toEqual(['VISIT_RESCHEDULE']);
  });

  it('queues nothing for the same day, which the edit form always sends back', async () => {
    const { service, tx } = build(existing());
    await service.updateInspection(user, 'inspection-1', { scheduledAt: '2026-10-02T00:00:00.000Z', priority: 'HIGH' });
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('queues the cancellation of a Jobber visit', async () => {
    const { service, tx } = build(existing());
    tx.inspection.findFirst = jest.fn().mockResolvedValue(JOBBER_VISIT);

    await service.updateInspection(user, 'inspection-1', { status: 'CANCELLED', cancellationReason: 'Tenant left early' });

    expect(queuedKinds(tx)).toEqual(['VISIT_CANCEL']);
  });

  it('writes the edited Details and queues them, auditing only that they changed', async () => {
    const { service, tx } = build(existing());
    tx.inspection.findFirst = jest.fn().mockResolvedValue(JOBBER_VISIT);

    await service.updateJobberVisit(user, 'inspection-1', {
      title: ' 100 Main St - Zone 3 - Move in Inspection ',
      details: 'Gate Code: 4321',
    });

    expect(tx.inspection.update).toHaveBeenCalledWith({
      where: { id: 'inspection-1' },
      data: { jobberVisitTitle: '100 Main St - Zone 3 - Move in Inspection', jobberVisitDetails: 'Gate Code: 4321' },
    });
    expect(queuedKinds(tx)).toEqual(['VISIT_EDIT']);
    const audit = tx.auditLog.create.mock.calls.map((call) => call[0].data).find((row) => row.action === 'JOBBER_VISIT_EDITED');
    expect(audit.metadata).toEqual({ titleChanged: true });
  });

  it('refuses to edit a visit an inspection does not have', async () => {
    const { service } = build(existing({ jobberVisitId: null }));
    await expect(
      service.updateJobberVisit(user, 'inspection-1', { details: 'Anything' }),
    ).rejects.toMatchObject({ status: 409, code: 'NO_JOBBER_VISIT' });
  });

  it('edits a booking not yet sent without queueing anything: the booking carries it', async () => {
    const { service, tx } = build(existing({ jobberVisitId: null }));
    tx.jobberOutboundTask.findFirst.mockResolvedValue({ id: 'booking-1' });
    tx.inspection.findFirst = jest.fn().mockResolvedValue({ jobberVisitId: null, jobberJobId: null });

    await service.updateJobberVisit(user, 'inspection-1', { details: 'Gate Code: 4321' });

    expect(tx.inspection.update).toHaveBeenCalled();
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });
});

describe('console changes to a Jobber visit, when they are not pushed', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    delete process.env.JOBBER_BOOKING_ENABLED;
    delete process.env.JOBBER_PUSH_EDITS_ENABLED;
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('still refuses a new date, and says where to change it', async () => {
    const { service, prisma } = build(existing());
    await expect(
      service.updateInspection(user, 'inspection-1', { scheduledAt: '2026-10-09T00:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_IN_JOBBER' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cancels here without touching Jobber', async () => {
    const { service, tx } = build(existing());
    await service.updateInspection(user, 'inspection-1', { status: 'CANCELLED', cancellationReason: 'Tenant left early' });
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('refuses to edit the Details of a visit Jobber has', async () => {
    const { service } = build(existing());
    await expect(
      service.updateJobberVisit(user, 'inspection-1', { details: 'Anything' }),
    ).rejects.toMatchObject({ status: 409, code: 'JOBBER_EDITS_OFF' });
  });
});
