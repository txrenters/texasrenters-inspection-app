import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TRANSACTION_DEFAULTS } from '../src/database/prisma.service';
import { TechnicianService } from '../src/technician/technician.service';

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-tech',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Taylor Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
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
    // The area is written with its default checklist in the same transaction.
    areaChecklistItem: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
  it('gives a technician-added area its default checklist on the spot', async () => {
    // The case this exists for: no floor plan, so nobody classified the area
    // and no administrator will see it before the technician records it. The
    // list has to arrive with the area, in the same transaction, or they walk
    // into a room with nothing to cover.
    const { prisma, tx } = buildPrisma();
    await service(prisma).createArea(technician, 'insp-1', {
      name: 'Guest bathroom',
      environment: 'INDOOR' as never,
    });

    // Read off the area's own create: the items are nested into that statement
    // rather than issued as a second one, which is what keeps this to a single
    // round trip. Nesting is also what makes it atomic without a second write.
    const [areaCall] = tx.propertyArea.create.mock.calls;
    const items = (
      areaCall[0] as {
        data: {
          checklistItems: {
            createMany: { data: { label: string; keywords: string[]; sortOrder: number }[] };
          };
        };
      }
    ).data.checklistItems.createMany.data;
    const labels = items.map((item) => item.label);
    // Base set plus what a bathroom needs, read from the name alone.
    expect(labels).toContain('Doors and locks');
    expect(labels).toContain('Toilet and roll holder');
    // Keywords are derived the same way an administrator's own item would be,
    // so a generated item ticks itself under the same conditions.
    expect(items.find((item) => item.label === 'Toilet and roll holder')?.keywords).toContain(
      'toilet',
    );
    // Ordered as the technician should walk them.
    expect(items.map((item) => item.sortOrder)).toEqual(labels.map((_, index) => index));
    // The nested write is the only one: a separate createMany would be a fifth
    // round trip inside the transaction, which is what exhausted Prisma's
    // five-second default against a remote pooler and rolled the area back.
    expect(tx.areaChecklistItem.createMany).not.toHaveBeenCalled();
  });

  it('holds the transaction to three statements', async () => {
    // What broke this was round-trip count, not logic. Every statement is a few
    // hundred milliseconds against a remote pooler, so a fourth pushed the
    // transaction past its budget mid-flight; Prisma closed it underneath the
    // code still using it, the next statement threw "Transaction not found",
    // and the area a technician was standing in was rolled back.
    //
    // The budget itself is set once on the client. This counts the statements,
    // because that is the part a future change can quietly regress.
    const { prisma, tx } = buildPrisma();
    await service(prisma).createArea(technician, 'insp-1', {
      name: 'Guest bathroom',
      environment: 'INDOOR' as never,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const statements =
      tx.propertyArea.create.mock.calls.length +
      tx.inspectionArea.create.mock.calls.length +
      tx.auditLog.create.mock.calls.length +
      tx.areaChecklistItem.createMany.mock.calls.length;
    expect(statements).toBe(3);
  });

  it('gives every transaction more room than the five-second Prisma default', () => {
    // Guards the value itself: reverting it to Prisma's default would restore
    // the outage across all thirty-odd transaction sites at once, and the
    // failure it produces does not name a timeout.
    expect(TRANSACTION_DEFAULTS.timeout).toBeGreaterThan(5_000);
    expect(TRANSACTION_DEFAULTS.maxWait).toBeGreaterThan(2_000);
  });

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

/**
 * An area added on site gets the list the *visit* will actually read.
 *
 * Reported 2026-09-10: "make sure our app is smart enough to know the kind of
 * inspection — if the technician is doing an occupied inspection and adds an
 * area, the checklist should align with it."
 *
 * Only a ROOM visit reads a per-area list. An occupied visit reads the
 * organization's short list and an HVAC visit the equipment one, both stored
 * once with a null area; a lockbox visit reads nothing. So on any of those, the
 * rows written here are for *later* inspections of this property — which makes
 * the provider call latency in front of somebody who will never see its output,
 * inside a fifteen-minute visit.
 */
describe('the checklist an added area is given', () => {
  function withType(inspectionType: string | undefined) {
    const { prisma, tx } = buildPrisma({
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ ...inspectionRecord, inspectionType }),
      },
    });
    const generate = jest.fn().mockResolvedValue({ items: [['A model item']] });
    const built = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      // Positional: (prisma, floorPlanStorage, mediaStorage, mediaProcessing,
      // technicianEvents?, checklistAi?, aiSettings?). The last three are
      // @Optional() and appended, so the generator is sixth and the settings
      // service seventh — reversing them makes `aiSettings.resolve` a function
      // that does not exist, several frames from anything that says so.
      undefined,
      { generate } as never,
      { resolve: jest.fn().mockResolvedValue({}) } as never,
    );
    return { service: built, tx, generate };
  }

  const add = (svc: TechnicianService) =>
    svc.createArea(technician, 'insp-1', {
      name: 'Guest bathroom',
      environment: 'INDOOR' as never,
    });

  it('always writes ROOM items, whatever visit added the area', async () => {
    // The area is the property's, permanently. Its room list is what a later
    // move-in or move-out will read, so it is written either way — and `kind`
    // is stated rather than left to the column default, because that field is
    // what decides whether these rows are ever shown.
    const { service: svc, tx } = withType('OCCUPIED');
    await add(svc);
    const rows = tx.areaChecklistItem.createMany.mock.calls[0]?.[0]?.data
      ?? (tx.propertyArea.create.mock.calls[0][0].data.checklistItems.createMany.data as {
        kind: string;
      }[]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row: { kind: string }) => row.kind === 'ROOM')).toBe(true);
  });

  it.each([['OCCUPIED'], ['HVAC'], ['SUPRA_LOCKBOX_PLACEMENT']])(
    'does not wait on the model during a %s visit',
    async (inspectionType) => {
      const { service: svc, generate } = withType(inspectionType);
      await add(svc);
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it.each([['MOVE_IN'], ['MOVE_OUT'], ['BACK_TO_MARKET']])(
    'still asks the model on a %s visit, which does read this list',
    async (inspectionType) => {
      const { service: svc, generate } = withType(inspectionType);
      await add(svc);
      expect(generate).toHaveBeenCalled();
    },
  );
});
