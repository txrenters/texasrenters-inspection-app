import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-tech',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Taylor Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
};

const inspectionRecord = {
  id: 'insp-1',
  propertywareBuilding: {
    id: 'bld-1',
    name: 'Building',
    addressLine1: '1 Main',
    city: 'Houston',
    state: 'TX',
    postalCode: '77000',
  },
  propertywareUnit: null,
};

const roomRecord = {
  id: 'room-1',
  inspectionId: 'insp-1',
  propertyAreaId: 'area-1',
  completionStatus: 'PENDING',
  skipReason: null,
  technicianNote: null,
  inspection: { inspectionType: 'MOVE_OUT', baselineInspectionId: null },
  propertyArea: {
    name: 'Backyard',
    inspectionOrder: 5,
    isRequired: true,
    environment: 'OUTDOOR',
    category: 'YARD',
    source: 'TECHNICIAN',
    status: 'DRAFT',
    floor: { name: 'Added areas' },
    baselineConditions: [],
  },
  media: [],
};

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    propertyArea: { create: jest.fn().mockResolvedValue({ id: 'area-1' }) },
    inspectionArea: { create: jest.fn().mockResolvedValue({ id: 'room-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    inspection: { findFirst: jest.fn().mockResolvedValue(inspectionRecord) },
    property: { upsert: jest.fn().mockResolvedValue({ id: 'bld-1' }) },
    propertyArea: {
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { inspectionOrder: 4 } }),
    },
    propertyFloor: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'floor-1' }),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    inspectionArea: { findUniqueOrThrow: jest.fn().mockResolvedValue(roomRecord) },
    ...overrides,
  };
  return { prisma, tx };
}

function service(prisma: unknown) {
  return new TechnicianService(prisma as never, {} as never, {} as never, {} as never);
}

describe('technician manual area creation', () => {
  it('creates a DRAFT technician-sourced area and links it to the inspection', async () => {
    const { prisma, tx } = buildPrisma();
    const result = await service(prisma).createArea(technician, 'insp-1', {
      name: 'Backyard',
      environment: 'OUTDOOR' as never,
      category: 'YARD' as never,
    });

    expect(tx.propertyArea.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          propertyId: 'bld-1',
          source: 'TECHNICIAN',
          status: 'DRAFT',
          environment: 'OUTDOOR',
          category: 'YARD',
          isRequired: true,
          inspectionOrder: 5, // max(4) + 1
          createdById: technician.id,
        }),
      }),
    );
    expect(tx.inspectionArea.create).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(result).toMatchObject({
      environment: 'OUTDOOR',
      source: 'TECHNICIAN',
      areaStatus: 'DRAFT',
      name: 'Backyard',
    });
  });

  it('rejects a duplicate area name on the same floor', async () => {
    const { prisma } = buildPrisma({
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue({ id: 'existing' }),
        aggregate: jest.fn().mockResolvedValue({ _max: { inspectionOrder: 4 } }),
      },
    });
    await expect(
      service(prisma).createArea(technician, 'insp-1', {
        name: 'Backyard',
        environment: 'OUTDOOR' as never,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_AREA' });
  });

  it('refuses when the inspection has no linked property', async () => {
    const { prisma } = buildPrisma({
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ ...inspectionRecord, propertywareBuilding: null }),
      },
    });
    await expect(
      service(prisma).createArea(technician, 'insp-1', {
        name: 'Backyard',
        environment: 'OUTDOOR' as never,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'INSPECTION_HAS_NO_PROPERTY' });
  });
});
