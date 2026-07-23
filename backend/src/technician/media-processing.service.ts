import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AiAnalysisStatus,
  AiProvider,
  FindingReviewStatus,
  InspectionStatus,
  MediaProcessingStatus,
  TranscriptionStatus,
} from '@prisma/client';
import { z } from 'zod';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { InspectionMediaStorageService } from './inspection-media-storage.service';

const PROMPT_VERSION = '2';
const SCHEMA_VERSION = '1';
const MAX_DIRECT_TRANSCRIPTION_BYTES = 24_000_000; // OpenAI hard limit is 25 MB.

/**
 * Marker for the informational per-room AI summary. Summaries are context for
 * reviewers, not chargeable findings: queries exclude them from the review
 * queue and from every pending-review count/gate.
 */
export const ROOM_SUMMARY_TITLE = 'Room condition summary';

/** Prisma where-fragment matching summary rows. */
export const ROOM_SUMMARY_WHERE = { findingType: 'NO_CHANGE', title: ROOM_SUMMARY_TITLE } as const;

// Biases the speech model toward inspection vocabulary; helps with accented
// and non-native English narration. Language itself is auto-detected.
const TRANSCRIPTION_DOMAIN_HINT =
  'Property inspection walkthrough narrated by a field technician, possibly with a strong accent ' +
  'or in a language other than English. Typical terms: room names, walls, flooring, ceiling, ' +
  'plumbing, appliances, fixtures, damage, scratches, stains, leaks, mold, working condition.';

const findingItemSchema = z.object({
  findingType: z.enum(['POSSIBLE_NEW_DAMAGE', 'EXISTING_CONDITION', 'MAINTENANCE', 'NO_CHANGE']),
  category: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(2000),
  baselineCondition: z.string().max(1000).catch(''),
  comparisonResult: z.enum([
    'EXISTING_CONDITION',
    'POSSIBLE_NEW_DAMAGE',
    'NO_MATERIAL_CHANGE',
    'NORMAL_WEAR',
    'OWNER_MAINTENANCE',
    'MISSING_EVIDENCE',
    'INSUFFICIENT_DATA',
  ]),
  videoTimestampStart: z.number().int().nonnegative().catch(0),
  videoTimestampEnd: z.number().int().nonnegative().catch(0),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  possibleResponsibility: z.enum([
    'TENANT_REVIEW_REQUIRED',
    'OWNER_REVIEW_REQUIRED',
    'UNDETERMINED',
  ]),
  confidence: z.number().min(0).max(1),
  recommendedReview: z.string().min(1).max(500),
});
export const analysisResponseSchema = z.array(findingItemSchema).max(25);

const openAiTextSchema = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});
const anthropicTextSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export function extractJsonArray(text: string) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  return start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
}

/**
 * The real (database-backed) processing pipeline for uploaded room videos:
 * transcription via OpenAI audio models, findings analysis via the
 * organization's active AI provider, and lifecycle bookkeeping. Findings are
 * always created PENDING_REVIEW — humans approve or reject them.
 */
@Injectable()
export class MediaProcessingService implements OnModuleInit {
  private readonly logger = new Logger(MediaProcessingService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InspectionMediaStorageService)
    private readonly storage: InspectionMediaStorageService,
    @Inject(AiProviderSettingsService) private readonly aiSettings: AiProviderSettingsService,
  ) {}

  /** Recover recordings that were uploaded before this pipeline existed or
   *  whose processing died with the server (stuck PENDING/PROCESSING). */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    setImmediate(() => {
      void this.prisma.inspectionMedia
        .findMany({
          where: {
            processingStatus: {
              in: [MediaProcessingStatus.PENDING, MediaProcessingStatus.PROCESSING],
            },
          },
          select: { id: true, organizationId: true },
          take: 25,
        })
        .then((stuck) => {
          if (!stuck.length) return;
          this.logger.log(`Recovering ${stuck.length} unprocessed recording(s).`);
          for (const media of stuck) this.queue(media.id, media.organizationId);
        })
        .catch((error) => {
          this.logger.warn(`Startup recovery scan failed: ${String(error)}`);
        });
    });
  }

  /** Fire-and-forget: uploads must not wait for transcription and analysis. */
  queue(mediaId: string, organizationId: string) {
    setImmediate(() => {
      void this.process(mediaId, organizationId).catch((error) => {
        this.logger.error(
          `Unhandled processing failure for media ${mediaId}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    });
  }

  async process(mediaId: string, organizationId: string) {
    if (this.inFlight.has(mediaId)) return;
    this.inFlight.add(mediaId);
    try {
      const media = await this.prisma.inspectionMedia.findFirst({
        where: { id: mediaId, organizationId },
        select: {
          id: true,
          inspectionId: true,
          providerMediaId: true,
          mimeType: true,
          durationSeconds: true,
          processingStatus: true,
          inspectionArea: {
            select: {
              propertyArea: {
                select: {
                  id: true,
                  name: true,
                  floor: { select: { name: true } },
                  baselineConditions: {
                    orderBy: { baselineInspection: { inspectedAt: 'desc' } },
                    take: 1,
                    select: { conditionSummary: true, knownDefects: true },
                  },
                },
              },
              inspection: { select: { inspectionType: true, baselineInspectionId: true } },
            },
          },
        },
      });
      if (!media || media.processingStatus === MediaProcessingStatus.READY) return;

      await this.prisma.inspectionMedia.update({
        where: { id: media.id },
        data: { processingStatus: MediaProcessingStatus.PROCESSING },
      });
      await this.event(media.id, 'PROCESSING_STARTED', {});

      try {
        const transcript = await this.transcribe(media, organizationId);
        // Full transcripts belong in the protected transcription tables, not
        // operational event payloads or logs.
        await this.event(media.id, 'TRANSCRIPTION_COMPLETED', { characters: transcript.length });

        const findingCount = await this.analyze(media, transcript, organizationId);
        await this.event(media.id, 'ANALYSIS_COMPLETED', { findingCount });

        await this.prisma.inspectionMedia.update({
          where: { id: media.id },
          data: { processingStatus: MediaProcessingStatus.READY },
        });
        await this.advanceInspection(media.inspectionId);
      } catch (error) {
        const message =
          error instanceof ApplicationError
            ? error.message
            : 'Processing failed unexpectedly. Retry from the uploads screen.';
        this.logger.error(
          `Processing failed for media ${media.id}`,
          error instanceof Error ? error.stack : String(error),
        );
        await this.prisma.inspectionMedia.update({
          where: { id: media.id },
          data: { processingStatus: MediaProcessingStatus.FAILED },
        });
        await this.event(media.id, 'PROCESSING_FAILED', { message });
      }
    } finally {
      this.inFlight.delete(mediaId);
    }
  }

  /** Re-queue a failed or stalled recording owned by this technician. */
  async reprocess(organizationId: string, technicianId: string, mediaId: string) {
    const media = await this.prisma.inspectionMedia.findFirst({
      where: { id: mediaId, organizationId, technicianId },
      select: { id: true, processingStatus: true },
    });
    if (!media)
      throw new ApplicationError(404, 'INSPECTION_MEDIA_NOT_FOUND', 'Room video not found.');
    if (media.processingStatus === MediaProcessingStatus.READY)
      return { queued: false, processingStatus: media.processingStatus };
    if (media.processingStatus === MediaProcessingStatus.PROCESSING && this.inFlight.has(mediaId))
      return { queued: false, processingStatus: media.processingStatus };
    this.queue(mediaId, organizationId);
    return { queued: true, processingStatus: MediaProcessingStatus.PROCESSING };
  }

  private async transcribe(
    media: {
      id: string;
      providerMediaId: string;
      mimeType: string;
      durationSeconds: number;
    },
    organizationId: string,
  ) {
    const configuration = await this.aiSettings
      .resolve(organizationId, AiProvider.OPENAI)
      .catch(() => null);
    if (!configuration)
      throw new ApplicationError(
        503,
        'TRANSCRIPTION_NOT_CONFIGURED',
        'Video transcription requires a configured OpenAI API key in Settings → AI operations.',
      );
    const job = await this.prisma.transcriptionJob.upsert({
      where: { inspectionMediaId: media.id },
      create: {
        inspectionMediaId: media.id,
        status: TranscriptionStatus.RUNNING,
        provider: 'openai',
      },
      update: { status: TranscriptionStatus.RUNNING, provider: 'openai' },
    });
    try {
      const video = await this.storage.get(media.providerMediaId);
      const audio = await this.extractAudio(video, media.mimeType);
      const transcript = await this.requestTranscription(configuration.apiKey, audio);
      await this.prisma.$transaction([
        this.prisma.transcriptSegment.deleteMany({
          where: { transcriptionJobId: job.id },
        }),
        this.prisma.transcriptSegment.create({
          data: {
            transcriptionJobId: job.id,
            startSeconds: 0,
            endSeconds: media.durationSeconds,
            text: transcript,
          },
        }),
      ]);
      await this.prisma.transcriptionJob.update({
        where: { inspectionMediaId: media.id },
        // Language is auto-detected by the provider and not reliably reported;
        // never hardcode English — narrations may be in any language.
        data: { status: TranscriptionStatus.COMPLETED, language: null },
      });
      await this.aiSettings.recordUsage(
        organizationId,
        { provider: AiProvider.OPENAI, modelId: 'audio-transcription' },
        'VIDEO_TRANSCRIPTION',
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        media.id,
      );
      return transcript;
    } catch (error) {
      await this.prisma.transcriptionJob.update({
        where: { inspectionMediaId: media.id },
        data: { status: TranscriptionStatus.FAILED },
      });
      throw error;
    }
  }

  /**
   * OpenAI's transcription endpoints cap uploads at 25 MB; a room video is
   * usually far larger, but its mono audio track is tiny. Extract it with
   * ffmpeg, falling back to the raw video only when it is small enough.
   */
  private async extractAudio(video: Buffer, mimeType: string) {
    const directory = await mkdtemp(join(tmpdir(), 'txr-media-'));
    const input = join(directory, mimeType === 'video/quicktime' ? 'input.mov' : 'input.mp4');
    const output = join(directory, 'audio.m4a');
    try {
      await writeFile(input, video);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpegPath = require('ffmpeg-static') as string | null;
      if (ffmpegPath) {
        const succeeded = await new Promise<boolean>((resolvePromise) => {
          const child = spawn(ffmpegPath, [
            '-y',
            '-i',
            input,
            '-vn',
            '-ac',
            '1',
            '-b:a',
            '48k',
            output,
          ]);
          child.on('error', () => resolvePromise(false));
          child.on('exit', (code) => resolvePromise(code === 0));
        });
        if (succeeded)
          return { bytes: await readFile(output), name: 'audio.m4a', type: 'audio/mp4' };
        this.logger.warn('ffmpeg audio extraction failed; falling back to raw video upload');
      }
      if (video.byteLength > MAX_DIRECT_TRANSCRIPTION_BYTES)
        throw new ApplicationError(
          422,
          'TRANSCRIPTION_SOURCE_TOO_LARGE',
          'The recording is too large to transcribe directly and audio extraction failed.',
        );
      return {
        bytes: video,
        name: mimeType === 'video/quicktime' ? 'video.mov' : 'video.mp4',
        type: mimeType,
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async requestTranscription(
    apiKey: string,
    audio: { bytes: Buffer; name: string; type: string },
  ) {
    const models = ['gpt-4o-mini-transcribe', 'whisper-1'];
    let lastError: ApplicationError | null = null;
    for (const model of models) {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(audio.bytes)], { type: audio.type }),
        audio.name,
      );
      form.append('model', model);
      form.append('response_format', 'json');
      // No language parameter: let the model auto-detect (multilingual crews).
      form.append('prompt', TRANSCRIPTION_DOMAIN_HINT);
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const parsed = z.object({ text: z.string() }).safeParse(payload);
        if (!parsed.success)
          throw new ApplicationError(
            502,
            'TRANSCRIPTION_FAILED',
            'The transcription provider returned an unreadable response.',
          );
        return parsed.data.text;
      }
      const message =
        (payload as { error?: { message?: string } } | null)?.error?.message ?? 'unknown error';
      this.logger.warn(`Transcription with ${model} failed (HTTP ${response.status}): ${message}`);
      lastError = new ApplicationError(
        response.status === 401 || response.status === 403 ? 503 : 502,
        'TRANSCRIPTION_FAILED',
        response.status === 401 || response.status === 403
          ? 'The OpenAI credential was rejected during transcription. Verify it in Settings.'
          : 'The recording could not be transcribed. Retry from the uploads screen.',
      );
      // Only fall through to the next model when the model itself was refused.
      if (response.status !== 400 && response.status !== 404) break;
    }
    throw lastError ?? new ApplicationError(502, 'TRANSCRIPTION_FAILED', 'Transcription failed.');
  }

  private async analyze(
    media: {
      id: string;
      inspectionId: string;
      durationSeconds: number;
      inspectionArea: {
        propertyArea: {
          id: string;
          name: string;
          floor: { name: string } | null;
          baselineConditions: Array<{ conditionSummary: string; knownDefects: unknown }>;
        };
        inspection: { inspectionType: string; baselineInspectionId?: string | null };
      };
    },
    transcript: string,
    organizationId: string,
  ) {
    const configuration = await this.aiSettings.resolve(organizationId);
    const job = await this.prisma.aiAnalysisJob.create({
      data: {
        inspectionMediaId: media.id,
        status: AiAnalysisStatus.RUNNING,
        provider: configuration.provider.toLowerCase(),
        modelId: configuration.modelId,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
      },
    });
    try {
      let items: z.infer<typeof analysisResponseSchema>;
      let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      if (transcript.trim().length < 5) {
        // Nothing was said — record that as the summary without an AI call.
        items = [this.noNotableConditionSummary(media.inspectionArea.propertyArea.name)];
      } else {
        const baselineContext = await this.baselineContext(media);
        const prompt = this.analysisPrompt(media, transcript, baselineContext);
        const result =
          configuration.provider === AiProvider.ANTHROPIC
            ? await this.anthropicText(configuration.apiKey, configuration.modelId, prompt)
            : await this.openAiText(configuration.apiKey, configuration.modelId, prompt);
        usage = result.usage;
        const parsed = analysisResponseSchema.safeParse(JSON.parse(extractJsonArray(result.text)));
        if (!parsed.success)
          throw new ApplicationError(
            422,
            'INVALID_AI_FINDINGS',
            'The AI findings did not pass validation and were discarded.',
          );
        items = this.ensureSummaryFirst(
          parsed.data,
          media.inspectionArea.propertyArea.name,
        );
      }
      // Reprocessing replaces this recording's unreviewed suggestions instead
      // of stacking duplicates; human-reviewed findings are never touched.
      await this.prisma.inspectionFinding.deleteMany({
        where: { inspectionMediaId: media.id, reviewStatus: FindingReviewStatus.PENDING_REVIEW },
      });
      if (items.length)
        await this.prisma.inspectionFinding.createMany({
          data: items.map((finding) => ({
            inspectionId: media.inspectionId,
            propertyAreaId: media.inspectionArea.propertyArea.id,
            inspectionMediaId: media.id,
            aiAnalysisJobId: job.id,
            findingType: finding.findingType,
            category: finding.category,
            title: finding.title,
            description: finding.description,
            baselineCondition: finding.baselineCondition,
            comparisonResult: finding.comparisonResult,
            videoTimestampStart: Math.min(finding.videoTimestampStart, media.durationSeconds),
            videoTimestampEnd: Math.min(
              Math.max(finding.videoTimestampEnd, finding.videoTimestampStart),
              media.durationSeconds,
            ),
            severity: finding.severity,
            possibleResponsibility: finding.possibleResponsibility,
            confidence: finding.confidence,
            recommendedReview: finding.recommendedReview,
            // Human review is mandatory: AI output is never auto-approved.
            reviewStatus: FindingReviewStatus.PENDING_REVIEW,
          })),
        });
      await this.prisma.aiAnalysisJob.update({
        where: { id: job.id },
        data: { status: AiAnalysisStatus.COMPLETED },
      });
      await this.aiSettings.recordUsage(
        organizationId,
        configuration,
        'FINDING_ANALYSIS',
        usage,
        media.id,
      );
      return items.length;
    } catch (error) {
      await this.prisma.aiAnalysisJob
        .update({ where: { id: job.id }, data: { status: AiAnalysisStatus.FAILED } })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Baseline for comparisons comes from the linked move-in inspection (its
   * room summary + human-approved findings for the same area). The legacy
   * building-level baseline tables are the fallback.
   */
  private async baselineContext(media: {
    inspectionArea: {
      propertyArea: {
        id: string;
        baselineConditions: Array<{ conditionSummary: string; knownDefects: unknown }>;
      };
      inspection: { baselineInspectionId?: string | null };
    };
  }) {
    const baselineInspectionId = media.inspectionArea.inspection.baselineInspectionId;
    if (baselineInspectionId) {
      const rows = await this.prisma.inspectionFinding.findMany({
        where: {
          inspectionId: baselineInspectionId,
          propertyAreaId: media.inspectionArea.propertyArea.id,
          OR: [{ ...ROOM_SUMMARY_WHERE }, { reviewStatus: FindingReviewStatus.APPROVED }],
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { title: true, description: true, findingType: true },
      });
      if (rows.length)
        return rows
          .map((row) => `- [${row.findingType}] ${row.title}: ${row.description}`)
          .join('\n');
    }
    const legacy = media.inspectionArea.propertyArea.baselineConditions[0];
    return legacy
      ? `- ${legacy.conditionSummary} Known defects: ${JSON.stringify(legacy.knownDefects)}`
      : null;
  }

  private analysisPrompt(
    media: {
      durationSeconds: number;
      inspectionArea: {
        propertyArea: {
          name: string;
          floor: { name: string } | null;
          baselineConditions: Array<{ conditionSummary: string; knownDefects: unknown }>;
        };
        inspection: { inspectionType: string; baselineInspectionId?: string | null };
      };
    },
    transcript: string,
    baselineContext: string | null,
  ) {
    const area = media.inspectionArea.propertyArea;
    const isMoveIn = media.inspectionArea.inspection.inspectionType === 'MOVE_IN';
    return [
      'You review property-inspection narrations for TexasRenters.',
      `Room: ${area.name}${area.floor ? ` (${area.floor.name})` : ''}.`,
      `Inspection type: ${media.inspectionArea.inspection.inspectionType}.`,
      `Video duration: ${media.durationSeconds} seconds.`,
      isMoveIn
        ? 'This is a MOVE-IN inspection: what you extract becomes the baseline every future inspection of this room is compared against. Document the observed condition thoroughly.'
        : baselineContext
          ? `Move-in baseline for this room:\n${baselineContext}`
          : 'No move-in baseline is documented for this room.',
      'Technician narration transcript follows between <transcript> tags.',
      'The narration may be in any language, mixed languages, or heavily accented English —',
      'interpret it faithfully and write every output field in clear English.',
      `<transcript>${transcript}</transcript>`,
      'Return a JSON array only (no prose).',
      `The FIRST item must always be a room summary: findingType NO_CHANGE, category "Room condition", title "${ROOM_SUMMARY_TITLE}",`,
      'description = a 2-4 sentence English summary of the narrated room condition,',
      'comparisonResult NO_MATERIAL_CHANGE (or INSUFFICIENT_DATA when the narration is unclear), severity LOW, possibleResponsibility UNDETERMINED.',
      'After the summary, add one item per damage or maintenance issue the narration supports — none if none were narrated.',
      'Each item: findingType (POSSIBLE_NEW_DAMAGE|EXISTING_CONDITION|MAINTENANCE|NO_CHANGE),',
      'category (short noun, e.g. Walls, Plumbing), title, description,',
      'baselineCondition (what the baseline says about this item, or empty string),',
      'comparisonResult (EXISTING_CONDITION|POSSIBLE_NEW_DAMAGE|NO_MATERIAL_CHANGE|NORMAL_WEAR|OWNER_MAINTENANCE|MISSING_EVIDENCE|INSUFFICIENT_DATA),',
      'videoTimestampStart and videoTimestampEnd (integer seconds within the duration; use 0 when unknown),',
      'severity (LOW|MEDIUM|HIGH), possibleResponsibility (TENANT_REVIEW_REQUIRED|OWNER_REVIEW_REQUIRED|UNDETERMINED),',
      'confidence (0-1), recommendedReview (one actionable sentence for the human reviewer).',
      'Findings are suggestions for human review; never state conclusions about charges or fault.',
    ].join('\n');
  }

  /** Guarantees exactly one summary row, always first. */
  private ensureSummaryFirst(
    items: z.infer<typeof analysisResponseSchema>,
    roomName: string,
  ): z.infer<typeof analysisResponseSchema> {
    const isSummary = (item: z.infer<typeof findingItemSchema>) =>
      item.findingType === 'NO_CHANGE' && item.title.trim().toLowerCase() === ROOM_SUMMARY_TITLE.toLowerCase();
    const summaries = items.filter(isSummary).map((item) => ({ ...item, title: ROOM_SUMMARY_TITLE }));
    const defects = items.filter((item) => !isSummary(item));
    return [summaries[0] ?? this.noNotableConditionSummary(roomName), ...defects];
  }

  private async anthropicText(apiKey: string, modelId: string, prompt: string) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 4_000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw this.analysisProviderError(response.status, payload);
    const parsed = anthropicTextSchema.parse(payload);
    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    return {
      text: parsed.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text || '')
        .join('\n'),
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }

  private async openAiText(apiKey: string, modelId: string, prompt: string) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        max_output_tokens: 8_000,
        reasoning: { effort: 'low' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw this.analysisProviderError(response.status, payload);
    const parsed = openAiTextSchema.parse(payload);
    return {
      text: parsed.output
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text || '')
        .join('\n'),
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        totalTokens: parsed.usage?.total_tokens ?? 0,
      },
    };
  }

  private analysisProviderError(status: number, payload: unknown) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ?? 'unknown error';
    this.logger.warn(`Finding analysis rejected (HTTP ${status}): ${message}`);
    if ((status === 400 || status === 402) && /credit|billing|balance|quota/i.test(message))
      return new ApplicationError(
        402,
        'AI_CREDITS_REQUIRED',
        'The AI provider account has no remaining credits. Add credits or switch providers in Settings.',
      );
    if (status === 401 || status === 403)
      return new ApplicationError(
        503,
        'AI_AUTHENTICATION_FAILED',
        'The AI credential was rejected. Verify the provider configuration in Settings.',
      );
    return new ApplicationError(
      502,
      'AI_ANALYSIS_FAILED',
      'The AI analysis provider rejected this request. Retry from the uploads screen.',
    );
  }

  private noNotableConditionSummary(roomName: string): z.infer<typeof findingItemSchema> {
    return {
      findingType: 'NO_CHANGE',
      category: 'Room condition',
      title: ROOM_SUMMARY_TITLE,
      description: `No specific damage or maintenance concern was identified in the ${roomName} narration.`,
      baselineCondition: '',
      comparisonResult: 'INSUFFICIENT_DATA',
      videoTimestampStart: 0,
      videoTimestampEnd: 0,
      severity: 'LOW',
      possibleResponsibility: 'UNDETERMINED',
      confidence: 0.5,
      recommendedReview: 'Review the room video and transcript to confirm the recorded condition.',
    };
  }

  /** Move a fully processed inspection from PROCESSING to REVIEW_REQUIRED. */
  async advanceInspection(inspectionId: string) {
    const [inspection, unfinished] = await Promise.all([
      this.prisma.inspection.findUnique({
        where: { id: inspectionId },
        select: { status: true },
      }),
      this.prisma.inspectionMedia.count({
        where: {
          inspectionId,
          processingStatus: {
            in: [MediaProcessingStatus.PENDING, MediaProcessingStatus.PROCESSING],
          },
        },
      }),
    ]);
    if (inspection?.status === InspectionStatus.PROCESSING && unfinished === 0)
      await this.prisma.inspection.update({
        where: { id: inspectionId },
        data: { status: InspectionStatus.REVIEW_REQUIRED },
      });
  }

  private event(inspectionMediaId: string, eventType: string, payloadSummary: object) {
    return this.prisma.mediaProcessingEvent
      .create({ data: { inspectionMediaId, eventType, payloadSummary } })
      .catch(() => undefined);
  }
}
