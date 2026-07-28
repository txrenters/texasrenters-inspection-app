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
