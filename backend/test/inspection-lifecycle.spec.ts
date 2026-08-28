import { InspectionStatus } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import { PresenceService } from '../src/realtime/presence.service';
import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Administrator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
};

const technician: AuthenticatedUser = {
  ...admin,
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
};

function reviewableInspection(status: InspectionStatus = InspectionStatus.REVIEW_REQUIRED) {
  return { id: 'insp-1', status, propertywareBuildingId: null, propertywareUnitId: null };
}

describe('inspection status lifecycle (spec §11)', () => {
  it('technician submission sets TECHNICIAN_SUBMITTED, never COMPLETED', async () => {
    const record = {
      id: 'insp-1',
      inspectionType: 'MOVE_OUT',
      baselineInspectionId: null,
      baselineInspection: null,
      scheduledAt: new Date('2026-07-25T09:00:00.000Z'),
      status: InspectionStatus.IN_PROGRESS,
      priority: 'STANDARD',
      internalNotes: null,
      propertywareUnit: null,
      propertywareBuilding: {
        id: 'b1',
        name: 'Building',
        addressLine1: '1 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      },
      areas: [],
    };
    const advanceInspection = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue(record),
        update: jest
          .fn()
          .mockResolvedValue({ ...record, status: InspectionStatus.TECHNICIAN_SUBMITTED }),
      },
      inspectionArea: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      { queue: jest.fn(), advanceInspection } as never,
    );

    await service.completeInspection(technician, 'insp-1');

    expect(prisma.inspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'insp-1' },
        data: expect.objectContaining({
          status: InspectionStatus.TECHNICIAN_SUBMITTED,
          submittedAt: expect.any(Date),
        }),
      }),
    );
    // Submission must not stamp completion.
    expect(prisma.inspection.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: InspectionStatus.COMPLETED }),
      }),
    );
    expect(advanceInspection).toHaveBeenCalledWith('insp-1');
  });

  it('blocks finalization while findings await review unless an override is documented', async () => {
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(reviewableInspection()) },
      inspectionFinding: {
        findMany: jest.fn().mockResolvedValue([
          { title: 'Cracked tile', propertyArea: { name: 'Kitchen' } },
          { title: 'Scuffed baseboard', propertyArea: { name: 'Hall' } },
        ]),
      },
      inspectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    const service = new AdminService(prisma as never, new PresenceService());

    await expect(service.finalizeInspection(admin, 'insp-1', {})).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_HAS_UNRESOLVED_ITEMS',
      // Names what is blocking, and says nothing about the zero recordings —
      // the old wording printed both counts and left the reviewer to work out
      // which half mattered.
      message: expect.stringContaining('Kitchen — Cracked tile'),
    });
    await expect(service.finalizeInspection(admin, 'insp-1', {})).rejects.not.toMatchObject({
      message: expect.stringContaining('recording'),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();

    // The room condition summary must never be one of the counted rows: it is
    // narrative, the review screen hides it, and an administrator has no
    // control that clears it.
    const [[query]] = prisma.inspectionFinding.findMany.mock.calls;
    expect(query.where.NOT).toEqual({ findingType: 'NO_CHANGE', title: 'Room condition summary' });
  });

  it('finalizes with a documented override, recording the finalizer and audit trail', async () => {
    const tx = {
      inspection: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const detail = { id: 'insp-1', status: InspectionStatus.COMPLETED };
    const prisma = {
      inspection: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(reviewableInspection())
          .mockResolvedValueOnce(detail),
      },
      inspectionFinding: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ title: 'Cracked tile', propertyArea: { name: 'Kitchen' } }]),
      },
      inspectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new AdminService(prisma as never, new PresenceService());

    await expect(
      service.finalizeInspection(admin, 'insp-1', { overrideReason: 'Owner approved closure' }),
    ).resolves.toBe(detail);
    expect(tx.inspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'insp-1' },
        data: expect.objectContaining({
          status: InspectionStatus.COMPLETED,
          finalizedById: admin.id,
          finalizedAt: expect.any(Date),
          completedAt: expect.any(Date),
          followUpRequired: false,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'INSPECTION_FINALIZED',
          metadata: expect.objectContaining({
            override: true,
            overrideReason: 'Owner approved closure',
          }),
        }),
      }),
    );
  });

  it('rejects finalizing an inspection the technician has not submitted', async () => {
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue(reviewableInspection(InspectionStatus.SCHEDULED)),
      },
      inspectionFinding: { count: jest.fn() },
      inspectionMedia: { count: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new AdminService(prisma as never, new PresenceService());

    await expect(service.finalizeInspection(admin, 'insp-1', {})).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_NOT_REVIEWABLE',
    });
    expect(prisma.inspectionFinding.count).not.toHaveBeenCalled();
  });

  it('marks an inspection TBD with a reason and audit event', async () => {
    const tx = {
      inspection: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(reviewableInspection())
          .mockResolvedValueOnce({ id: 'insp-1', status: InspectionStatus.TBD }),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new AdminService(prisma as never, new PresenceService());

    await service.markInspectionTbd(admin, 'insp-1', { reason: 'Awaiting owner response' });
    expect(tx.inspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: InspectionStatus.TBD,
          tbdReason: 'Awaiting owner response',
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'INSPECTION_MARKED_TBD' }),
      }),
    );
  });

  it('requires a follow-up with a planned date and tasks', async () => {
    const tx = {
      inspection: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(reviewableInspection())
          .mockResolvedValueOnce({ id: 'insp-1', status: InspectionStatus.FOLLOW_UP_REQUIRED }),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new AdminService(prisma as never, new PresenceService());

    await service.requireInspectionFollowUp(admin, 'insp-1', {
      dueAt: '2026-08-01T00:00:00.000Z',
      tasks: 'Re-check the roof',
      reason: 'Weather blocked access',
    });
    expect(tx.inspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: InspectionStatus.FOLLOW_UP_REQUIRED,
          followUpRequired: true,
          followUpDueAt: expect.any(Date),
          followUpTasks: 'Re-check the roof',
        }),
      }),
    );
  });

  function reopenPrisma(from: InspectionStatus, currentAssignments = 1, updated = 1) {
    const tx = {
      inspection: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(reviewableInspection(from))
          .mockResolvedValueOnce({ id: 'insp-1', status: InspectionStatus.IN_PROGRESS }),
      },
      // findMany, not count: reopen needs the technician ids so it can tell
      // each of them, which a count cannot address.
      inspectionAssignment: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: currentAssignments }, (_, index) => ({
            technicianId: `tech-${index + 1}`,
          })),
        ),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return { tx, prisma };
  }

  it('tells every assigned technician, in real time', async () => {
    /**
     * The gap this closes. Reopen published only a cache invalidation, which
     * refreshes the web console and reaches nobody in the field: the inspection
     * reappeared in the technician's queue on their next sixty-second poll,
     * with no signal and no explanation. Every other admin action that moves
     * work already publishes here.
     */
    const { prisma } = reopenPrisma(InspectionStatus.TECHNICIAN_SUBMITTED, 2);
    const technicianEvents = { publish: jest.fn() };
    const service = new AdminService(prisma as never, new PresenceService(), technicianEvents as never);

    await service.reopenInspection(admin, 'insp-1', { reason: 'Garage was never captured' });

    expect(technicianEvents.publish).toHaveBeenCalledTimes(2);
    expect(technicianEvents.publish).toHaveBeenCalledWith('tech-1', 'insp-1', 'REOPENED');
    expect(technicianEvents.publish).toHaveBeenCalledWith('tech-2', 'insp-1', 'REOPENED');
  });

  it('stores the reason where the technician can read it', async () => {
    // It used to live only in the audit metadata, which no technician endpoint
    // reads — so the office had to phone them.
    const { tx, prisma } = reopenPrisma(InspectionStatus.COMPLETED);
    const service = new AdminService(prisma as never, new PresenceService());

    await service.reopenInspection(admin, 'insp-1', { reason: '  Garage was never captured  ' });

    const [{ data }] = tx.inspection.updateMany.mock.calls[0];
    expect(data.reopenReason).toBe('Garage was never captured');
  });

  it('reopens a finalized inspection back to IN_PROGRESS', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.COMPLETED);
    const service = new AdminService(prisma as never, new PresenceService());

    await service.reopenInspection(admin, 'insp-1', { reason: 'Garage was never captured' });

    // IN_PROGRESS is the only status that puts the inspection back in the
    // technician's queue.
    const [{ data, where }] = tx.inspection.updateMany.mock.calls[0];
    expect(data.status).toBe(InspectionStatus.IN_PROGRESS);
    // The finalization stamp OUTLIVES the reopen. Two guards — technician
    // photo deletion and renaming a technician-created area — key on it, and
    // nulling it would let a technician hard-delete evidence out of an
    // inspection that had already been finalized and possibly shared.
    expect(data).not.toHaveProperty('finalizedAt');
    expect(data).not.toHaveProperty('finalizedById');
    expect(data).not.toHaveProperty('completedAt');
    // Re-asserted in the WHERE clause: the status check ran outside this
    // transaction, so a concurrent finalize could otherwise slip in between.
    expect(where.status.in).toContain(InspectionStatus.COMPLETED);
    expect(where.status.in).not.toContain(InspectionStatus.CANCELLED);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'INSPECTION_REOPENED' }),
      }),
    );
  });

  it('scopes the lookup to the caller’s organization', async () => {
    const { prisma } = reopenPrisma(InspectionStatus.COMPLETED);
    const service = new AdminService(prisma as never, new PresenceService());

    await service.reopenInspection(admin, 'insp-1', { reason: 'Another area' });

    expect(prisma.inspection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'insp-1', organizationId: admin.organizationId }),
      }),
    );
  });

  it('records the reason against the actor, which is the point of requiring it', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.COMPLETED);
    const service = new AdminService(prisma as never, new PresenceService());

    await service.reopenInspection(admin, 'insp-1', { reason: 'Garage was never captured' });

    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: admin.id,
          metadata: expect.objectContaining({
            reason: 'Garage was never captured',
            wasFinalized: true,
            fromStatus: InspectionStatus.COMPLETED,
          }),
        }),
      }),
    );
  });

  it('refuses, and writes no audit row, when the status changed mid-transaction', async () => {
    // updateMany matching nothing means a concurrent transition won the race.
    const { tx, prisma } = reopenPrisma(InspectionStatus.COMPLETED, 1, 0);
    const service = new AdminService(prisma as never, new PresenceService());

    await expect(
      service.reopenInspection(admin, 'insp-1', { reason: 'One more room' }),
    ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_NOT_REOPENABLE' });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('reopens from a mid-review state without clearing the administrator determination', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.FOLLOW_UP_REQUIRED);
    const service = new AdminService(prisma as never, new PresenceService());

    await service.reopenInspection(admin, 'insp-1', { reason: 'Re-shoot the roof' });

    // Reopening is how a follow-up gets actioned, not proof it is resolved:
    // clearing the determination would destroy why the inspection was held.
    const [{ data }] = tx.inspection.updateMany.mock.calls[0];
    expect(data.status).toBe(InspectionStatus.IN_PROGRESS);
    expect(data).not.toHaveProperty('followUpRequired');
    expect(data).not.toHaveProperty('tbdReason');
  });

  it.each([InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS])(
    'refuses to reopen a %s inspection, which was never submitted',
    async (status) => {
      const { tx, prisma } = reopenPrisma(status);
      const service = new AdminService(prisma as never, new PresenceService());

      await expect(
        service.reopenInspection(admin, 'insp-1', { reason: 'nothing to reopen' }),
      ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_NOT_REOPENABLE' });
      expect(tx.inspection.updateMany).not.toHaveBeenCalled();
    },
  );

  it('refuses to reopen a cancelled inspection', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.CANCELLED);
    const service = new AdminService(prisma as never, new PresenceService());

    await expect(
      service.reopenInspection(admin, 'insp-1', { reason: 'changed our mind' }),
    ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_CANCELLED' });
    expect(tx.inspection.updateMany).not.toHaveBeenCalled();
  });

  it('records that a reopened inspection has nobody assigned', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.COMPLETED, 0);
    const service = new AdminService(prisma as never, new PresenceService());

    await service.reopenInspection(admin, 'insp-1', { reason: 'One more room' });

    // Not refused — the admin may be about to assign it — but a reopened
    // inspection with no technician reaches nobody, so the trail says so.
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ hadCurrentAssignment: false }),
        }),
      }),
    );
  });
});

describe('evidence behind a finalized inspection survives a reopen', () => {
  function photoPrisma(status: InspectionStatus, finalizedAt: Date | null) {
    return {
      inspectionPhoto: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'photo-1',
          storageKey: 'k',
          inspectionArea: { inspection: { status, finalizedAt } },
        }),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
  }

  it('refuses deletion once the inspection has been finalized, even while reopened', async () => {
    // The regression this guards: reopen returns the inspection to
    // IN_PROGRESS, and a status-only check handed the still-assigned
    // technician the ability to hard-delete a photo — and its stored object —
    // out of a report that was already closed and possibly shared.
    const prisma = photoPrisma(InspectionStatus.IN_PROGRESS, new Date('2026-08-01T00:00:00.000Z'));
    const objectDelete = jest.fn();
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      { delete: objectDelete } as never,
      {} as never,
    );

    await expect(service.deletePhoto(technician, 'photo-1')).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_FINALIZED',
    });
    expect(prisma.inspectionPhoto.delete).not.toHaveBeenCalled();
    // The stored object matters as much as the row: it is the evidence.
    expect(objectDelete).not.toHaveBeenCalled();
  });

  it('still allows deletion on an inspection that was never finalized', async () => {
    const prisma = photoPrisma(InspectionStatus.IN_PROGRESS, null);
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      { delete: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );

    await expect(service.deletePhoto(technician, 'photo-1')).resolves.toEqual({ deleted: true });
    expect(prisma.inspectionPhoto.delete).toHaveBeenCalled();
  });
});

describe('duplicate area merge (spec §16)', () => {
  it('reassigns evidence, demotes a conflicting primary, aliases the name, and audits', async () => {
    const tx = {
      inspectionArea: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'area-src',
            propertyAreaId: 'pa-src',
            propertyArea: { name: 'Kitchen' },
          })
          .mockResolvedValueOnce({
            id: 'area-tgt',
            propertyAreaId: 'pa-tgt',
            propertyArea: { name: 'Kitchenette' },
          }),
        delete: jest.fn().mockResolvedValue({}),
      },
      inspectionMedia: {
        count: jest.fn().mockResolvedValue(1), // target already has a primary
        findMany: jest.fn().mockResolvedValue([{ id: 'm-src-primary' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inspectionPhoto: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      mediaUploadSession: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      inspectionAreaStatusHistory: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      inspectionFinding: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      propertyAreaAlias: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(reviewableInspection()) },
      inspectionArea: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new AdminService(prisma as never, new PresenceService());

    await expect(
      service.mergeInspectionAreas(admin, 'insp-1', {
        sourceAreaId: 'area-src',
        targetAreaId: 'area-tgt',
      }),
    ).resolves.toMatchObject({
      movedMedia: 1,
      movedPhotos: 2,
      movedFindings: 3,
      demotedPrimaries: 1,
    });

    // The conflicting source primary is demoted to an additional clip.
    expect(tx.inspectionMedia.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['m-src-primary'] } },
        data: expect.objectContaining({ recordingType: 'ADDITIONAL_ISSUE' }),
      }),
    );
    // Media and findings are reassigned to the target.
    expect(tx.inspectionMedia.updateMany).toHaveBeenCalledWith({
      where: { inspectionAreaId: 'area-src' },
      data: { inspectionAreaId: 'area-tgt' },
    });
    expect(tx.inspectionFinding.updateMany).toHaveBeenCalledWith({
      where: { inspectionId: 'insp-1', propertyAreaId: 'pa-src' },
      data: { propertyAreaId: 'pa-tgt' },
    });
    // Source name preserved as an alias; source area removed; decision audited.
    expect(tx.propertyAreaAlias.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ propertyAreaId: 'pa-tgt', alias: 'Kitchen' }),
      }),
    );
    expect(tx.inspectionArea.delete).toHaveBeenCalledWith({ where: { id: 'area-src' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'INSPECTION_AREAS_MERGED' }),
      }),
    );
  });

  it('refuses to merge an area into itself', async () => {
    const prisma = { inspection: { findFirst: jest.fn() }, $transaction: jest.fn() };
    const service = new AdminService(prisma as never, new PresenceService());
    await expect(
      service.mergeInspectionAreas(admin, 'insp-1', {
        sourceAreaId: 'area-1',
        targetAreaId: 'area-1',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_MERGE' });
  });
});
