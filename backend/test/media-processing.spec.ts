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

  // The office (2026-10-06): a sentence on every finding came back as the same
  // "compare the move-in and move-out". Empty is the usual answer now.
  it('takes a finding with no advice for the reviewer, rather than failing the analysis', () => {
    const withoutAdvice: Partial<typeof FINDING> = { ...FINDING };
    delete withoutAdvice.recommendedReview;
    const parsed = analysisResponseSchema.parse([{ ...FINDING, recommendedReview: '' }, withoutAdvice]);
    expect(parsed.map((item) => item.recommendedReview)).toEqual(['', '']);
  });

  it('takes a room with many problems, one finding each', () => {
    expect(analysisResponseSchema.safeParse(Array.from({ length: 40 }, () => FINDING)).success).toBe(true);
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
        // Nothing transcribed yet: the first run.
        findUnique: jest.fn().mockResolvedValue(null),
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
      transcriptionJob: { findUnique: jest.fn().mockResolvedValue(null) },
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
    /** The model's whole answer, in place of the one `finding`. */
    findings?: Array<Record<string, unknown>>;
    /** This room's own checklist answers on the move-out. */
    answers?: unknown[];
    analysis?: 'ok' | 'invalid';
    /** The AI's look at the frames; absent unless a test is about it. */
    visualReview?: { enabled: jest.Mock; review: jest.Mock };
    /** The office's house rules and lessons; absent unless a test is about them. */
    guidance?: { current: jest.Mock; lessons: jest.Mock };
    /** Frames the AI filed under findings this re-run replaces. */
    orphans?: Array<{ id: string; storageKey: string }>;
    /** Cloudflare, for a re-run that transcribes the recording again. */
    stream?: { ensureDownloadUrl: jest.Mock };
    /** The report's room summaries; absent unless a test is about them. */
    recordingSummary?: { afterRetranscription: jest.Mock };
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
        args.where.inspectionAreaId ? (opts.answers ?? []) : (opts.moveInAnswers ?? []),
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
    // Present so a write to it would be seen: a re-run must never make one.
    inspection: { update: jest.fn(), updateMany: jest.fn() },
    inspectionPhoto: {
      findMany: jest.fn().mockResolvedValue(opts.orphans ?? []),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
  const storage = { get: jest.fn(), delete: jest.fn().mockResolvedValue(undefined) };
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
  const answer = opts.findings?.map((finding) => ({ ...FINDING, ...finding })) ?? [
    { ...FINDING, ...opts.finding },
  ];
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
    storage as never,
    aiSettings as never,
    comparison as never,
    opts.stream as never,
    opts.visualReview as never,
    opts.guidance as never,
    undefined,
    opts.recordingSummary as never,
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
  return { service, prisma, storage, comparison, aiSettings, prompt, events, settled };
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

  // A re-run is allowed on a finalized inspection (2026-10-03) because of this:
  // the visit's status is what Jobber's completion and the technician's paid
  // time follow, and a re-run writes findings only.
  it('never moves the inspection’s status', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.prisma.inspectionFinding.createMany).toHaveBeenCalled();
    expect(harness.prisma.inspection.update).not.toHaveBeenCalled();
    expect(harness.prisma.inspection.updateMany).not.toHaveBeenCalled();
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

  it('does not pay to transcribe a silent room again', async () => {
    const harness = reanalysisHarness({ storedSegments: [] });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.prisma.transcriptionJob.upsert).not.toHaveBeenCalled();
    expect(harness.events()).toEqual(['REANALYSIS_STARTED', 'REANALYSIS_COMPLETED']);
  });

  /**
   * Transcripts stored before invented lines were dropped. The stock lines are
   * only what shows: the rest reads as speech, so the recording is transcribed
   * again, and the room's report summary written from the new transcript.
   */
  it('transcribes again a narration holding lines whisper invented, then rewrites the room summary', async () => {
    const recordingSummary = { afterRetranscription: jest.fn().mockResolvedValue(undefined) };
    const harness = reanalysisHarness({
      storedSegments: [
        { startSeconds: 0, endSeconds: 10, text: 'Special thanks to the cast and crew.' },
        { startSeconds: 14, endSeconds: 16, text: 'Thanks for watching.' },
        { startSeconds: 16, endSeconds: 18, text: 'Rest in peace.' },
      ],
      stream: {
        ensureDownloadUrl: jest
          .fn()
          .mockResolvedValue('https://customer-abc.cloudflarestream.com/uid-1/downloads/default.mp4'),
      },
      recordingSummary,
    });
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('cloudflarestream.com'))
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          text: 'Thanks for watching. Rest in peace.',
          segments: [
            { start: 14, end: 16, text: ' Thanks for watching.', no_speech_prob: 0.9 },
            { start: 16, end: 18, text: ' Rest in peace.', no_speech_prob: 0.9 },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    // ffmpeg is real time, which `settled` does not wait for; the audio is not what is tested.
    jest
      .spyOn(harness.service as unknown as { extractAudio: () => Promise<unknown> }, 'extractAudio')
      .mockResolvedValue({ bytes: Buffer.from([0]), name: 'audio.m4a', type: 'audio/mp4' });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.events()).toEqual(['REANALYSIS_STARTED', 'REANALYSIS_COMPLETED']);
    expect(harness.prisma.transcriptionJob.upsert).toHaveBeenCalledTimes(1);
    expect(harness.prisma.transcriptSegment.createMany).toHaveBeenCalledWith({ data: [] });
    expect(recordingSummary.afterRetranscription).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      'move-out-1',
      'inspection-area-1',
    );
  });

  it('leaves the room summary alone when the stored narration was reused', async () => {
    const recordingSummary = { afterRetranscription: jest.fn() };
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION, recordingSummary });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(recordingSummary.afterRetranscription).not.toHaveBeenCalled();
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
      where: { inspectionMediaId: 'media-1', reviewStatus: 'PENDING_REVIEW', source: 'NARRATION' },
    });
  });

  it('takes the frames the AI filed under the replaced findings with them', async () => {
    const harness = reanalysisHarness({
      storedSegments: TIMED_NARRATION,
      orphans: [{ id: 'ai-photo-old', storageKey: 'organizations/x/old.jpg' }],
    });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.prisma.inspectionPhoto.findMany).toHaveBeenCalledWith({
      where: {
        inspectionAreaId: 'inspection-area-1',
        findingId: null,
        metadata: { path: ['filedBy'], equals: 'AI' },
      },
      select: { id: true, storageKey: true },
    });
    // After the findings they were filed under are gone, not before.
    expect(harness.prisma.inspectionPhoto.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      harness.prisma.inspectionFinding.deleteMany.mock.invocationCallOrder[0],
    );
    expect(harness.prisma.inspectionPhoto.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['ai-photo-old'] } },
    });
    expect(harness.storage.delete).toHaveBeenCalledWith('organizations/x/old.jpg');
  });

  it('asks for every problem, one thing per finding, said specifically, without stock advice', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    const prompt = harness.prompt();
    expect(prompt).toContain('Report EVERY problem the technician names, minor ones included');
    // Not a checklist answer said back (10830 Harston Dr: 227 findings, most of
    // them "Walls and ceilings: not clean"), and a title short enough to print
    // as the report's comment (2026-10-07).
    expect(prompt).not.toContain('or the checklist marks');
    expect(prompt).toContain('A checklist answer on its own is not a finding');
    expect(prompt).toContain('at most eight words');
    expect(prompt).toContain('Never join two things in one finding');
    expect(prompt).toContain('Do not repeat the title');
    expect(prompt).toContain('recommendedReview: an empty string unless');
    expect(prompt).not.toContain('one actionable sentence for the human reviewer');
    // The timestamp rule no longer supposes a finding about an item nobody mentions.
    expect(prompt).not.toContain('nobody talks about');
    expect(prompt).toContain("no line carries a time, use its checklist item's [at Ns] time");
  });

  // 20906 Greenfield Trl's move-out (2026-10-09): 372 findings, the Kitchen's
  // "Floor and coverings" row scored N, N, N and filed again for each axis.
  const ECHOES = [
    {
      category: 'Flooring',
      title: 'Entrance floor or coverings are not clean',
      description: 'The technician recorded the entrance floor and coverings as not clean.',
    },
    {
      category: 'Flooring',
      title: 'Entrance floor or covering component not working',
      description: 'The checklist records the floor as not working; the narration does not specify why.',
    },
    {
      category: 'Flooring',
      title: 'Entrance floor recorded damaged',
      description: 'The narration states the floor is damaged without identifying the location.',
    },
  ];
  const FLOOR_SCORED_N = {
    isClean: false,
    isUndamaged: false,
    isWorking: false,
    comment: null,
    videoTimestampSeconds: null,
    checklistItem: { label: 'Floor and coverings', keywords: ['floor', 'carpet'] },
  };

  it('stores no finding that only says a failed checklist answer back', async () => {
    const harness = reanalysisHarness({
      storedSegments: TIMED_NARRATION,
      answers: [
        FLOOR_SCORED_N,
        {
          isClean: true,
          isUndamaged: true,
          isWorking: true,
          comment: null,
          videoTimestampSeconds: null,
          checklistItem: { label: 'Doors and locks', keywords: ['door', 'lock'] },
        },
      ],
      findings: [
        ...ECHOES,
        // What is wrong with the same row, and the work it needs.
        {
          category: 'Flooring',
          title: 'Entrance floor: tile cracked by the door',
          description: 'One tile is cracked corner to corner.',
        },
        {
          category: 'Flooring',
          title: 'Entrance floor needs sweeping and mopping',
          description: 'The technician says the floor is dirty.',
        },
        // A row that passed: this says nothing back, it disagrees, and a person decides.
        {
          category: 'Doors',
          title: 'Entrance door damaged',
          description: 'The technician recorded the door as damaged.',
        },
      ],
    });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    const rows = harness.prisma.inspectionFinding.createMany.mock.calls[0][0].data as Array<{
      title: string;
      reviewStatus: string;
    }>;
    expect(rows.map((row) => row.title)).toEqual([
      'Room condition summary',
      'Entrance floor: tile cracked by the door',
      'Entrance floor needs sweeping and mopping',
      'Entrance door damaged',
    ]);
    expect(rows.every((row) => row.reviewStatus === 'PENDING_REVIEW')).toBe(true);
  });

  it('keeps them while nobody has scored the row: then they are all the office has', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION, findings: ECHOES });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    const rows = harness.prisma.inspectionFinding.createMany.mock.calls[0][0].data as Array<{
      title: string;
    }>;
    expect(rows.map((row) => row.title)).toEqual([
      'Room condition summary',
      ...ECHOES.map((echo) => echo.title),
    ]);
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

  it('brings the comparison up to date, approved under the old rules or not', async () => {
    // Nobody approves a comparison any more (2026-10-07): there is no
    // decision a redraw could overwrite.
    for (const comparisonStatus of ['DRAFT', 'APPROVED']) {
      const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION, comparisonStatus });
      harness.service.reanalyze('media-1', ORGANIZATION_ID);
      await harness.settled();
      expect(harness.comparison.generate).toHaveBeenCalledWith('move-out-1');
    }

    // A move-out with none yet gets its first when it is read.
    const none = reanalysisHarness({ storedSegments: TIMED_NARRATION });
    none.service.reanalyze('media-1', ORGANIZATION_ID);
    await none.settled();
    expect(none.comparison.generate).not.toHaveBeenCalled();
  });
});

describe('the AI looking at the video, after the narration', () => {
  const visual = (enabled: boolean, review: jest.Mock) => ({
    enabled: jest.fn().mockResolvedValue(enabled),
    review,
  });

  it('looks once the narration is analysed, when the office has switched it on', async () => {
    const review = jest
      .fn()
      .mockResolvedValue({ checked: 2, suggested: 3, spotted: 1, usage: { totalTokens: 21_000 } });
    const harness = reanalysisHarness({
      storedSegments: TIMED_NARRATION,
      visualReview: visual(true, review),
    });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(review).toHaveBeenCalledWith('media-1', ORGANIZATION_ID);
    expect(harness.events()).toEqual([
      'REANALYSIS_STARTED',
      'VISUAL_REVIEW_COMPLETED',
      'REANALYSIS_COMPLETED',
    ]);
  });

  it('does not look while it is switched off', async () => {
    const review = jest.fn();
    const harness = reanalysisHarness({
      storedSegments: TIMED_NARRATION,
      visualReview: visual(false, review),
    });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(review).not.toHaveBeenCalled();
    expect(harness.events()).toEqual(['REANALYSIS_STARTED', 'REANALYSIS_COMPLETED']);
  });

  it('never fails the run: the narration’s findings stand when the look at the video does not', async () => {
    const review = jest.fn().mockRejectedValue(new Error('provider down'));
    const harness = reanalysisHarness({
      storedSegments: TIMED_NARRATION,
      visualReview: visual(true, review),
    });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.events()).toEqual([
      'REANALYSIS_STARTED',
      'VISUAL_REVIEW_FAILED',
      'REANALYSIS_COMPLETED',
    ]);
    expect(harness.prisma.inspectionFinding.createMany).toHaveBeenCalled();
  });

  it('replaces only the narration’s own undecided findings, not what the AI spotted', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.prisma.inspectionFinding.deleteMany).toHaveBeenCalledWith({
      where: { inspectionMediaId: 'media-1', reviewStatus: 'PENDING_REVIEW', source: 'NARRATION' },
    });
  });
});

describe('the office teaches the analysis', () => {
  const guidance = (text: string | null) => ({
    current: jest.fn().mockResolvedValue(
      text === null ? null : { version: 3, text, createdAt: new Date('2026-10-03T00:00:00Z') },
    ),
    lessons: jest
      .fn()
      .mockResolvedValue([
        '- Rejected as normal wear and tear: "Small nail holes in wall" (Bedroom 2).',
      ]),
  });

  it('reads the house rules and the office’s recent decisions into the prompt', async () => {
    const teaching = guidance('Small nail holes from pictures are normal wear, never damage.');
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION, guidance: teaching });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    const prompt = harness.prompt();
    expect(prompt).toContain(
      '<house_rules>\nSmall nail holes from pictures are normal wear, never damage.\n</house_rules>',
    );
    expect(prompt).toContain('every finding stays a suggestion for review');
    expect(prompt).toContain(
      '<lessons>\n- Rejected as normal wear and tear: "Small nail holes in wall" (Bedroom 2).\n</lessons>',
    );
    // Lessons come from other inspections, chosen for this room.
    expect(teaching.lessons).toHaveBeenCalledWith(ORGANIZATION_ID, 'Entrance', 'move-out-1');
    // The analysis records the rules it ran under, for the scorecard.
    expect(harness.prisma.aiAnalysisJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ promptVersion: '9', guidanceVersion: 3 }),
    });
  });

  it('says nothing about rules the office has not written', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION });

    harness.service.reanalyze('media-1', ORGANIZATION_ID);
    await harness.settled();

    expect(harness.prompt()).not.toContain('<house_rules>');
    expect(harness.prompt()).not.toContain('<lessons>');
    expect(harness.prisma.aiAnalysisJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ guidanceVersion: null }),
    });
  });
});

describe('trying draft house rules on a recording', () => {
  const decided = [
    { title: 'Scuffed wall near window', description: 'Long scuff.', reviewStatus: 'REJECTED' },
  ];

  it('runs the analysis under the draft and stores nothing but the usage', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION, reviewed: decided });

    const result = await harness.service.previewAnalysis(
      'media-1',
      ORGANIZATION_ID,
      '  Scuffs are normal wear.  ',
    );

    expect(result.items.map((item) => item.title)).toContain('Scuffed wall near window');
    expect(result.modelId).toBe('gpt-5.6-terra');
    expect(harness.prompt()).toContain('<house_rules>\nScuffs are normal wear.\n</house_rules>');
    expect(harness.prisma.inspectionFinding.deleteMany).not.toHaveBeenCalled();
    expect(harness.prisma.inspectionFinding.createMany).not.toHaveBeenCalled();
    expect(harness.prisma.aiAnalysisJob.create).not.toHaveBeenCalled();
    expect(harness.aiSettings.recordUsage).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      expect.objectContaining({ modelId: 'gpt-5.6-terra' }),
      'GUIDANCE_PREVIEW',
      expect.objectContaining({ totalTokens: 1200 }),
      'media-1',
    );
  });

  it('is not shown the decisions it is judged against', async () => {
    // Told the office rejected the scuff, the model would leave it out and the
    // draft would get the credit.
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION, reviewed: decided });

    await harness.service.previewAnalysis('media-1', ORGANIZATION_ID, 'Scuffs are normal wear.');

    expect(harness.prompt()).not.toContain('<reviewed>');
  });

  it('tries the analysis with no rules at all when the draft is empty', async () => {
    const harness = reanalysisHarness({ storedSegments: TIMED_NARRATION });

    await harness.service.previewAnalysis('media-1', ORGANIZATION_ID, '   ');

    expect(harness.prompt()).not.toContain('<house_rules>');
  });

  it('needs a stored narration, rather than transcribing again', async () => {
    const harness = reanalysisHarness();

    await expect(
      harness.service.previewAnalysis('media-1', ORGANIZATION_ID, 'Scuffs are normal wear.'),
    ).rejects.toMatchObject({ code: 'NO_STORED_NARRATION' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

/**
 * What a retry costs (2026-11-04, after October's Mapbox bill: count the paid
 * calls per action and per repeat).
 *
 * A run of transcription and analysis is tried again by the five-minute retry
 * (up to three runs), by the technician's Retry button (each press) and by
 * every restart that finds it unfinished. Each used to transcribe the whole
 * recording again, a new bill from Deepgram or OpenAI for the same words. The
 * narration is paid for once now; only the step that failed runs again.
 */
describe('a retry pays for the narration once', () => {
  const NARRATION = 'There is a scuff mark on the wall near the window.';

  /** A recording whose analysis keeps failing, with a database that remembers. */
  function pipeline({
    analysisFails = true,
    transcription = { text: NARRATION },
  }: {
    analysisFails?: boolean;
    /** What the transcription endpoint answers. */
    transcription?: unknown;
  } = {}) {
    let job: { status: string; segments: { startSeconds: number; endSeconds: number; text: string }[] } | null =
      null;
    let written: { startSeconds: number; endSeconds: number; text: string }[] = [];
    const prisma = {
      inspectionMedia: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'media-1',
          inspectionId: 'inspection-1',
          providerMediaId: 'local-key',
          storageKey: 'inspection-media/org-1/media-1.mp4',
          streamUid: null,
          mimeType: 'video/mp4',
          durationSeconds: 90,
          processingStatus: 'FAILED',
          inspectionArea: {
            propertyArea: { id: 'property-area-1', name: 'Living Room', floor: null, baselineConditions: [] },
            inspection: { inspectionType: 'MOVE_IN' },
          },
        }),
        findUnique: jest.fn().mockResolvedValue({ inspectionAreaId: 'inspection-area-1' }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      inspectionAreaChecklistResponse: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptionJob: {
        findUnique: jest.fn(async () => job),
        upsert: jest.fn().mockResolvedValue({ id: 'transcription-1' }),
        update: jest.fn(async ({ data }: { data: { status: string } }) => {
          if (data.status === 'COMPLETED') job = { status: 'COMPLETED', segments: written };
          return {};
        }),
      },
      transcriptSegment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn(async ({ data }: { data: typeof written }) => {
          written = data.map(({ startSeconds, endSeconds, text }) => ({ startSeconds, endSeconds, text }));
          return { count: data.length };
        }),
      },
      aiAnalysisJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      inspectionFinding: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mediaProcessingEvent: { create: jest.fn().mockResolvedValue({}) },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({ status: 'PROCESSING' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    };
    const aiSettings = {
      resolve: jest.fn(async (_org: string, provider?: AiProvider) => ({
        provider: provider ?? AiProvider.OPENAI,
        modelId: 'gpt-5.6-terra',
        apiKey: 'test-key',
      })),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    const fetch = jest.fn(async (url: string) => {
      if (String(url).includes('/audio/transcriptions'))
        return { ok: true, status: 200, json: async () => transcription };
      if (analysisFails) return { ok: false, status: 500, json: async () => ({ error: { message: 'unavailable' } }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify([FINDING]) }] }],
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        }),
      };
    });
    global.fetch = fetch as unknown as typeof global.fetch;
    const service = new MediaProcessingService(
      prisma as never,
      { get: jest.fn().mockResolvedValue(Buffer.from([0, 0, 0, 0])) } as never,
      aiSettings as never,
    );
    const transcriptions = () => fetch.mock.calls.filter(([url]) => String(url).includes('/audio/transcriptions')).length;
    const analyses = () => fetch.mock.calls.filter(([url]) => String(url).includes('/v1/responses')).length;
    return {
      service,
      prisma,
      transcriptions,
      analyses,
      setJob: (next: typeof job) => (job = next),
      stored: () => written,
    };
  }

  it('transcribes once however often a failing analysis is tried again', async () => {
    const harness = pipeline();

    // The first run, two five-minute retries, five presses of Retry and two
    // restarts: ten runs of one recording whose analysis never succeeds.
    for (let run = 0; run < 10; run += 1) await harness.service.process('media-1', ORGANIZATION_ID);

    expect(harness.transcriptions()).toBe(1);
    // The step that failed is the one tried again.
    expect(harness.analyses()).toBe(10);
    const statuses = harness.prisma.inspectionMedia.update.mock.calls.map((call) => call[0].data.processingStatus);
    expect(statuses.filter((status) => status === 'FAILED')).toHaveLength(10);
  });

  it('says the narration was reused, and finishes the recording with it', async () => {
    const harness = pipeline({ analysisFails: false });
    harness.setJob({ status: 'COMPLETED', segments: [{ startSeconds: 4, endSeconds: 9, text: NARRATION }] });

    await harness.service.process('media-1', ORGANIZATION_ID);

    expect(harness.transcriptions()).toBe(0);
    expect(harness.prisma.transcriptionJob.upsert).not.toHaveBeenCalled();
    expect(harness.prisma.inspectionFinding.createMany).toHaveBeenCalledTimes(1);
    const completed = harness.prisma.mediaProcessingEvent.create.mock.calls.find(
      (call) => call[0].data.eventType === 'TRANSCRIPTION_COMPLETED',
    )?.[0].data.payloadSummary;
    expect(completed).toEqual({ characters: NARRATION.length, reused: true });
  });

  /** Nobody spoke: that is the answer, and a second transcription would say it again. */
  it('reuses a recording nobody spoke in, rather than transcribing silence twice', async () => {
    const harness = pipeline({ analysisFails: false });
    harness.setJob({ status: 'COMPLETED', segments: [] });

    await harness.service.process('media-1', ORGANIZATION_ID);

    expect(harness.transcriptions()).toBe(0);
  });

  it('transcribes again when the last transcription did not finish', async () => {
    const harness = pipeline({ analysisFails: false });
    harness.setJob({ status: 'RUNNING', segments: [] });

    await harness.service.process('media-1', ORGANIZATION_ID);

    expect(harness.transcriptions()).toBe(1);
  });

  /**
   * A hallway at a move-out, 2026-11-12: nobody spoke, and whisper wrote video
   * credits, "Rest in peace" and a sentence about a time of death over it.
   */
  it('keeps what whisper wrote over silence out of the narration', async () => {
    const harness = pipeline({
      analysisFails: false,
      transcription: {
        text: 'Special thanks to the cast and crew. Thanks for watching. Rest in peace. The time was approximately 19.',
        segments: [
          { start: 0, end: 10, text: ' Special thanks to the cast and crew.', no_speech_prob: 0.82 },
          { start: 10, end: 14, text: ' Thanks for watching.', no_speech_prob: 0.82 },
          { start: 14, end: 16, text: ' Rest in peace.', no_speech_prob: 0.82 },
          { start: 16, end: 27, text: ' The time was approximately 19.', no_speech_prob: 0.82 },
        ],
      },
    });

    await harness.service.process('media-1', ORGANIZATION_ID);

    expect(harness.stored()).toEqual([]);
    // Nothing was said, so the room is summarized without asking the model.
    expect(harness.analyses()).toBe(0);
  });

  it('drops a stock ending the model was sure of, and keeps the narration around it', async () => {
    const harness = pipeline({
      analysisFails: false,
      transcription: {
        text: `${NARRATION} Thank you for watching.`,
        segments: [
          { start: 2, end: 8, text: ` ${NARRATION}`, no_speech_prob: 0.02 },
          // Confident, over speech-free tail: the silence estimate alone misses it.
          { start: 80, end: 82, text: ' Thank you for watching.', no_speech_prob: 0.3 },
        ],
      },
    });

    await harness.service.process('media-1', ORGANIZATION_ID);

    expect(harness.stored()).toEqual([{ startSeconds: 2, endSeconds: 8, text: NARRATION }]);
    expect(harness.analyses()).toBe(1);
  });

  it('takes a stock ending out of a transcript that came back without lines', async () => {
    // gpt-4o-mini-transcribe, when whisper-1 is refused: text alone.
    const harness = pipeline({
      analysisFails: false,
      transcription: { text: `${NARRATION} Thanks for watching!` },
    });

    await harness.service.process('media-1', ORGANIZATION_ID);

    expect(harness.stored().map((line) => line.text)).toEqual([NARRATION]);
  });
});

/**
 * Picking up after a restart. Every release restarts the backend; this used to
 * queue any 25 unfinished recordings each time, with no count of how often each
 * had already been tried.
 */
describe('recovering what a restart left unfinished', () => {
  const stuck = (index: number, started: number) => ({
    id: `media-${index}`,
    organizationId: ORGANIZATION_ID,
    _count: { processingEvents: started },
  });

  function recovery(rows: unknown[] | Error) {
    const prisma = {
      inspectionMedia: {
        findMany: rows instanceof Error ? jest.fn().mockRejectedValue(rows) : jest.fn().mockResolvedValue(rows),
      },
    };
    const service = new MediaProcessingService(prisma as never, {} as never, {} as never);
    const queue = jest.spyOn(service, 'queue').mockImplementation(() => undefined);
    return { service, prisma, queue };
  }

  it('queues only recordings with runs left, and no more than 25 a restart', async () => {
    // Sixty unfinished: twenty already started three times, forty with runs left.
    const rows = [
      ...Array.from({ length: 20 }, (_, index) => stuck(index, 3)),
      ...Array.from({ length: 40 }, (_, index) => stuck(100 + index, index % 3)),
    ];
    const { service, queue } = recovery(rows);

    await expect(service.recoverInterrupted()).resolves.toEqual({ checked: 60, queued: 25, exhausted: 20 });

    expect(queue).toHaveBeenCalledTimes(25);
    expect(queue.mock.calls.every(([id]) => Number(String(id).split('-')[1]) >= 100)).toBe(true);
  });

  it('never queues a recording that has used its three runs, however many restarts there are', async () => {
    const { service, queue } = recovery([stuck(1, 3), stuck(2, 7)]);

    // A day of crash-restarts.
    for (let restart = 0; restart < 50; restart += 1) await service.recoverInterrupted();

    expect(queue).not.toHaveBeenCalled();
  });

  it('asks only for recordings with something to read, newest first, counting their runs', async () => {
    const { service, prisma } = recovery([]);

    await service.recoverInterrupted();

    expect(prisma.inspectionMedia.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        processingStatus: { in: ['PENDING', 'PROCESSING'] },
        // A Cloudflare upload still encoding is the webhook's to start.
        OR: [{ streamUid: null }, { readyAt: { not: null } }],
      },
      orderBy: { updatedAt: 'desc' },
      select: { _count: { select: { processingEvents: { where: { eventType: 'PROCESSING_STARTED' } } } } },
    });
  });

  it('survives the database being unreachable', async () => {
    const { service, queue } = recovery(new Error('database unreachable'));

    await expect(service.recoverInterrupted()).resolves.toEqual({ checked: 0, queued: 0, exhausted: 0 });
    expect(queue).not.toHaveBeenCalled();
  });
});
