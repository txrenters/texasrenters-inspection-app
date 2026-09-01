import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberOutboundStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import { getJobberConfig } from '../../integrations/jobber/jobber.config';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import {
  JOB_NOTE_CREATE_MUTATION,
  VISIT_COMPLETE_MUTATION,
} from '../../integrations/jobber/jobber.queries';

/** How many failures before a task stops retrying and waits for a person. */
const MAX_ATTEMPTS = 6;

/** Share links pushed to Jobber live as long as the ones the office emails. */
const SHARE_LIFETIME_DAYS = 30;

const BATCH_SIZE = 25;

interface JobberUserErrors {
  userErrors?: { message: string; path?: string[] }[];
}

export interface JobberOutboundResult {
  processed: number;
  sent: number;
  failed: number;
  abandoned: number;
}

/**
 * Sends Jobber the half of the sync that flows outward.
 *
 * Deliberately narrow: a completed visit, and optionally a link to the report.
 * The ownership split this integration runs on gives Jobber the schedule and
 * gives this app everything from the technician arriving onward, so pushing
 * status detail back would create a second writer for fields Jobber does not
 * own — which is how two-way syncs start disagreeing with themselves.
 */
@Injectable()
export class JobberOutboundWorker {
  private readonly logger = new Logger(JobberOutboundWorker.name);
  private readonly config = getJobberConfig();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
  ) {}

  /** Drains what is due for one organization. */
  async run(organizationId: string): Promise<JobberOutboundResult> {
    const result: JobberOutboundResult = { processed: 0, sent: 0, failed: 0, abandoned: 0 };
    const due = await this.prisma.jobberOutboundTask.findMany({
      where: {
        organizationId,
        status: { in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED] },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH_SIZE,
    });

    for (const task of due) {
      result.processed += 1;
      try {
        await this.send(organizationId, task);
        await this.prisma.jobberOutboundTask.update({
          where: { id: task.id },
          data: {
            status: JobberOutboundStatus.SENT,
            sentAt: new Date(),
            attempts: task.attempts + 1,
            lastError: null,
          },
        });
        result.sent += 1;
      } catch (error) {
        const attempts = task.attempts + 1;
        const message =
          error instanceof JobberError ? error.message : 'The Jobber update could not be sent.';
        const abandoned = attempts >= MAX_ATTEMPTS;
        await this.prisma.jobberOutboundTask.update({
          where: { id: task.id },
          data: {
            status: abandoned ? JobberOutboundStatus.ABANDONED : JobberOutboundStatus.FAILED,
            attempts,
            lastError: message,
            // Exponential, capped at an hour: a Jobber outage should not become
            // a retry storm against a rate limiter shared with the pull.
            nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000),
          },
        });
        if (abandoned) result.abandoned += 1;
        else result.failed += 1;
        this.logger.warn(`Jobber push for inspection ${task.inspectionId} failed: ${message}`);
      }
    }
    return result;
  }

  private async send(
    organizationId: string,
    task: { id: string; inspectionId: string; jobberVisitId: string; jobberJobId: string | null; createdById: string | null },
  ) {
    /**
     * Jobber is told when the work was signed off, not when the outbox drained.
     *
     * The two differ by however long the queue waited — minutes normally, hours
     * after an outage — and the second is not a fact about the inspection.
     */
    const finalizedAt = await this.prisma.inspection.findUnique({
      where: { id: task.inspectionId },
      select: { finalizedAt: true },
    });
    const completion = await this.client.request<{ visitComplete: JobberUserErrors }>(
      organizationId,
      VISIT_COMPLETE_MUTATION,
      {
        visitId: task.jobberVisitId,
        input: { completedAt: (finalizedAt?.finalizedAt ?? new Date()).toISOString() },
      },
    );
    this.assertNoUserErrors(completion.visitComplete);

    if (!this.config.pushReportLink || !task.jobberJobId) return;
    const url = await this.reportLink(organizationId, task.inspectionId, task.createdById);
    if (!url) return;
    const note = await this.client.request<{ jobCreateNote: JobberUserErrors }>(
      organizationId,
      JOB_NOTE_CREATE_MUTATION,
      { jobId: task.jobberJobId, input: { message: `Inspection report: ${url}` } },
    );
    this.assertNoUserErrors(note.jobCreateNote);
  }

  /**
   * Jobber reports business-rule rejections inside a successful response.
   *
   * Treating a 200 with a populated `userErrors` as success is how a push
   * silently does nothing while the task is marked SENT and nobody looks again.
   */
  private assertNoUserErrors(payload: JobberUserErrors | null | undefined) {
    if (!payload?.userErrors?.length) return;
    throw new JobberError('Jobber rejected the update.', 'JOBBER_USER_ERROR', 422);
  }

  /**
   * A share link for the finished report, reusing a live one where possible.
   *
   * Minting a new token on every attempt would leave a trail of valid bearer
   * links to a tenant's home whenever a retry ran, so an unexpired, unrevoked
   * share is reused and a new one is only created when there is none.
   *
   * Returns null when the task has no owner: a share row requires a creator,
   * and attributing one to nobody would make an unauditable link.
   */
  private async reportLink(
    organizationId: string,
    inspectionId: string,
    createdById: string | null,
  ) {
    if (!createdById) return null;
    const existing = await this.prisma.inspectionReportShare.findFirst({
      where: {
        inspectionId,
        organizationId,
        revokedAt: null,
        expiresAt: { gt: new Date(Date.now() + 24 * 60 * 60 * 1_000) },
      },
      orderBy: { expiresAt: 'desc' },
      select: { token: true },
    });
    const token = existing?.token ?? randomBytes(32).toString('base64url');
    if (!existing)
      await this.prisma.inspectionReportShare.create({
        data: {
          organizationId,
          inspectionId,
          createdById,
          token,
          expiresAt: new Date(Date.now() + SHARE_LIFETIME_DAYS * 24 * 60 * 60 * 1_000),
        },
      });
    const origin = (process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '');
    return `${origin}/report/${token}`;
  }
}
