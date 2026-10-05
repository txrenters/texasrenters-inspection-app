import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AiEvaluationStatus,
  FindingReviewStatus,
  FindingSource,
  PhotoCaptureType,
  TranscriptionStatus,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { withTenant } from '../database/tenant-context';
import { isAiFiled } from '../technician/ai-filed-frames';
import { MediaProcessingService, PROMPT_VERSION } from '../technician/media-processing.service';
import { ROOM_SUMMARY_TITLE, ROOM_SUMMARY_WHERE } from '../technician/room-summary';
import { AiGuidanceService, MAX_GUIDANCE_LENGTH } from './ai-guidance.service';
import {
  scoreRecording,
  sumScores,
  type DraftFinding,
  type KeyFinding,
  type RecordingScore,
} from './ai-evaluation';

/** How many recordings a run takes by default, and at most: a run costs one analysis each. */
export const DEFAULT_TEST_SET_SIZE = 10;
export const MAX_TEST_SET_SIZE = 20;

/**
 * A run still RUNNING after this long was cut off -- the server restarted under
 * it -- and is reported as failed rather than running for ever.
 */
const STALE_RUN_MS = 45 * 60_000;

type TestRecording = {
  mediaId: string;
  inspectionId: string;
  roomName: string;
  propertyName: string | null;
  inspectionType: string;
  recordedAt: string;
};

type RecordingResult = TestRecording & {
  score: RecordingScore | null;
  error: string | null;
  tokens: number;
};

/**
 * The AI measured against the office's own decisions before a change ships.
 *
 * A run takes the most recent recordings the office has decided findings on,
 * runs the narration's analysis on each under the rules being tried -- the
 * same analysis the one-recording trial runs, which is never shown that
 * recording's own decisions -- and scores the answer against those decisions.
 * Nothing it proposes is stored as a finding. Runs are kept, so two versions of
 * the rules can be compared on the same recordings.
 */
@Injectable()
export class AiEvaluationService {
  private readonly logger = new Logger(AiEvaluationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiGuidanceService) private readonly guidance: AiGuidanceService,
    @Optional()
    @Inject(MediaProcessingService)
    private readonly mediaProcessing?: MediaProcessingService,
  ) {}

  async start(user: AuthenticatedUser, input: { houseRules: string; size?: number }) {
    if (!this.mediaProcessing)
      throw new ApplicationError(
        503,
        'MEDIA_PROCESSING_UNAVAILABLE',
        'The analysis pipeline is not available on this server.',
      );
    const houseRules = input.houseRules.trim();
    if (houseRules.length > MAX_GUIDANCE_LENGTH)
      throw new ApplicationError(
        422,
        'AI_GUIDANCE_TOO_LONG',
        `House rules are limited to ${MAX_GUIDANCE_LENGTH} characters.`,
      );
    const size = Math.min(MAX_TEST_SET_SIZE, Math.max(1, input.size ?? DEFAULT_TEST_SET_SIZE));

    // One at a time: a second run would double the bill for no second answer.
    const running = await this.prisma.aiEvaluationRun.findFirst({
      where: {
        organizationId: user.organizationId,
        status: AiEvaluationStatus.RUNNING,
        startedAt: { gte: new Date(Date.now() - STALE_RUN_MS) },
      },
      select: { id: true },
    });
    if (running)
      throw new ApplicationError(
        409,
        'AI_EVALUATION_RUNNING',
        'A test run is already going. Wait for it to finish.',
      );

    const recordings = await this.testSet(user.organizationId, size);
    if (!recordings.length)
      throw new ApplicationError(
        409,
        'NO_TEST_SET',
        'No recording has decided findings and a stored narration yet. Review one inspection’s findings first.',
      );

    const current = await this.guidance.current(user.organizationId);
    const guidanceVersion = current && current.text.trim() === houseRules ? current.version : null;
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.aiEvaluationRun.create({
        data: {
          organizationId: user.organizationId,
          guidanceVersion,
          houseRules,
          promptVersion: PROMPT_VERSION,
          recordingCount: recordings.length,
          startedById: user.id,
          results: [],
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'AI_EVALUATION_STARTED',
          entityType: 'AiEvaluationRun',
          entityId: created.id,
          metadata: {
            recordingCount: recordings.length,
            guidanceVersion,
            draft: guidanceVersion === null,
          },
        },
      });
      return created;
    });

    // Minutes of work: answered now, and run after the request, under its
    // organization like every query in it.
    setImmediate(() => {
      void withTenant(user.organizationId, () =>
        this.execute(run.id, user.organizationId, recordings, houseRules),
      ).catch((error) =>
        this.logger.error(
          `Unhandled AI test run failure ${run.id}`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
    });
    return this.get(user.organizationId, run.id);
  }

  /** The recent runs, newest first, without each recording's detail. */
  async list(organizationId: string) {
    const runs = await this.prisma.aiEvaluationRun.findMany({
      where: { organizationId },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: RUN_SUMMARY,
    });
    return this.withNames(runs.map((run) => this.present(run)));
  }

  async get(organizationId: string, id: string) {
    const run = await this.prisma.aiEvaluationRun.findFirst({
      where: { id, organizationId },
      select: { ...RUN_SUMMARY, results: true },
    });
    if (!run)
      throw new ApplicationError(404, 'AI_EVALUATION_NOT_FOUND', 'That test run was not found.');
    const [named] = await this.withNames([this.present(run)]);
    return {
      ...named,
      // The rules as they were tried, which a draft no longer has anywhere else.
      houseRules: run.houseRules,
      results: (run.results ?? []) as unknown as RecordingResult[],
    };
  }

  /**
   * The recordings to test on: the most recent with narration findings the
   * office decided and a stored narration to analyse again.
   */
  private async testSet(organizationId: string, size: number): Promise<TestRecording[]> {
    const media = await this.prisma.inspectionMedia.findMany({
      where: {
        organizationId,
        transcriptionJob: { is: { status: TranscriptionStatus.COMPLETED } },
        findings: {
          some: {
            source: FindingSource.NARRATION,
            reviewStatus: { in: [FindingReviewStatus.APPROVED, FindingReviewStatus.REJECTED] },
            NOT: { ...ROOM_SUMMARY_WHERE },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: size,
      select: {
        id: true,
        createdAt: true,
        inspectionId: true,
        inspectionArea: {
          select: {
            propertyArea: { select: { name: true } },
            inspection: {
              select: { inspectionType: true, propertywareBuilding: { select: { name: true } } },
            },
          },
        },
      },
    });
    return media.map((row) => ({
      mediaId: row.id,
      inspectionId: row.inspectionId,
      roomName: row.inspectionArea.propertyArea.name,
      propertyName: row.inspectionArea.inspection.propertywareBuilding?.name ?? null,
      inspectionType: row.inspectionArea.inspection.inspectionType,
      recordedAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * What the office decided about the narration's findings on one recording.
   * The AI's own look at the video is not part of the narration's analysis,
   * so what it spotted is not something a draft could find or miss.
   */
  private async answerKey(mediaId: string): Promise<KeyFinding[]> {
    const findings = await this.prisma.inspectionFinding.findMany({
      where: {
        inspectionMediaId: mediaId,
        source: FindingSource.NARRATION,
        reviewStatus: { in: [FindingReviewStatus.APPROVED, FindingReviewStatus.REJECTED] },
        NOT: { ...ROOM_SUMMARY_WHERE },
      },
      select: {
        id: true,
        title: true,
        category: true,
        reviewStatus: true,
        videoTimestampStart: true,
        reviews: {
          orderBy: { createdAt: 'desc' },
          select: { status: true, reasonCode: true, editedValue: true },
        },
        // Every frame filed, so the first a person chose can be told from the
        // AI's own: a frame the AI filed is not the office confirming anything.
        photos: {
          where: { captureType: PhotoCaptureType.VIDEO_FRAME_SNAPSHOT },
          orderBy: { createdAt: 'asc' },
          select: { metadata: true },
        },
      },
    });
    return findings.map((finding) => {
      const latest = finding.reviews[0];
      const correctedFrom = finding.reviews
        .map((review) => (review.editedValue as { before?: { title?: unknown } } | null)?.before?.title)
        .filter((title): title is string => typeof title === 'string' && title !== finding.title);
      const chosen = finding.photos.find((photo) => !isAiFiled(photo.metadata));
      const frame = (chosen?.metadata as { videoTimestampMs?: unknown } | null)?.videoTimestampMs;
      return {
        id: finding.id,
        titles: [finding.title, ...correctedFrom],
        category: finding.category,
        startSeconds: finding.videoTimestampStart || null,
        decision: finding.reviewStatus === FindingReviewStatus.REJECTED ? 'REJECTED' : 'KEPT',
        reasonCode: finding.reviewStatus === FindingReviewStatus.REJECTED ? (latest?.reasonCode ?? null) : null,
        confirmedMs: typeof frame === 'number' && Number.isFinite(frame) ? frame : null,
      };
    });
  }

  /**
   * Each recording in turn, its result written as it finishes so the console
   * can show progress. One recording failing is that recording's result, not
   * the run's: the rest still say something.
   */
  private async execute(
    runId: string,
    organizationId: string,
    recordings: TestRecording[],
    houseRules: string,
  ) {
    const results: RecordingResult[] = [];
    let tokens = 0;
    let modelId: string | null = null;
    try {
      for (const recording of recordings) {
        try {
          const [key, draft] = await Promise.all([
            this.answerKey(recording.mediaId),
            this.mediaProcessing!.previewAnalysis(
              recording.mediaId,
              organizationId,
              houseRules,
              'AI_EVALUATION',
            ),
          ]);
          modelId = draft.modelId;
          tokens += draft.usage.totalTokens;
          const proposed: DraftFinding[] = draft.items.filter(
            (item) => !(item.findingType === 'NO_CHANGE' && item.title === ROOM_SUMMARY_TITLE),
          );
          results.push({
            ...recording,
            score: scoreRecording(key, proposed),
            error: null,
            tokens: draft.usage.totalTokens,
          });
        } catch (error) {
          results.push({
            ...recording,
            score: null,
            error: error instanceof Error ? error.message.slice(0, 300) : 'The analysis failed.',
            tokens: 0,
          });
        }
        await this.prisma.aiEvaluationRun.update({
          where: { id: runId },
          data: {
            completedCount: results.length,
            results: results as unknown as Prisma.InputJsonValue,
            tokens,
            modelId,
          },
        });
      }
      await this.prisma.aiEvaluationRun.update({
        where: { id: runId },
        data: {
          status: AiEvaluationStatus.COMPLETED,
          totals: sumScores(results.map((result) => result.score)) as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      await this.prisma.aiEvaluationRun
        .update({
          where: { id: runId },
          data: {
            status: AiEvaluationStatus.FAILED,
            error: error instanceof Error ? error.message.slice(0, 500) : 'The test run failed.',
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private present(run: Prisma.AiEvaluationRunGetPayload<{ select: typeof RUN_SUMMARY }>) {
    // Cut off by a restart: nothing will ever finish it.
    const stale =
      run.status === AiEvaluationStatus.RUNNING &&
      Date.now() - run.startedAt.getTime() > STALE_RUN_MS;
    return {
      id: run.id,
      status: stale ? AiEvaluationStatus.FAILED : run.status,
      error: stale ? 'The run was interrupted before it finished.' : run.error,
      guidanceVersion: run.guidanceVersion,
      houseRulesLength: run.houseRules.length,
      promptVersion: run.promptVersion,
      modelId: run.modelId,
      recordingCount: run.recordingCount,
      completedCount: run.completedCount,
      totals: (run.totals ?? null) as ReturnType<typeof sumScores> | null,
      tokens: run.tokens,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      startedById: run.startedById,
    };
  }

  private async withNames<T extends { startedById: string | null }>(runs: T[]) {
    const ids = [...new Set(runs.flatMap((run) => (run.startedById ? [run.startedById] : [])))];
    const people = ids.length
      ? await this.prisma.userProfile.findMany({
          where: { id: { in: ids } },
          select: { id: true, displayName: true },
        })
      : [];
    const name = new Map(people.map((person) => [person.id, person.displayName]));
    return runs.map(({ startedById, ...run }) => ({
      ...run,
      startedByName: startedById ? (name.get(startedById) ?? null) : null,
    }));
  }
}

const RUN_SUMMARY = {
  id: true,
  status: true,
  error: true,
  guidanceVersion: true,
  houseRules: true,
  promptVersion: true,
  modelId: true,
  recordingCount: true,
  completedCount: true,
  totals: true,
  tokens: true,
  startedAt: true,
  completedAt: true,
  startedById: true,
} satisfies Prisma.AiEvaluationRunSelect;
