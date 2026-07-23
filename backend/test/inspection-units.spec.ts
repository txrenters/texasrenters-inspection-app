import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { AdminService } from '../src/admin/admin.service';
import { TechnicianService } from '../src/technician/technician.service';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

function mediaProcessingDouble() {
  return { queue: jest.fn(), advanceInspection: jest.fn().mockResolvedValue(undefined) } as never;
}

const building = {
  id: 'building-1',
  externalId: 'ext-building',
  name: '4-Plex on Oak',
  addressLine1: '100 Oak St',
  addressLine2: null,
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  portfolio: { name: 'Core' },
};

const unitB = {
  id: 'unit-b',
  externalId: 'ext-unit-b',
  name: 'B',
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
};

function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
    propertywareUnit: {
      findFirst: jest.fn().mockResolvedValue(unitB),
      count: jest.fn().mockResolvedValue(0),
    },
    propertywareLease: { findFirst: jest.fn().mockResolvedValue(null) },
    propertyArea: { findMany: jest.fn().mockResolvedValue([]) },
    inspection: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'inspection-1' }),
    },
    inspectionAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function buildService(tx: ReturnType<typeof buildTx>) {
  const prisma = {
    $transaction: jest.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return new AdminService(prisma as never);
}

describe('multi-unit inspection creation', () => {
  it('rejects unit-less inspections for buildings that have active units', async () => {
    const tx = buildTx({
      propertywareUnit: {
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'MOVE_IN',
        priority: 'STANDARD',
      } as never),
    ).rejects.toMatchObject({ status: 422, code: 'UNIT_REQUIRED' });
    expect(tx.propertyArea.findMany).not.toHaveBeenCalled();
  });

  it('still allows entire-property inspections for buildings without units', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }, { id: 'area-2' }]),
      },
    });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'MOVE_IN',
      priority: 'STANDARD',
    } as never);

    expect(tx.propertywareUnit.count).toHaveBeenCalled();
    // Unit-less inspections seed from the building-level (unitId null) areas.
    expect(tx.propertyArea.findMany).toHaveBeenCalledTimes(1);
    expect(tx.propertyArea.findMany.mock.calls[0][0].where).toMatchObject({
      propertyId: 'building-1',
      unitId: null,
    });
  });

  it("seeds a unit inspection from the unit's own approved areas when they exist", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'unit-b-area-1' }, { id: 'unit-b-area-2' }]);
    const tx = buildTx({ propertyArea: { findMany } });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      unitId: 'unit-b',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'MOVE_IN',
      priority: 'STANDARD',
    } as never);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      propertyId: 'building-1',
      unitId: 'unit-b',
    });
    const createData = tx.inspection.create.mock.calls[0][0].data;
    expect(createData.areas.create).toEqual([
      { propertyAreaId: 'unit-b-area-1' },
      { propertyAreaId: 'unit-b-area-2' },
    ]);
  });

  it('falls back to building-level areas when the unit has no plan of its own', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([]) // unit-scoped query: nothing approved for unit B
      .mockResolvedValueOnce([{ id: 'shared-area-1' }]); // building-level fallback
    const tx = buildTx({ propertyArea: { findMany } });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      unitId: 'unit-b',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'MOVE_IN',
      priority: 'STANDARD',
    } as never);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].where).toMatchObject({
      propertyId: 'building-1',
      unitId: null,
    });
    const createData = tx.inspection.create.mock.calls[0][0].data;
    expect(createData.areas.create).toEqual([{ propertyAreaId: 'shared-area-1' }]);
    expect(createData.propertywareUnitId).toBe('unit-b');
  });

  it('reports a friendly conflict when the database unique index catches a duplicate race', async () => {
    const { Prisma } = jest.requireActual('@prisma/client');
    const raceError = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const tx = buildTx({
      propertyArea: { findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }]) },
      inspection: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(raceError),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'MOVE_IN',
        priority: 'STANDARD',
      } as never),
    ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_INSPECTION' });
  });
});

describe('technician payloads for unit inspections', () => {
  const technician: AuthenticatedUser = {
    id: '10000000-0000-4000-8000-000000000004',
    authUserId: 'auth-technician',
    organizationId: admin.organizationId,
    displayName: 'Field Technician',
    roles: [UserRole.INSPECTION_TECHNICIAN],
    permissions: [],
    mustChangePassword: false,
  };

  it("uses the inspection's own unit for identity and bed/bath counts", async () => {
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'inspection-1',
          inspectionType: 'MOVE_IN',
          baselineInspectionId: null,
          baselineInspection: null,
          scheduledAt: new Date('2026-08-01T15:00:00.000Z'),
          status: 'SCHEDULED',
          priority: 'STANDARD',
          internalNotes: null,
          propertywareUnit: { id: 'unit-b', name: 'B', bedrooms: 1, bathrooms: 1 },
          propertywareBuilding: {
            id: 'building-1',
            externalId: 'ext-building',
            externalPortfolioId: 'ext-portfolio',
            name: '4-Plex on Oak',
            addressLine1: '100 Oak St',
            city: 'Austin',
            state: 'TX',
            postalCode: '78701',
          },
          areas: [],
          _count: { findings: 0 },
        }),
      },
    };
    const service = new TechnicianService(prisma as never, {} as never, {} as never, mediaProcessingDouble());

    const context = await service.inspectionContext(technician, 'inspection-1');

    expect(context.inspection).toMatchObject({ unitId: 'unit-b', unitName: 'B' });
    expect(context.inspection.property.address).toBe('100 Oak St · Unit B');
    // Bed/bath counts come from the inspected unit, never "first unit wins".
    expect(context.property).toMatchObject({
      bedrooms: 1,
      bathrooms: 1,
      unitName: 'B',
      address: '100 Oak St · Unit B',
    });
  });
});
