import { AiProvider } from '@prisma/client';

import {
  MediaProcessingService,
  analysisResponseSchema,
  extractJsonArray,
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

  it('transcribes, analyzes, stores PENDING_REVIEW findings, and advances the inspection', async () => {
    const media = {
      id: 'media-1',
      inspectionId: 'inspection-1',
      providerMediaId: 'local-key',
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
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      transcriptionJob: {
        upsert: jest.fn().mockResolvedValue({ id: 'transcription-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      transcriptSegment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
      },
      aiAnalysisJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      inspectionFinding: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mediaProcessingEvent: { create: jest.fn().mockResolvedValue({}) },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({ status: 'PROCESSING' }),
        update: jest.fn().mockResolvedValue({}),
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
    expect(prisma.transcriptSegment.create).toHaveBeenCalledWith({
      data: {
        transcriptionJobId: 'transcription-1',
        startSeconds: 0,
        endSeconds: 90,
        text: 'There is a scuff mark on the wall near the window.',
      },
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
    // Inspection was PROCESSING with no unfinished media → moves to review.
    expect(prisma.inspection.update).toHaveBeenCalledWith({
      where: { id: 'inspection-1' },
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
