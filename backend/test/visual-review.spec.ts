import { AiProvider } from '@prisma/client';

import {
  VisualReviewService,
  normalizeBox,
  photoMatchesFinding,
  scanTimes,
} from '../src/technician/visual-review.service';

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';

/**
 * The AI looking at the recording a finding came from. Settled by a trial on
 * the 2026-10-01 Flower Gate move-out: the scan finds the right frames, its
 * boxes are only roughly placed, and a close look at a sharp frame puts them on
 * the damage.
 */

describe('which frames the scan looks at', () => {
  it('every three seconds on a short walkthrough', () => {
    expect(scanTimes(10)).toEqual([1, 4, 7]);
  });

  it('never more than ninety, however long the recording', () => {
    const times = scanTimes(440);
    expect(times.length).toBeLessThanOrEqual(90);
    expect(times.at(-1)).toBeLessThan(440);
  });

  it('one frame for a recording too short to step through', () => {
    expect(scanTimes(1)).toEqual([0]);
  });
});

describe('a box the model gave', () => {
  it('is kept as fractions of the frame', () => {
    expect(normalizeBox([0.33, 0.43, 0.17, 0.07])).toEqual({
      x: 0.33,
      y: 0.43,
      width: 0.17,
      height: 0.07,
    });
  });

  it('is pulled inside the frame', () => {
    expect(normalizeBox([0.9, -0.2, 0.5, 0.5])).toEqual({
      x: 0.9,
      y: 0,
      width: expect.closeTo(0.1, 6),
      height: 0.5,
    });
  });

  it('is dropped when it is not a box at all', () => {
    for (const value of [null, [0.1, 0.2, 0.3], ['a', 0, 0.1, 0.1], [0.1, 0.1, 0.001, 0.2]])
      expect(normalizeBox(value)).toBeNull();
  });
});

describe('which move-in photographs are of the same item', () => {
  const doors = { label: 'Doors and locks', keywords: ['door', 'lock'] };
  const windows = { label: 'Windows and locks', keywords: ['window', 'lock'] };

  it('is the one filed under the item the finding is about', () => {
    const finding = { title: 'Door hole and trim require repair', category: 'Door' };
    expect(photoMatchesFinding(finding, doors)).toBe(true);
    expect(photoMatchesFinding(finding, windows)).toBe(false);
  });

  it('is none for a photograph filed under no item', () => {
    expect(photoMatchesFinding({ title: 'Wall holes', category: 'Walls' }, null)).toBe(false);
  });
});

const DEFAULT_BASELINE_PHOTOS = [
  {
    id: 'move-in-photo-door',
    storageKey: 'photos/door.jpg',
    checklistItem: { label: 'Doors and locks', keywords: ['door', 'lock'] },
  },
  {
    id: 'move-in-photo-window',
    storageKey: 'photos/window.jpg',
    checklistItem: { label: 'Windows and locks', keywords: ['window'] },
  },
];

function harness(
  opts: {
    media?: Record<string, unknown> | null;
    findings?: unknown[];
    scan?: unknown;
    close?: unknown;
    baselinePhotos?: unknown[];
    customerCode?: string | null;
    houseRules?: string | null;
    /** The technician's own photos of this room; none unless a test is about them. */
    roomPhotos?: unknown[];
  } = {},
) {
  const media =
    opts.media === undefined
      ? {
          id: 'media-1',
          inspectionId: 'move-out-1',
          streamUid: 'uid-1',
          readyAt: new Date(),
          durationSeconds: 12,
          inspectionAreaId: 'inspection-area-1',
          inspectionArea: {
            propertyArea: { id: 'pa-entrance', name: 'Entrance' },
            inspection: { inspectionType: 'MOVE_OUT', finalizedAt: null },
          },
        }
      : opts.media;
  const tx = {
    inspectionFinding: {
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    findingFrameSuggestion: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    inspectionMedia: { findFirst: jest.fn().mockResolvedValue(media) },
    inspectionFinding: {
      findMany: jest
        .fn()
        // This recording's narration findings, then everything decided in the room.
        .mockResolvedValueOnce(
          opts.findings ?? [
            {
              id: 'finding-door',
              title: 'Door hole and trim require repair',
              description: 'Two holes below the handle.',
              category: 'Door',
              videoTimestampStart: 18,
              videoTimestampEnd: 24,
              reviewStatus: 'PENDING_REVIEW',
              possibleResponsibility: 'TENANT_REVIEW_REQUIRED',
            },
            {
              id: 'finding-trim',
              title: 'Garage door trim repainting requested',
              description: 'Repaint the trim.',
              category: 'Trim',
              videoTimestampStart: 0,
              videoTimestampEnd: 0,
              reviewStatus: 'PENDING_REVIEW',
              possibleResponsibility: 'UNDETERMINED',
            },
          ],
        )
        .mockResolvedValueOnce([{ title: 'Window screen missing', reviewStatus: 'REJECTED' }]),
    },
    inspectionAreaChecklistResponse: {
      findMany: jest.fn().mockResolvedValue([
        {
          isClean: false,
          isUndamaged: false,
          isWorking: true,
          comment: null,
          checklistItem: { label: 'Doors and locks' },
        },
      ]),
    },
    inspectionPhoto: {
      // The room's own photos are asked for by area; the move-in's by its room.
      findMany: jest.fn(async (args: { where: { inspectionAreaId?: string } }) =>
        args.where.inspectionAreaId
          ? (opts.roomPhotos ?? [])
          : (opts.baselinePhotos ?? DEFAULT_BASELINE_PHOTOS),
      ),
    },
    aiAnalysisJob: {
      create: jest.fn().mockResolvedValue({ id: 'vision-job-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const aiSettings = {
    resolve: jest.fn().mockResolvedValue({
      provider: AiProvider.OPENAI,
      modelId: 'gpt-5.6-sol',
      apiKey: 'test-key',
    }),
    recordUsage: jest.fn().mockResolvedValue(undefined),
    visualReviewEnabled: jest.fn().mockResolvedValue(true),
  };
  const stream = {
    customerCode: opts.customerCode === undefined ? 'cust' : opts.customerCode,
    signPlaybackToken: jest.fn().mockReturnValue({ token: 'tok' }),
  };
  const storage = { get: jest.fn().mockResolvedValue(Buffer.from('move-in-photo')) };
  const comparison = {
    baselineAreaFor: jest.fn().mockResolvedValue({
      inspectionId: 'move-in-1',
      scheduledAt: new Date('2025-06-12T00:00:00.000Z'),
      area: { propertyAreaId: 'pa-entrance-move-in', name: 'Entrance' },
    }),
  };

  const scan = opts.scan ?? {
    findings: [
      { ref: 'F1', visible: 'VISIBLE', frames: ['T004', 'T007'], observation: 'Two holes below the handle.' },
      { ref: 'F2', visible: 'NOT_VISIBLE', frames: [], observation: 'The trim looks intact.' },
    ],
    additional: [
      {
        title: 'Broken drywall above the water heater',
        description: 'A palm-sized piece of drywall is broken away.',
        category: 'Walls',
        kind: 'DAMAGE',
        severity: 'MEDIUM',
        frames: ['T007'],
        observation: 'Broken drywall at the corner.',
      },
      {
        title: 'Stain on the floor',
        description: 'A dark stain.',
        category: 'Floor',
        kind: 'CLEANING',
        severity: 'LOW',
        frames: ['T010'],
        observation: 'A stain.',
      },
    ],
  };
  const close = opts.close ?? {
    items: [
      {
        ref: 'F1',
        visible: true,
        box: [0.36, 0.6, 0.1, 0.06],
        observation: 'Two small holes below the handle.',
        atMoveIn: 'PRESENT',
        moveInNote: 'The move-in photograph shows the same two holes.',
      },
      { ref: 'A1', visible: true, box: [0.33, 0.43, 0.17, 0.07], observation: 'Broken drywall.' },
      // The scan saw it; a sharp look does not. It is not added.
      { ref: 'A2', visible: false, box: null, observation: '' },
    ],
  };
  const answers = [scan, close];
  global.fetch = jest.fn(async (url: string) => {
    if (url.includes('/thumbnails/thumbnail.jpg')) {
      // Larger half a second after the scan's frame: the sharpest of three
      // neighbours, which is what the close look is shown.
      const sharp = url.includes('time=4.5s&height=1080');
      return { ok: true, arrayBuffer: async () => new Uint8Array(sharp ? 900 : 300).buffer };
    }
    const answer = answers.shift();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
        usage: { input_tokens: 10_000, output_tokens: 500, total_tokens: 10_500 },
      }),
    };
  }) as unknown as typeof fetch;

  const service = new VisualReviewService(
    prisma as never,
    aiSettings as never,
    stream as never,
    storage as never,
    comparison as never,
    (opts.houseRules
      ? { current: jest.fn().mockResolvedValue({ version: 2, text: opts.houseRules }) }
      : undefined) as never,
  );
  const calls = () =>
    (global.fetch as jest.Mock).mock.calls.filter(([url]) => url === 'https://api.openai.com/v1/responses');
  const sent = (index: number) =>
    JSON.parse(calls()[index][1].body as string).input[0].content as Array<{
      type: string;
      text?: string;
      image_url?: string;
    }>;
  return { service, prisma, tx, aiSettings, stream, comparison, sent, calls };
}

describe('looking at a recording', () => {
  it('scans frames through the walkthrough with the findings and the checklist', async () => {
    const { service, sent } = harness();

    await service.review('media-1', ORGANIZATION_ID);

    const scan = sent(0);
    const prompt = scan[0].text!;
    expect(prompt).toContain('F1: Door hole and trim require repair');
    expect(prompt).toContain('narrated around 0:18–0:24');
    expect(prompt).toContain('- Doors and locks: NOT clean, DAMAGED, working');
    // Decided already: not to be raised again.
    expect(prompt).toContain('- Window screen missing (rejected)');
    // A frame every three seconds of a twelve-second walkthrough, each named.
    expect(scan.filter((part) => part.type === 'input_image')).toHaveLength(4);
    expect(scan.map((part) => part.text)).toEqual(expect.arrayContaining(['T001 (0:01)', 'T010 (0:10)']));
  });

  it('takes a close look at the sharpest frame, with the move-in photograph of the same item', async () => {
    const { service, sent } = harness();

    await service.review('media-1', ORGANIZATION_ID);

    const close = sent(1);
    expect(close[0].text).toContain('move-in inspection of 2025-06-12');
    expect(close.map((part) => part.text)).toEqual(
      expect.arrayContaining([
        'F1: Door hole and trim require repair. Two holes below the handle.',
        'F1 at move-in:',
      ]),
    );
    // Only the photograph filed under doors, not the window's.
    expect(close.filter((part) => part.type === 'input_image')).toHaveLength(1 + 1 + 2);
  });

  it('records what it saw on each finding, and whether the move-in already showed it', async () => {
    const { service, tx } = harness();

    await service.review('media-1', ORGANIZATION_ID);

    const updates = Object.fromEntries(
      tx.inspectionFinding.update.mock.calls.map(([call]) => [call.where.id, call.data]),
    );
    expect(updates['finding-door']).toMatchObject({
      visualStatus: 'VISIBLE',
      visualObservation: 'Two small holes below the handle.',
      baselineVisualStatus: 'PRESENT_AT_MOVE_IN',
      baselineVisualNote: 'The move-in photograph shows the same two holes.',
      baselinePhotoIds: ['move-in-photo-door'],
      // Already there at move-in: the tenant lean comes off.
      possibleResponsibility: 'UNDETERMINED',
    });
    // The narration said so; the video does not show it.
    expect(updates['finding-trim']).toMatchObject({
      visualStatus: 'NOT_VISIBLE',
      visualObservation: 'The trim looks intact.',
    });
  });

  it('suggests the sharp frame, boxed, and the scan’s other frames as alternatives', async () => {
    const { service, tx } = harness();

    await service.review('media-1', ORGANIZATION_ID);

    const suggestions = tx.findingFrameSuggestion.createMany.mock.calls[0][0].data.filter(
      (row: { findingId: string }) => row.findingId === 'finding-door',
    );
    expect(suggestions).toEqual([
      expect.objectContaining({
        atMs: 4500,
        rank: 0,
        boxX: 0.36,
        boxY: 0.6,
        boxWidth: 0.1,
        boxHeight: 0.06,
        observation: 'Two small holes below the handle.',
      }),
      expect.objectContaining({ atMs: 7000, rank: 1, boxX: null }),
    ]);
    // Nothing for a finding the video does not show.
    expect(
      tx.findingFrameSuggestion.createMany.mock.calls[0][0].data.some(
        (row: { findingId: string }) => row.findingId === 'finding-trim',
      ),
    ).toBe(false);
  });

  it('adds what it spotted only when both looks agree, never leaning to the tenant', async () => {
    const { service, tx } = harness();

    await service.review('media-1', ORGANIZATION_ID);

    const [[{ data: spotted }]] = tx.inspectionFinding.createMany.mock.calls;
    expect(spotted).toHaveLength(1);
    expect(spotted[0]).toMatchObject({
      source: 'AI_VISION',
      title: 'Broken drywall above the water heater',
      findingType: 'POSSIBLE_NEW_DAMAGE',
      comparisonResult: 'INSUFFICIENT_DATA',
      possibleResponsibility: 'UNDETERMINED',
      reviewStatus: 'PENDING_REVIEW',
      visualStatus: 'VISIBLE',
      videoTimestampStart: 7,
      aiAnalysisJobId: 'vision-job-1',
    });
  });

  it('replaces its own earlier suggestions and spotted findings, and keeps every decision', async () => {
    const { service, tx } = harness();

    await service.review('media-1', ORGANIZATION_ID);

    expect(tx.findingFrameSuggestion.deleteMany).toHaveBeenCalledWith({
      where: { inspectionMediaId: 'media-1', status: 'SUGGESTED' },
    });
    expect(tx.inspectionFinding.deleteMany).toHaveBeenCalledWith({
      where: { inspectionMediaId: 'media-1', source: 'AI_VISION', reviewStatus: 'PENDING_REVIEW' },
    });
    expect(tx.findingFrameSuggestion.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('records what both looks cost', async () => {
    const { service, aiSettings } = harness();

    const result = await service.review('media-1', ORGANIZATION_ID);

    expect(result?.usage).toEqual({ inputTokens: 20_000, outputTokens: 1_000, totalTokens: 21_000 });
    expect(aiSettings.recordUsage).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      expect.objectContaining({ modelId: 'gpt-5.6-sol' }),
      'VISUAL_REVIEW',
      { inputTokens: 20_000, outputTokens: 1_000, totalTokens: 21_000 },
      'media-1',
    );
  });

  it('does not compare with a move-in on a move-in', async () => {
    const { service, comparison, sent } = harness({
      media: {
        id: 'media-1',
        inspectionId: 'move-in-2',
        streamUid: 'uid-1',
        readyAt: new Date(),
        durationSeconds: 12,
        inspectionAreaId: 'inspection-area-1',
        inspectionArea: {
          propertyArea: { id: 'pa-entrance', name: 'Entrance' },
          inspection: { inspectionType: 'MOVE_IN', finalizedAt: null },
        },
      },
    });

    await service.review('media-1', ORGANIZATION_ID);

    expect(comparison.baselineAreaFor).not.toHaveBeenCalled();
    expect(sent(0)[0].text).toContain('This is a MOVE-IN');
    expect(sent(1)[0].text).not.toContain('move-in inspection of');
  });

  it('leaves what it found before alone when the model answers nonsense', async () => {
    const { service, tx, prisma } = harness({ scan: 'not json at all' as never });
    (global.fetch as jest.Mock).mockImplementation(async (url: string) =>
      url.includes('/thumbnails/')
        ? { ok: true, arrayBuffer: async () => new Uint8Array(300).buffer }
        : {
            ok: true,
            status: 200,
            json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'I cannot help.' }] }] }),
          },
    );

    await expect(service.review('media-1', ORGANIZATION_ID)).rejects.toThrow();
    expect(tx.findingFrameSuggestion.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiAnalysisJob.update).toHaveBeenCalledWith({
      where: { id: 'vision-job-1' },
      data: { status: 'FAILED' },
    });
  });

  it('has nothing to look at without an encoded Stream video', async () => {
    for (const media of [
      null,
      { id: 'media-1', streamUid: null, readyAt: new Date(), durationSeconds: 60 },
      { id: 'media-1', streamUid: 'uid', readyAt: null, durationSeconds: 60 },
    ]) {
      const { service, calls } = harness({ media });
      await expect(service.review('media-1', ORGANIZATION_ID)).resolves.toBeNull();
      expect(calls()).toHaveLength(0);
    }
  });

  // A re-run on a finalized inspection looks at the video too: the office
  // decides its findings after the visit is closed (2026-10-03).
  it('looks at a finalized inspection’s recording too', async () => {
    const { service, calls } = harness({
      media: {
        id: 'media-1',
        inspectionId: 'move-out-1',
        streamUid: 'uid-1',
        readyAt: new Date(),
        durationSeconds: 12,
        inspectionAreaId: 'inspection-area-1',
        inspectionArea: {
          propertyArea: { id: 'pa-entrance', name: 'Entrance' },
          inspection: { inspectionType: 'MOVE_OUT', finalizedAt: new Date('2026-10-02T16:45:36Z') },
        },
      },
    });
    await expect(service.review('media-1', ORGANIZATION_ID)).resolves.not.toBeNull();
    expect(calls().length).toBeGreaterThan(0);
  });
});

describe('the office’s house rules, in the look at the video', () => {
  it('judges what is worth listing by them, and records the version it ran under', async () => {
    const { service, sent, prisma } = harness({
      houseRules: 'Dirt is a cleaning item, never damage.',
    });

    await service.review('media-1', ORGANIZATION_ID);

    expect(sent(0)[0].text).toContain(
      '<house_rules>\nDirt is a cleaning item, never damage.\n</house_rules>',
    );
    expect(prisma.aiAnalysisJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ promptVersion: 'vision-3', guidanceVersion: 2 }),
    });
  });

  it('says nothing of rules when there are none', async () => {
    const { service, sent, prisma } = harness();

    await service.review('media-1', ORGANIZATION_ID);

    expect(sent(0)[0].text).not.toContain('<house_rules>');
    expect(prisma.aiAnalysisJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ guidanceVersion: null }),
    });
  });
});

/**
 * The technician's still photos of the room (2026-10-03): sharper than any
 * frame of a moving phone video, shown to the scan after the frames, and cited
 * as evidence the same way.
 */
describe('the technician’s photos of the room', () => {
  const ROOM_PHOTOS = [
    {
      id: 'photo-door',
      storageKey: 'photos/move-out-door.jpg',
      label: null,
      checklistItem: { label: 'Doors and locks' },
    },
    {
      id: 'photo-outlet',
      storageKey: 'photos/move-out-outlet.jpg',
      label: 'Outlet by the window',
      checklistItem: null,
    },
  ];
  const only = (findings: unknown[], additional: unknown[] = []) => ({ findings, additional });

  it('are shown to the scan after the frames, labelled to be cited, never the video’s own stills', async () => {
    const { service, sent, prisma } = harness({ roomPhotos: ROOM_PHOTOS });

    await service.review('media-1', ORGANIZATION_ID);

    const scan = sent(0);
    expect(scan[0].text).toContain('After the frames come 2 still photographs the technician took');
    expect(scan.map((part) => part.text)).toEqual(
      expect.arrayContaining(['P1 (photo: Doors and locks)', 'P2 (photo: Outlet by the window)']),
    );
    // Four frames of a twelve-second walkthrough, then the two photographs.
    expect(scan.filter((part) => part.type === 'input_image')).toHaveLength(6);
    const roomQuery = prisma.inspectionPhoto.findMany.mock.calls
      .map(([args]) => args)
      .find((args) => args.where.inspectionAreaId);
    expect(roomQuery).toMatchObject({
      where: {
        inspectionAreaId: 'inspection-area-1',
        storageStatus: 'UPLOADED',
        captureType: { not: 'VIDEO_FRAME_SNAPSHOT' },
      },
      take: 8,
    });
  });

  it('keep a finding seen only in a photo as seen, with the photo, and offer no frame', async () => {
    const { service, tx, sent } = harness({
      roomPhotos: ROOM_PHOTOS,
      scan: only([
        { ref: 'F1', visible: 'VISIBLE', frames: ['P1'], observation: 'Two holes under the handle.' },
        { ref: 'F2', visible: 'UNCLEAR', frames: [], observation: '' },
      ]),
      close: { items: [{ ref: 'F1', visible: true, box: null, observation: 'Two small holes below the handle.' }] },
    });

    await service.review('media-1', ORGANIZATION_ID);

    // The close look is shown the photograph, said to be one.
    expect(sent(1).map((part) => part.text)).toEqual(
      expect.arrayContaining([
        'F1: Door hole and trim require repair. Two holes under the handle. (a photograph of the room, not a frame)',
      ]),
    );
    const updates = Object.fromEntries(
      tx.inspectionFinding.update.mock.calls.map(([call]) => [call.where.id, call.data]),
    );
    expect(updates['finding-door']).toMatchObject({
      visualStatus: 'VISIBLE',
      visualObservation: 'Two small holes below the handle.',
      visualPhotoIds: ['photo-door'],
    });
    expect(updates['finding-trim']).toMatchObject({ visualStatus: 'UNCLEAR', visualPhotoIds: [] });
    expect(tx.findingFrameSuggestion.createMany).not.toHaveBeenCalled();
  });

  it('let a photo stand for a finding the sharp frame does not show, without offering that frame', async () => {
    const { service, tx } = harness({
      roomPhotos: ROOM_PHOTOS,
      scan: only([{ ref: 'F1', visible: 'VISIBLE', frames: ['T004', 'P1'], observation: 'Holes.' }]),
      close: { items: [{ ref: 'F1', visible: false, box: null, observation: '' }] },
    });

    await service.review('media-1', ORGANIZATION_ID);

    const door = tx.inspectionFinding.update.mock.calls.find(([call]) => call.where.id === 'finding-door')[0];
    expect(door.data).toMatchObject({ visualStatus: 'VISIBLE', visualPhotoIds: ['photo-door'] });
    expect(tx.findingFrameSuggestion.createMany).not.toHaveBeenCalled();
  });

  it('call a photo sighting a sharp look does not confirm unclear', async () => {
    const { service, tx } = harness({
      roomPhotos: ROOM_PHOTOS,
      scan: only([{ ref: 'F1', visible: 'VISIBLE', frames: ['P1'], observation: 'Holes.' }]),
      close: { items: [{ ref: 'F1', visible: false, box: null, observation: '' }] },
    });

    await service.review('media-1', ORGANIZATION_ID);

    const door = tx.inspectionFinding.update.mock.calls.find(([call]) => call.where.id === 'finding-door')[0];
    expect(door.data).toMatchObject({ visualStatus: 'UNCLEAR', visualPhotoIds: [] });
  });

  it('let the AI add a problem only a photo shows, once a sharp look agrees, citing no moment', async () => {
    const { service, tx } = harness({
      roomPhotos: ROOM_PHOTOS,
      scan: only(
        [],
        [
          {
            title: 'Cracked outlet cover',
            description: 'The cover plate is split.',
            category: 'Electrical',
            kind: 'DAMAGE',
            severity: 'LOW',
            frames: ['P2'],
            observation: 'A crack across the cover plate.',
          },
        ],
      ),
      close: { items: [{ ref: 'A1', visible: true, box: [0.4, 0.4, 0.1, 0.1], observation: 'Split cover plate.' }] },
    });

    await service.review('media-1', ORGANIZATION_ID);

    const [created] = tx.inspectionFinding.createMany.mock.calls[0][0].data;
    expect(created).toMatchObject({
      source: 'AI_VISION',
      title: 'Cracked outlet cover',
      videoTimestampStart: 0,
      videoTimestampEnd: 0,
      visualPhotoIds: ['photo-outlet'],
      reviewStatus: 'PENDING_REVIEW',
      possibleResponsibility: 'UNDETERMINED',
    });
    expect(tx.findingFrameSuggestion.createMany).not.toHaveBeenCalled();
  });
});
