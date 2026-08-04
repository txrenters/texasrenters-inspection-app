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
    // Returns the whole selected row: createArea now selects the room inside
    // the transaction instead of re-reading it afterwards.
    inspectionArea: { create: jest.fn().mockResolvedValue(roomRecord) },
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
  it('creates an approved technician-sourced area and links it to the inspection', async () => {
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
          // Approved on creation: the technician is standing in the area, which
          // is better evidence of the layout than a plan read from an office.
          // It stays attributable through `source` and the audit entry.
          status: 'APPROVED',
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
        findFirst: jest.fn().mockResolvedValue({ id: 'existing', inspectionAreas: [] }),
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

  it('returns the existing area when a timed-out attempt is retried', async () => {
    // The mobile client gives up after 15s. Adding an area used to take ~14s of
    // serial round trips, so the write landed while the phone was already
    // showing a failure — and the retry then hit DUPLICATE_AREA for the
    // technician's own area. If it is already part of this inspection, hand it
    // back instead.
    const { prisma, tx } = buildPrisma({
      propertyArea: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'existing', inspectionAreas: [{ id: 'room-1' }] }),
        aggregate: jest.fn().mockResolvedValue({ _max: { inspectionOrder: 4 } }),
      },
    });

    const result = await service(prisma).createArea(technician, 'insp-1', {
      name: 'Backyard',
      environment: 'OUTDOOR' as never,
    });

    expect(result).toMatchObject({ name: 'Backyard', source: 'TECHNICIAN' });
    // Nothing written twice: no second area, no second audit entry.
    expect(tx.propertyArea.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('still rejects a name reused from a different inspection', async () => {
    // Same name on the same floor, but not part of this inspection — a real
    // collision, not a retry, and it must keep failing.
    const { prisma } = buildPrisma({
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue({ id: 'existing', inspectionAreas: [] }),
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

  it('does not re-read the room it just wrote', async () => {
    // Every avoided round trip is a few hundred milliseconds against the
    // pooler, which is the entire reason this endpoint blew the client timeout.
    const { prisma } = buildPrisma();
    await service(prisma).createArea(technician, 'insp-1', {
      name: 'Backyard',
      environment: 'OUTDOOR' as never,
    });
    expect(prisma.inspectionArea.findUniqueOrThrow).not.toHaveBeenCalled();
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
