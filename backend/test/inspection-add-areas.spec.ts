import { UserRole } from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Property Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['inspections:manage'],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
};

const INSPECTION_ID = '20000000-0000-4000-8000-000000000001';

type Overrides = {
  inspection?: Record<string, unknown> | null;
  approvedAreas?: Array<Record<string, unknown>>;
  unitAreas?: Array<Record<string, unknown>>;
  existingAreas?: Array<{ propertyAreaId: string }>;
  assignees?: Array<{ technicianId: string }>;
};

function buildService(overrides: Overrides = {}) {
  const auditLog = { create: jest.fn().mockResolvedValue({}) };
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = { inspectionArea: { createMany }, auditLog };

  // `unitId` in the where clause is what separates the unit's own layout from
  // the building-level fallback, exactly as the service resolves it.
  const propertyAreaFindMany = jest.fn(({ where }: { where: { unitId?: string | null } }) =>
    Promise.resolve(where.unitId ? (overrides.unitAreas ?? []) : (overrides.approvedAreas ?? [])),
  );

  const prisma = {
    inspection: {
      findFirst: jest.fn().mockResolvedValue(
        overrides.inspection === undefined
          ? {
              id: INSPECTION_ID,
              status: 'IN_PROGRESS',
              inspectionType: 'OCCUPIED',
              finalizedAt: null,
              propertywareBuildingId: 'bld-1',
              propertywareUnitId: null,
            }
          : overrides.inspection,
      ),
    },
    propertyArea: { findMany: propertyAreaFindMany },
    inspectionArea: { findMany: jest.fn().mockResolvedValue(overrides.existingAreas ?? []) },
    inspectionAssignment: {
      findMany: jest.fn().mockResolvedValue(overrides.assignees ?? []),
    },
    auditLog,
    $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
  };

  const gateway = { publish: jest.fn() };
  const service = new AdminService(prisma as never, gateway as never);
  // The method returns the refreshed detail, which is a much larger read and not
  // what any of this is asserting.
  jest.spyOn(service, 'inspection').mockResolvedValue({ id: INSPECTION_ID } as never);
  return { service, prisma, gateway, createMany, auditLog };
}

const AREA = { id: 'area-1', name: 'Garage' };

describe('adding areas to an inspection already under way', () => {
  it('creates the area and tells the assigned technician in real time', async () => {
    const { service, gateway, createMany } = buildService({
      approvedAreas: [AREA],
      assignees: [{ technicianId: 'tech-1' }, { technicianId: 'tech-2' }],
    });

    await service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['area-1'] });

    expect(createMany).toHaveBeenCalledWith({
      data: [{ inspectionId: INSPECTION_ID, propertyAreaId: 'area-1' }],
      // The unique index is the real guard; two administrators adding the same
      // missed room must produce one area and no error.
      skipDuplicates: true,
    });
    // Every current assignee, not just the first: the area is work in their
    // hands, and a poll sixty seconds later is too late if they have driven off.
    expect(gateway.publish).toHaveBeenCalledWith('tech-1', INSPECTION_ID, 'UPDATED');
    expect(gateway.publish).toHaveBeenCalledWith('tech-2', INSPECTION_ID, 'UPDATED');
  });

  it('records what was added, by name, in the audit log', async () => {
    const { service, auditLog } = buildService({
      approvedAreas: [AREA],
      assignees: [{ technicianId: 'tech-1' }],
    });

    await service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['area-1'] });

    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'INSPECTION_AREAS_ADDED',
          metadata: expect.objectContaining({
            propertyAreaIds: ['area-1'],
            // Names too: an area can be renamed or archived later, and a row of
            // bare uuids cannot be read back into what was decided.
            areaNames: ['Garage'],
            notifiedTechnicians: 1,
          }),
        }),
      }),
    );
  });

  it('flags a move-out as affecting the baseline comparison', async () => {
    const { service, auditLog } = buildService({
      inspection: {
        id: INSPECTION_ID,
        status: 'IN_PROGRESS',
        inspectionType: 'MOVE_OUT',
        finalizedAt: null,
        propertywareBuildingId: 'bld-1',
        propertywareUnitId: null,
      },
      approvedAreas: [AREA],
    });

    await service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['area-1'] });

    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ comparisonAffected: true }),
        }),
      }),
    );
  });

  it('refuses a draft area, which is never in the approved set', async () => {
    // The service only ever reads APPROVED areas, so a draft simply is not
    // eligible - and is reported as such rather than silently dropped.
    const { service, createMany } = buildService({ approvedAreas: [] });

    await expect(
      service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['area-draft'] }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_AREA_SELECTION' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('refuses a finalized inspection, whose evidence is frozen', async () => {
    const { service, gateway } = buildService({
      inspection: {
        id: INSPECTION_ID,
        status: 'COMPLETED',
        inspectionType: 'OCCUPIED',
        finalizedAt: new Date(),
        propertywareBuildingId: 'bld-1',
        propertywareUnitId: null,
      },
    });

    await expect(
      service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['area-1'] }),
    ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_FINALIZED' });
    expect(gateway.publish).not.toHaveBeenCalled();
  });

  it('refuses when every selected area is already part of the inspection', async () => {
    const { service, createMany } = buildService({
      approvedAreas: [AREA],
      existingAreas: [{ propertyAreaId: 'area-1' }],
    });

    await expect(
      service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['area-1'] }),
    ).rejects.toMatchObject({ status: 409, code: 'AREAS_ALREADY_PRESENT' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('prefers the unit layout over the building-level one, as creation does', async () => {
    const { service, createMany } = buildService({
      inspection: {
        id: INSPECTION_ID,
        status: 'IN_PROGRESS',
        inspectionType: 'OCCUPIED',
        finalizedAt: null,
        propertywareBuildingId: 'bld-1',
        propertywareUnitId: 'unit-1',
      },
      unitAreas: [{ id: 'unit-area-1', name: 'Unit kitchen' }],
      // Present, and must not be reachable: an inspection built against the
      // unit's layout must never take an area from the shared one.
      approvedAreas: [{ id: 'building-area-1', name: 'Lobby' }],
    });

    await expect(
      service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['building-area-1'] }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_AREA_SELECTION' });

    await service.addInspectionAreas(admin, INSPECTION_ID, { propertyAreaIds: ['unit-area-1'] });
    expect(createMany).toHaveBeenCalledWith({
      data: [{ inspectionId: INSPECTION_ID, propertyAreaId: 'unit-area-1' }],
      skipDuplicates: true,
    });
  });
});
