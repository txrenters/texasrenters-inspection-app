import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { AdminService } from '../src/admin/admin.service';

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-property-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Property Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

const SYNCED = new Date('2026-07-24T00:00:00.000Z');
const portfolio = { id: 'p1', name: 'Austin Residential', externalId: 'pw-portfolio-1' };

function building(overrides: Record<string, unknown>) {
  return {
    id: 'b1',
    externalId: '233900007',
    name: '7306 Cypress Prairie',
    addressLine1: '7306 Cypress Prairie',
    addressLine2: null,
    city: 'Houston',
    state: 'TX',
    postalCode: '77000',
    sourceStatus: 'Active',
    isActive: true,
    lastSyncedAt: SYNCED,
    updatedAt: SYNCED,
    totalArea: null,
    areaUnits: null,
    category: null,
    manualTotalArea: null,
    manualAreaUnit: null,
    portfolio,
    units: [] as Array<{ id: string }>,
    leases: [] as Array<{
      unitId: string;
      sourceStatus: string | null;
      scheduledMoveOutDate: Date | null;
    }>,
    _count: { units: 0, inspections: 0 },
    ...overrides,
  };
}

describe('property total-area resolution', () => {
  it('uses the verified Propertyware building total when present', async () => {
    const prisma = {
      propertywareBuilding: {
        findMany: jest.fn().mockResolvedValue([
          building({
            totalArea: 1662,
            areaUnits: 'Sq Ft',
            category: 'RESIDENTIAL',
            units: [{ id: 'u1' }],
            leases: [],
            _count: { units: 1, inspections: 0 },
          }),
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(prisma as never);
    const result = await service.properties(user, { page: 1, pageSize: 20 } as never);
    expect(result.items[0].totalArea).toEqual({
      value: 1662,
      unit: 'sq ft',
      source: 'PROPERTYWARE_BUILDING',
      derived: false,
      updatedAt: SYNCED.toISOString(),
      label: '1,662 sq ft',
    });
  });

  it('falls back to an administrator manual value when Propertyware has none', async () => {
    const prisma = {
      propertywareBuilding: {
        findMany: jest
          .fn()
          .mockResolvedValue([building({ manualTotalArea: 1200, manualAreaUnit: 'sq ft' })]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(prisma as never);
    const result = await service.properties(user, { page: 1, pageSize: 20 } as never);
    expect(result.items[0].totalArea.source).toBe('MANUAL');
    expect(result.items[0].totalArea.label).toBe('1,200 sq ft');
  });

  it('reports "Not provided" (UNKNOWN) when no reliable area exists — never a guess', async () => {
    const prisma = {
      propertywareBuilding: {
        findMany: jest.fn().mockResolvedValue([building({})]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(prisma as never);
    const result = await service.properties(user, { page: 1, pageSize: 20 } as never);
    expect(result.items[0].totalArea).toMatchObject({
      value: null,
      source: 'UNKNOWN',
      label: 'Not provided',
    });
  });
});

describe('property lease summary', () => {
  it('counts active leases, scheduled move-outs, and derives vacancy', async () => {
    const prisma = {
      propertywareBuilding: {
        findMany: jest.fn().mockResolvedValue([
          building({
            units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
            leases: [
              { unitId: 'u1', sourceStatus: 'Active', scheduledMoveOutDate: null },
              { unitId: 'u2', sourceStatus: 'Notice given', scheduledMoveOutDate: new Date('2026-09-01') },
            ],
            _count: { units: 3, inspections: 0 },
          }),
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(prisma as never);
    const result = await service.properties(user, { page: 1, pageSize: 20 } as never);
    expect(result.items[0].leaseSummary).toEqual({
      activeLeaseCount: 2,
      scheduledMoveOutCount: 1,
      vacantUnitCount: 1, // u3 has no active lease
      summary: '2 active leases · 1 scheduled move-out · 1 vacant unit',
    });
  });

  it('shows a vacant unit even when the property has no active leases', async () => {
    const prisma = {
      propertywareBuilding: {
        findMany: jest
          .fn()
          .mockResolvedValue([building({ units: [{ id: 'u1' }], leases: [] })]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(prisma as never);
    const result = await service.properties(user, { page: 1, pageSize: 20 } as never);
    expect(result.items[0].leaseSummary.summary).toBe('1 vacant unit');
    expect(result.items[0].leaseSummary.vacantUnitCount).toBe(1);
  });

  it('summarizes "No relevant lease" when there is nothing to report', async () => {
    const prisma = {
      propertywareBuilding: {
        findMany: jest.fn().mockResolvedValue([building({ units: [], leases: [] })]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(prisma as never);
    const result = await service.properties(user, { page: 1, pageSize: 20 } as never);
    expect(result.items[0].leaseSummary.summary).toBe('No relevant lease');
  });
});

describe('property detail per-unit lease status', () => {
  it('maps each unit to its active lease status, or "No relevant lease" when none', async () => {
    const prisma = {
      propertywareBuilding: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'b1',
          externalId: '233900007',
          name: '7306 Cypress Prairie',
          addressLine1: '7306 Cypress Prairie',
          addressLine2: null,
          city: 'Houston',
          state: 'TX',
          postalCode: '77000',
          sourceStatus: 'Active',
          isActive: true,
          lastSyncedAt: SYNCED,
          updatedAt: SYNCED,
          totalArea: 1662,
          areaUnits: 'Sq Ft',
          category: 'RESIDENTIAL',
          manualTotalArea: null,
          manualAreaUnit: null,
          portfolio,
          units: [
            { id: 'u1', externalId: 'e1', name: 'A', bedrooms: 3, bathrooms: 2, isActive: true, lastSyncedAt: SYNCED },
            { id: 'u2', externalId: 'e2', name: 'B', bedrooms: 2, bathrooms: 1, isActive: true, lastSyncedAt: SYNCED },
          ],
          leases: [
            {
              id: 'l1',
              externalId: 'lx1',
              unitId: 'u1',
              leaseName: 'Smith',
              sourceStatus: 'Notice given',
              startDate: null,
              endDate: null,
              scheduledMoveOutDate: new Date('2026-09-01'),
            },
          ],
        }),
      },
    };
    const service = new AdminService(prisma as never);
    const detail = (await service.property(user, 'b1')) as {
      totalArea: { source: string };
      units: Array<{ id: string; leaseStatus: string | null; scheduledMoveOutDate: Date | null }>;
    };
    expect(detail.totalArea.source).toBe('PROPERTYWARE_BUILDING');
    const u1 = detail.units.find((unit) => unit.id === 'u1')!;
    const u2 = detail.units.find((unit) => unit.id === 'u2')!;
    expect(u1.leaseStatus).toBe('Notice given');
    expect(u1.scheduledMoveOutDate).toEqual(new Date('2026-09-01'));
    expect(u2.leaseStatus).toBeNull();
  });
});
