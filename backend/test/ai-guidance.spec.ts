import { Prisma } from '@prisma/client';

import { AiGuidanceService, lessonLines, roomKind } from '../src/admin/ai-guidance.service';

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const USER = {
  id: '20000000-0000-4000-8000-000000000002',
  organizationId: ORGANIZATION_ID,
  permissions: ['ai:configure'],
} as never;

/**
 * The office teaching the AI (2026-10-03): its house rules, kept in versions,
 * its recent decisions shown to the analysis as lessons, and a scorecard read
 * from the decisions people already made.
 */

type Row = Parameters<typeof lessonLines>[0][number];
const rejected = (title: string, roomName: string, reasonCode: Row['reasonCode'], reason: string | null = null): Row => ({
  status: 'REJECTED',
  reason,
  reasonCode,
  editedValue: null,
  finding: { title, roomName },
});

describe('the lessons the analysis is shown', () => {
  it('treats a numbered room as the same kind of room', () => {
    expect(roomKind('Bedroom 2')).toBe('bedroom');
    expect(roomKind('Half-bath')).toBe(roomKind('half bath'));
  });

  it('puts decisions on the same kind of room first, each with its reason', () => {
    const lines = lessonLines(
      [
        rejected('Stained carpet', 'Living Room', 'NOT_A_PROBLEM'),
        rejected('Small nail holes in wall', 'Bedroom 1', 'NORMAL_WEAR', 'Picture hooks.'),
      ],
      'Bedroom 2',
    );

    expect(lines).toEqual([
      '- Rejected as normal wear and tear: "Small nail holes in wall" (Bedroom 1). Office note: Picture hooks.',
      '- Rejected as not a problem: "Stained carpet" (Living Room).',
    ]);
  });

  it('says when no reason was chosen, as for every rejection before reasons were asked', () => {
    expect(lessonLines([rejected('Loose towel bar', 'Bathroom', null, 'Fine')], 'Bathroom')).toEqual([
      '- Rejected as no reason chosen: "Loose towel bar" (Bathroom). Office note: Fine',
    ]);
  });

  it('shows a correction as what the AI wrote and what the office kept', () => {
    const lines = lessonLines(
      [
        {
          status: 'EDITED',
          reason: null,
          reasonCode: null,
          editedValue: {
            before: { title: 'Damaged wall', severity: 'HIGH', findingType: 'POSSIBLE_NEW_DAMAGE' },
            after: { title: 'Scuffed paint', severity: 'LOW', findingType: 'MAINTENANCE' },
          },
          finding: { title: 'Scuffed paint', roomName: 'Hallway' },
        },
      ],
      'Hallway',
    );

    expect(lines).toEqual([
      '- Corrected: "Damaged wall" (HIGH, POSSIBLE_NEW_DAMAGE) became "Scuffed paint" (LOW, MAINTENANCE) (Hallway).',
    ]);
  });

  it('says each lesson once, and only a handful of them', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      rejected(`Finding ${index}`, 'Kitchen', 'DUPLICATE'),
    );
    const lines = lessonLines([...many, rejected('Finding 0', 'Kitchen', 'DUPLICATE')], 'Kitchen');

    expect(lines).toHaveLength(6);
    expect(new Set(lines).size).toBe(6);
  });
});

function prismaFor(overrides: Record<string, unknown> = {}) {
  const tx = {
    aiGuidanceVersion: {
      findFirst: jest.fn().mockResolvedValue({ version: 2, text: 'Old rules.' }),
      create: jest.fn(async ({ data }: { data: { version: number; text: string } }) => ({
        version: data.version,
        text: data.text,
      })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    aiGuidanceVersion: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userProfile: { findMany: jest.fn().mockResolvedValue([]) },
    findingReview: { findMany: jest.fn().mockResolvedValue([]) },
    inspectionFinding: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    ...overrides,
  };
  return { prisma, tx, service: new AiGuidanceService(prisma as never) };
}

describe('the house rules', () => {
  it('are none until the office writes some, and none when it empties them', async () => {
    const { service, prisma } = prismaFor();
    await expect(service.current(ORGANIZATION_ID)).resolves.toBeNull();

    prisma.aiGuidanceVersion.findFirst.mockResolvedValue({
      version: 4,
      text: '   ',
      createdAt: new Date(),
    });
    await expect(service.current(ORGANIZATION_ID)).resolves.toBeNull();
  });

  it('are saved as a new version, never over the old one, and the change is audited', async () => {
    const { service, tx } = prismaFor();

    const result = await service.save(USER, '  Nail holes are normal wear.  ');

    expect(tx.aiGuidanceVersion.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORGANIZATION_ID,
        version: 3,
        text: 'Nail holes are normal wear.',
        createdById: '20000000-0000-4000-8000-000000000002',
      },
      select: { version: true, text: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AI_GUIDANCE_UPDATED',
        metadata: { version: 3, length: 27 },
      }),
    });
    expect(result.saved).toEqual({ version: 3, text: 'Nail holes are normal wear.' });
  });

  it('are not versioned again when nothing changed', async () => {
    const { service, tx } = prismaFor();

    const result = await service.save(USER, 'Old rules.');

    expect(tx.aiGuidanceVersion.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(result.saved).toEqual({ version: 2, text: 'Old rules.' });
  });

  it('are refused past the length the prompt can carry', async () => {
    const { service, prisma } = prismaFor();

    await expect(service.save(USER, 'x'.repeat(8001))).rejects.toMatchObject({
      code: 'AI_GUIDANCE_TOO_LONG',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('survive two saves at once: the second goes on top of the first', async () => {
    const { service, prisma, tx } = prismaFor();
    prisma.$transaction
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      )
      .mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));

    await expect(service.save(USER, 'New rules.')).resolves.toMatchObject({
      saved: { version: 3 },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe('the decisions the analysis learns from', () => {
  it('come from other inspections of the organization, never room summaries', async () => {
    const { service, prisma } = prismaFor();
    prisma.findingReview.findMany.mockResolvedValue([
      {
        status: 'REJECTED',
        reason: null,
        reasonCode: 'ALREADY_AT_MOVE_IN',
        editedValue: null,
        finding: { title: 'Cracked tile', propertyArea: { name: 'Kitchen' } },
      },
    ]);

    const lines = await service.lessons(ORGANIZATION_ID, 'Kitchen', 'inspection-now');

    expect(lines).toEqual(['- Rejected as already there at move-in: "Cracked tile" (Kitchen).']);
    const where = prisma.findingReview.findMany.mock.calls[0][0].where;
    expect(where.finding).toEqual({
      inspection: { organizationId: ORGANIZATION_ID },
      inspectionId: { not: 'inspection-now' },
      NOT: { findingType: 'NO_CHANGE', title: 'Room condition summary' },
    });
    expect(where.status).toEqual({ in: ['REJECTED', 'EDITED'] });
  });
});

describe('the scorecard', () => {
  const finding = (fields: Record<string, unknown>) => ({
    source: 'NARRATION',
    reviewStatus: 'APPROVED',
    visualStatus: null,
    videoTimestampStart: 0,
    videoTimestampEnd: 0,
    aiAnalysisJob: { promptVersion: '5', modelId: 'gpt-5.6-sol', guidanceVersion: 1 },
    reviews: [{ status: 'APPROVED', reasonCode: null }],
    frameSuggestions: [],
    ...fields,
  });

  it('counts kept, corrected and rejected findings, and why they were rejected', async () => {
    const { service, prisma } = prismaFor();
    prisma.inspectionFinding.findMany.mockResolvedValue([
      finding({ videoTimestampStart: 12, videoTimestampEnd: 20 }),
      finding({ reviews: [{ status: 'EDITED', reasonCode: null }] }),
      finding({
        reviewStatus: 'REJECTED',
        reviews: [{ status: 'REJECTED', reasonCode: 'NORMAL_WEAR' }],
        visualStatus: 'NOT_VISIBLE',
      }),
      finding({ reviewStatus: 'REJECTED', reviews: [{ status: 'REJECTED', reasonCode: null }] }),
      finding({
        source: 'AI_VISION',
        reviewStatus: 'PENDING_REVIEW',
        reviews: [],
        visualStatus: 'VISIBLE',
        aiAnalysisJob: { promptVersion: 'vision-2', modelId: 'gpt-5.6-sol', guidanceVersion: 1 },
        frameSuggestions: [{ status: 'ACCEPTED' }, { status: 'SUGGESTED' }],
      }),
    ]);

    const card = await service.scorecard(ORGANIZATION_ID, 30);

    expect(card.totals).toEqual({ findings: 5, pending: 1, kept: 1, corrected: 1, rejected: 2 });
    expect(card.rejectReasons).toEqual({ NORMAL_WEAR: 1, UNSPECIFIED: 1 });
    expect(card.bySource.AI_VISION).toEqual({
      findings: 1,
      pending: 1,
      kept: 0,
      corrected: 0,
      rejected: 0,
    });
    expect(card.visual).toMatchObject({ checked: 2, seen: 1, notSeen: 1, notSeenRejected: 1 });
    expect(card.photos).toEqual({ offered: 1, accepted: 1, allDismissed: 0 });
    expect(card.timing).toEqual({ narration: 4, withMoment: 1 });
    expect(card.byVersion.map((row) => [row.promptVersion, row.findings])).toEqual([
      ['5', 4],
      ['vision-2', 1],
    ]);
    expect(card.window.days).toBe(30);
  });

  it('reads only the organization’s own findings in the period, summaries left out', async () => {
    const { service, prisma } = prismaFor();

    await service.scorecard(ORGANIZATION_ID, 90);

    const where = prisma.inspectionFinding.findMany.mock.calls[0][0].where;
    expect(where.inspection).toEqual({ organizationId: ORGANIZATION_ID });
    expect(where.NOT).toEqual({ findingType: 'NO_CHANGE', title: 'Room condition summary' });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });
});
