import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { FloorPlanAdminService } from '../src/admin/floor-plan-admin.service';

/**
 * Extraction is started, not awaited — the request returns a job id and the
 * work continues on the microtask queue. Draining it lets a test observe the
 * outcome the client would later poll for.
 */
async function flushBackgroundWork() {
  for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Property Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

const building = {
  id: '20000000-0000-4000-8000-000000000001',
  organizationId: admin.organizationId,
  name: '100 Main Street',
  addressLine1: '100 Main Street',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  isActive: true,
};

describe('administrator floor plans', () => {
  it('rejects a spoofed file before storage or persistence', async () => {
    const prisma = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
      property: { upsert: jest.fn() },
      propertyFloorPlan: { create: jest.fn() },
    };
    const storage = { put: jest.fn(), delete: jest.fn() };
    const service = new FloorPlanAdminService(
      prisma as never,
      storage as never,
      {} as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
      {} as never,
    );

    await expect(
      service.upload(admin, building.id, {
        originalname: 'floor-plan.pdf',
        mimetype: 'application/pdf',
        size: 12,
        buffer: Buffer.from('not a pdf'),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_FLOOR_PLAN_FILE' });
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.propertyFloorPlan.create).not.toHaveBeenCalled();
  });

  it('stores a valid private file and audits metadata without file contents', async () => {
    const plan = { id: '30000000-0000-4000-8000-000000000001', fileName: 'plan.png' };
    const prisma = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
      property: { upsert: jest.fn().mockResolvedValue({ id: building.id }) },
      propertyFloorPlan: { create: jest.fn().mockResolvedValue(plan) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new FloorPlanAdminService(
      prisma as never,
      storage as never,
      {} as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
      {} as never,
    );
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

    await expect(
      service.upload(admin, building.id, {
        originalname: 'plan.png',
        mimetype: 'image/png',
        size: bytes.length,
        buffer: bytes,
      }),
    ).resolves.toMatchObject(plan);

    expect(storage.put).toHaveBeenCalledWith(
      expect.stringContaining(building.id),
      bytes,
      'image/png',
    );
    const auditPayload = JSON.stringify(prisma.auditLog.create.mock.calls);
    expect(auditPayload).toContain('FLOOR_PLAN_UPLOADED');
    expect(auditPayload).not.toContain(bytes.toString('base64'));
  });

  it('does not expose a floor plan across organization boundaries', async () => {
    const prisma = {
      propertyFloorPlan: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { get: jest.fn() };
    const service = new FloorPlanAdminService(
      prisma as never,
      storage as never,
      {} as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
      {} as never,
    );

    await expect(
      service.content(admin, '30000000-0000-4000-8000-000000000099'),
    ).rejects.toMatchObject({ status: 404, code: 'FLOOR_PLAN_NOT_FOUND' });
    expect(prisma.propertyFloorPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: '30000000-0000-4000-8000-000000000099',
          property: { organizationId: admin.organizationId },
        },
        select: expect.objectContaining({ storageKey: true }),
      }),
    );
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('preserves an actionable provider error when failure bookkeeping also fails', async () => {
    const providerError = new ApplicationError(
      402,
      'FLOOR_PLAN_AI_CREDITS_REQUIRED',
      'AI extraction credits are unavailable.',
    );
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'plan-1',
          propertyId: building.id,
          storageKey: 'private/plan.png',
          fileName: 'plan.png',
          mimeType: 'image/png',
        }),
        update: jest
          .fn()
          .mockResolvedValueOnce({ id: 'plan-1', status: 'PROCESSING' })
          .mockRejectedValueOnce(new Error('status update unavailable')),
      },
      floorPlanExtractionJob: {
        // No extraction already running for this plan.
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockRejectedValue(new Error('job update unavailable')),
      },
    };
    const storage = { get: jest.fn().mockResolvedValue(Buffer.from('plan')) };
    const extraction = {
      descriptor: jest.fn().mockReturnValue({
        provider: 'anthropic',
        modelId: 'test-model',
        schemaVersion: '1',
      }),
      extract: jest.fn().mockRejectedValue(providerError),
    };
    const service = new FloorPlanAdminService(
      prisma as never,
      storage as never,
      extraction as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
      {
        resolve: jest.fn().mockResolvedValue({
          provider: 'ANTHROPIC',
          modelId: 'test-model',
          apiKey: 'private-test-key',
        }),
      } as never,
    );

    // Extraction runs outside the request now, so starting it resolves with the
    // job to poll and the provider failure is recorded on that job instead of
    // being thrown at the caller.
    await expect(service.extract(admin, 'plan-1')).resolves.toMatchObject({
      jobId: 'job-1',
      status: 'RUNNING',
    });
    await flushBackgroundWork();

    // The actionable provider code still survives, even though the bookkeeping
    // writes themselves fail — that was the point of this test.
    expect(prisma.floorPlanExtractionJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'FLOOR_PLAN_AI_CREDITS_REQUIRED' }),
      }),
    );
  });

  it('reports all detected areas and keeps new draft orders unique when approved areas exist', async () => {
    const plan = {
      id: '30000000-0000-4000-8000-000000000010',
      propertyId: building.id,
      unitId: null,
      storageKey: 'private/plan.png',
      fileName: 'plan.png',
      mimeType: 'image/png',
    };
    const existing = [
      {
        name: 'Kitchen',
        inspectionOrder: 1,
        floor: { name: 'Ground Floor' },
      },
      {
        name: 'Living Room',
        inspectionOrder: 2,
        floor: { name: 'Ground Floor' },
      },
    ];
    const created = [
      { id: 'area-foyer', name: 'Foyer', inspectionOrder: 3 },
      { id: 'area-porch', name: 'Front Porch', inspectionOrder: 4 },
    ];
    const tx = {
      propertyArea: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(created),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      propertyFloor: {
        findMany: jest.fn().mockResolvedValue([{ id: 'floor-1', name: 'Ground Floor' }]),
        create: jest.fn(),
      },
      floorPlanExtractionJob: { update: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      propertyFloorPlan: { update: jest.fn().mockResolvedValue(plan) },
      // Extraction now writes each area's default checklist alongside the area
      // itself, rather than leaving it until approval.
      areaChecklistItem: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue(plan),
        update: jest.fn().mockResolvedValue(plan),
      },
      floorPlanExtractionJob: {
        // No extraction already running for this plan.
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'job-1',
          provider: 'openai',
          modelId: 'test-model',
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const extraction = {
      descriptor: jest.fn().mockReturnValue({
        provider: 'openai',
        modelId: 'test-model',
        schemaVersion: '1',
      }),
      extract: jest.fn().mockResolvedValue({
        areas: [
          {
            floorName: 'Ground Floor',
            name: 'Kitchen',
            inspectionOrder: 1,
            isRequired: true,
          },
          {
            floorName: 'Ground Floor',
            name: 'Living Room',
            inspectionOrder: 2,
            isRequired: true,
          },
          {
            floorName: 'Ground Floor',
            name: 'Foyer',
            inspectionOrder: 1,
            isRequired: true,
          },
          {
            floorName: 'Ground Floor',
            name: 'Front Porch',
            inspectionOrder: 4,
            isRequired: false,
          },
        ],
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      }),
    };
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        provider: 'OPENAI',
        modelId: 'test-model',
        apiKey: 'private-test-key',
      }),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new FloorPlanAdminService(
      prisma as never,
      { get: jest.fn().mockResolvedValue(Buffer.from('plan')) } as never,
      extraction as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
      aiSettings as never,
    );

    // Starting extraction returns the job to poll; the outcome lands on the job.
    await expect(service.extract(admin, plan.id)).resolves.toMatchObject({
      status: 'RUNNING',
    });
    await flushBackgroundWork();

    expect(tx.propertyArea.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ name: 'Foyer', inspectionOrder: 3 }),
        expect.objectContaining({ name: 'Front Porch', inspectionOrder: 4 }),
      ]),
    });
    expect(tx.floorPlanExtractionJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          output: expect.objectContaining({
            summary: {
              detectedCount: 4,
              createdCount: 2,
              alreadyPresentCount: 2,
              // Neither created area carried a spatial marker in this fixture.
              markerWarnings: 2,
            },
          }),
        }),
      }),
    );
  });

  it('approves only selected draft areas belonging to the active property', async () => {
    const areaIds = [
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
    ];
    const tx = {
      propertyArea: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      propertyFloorPlan: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      // Approval now also writes each area's default checklist.
      areaChecklistItem: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
      propertyArea: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            areaIds.map((id) => ({ id, propertyId: building.id, status: 'DRAFT' })),
          ),
      },
      // Nothing has a checklist yet, so every approved area gets the default.
      areaChecklistItem: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new FloorPlanAdminService(
      prisma as never,
      {} as never,
      {} as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
      {} as never,
    );
    jest.spyOn(service, 'areas').mockResolvedValue([]);

    await service.approveAreas(admin, building.id, areaIds);

    expect(prisma.propertyArea.findMany).toHaveBeenCalledWith({
      where: { id: { in: areaIds }, propertyId: building.id, status: 'DRAFT' },
      // Name, category and environment ride along because approval is where an
      // extracted area gets its default checklist, and the template reads all
      // three to choose a list.
      select: { id: true, name: true, category: true, environment: true },
    });
    // Approval is where an extracted area gets the same house-standard list a
    // technician-added area gets on creation.
    expect(tx.areaChecklistItem.createMany).toHaveBeenCalled();
    expect(tx.propertyArea.updateMany).toHaveBeenCalledWith({
      where: { id: { in: areaIds } },
      data: { status: 'APPROVED' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ metadata: { areaIds } }) }),
    );
  });

  it('creates an audited approved fallback area when floor-plan areas are unavailable', async () => {
    const fallback = {
      id: '40000000-0000-4000-8000-000000000003',
      propertyId: building.id,
      name: 'Entire property',
      status: 'APPROVED',
    };
    const tx = {
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(fallback),
        update: jest.fn(),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
      property: { upsert: jest.fn().mockResolvedValue({ id: building.id }) },
      propertyFloor: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'floor-1',
          propertyId: building.id,
          name: 'Whole property',
          sortOrder: 1,
        }),
        create: jest.fn(),
      },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new FloorPlanAdminService(
      prisma as never,
      {} as never,
      {} as never,
      // Returns nothing per area, so the service falls back to the shared
      // templates and these assertions stay deterministic and offline.
      { generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }) } as never,
      {} as never,
    );

    // The area is returned through the marker-aware DTO mapper, so compare by
    // shape rather than identity. A fallback area carries no spatial marker.
    await expect(service.createFallbackArea(admin, building.id)).resolves.toMatchObject({
      id: fallback.id,
      propertyId: fallback.propertyId,
      name: 'Entire property',
      status: 'APPROVED',
      marker: null,
      boundingBox: null,
    });

    expect(tx.propertyArea.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Entire property',
          isRequired: true,
          source: 'MANUAL_FALLBACK',
          status: 'APPROVED',
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PROPERTY_FALLBACK_AREA_APPROVED' }),
      }),
    );
  });
});
