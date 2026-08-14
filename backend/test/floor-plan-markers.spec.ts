import { floorPlanExtractionSchema } from '@texasrenters/shared';
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

const baseArea = { floorName: 'Ground Floor', name: 'Kitchen', inspectionOrder: 1, isRequired: true };

function service(prisma: unknown, storage: unknown = {}, extraction: unknown = {}, ai: unknown = {}) {
  return new FloorPlanAdminService(
    prisma as never,
    storage as never,
    extraction as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
    ai as never,
  );
}

function areaRow(overrides: Record<string, unknown>) {
  return {
    id: 'area-1',
    propertyId: 'building-1',
    unitId: null,
    unit: null,
    name: 'Kitchen',
    inspectionOrder: 1,
    isRequired: true,
    status: 'APPROVED',
    source: 'AI_FLOOR_PLAN',
    environment: 'INDOOR',
    category: null,
    notes: null,
    archivedAt: null,
    markerX: null,
    markerY: null,
    markerSource: null,
    markerConfidence: null,
    markerUpdatedAt: null,
    sourceFloorPlanId: null,
    sourcePageNumber: null,
    boundingBoxX: null,
    boundingBoxY: null,
    boundingBoxWidth: null,
    boundingBoxHeight: null,
    createdBy: null,
    updatedAt: new Date('2026-07-28T02:00:00.000Z'),
    floor: null,
    _count: { inspectionAreas: 0 },
    ...overrides,
  };
}

describe('floor-plan marker extraction schema', () => {
  it('accepts a valid normalized marker and bounding box', () => {
    const parsed = floorPlanExtractionSchema.parse([
      { ...baseArea, marker: { x: 0.54, y: 0.16, confidence: 0.9 }, boundingBox: { x: 0.4, y: 0.02, width: 0.19, height: 0.27 } },
    ]);
    expect(parsed[0].marker).toEqual({ x: 0.54, y: 0.16, confidence: 0.9 });
    expect(parsed[0].boundingBox).toEqual({ x: 0.4, y: 0.02, width: 0.19, height: 0.27 });
  });

  it('drops a marker with x below 0 or above 1 but keeps the area', () => {
    expect(floorPlanExtractionSchema.parse([{ ...baseArea, marker: { x: -0.1, y: 0.2 } }])[0].marker).toBeUndefined();
    const high = floorPlanExtractionSchema.parse([{ ...baseArea, marker: { x: 1.5, y: 0.2 } }]);
    expect(high[0].marker).toBeUndefined();
    expect(high[0].name).toBe('Kitchen');
  });

  it('drops a marker with y out of range but keeps the area', () => {
    expect(floorPlanExtractionSchema.parse([{ ...baseArea, marker: { x: 0.2, y: -0.3 } }])[0].marker).toBeUndefined();
    expect(floorPlanExtractionSchema.parse([{ ...baseArea, marker: { x: 0.2, y: 2 } }])[0].marker).toBeUndefined();
  });

  it('accepts an area with no marker at all', () => {
    const parsed = floorPlanExtractionSchema.parse([baseArea]);
    expect(parsed[0].marker).toBeUndefined();
    expect(parsed[0].boundingBox).toBeUndefined();
  });
});

describe('updateAreaMarker (spec §12/§18/§19)', () => {
  it('places a marker on a legacy area, binds it to the current plan, and audits — without touching status', async () => {
    let updateArgs: { data: Record<string, unknown> } | null = null;
    const prisma = {
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue(
          areaRow({ markerX: null, markerY: null, sourceFloorPlanId: null }),
        ),
        update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return Promise.resolve(
            areaRow({ markerX: 0.5, markerY: 0.25, markerSource: 'ADMIN_PLACED', sourceFloorPlanId: 'plan-1' }),
          );
        }),
      },
      propertyFloorPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'plan-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const result = await service(prisma).updateAreaMarker(admin, 'area-1', { x: 0.5, y: 0.25 });

    expect(result.marker).toMatchObject({ available: true, x: 0.5, y: 0.25 });
    expect(updateArgs!.data).toMatchObject({
      markerX: 0.5,
      markerY: 0.25,
      markerSource: 'ADMIN_PLACED',
      sourceFloorPlanId: 'plan-1',
    });
    // Approval status is never changed by a marker edit.
    expect('status' in updateArgs!.data).toBe(false);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'AREA_MARKER_PLACED' }) }),
    );
  });

  it('adjusts an existing marker (keeps its plan version) and audits AREA_MARKER_MOVED', async () => {
    let updateArgs: { data: Record<string, unknown> } | null = null;
    const planLookup = jest.fn();
    const prisma = {
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue(
          areaRow({ markerX: 0.1, markerY: 0.1, sourceFloorPlanId: 'plan-1', markerSource: 'AI_EXTRACTED' }),
        ),
        update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return Promise.resolve(
            areaRow({ markerX: 0.6, markerY: 0.7, markerSource: 'ADMIN_ADJUSTED', sourceFloorPlanId: 'plan-1' }),
          );
        }),
      },
      propertyFloorPlan: { findFirst: planLookup },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    await service(prisma).updateAreaMarker(admin, 'area-1', { x: 0.6, y: 0.7 });

    expect(updateArgs!.data).toMatchObject({ markerSource: 'ADMIN_ADJUSTED', sourceFloorPlanId: 'plan-1' });
    // An area that already belongs to a plan version does not re-resolve one.
    expect(planLookup).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'AREA_MARKER_MOVED' }) }),
    );
  });

  it('rejects a stale marker edit instead of overwriting a newer revision', async () => {
    const tx = {
      propertyArea: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ updatedAt: new Date('2026-07-28T03:00:00.000Z') }),
      },
    };
    const prisma = {
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue(
          areaRow({ markerX: 0.1, markerY: 0.1, sourceFloorPlanId: 'plan-1' }),
        ),
      },
      propertyFloorPlan: { findFirst: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn((callback) => callback(tx)),
    };

    const mutation = service(prisma).updateAreaMarker(admin, 'area-1', {
        x: 0.6,
        y: 0.7,
        expectedUpdatedAt: '2026-07-28T02:00:00.000Z',
      });
    await expect(mutation).rejects.toMatchObject({ code: 'AREA_VERSION_CONFLICT' });
    await mutation.catch((error: { getStatus(): number }) => expect(error.getStatus()).toBe(409));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('backfills only missing markers and never rewrites names, order, or status', async () => {
    const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'plan-1',
          propertyId: 'building-1',
          unitId: null,
          storageKey: 'key',
          fileName: 'plan.png',
          mimeType: 'image/png',
        }),
      },
      propertyArea: {
        findMany: jest
          .fn()
          // Candidates lacking coordinates.
          .mockResolvedValueOnce([
            { id: 'area-kitchen', name: 'Kitchen', floor: { name: 'Ground Floor' } },
            { id: 'area-attic', name: 'Attic', floor: { name: 'Ground Floor' } },
          ])
          // Reload for the returned area list.
          .mockResolvedValueOnce([]),
        update: jest.fn().mockImplementation((args) => {
          updates.push(args);
          return Promise.resolve(areaRow({}));
        }),
      },
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue({ id: 'building-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const extraction = {
      extract: jest.fn().mockResolvedValue({
        areas: [
          { floorName: 'Ground Floor', name: 'Kitchen', inspectionOrder: 1, isRequired: true, marker: { x: 0.4, y: 0.6 } },
        ],
        usage: {},
      }),
    };
    const result = await service(
      prisma,
      { get: jest.fn().mockResolvedValue(Buffer.from('plan')) },
      extraction,
      { resolve: jest.fn().mockResolvedValue({}), recordUsage: jest.fn().mockResolvedValue({}) },
    ).retryMissingMarkers(admin, 'plan-1');

    expect(result).toMatchObject({ updated: 1, unmatched: 1 });
    // Only the matched area was written, and only marker columns.
    expect(updates).toHaveLength(1);
    expect(updates[0].where.id).toBe('area-kitchen');
    expect(updates[0].data).toMatchObject({
      markerX: 0.4,
      markerY: 0.6,
      markerSource: 'AI_EXTRACTED',
      sourceFloorPlanId: 'plan-1',
    });
    for (const field of ['status', 'name', 'inspectionOrder', 'isRequired'])
      expect(field in updates[0].data).toBe(false);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'AREA_MARKER_GENERATED' }) }),
    );
  });

  it('skips extraction entirely when every area already has a marker', async () => {
    const extraction = { extract: jest.fn() };
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'plan-1',
          propertyId: 'building-1',
          unitId: null,
          storageKey: 'key',
          fileName: 'plan.png',
          mimeType: 'image/png',
        }),
      },
      propertyArea: { findMany: jest.fn().mockResolvedValue([]) },
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue({ id: 'building-1' }) },
    };
    const result = await service(prisma, {}, extraction, {}).retryMissingMarkers(admin, 'plan-1');
    expect(result).toMatchObject({ updated: 0, unmatched: 0 });
    expect(extraction.extract).not.toHaveBeenCalled();
  });

  it('exposes a mapped marker DTO (no raw coordinate columns)', async () => {
    const prisma = {
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue(areaRow({ sourceFloorPlanId: 'plan-1' })),
        update: jest.fn().mockResolvedValue(
          areaRow({ markerX: 0.5, markerY: 0.25, markerSource: 'ADMIN_ADJUSTED', sourceFloorPlanId: 'plan-1' }),
        ),
      },
      propertyFloorPlan: { findFirst: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const result = (await service(prisma).updateAreaMarker(admin, 'area-1', { x: 0.5, y: 0.25 })) as Record<
      string,
      unknown
    >;
    expect(result).not.toHaveProperty('markerX');
    expect(result).not.toHaveProperty('boundingBoxX');
    expect(result.marker).toBeTruthy();
  });
});

describe('editing a technician-added area', () => {
  // Technician areas are approved on creation — nobody reviewed them first —
  // so this is the only chance anyone gets to fix a name typed one-handed in
  // somebody's back garden. AI-extracted areas keep the freeze: those were
  // reviewed before approval.
  const prismaFor = (area: Record<string, unknown>, finalizedCount: number) => ({
    propertyArea: {
      // First call resolves the area being edited; the next is the uniqueness
      // check, which must find nothing or every rename looks like a duplicate.
      findFirst: jest.fn().mockResolvedValueOnce(areaRow(area)).mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(areaRow(area)),
    },
    inspectionArea: { count: jest.fn().mockResolvedValue(finalizedCount) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (run: (tx: unknown) => unknown) =>
      run({
        propertyArea: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findFirst: jest.fn().mockResolvedValue(areaRow(area)),
          findUniqueOrThrow: jest.fn().mockResolvedValue(areaRow(area)),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      }),
    ),
  });

  it('refuses an approved area that an administrator approved', async () => {
    const prisma = prismaFor({ source: 'AI_FLOOR_PLAN' }, 0);
    await expect(
      service(prisma).updateArea(admin, 'area-1', { name: 'Kitchenette' } as never),
    ).rejects.toMatchObject({ code: 'AREA_ALREADY_APPROVED' });
  });

  it('refuses once the area appears in a completed inspection', async () => {
    // Renaming then would relabel evidence in a finished report — that is the
    // audit trail, not the layout.
    const prisma = prismaFor({ source: 'TECHNICIAN' }, 1);
    await expect(
      service(prisma).updateArea(admin, 'area-1', { name: 'Back garden' } as never),
    ).rejects.toMatchObject({ code: 'AREA_ALREADY_APPROVED' });
  });

  it('allows correcting one before any inspection using it has completed', async () => {
    const prisma = prismaFor({ source: 'TECHNICIAN' }, 0);
    await expect(
      service(prisma).updateArea(admin, 'area-1', { name: 'Back garden' } as never),
    ).resolves.toBeDefined();
  });
});

/**
 * The freeze protects the *layout*, and `hasAirConditioning` is not part of it:
 * it records where the equipment is and only decides which future HVAC visits
 * include the area.
 *
 * Reaching that exemption from a form is the part that was broken. Every editor
 * submits all of an area's fields, so ticking the box also resubmitted the
 * area's own name — and a freeze that asked "was a layout field mentioned?"
 * rather than "did one change?" refused it as a rename. That made the flag
 * unsettable on precisely the areas it matters for, since inspections scope
 * from APPROVED areas.
 */
describe('recording where the air conditioners are', () => {
  const prismaFor = (area: Record<string, unknown>) => ({
    propertyArea: {
      findFirst: jest.fn().mockResolvedValueOnce(areaRow(area)).mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    inspectionArea: { count: jest.fn().mockResolvedValue(1) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (run: (tx: unknown) => unknown) =>
      run({
        propertyArea: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(areaRow(area)),
        },
        areaChecklistItem: { createMany: jest.fn().mockResolvedValue({ count: 6 }) },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      }),
    ),
  });

  // The exact payload the console sends: the whole form, with only the tick
  // actually different from what is stored.
  const wholeForm = {
    name: 'Kitchen',
    inspectionOrder: 1,
    isRequired: true,
    hasAirConditioning: true,
  };

  it('accepts the tick on an approved area when nothing else changed', async () => {
    const prisma = prismaFor({ source: 'AI_FLOOR_PLAN', status: 'APPROVED' });

    await expect(
      service(prisma).updateArea(admin, 'area-1', wholeForm as never),
    ).resolves.toBeDefined();
  });

  it('accepts it on an area already used by a completed inspection', async () => {
    const prisma = prismaFor({ source: 'TECHNICIAN', status: 'APPROVED' });

    await expect(
      service(prisma).updateArea(admin, 'area-1', wholeForm as never),
    ).resolves.toBeDefined();
  });

  it('generates the air-conditioning checklist so the tick means something', async () => {
    // Without the items an HVAC visit reaches the technician as an area with
    // no questions on it.
    let seeded: { data: { kind: string; label: string }[] } | undefined;
    const prisma = prismaFor({ source: 'AI_FLOOR_PLAN', status: 'APPROVED' });
    prisma.$transaction = jest.fn(async (run: (tx: unknown) => unknown) =>
      run({
        propertyArea: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(areaRow({ source: 'AI_FLOOR_PLAN' })),
        },
        areaChecklistItem: {
          createMany: jest.fn((call: typeof seeded) => {
            seeded = call;
            return Promise.resolve({ count: call?.data.length ?? 0 });
          }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      }),
    ) as never;

    await service(prisma).updateArea(admin, 'area-1', wholeForm as never);

    expect(seeded?.data.length).toBeGreaterThan(0);
    expect(seeded?.data.every((item) => item.kind === 'AIR_CONDITIONING')).toBe(true);
  });

  it('still refuses a genuine rename of a frozen area', async () => {
    // The relaxation is about unchanged values, not about the rule.
    const prisma = prismaFor({ source: 'AI_FLOOR_PLAN', status: 'APPROVED' });

    await expect(
      service(prisma).updateArea(admin, 'area-1', {
        ...wholeForm,
        name: 'Kitchenette',
      } as never),
    ).rejects.toMatchObject({ code: 'AREA_ALREADY_APPROVED' });
  });
});
