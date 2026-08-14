import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import {
  AiAnalysisStatus,
  AiProvider,
  FindingReviewStatus,
  InspectionStatus,
  InspectionType,
  MediaProcessingStatus,
  PhotoCaptureType,
  TranscriptionStatus,
} from '@prisma/client';
import { z } from 'zod';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant, withTenant } from '../database/tenant-context';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { ComparisonService } from '../admin/comparison.service';
import { thumbnailKeyFor } from '../common/object-storage';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import {
  deepgramApiKey,
  requestDeepgramTranscription,
  requestDeepgramTranscriptionFromUrl,
} from './deepgram-transcription';
import { CloudflareStreamService } from '../media/cloudflare-stream.service';

const PROMPT_VERSION = '3';
const SCHEMA_VERSION = '1';
const MAX_DIRECT_TRANSCRIPTION_BYTES = 24_000_000; // OpenAI hard limit is 25 MB.

/** Hard ceiling on frames cut from one recording, whatever the client asked for. */
const MAX_EXTRACTED_FRAMES = 60;

/**
 * Reads technician frame markers back out of the stored capture summary.
 *
 * Bounded by the recording length: a marker past the end yields no frame, and
 * trusting a client-supplied offset unchecked would let one recording spawn
 * arbitrarily many ffmpeg passes.
 */
export function readFrameMarkers(captureSummary: unknown, durationSeconds: number): number[] {
  if (!captureSummary || typeof captureSummary !== 'object') return [];
  const raw = (captureSummary as { frameMarkersMs?: unknown }).frameMarkersMs;
  if (!Array.isArray(raw)) return [];
  const limitMs = Math.max(0, durationSeconds) * 1000;
  const valid = raw.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limitMs,
  );
  return [...new Set(valid.map((value) => Math.round(value)))]
    .sort((left, right) => left - right)
    .slice(0, MAX_EXTRACTED_FRAMES);
}

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
  'plumbing, appliances, fixtures, damage, scratches, stains, leaks, mold, working condition. ' +
  // "undamaged" and "damaged" are near-homophones in running speech and exact
  // opposites in the report. A real walkthrough came back with "clean and
  // damaged" where the technician had said "clean and undamaged", inverting
  // three findings. Listing both forms biases the recogniser toward hearing the
  // prefix; it does not guarantee it, which is why the checklist answers — not
  // this transcript — are what the analysis treats as authoritative.
  'Technicians grade each item as clean or dirty, undamaged or damaged, working or not working. ' +
  'The words "undamaged" and "not damaged" are common; do not transcribe them as "damaged".';

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
    @Optional() @Inject(ComparisonService) private readonly comparison?: ComparisonService,
    // Optional so the pipeline still constructs on a deployment with no
    // Cloudflare account, where every recording is bucket-backed anyway.
    @Optional() @Inject(CloudflareStreamService) private readonly stream?: CloudflareStreamService,
  ) {}

  /** Recover recordings that were uploaded before this pipeline existed or
   *  whose processing died with the server (stuck PENDING/PROCESSING). */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // Cross-organization by design: recordings interrupted by a restart belong
    // to whichever tenants happened to be mid-upload, and none of them is
    // "the" organization here.
    setImmediate(() => {
      void withSystemTenant(() =>
        this.prisma.inspectionMedia
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
            // Each queued item carries its own organization, so the work that
            // follows is scoped even though finding it was not.
            for (const media of stuck) this.queue(media.id, media.organizationId);
          })
          .catch((error) => {
            this.logger.warn(`Startup recovery scan failed: ${String(error)}`);
          }),
      );
    });
  }

  /** Fire-and-forget: uploads must not wait for transcription and analysis. */
  queue(mediaId: string, organizationId: string) {
    setImmediate(() => {
      // Runs after the response, so the request's tenant scope is long gone —
      // but the organization was passed in, so this re-establishes it rather
      // than falling back to system access.
      void withTenant(organizationId, () => this.process(mediaId, organizationId)).catch((error) => {
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
          storageKey: true,
          // Present only for a Cloudflare Stream recording, which has no bucket
          // object and is transcribed from a signed provider URL instead.
          streamUid: true,
          mimeType: true,
          durationSeconds: true,
          processingStatus: true,
          // Needed to cut technician-marked frames out of the video below.
          captureSummary: true,
          inspectionAreaId: true,
          technicianId: true,
          organizationId: true,
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

  /**
   * Transcribe a Cloudflare Stream recording without touching its bytes.
   *
   * Cloudflare renders a downloadable MP4 on request; that URL goes to Deepgram,
   * which fetches the media itself. A first request on a long walkthrough starts
   * the render and returns nothing, so this fails as retryable rather than
   * blocking a worker until it finishes — the normal processing retry brings it
   * back once the render is ready.
   *
   * Thumbnails and technician marker frames are not produced here: both are cut
   * from the video with ffmpeg, and doing that would mean downloading the whole
   * recording. Cloudflare supplies a thumbnail through the webhook; marker
   * frames are genuinely unavailable for Stream recordings for now.
   */
  private async transcribeStreamRecording(
    media: { id: string; streamUid: string | null; durationSeconds: number; organizationId: string },
    job: { id: string },
    deepgramKey: string,
  ) {
    if (!this.stream || !media.streamUid)
      throw new ApplicationError(
        503,
        'TRANSCRIPTION_SOURCE_UNAVAILABLE',
        'This recording has no Cloudflare video to transcribe.',
      );

    const mediaUrl = await this.stream.ensureDownloadUrl(media.streamUid);
    if (!mediaUrl)
      throw new ApplicationError(
        503,
        'TRANSCRIPTION_SOURCE_PREPARING',
        'Cloudflare is still preparing this recording for transcription.',
      );

    const result = await requestDeepgramTranscriptionFromUrl(
      deepgramKey,
      mediaUrl,
      media.durationSeconds,
    );
    const segments = result.segments ?? [
      { startSeconds: 0, endSeconds: media.durationSeconds, text: result.text },
    ];
    await this.prisma.$transaction([
      this.prisma.transcriptSegment.deleteMany({ where: { transcriptionJobId: job.id } }),
      this.prisma.transcriptSegment.createMany({
        data: segments.map((segment) => ({ transcriptionJobId: job.id, ...segment })),
      }),
    ]);
    await this.prisma.transcriptionJob.update({
      where: { inspectionMediaId: media.id },
      data: { status: TranscriptionStatus.COMPLETED, language: null },
    });
    return result.text;
  }

  /**
   * Transcribe a Cloudflare Stream recording with OpenAI.
   *
   * OpenAI's transcription endpoint takes bytes rather than a URL, so the
   * recording is fetched once from a signed Cloudflare download URL and its
   * audio extracted locally — the same ffmpeg step the R2 path uses. Only the
   * audio is sent onward, which is a fraction of the video's size.
   */
  private async transcribeStreamRecordingWithOpenAi(
    media: { id: string; streamUid: string | null; durationSeconds: number; mimeType: string },
    job: { id: string },
    apiKey: string,
  ) {
    if (!this.stream || !media.streamUid)
      throw new ApplicationError(
        503,
        'TRANSCRIPTION_SOURCE_UNAVAILABLE',
        'This recording has no Cloudflare video to transcribe.',
      );
    const mediaUrl = await this.stream.ensureDownloadUrl(media.streamUid);
    if (!mediaUrl)
      throw new ApplicationError(
        503,
        'TRANSCRIPTION_SOURCE_PREPARING',
        'Cloudflare is still preparing this recording for transcription.',
      );

    const response = await fetch(mediaUrl);
    if (!response.ok)
      throw new ApplicationError(
        502,
        'TRANSCRIPTION_SOURCE_UNREACHABLE',
        `Could not download the recording from Cloudflare (${response.status}).`,
      );
    const video = Buffer.from(await response.arrayBuffer());
    const audio = await this.extractAudio(video, media.mimeType);
    const { text: transcript, segments } = await this.requestTranscription(apiKey, audio);

    // Real timings when the model gave them; one whole-recording segment only as
    // the honest fallback, which is what this path always used to store.
    const rows = segments.length
      ? segments.map((segment) => ({
          transcriptionJobId: job.id,
          startSeconds: Math.max(0, Math.round(segment.start)),
          endSeconds: Math.min(media.durationSeconds, Math.round(segment.end)),
          text: segment.text.trim(),
        }))
      : [
          {
            transcriptionJobId: job.id,
            startSeconds: 0,
            endSeconds: media.durationSeconds,
            text: transcript,
          },
        ];
    await this.prisma.$transaction([
      this.prisma.transcriptSegment.deleteMany({ where: { transcriptionJobId: job.id } }),
      this.prisma.transcriptSegment.createMany({ data: rows }),
    ]);
    await this.prisma.transcriptionJob.update({
      where: { inspectionMediaId: media.id },
      data: { status: TranscriptionStatus.COMPLETED, language: null },
    });
    return transcript;
  }

  private async transcribe(
    media: {
      id: string;
      providerMediaId: string;
      // Exactly one of these is set. A bucket key means the recording is in R2
      // and its audio is extracted locally; a Stream uid means the bytes only
      // ever existed on the device and at Cloudflare, and the provider fetches
      // the media itself.
      storageKey: string | null;
      streamUid: string | null;
      mimeType: string;
      durationSeconds: number;
      organizationId: string;
      inspectionId: string;
      inspectionAreaId: string;
      technicianId: string;
      captureSummary: unknown;
    },
    organizationId: string,
  ) {
    // Deepgram when the backend has a key, OpenAI otherwise.
    //
    // Resolved before anything else because the two need different credentials:
    // requiring an OpenAI key here is what made a Deepgram-only deployment
    // refuse to transcribe at all, with a message naming a provider it was not
    // going to use.
    const deepgramKey = deepgramApiKey();
    const configuration = deepgramKey
      ? null
      : await this.aiSettings.resolve(organizationId, AiProvider.OPENAI).catch(() => null);
    if (!deepgramKey && !configuration)
      throw new ApplicationError(
        503,
        'TRANSCRIPTION_NOT_CONFIGURED',
        'Video transcription needs either DEEPGRAM_API_KEY on the backend or an OpenAI API key in Settings → AI operations.',
      );
    const provider = deepgramKey ? 'deepgram' : 'openai';
    const job = await this.prisma.transcriptionJob.upsert({
      where: { inspectionMediaId: media.id },
      create: {
        inspectionMediaId: media.id,
        status: TranscriptionStatus.RUNNING,
        provider,
      },
      update: { status: TranscriptionStatus.RUNNING, provider },
    });
    // A Cloudflare Stream recording has no bucket object. Deepgram fetches the
    // media itself from a signed Cloudflare URL, so the bytes still never pass
    // through this backend — downloading a walkthrough here purely to forward
    // it would reintroduce the transfer the Stream migration removed.
    //
    // This path requires Deepgram for that reason: OpenAI's transcription
    // endpoint takes bytes, not a URL, so using it would mean proxying the
    // video after all.
    if (!media.storageKey) {
      if (deepgramKey) return this.transcribeStreamRecording(media, job, deepgramKey);
      /**
       * No Deepgram key: fetch the recording once and transcribe it with OpenAI.
       *
       * This used to throw, on the grounds that pulling the video back through
       * the backend is what Stream removed. That reasoning does not survive
       * contact with the rest of this method — the R2 branch below downloads
       * the whole video and extracts audio locally, and has always done so. The
       * transfer Stream eliminated is the per-viewer one: a reviewer streaming
       * segments through this process. A single server-side read at analysis
       * time is a different thing, happens once per recording, and never
       * touches a client.
       *
       * The practical effect of refusing was that a deployment with a perfectly
       * good OpenAI key produced no transcript, no summary and no findings for
       * every recording, and reported it as though the AI had simply found
       * nothing.
       */
      return this.transcribeStreamRecordingWithOpenAi(media, job, configuration!.apiKey);
    }

    try {
      const storageKey = media.storageKey;
      const video = await this.storage.get(storageKey);
      // Generated here because the video bytes are already in memory for audio
      // extraction; fetching them again just for a poster frame would be wasteful.
      await this.generateThumbnail(video, media.mimeType, storageKey);
      // Same bytes, same trip: stills the technician marked while recording.
      await this.extractMarkerFrames(video, media);
      const audio = await this.extractAudio(video, media.mimeType);
      const result = deepgramKey
        ? await requestDeepgramTranscription(deepgramKey, audio, media.durationSeconds)
        : await (async () => {
            // OpenAI returns timings now too, via whisper-1 and verbose_json, so
            // this path is no longer the untimed one. `segments: null` here used
            // to force the whole-recording fallback below even when timings
            // existed, which is half of why findings were all stamped 0:00.
            const openAi = await this.requestTranscription(configuration!.apiKey, audio);
            return {
              text: openAi.text,
              segments: openAi.segments.length
                ? openAi.segments.map((segment) => ({
                    startSeconds: Math.max(0, Math.round(segment.start)),
                    endSeconds: Math.min(media.durationSeconds, Math.round(segment.end)),
                    text: segment.text.trim(),
                  }))
                : null,
              language: null,
            };
          })();
      const transcript = result.text;
      // Real per-utterance timings when the provider supplies them. The single
      // whole-recording segment below is the fallback, and it is why an AI
      // finding's timestamp used to be a guess — a reviewer seeking to it
      // landed at the start of the video every time.
      const segments = result.segments ?? [
        { startSeconds: 0, endSeconds: media.durationSeconds, text: transcript },
      ];
      await this.prisma.$transaction([
        this.prisma.transcriptSegment.deleteMany({
          where: { transcriptionJobId: job.id },
        }),
        this.prisma.transcriptSegment.createMany({
          data: segments.map((segment) => ({ transcriptionJobId: job.id, ...segment })),
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
  /**
   * Writes a poster frame beside the video so reviewers see a preview without
   * downloading it. Best-effort by design: a missing thumbnail degrades to a
   * blank poster, so no failure here may interrupt transcription or analysis.
   */
  /**
   * Cuts stills out of the video at the offsets the technician marked.
   *
   * Android cannot photograph while recording — expo-camera binds either the
   * image-capture or the video-capture use case, never both — so the shutter
   * records the moment instead of interrupting a walkthrough that is supposed
   * to be one continuous clockwise pass. The frames are recovered here.
   *
   * Best-effort in the same way the poster frame is: a marker that yields no
   * frame must never cost the technician their transcript or their findings.
   */
  private async extractMarkerFrames(
    video: Buffer,
    media: {
      id: string;
      providerMediaId: string;
      mimeType: string;
      durationSeconds: number;
      organizationId: string;
      inspectionId: string;
      inspectionAreaId: string;
      technicianId: string;
      captureSummary: unknown;
    },
  ) {
    const markers = readFrameMarkers(media.captureSummary, media.durationSeconds);
    if (!markers.length) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegPath = require('ffmpeg-static') as string | null;
    if (!ffmpegPath) return;

    const directory = await mkdtemp(join(tmpdir(), 'txr-frames-'));
    const input = join(directory, media.mimeType === 'video/quicktime' ? 'input.mov' : 'input.mp4');
    try {
      await writeFile(input, video);
      let extracted = 0;
      for (const [index, atMs] of markers.entries()) {
        // Derived from the media and the offset, so re-processing the same
        // recording overwrites its own frames instead of duplicating them.
        const idempotencyKey = `${media.providerMediaId}-frame-${atMs}`;
        const existing = await this.prisma.inspectionPhoto.findUnique({
          where: { idempotencyKey },
          select: { id: true },
        });
        if (existing) continue;

        const output = join(directory, `frame-${atMs}.jpg`);
        await new Promise<void>((resolvePromise) => {
          const child = spawn(ffmpegPath, [
            '-y',
            // Before -i: seeks by keyframe, which is far cheaper than decoding
            // the whole clip and accurate enough for a walkthrough still.
            '-ss',
            (atMs / 1000).toFixed(3),
            '-i',
            input,
            '-frames:v',
            '1',
            '-q:v',
            '3',
            output,
          ]);
          child.on('error', () => resolvePromise());
          child.on('exit', () => resolvePromise());
        });

        // The written file decides, not the exit code. Seeking past the end of
        // a clip makes ffmpeg exit 0 having produced nothing, so trusting the
        // status would send a missing path to storage and abort the remaining
        // markers. `durationSeconds` is client-reported and can overstate the
        // real video, so this case is reachable in practice.
        const bytes = await stat(output).catch(() => null);
        if (!bytes?.size) continue;

        // Per marker, so one unwritable frame costs only its own still rather
        // than every later one in the same recording.
        try {
          const storageKey = `${media.organizationId}/${media.inspectionId}/${media.inspectionAreaId}/photos/${randomUUID()}.jpg`;
          await this.storage.putFromFile(storageKey, output, 'image/jpeg');
          await this.prisma.inspectionPhoto.create({
            data: {
              organizationId: media.organizationId,
              inspectionId: media.inspectionId,
              inspectionAreaId: media.inspectionAreaId,
              capturedById: media.technicianId,
              provider: this.storage.providerName(),
              storageKey,
              // The first marked frame stands in for the room overview; later
              // ones are context for whatever the technician was pointing at.
              captureType:
                index === 0 ? PhotoCaptureType.AREA_OVERVIEW : PhotoCaptureType.FINDING_CONTEXT,
              sequenceNumber: index + 1,
              mimeType: 'image/jpeg',
              sizeBytes: bytes.size,
              idempotencyKey,
              metadata: {
                captureSource: 'VIDEO_FRAME_EXTRACTION',
                videoTimestampMs: atMs,
                sourceMediaId: media.id,
              },
            },
          });
          extracted += 1;
        } catch (error) {
          this.logger.warn(
            `Frame at ${atMs}ms not stored for ${media.id}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
      }
      if (extracted) await this.event(media.id, 'FRAMES_EXTRACTED', { count: extracted });
    } catch (error) {
      this.logger.warn(
        `Marker frame extraction skipped for ${media.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async generateThumbnail(video: Buffer, mimeType: string, storageKey: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegPath = require('ffmpeg-static') as string | null;
    if (!ffmpegPath) return;
    const directory = await mkdtemp(join(tmpdir(), 'txr-thumb-'));
    const input = join(directory, mimeType === 'video/quicktime' ? 'input.mov' : 'input.mp4');
    const output = join(directory, 'thumb.jpg');
    try {
      await writeFile(input, video);
      // Seek a second in to skip a black or blurry opening frame; clips shorter
      // than that fall back to the very first frame.
      const grab = (seekSeconds: number) =>
        new Promise<boolean>((resolvePromise) => {
          const child = spawn(ffmpegPath, [
            '-y',
            '-ss',
            String(seekSeconds),
            '-i',
            input,
            '-frames:v',
            '1',
            '-vf',
            'scale=640:-2',
            '-q:v',
            '3',
            output,
          ]);
          child.on('error', () => resolvePromise(false));
          child.on('exit', (code) => resolvePromise(code === 0));
        });
      if (!(await grab(1)) && !(await grab(0))) {
        this.logger.warn(`Thumbnail extraction failed for ${storageKey}`);
        return;
      }
      await this.storage.putFromFile(thumbnailKeyFor(storageKey), output, 'image/jpeg');
    } catch (error) {
      this.logger.warn(
        `Thumbnail generation skipped for ${storageKey}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

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
    // whisper-1 first, and deliberately so. It is the only OpenAI transcription
    // model that accepts response_format=verbose_json, which is the only way to
    // get per-utterance timings; gpt-4o-mini-transcribe returns text alone. That
    // left every finding stamped 0:00, because one 150-second segment is all the
    // analysis had to cite. Segment timings are worth more here than any margin
    // in raw text quality, now that correctness rests on the checklist answers.
    const models = [
      { id: 'whisper-1', format: 'verbose_json' },
      { id: 'gpt-4o-mini-transcribe', format: 'json' },
    ];
    let lastError: ApplicationError | null = null;
    for (const model of models) {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(audio.bytes)], { type: audio.type }),
        audio.name,
      );
      form.append('model', model.id);
      form.append('response_format', model.format);
      if (model.format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
      // No language parameter: let the model auto-detect (multilingual crews).
      form.append('prompt', TRANSCRIPTION_DOMAIN_HINT);
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) {
        // `segments` is optional: only the verbose_json model returns it, and the
        // caller falls back to a single whole-recording segment without it.
        const parsed = z
          .object({
            text: z.string(),
            segments: z
              .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
              .optional(),
          })
          .safeParse(payload);
        if (!parsed.success)
          throw new ApplicationError(
            502,
            'TRANSCRIPTION_FAILED',
            'The transcription provider returned an unreadable response.',
          );
        return { text: parsed.data.text, segments: parsed.data.segments ?? [] };
      }
      const message =
        (payload as { error?: { message?: string } } | null)?.error?.message ?? 'unknown error';
      this.logger.warn(`Transcription with ${model.id} failed (HTTP ${response.status}): ${message}`);
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
        const assessments = await this.checklistAssessments(media.id);
        const prompt = this.analysisPrompt(media, transcript, baselineContext, assessments);
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

  /**
   * What the technician actually recorded, item by item.
   *
   * This is ground truth in a way the transcript is not. The answers are taps on
   * three explicit axes, stored as booleans; the transcript is speech run through
   * a recogniser that can drop a syllable and invert the meaning. A real
   * walkthrough produced "doors and locks, they are clean and damaged" from a
   * technician who had tapped undamaged, and three findings asserted damage that
   * nobody reported.
   *
   * Each answer also carries the second of the recording it was given at, which
   * is a far better anchor for a finding's timestamp than anything inferable
   * from narration.
   */
  private async checklistAssessments(mediaId: string) {
    const media = await this.prisma.inspectionMedia.findUnique({
      where: { id: mediaId },
      select: { inspectionAreaId: true },
    });
    if (!media) return [];
    const responses = await this.prisma.inspectionAreaChecklistResponse.findMany({
      where: {
        inspectionAreaId: media.inspectionAreaId,
        // An item nobody answered says nothing, and presenting it as a blank row
        // invites the model to treat "unanswered" as "nothing wrong".
        OR: [
          { isClean: { not: null } },
          { isUndamaged: { not: null } },
          { isWorking: { not: null } },
        ],
      },
      select: {
        isClean: true,
        isUndamaged: true,
        isWorking: true,
        comment: true,
        videoTimestampSeconds: true,
        checklistItem: { select: { label: true } },
      },
      orderBy: { videoTimestampSeconds: 'asc' },
    });
    return responses.map((response) => ({
      label: response.checklistItem.label,
      isClean: response.isClean,
      isUndamaged: response.isUndamaged,
      isWorking: response.isWorking,
      comment: response.comment,
      videoTimestampSeconds: response.videoTimestampSeconds,
    }));
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
    assessments: Array<{
      label: string;
      isClean: boolean | null;
      isUndamaged: boolean | null;
      isWorking: boolean | null;
      comment: string | null;
      videoTimestampSeconds: number | null;
    }> = [],
  ) {
    const area = media.inspectionArea.propertyArea;
    const axis = (value: boolean | null, yes: string, no: string) =>
      value === null ? 'not assessed' : value ? yes : no;
    const assessmentLines = assessments.map((item) => {
      const at =
        item.videoTimestampSeconds === null ? '' : ` [at ${item.videoTimestampSeconds}s]`;
      const note = item.comment ? ` — technician note: ${item.comment}` : '';
      return `- ${item.label}: ${axis(item.isClean, 'clean', 'NOT clean')}, ${axis(
        item.isUndamaged,
        'undamaged',
        'DAMAGED',
      )}, ${axis(item.isWorking, 'working', 'NOT working')}${at}${note}`;
    });
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
      // Placed before the transcript on purpose: the model reads the facts it
      // must not contradict before it reads the prose it may misread.
      ...(assessmentLines.length
        ? [
            'The technician recorded the following assessment for each checklist item.',
            'These are explicit recorded answers, not speech, and they are AUTHORITATIVE.',
            '<assessment>',
            ...assessmentLines,
            '</assessment>',
            'Rules for using the assessment:',
            '- Never report damage for an item recorded as undamaged, however the transcript reads.',
            '  Speech recognition drops the "un-" in "undamaged" often enough that the transcript',
            '  can assert the exact opposite of what the technician recorded. The assessment wins.',
            '- The same applies to clean and working.',
            '- Raise a finding for an item only when the assessment marks it NOT clean, DAMAGED or',
            '  NOT working, or when the narration describes a problem the checklist has no item for.',
            '- When an item is "not assessed", the narration is the only evidence; say so in',
            '  recommendedReview rather than assuming a condition.',
            '- If the transcript and the assessment disagree, follow the assessment and note the',
            '  discrepancy in recommendedReview so a human can check the recording.',
          ]
        : []),
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
      // Findings used to come back stamped 0:00 across the board: the transcript
      // was one untimed block, so there was nothing to cite. The assessment
      // timestamps are exact — they are recorded by the phone at the moment the
      // technician answers — so they are the best anchor available.
      'videoTimestampStart and videoTimestampEnd (integer seconds within the duration):',
      '  for a finding about a checklist item, use the [at Ns] timestamp of that item as the start',
      '  and a few seconds later as the end; otherwise use the timing of the narration that',
      '  supports it; use 0 only when neither is available,',
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
        select: { status: true, inspectionType: true },
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
    // Technician submission (TECHNICIAN_SUBMITTED) or a legacy PROCESSING state
    // both mean "submitted, awaiting processing"; either advances to review once
    // every recording has finished processing.
    const advanceable: InspectionStatus[] = [
      InspectionStatus.TECHNICIAN_SUBMITTED,
      InspectionStatus.PROCESSING,
    ];
    if (inspection && advanceable.includes(inspection.status) && unfinished === 0) {
      // The status is re-checked in the WHERE clause, not just above it. The
      // read is not in a transaction, so an administrator's reopen can commit
      // in between — an unconditional update would then drag the inspection
      // back to REVIEW_REQUIRED behind the admin's back, out of the technician
      // queue they had just returned it to. updateMany because update() throws
      // when its where matches nothing, and losing this race is expected.
      const { count } = await this.prisma.inspection.updateMany({
        where: { id: inspectionId, status: { in: advanceable } },
        data: { status: InspectionStatus.REVIEW_REQUIRED },
      });
      if (count === 0) return;
      // Now that move-out findings are ready, draft the move-in vs move-out
      // comparison (spec §12). Best-effort: a failure never blocks review.
      if (inspection.inspectionType === InspectionType.MOVE_OUT && this.comparison)
        await this.comparison.generate(inspectionId).catch((error) => {
          this.logger.warn(
            `Comparison generation skipped for ${inspectionId}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        });
    }
  }

  private event(inspectionMediaId: string, eventType: string, payloadSummary: object) {
    return this.prisma.mediaProcessingEvent
      .create({ data: { inspectionMediaId, eventType, payloadSummary } })
      .catch(() => undefined);
  }
}
