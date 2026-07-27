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
