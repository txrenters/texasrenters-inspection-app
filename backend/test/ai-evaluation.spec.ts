import { scoreRecording, sumScores, type KeyFinding } from '../src/admin/ai-evaluation';
import { AiEvaluationService } from '../src/admin/ai-evaluation.service';

/**
 * The AI measured against the office's own decisions before a change ships
 * (2026-10-03): found, missed, false alarms repeated, and whether the moment it
 * cites is the one a reviewer confirmed.
 */

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const USER = {
  id: '20000000-0000-4000-8000-000000000002',
  organizationId: ORGANIZATION_ID,
  permissions: ['ai:configure'],
} as never;

const kept = (id: string, title: string, fields: Partial<KeyFinding> = {}): KeyFinding => ({
  id,
  titles: [title],
  category: 'Doors',
  startSeconds: null,
  decision: 'KEPT',
  reasonCode: null,
  confirmedMs: null,
  ...fields,
});
const rejected = (id: string, title: string, reasonCode = 'NORMAL_WEAR'): KeyFinding =>
  kept(id, title, { decision: 'REJECTED', reasonCode, category: 'Walls' });
const draft = (title: string, start = 0, end = 0, category = 'Doors') => ({
  title,
  category,
  videoTimestampStart: start,
  videoTimestampEnd: end,
});

describe('scoring one recording', () => {
  it('counts what it still finds, what it misses, false alarms it repeats, and what is new', () => {
    const score = scoreRecording(
      [
        kept('door', 'Holes in the entrance door below the handle'),
        kept('floor', 'Entrance floor tiles cracked', { category: 'Floor' }),
        rejected('nail', 'Small nail holes in the wall'),
        rejected('scuff', 'Scuffed paint beside the door'),
      ],
      [
        draft('Entrance door has holes below the handle'),
        draft('Nail holes in wall', 0, 0, 'Walls'),
        draft('Loose door stop behind the door', 0, 0, 'Hardware'),
      ],
    );

    expect(score).toMatchObject({
      kept: 2,
      found: 1,
      missed: [{ id: 'floor', title: 'Entrance floor tiles cracked' }],
      rejected: 2,
      repeated: [{ id: 'nail', title: 'Small nail holes in the wall', reasonCode: 'NORMAL_WEAR' }],
      added: [{ title: 'Loose door stop behind the door' }],
    });
  });

  it('knows a corrected finding by the AI’s own wording too', () => {
    const score = scoreRecording(
      [kept('wall', 'Scuffed paint near the door', { titles: ['Scuffed paint near the door', 'Damaged wall near the door'] })],
      [draft('Damaged wall near the door')],
    );
    expect(score.found).toBe(1);
  });

  it('times a finding against the frame a reviewer filed as its photograph, within five seconds', () => {
    const score = scoreRecording(
      [
        kept('a', 'Holes in the entrance door', { confirmedMs: 21_500 }),
        kept('b', 'Cracked window pane', { confirmedMs: 95_000, category: 'Windows' }),
        kept('c', 'Broken light switch cover', { confirmedMs: 40_000, category: 'Electrical' }),
        // No confirmed frame: found, but not timed.
        kept('d', 'Torn carpet in the doorway', { category: 'Floor' }),
      ],
      [
        draft('Entrance door has holes', 18, 24),
        draft('Window pane cracked', 60, 66, 'Windows'),
        // Cites no moment at all: never on time, however close 0:00 is.
        draft('Light switch cover broken', 0, 0, 'Electrical'),
        draft('Carpet torn at the doorway', 70, 72, 'Floor'),
      ],
    );

    expect(score).toMatchObject({ kept: 4, found: 4, timed: 3, onTime: 1 });
  });

  it('pairs a weak title match only when the moment or category backs it', () => {
    const key = [kept('a', 'Door frame chipped', { startSeconds: 30 })];
    // One word in common: the same moment is what makes it the same finding.
    expect(scoreRecording(key, [draft('Frame damage by the entry', 32, 34, 'Trim')]).found).toBe(1);
    expect(scoreRecording(key, [draft('Frame damage by the entry', 200, 204, 'Trim')]).found).toBe(0);
    // Nothing in common: no moment or category makes it a match.
    expect(scoreRecording(key, [draft('Smoke alarm missing', 30, 32, 'Doors')]).found).toBe(0);
  });

  it('sums recordings, counting the ones that failed apart', () => {
    const one = scoreRecording([kept('a', 'Door holes')], [draft('Door holes')]);
    expect(sumScores([one, null, one])).toMatchObject({
      recordings: 3,
      failed: 1,
      kept: 2,
      found: 2,
    });
  });
});

function harness(opts: { running?: boolean; testSet?: unknown[]; current?: { version: number; text: string } | null } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const media = opts.testSet ?? [
    {
      id: 'media-entrance',
      createdAt: new Date('2026-10-01T15:00:00.000Z'),
      inspectionId: 'insp-1',
      inspectionArea: {
        propertyArea: { name: 'Entrance' },
        inspection: { inspectionType: 'MOVE_OUT', propertywareBuilding: { name: '100 Example Ln' } },
      },
    },
    {
      id: 'media-kitchen',
      createdAt: new Date('2026-10-01T15:20:00.000Z'),
      inspectionId: 'insp-1',
      inspectionArea: {
        propertyArea: { name: 'Kitchen' },
        inspection: { inspectionType: 'MOVE_OUT', propertywareBuilding: { name: '100 Example Ln' } },
      },
    },
  ];
  const tx = {
    aiEvaluationRun: { create: jest.fn().mockResolvedValue({ id: 'run-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    aiEvaluationRun: {
      findFirst: jest.fn(async (args: { where: { status?: string } }) =>
        args.where.status
          ? opts.running
            ? { id: 'run-0' }
            : null
          : {
              id: 'run-1',
              status: 'RUNNING',
              error: null,
              guidanceVersion: null,
              houseRules: 'Scuffs are normal wear.',
              promptVersion: '5',
              modelId: null,
              recordingCount: 2,
              completedCount: 0,
              totals: null,
              tokens: 0,
              startedAt: new Date(),
              completedAt: null,
              startedById: USER_ID,
              results: [],
            },
      ),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      }),
    },
    inspectionMedia: { findMany: jest.fn().mockResolvedValue(media) },
    inspectionFinding: {
      findMany: jest.fn(async (args: { where: { inspectionMediaId: string } }) =>
        args.where.inspectionMediaId === 'media-entrance'
          ? [
              {
                id: 'f-door',
                title: 'Holes in the entrance door',
                category: 'Doors',
                reviewStatus: 'APPROVED',
                videoTimestampStart: 18,
                reviews: [{ status: 'APPROVED', reasonCode: null, editedValue: null }],
                photos: [{ metadata: { videoTimestampMs: 21_000, captureSource: 'VIDEO_FRAME_EXTRACTION' } }],
              },
              {
                id: 'f-scuff',
                title: 'Scuffed paint beside the door',
                category: 'Walls',
                reviewStatus: 'REJECTED',
                videoTimestampStart: 30,
                reviews: [{ status: 'REJECTED', reasonCode: 'NORMAL_WEAR', editedValue: null }],
                photos: [],
              },
            ]
          : [],
      ),
    },
    userProfile: { findMany: jest.fn().mockResolvedValue([{ id: USER_ID, displayName: 'Ana' }]) },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const guidance = { current: jest.fn().mockResolvedValue(opts.current ?? null) };
  const mediaProcessing = {
    previewAnalysis: jest.fn(async (mediaId: string) => {
      if (mediaId === 'media-kitchen') throw new Error('This recording has no stored narration yet.');
      return {
        items: [
          {
            title: 'Room condition summary',
            findingType: 'NO_CHANGE',
            category: 'Room condition',
            videoTimestampStart: 0,
            videoTimestampEnd: 0,
          },
          {
            title: 'Entrance door has holes',
            findingType: 'POSSIBLE_NEW_DAMAGE',
            category: 'Doors',
            videoTimestampStart: 18,
            videoTimestampEnd: 24,
          },
        ],
        usage: { inputTokens: 3000, outputTokens: 500, totalTokens: 3500 },
        modelId: 'gpt-5.6-sol',
      };
    }),
  };
  const service = new AiEvaluationService(prisma as never, guidance as never, mediaProcessing as never);
  const finished = async () => {
    for (let tick = 0; tick < 200; tick += 1) {
      if (updates.some((data) => data.status === 'COMPLETED' || data.status === 'FAILED')) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('The run never finished.');
  };
  return { service, prisma, tx, mediaProcessing, updates, finished };
}

const USER_ID = '20000000-0000-4000-8000-000000000002';

describe('a test run', () => {
  it('scores each recording against its decisions, keeps going past a failure, and totals the run', async () => {
    const { service, tx, mediaProcessing, updates, finished } = harness();

    const started = await service.start(USER, { houseRules: '  Scuffs are normal wear.  ' });
    await finished();

    expect(started).toMatchObject({ id: 'run-1', status: 'RUNNING', startedByName: 'Ana' });
    expect(tx.aiEvaluationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        houseRules: 'Scuffs are normal wear.',
        guidanceVersion: null,
        promptVersion: '7',
        recordingCount: 2,
      }),
      select: { id: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AI_EVALUATION_STARTED',
        metadata: { recordingCount: 2, guidanceVersion: null, draft: true },
      }),
    });
    // Billed as a test run, recording by recording, never stored as findings.
    expect(mediaProcessing.previewAnalysis).toHaveBeenCalledWith(
      'media-entrance',
      ORGANIZATION_ID,
      'Scuffs are normal wear.',
      'AI_EVALUATION',
    );
    // Progress after each recording, then the totals.
    expect(updates[0]).toMatchObject({ completedCount: 1, tokens: 3500, modelId: 'gpt-5.6-sol' });
    expect(updates[1]).toMatchObject({ completedCount: 2 });
    const results = updates[1].results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({
      roomName: 'Entrance',
      score: { kept: 1, found: 1, rejected: 1, repeated: [], timed: 1, onTime: 1, added: [] },
    });
    expect(results[1]).toMatchObject({ roomName: 'Kitchen', score: null, error: expect.stringContaining('no stored narration') });
    expect(updates.at(-1)).toMatchObject({
      status: 'COMPLETED',
      totals: { recordings: 2, failed: 1, kept: 1, found: 1, rejected: 1, repeated: 0, onTime: 1 },
    });
  });

  // The AI files its best frame of a finding itself (2026-10-06). That frame is
  // its own guess, not the office confirming where the finding is.
  it('times a finding by the frame a person filed, never by the one the AI filed', async () => {
    const aiFrame = {
      metadata: { videoTimestampMs: 90_000, captureSource: 'VIDEO_FRAME_EXTRACTION', filedBy: 'AI' },
    };
    const personFrame = { metadata: { videoTimestampMs: 21_000, captureSource: 'VIDEO_FRAME_EXTRACTION' } };
    const door = {
      id: 'f-door',
      title: 'Holes in the entrance door',
      category: 'Doors',
      reviewStatus: 'APPROVED',
      videoTimestampStart: 18,
      reviews: [{ status: 'APPROVED', reasonCode: null, editedValue: null }],
    };
    const scoreWith = async (photos: unknown[]) => {
      const { service, prisma, updates, finished } = harness();
      prisma.inspectionFinding.findMany.mockImplementationOnce((async () => [{ ...door, photos }]) as never);
      await service.start(USER, { houseRules: '' });
      await finished();
      return (updates[0].results as Array<{ score: { timed: number; onTime: number } | null }>)[0].score;
    };

    // The AI's frame first, the reviewer's after: the reviewer's is the moment.
    await expect(scoreWith([aiFrame, personFrame])).resolves.toMatchObject({ timed: 1, onTime: 1 });
    // Only the AI's: no confirmed moment at all.
    await expect(scoreWith([aiFrame])).resolves.toMatchObject({ timed: 0, onTime: 0 });
  });

  it('records the saved version when the rules tried are the ones in use', async () => {
    const { service, tx, finished } = harness({ current: { version: 4, text: 'Scuffs are normal wear.' } });

    await service.start(USER, { houseRules: 'Scuffs are normal wear.' });
    await finished();

    expect(tx.aiEvaluationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ guidanceVersion: 4 }),
      select: { id: true },
    });
  });

  it('runs one at a time', async () => {
    const { service, tx } = harness({ running: true });

    await expect(service.start(USER, { houseRules: '' })).rejects.toMatchObject({
      code: 'AI_EVALUATION_RUNNING',
    });
    expect(tx.aiEvaluationRun.create).not.toHaveBeenCalled();
  });

  it('needs recordings the office has decided', async () => {
    const { service, prisma } = harness({ testSet: [] });

    await expect(service.start(USER, { houseRules: '' })).rejects.toMatchObject({ code: 'NO_TEST_SET' });
    expect(prisma.inspectionMedia.findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: ORGANIZATION_ID },
      take: 10,
    });
  });

  it('takes at most twenty recordings, however many are asked for', async () => {
    const { service, prisma, finished } = harness();

    await service.start(USER, { houseRules: '', size: 500 });
    await finished();

    expect(prisma.inspectionMedia.findMany.mock.calls[0][0].take).toBe(20);
  });

  it('reports a run a restart cut off as failed, not running for ever', async () => {
    const { service, prisma } = harness();
    prisma.aiEvaluationRun.findMany.mockResolvedValue([
      {
        id: 'run-old',
        status: 'RUNNING',
        error: null,
        guidanceVersion: 2,
        houseRules: 'Rules.',
        promptVersion: '5',
        modelId: 'gpt-5.6-sol',
        recordingCount: 10,
        completedCount: 4,
        totals: null,
        tokens: 14_000,
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        completedAt: null,
        startedById: null,
      },
    ]);

    const [run] = await service.list(ORGANIZATION_ID);

    expect(run).toMatchObject({
      status: 'FAILED',
      error: 'The run was interrupted before it finished.',
      houseRulesLength: 6,
      startedByName: null,
    });
    expect(run).not.toHaveProperty('houseRules');
  });

  it('is found only in its own organization', async () => {
    const { service, prisma } = harness();
    prisma.aiEvaluationRun.findFirst.mockResolvedValue(null as never);

    await expect(service.get(ORGANIZATION_ID, 'run-x')).rejects.toMatchObject({
      code: 'AI_EVALUATION_NOT_FOUND',
    });
  });
});
