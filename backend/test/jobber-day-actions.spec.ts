import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { JobberDayActionsService } from '../src/integrations/jobber/jobber-day-actions.service';

/**
 * The actions on the day's comparison against Jobber (console-development,
 * 2026-10-09). What matters is what they refuse, and that every write goes
 * through the integration's own queue or sync rather than to Jobber.
 */

const ORG = '10000000-0000-4000-8000-000000000001';
const INSPECTION = '20000000-0000-4000-8000-000000000001';

function user(permissions: string[] = ['inspections:manage']): AuthenticatedUser {
  return {
    id: '10000000-0000-4000-8000-000000000002',
    authUserId: 'auth-office',
    organizationId: ORG,
    displayName: 'Office',
    roles: [UserRole.PROPERTY_ADMIN],
    permissions,
    mustChangePassword: false,
    principalType: 'USER',
  } as AuthenticatedUser;
}

function setup({
  inspection = { status: 'SCHEDULED', source: 'JOBBER', jobberVisitId: 'v-1', jobberJobId: 'j-1' },
  waiting = [] as Array<{ id: string; kind: string }>,
  completion = null as null | { id: string; status: string; sentAt: Date | null },
  connection = 'CONNECTED',
  importRow = { status: 'IMPORTED', inspectionId: INSPECTION, failureCode: null, failureMessage: null } as Record<string, unknown> | null,
} = {}) {
  const prisma: Record<string, any> = {
    inspection: { findFirst: jest.fn().mockResolvedValue(inspection), update: jest.fn() },
    jobberOutboundTask: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue(waiting),
      deleteMany: jest.fn().mockResolvedValue({ count: waiting.length }),
      findFirst: jest.fn().mockResolvedValue(completion),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    jobberConnection: { findUnique: jest.fn().mockResolvedValue(connection ? { status: connection } : null) },
    jobberVisitImport: { findFirst: jest.fn().mockResolvedValue(importRow) },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const sync = { syncVisit: jest.fn().mockResolvedValue({ visitsSeen: 1 }) };
  const service = new JobberDayActionsService(prisma as never, sync as never);
  const audits = () => prisma.auditLog.create.mock.calls.map((call: any[]) => call[0].data.action);
  return { prisma, sync, service, audits };
}

const saved = { push: process.env.JOBBER_PUSH_EDITS_ENABLED, booking: process.env.JOBBER_BOOKING_ENABLED };
const pushes = (on: boolean) => {
  process.env.JOBBER_PUSH_EDITS_ENABLED = on ? 'true' : 'false';
};
afterEach(() => {
  process.env.JOBBER_PUSH_EDITS_ENABLED = saved.push;
  process.env.JOBBER_BOOKING_ENABLED = saved.booking;
  if (saved.push === undefined) delete process.env.JOBBER_PUSH_EDITS_ENABLED;
  if (saved.booking === undefined) delete process.env.JOBBER_BOOKING_ENABLED;
});

describe('push our time to Jobber', () => {
  it('is refused while pushes are switched off, and queues nothing', async () => {
    pushes(false);
    const { service, prisma } = setup();

    await expect(service.push(user(), INSPECTION)).rejects.toMatchObject({ code: 'JOBBER_PUSHES_OFF' });
    expect(prisma.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('only for a visit still to happen', async () => {
    pushes(true);
    const { service } = setup({ inspection: { status: 'TECHNICIAN_SUBMITTED', source: 'JOBBER', jobberVisitId: 'v-1', jobberJobId: 'j-1' } });

    await expect(service.push(user(), INSPECTION)).rejects.toMatchObject({ code: 'INSPECTION_NOT_OPEN' });
  });

  it('sends the technician only with the Assign permission', async () => {
    pushes(true);
    const { service, prisma } = setup();

    await expect(service.push(user(['inspections:manage']), INSPECTION, true)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(prisma.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('queues the reschedule (and the assignment when asked) through the edit queue, audited', async () => {
    pushes(true);
    const { service, prisma, audits } = setup();

    const result = await service.push(user(['inspections:manage', 'inspections:assign']), INSPECTION, true);

    expect(result.queued).toEqual(['VISIT_RESCHEDULE', 'VISIT_ASSIGN']);
    const kinds = prisma.jobberOutboundTask.upsert.mock.calls.map((call: any[]) => call[0].create.kind);
    expect(kinds).toEqual(['VISIT_RESCHEDULE', 'VISIT_ASSIGN']);
    expect(audits()).toEqual(['JOBBER_PUSH_REQUESTED']);
  });

  it('needs a Jobber visit to push to', async () => {
    pushes(true);
    const { service } = setup({ inspection: { status: 'SCHEDULED', source: 'MANUAL', jobberVisitId: null as never, jobberJobId: null as never } });

    await expect(service.push(user(), INSPECTION)).rejects.toMatchObject({ code: 'NOT_IN_JOBBER' });
  });
});

describe("take Jobber's time", () => {
  it('withdraws nothing when Jobber is not connected', async () => {
    const { service, prisma, sync } = setup({ connection: 'DISCONNECTED', waiting: [{ id: 't-1', kind: 'VISIT_RESCHEDULE' }] });

    await expect(service.takeJobber(user(), INSPECTION)).rejects.toMatchObject({ code: 'JOBBER_NOT_CONNECTED' });
    expect(prisma.jobberOutboundTask.deleteMany).not.toHaveBeenCalled();
    expect(sync.syncVisit).not.toHaveBeenCalled();
  });

  it('withdraws our queued edit, audited as the sync does, then reads the one visit again', async () => {
    const { service, prisma, sync, audits } = setup({ waiting: [{ id: 't-1', kind: 'VISIT_RESCHEDULE' }] });

    const result = await service.takeJobber(user(), INSPECTION);

    expect(result.withdrawn).toEqual(['VISIT_RESCHEDULE']);
    expect(audits()).toEqual(['JOBBER_CONSOLE_EDIT_WITHDRAWN']);
    expect(sync.syncVisit).toHaveBeenCalledWith(ORG, 'v-1');
    expect(prisma.jobberOutboundTask.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      sync.syncVisit.mock.invocationCallOrder[0],
    );
  });

  it('never withdraws a queued cancellation', async () => {
    const { service, prisma } = setup();

    await service.takeJobber(user(), INSPECTION);

    const kinds = prisma.jobberOutboundTask.findMany.mock.calls[0][0].where.kind.in;
    expect(kinds).not.toContain('VISIT_CANCEL');
  });
});

describe('create the inspection for a Jobber-only visit', () => {
  it('will not touch a visit that is not an inspection, or one the office ignored', async () => {
    const { service, sync } = setup({ importRow: { status: 'IGNORED', inspectionId: null } });

    await expect(service.createFromVisit(user(), 'v-9')).rejects.toMatchObject({ code: 'JOBBER_VISIT_NOT_AN_INSPECTION' });
    expect(sync.syncVisit).not.toHaveBeenCalled();
  });

  it('answers with the inspection already made, without reading Jobber', async () => {
    const { service, sync } = setup();

    await expect(service.createFromVisit(user(), 'v-1')).resolves.toMatchObject({ inspectionId: INSPECTION });
    expect(sync.syncVisit).not.toHaveBeenCalled();
  });

  it('reads a waiting visit again through the sync, which decides', async () => {
    const { service, sync, audits } = setup({
      importRow: { status: 'UNMATCHED_PROPERTY', inspectionId: null, failureCode: null, failureMessage: 'Not linked' },
    });

    const result = await service.createFromVisit(user(), 'v-9');

    expect(sync.syncVisit).toHaveBeenCalledWith(ORG, 'v-9');
    expect(audits()).toEqual(['JOBBER_IMPORT_REQUESTED']);
    expect(result.status).toBe('UNMATCHED_PROPERTY');
  });
});

describe('cancel in Jobber', () => {
  it('only once the inspection is cancelled here', async () => {
    pushes(true);
    const { service } = setup();

    await expect(service.cancelInJobber(user(), INSPECTION)).rejects.toMatchObject({ code: 'INSPECTION_NOT_CANCELLED' });
  });

  it('queues the cancel task and leaves the inspection itself untouched', async () => {
    pushes(true);
    const { service, prisma, audits } = setup({ inspection: { status: 'CANCELLED', source: 'JOBBER', jobberVisitId: 'v-1', jobberJobId: 'j-1' } });

    await service.cancelInJobber(user(), INSPECTION);

    expect(prisma.jobberOutboundTask.upsert.mock.calls[0][0].create.kind).toBe('VISIT_CANCEL');
    // No cancellation reason is written: a Jobber-prefixed one makes the sync delete the inspection.
    expect(prisma.inspection.update).not.toHaveBeenCalled();
    expect(audits()).toEqual(['JOBBER_CANCEL_REQUESTED']);
  });
});

describe('complete in Jobber', () => {
  const done = { status: 'TECHNICIAN_SUBMITTED', source: 'JOBBER', jobberVisitId: 'v-1', jobberJobId: 'j-1' };

  it('only for a visit that came from Jobber and is finished here', async () => {
    await expect(setup().service.completeInJobber(user(), INSPECTION)).rejects.toMatchObject({ code: 'INSPECTION_NOT_DONE' });
    await expect(
      setup({ inspection: { ...done, source: 'MANUAL' } }).service.completeInJobber(user(), INSPECTION),
    ).rejects.toMatchObject({ code: 'NOT_BOOKED_FROM_JOBBER' });
  });

  it('queues the completion when there never was one', async () => {
    const { service, prisma } = setup({ inspection: done });

    await expect(service.completeInJobber(user(), INSPECTION)).resolves.toEqual({ outcome: 'queued' });
    expect(prisma.jobberOutboundTask.create.mock.calls[0][0].data.kind).toBe('VISIT_COMPLETED');
  });

  it('re-arms one the worker gave up on', async () => {
    const { service, prisma } = setup({ inspection: done, completion: { id: 'c-1', status: 'ABANDONED', sentAt: null } });

    await expect(service.completeInJobber(user(), INSPECTION)).resolves.toEqual({ outcome: 'retried' });
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: expect.objectContaining({ status: 'PENDING', attempts: 0 }),
    });
  });

  it('does not resend one Jobber already received', async () => {
    const { service, prisma } = setup({ inspection: done, completion: { id: 'c-1', status: 'SENT', sentAt: new Date() } });

    await expect(service.completeInJobber(user(), INSPECTION)).rejects.toMatchObject({ code: 'JOBBER_ALREADY_TOLD' });
    expect(prisma.jobberOutboundTask.update).not.toHaveBeenCalled();
  });
});
