import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AreaChecklistItemKind,
  ChecklistResponseType,
  TranscriptionStatus,
  VideoRecordingType,
} from '@prisma/client';
import { sortAreasBySequence } from '@texasrenters/shared';
import type { AreaRecordingSummaryView, InspectionRecordingSummaries } from '@texasrenters/shared';

import {
  AiProviderSettingsService,
  type ResolvedAiConfiguration,
} from '../admin/ai-provider-settings.service';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { withTenant } from '../database/tenant-context';
import { askAi } from './ai-text';
import {
  acceptedSummary,
  readStoredSummary,
  summaryPrompt,
  type StoredRecordingSummary,
  STORED_SUMMARY_VERSION,
  type SummaryRecording,
} from './recording-summary';

/**
 * Writes each room's "Summary based on the recordings" for the report.
 *
 * The report printed the narration word for word under each room's
 * photographs; the maintenance team asked for it summarized, with its
 * timestamps, and for what the room needs grouped as Repairs / Maintenance,
 * Painting and Cleaning (2026-10-07). The rules that keep the summary to what
 * was said are in `recording-summary.ts`.
 *
 * Written once per room and stored, never at report time: a report link is
 * public and opened again and again, and it must print the same words each
 * time. Runs by itself when a submitted inspection reaches review, and on
 * demand from the console. One RECORDING_SUMMARY_GENERATED audit row per run.
 * It decides nothing: no finding, approval, charge or checklist answer.
 */

export type SummaryTrigger = 'REVIEWER' | 'PIPELINE';
export const SUMMARY_AUDIT_ACTION = 'RECORDING_SUMMARY_GENERATED';
const USAGE_OPERATION = 'RECORDING_SUMMARY';
const CALL_TIMEOUT_MS = 150_000;
const CONCURRENCY = 3;
const MAX_LINES = 600;

interface AreaSummaryOutcome {
  inspectionAreaId: string;
  areaName: string;
  points: number;
  actions: number;
}

@Injectable()
export class RecordingSummaryService {
  private readonly logger = new Logger(RecordingSummaryService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiProviderSettingsService) private readonly aiSettings: AiProviderSettingsService,
  ) {}

  /** Every room of an inspection, in the background; answers at once. */
  async queueInspection(
    organizationId: string,
    inspectionId: string,
    actorUserId: string | null,
    trigger: SummaryTrigger,
  ) {
    const inspection = await this.inspection(organizationId, inspectionId);
    const areas = await this.prisma.inspectionArea.count({ where: { inspectionId } });
    if (this.inFlight.has(inspectionId)) return { queued: false, areas };
    this.inFlight.add(inspectionId);
    setImmediate(() => {
      void withTenant(organizationId, () =>
        this.runInspection(organizationId, inspection, actorUserId, trigger),
      )
        .catch((error) =>
          this.logger.error(
            `Recording summary failed for inspection ${inspectionId}`,
            error instanceof Error ? error.stack : String(error),
          ),
        )
        .finally(() => this.inFlight.delete(inspectionId));
    });
    return { queued: true, areas };
  }

  /** Called by the pipeline when a submitted inspection reaches review. Never throws. */
  async afterSubmission(organizationId: string, inspectionId: string) {
    await this.queueInspection(organizationId, inspectionId, null, 'PIPELINE').catch((error) =>
      this.logger.warn(
        `Recording summary skipped for ${inspectionId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
    );
  }

  /** One room now; answers with the summary, or null when nothing was said there. */
  async summarizeArea(
    organizationId: string,
    inspectionId: string,
    inspectionAreaId: string,
    actorUserId: string,
  ): Promise<AreaRecordingSummaryView | null> {
    const inspection = await this.inspection(organizationId, inspectionId);
    const area = await this.prisma.inspectionArea.findFirst({
      where: { id: inspectionAreaId, inspectionId },
      select: { id: true },
    });
    if (!area)
      throw new ApplicationError(404, 'INSPECTION_AREA_NOT_FOUND', 'Inspection area was not found.');
    const configuration = await this.aiSettings.resolve(organizationId);
    const { outcome, view } = await this.summarizeOne(organizationId, inspection, area.id, configuration);
    await this.audit(
      organizationId,
      inspectionId,
      actorUserId,
      'REVIEWER',
      configuration,
      [outcome],
      inspection.finalizedAt,
    );
    return view;
  }

  /**
   * Every area's summary, in walk order, for the "Summaries of all areas" tab.
   * A summary is marked stale exactly as the report judges it: a recording
   * transcribed since it was written.
   */
  async listForInspection(
    organizationId: string,
    inspectionId: string,
  ): Promise<InspectionRecordingSummaries> {
    await this.inspection(organizationId, inspectionId);
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId },
      orderBy: { propertyArea: { inspectionOrder: 'asc' } },
      take: 100,
      select: {
        id: true,
        recordingSummary: true,
        recordingSummaryAt: true,
        propertyArea: { select: { name: true, floor: { select: { name: true } } } },
        media: {
          where: { transcriptionJob: { status: TranscriptionStatus.COMPLETED } },
          select: {
            id: true,
            transcriptionJob: {
              select: { segments: { where: { text: { not: '' } }, take: 5, select: { text: true } } },
            },
          },
        },
      },
    });
    return {
      // The office's order, the entrance first (2026-10-08).
      areas: sortAreasBySequence(areas, (area) => area.propertyArea.name).map((area) => {
        const spoken = area.media
          .filter((media) =>
            (media.transcriptionJob?.segments ?? []).some((segment) => segment.text.trim()),
          )
          .map((media) => media.id);
        const read = area.recordingSummaryAt
          ? readStoredSummary(area.recordingSummary, spoken)
          : null;
        return {
          inspectionAreaId: area.id,
          name: area.propertyArea.name,
          floorName: area.propertyArea.floor?.name ?? null,
          recorded: spoken.length > 0,
          summary:
            read && area.recordingSummaryAt
              ? {
                  ...read.summary,
                  generatedAt: area.recordingSummaryAt.toISOString(),
                  current: read.current,
                  staleReason: read.staleReason,
                }
              : null,
        };
      }),
    };
  }

  private async inspection(organizationId: string, inspectionId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: { id: true, inspectionType: true, finalizedAt: true },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }

  private async runInspection(
    organizationId: string,
    inspection: { id: string; inspectionType: string; finalizedAt: Date | null },
    actorUserId: string | null,
    trigger: SummaryTrigger,
  ) {
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId: inspection.id },
      select: { id: true },
    });
    const configuration = await this.aiSettings.resolve(organizationId);
    const queue = areas.map((area) => area.id);
    const outcomes: AreaSummaryOutcome[] = [];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let areaId = queue.shift(); areaId; areaId = queue.shift()) {
        try {
          outcomes.push(
            (await this.summarizeOne(organizationId, inspection, areaId, configuration)).outcome,
          );
        } catch (error) {
          // That room keeps what it printed before: its last summary, or the narration.
          this.logger.warn(
            `Recording summary failed for area ${areaId}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
    });
    await Promise.all(workers);
    await this.audit(
      organizationId,
      inspection.id,
      actorUserId,
      trigger,
      configuration,
      outcomes,
      inspection.finalizedAt,
    );
  }

  private async summarizeOne(
    organizationId: string,
    inspection: { id: string; inspectionType: string },
    inspectionAreaId: string,
    configuration: ResolvedAiConfiguration,
  ): Promise<{ outcome: AreaSummaryOutcome; view: AreaRecordingSummaryView | null }> {
    const area = await this.prisma.inspectionArea.findUniqueOrThrow({
      where: { id: inspectionAreaId },
      select: {
        id: true,
        propertyArea: {
          select: {
            name: true,
            // The room's own checklist, so each action can name the item it is
            // about and print in that item's Comments cell (2026-10-08).
            checklistItems: {
              where: {
                kind: AreaChecklistItemKind.ROOM,
                archivedAt: null,
                responseType: ChecklistResponseType.STATUS,
              },
              orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
              take: 60,
              select: { id: true, label: true },
            },
          },
        },
        media: {
          where: { transcriptionJob: { status: TranscriptionStatus.COMPLETED } },
          orderBy: [{ recordingType: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            recordingType: true,
            label: true,
            transcriptionJob: {
              select: {
                segments: {
                  orderBy: [{ startSeconds: 'asc' }, { endSeconds: 'asc' }],
                  select: { startSeconds: true, text: true },
                },
              },
            },
          },
        },
      },
    });
    const areaName = area.propertyArea.name;
    const recordings: SummaryRecording[] = area.media
      .map((media) => ({
        mediaId: media.id,
        primary: media.recordingType === VideoRecordingType.PRIMARY_AREA,
        label: media.label?.trim() || null,
        lines: (media.transcriptionJob?.segments ?? [])
          .map((segment) => ({ start: segment.startSeconds, text: segment.text.trim() }))
          .filter((line) => line.text.length > 0)
          .slice(0, MAX_LINES),
      }))
      .filter((recording) => recording.lines.length > 0);
    if (!recordings.length)
      return { outcome: { inspectionAreaId, areaName, points: 0, actions: 0 }, view: null };

    const { text, usage } = await askAi(
      configuration,
      summaryPrompt(
        areaName,
        `${inspection.inspectionType.toLowerCase().replace(/_/g, '-')} inspection`,
        recordings,
        area.propertyArea.checklistItems,
      ),
      {
        maxTokens: 6_000,
        timeoutMs: CALL_TIMEOUT_MS,
        failureCode: 'AI_SUMMARY_FAILED',
        onRejected: (status, message) =>
          this.logger.warn(`Recording summary rejected (HTTP ${status}): ${message}`),
      },
    );
    await this.aiSettings
      .recordUsage(organizationId, configuration, USAGE_OPERATION, usage, inspectionAreaId)
      .catch(() => undefined);
    const summary = acceptedSummary(text, recordings, area.propertyArea.checklistItems);
    const stored: StoredRecordingSummary = {
      version: STORED_SUMMARY_VERSION,
      mediaIds: recordings.map((recording) => recording.mediaId),
      ...summary,
    };
    const at = new Date();
    await this.prisma.inspectionArea.update({
      where: { id: inspectionAreaId },
      data: { recordingSummary: stored as never, recordingSummaryAt: at },
    });
    return {
      outcome: {
        inspectionAreaId,
        areaName,
        points: summary.recordings.reduce((total, recording) => total + recording.lines.length, 0),
        actions: summary.actions.reduce((total, group) => total + group.items.length, 0),
      },
      view: {
        ...(readStoredSummary(stored, stored.mediaIds)?.summary ?? summary),
        generatedAt: at.toISOString(),
        current: true,
        staleReason: null,
      },
    };
  }

  private async audit(
    organizationId: string,
    inspectionId: string,
    actorUserId: string | null,
    trigger: SummaryTrigger,
    configuration: ResolvedAiConfiguration,
    outcomes: AreaSummaryOutcome[],
    finalizedAt?: Date | null,
  ) {
    await this.prisma.auditLog
      .create({
        data: {
          organizationId,
          actorUserId,
          action: SUMMARY_AUDIT_ACTION,
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: {
            trigger,
            provider: configuration.provider,
            modelId: configuration.modelId,
            afterFinalization: Boolean(finalizedAt),
            areas: outcomes.map((outcome) => ({ ...outcome })),
          },
        },
      })
      .catch((error) =>
        this.logger.error(
          `Recording summary audit failed for ${inspectionId}`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }
}
