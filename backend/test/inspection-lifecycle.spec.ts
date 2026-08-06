import { InspectionStatus } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

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
      inspectionFinding: { count: jest.fn().mockResolvedValue(2) },
      inspectionMedia: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn(),
    };
    const service = new AdminService(prisma as never);

    await expect(service.finalizeInspection(admin, 'insp-1', {})).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_HAS_UNRESOLVED_ITEMS',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('finalizes with a documented override, recording the finalizer and audit trail', async () => {
    const tx = {
      inspection: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const detail = { id: 'insp-1', status: InspectionStatus.COMPLETED };
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValueOnce(reviewableInspection()).mockResolvedValueOnce(detail),
      },
      inspectionFinding: { count: jest.fn().mockResolvedValue(1) },
      inspectionMedia: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new AdminService(prisma as never);

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
          metadata: expect.objectContaining({ override: true, overrideReason: 'Owner approved closure' }),
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
    const service = new AdminService(prisma as never);

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
    const service = new AdminService(prisma as never);

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
      expect.objectContaining({ data: expect.objectContaining({ action: 'INSPECTION_MARKED_TBD' }) }),
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
    const service = new AdminService(prisma as never);

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

  function reopenPrisma(from: InspectionStatus, currentAssignments = 1) {
    const tx = {
      inspection: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(reviewableInspection(from))
          .mockResolvedValueOnce({ id: 'insp-1', status: InspectionStatus.IN_PROGRESS }),
      },
      inspectionAssignment: { count: jest.fn().mockResolvedValue(currentAssignments) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return { tx, prisma };
  }

  it('reopens a finalized inspection back to IN_PROGRESS and clears the finalization', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.COMPLETED);
    const service = new AdminService(prisma as never);

    await service.reopenInspection(admin, 'insp-1', { reason: 'Garage was never captured' });

    // IN_PROGRESS is the only status that puts the inspection back in the
    // technician's queue, and the finalization stamps must not outlive it.
    expect(tx.inspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: InspectionStatus.IN_PROGRESS,
          submittedAt: null,
          completedAt: null,
          finalizedAt: null,
          finalizedById: null,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'INSPECTION_REOPENED' }),
      }),
    );
  });

  it('reopens from a mid-review state without clearing the administrator determination', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.FOLLOW_UP_REQUIRED);
    const service = new AdminService(prisma as never);

    await service.reopenInspection(admin, 'insp-1', { reason: 'Re-shoot the roof' });

    // Reopening is how a follow-up gets actioned, not proof it is resolved:
    // clearing the determination would destroy why the inspection was held.
    const { data } = tx.inspection.update.mock.calls[0][0];
    expect(data.status).toBe(InspectionStatus.IN_PROGRESS);
    expect(data).not.toHaveProperty('followUpRequired');
    expect(data).not.toHaveProperty('tbdReason');
  });

  it.each([InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS])(
    'refuses to reopen a %s inspection, which was never submitted',
    async (status) => {
      const { tx, prisma } = reopenPrisma(status);
      const service = new AdminService(prisma as never);

      await expect(
        service.reopenInspection(admin, 'insp-1', { reason: 'nothing to reopen' }),
      ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_NOT_REOPENABLE' });
      expect(tx.inspection.update).not.toHaveBeenCalled();
    },
  );

  it('refuses to reopen a cancelled inspection', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.CANCELLED);
    const service = new AdminService(prisma as never);

    await expect(
      service.reopenInspection(admin, 'insp-1', { reason: 'changed our mind' }),
    ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_CANCELLED' });
    expect(tx.inspection.update).not.toHaveBeenCalled();
  });

  it('records that a reopened inspection has nobody assigned', async () => {
    const { tx, prisma } = reopenPrisma(InspectionStatus.COMPLETED, 0);
    const service = new AdminService(prisma as never);

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
    const service = new AdminService(prisma as never);

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
    const service = new AdminService(prisma as never);
    await expect(
      service.mergeInspectionAreas(admin, 'insp-1', {
        sourceAreaId: 'area-1',
        targetAreaId: 'area-1',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_MERGE' });
  });
});
