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

function mediaRow(propertyAreaId: string, count: number) {
  return { propertyAreaId, _count: { media: count } };
}

/**
 * Build a prisma double for ComparisonService.generate. The three
 * inspectionArea.findMany calls fire in this order: move-out areas, move-in
 * areas, move-out media counts; inspectionFinding.findMany fires for move-out
 * then move-in damage.
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
