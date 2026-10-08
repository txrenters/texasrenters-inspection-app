import type { Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { UserRole } from '@texasrenters/shared';

import { baselineWhere, COMPARISON_RULES, ComparisonService } from '../src/admin/comparison.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';

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

type FindingRow = {
  propertyAreaId: string;
  findingType: string;
  comparisonResult: string | null;
  title?: string;
  category?: string;
  reviewStatus?: string;
};
type ResponseRow = {
  isUndamaged: boolean | null;
  isWorking: boolean | null;
  inspectionArea: { propertyAreaId: string };
};

/**
 * A finding of new damage the office confirmed from the recording, shaped as
 * `loadConditionSignals` selects it. Only a confirmed one is damage.
 */
function damageFinding(propertyAreaId: string, title = 'Wall: hole beside the door') {
  return {
    propertyAreaId,
    findingType: 'POSSIBLE_NEW_DAMAGE',
    comparisonResult: null,
    title,
    category: 'Walls',
    reviewStatus: 'APPROVED',
  };
}

/** The same, still waiting for the office: it moves nothing. */
function pendingDamage(propertyAreaId: string) {
  return { ...damageFinding(propertyAreaId), reviewStatus: 'PENDING_REVIEW' };
}

/** An area the AI assessed and found unremarkable: graded, but not damage. */
function soundFinding(propertyAreaId: string) {
  return { propertyAreaId, findingType: 'NO_CHANGE', comparisonResult: null };
}

/** A checklist item graded damaged or not working. */
function failedItem(propertyAreaId: string) {
  return { isUndamaged: false, isWorking: null, inspectionArea: { propertyAreaId } };
}

/** A checklist item graded and found sound — the area was assessed. */
function soundItem(propertyAreaId: string) {
  return { isUndamaged: true, isWorking: true, inspectionArea: { propertyAreaId } };
}

/**
 * An item where only cleanliness was graded. The query returns it because
 * `isClean` is non-null, but the select carries no `isClean`, so both damage
 * grades read null — which is exactly the point: being dirty is not damage.
 */
function dirtyItem(propertyAreaId: string) {
  return { isUndamaged: null, isWorking: null, inspectionArea: { propertyAreaId } };
}

/**
 * The reads `staleness` makes, added to a double: by default nothing changed
 * since the comparison was drawn, and the same move-in.
 */
function withStaleness<T extends Record<string, unknown>>(
  prisma: T,
  opts: {
    checklistChanged?: boolean;
    roomAdded?: boolean;
    latestMoveIn?: string;
    findingChanged?: boolean;
    photoAdded?: boolean;
    recordingAdded?: boolean;
  } = {},
) {
  const part = (key: string) => {
    const existing = (prisma as Record<string, Record<string, unknown> | undefined>)[key] ?? {};
    (prisma as Record<string, unknown>)[key] = existing;
    return existing;
  };
  const found = (yes: boolean | undefined, id: string) => jest.fn().mockResolvedValue(yes ? { id } : null);
  Object.assign(part('inspectionAreaChecklistResponse'), { findFirst: found(opts.checklistChanged, 'response-1') });
  Object.assign(part('inspectionArea'), { findFirst: found(opts.roomAdded, 'area-new') });
  Object.assign(part('inspectionFinding'), { findFirst: found(opts.findingChanged, 'finding-1') });
  Object.assign(part('inspectionPhoto'), { findFirst: found(opts.photoAdded, 'photo-1') });
  Object.assign(part('inspectionMedia'), { findFirst: found(opts.recordingAdded, 'media-1') });
  const inspection = part('inspection');
  inspection.findUnique ??= jest.fn().mockResolvedValue(moveOutRecord());
  inspection.findFirst ??= jest
    .fn()
    .mockResolvedValue({ id: opts.latestMoveIn ?? 'move-in-1', scheduledAt: new Date('2025-06-12') });
  return prisma;
}

function moveOutRecord() {
  return {
    id: 'move-out-1',
    organizationId: '10000000-0000-4000-8000-000000000001',
    inspectionType: 'MOVE_OUT',
    propertywareBuildingId: 'building-1',
    propertywareUnitId: 'unit-1',
    propertywareLeaseId: 'lease-1',
    baselineInspectionId: 'move-in-1',
    scheduledAt: new Date('2026-07-01T00:00:00.000Z'),
  };
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
  moveOutFindings: FindingRow[];
  moveInFindings: FindingRow[];
  // Default empty: the recording-based fixtures record condition as findings.
  moveOutResponses?: ResponseRow[];
  moveInResponses?: ResponseRow[];
}) {
  const created: { data?: Record<string, unknown> } = {};
  const areaCreateMany = { data: [] as Array<Record<string, unknown>> };
  const tx = {
    // The lock that keeps two redraws of one move-out from interleaving.
    $executeRaw: jest.fn().mockResolvedValue(1),
    inspectionAreaComparison: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockImplementation((args: { data: Array<Record<string, unknown>> }) => {
        areaCreateMany.data = args.data;
        return Promise.resolve({ count: args.data.length });
      }),
    },
    inspectionComparison: {
      // Read under the lock.
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
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
      findFirst: jest.fn().mockResolvedValue({
        id: 'comparison-1',
        moveOutInspectionId: opts.moveOut.id,
        moveInInspectionId: opts.moveIn?.id ?? null,
        status: 'DRAFT',
        overallCondition: 'UNCHANGED',
        version: 1,
        generator: 'DETERMINISTIC',
        summary: '',
        metadata: { rules: COMPARISON_RULES },
        generatedAt: new Date(),
        areaComparisons: [],
      }),
    },
    inspectionArea: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.moveOutAreas)
        .mockResolvedValueOnce(opts.moveInAreas)
        .mockResolvedValueOnce(opts.moveOutMedia)
        // `load`, afterwards: the move-out's area rows, for opening one.
        .mockResolvedValue([]),
    },
    inspectionFinding: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.moveOutFindings)
        .mockResolvedValueOnce(opts.moveInFindings)
        // `load`, afterwards: the findings shown beside each item.
        .mockResolvedValue([]),
    },
    inspectionAreaChecklistResponse: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.moveOutResponses ?? [])
        .mockResolvedValueOnce(opts.moveInResponses ?? []),
    },
    // `load`, afterwards: recordings still with the AI.
    inspectionMedia: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  withStaleness(prisma);
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
      moveOutFindings: [damageFinding('pa-kitchen')],
      // The baseline assessed both rooms and found them sound. Without that,
      // "new" would be unsupported and the area would go to review instead.
      moveInFindings: [soundFinding('pa-kitchen'), soundFinding('pa-bed')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    const byArea = Object.fromEntries(areaCreateMany.data.map((a) => [a.moveOutPropertyAreaId, a]));
    expect(byArea['pa-kitchen']).toMatchObject({
      classification: 'NEW_DAMAGE',
      matchMethod: 'LOCAL_AREA_ID',
    });
    expect(byArea['pa-bed']).toMatchObject({
      classification: 'UNCHANGED',
    });
    expect(created.data).toMatchObject({
      status: 'DRAFT',
      overallCondition: 'NEW_DAMAGE',
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
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      moveInAreas: [area('pa-kitchen', 'Kitchen'), area('pa-bed', 'Bedroom')],
      // No recordings at all; the kitchen was photographed, the bedroom was not.
      moveOutMedia: [mediaRow('pa-kitchen', 0, 12), mediaRow('pa-bed', 0, 0)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    const byArea = Object.fromEntries(areaCreateMany.data.map((a) => [a.moveOutPropertyAreaId, a]));
    expect(byArea['pa-kitchen']).toMatchObject({
      classification: 'UNCHANGED',
      matchMethod: 'LOCAL_AREA_ID',
    });
    // An area with neither a recording nor a photograph is still unevidenced.
    expect(byArea['pa-bed']).toMatchObject({
      classification: 'MISSING_MOVE_OUT_EVIDENCE',
    });
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
      moveOutFindings: [],
      moveInFindings: [],
      // The move-out report graded the kitchen damaged; the move-in graded both
      // rooms and found them sound, which is what makes the kitchen's defect new.
      moveOutResponses: [failedItem('pa-kitchen')],
      moveInResponses: [soundItem('pa-kitchen'), soundItem('pa-bed')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    const byArea = Object.fromEntries(areaCreateMany.data.map((a) => [a.moveOutPropertyAreaId, a]));
    expect(byArea['pa-kitchen']).toMatchObject({
      classification: 'NEW_DAMAGE',
    });
    expect(byArea['pa-bed']).toMatchObject({ classification: 'UNCHANGED' });
  });

  /**
   * A move-out is expected to come back dirty; that is the tenant's cleaning
   * obligation, not harm to the property. Counting `isClean === false` as
   * damage put a NEW_DAMAGE badge on every room with one smudged item, which
   * on a real report meant thirteen of thirteen rooms.
   */
  it('treats a not-clean item as a cleaning matter rather than damage', async () => {
    const { prisma, areaCreateMany, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 0, 6)],
      moveOutFindings: [],
      moveInFindings: [],
      // Graded dirty, and nothing else.
      moveOutResponses: [dirtyItem('pa-kitchen')],
      moveInResponses: [soundItem('pa-kitchen')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data[0]).toMatchObject({
      classification: 'UNCHANGED',
    });
    expect(created.data).toMatchObject({ requiresReviewCount: 0 });
  });

  /**
   * An area the baseline never graded scores zero defects for the same reason a
   * spotless one does, and the two mean opposite things. Calling the defect new
   * on that basis invents a baseline nobody recorded, and it is the tenant's
   * deposit that pays for the guess.
   */
  it('will not call a defect new when the baseline graded nothing there', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 0, 9)],
      moveOutFindings: [],
      moveInFindings: [],
      moveOutResponses: [failedItem('pa-kitchen')],
      // The baseline recorded no condition for this area at all.
      moveInResponses: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data[0]).toMatchObject({
      // Said as what it is, rather than left for a reviewer to decide.
      classification: 'NOT_COMPARABLE',
    });
    expect(areaCreateMany.data[0]?.summary).toContain('the move-in recorded no condition for this room');
    expect(areaCreateMany.data[0]?.classification).not.toBe('NEW_DAMAGE');
  });

  /**
   * The order of the areas is stored, because it cannot be recovered.
   *
   * Every row is written by one `createMany` inside one transaction, and
   * `CURRENT_TIMESTAMP` is transaction start time -- so they all share a
   * `createdAt` to the millisecond and ordering by it is a tie. A tie is
   * unspecified in SQL, so the rows came back in whatever order the scan
   * yielded: stable only while the heap happened to hold insertion order, and
   * shuffled the moment an import rewrote the comparison.
   */
  it('writes down where each area sits, in the order it built them', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [
        area('pa-entrance', 'Entrance'),
        area('pa-kitchen', 'Kitchen'),
        area('pa-bed', 'Bedroom'),
      ],
      moveInAreas: [
        area('pa-entrance', 'Entrance'),
        area('pa-kitchen', 'Kitchen'),
        // Documented at move-in and never revisited: appended after the
        // move-out's own areas, and its position has to say so.
        area('pa-garage', 'Garage', 'GARAGE'),
      ],
      moveOutMedia: [
        mediaRow('pa-entrance', 1),
        mediaRow('pa-kitchen', 1),
        mediaRow('pa-bed', 1),
      ],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data.map((a) => a.position)).toEqual([0, 1, 2, 3]);
    // And position follows the build order rather than the area name.
    expect(areaCreateMany.data.map((a) => a.areaName)).toEqual([
      'Entrance',
      'Kitchen',
      'Bedroom',
      'Garage',
    ]);
  });

  it('marks unmatched areas as MISSING_BASELINE / MISSING_MOVE_OUT_EVIDENCE', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      // Different room name + category so no deterministic match is possible.
      moveOutAreas: [area('pa-garage', 'Garage', 'GARAGE')],
      moveInAreas: [area('pa-kitchen', 'Kitchen', 'INDOOR_ROOM')],
      moveOutMedia: [mediaRow('pa-garage', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    const classifications = areaCreateMany.data.map((a) => a.classification).sort();
    expect(classifications).toEqual(['MISSING_BASELINE', 'MISSING_MOVE_OUT_EVIDENCE']);
  });

  /**
   * The weak fallback, when there is genuinely only one candidate. A single
   * indoor room on the floor is an inference worth drawing, flagged at 50% and
   * sent to review.
   */
  it('pairs by category when exactly one candidate shares it', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      // Differently named, so only category can pair them.
      moveInAreas: [area('pa-kitchen-old', 'Kitchen / Breakfast')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutFindings: [],
      moveInFindings: [soundFinding('pa-kitchen-old')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data[0]).toMatchObject({
      matchMethod: 'AREA_CATEGORY',
      moveInPropertyAreaId: 'pa-kitchen-old',
    });
  });

  /**
   * The bug this exists for. The fallback took the *first* candidate sharing a
   * category and floor, from an unordered query -- so a move-out Kitchen could
   * pair with a move-in Bedroom, and the report then showed that bedroom's
   * photographs under the Kitchen. The badge read 50% and nothing else said so.
   *
   * Several candidates is a guess, and a guess is indistinguishable from
   * evidence once it is printed on the document that justifies a charge. No
   * match is the honest answer.
   */
  it('refuses to pair when several candidates share the category and floor', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      // Two indoor rooms on the same floor, neither named like the kitchen.
      moveInAreas: [area('pa-bed-1', 'Bedroom 1'), area('pa-bed-2', 'Bedroom 2')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    const kitchen = areaCreateMany.data.find((a) => a.moveOutPropertyAreaId === 'pa-kitchen');
    expect(kitchen).toMatchObject({
      classification: 'MISSING_BASELINE',
      matchMethod: 'UNMATCHED',
      moveInPropertyAreaId: null,
    });
    // And it never silently borrowed one of the bedrooms.
    expect(kitchen?.matchConfidence).toBe(0);
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
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data).toHaveLength(1);
    expect(areaCreateMany.data[0]).toMatchObject({
      classification: 'UNCHANGED',
      matchMethod: 'APPROVED_ALIAS',
    });
  });

  /**
   * There is no approval to protect any more (the office, 2026-10-07): a
   * comparison approved under the old rules is redrawn like any other, and the
   * record forgets the approval rather than claiming one for the new verdicts.
   */
  it('redraws a comparison approved under the old rules, keeping no approval', async () => {
    const { prisma, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      existing: { id: 'comparison-1', status: 'APPROVED', version: 2 },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutFindings: [],
      moveInFindings: [soundFinding('pa-kitchen')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(created.data).toMatchObject({
      status: 'DRAFT',
      version: 3,
      reviewedById: null,
      reviewedAt: null,
      reviewNote: null,
    });
  });

  it('draws one at a time per move-out, reading the record under the lock', async () => {
    const { prisma, tx, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    const [sql, key] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe('comparison:move-out-1');
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.inspectionComparison.findUnique.mock.invocationCallOrder[0],
    );
    // The rules it was drawn under, so a later rule change redraws it.
    expect(created.data?.metadata).toMatchObject({ rules: COMPARISON_RULES });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INSPECTION_COMPARISON_GENERATED',
      actorUserId: null,
      metadata: expect.objectContaining({ system: true, rules: COMPARISON_RULES }),
    });
  });

  /**
   * An AI finding nobody has looked at is not on the report, so it cannot be
   * what makes a room "new damage" there either. The console says it waits.
   */
  it('lets an unconfirmed AI finding move nothing, and notes that it waits', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutFindings: [pendingDamage('pa-kitchen')],
      moveInFindings: [soundFinding('pa-kitchen')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data[0]).toMatchObject({
      classification: 'UNCHANGED',
      metadata: { aiNote: expect.stringContaining('waiting to be confirmed') },
    });
  });

  it('names what the office confirmed, for the report to list', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutFindings: [damageFinding('pa-kitchen', 'Wall: hole beside the door')],
      moveInFindings: [soundFinding('pa-kitchen')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data[0]).toMatchObject({
      classification: 'NEW_DAMAGE',
      metadata: { fromRecording: ['Wall: hole beside the door'] },
    });
  });

  it('says damage on both sides cannot be compared where no item was graded at both', async () => {
    const { prisma, areaCreateMany, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 0, 4)],
      moveOutFindings: [],
      moveInFindings: [],
      moveOutResponses: [failedItem('pa-kitchen')],
      moveInResponses: [failedItem('pa-kitchen')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data[0]?.classification).toBe('NOT_COMPARABLE');
    expect(areaCreateMany.data[0]?.summary).toContain('Damage was recorded at both inspections');
    // Nothing could be compared at all: the headline says so.
    expect(created.data).toMatchObject({ overallCondition: 'NOT_COMPARABLE' });
  });

  it('never leaves a room "requires review"', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-kitchen', 'Kitchen'), area('pa-garage', 'Garage', 'GARAGE'), area('pa-bed', 'Bedroom')],
      moveInAreas: [area('pa-kitchen-old', 'Kitchen / Breakfast'), area('pa-bed', 'Bedroom')],
      moveOutMedia: [mediaRow('pa-kitchen', 1), mediaRow('pa-garage', 0), mediaRow('pa-bed', 0, 2)],
      moveOutFindings: [pendingDamage('pa-kitchen')],
      moveInFindings: [],
      moveOutResponses: [failedItem('pa-bed')],
      moveInResponses: [failedItem('pa-bed')],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data.map((a) => a.classification)).not.toContain('REQUIRES_REVIEW');
    expect(areaCreateMany.data.every((a) => a.requiresReview === undefined)).toBe(true);
  });

  it('bumps the version when regenerating a draft', async () => {
    const { prisma, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      existing: { id: 'comparison-1', status: 'DRAFT', version: 3 },
      moveOutAreas: [area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen')],
      moveOutMedia: [mediaRow('pa-kitchen', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');
    expect(created.data).toMatchObject({ version: 4, status: 'DRAFT' });
  });

  it('fails when no matching move-in baseline exists', async () => {
    const { prisma } = generatePrisma({
      moveOut: { ...moveOut, baselineInspectionId: null },
      moveIn: null,
      moveOutAreas: [],
      moveInAreas: [],
      moveOutMedia: [],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await expect(
      service.generate('move-out-1'),
    ).rejects.toMatchObject({ status: 409, code: 'MOVE_IN_BASELINE_NOT_FOUND' });
  });

  it('rejects generating a comparison for a non-move-out inspection', async () => {
    const { prisma } = generatePrisma({
      moveOut: { ...moveOut, inspectionType: 'MOVE_IN' },
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [],
      moveInAreas: [],
      moveOutMedia: [],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await expect(
      service.generate('move-out-1'),
    ).rejects.toMatchObject({ status: 422, code: 'NOT_A_MOVE_OUT' });
  });
});

/**
 * Nobody approves a comparison (the office, 2026-10-07: the maintenance admin
 * "will not going to mark review every everything"). It keeps itself current
 * instead: wherever it is read, it is redrawn if anything under it moved.
 */
describe('a comparison that keeps itself current', () => {
  const drawn = (metadata: Prisma.JsonValue = { rules: COMPARISON_RULES }) => ({
    id: 'comparison-1',
    moveOutInspectionId: 'move-out-1',
    moveInInspectionId: 'move-in-1',
    generatedAt: new Date('2026-10-06T15:00:00Z'),
    metadata,
  });

  function reading(
    record: ReturnType<typeof drawn> | null,
    changed: Parameters<typeof withStaleness>[1] = {},
    moveOut: Record<string, unknown> | null = { inspectionType: 'MOVE_OUT', status: 'REVIEW_REQUIRED' },
  ) {
    const prisma = withStaleness(
      {
        inspectionComparison: { findFirst: jest.fn().mockResolvedValue(record) },
        inspection: {
          findUnique: jest.fn().mockResolvedValue(moveOutRecord()),
          // With a record: the latest move-in. Without: the move-out itself.
          findFirst: jest
            .fn()
            .mockResolvedValue(
              record ? { id: changed.latestMoveIn ?? 'move-in-1', scheduledAt: new Date('2025-06-12') } : moveOut,
            ),
        },
      },
      changed,
    );
    const service = new ComparisonService(prisma as never);
    const generate = jest.spyOn(service, 'generate').mockResolvedValue(null);
    // The reads withStaleness added, typed for the assertions.
    return { service, generate, prisma: prisma as unknown as Record<string, Record<string, jest.Mock>> };
  }

  it('leaves alone a comparison nothing under has moved', async () => {
    const { service, generate } = reading(drawn());

    await service.current(user.organizationId, 'move-out-1');

    expect(generate).not.toHaveBeenCalled();
  });

  it('redraws one made under the old rules, Requires review rooms and all', async () => {
    const { service, generate } = reading(drawn({ moveInInspectionId: 'move-in-1' }));

    await service.current(user.organizationId, 'move-out-1');

    expect(generate).toHaveBeenCalledWith('move-out-1');
  });

  it('redraws one when a finding was confirmed, rejected or added after it was drawn', async () => {
    const { service, generate } = reading(drawn(), { findingChanged: true });

    await service.current(user.organizationId, 'move-out-1');

    expect(generate).toHaveBeenCalledWith('move-out-1');
  });

  it('says what moved, each of the ways it can', async () => {
    const cases = [
      [{ checklistChanged: true }, 'CHECKLIST_CHANGED'],
      [{ roomAdded: true }, 'ROOMS_CHANGED'],
      [{ latestMoveIn: 'move-in-2' }, 'NEWER_MOVE_IN'],
      [{ findingChanged: true }, 'FINDINGS_CHANGED'],
      [{ photoAdded: true }, 'EVIDENCE_ADDED'],
      [{ recordingAdded: true }, 'EVIDENCE_ADDED'],
    ] as const;
    for (const [changed, reason] of cases) {
      const { service } = reading(drawn(), changed);
      await expect(service.staleness(drawn())).resolves.toEqual([reason]);
    }
    await expect(reading(drawn()).service.staleness(drawn({}))).resolves.toEqual(['RULES_CHANGED']);
  });

  it('asks about findings and evidence since it was drawn, on the inspections it compares', async () => {
    const { service, prisma } = reading(drawn());

    await service.staleness(drawn());

    const since = { gt: new Date('2026-10-06T15:00:00Z') };
    expect(prisma.inspectionFinding.findFirst.mock.calls[0][0].where).toEqual({
      inspectionId: { in: ['move-out-1', 'move-in-1'] },
      updatedAt: since,
    });
    expect(prisma.inspectionPhoto.findFirst.mock.calls[0][0].where).toEqual({
      inspectionArea: { inspectionId: 'move-out-1' },
      createdAt: since,
    });
    expect(prisma.inspectionMedia.findFirst.mock.calls[0][0].where).toEqual({
      inspectionId: 'move-out-1',
      createdAt: since,
    });
  });

  it('draws the first one once the move-out is submitted, and not before', async () => {
    const submitted = reading(null, {}, { inspectionType: 'MOVE_OUT', status: 'TECHNICIAN_SUBMITTED' });
    await submitted.service.current(user.organizationId, 'move-out-1');
    expect(submitted.generate).toHaveBeenCalledWith('move-out-1');

    for (const moveOut of [
      { inspectionType: 'MOVE_OUT', status: 'IN_PROGRESS' },
      { inspectionType: 'MOVE_IN', status: 'COMPLETED' },
      null,
    ]) {
      const early = reading(null, {}, moveOut);
      await early.service.current(user.organizationId, 'move-out-1');
      expect(early.generate).not.toHaveBeenCalled();
    }
  });

  it('scopes the move-out to the caller’s organization', async () => {
    const { service, prisma } = reading(null);

    await service.current(user.organizationId, 'move-out-1');

    expect(prisma.inspectionComparison.findFirst.mock.calls[0][0].where).toEqual({
      moveOutInspectionId: 'move-out-1',
      organizationId: user.organizationId,
    });
    expect(prisma.inspection.findFirst.mock.calls[0][0].where).toEqual({
      id: 'move-out-1',
      organizationId: user.organizationId,
    });
  });

  it('asks quietly about a move-out with no move-in on record, which it does on every read', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, generate } = reading(null, {}, { inspectionType: 'MOVE_OUT', status: 'COMPLETED' });
    generate.mockRejectedValue(
      new ApplicationError(409, 'MOVE_IN_BASELINE_NOT_FOUND', 'No matching move-in baseline inspection was found.'),
    );

    await service.current(user.organizationId, 'move-out-1');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves the comparison as it is when it cannot be redrawn, and the read still answers', async () => {
    const { service, generate } = reading(drawn(), { findingChanged: true });
    generate.mockRejectedValue(new Error('No matching move-in baseline inspection was found.'));

    await expect(service.current(user.organizationId, 'move-out-1')).resolves.toBeUndefined();
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

/**
 * The room of the move-in that the AI analysis of a move-out recording reads.
 *
 * It has to be the comparison's own pairing. The analysis used to read the
 * creation-time link instead, and on 5819 Flower Gate Dr (2026-10-01) that link
 * was empty: every finding said there was no baseline while this comparison was
 * reading the June 2025 move-in.
 */
describe('the move-in room an AI analysis reads', () => {
  const moveIn = { id: 'move-in-1', scheduledAt: new Date('2025-06-12T00:00:00.000Z') };

  function prismaFor(opts: {
    moveOut?: Record<string, unknown> | null;
    moveIn?: typeof moveIn | null;
    moveOutAreas?: ReturnType<typeof area>[];
    moveInAreas?: ReturnType<typeof area>[];
  }) {
    return {
      inspection: {
        findUnique: jest.fn().mockResolvedValue(opts.moveOut === undefined ? moveOut : opts.moveOut),
        findFirst: jest.fn().mockResolvedValue(opts.moveIn === undefined ? moveIn : opts.moveIn),
      },
      inspectionArea: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(opts.moveOutAreas ?? [])
          .mockResolvedValueOnce(opts.moveInAreas ?? []),
      },
    };
  }

  it('is the latest move-in and the room the comparison pairs', async () => {
    const prisma = prismaFor({
      moveOutAreas: [area('pa-entrance', 'Entrance'), area('pa-kitchen', 'Kitchen')],
      moveInAreas: [area('pa-kitchen', 'Kitchen'), area('pa-entrance', 'Entrance')],
    });
    const service = new ComparisonService(prisma as never);

    await expect(service.baselineAreaFor('move-out-1', 'pa-entrance')).resolves.toEqual({
      inspectionId: 'move-in-1',
      scheduledAt: moveIn.scheduledAt,
      area: { propertyAreaId: 'pa-entrance', name: 'Entrance' },
    });
  });

  it('pairs in the move-out order, so a room an earlier one took is not offered twice', async () => {
    // Two move-out bedrooms, one move-in bedroom matched by name: the first
    // takes it, exactly as `generate` would, and the second has no baseline.
    const prisma = prismaFor({
      moveOutAreas: [area('pa-bed-a', 'Bedroom'), area('pa-bed-b', 'Bedroom')],
      moveInAreas: [area('pa-bed-old', 'Bedroom')],
    });
    const service = new ComparisonService(prisma as never);

    await expect(service.baselineAreaFor('move-out-1', 'pa-bed-b')).resolves.toMatchObject({
      inspectionId: 'move-in-1',
      area: null,
    });
  });

  it('is nothing when there is no move-in to compare against', async () => {
    const service = new ComparisonService(prismaFor({ moveIn: null }) as never);
    await expect(service.baselineAreaFor('move-out-1', 'pa-entrance')).resolves.toBeNull();
  });

  it('is nothing for an inspection that is not a move-out', async () => {
    const prisma = prismaFor({ moveOut: { ...moveOut, inspectionType: 'OCCUPIED' } });
    const service = new ComparisonService(prisma as never);
    await expect(service.baselineAreaFor('move-out-1', 'pa-entrance')).resolves.toBeNull();
    expect(prisma.inspection.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * Item by item (2026-10-03): where both inspections graded the same checklist
 * items, the verdict comes from the items, and the console shows each move-out
 * finding beside the item it is about.
 */
describe('comparing a room item by item', () => {
  const graded = (
    propertyAreaId: string,
    id: string,
    label: string,
    undamaged: boolean,
    keywords: string[] = [],
  ) => ({
    isClean: true,
    isUndamaged: undamaged,
    isWorking: true,
    comment: null,
    checklistItem: { id, label, keywords, responseType: 'STATUS' },
    inspectionArea: { propertyAreaId },
  });

  it('calls only the item that changed new, and keeps the items for the console', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-entrance', 'Entrance')],
      moveInAreas: [area('pa-entrance', 'Entrance')],
      moveOutMedia: [mediaRow('pa-entrance', 1)],
      moveOutFindings: [],
      moveInFindings: [],
      moveOutResponses: [
        graded('pa-entrance', 'floor', 'Floor and coverings', false),
        graded('pa-entrance', 'windows', 'Windows and locks', false),
      ] as never,
      moveInResponses: [
        graded('pa-entrance', 'floor', 'Floor and coverings', false),
        graded('pa-entrance', 'windows', 'Windows and locks', true),
      ] as never,
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(areaCreateMany.data[0]).toMatchObject({
      classification: 'NEW_DAMAGE',
      summary:
        'New since move-in: Windows and locks. Already damaged at move-in: Floor and coverings.',
      metadata: {
        items: [
          expect.objectContaining({ label: 'Floor and coverings', change: 'ALREADY_DAMAGED' }),
          expect.objectContaining({ label: 'Windows and locks', change: 'NEW_DAMAGE' }),
        ],
        aiNote: null,
      },
    });
  });

  it('never weighs a finding the office rejected, and reads the checklist in its own order', async () => {
    const { prisma } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-entrance', 'Entrance')],
      moveInAreas: [area('pa-entrance', 'Entrance')],
      moveOutMedia: [mediaRow('pa-entrance', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const service = new ComparisonService(prisma as never);

    await service.generate('move-out-1');

    expect(prisma.inspectionFinding.findMany.mock.calls[0][0].where).toMatchObject({
      reviewStatus: { not: 'REJECTED' },
    });
    expect(prisma.inspectionAreaChecklistResponse.findMany.mock.calls[0][0].orderBy).toEqual([
      { checklistItem: { sortOrder: 'asc' } },
      { checklistItem: { label: 'asc' } },
    ]);
  });

  it('shows each finding beside its item, links the room, and keeps the AI note off the summary', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'finding-floor',
        propertyAreaId: 'pa-entrance',
        title: 'Cracked floor tiles at the door',
        category: 'Floor',
        severity: 'MEDIUM',
        findingType: 'POSSIBLE_NEW_DAMAGE',
        reviewStatus: 'PENDING_REVIEW',
        source: 'NARRATION',
      },
      {
        id: 'finding-other',
        propertyAreaId: 'pa-entrance',
        title: 'Smoke alarm missing',
        category: 'Safety',
        severity: 'HIGH',
        findingType: 'MAINTENANCE',
        reviewStatus: 'APPROVED',
        source: 'AI_VISION',
      },
    ]);
    const prisma = {
      inspectionComparison: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'comparison-1',
          moveOutInspectionId: 'move-out-1',
          moveInInspectionId: 'move-in-1',
          overallCondition: 'UNCHANGED',
          version: 2,
          generator: 'DETERMINISTIC',
          summary: '',
          // Drawn under today's rules: reading it redraws nothing.
          metadata: { rules: COMPARISON_RULES },
          generatedAt: new Date(),
          areaComparisons: [
            {
              id: 'area-comparison-1',
              areaName: 'Entrance',
              floorName: null,
              classification: 'UNCHANGED',
              matchMethod: 'LOCAL_AREA_ID',
              matchConfidence: 1,
              summary: 'Already damaged at move-in: Floor and coverings.',
              moveOutPropertyAreaId: 'pa-entrance',
              metadata: {
                items: [
                  {
                    itemId: 'floor',
                    label: 'Floor and coverings',
                    keywords: ['floor'],
                    moveIn: { clean: true, undamaged: false, working: true, comment: null },
                    moveOut: { clean: true, undamaged: false, working: true, comment: null },
                    change: 'ALREADY_DAMAGED',
                    cleaning: null,
                  },
                ],
                aiNote: '1 AI finding of new damage here is waiting to be confirmed from the recording; it joins the report once confirmed.',
              },
            },
          ],
        }),
      },
      inspectionArea: {
        findMany: jest.fn().mockResolvedValue([{ id: 'inspection-area-entrance', propertyAreaId: 'pa-entrance' }]),
      },
      inspectionFinding: { findMany },
      inspectionMedia: { count: jest.fn().mockResolvedValue(1) },
    };
    const service = new ComparisonService(withStaleness(prisma) as never);

    const result = await service.get(user, 'move-out-1');

    expect(result?.areas[0]).toMatchObject({
      moveOutAreaId: 'inspection-area-entrance',
      aiNote: '1 AI finding of new damage here is waiting to be confirmed from the recording; it joins the report once confirmed.',
      items: [
        {
          label: 'Floor and coverings',
          change: 'ALREADY_DAMAGED',
          findings: [{ id: 'finding-floor', title: 'Cracked floor tiles at the door' }],
        },
      ],
      otherFindings: [{ id: 'finding-other', source: 'AI_VISION' }],
    });
    // Read now, never the rejected ones, and only this move-out's.
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      inspectionId: 'move-out-1',
      reviewStatus: { not: 'REJECTED' },
    });
    expect(result?.areas[0]).not.toHaveProperty('items.0.keywords');
  });
});


describe('which move-in counts as a baseline', () => {
  it('compares against a move-in submitted but not yet through the AI', () => {
    // Submitted is done (2026-10-05): the checklist is complete at submission.
    const where = baselineWhere(moveOutRecord());
    expect(where.status.in).toEqual(
      expect.arrayContaining(['TECHNICIAN_SUBMITTED', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED']),
    );
    expect(where.status.in).not.toContain('IN_PROGRESS');
    expect(where.status.in).not.toContain('SCHEDULED');
  });
});

/**
 * The rooms in the office's order, and the AI pairing what the names cannot
 * (the maintenance team, 2026-10-08).
 */
describe('pairing and ordering the rooms', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** An AI that answers `answer`, counted. */
  function ai(answer: unknown) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const settings = {
      resolve: jest.fn().mockResolvedValue({ provider: 'OPENAI', modelId: 'model-x', apiKey: 'test-key' }),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    return { fetchMock, settings };
  }

  /** The comparison read before a draw, for the AI's kept pairs. */
  function previousComparison(prisma: { inspectionComparison: unknown }, metadata: unknown) {
    (prisma.inspectionComparison as Record<string, unknown>).findUnique = jest
      .fn()
      .mockResolvedValue(metadata === undefined ? null : { metadata });
  }

  it('pairs "Gameroom" with "Game Room" by name, without asking the AI', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-game-out', 'Gameroom', 'INDOOR_ROOM', '2')],
      moveInAreas: [area('pa-game-in', 'Game Room', 'INDOOR_ROOM', '2'), area('pa-den', 'Den', 'INDOOR_ROOM', '2')],
      moveOutMedia: [mediaRow('pa-game-out', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    const { fetchMock, settings } = ai([]);
    previousComparison(prisma, undefined);

    await new ComparisonService(prisma as never, settings as never).generate('move-out-1');

    expect(areaCreateMany.data.find((row) => row.moveOutPropertyAreaId === 'pa-game-out')).toMatchObject({
      matchMethod: 'NORMALIZED_NAME',
      moveInPropertyAreaId: 'pa-game-in',
    });
    // Nothing left on the move-out side, so nothing to ask.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pairs what the names cannot through the AI, marked as its suggestion and kept', async () => {
    const { prisma, areaCreateMany, created } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [
        area('pa-office-out', 'Office. Front Of The Home.', 'INDOOR_ROOM', '1'),
        area('pa-bed-out', 'Bedroom 3 (Right-Right)', 'BEDROOM', '2'),
      ],
      moveInAreas: [
        area('pa-office-in', 'Office Front', 'INDOOR_ROOM', '1'),
        area('pa-bed-in', 'Bedroom 2', 'BEDROOM', '2'),
        area('pa-study', 'Study', 'INDOOR_ROOM', '1'),
      ],
      moveOutMedia: [mediaRow('pa-office-out', 1), mediaRow('pa-bed-out', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    // The office pair is sure; the bedrooms carry different numbers, and are refused.
    const { fetchMock, settings } = ai([
      { moveOut: 'o1', moveIn: 'i1', confidence: 0.95 },
      { moveOut: 'o2', moveIn: 'i2', confidence: 0.9 },
    ]);
    previousComparison(prisma, undefined);

    await new ComparisonService(prisma as never, settings as never).generate('move-out-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(areaCreateMany.data.find((row) => row.moveOutPropertyAreaId === 'pa-office-out')).toMatchObject({
      matchMethod: 'AI_SUGGESTED',
      moveInPropertyAreaId: 'pa-office-in',
      matchConfidence: 0.75,
    });
    expect(areaCreateMany.data.find((row) => row.moveOutPropertyAreaId === 'pa-bed-out')).toMatchObject({
      matchMethod: 'UNMATCHED',
    });
    expect((created.data?.metadata as { aiPairing?: { pairs: unknown[] } }).aiPairing?.pairs).toEqual([
      { moveOut: 'pa-office-out', moveIn: 'pa-office-in', confidence: 0.75 },
    ]);
    expect(settings.recordUsage).toHaveBeenCalledWith(
      moveOut.organizationId,
      expect.anything(),
      'AREA_PAIRING',
      expect.anything(),
      'move-out-1',
    );
  });

  it('does not ask again for the same leftovers', async () => {
    const setup = () =>
      generatePrisma({
        moveOut,
        moveIn: { id: 'move-in-1' },
        moveOutAreas: [area('pa-office-out', 'Office. Front Of The Home.')],
        moveInAreas: [area('pa-office-in', 'Office Front'), area('pa-study', 'Study')],
        moveOutMedia: [mediaRow('pa-office-out', 1)],
        moveOutFindings: [],
        moveInFindings: [],
      });
    const first = setup();
    const { fetchMock, settings } = ai([{ moveOut: 'o1', moveIn: 'i1', confidence: 0.9 }]);
    previousComparison(first.prisma, undefined);
    await new ComparisonService(first.prisma as never, settings as never).generate('move-out-1');
    const kept = first.created.data?.metadata;

    const second = setup();
    previousComparison(second.prisma, kept);
    await new ComparisonService(second.prisma as never, settings as never).generate('move-out-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.areaCreateMany.data[0]).toMatchObject({
      matchMethod: 'AI_SUGGESTED',
      moveInPropertyAreaId: 'pa-office-in',
    });
  });

  it('lists the rooms in the office’s order, the entrance first, a move-in-only room in its place', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-bed', 'Bedroom 1'), area('pa-garage', 'Garage', 'GARAGE'), area('pa-entry', 'Entrance')],
      moveInAreas: [
        area('pa-bed', 'Bedroom 1'),
        area('pa-garage', 'Garage', 'GARAGE'),
        area('pa-entry', 'Entrance'),
        area('pa-kitchen', 'Kitchen', 'KITCHEN'),
      ],
      moveOutMedia: [mediaRow('pa-bed', 1), mediaRow('pa-garage', 1), mediaRow('pa-entry', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });

    await new ComparisonService(prisma as never).generate('move-out-1');

    expect(areaCreateMany.data.map((row) => [row.areaName, row.position])).toEqual([
      ['Entrance', 0],
      ['Kitchen', 1],
      ['Bedroom 1', 2],
      ['Garage', 3],
    ]);
  });

  it('carries on by the rules alone when the AI cannot be reached', async () => {
    const { prisma, areaCreateMany } = generatePrisma({
      moveOut,
      moveIn: { id: 'move-in-1' },
      moveOutAreas: [area('pa-office-out', 'Office. Front Of The Home.')],
      moveInAreas: [area('pa-office-in', 'Office Front'), area('pa-study', 'Study')],
      moveOutMedia: [mediaRow('pa-office-out', 1)],
      moveOutFindings: [],
      moveInFindings: [],
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;
    const settings = {
      resolve: jest.fn().mockResolvedValue({ provider: 'OPENAI', modelId: 'model-x', apiKey: 'test-key' }),
      recordUsage: jest.fn(),
    };
    previousComparison(prisma, undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await new ComparisonService(prisma as never, settings as never).generate('move-out-1');

    expect(areaCreateMany.data[0]).toMatchObject({ matchMethod: 'UNMATCHED' });
  });
});
