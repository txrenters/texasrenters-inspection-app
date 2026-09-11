import { UserRole } from '@texasrenters/shared';

import { ComparisonService } from '../src/admin/comparison.service';
import type { AuthenticatedUser } from '../src/common/auth';

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Administrator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
};

function area(propertyAreaId: string, name: string, category = 'INDOOR_ROOM', floor = '1') {
  return {
    propertyAreaId,
    propertyArea: {
      name,
      category,
      floor: { name: floor },
      aliases: [] as Array<{ alias: string }>,
    },
  };
}

/**
 * An area's captured evidence. `photos` defaults to 0 so the recording-only
 * fixtures below read unchanged; pass it to describe an area documented with
 * stills instead of a video, which is what a PDF import produces.
 */
function mediaRow(propertyAreaId: string, count: number, photos = 0) {
  return { propertyAreaId, _count: { media: count, photos } };
}

/** A checklist item a technician or an imported report graded as failed. */
function failedItem(propertyAreaId: string) {
  return { inspectionArea: { propertyAreaId } };
}

/**
 * Build a prisma double for ComparisonService.generate. The three
 * inspectionArea.findMany calls fire in this order: move-out areas, move-in
 * areas, move-out evidence counts; inspectionFinding.findMany and
 * inspectionAreaChecklistResponse.findMany each fire for move-out then move-in
 * damage.
 */
function generatePrisma(opts: {
  moveOut: Record<string, unknown>;
  moveIn: { id: string } | null;
  existing?: { id: string; status: string; version: number } | null;
  moveOutAreas: ReturnType<typeof area>[];
  moveInAreas: ReturnType<typeof area>[];
  moveOutMedia: ReturnType<typeof mediaRow>[];
  moveOutDamage: Array<{ propertyAreaId: string }>;
  moveInDamage: Array<{ propertyAreaId: string }>;
  // Default empty: the recording-based fixtures record damage as findings.
  moveOutFailedItems?: ReturnType<typeof failedItem>[];
  moveInFailedItems?: ReturnType<typeof failedItem>[];
}) {
  const created: { data?: Record<string, unknown> } = {};
  const areaCreateMany = { data: [] as Array<Record<string, unknown>> };
  const tx = {
    inspectionAreaComparison: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockImplementation((args: { data: Array<Record<string, unknown>> }) => {
        areaCreateMany.data = args.data;
        return Promise.resolve({ count: args.data.length });
      }),
    },
    inspectionComparison: {
      create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        created.data = args.data;
        return Promise.resolve({ id: 'comparison-1' });
      }),
      update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        created.data = args.data;
        return Promise.resolve({ id: opts.existing?.id ?? 'comparison-1' });
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    inspection: {
      findUnique: jest.fn().mockResolvedValue(opts.moveOut),
      findFirst: jest.fn().mockResolvedValue(opts.moveIn),
    },
    inspectionComparison: {
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      findFirst: jest.fn().mockResolvedValue({
        id: 'comparison-1',
        moveOutInspectionId: opts.moveOut.id,
        moveInInspectionId: opts.moveIn?.id ?? null,
        status: 'DRAFT',
        overallCondition: 'REQUIRES_REVIEW',
        version: 1,
        generator: 'DETERMINISTIC',
        requiresReviewCount: 0,
        summary: '',
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        generatedAt: new Date(),
        areaComparisons: [],
      }),
    },
    inspectionArea: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.moveOutAreas)
        .mockResolvedValueOnce(opts.moveInAreas)
        .mockResolvedValueOnce(opts.moveOutMedia),
    },
    inspectionFinding: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.moveOutDamage)
        .mockResolvedValueOnce(opts.moveInDamage),
    },
    inspectionAreaChecklistResponse: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.moveOutFailedItems ?? [])
        .mockResolvedValueOnce(opts.moveInFailedItems ?? []),
    },
    userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { prisma, tx, created, areaCreateMany };
}

const moveOut = {
  id: 'move-out-1',
  organizationId: user.organizationId,
  inspectionType: 'MOVE_OUT',
  propertywareBuildingId: 'building-1',
  propertywareUnitId: 'unit-1',
  propertywareLeaseId: 'lease-1',
  baselineInspectionId: 'move-in-1',
  scheduledAt: new Date('2026-07-01T00:00:00.000Z'),
};

describe('move-in vs move-out comparison (spec §12)', () => {
  it('flags new move-out damage and leaves clean areas unchanged', async () => {
    const { prisma, created, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      moveInAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      moveOutMedia: [mediaRow('pa-kitchen', 1), mediaRow('pa-bed', 1)],
      moveOutDamage: [{ propertyAreaId: 'pa-kitchen' }],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id });

    const byArea = Object.fromEntries(areaCreateMany.data.map((a) => [a.moveOutPropertyAreaId, a]));
    expect(byArea['pa-kitchen']).toMatchObject({
      classification: 'NEW_DAMAGE',
      matchMethod: 'LOCAL_AREA_ID',
      requiresReview: true,
    });
    expect(byArea['pa-bed']).toMatchObject({
      classification: 'UNCHANGED',
      requiresReview: false,
    });
    expect(created.data).toMatchObject({
      status: 'DRAFT',
      overallCondition: 'NEW_DAMAGE',
      requiresReviewCount: 1,
      version: 1,
    });
  });

  /**
   * An area whose evidence is photographs rather than a recording. Every
   * inspection imported from an Inspect & Cloud PDF is this shape -- the
   * importer writes `InspectionPhoto` and never `InspectionMedia` -- as is any
   * room a technician photographed instead of filming. Counting recordings
   * alone reported a perfectly matched area as MISSING_MOVE_OUT_EVIDENCE, and
   * because the empty count was recomputed identically on every run,
   * regenerating or rejecting and regenerating never cleared it.
   */
  it('treats photographs as move-out evidence when an area has no recording', async () => {
    const { prisma, areaCreateMany, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      moveInAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      // No recordings at all; the kitchen was photographed, the bedroom was not.
      moveOutMedia: [mediaRow('pa-kitchen', 0, 12), mediaRow('pa-bed', 0, 0)],
      moveOutDamage: [],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id });

    const byArea = Object.fromEntries(areaCreateMany.data.map((a) => [a.moveOutPropertyAreaId, a]));
    expect(byArea['pa-kitchen']).toMatchObject({
      classification: 'UNCHANGED',
      matchMethod: 'LOCAL_AREA_ID',
      requiresReview: false,
    });
    // An area with neither a recording nor a photograph is still unevidenced.
    expect(byArea['pa-bed']).toMatchObject({
      classification: 'MISSING_MOVE_OUT_EVIDENCE',
      requiresReview: true,
    });
    expect(created.data).toMatchObject({ requiresReviewCount: 1 });
  });

  /**
   * An imported inspection has no `InspectionFinding` rows at all -- that table
   * requires an `inspectionMediaId` and an imported report has no recording --
   * so every defect it records lives on a failed checklist response. Counting
   * findings alone scored these areas zero, which once photographs began
   * counting as evidence would have printed "no new damage detected" over a
   * room the report graded damaged.
   */
  it('counts a failed checklist grade as damage when an import has no findings', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      moveInAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      moveOutMedia: [mediaRow('pa-kitchen', 0, 8), mediaRow('pa-bed', 0, 5)],
      // No findings on either side, as an imported pair of inspections has none.
      moveOutDamage: [],
      moveInDamage: [],
      // The move-out report graded the kitchen damaged; the move-in did not.
      moveOutFailedItems: [failedItem('pa-kitchen')],
      moveInFailedItems: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id });

    const byArea = Object.fromEntries(areaCreateMany.data.map((a) => [a.moveOutPropertyAreaId, a]));
    expect(byArea['pa-kitchen']).toMatchObject({
      classification: 'NEW_DAMAGE',
      requiresReview: true,
    });
    expect(byArea['pa-bed']).toMatchObject({ classification: 'UNCHANGED' });
  });

  it('marks unmatched areas as MISSING_BASELINE / MISSING_MOVE_OUT_EVIDENCE', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      // Different room name + category so no deterministic match is possible.
      moveOutAreas: [area('pa-garage', 'Garage', 'GARAGE')],
      moveInAreas: [area('pa-kitchen', 'Kitchen', 'INDOOR_ROOM')],
      moveOutMedia: [mediaRow('pa-garage', 1)],
      moveOutDamage: [],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id });

    const classifications = areaCreateMany.data.map((a) => a.classification).sort();
    expect(classifications).toEqual(['MISSING_BASELINE', 'MISSING_MOVE_OUT_EVIDENCE']);
    expect(areaCreateMany.data.every((a) => a.requiresReview)).toBe(true);
  });

  it('matches a renamed room through an approved alias', async () => {
    const moveOutArea = area('pa-den', 'Den');
    const moveInArea = area('pa-office', 'Office');
    moveInArea.propertyArea.aliases = [{ alias: 'Den' }];
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [moveOutArea],
      moveInAreas: [moveInArea],
      moveOutMedia: [mediaRow('pa-den', 1)],
      moveOutDamage: [],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id });

    expect(areaCreateMany.data).toHaveLength(1);
    expect(areaCreateMany.data[0]).toMatchObject({
      classification: 'UNCHANGED',
      matchMethod: 'APPROVED_ALIAS',
    });
  });

  it('refuses to regenerate over an approved comparison', async () => {
    const { prisma } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      existing: { id: 'comparison-1', status: 'APPROVED', version: 2 },
      moveOutAreas: [],
      moveInAreas: [],
      moveOutMedia: [],
      moveOutDamage: [],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await expect(
      service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id }),
    ).rejects.toMatchObject({ status: 409, code: 'COMPARISON_ALREADY_APPROVED' });
  });

  it('bumps the version when regenerating a draft', async () => {
    const { prisma, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      existing: { id: 'comparison-1', status: 'DRAFT', version: 3 },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutDamage: [],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id });
    expect(created.data).toMatchObject({ version: 4, status: 'DRAFT' });
  });

  it('fails when no matching move-in baseline exists', async () => {
    const { prisma } = generatePrisma({
      moveOut: { ...moveOut, baselineInspectionId: null },
      moveIn: null,
      moveOutAreas: [],
      moveInAreas: [],
      moveOutMedia: [],
      moveOutDamage: [],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await expect(
      service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id }),
    ).rejects.toMatchObject({ status: 409, code: 'MOVE_IN_BASELINE_NOT_FOUND' });
  });

  it('rejects generating a comparison for a non-move-out inspection', async () => {
    const { prisma } = generatePrisma({
      moveOut: { ...moveOut, inspectionType: 'MOVE_IN' },
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [],
      moveInAreas: [],
      moveOutMedia: [],
      moveOutDamage: [],
      moveInDamage: [],
    });
    const service = new ComparisonService(prisma as never);

    await expect(
      service.generate('move-out-1', { organizationId: user.organizationId, userId: user.id }),
    ).rejects.toMatchObject({ status: 422, code: 'NOT_A_MOVE_OUT' });
  });
});

describe('comparison review + override (spec §12)', () => {
  it('approves a comparison and records the reviewer and audit event', async () => {
    const tx = {
      inspectionComparison: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspectionComparison: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'comparison-1',
            status: 'DRAFT',
            moveOutInspectionId: 'move-out-1',
          })
          .mockResolvedValueOnce({
            id: 'comparison-1',
            moveOutInspectionId: 'move-out-1',
            moveInInspectionId: 'move-in-1',
            status: 'APPROVED',
            overallCondition: 'UNCHANGED',
            version: 1,
            generator: 'DETERMINISTIC',
            requiresReviewCount: 0,
            summary: '',
            reviewedById: user.id,
            reviewedAt: new Date(),
            reviewNote: null,
            generatedAt: new Date(),
            areaComparisons: [],
          }),
      },
      userProfile: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Administrator' }) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new ComparisonService(prisma as never);

    await service.review(user, 'comparison-1', 'APPROVED');
    expect(tx.inspectionComparison.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'comparison-1' },
        data: expect.objectContaining({ status: 'APPROVED', reviewedById: user.id }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'INSPECTION_COMPARISON_APPROVED' }),
      }),
    );
  });

  it('overrides an area classification, preserving the original and auditing', async () => {
    const tx = {
      inspectionAreaComparison: {
        update: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValue([{ classification: 'UNCHANGED', requiresReview: false }]),
      },
      inspectionComparison: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspectionAreaComparison: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'area-comparison-1',
          classification: 'NEW_DAMAGE',
          originalClassification: null,
          comparisonId: 'comparison-1',
          comparison: { moveOutInspectionId: 'move-out-1' },
        }),
      },
      inspectionComparison: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'comparison-1',
          moveOutInspectionId: 'move-out-1',
          moveInInspectionId: 'move-in-1',
          status: 'DRAFT',
          overallCondition: 'UNCHANGED',
          version: 1,
          generator: 'DETERMINISTIC',
          requiresReviewCount: 0,
          summary: '',
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
          generatedAt: new Date(),
          areaComparisons: [],
        }),
      },
      userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new ComparisonService(prisma as never);

    await service.overrideArea(
      user,
      'area-comparison-1',
      'UNCHANGED' as never,
      'Pre-existing wear',
    );
    expect(tx.inspectionAreaComparison.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'area-comparison-1' },
        data: expect.objectContaining({
          classification: 'UNCHANGED',
          originalClassification: 'NEW_DAMAGE',
          overriddenById: user.id,
          requiresReview: false,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'INSPECTION_AREA_COMPARISON_OVERRIDDEN',
          metadata: expect.objectContaining({ from: 'NEW_DAMAGE', to: 'UNCHANGED' }),
        }),
      }),
    );
  });
});

/**
 * A move-out report is compared against the **latest** move-in for the
 * property, stated as a rule by the office on 2026-09-02.
 *
 * `resolveBaseline` used to prefer `baselineInspectionId` — the link written
 * when the move-out was created, which records what was current *then*. A
 * move-in that happened after the move-out was scheduled but before it was
 * carried out therefore lost to an older one that was still in scope. A new
 * tenancy usually hid it, because the lease is part of the scope and a stale
 * link fails it — but a Jobber-created inspection often carries no lease, and
 * nulls match nulls.
 */
describe('which move-in a move-out is compared against', () => {
  const moveOut = {
    organizationId: user.organizationId,
    propertywareBuildingId: 'building-1',
    propertywareUnitId: null,
    propertywareLeaseId: null,
    baselineInspectionId: 'older-move-in',
    scheduledAt: new Date('2026-09-01T00:00:00.000Z'),
  };

  const resolve = (prisma: unknown) =>
    (
      new ComparisonService(prisma as never) as unknown as {
        resolveBaseline: (m: typeof moveOut) => Promise<{ id: string } | null>;
      }
    ).resolveBaseline(moveOut);

  it('takes the newest one, not the one linked when it was created', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'newer-move-in' });
    await expect(resolve({ inspection: { findFirst } })).resolves.toEqual({ id: 'newer-move-in' });
    // One query, not two: the linked lookup is gone entirely.
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('orders by scheduled date descending, which is what "latest" means here', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'newer-move-in' });
    await resolve({ inspection: { findFirst } });
    const call = findFirst.mock.calls[0][0] as {
      orderBy: { scheduledAt: string };
      where: Record<string, unknown>;
    };
    expect(call.orderBy).toEqual({ scheduledAt: 'desc' });
    // Never a move-in dated after the move-out. The old linked lookup applied
    // no date filter at all and could return exactly that.
    expect(call.where.scheduledAt).toEqual({ lt: moveOut.scheduledAt });
  });

  it('keeps the lease in scope, so a previous tenancy is never borrowed', async () => {
    // Dropping it is how a new tenant gets charged for the last one's damage.
    const findFirst = jest.fn().mockResolvedValue(null);
    await resolve({ inspection: { findFirst } });
    const where = findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.propertywareLeaseId).toBe(moveOut.propertywareLeaseId);
    expect(where.propertywareBuildingId).toBe('building-1');
    expect(where.propertywareUnitId).toBeNull();
  });

  it('answers nothing rather than reaching for an unrelated move-in', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    await expect(resolve({ inspection: { findFirst } })).resolves.toBeNull();
  });
});
