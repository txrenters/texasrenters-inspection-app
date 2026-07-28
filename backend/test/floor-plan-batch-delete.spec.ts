import { UserRole } from '@texasrenters/shared';

import { FloorPlanAdminService } from '../src/admin/floor-plan-admin.service';
import type { AuthenticatedUser } from '../src/common/auth';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Administrator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

const BUILDING = 'building-1';
const IDS = ['area-1', 'area-2'];

function service(overrides: Record<string, unknown> = {}) {
  const tx = {
    propertyArea: { deleteMany: jest.fn().mockResolvedValue({ count: IDS.length }) },
    auditLog: { createMany: jest.fn().mockResolvedValue({ count: IDS.length }) },
  };
  const prisma = {
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue({ id: BUILDING }) },
    propertyArea: {
      findMany: jest
        .fn()
        .mockResolvedValue(IDS.map((id, index) => ({ id, name: `Area ${index + 1}` }))),
    },
    inspectionArea: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
    ...overrides,
  };
  return {
    prisma,
    tx,
    service: new FloorPlanAdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    ),
  };
}

describe('batch area deletion', () => {
  it('deletes the selection and records one audit event per area', async () => {
    const { service: subject, prisma, tx } = service();

    await expect(subject.deleteAreas(admin, BUILDING, IDS)).resolves.toMatchObject({
      ids: IDS,
      deleted: 2,
      deletedAt: expect.any(String),
    });

    expect(tx.propertyArea.deleteMany).toHaveBeenCalledWith({ where: { id: { in: IDS } } });
    const audits = tx.auditLog.createMany.mock.calls[0][0].data;
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      organizationId: admin.organizationId,
      actorUserId: admin.id,
      action: 'PROPERTY_AREA_DELETED',
      entityType: 'PropertyArea',
    });
    // Ownership is enforced before anything is read or removed.
    expect(prisma.propertywareBuilding.findFirst).toHaveBeenCalled();
  });

  it('refuses the whole batch when any area is used by an inspection, naming them', async () => {
    const { service: subject, tx } = service({
      inspectionArea: { findMany: jest.fn().mockResolvedValue([{ propertyAreaId: 'area-2' }]) },
    });

    await expect(subject.deleteAreas(admin, BUILDING, IDS)).rejects.toMatchObject({
      status: 409,
      code: 'AREA_IN_USE',
      // The operator must know which row to deselect, not just how many.
      message: expect.stringContaining('Area 2'),
    });
    // Nothing is partially deleted.
    expect(tx.propertyArea.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses ids that belong to another property or organization', async () => {
    const { service: subject, tx } = service({
      // Only one of the two requested ids resolves within this building.
      propertyArea: { findMany: jest.fn().mockResolvedValue([{ id: 'area-1', name: 'Area 1' }]) },
    });

    await expect(subject.deleteAreas(admin, BUILDING, IDS)).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_AREA_SELECTION',
    });
    expect(tx.propertyArea.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects a duplicated selection rather than under-deleting silently', async () => {
    const { service: subject, tx } = service();

    await expect(
      subject.deleteAreas(admin, BUILDING, ['area-1', 'area-1']),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_AREA_SELECTION' });
    expect(tx.propertyArea.deleteMany).not.toHaveBeenCalled();
  });
});
