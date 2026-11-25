import { UserRole } from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { PresenceService } from '../src/realtime/presence.service';
import { ZERO_EVIDENCE } from './support/prisma-evidence';

/**
 * Who did a finished visit, corrected from the console (the office,
 * 2026-11-25: Jobber completed a visit that still named the technician it was
 * booked for, and somebody else had done it). People and ids invented.
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

const REASON = 'Taylor did this visit, not Jordan.';

interface Member {
  id: string;
  current?: { id: string; technicianId: string } | null;
}

function build({
  status = 'COMPLETED',
  companionOf = null,
  visit = [{ id: 'inspection-1', current: { id: 'assignment-old', technicianId: 'technician-old' } }],
  technician = { id: 'technician-new' },
  current = null,
}: {
  status?: string;
  companionOf?: string | null;
  visit?: Member[];
  technician?: { id: string } | null;
  /** The requested inspection's assignment after the change, for a no-op answer. */
  current?: unknown;
} = {}) {
  const tx = {
    inspection: {
      findFirst: jest
        .fn()
        // The inspection asked about, then the push's read of its Jobber visit.
        .mockResolvedValueOnce({ status, jobberCompanionOfId: companionOf })
        .mockResolvedValue({ jobberVisitId: 'visit-9', jobberJobId: 'job-9' }),
      findMany: jest.fn().mockResolvedValue(
        visit.map((member) => ({ id: member.id, assignments: member.current ? [member.current] : [] })),
      ),
    },
    userProfile: { findFirst: jest.fn().mockResolvedValue(technician) },
    inspectionAssignment: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(({ data }: { data: { inspectionId: string } }) =>
        Promise.resolve({ id: `assignment-${data.inspectionId}`, ...data }),
      ),
      findFirst: jest.fn().mockResolvedValue(current),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({ id: 'task-1' }) },
  };
  const prisma = {
    ...ZERO_EVIDENCE,
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const events = { publish: jest.fn() };
  const invalidation = { publish: jest.fn().mockResolvedValue(undefined) };
  const mailer = { sendInspectionAssignment: jest.fn() };
  const service = new AdminService(
    prisma as never,
    new PresenceService(),
    events as never,
    undefined,
    invalidation as never,
    undefined,
    mailer as never,
  );
  return { service, tx, prisma, events, invalidation, mailer };
}

const pushedFor = (tx: ReturnType<typeof build>['tx']) =>
  tx.jobberOutboundTask.upsert.mock.calls.map((call) => ({
    inspectionId: call[0].where.organizationId_inspectionId_kind.inspectionId,
    kind: call[0].where.organizationId_inspectionId_kind.kind,
  }));

describe('changing who did a finished visit', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('replaces the technician, keeps the old one in the history, audits both and tells Jobber', async () => {
    const { service, tx, events, invalidation, mailer } = build();

    const result = await service.changeDoneTechnician(user, 'inspection-1', {
      technicianId: 'technician-new',
      reason: REASON,
    });

    expect(tx.inspectionAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment-old' },
      data: expect.objectContaining({
        isCurrent: false,
        status: 'REASSIGNED',
        endedById: user.id,
        reason: REASON,
      }),
    });
    expect(tx.inspectionAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          inspectionId: 'inspection-1',
          technicianId: 'technician-new',
          assignedById: user.id,
          supersedesId: 'assignment-old',
          reason: REASON,
        },
      }),
    );
    expect(result).toMatchObject({ inspectionId: 'inspection-1', technicianId: 'technician-new' });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'INSPECTION_TECHNICIAN_CHANGED_AFTER_VISIT',
        entityId: 'inspection-1',
        actorUserId: user.id,
        metadata: expect.objectContaining({
          previousTechnicianId: 'technician-old',
          technicianId: 'technician-new',
          reason: REASON,
        }),
      }),
    });
    expect(pushedFor(tx)).toEqual([{ inspectionId: 'inspection-1', kind: 'VISIT_ASSIGN' }]);
    expect(invalidation.publish).toHaveBeenCalledTimes(1);
    // The visit is over: nobody is sent to it, so nobody is told it is theirs.
    expect(events.publish).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mailer.sendInspectionAssignment).not.toHaveBeenCalled();
  });

  it('names somebody on a finished visit that had nobody', async () => {
    const { service, tx } = build({ visit: [{ id: 'inspection-1', current: null }] });

    await service.changeDoneTechnician(user, 'inspection-1', { technicianId: 'technician-new', reason: REASON });

    expect(tx.inspectionAssignment.update).not.toHaveBeenCalled();
    expect(tx.inspectionAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ supersedesId: null }) }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ previousTechnicianId: null, previousAssignmentId: null }),
      }),
    });
  });

  it.each(['SCHEDULED', 'IN_PROGRESS', 'FOLLOW_UP_REQUIRED', 'CANCELLED'])(
    'refuses a visit that is %s, which Reassign is for',
    async (status) => {
      const { service, tx } = build({ status });

      await expect(
        service.changeDoneTechnician(user, 'inspection-1', { technicianId: 'technician-new', reason: REASON }),
      ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_NOT_DONE' });
      expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
    },
  );

  it('accepts every done status, a submitted visit as much as a completed one', async () => {
    for (const status of ['TECHNICIAN_SUBMITTED', 'UNDER_REVIEW', 'COMPLETED']) {
      const { service, tx } = build({ status });
      await service.changeDoneTechnician(user, 'inspection-1', { technicianId: 'technician-new', reason: REASON });
      expect(tx.inspectionAssignment.create).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses anyone who is not an active technician of the organization', async () => {
    const { service, tx } = build({ technician: null });

    await expect(
      service.changeDoneTechnician(user, 'inspection-1', { technicianId: 'someone', reason: REASON }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_ACTIVE_TECHNICIAN' });
    expect(tx.userProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'someone',
          isActive: true,
          memberships: { some: { organizationId: user.organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
        }),
      }),
    );
    expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
  });

  it('reads the inspection inside the caller’s organization only', async () => {
    const { service, tx } = build();
    tx.inspection.findFirst.mockReset().mockResolvedValue(null);

    await expect(
      service.changeDoneTechnician(user, 'inspection-elsewhere', { technicianId: 'technician-new', reason: REASON }),
    ).rejects.toMatchObject({ status: 404, code: 'INSPECTION_NOT_FOUND' });
    expect(tx.inspection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inspection-elsewhere', organizationId: user.organizationId } }),
    );
  });

  it('changes nothing when asked for the technician already on it', async () => {
    const on = { id: 'assignment-new', technicianId: 'technician-new' };
    const { service, tx, invalidation } = build({
      visit: [{ id: 'inspection-1', current: on }],
      current: on,
    });

    await expect(
      service.changeDoneTechnician(user, 'inspection-1', { technicianId: 'technician-new', reason: REASON }),
    ).resolves.toBe(on);
    expect(tx.inspectionAssignment.update).not.toHaveBeenCalled();
    expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
    expect(invalidation.publish).not.toHaveBeenCalled();
  });

  it('changes the other done inspection booked on the same Jobber visit, and tells Jobber once', async () => {
    // Asked on the companion: the holder has the Jobber visit.
    const { service, tx } = build({
      companionOf: 'inspection-holder',
      visit: [
        { id: 'inspection-holder', current: { id: 'assignment-h', technicianId: 'technician-old' } },
        { id: 'inspection-1', current: { id: 'assignment-c', technicianId: 'technician-old' } },
      ],
    });

    const result = await service.changeDoneTechnician(user, 'inspection-1', {
      technicianId: 'technician-new',
      reason: REASON,
    });

    // Only the visit's done inspections: an open one follows the visit through the sync.
    expect(tx.inspection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: user.organizationId,
          OR: [{ id: 'inspection-holder' }, { jobberCompanionOfId: 'inspection-holder' }],
          status: { in: expect.arrayContaining(['TECHNICIAN_SUBMITTED', 'COMPLETED']) },
        }),
      }),
    );
    expect(tx.inspectionAssignment.create).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ inspectionId: 'inspection-1' });
    expect(tx.auditLog.create.mock.calls.map((call) => call[0].data.entityId)).toEqual([
      'inspection-holder',
      'inspection-1',
    ]);
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ changedWith: 'inspection-1' });
    expect(pushedFor(tx)).toEqual([{ inspectionId: 'inspection-holder', kind: 'VISIT_ASSIGN' }]);
  });

  it('does not tell Jobber when the inspection holding the visit is still open', async () => {
    // The holder is left out by the status filter; only the done companion changes.
    const { service, tx } = build({
      companionOf: 'inspection-holder',
      visit: [{ id: 'inspection-1', current: { id: 'assignment-c', technicianId: 'technician-old' } }],
    });

    await service.changeDoneTechnician(user, 'inspection-1', { technicianId: 'technician-new', reason: REASON });

    expect(tx.inspectionAssignment.create).toHaveBeenCalledTimes(1);
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('queues nothing for Jobber while console edits are not pushed', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'false';
    const { service, tx } = build();

    await service.changeDoneTechnician(user, 'inspection-1', { technicianId: 'technician-new', reason: REASON });

    expect(tx.inspectionAssignment.create).toHaveBeenCalledTimes(1);
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });
});
