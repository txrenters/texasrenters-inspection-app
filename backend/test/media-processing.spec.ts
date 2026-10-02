import { AiProvider } from '@prisma/client';

import { thumbnailKeyFor } from '../src/common/object-storage';
import {
  MediaProcessingService,
  analysisResponseSchema,
  extractJsonArray,
  formatTranscript,
  transcriptFrom,
  transcriptLines,
  withoutUnfoundedTenantLean,
} from '../src/technician/media-processing.service';

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';

const FINDING = {
  findingType: 'POSSIBLE_NEW_DAMAGE',
  category: 'Walls',
  title: 'Scuffed wall near window',
  description: 'The technician noted a long scuff mark beside the living-room window.',
  baselineCondition: 'No wall damage documented at move-in.',
  comparisonResult: 'POSSIBLE_NEW_DAMAGE',
  videoTimestampStart: 12,
  videoTimestampEnd: 20,
  severity: 'MEDIUM',
  possibleResponsibility: 'TENANT_REVIEW_REQUIRED',
  confidence: 0.82,
  recommendedReview: 'Compare the scuff against move-in photos before approving.',
};

describe('video poster frames', () => {
  it('derives a thumbnail key beside the video so no column can drift out of sync', () => {
    expect(thumbnailKeyFor('org-1/insp-1/area-1/videos/abc.mp4')).toBe(
      'org-1/insp-1/area-1/videos/abc.mp4.thumb.jpg',
    );
    // Legacy pre-migration keys have no extension and must still work.
    expect(thumbnailKeyFor('local-media-123')).toBe('local-media-123.thumb.jpg');
  });

  it('never lets a thumbnail failure interrupt transcription', async () => {
    const storage = {
      get: jest.fn().mockResolvedValue(Buffer.from('video-bytes')),
      // Simulates ffmpeg producing nothing / the upload failing.
      putFromFile: jest.fn().mockRejectedValue(new Error('thumbnail upload failed')),
      providerName: () => 'r2',
    };
    const service = new MediaProcessingService(
      {} as never,
      storage as never,
      {} as never,
      undefined,
    );
    // The generator is deliberately private: assert it swallows failures rather
    // than propagating them into the processing pipeline.
    const generate = (
      service as unknown as {
        generateThumbnail: (v: Buffer, m: string, k: string) => Promise<void>;
      }
    ).generateThumbnail.bind(service);
    await expect(generate(Buffer.from('x'), 'video/mp4', 'key-1')).resolves.toBeUndefined();
  });
});

describe('media processing pipeline', () => {
  it('extracts JSON arrays from fenced or prose-wrapped model output', () => {
    expect(extractJsonArray('```json\n[1,2]\n```')).toBe('[1,2]');
    expect(extractJsonArray('Here are the findings: [ {"a": 1} ] Hope this helps!')).toBe(
      '[ {"a": 1} ]',
    );
  });

  it('validates finding items and defaults malformed timestamps', () => {
    const parsed = analysisResponseSchema.safeParse([
      { ...FINDING, videoTimestampStart: -4, videoTimestampEnd: 'later' },
    ]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data[0].videoTimestampStart).toBe(0);
      expect(parsed.data[0].videoTimestampEnd).toBe(0);
    }
  });

  it('rounds a fractional timestamp instead of throwing the moment away', () => {
    // `.int()` used to turn 12.5 into 0:00: a real moment, discarded.
    const parsed = analysisResponseSchema.parse([
      { ...FINDING, videoTimestampStart: 12.4, videoTimestampEnd: 18.6 },
    ]);
    expect(parsed[0]).toMatchObject({ videoTimestampStart: 12, videoTimestampEnd: 19 });
  });

  it('transcribes, analyzes, stores PENDING_REVIEW findings, and advances the inspection', async () => {
    const media = {
      id: 'media-1',
      inspectionId: 'inspection-1',
      providerMediaId: 'local-key',
      // Present in the real select; a Stream-backed row has none, and the
      // pipeline refuses those rather than reading a null key.
      storageKey: 'inspection-media/org-1/media-1.mp4',
      mimeType: 'video/mp4',
      durationSeconds: 90,
      processingStatus: 'PENDING',
      inspectionArea: {
        propertyArea: {
          id: 'property-area-1',
          name: 'Living Room',
          floor: { name: 'Ground Floor' },
          baselineConditions: [],
        },
        inspection: { inspectionType: 'MOVE_OUT' },
      },
    };
    const prisma = {
      inspectionMedia: {
        findFirst: jest.fn().mockResolvedValue(media),
        // Read by the analysis to reach the area's recorded checklist answers.
        findUnique: jest.fn().mockResolvedValue({ inspectionAreaId: 'inspection-area-1' }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      // The technician's own assessment of each item — booleans, not speech.
      // The analysis treats these as authoritative over the transcript.
      inspectionAreaChecklistResponse: {
        findMany: jest.fn().mockResolvedValue([
          {
            isClean: true,
            isUndamaged: true,
            isWorking: true,
            comment: null,
            videoTimestampSeconds: 39,
            checklistItem: { label: 'Doors and locks' },
          },
        ]),
      },
      transcriptionJob: {
        upsert: jest.fn().mockResolvedValue({ id: 'transcription-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      transcriptSegment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        // createMany since transcription gained real per-utterance segments:
        // a provider that reports timings writes several rows, not one.
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      aiAnalysisJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      inspectionFinding: {
        // This recording's findings a person already decided, which the
        // analysis is told about so it does not raise them again.
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mediaProcessingEvent: { create: jest.fn().mockResolvedValue({}) },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({ status: 'PROCESSING' }),
        // updateMany, not update: the advance re-asserts the status in its
        // WHERE clause so an administrator's reopen cannot be overwritten by a
        // late-finishing recording.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    };
    const storage = { get: jest.fn().mockResolvedValue(Buffer.from([0, 0, 0, 0])) };
    const aiSettings = {
      resolve: jest.fn(async (_org: string, provider?: AiProvider) => ({
        provider: provider ?? AiProvider.OPENAI,
        modelId: 'gpt-5.6-terra',
        apiKey: 'test-key',
      })),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    global.fetch = jest
      .fn()
      // 1) transcription
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ text: 'There is a scuff mark on the wall near the window.' }),
      })
      // 2) findings analysis
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          output: [
            { type: 'reasoning' },
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify([FINDING]) }],
            },
          ],
          usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
        }),
      }) as unknown as typeof fetch;

    const service = new MediaProcessingService(
      prisma as never,
      storage as never,
      aiSettings as never,
    );
    await service.process('media-1', ORGANIZATION_ID);

    expect(prisma.inspectionFinding.createMany).toHaveBeenCalledTimes(1);

    // The analysis prompt must carry the technician's recorded answers, and must
    // say they outrank the transcript.
    //
    // This is the guard for a real incident: OpenAI transcribed "clean and
    // undamaged" as "clean and damaged" — the "un-" is unstressed and the two
    // words are opposites — and three findings asserted damage on items the
    // technician had recorded as undamaged. The booleans cannot be misheard, so
    // they are what the model is told to trust.
    const analysisBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[1][1].body as string,
    ) as { input: string };
    const prompt = JSON.stringify(analysisBody);
    expect(prompt).toContain('<assessment>');
    expect(prompt).toContain('Doors and locks');
    expect(prompt).toContain('undamaged');
    expect(prompt).toContain('AUTHORITATIVE');
    expect(prompt).toContain('Never report damage for an item recorded as undamaged');
    // The moment the answer was given, so a finding about this item can cite it
    // instead of defaulting to 0:00.
    expect(prompt).toContain('[at 39s]');
    // No DEEPGRAM_API_KEY in this test, so the OpenAI path runs and reports no
    // timings — the whole narration is stored as one whole-recording segment.
    expect(prisma.transcriptSegment.createMany).toHaveBeenCalledWith({
      data: [
        {
          transcriptionJobId: 'transcription-1',
          startSeconds: 0,
          endSeconds: 90,
          text: 'There is a scuff mark on the wall near the window.',
        },
      ],
    });
    expect(
      prisma.mediaProcessingEvent.create.mock.calls.find(
        (call) => call[0].data.eventType === 'TRANSCRIPTION_COMPLETED',
      )?.[0].data.payloadSummary,
    ).toEqual({ characters: 50 });
    const rows = prisma.inspectionFinding.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({
      inspectionId: 'inspection-1',
      propertyAreaId: 'property-area-1',
      inspectionMediaId: 'media-1',
      aiAnalysisJobId: 'job-1',
      reviewStatus: 'PENDING_REVIEW',
    });
    const statusUpdates = prisma.inspectionMedia.update.mock.calls.map(
      (call) => call[0].data.processingStatus,
    );
    expect(statusUpdates).toEqual(['PROCESSING', 'READY']);
    // Inspection was PROCESSING with no unfinished media → moves to review,
    // but only while it is still in an advanceable status.
    expect(prisma.inspection.updateMany).toHaveBeenCalledWith({
      where: { id: 'inspection-1', status: { in: ['TECHNICIAN_SUBMITTED', 'PROCESSING'] } },
      data: { status: 'REVIEW_REQUIRED' },
    });
    expect(aiSettings.recordUsage).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      expect.objectContaining({ modelId: 'gpt-5.6-terra' }),
      'FINDING_ANALYSIS',
      { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      'media-1',
    );
  });

  it('marks the media FAILED with a diagnostic event when transcription is not configured', async () => {
    const prisma = {
      inspectionMedia: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'media-1',
          inspectionId: 'inspection-1',
          providerMediaId: 'local-key',
          storageKey: 'inspection-media/org-1/media-1.mp4',
          mimeType: 'video/mp4',
          durationSeconds: 90,
          processingStatus: 'PENDING',
          inspectionArea: {
            propertyArea: { id: 'a', name: 'Kitchen', floor: null, baselineConditions: [] },
            inspection: { inspectionType: 'MOVE_IN' },
          },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      mediaProcessingEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const aiSettings = {
      resolve: jest.fn().mockRejectedValue(new Error('no key')),
      recordUsage: jest.fn(),
    };
    const service = new MediaProcessingService(
      prisma as never,
      { get: jest.fn() } as never,
      aiSettings as never,
    );
    await service.process('media-1', ORGANIZATION_ID);

    const statuses = prisma.inspectionMedia.update.mock.calls.map(
      (call) => call[0].data.processingStatus,
    );
    expect(statuses).toEqual(['PROCESSING', 'FAILED']);
    const failure = prisma.mediaProcessingEvent.create.mock.calls.find(
      (call) => call[0].data.eventType === 'PROCESSING_FAILED',
    );
    expect(failure[0].data.payloadSummary.message).toMatch(/OpenAI API key/);
  });
});

describe('the narration reaches the analysis with its timings', () => {
  it('stores whole seconds inside the recording, whatever the provider reported', () => {
    // Deepgram reports fractions; the column is an integer.
    expect(
      transcriptLines(
        [
          { startSeconds: 1.2, endSeconds: 4.8, text: ' There is a hole in the door. ' },
          { startSeconds: 88.4, endSeconds: 95, text: 'And that is the entrance.' },
          { startSeconds: 50, endSeconds: 51, text: '   ' },
        ],
        90,
      ),
    ).toEqual([
      { startSeconds: 1, endSeconds: 5, text: 'There is a hole in the door.' },
      { startSeconds: 88, endSeconds: 90, text: 'And that is the entrance.' },
    ]);
  });

  it('cites each line by the seconds it was spoken at', () => {
    const transcript = transcriptFrom(
      [
        { startSeconds: 0, endSeconds: 6, text: 'This is the entrance.' },
        { startSeconds: 18, endSeconds: 24, text: 'There is a hole in the door.' },
      ],
      90,
    );
    expect(transcript.timed).toBe(true);
    expect(formatTranscript(transcript)).toBe(
      '[0-6s] This is the entrance.\n[18-24s] There is a hole in the door.',
    );
  });

  it('does not pass off the whole-recording fallback as a timing', () => {
    // One line from 0 to the end is what is stored when the provider gave no
    // timings. Citing it would put every finding at 0:00 with a straight face.
    const transcript = transcriptFrom(
      [{ startSeconds: 0, endSeconds: 90, text: 'Hole in the door.' }],
      90,
    );
    expect(transcript.timed).toBe(false);
    expect(formatTranscript(transcript)).toBe('Hole in the door.');
  });
});

describe('the AI does not lean toward the tenant without grounds', () => {
  const lean = { ...FINDING, possibleResponsibility: 'TENANT_REVIEW_REQUIRED' } as never;

  it('keeps the lean on new damage measured against a baseline', () => {
    expect(withoutUnfoundedTenantLean(lean, false).possibleResponsibility).toBe(
      'TENANT_REVIEW_REQUIRED',
    );
  });

  it('drops it on a move-out with no move-in to compare against', () => {
    expect(withoutUnfoundedTenantLean(lean, true).possibleResponsibility).toBe('UNDETERMINED');
  });

  it('drops it on a condition the AI itself calls pre-existing or wear', () => {
    for (const comparisonResult of ['EXISTING_CONDITION', 'NORMAL_WEAR'])
      expect(
        withoutUnfoundedTenantLean({ ...(lean as object), comparisonResult } as never, false)
          .possibleResponsibility,
      ).toBe('UNDETERMINED');
    expect(
      withoutUnfoundedTenantLean(
        { ...(lean as object), findingType: 'EXISTING_CONDITION' } as never,
        false,
      ).possibleResponsibility,
    ).toBe('UNDETERMINED');
  });

  it('leaves an owner lean alone', () => {
    const owner = { ...FINDING, possibleResponsibility: 'OWNER_REVIEW_REQUIRED' } as never;
    expect(withoutUnfoundedTenantLean(owner, true).possibleResponsibility).toBe(
      'OWNER_REVIEW_REQUIRED',
    );
  });
});

/**
 * A move-out recording ready for a re-run, with a stored, timed narration. The
 * move-in the comparison pairs it with is `baseline`; `reviewed` are this
 * recording's findings a person has already decided.
 */
function reanalysisHarness(
  opts: {
    baseline?: {
      inspectionId: string;
      scheduledAt: Date;
      area: { propertyAreaId: string; name: string } | null;
    } | null;
    moveInAnswers?: unknown[];
    moveInFindings?: unknown[];
    reviewed?: unknown[];
    storedSegments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
    comparisonStatus?: string | null;
    finding?: Record<string, unknown>;
    analysis?: 'ok' | 'invalid';
  } = {},
) {
  const media = {
    id: 'media-1',
    inspectionId: 'move-out-1',
    providerMediaId: 'stream-1',
    storageKey: null,
    streamUid: 'uid-1',
    mimeType: 'video/mp4',
    durationSeconds: 165,
    processingStatus: 'READY',
    captureSummary: null,
    recordedAt: null,
    inspectionAreaId: 'inspection-area-1',
    technicianId: 'technician-1',
    organizationId: ORGANIZATION_ID,
    inspectionArea: {
      propertyArea: { id: 'pa-entrance', name: 'Entrance', floor: null, baselineConditions: [] },
      inspection: { inspectionType: 'MOVE_OUT', baselineInspectionId: null },
    },
  };
  const prisma = {
    inspectionMedia: {
      findFirst: jest.fn().mockResolvedValue(media),
      findUnique: jest.fn().mockResolvedValue({ inspectionAreaId: 'inspection-area-1' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    inspectionAreaChecklistResponse: {
      // This recording's own answers are read by area; the move-in's through
      // the relation, by inspection and room.
      findMany: jest.fn(async (args: { where: { inspectionAreaId?: string } }) =>
        args.where.inspectionAreaId ? [] : (opts.moveInAnswers ?? []),
      ),
    },
    inspectionFinding: {
      findMany: jest.fn(async (args: { where: { inspectionMediaId?: string } }) =>
        args.where.inspectionMediaId ? (opts.reviewed ?? []) : (opts.moveInFindings ?? []),
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    transcriptionJob: {
      findUnique: jest.fn().mockResolvedValue(
        opts.storedSegments ? { status: 'COMPLETED', segments: opts.storedSegments } : null,
      ),
      upsert: jest.fn().mockResolvedValue({ id: 'transcription-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    transcriptSegment: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    aiAnalysisJob: {
      create: jest.fn().mockResolvedValue({ id: 'job-2' }),
      update: jest.fn().mockResolvedValue({}),
    },
    mediaProcessingEvent: { create: jest.fn().mockResolvedValue({}) },
    inspectionComparison: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.comparisonStatus ? { status: opts.comparisonStatus } : null),
    },
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
  const comparison = {
    baselineAreaFor: jest.fn().mockResolvedValue(opts.baseline ?? null),
    generate: jest.fn().mockResolvedValue({}),
  };
  const aiSettings = {
    resolve: jest.fn(async () => ({
      provider: AiProvider.OPENAI,
      modelId: 'gpt-5.6-terra',
      apiKey: 'test-key',
    })),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };
  const answer = [{ ...FINDING, ...opts.finding }];
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: opts.analysis === 'invalid' ? 'no findings today' : JSON.stringify(answer),
            },
          ],
        },
      ],
      usage: { input_tokens: 900, output_tokens: 300, total_tokens: 1200 },
    }),
  }) as unknown as typeof fetch;
  const service = new MediaProcessingService(
    prisma as never,
    { get: jest.fn() } as never,
    aiSettings as never,
    comparison as never,
  );
  /** The analysis prompt, as sent. */
  const prompt = () => {
    const call = (global.fetch as jest.Mock).mock.calls.find(
      ([url]) => url === 'https://api.openai.com/v1/responses',
    );
    return (JSON.parse(call[1].body as string) as { input: Array<{ content: Array<{ text: string }> }> })
      .input[0].content[0].text;
  };
  /** The events written, by type. */
  const events = () =>
    prisma.mediaProcessingEvent.create.mock.calls.map((call) => call[0].data.eventType as string);
  /** Wait for the re-run, which starts after the call returns, to end. */
  const settled = async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    for (let count = 0; count < 200; count += 1) {
      if (events().some((type) => type === 'REANALYSIS_COMPLETED' || type === 'REANALYSIS_FAILED')) {
        // And the `finally` that releases the recording, a few turns behind.
        for (let after = 0; after < 5; after += 1) await tick();
        return;
      }
      await tick();
    }
    throw new Error('The re-run never finished.');
  };
  return { service, prisma, comparison, prompt, events, settled };
}

const TIMED_NARRATION = [
  { startSeconds: 0, endSeconds: 6, text: 'This is the entrance.' },
  { startSeconds: 18, endSeconds: 24, text: 'The floor is damaged beyond repair.' },
];

describe('re-running the analysis on a recording', () => {
  it('reads the move-in the comparison pairs this room with, checklist and notes included', async () => {
    // 5819 Flower Gate Dr, 2026-10-01: the move-out had no creation-time link,
    // so the AI said there was no baseline, and called a floor the move-in had
    // already recorded as damaged possible new damage leaning to the tenant.
    const harness = reanalysisHarness({
      baseline: {
        inspectionId: 'move-in-1',
        scheduledAt: new Date('2025-06-12T00:00:00.000Z'),
        area: { propertyAreaId: 'pa-entrance', name: 'Entrance' },
      },
      moveInAnswers: [
        {
          isClean: true,
          isUndamaged: false,
          isWorking: true,
          comment: null,
          checklistItem: { label: 'Floor and coverings' },
        },
        {
          isClean: false,
          isUndamaged: true,
          isWorking: true,
          comment: 'Door need to be painting',
          checklistItem: { label: 'Doors and locks' },
        },
      ],
      storedSegments: TIMED_NARRATION,
    });

    expect(harness.service.reanalyze('media-1', ORGANIZATION_ID)).toBe(true);
    await harness.settled();

    expect(harness.comparison.baselineAreaFor).toHaveBeenCalledWith('move-out-1', 'pa-entrance');
    const prompt = harness.prompt();
    expect(prompt).toContain('Move-in inspection of 2025-06-12, Entrance.');
    expect(prompt).toContain('- Floor and coverings: clean, DAMAGED, working');
    expect(prompt).toContain('move-in note: Door need to be painting');
    expect(prompt).toContain('A condition the move-in already recorded is pre-existing');
    expect(prompt).not.toContain('No move-in baseline is documented');
    // The narration with its seconds, which is what the finding's time is for.
    expect(prompt).toContain('[18-24s] The floor is damaged beyond repair.');
    // The tenant lean stands: there is a baseline, and the AI called it new.
    const rows = harness.prisma.inspectionFinding.createMany.mock.calls[0][0].data;
    expect(rows[1]).toMatchObject({ possibleResponsibility: 'TENANT_REVIEW_REQUIRED' });
  });

  it('says there is no baseline when the comparison has none, and takes the tenant lean away', async () => {
    const harness = reanalysisHarness({ baseline: null, storedSegments: TIMED_NARRATION });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.prompt()).toContain('nothing here can tell new damage from old');
    const rows = harness.prisma.inspectionFinding.createMany.mock.calls[0][0].data;
    expect(rows.every((row: { possibleResponsibility: string }) => row.possibleResponsibility !== 'TENANT_REVIEW_REQUIRED')).toBe(true);
  });

  it('treats a move-in room that recorded nothing as no baseline', async () => {
    const harness = reanalysisHarness({
      baseline: {
        inspectionId: 'move-in-1',
        scheduledAt: new Date('2025-06-12T00:00:00.000Z'),
        area: { propertyAreaId: 'pa-entrance', name: 'Entrance' },
      },
      storedSegments: TIMED_NARRATION,
    });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.prompt()).toContain('nothing here can tell new damage from old');
  });

  it('reuses the stored narration instead of transcribing the video again', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    // One call, the analysis: no Cloudflare download, no transcription bill.
    expect((global.fetch as jest.Mock).mock.calls.map(([url]) => url)).toEqual([
      'https://api.openai.com/v1/responses',
    ]);
    expect(harness.prisma.transcriptionJob.upsert).not.toHaveBeenCalled();
    expect(harness.events()).toEqual(['REANALYSIS_STARTED', 'REANALYSIS_COMPLETED']);
  });

  it('tells the model what the office already decided, and replaces only what it has not', async () => {
    const harness = reanalysisHarness({
      storedSegments: TIMED_NARRATION,
      reviewed: [
        { title: 'Door hole and trim require repair', description: 'A hole.', reviewStatus: 'APPROVED' },
        { title: 'Window screen missing', description: 'No screen.', reviewStatus: 'REJECTED' },
      ],
    });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    const prompt = harness.prompt();
    expect(prompt).toContain('ALREADY RECORDED: Door hole and trim require repair');
    expect(prompt).toContain('REJECTED: Window screen missing');
    expect(harness.prisma.inspectionFinding.deleteMany).toHaveBeenCalledWith({
      where: { inspectionMediaId: 'media-1', reviewStatus: 'PENDING_REVIEW' },
    });
  });

  it('leaves the earlier findings and the recording alone when the new analysis is unusable', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION, analysis: 'invalid' });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.events()).toEqual(['REANALYSIS_STARTED', 'REANALYSIS_FAILED']);
    expect(harness.prisma.inspectionFinding.deleteMany).not.toHaveBeenCalled();
    // Still READY, still playable: a re-run never touches the status.
    expect(harness.prisma.inspectionMedia.update).not.toHaveBeenCalled();
  });

  it('starts once, however many times it is asked while running', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION });

    expect(harness.service.reanalyze('media-1', ORGANIZATION_ID)).toBe(true);
    expect(harness.service.reanalyze('media-1', ORGANIZATION_ID)).toBe(false);
    await harness.settled();
    expect(harness.prisma.aiAnalysisJob.create).toHaveBeenCalledTimes(1);
    // And can be asked again once it is done.
    expect(harness.service.reanalyze('media-1', ORGANIZATION_ID)).toBe(true);
  });

  it('brings a draft comparison up to date, and never an approved one', async () => {
    const draft = reanalysisHarness({ storedSegments: TIMED_NARRATION, comparisonStatus: 'DRAFT' });
    draft.service.reanalyze('media-1', ORGANIZATION_ID);
    await draft.settled();
    expect(draft.comparison.generate).toHaveBeenCalledWith('move-out-1');

    const approved = reanalysisHarness({
      storedSegments: TIMED_NARRATION,
      comparisonStatus: 'APPROVED',
    });
    approved.service.reanalyze('media-1', ORGANIZATION_ID);
    await approved.settled();
    expect(approved.comparison.generate).not.toHaveBeenCalled();
  });
});
