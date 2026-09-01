import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InspectionStatus,
  JobberVisitImportStatus,
  WebhookProcessingStatus,
} from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import { JobberSyncWorker } from '../../workers/jobber-sync/jobber-sync.worker';
import { JobberTokenService } from './jobber.tokens.service';
import { JOBBER_SOURCE_SYSTEM } from './jobber.constants';
import type { JobberWebhookEvent } from './jobber.schemas';

/**
 * Topics that mean "a visit changed, go and look at it".
 *
 * VISIT_DESTROY is handled separately: the visit is gone, so fetching it would
 * return nothing and look indistinguishable from a visit we simply cannot see.
 */
const VISIT_TOPICS = new Set(['VISIT_CREATE', 'VISIT_UPDATE', 'VISIT_COMPLETE']);

@Injectable()
export class JobberWebhookService {
  private readonly logger = new Logger(JobberWebhookService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberSyncWorker) private readonly sync: JobberSyncWorker,
    @Inject(JobberTokenService) private readonly tokens: JobberTokenService,
  ) {}

  /**
   * Records the delivery and says whether it is new work.
   *
   * Jobber delivers at least once, so retries repeat an event verbatim. The
   * unique `(provider, providerEventId)` is what makes a replay free: the
   * insert loses, and the caller is told not to process it again.
   *
   * Separately, a single user action often fires the same topic two or three
   * times about a second apart with *different* timestamps. Those are not
   * caught here and are not meant to be — they are genuinely distinct events,
   * and what makes them harmless is that processing a visit twice produces the
   * same result.
   */
  async record(event: JobberWebhookEvent, payloadHash: string) {
    const occurredAt = event.occurredAt ?? event.occuredAt ?? '';
    const providerEventId = `${event.topic}:${event.itemId}:${occurredAt}`;
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: JOBBER_SOURCE_SYSTEM,
          providerEventId,
          payloadHash,
          status: WebhookProcessingStatus.RECEIVED,
        },
      });
      return { providerEventId, isNew: true };
    } catch {
      // The only constraint on this table is that pair, so a failure here is a
      // replay. Recording it as such keeps the count of duplicates visible
      // rather than swallowing them into a bare success.
      await this.prisma.webhookEvent.updateMany({
        where: { provider: JOBBER_SOURCE_SYSTEM, providerEventId },
        data: { status: WebhookProcessingStatus.IGNORED_DUPLICATE },
      });
      return { providerEventId, isNew: false };
    }
  }

  /**
   * Acts on a delivery, after the response has already gone back to Jobber.
   *
   * Jobber requires a reply within one second and may disable an app's webhooks
   * if that slips, so nothing in here may run before the acknowledgement. The
   * cost is that a failure cannot be reported to Jobber — which is why the
   * periodic sync still exists: it re-reads the same window and reconciles
   * anything this path dropped.
   */
  async process(event: JobberWebhookEvent, providerEventId: string) {
    const connection = await this.prisma.jobberConnection.findFirst({
      where: { jobberAccountId: event.accountId },
      select: { organizationId: true },
    });
    /**
     * A delivery for an account we do not hold.
     *
     * The signature proves it came from Jobber, not that it concerns us — one
     * app can be installed on many accounts. Acting on it would write another
     * company's schedule into this organization.
     */
    if (!connection) {
      await this.finish(providerEventId, WebhookProcessingStatus.IGNORED_DUPLICATE);
      this.logger.warn(`Jobber webhook for an unknown account: ${event.accountId}`);
      return;
    }

    try {
      if (event.topic === 'VISIT_DESTROY') {
        await this.withdrawDeletedVisit(connection.organizationId, event.itemId);
      } else if (event.topic === 'APP_DISCONNECT') {
        // Jobber has already invalidated the tokens; keeping them would leave a
        // connection that looks healthy and fails at the next refresh.
        await this.tokens.markDisconnected(connection.organizationId);
        this.logger.log(`Jobber disconnected ${connection.organizationId} by webhook.`);
      } else if (VISIT_TOPICS.has(event.topic)) {
        await this.sync.syncVisit(connection.organizationId, event.itemId);
      } else {
        // Subscribed to something we do not act on. Recorded, not an error.
        await this.finish(providerEventId, WebhookProcessingStatus.IGNORED_DUPLICATE);
        return;
      }
      await this.finish(providerEventId, WebhookProcessingStatus.COMPLETED);
    } catch (error) {
      await this.finish(providerEventId, WebhookProcessingStatus.FAILED);
      this.logger.error(
        `Jobber webhook ${event.topic} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Withdraws an inspection whose Jobber visit was deleted.
   *
   * Handled here rather than by re-fetching, because a deleted visit and a
   * visit we cannot see return the same nothing — and only the topic knows
   * which happened. Without this the subscription would be inert: the delivery
   * recorded, the inspection left SCHEDULED on a technician's phone for work
   * that no longer exists.
   *
   * Work already under way is never cancelled from here. Once a technician has
   * started, evidence exists and someone has to decide what happens to it, so
   * that is recorded against the visit for a person rather than resolved by a
   * webhook.
   */
  private async withdrawDeletedVisit(organizationId: string, jobberVisitId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { organizationId, jobberVisitId },
      select: { id: true, status: true, startedAt: true },
    });
    if (!inspection) return;

    if (inspection.startedAt || inspection.status !== InspectionStatus.SCHEDULED) {
      await this.prisma.jobberVisitImport.updateMany({
        where: { organizationId, jobberVisitId },
        data: {
          failureCode: 'JOBBER_VISIT_DELETED_NEEDS_REVIEW',
          failureMessage:
            'Jobber deleted this visit after the inspection was already under way. Someone has to decide what happens to the work already recorded.',
        },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.inspection.update({
        where: { id: inspection.id },
        data: {
          status: InspectionStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: 'The Jobber visit this inspection came from was deleted.',
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          action: 'INSPECTION_CANCELLED',
          entityType: 'Inspection',
          entityId: inspection.id,
          metadata: { jobberVisitId, reason: 'JOBBER_VISIT_DESTROYED' },
        },
      });
      await tx.jobberVisitImport.updateMany({
        where: { organizationId, jobberVisitId },
        data: { status: JobberVisitImportStatus.IGNORED, inspectionId: null },
      });
    });
    this.logger.log(`Cancelled inspection ${inspection.id}: its Jobber visit was deleted.`);
  }

  private finish(providerEventId: string, status: WebhookProcessingStatus) {
    return this.prisma.webhookEvent.updateMany({
      where: { provider: JOBBER_SOURCE_SYSTEM, providerEventId },
      data: { status, processedAt: new Date() },
    });
  }
}
