import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InspectionSource,
  JobberLinkStatus,
  JobberOutboundKind,
  JobberOutboundStatus,
  JobberVisitImportStatus,
} from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import { getJobberConfig } from '../../integrations/jobber/jobber.config';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import {
  JOB_CREATE_MUTATION,
  JOB_NOTE_CREATE_MUTATION,
  TBP_JOB_INVOICING,
  VISIT_COMPLETE_MUTATION,
  VISIT_CREATE_MUTATION,
} from '../../integrations/jobber/jobber.queries';

/** How many failures before a task stops retrying and waits for a person. */
const MAX_ATTEMPTS = 6;

/** Share links pushed to Jobber live as long as the ones the office emails. */
const SHARE_LIFETIME_DAYS = 30;

const BATCH_SIZE = 25;

/**
 * The timezone a booked visit's day is expressed in.
 *
 * Required by Jobber and not optional in `LocalDateTimeAttributes`. Texas is
 * one zone, so a constant is honest here -- and hardcoding the office rather
 * than reading the server’s clock is what stops a container in another region
 * booking every visit a day out.
 */
const VISIT_TIMEZONE = process.env.JOBBER_VISIT_TIMEZONE ?? 'America/Chicago';

/** `Zone 1 - Q4 2026 Tenant Benefit Package`, as the office writes a job. */
function jobTitle(zone: string | null, year: number, quarter: number): string {
  return [zone?.trim(), `Q${quarter} ${year} Tenant Benefit Package`].filter(Boolean).join(' - ');
}

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
    task: {
      id: string;
      inspectionId: string;
      kind: JobberOutboundKind;
      jobberVisitId: string | null;
      jobberJobId: string | null;
      createdById: string | null;
    },
  ) {
    if (task.kind === JobberOutboundKind.TBP_VISIT_CREATE)
      return this.bookVisit(organizationId, task.id, task.inspectionId);

    // Only a completion reaches here, and a completion without a visit id is a
    // row that should never have been enqueued.
    if (!task.jobberVisitId)
      throw new JobberError(
        'This completion task has no Jobber visit to complete.',
        'JOBBER_TASK_MISSING_VISIT',
        500,
      );
    const jobberVisitId = task.jobberVisitId;
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
        visitId: jobberVisitId,
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
   * Books a benefit-package visit for a published plan stop.
   *
   * Two mutations, because the office's own jobs are one-off with a single
   * visit each — 115 live TBP visits across 115 distinct jobs — so there is no
   * recurring job to hang a new quarter on. `jobCreate` makes the job bare and
   * `visitCreate` supplies the title and instructions, rather than letting
   * Jobber mint the visit from the job's scheduling: the visit's instructions
   * are what `occupiedInspectionInDetails` reads to decide this is an occupied
   * inspection at all, and they have to be ours.
   *
   * Not transactional, and cannot be. If the job is created and the visit fails,
   * the job id is written to the task first so the retry books the visit onto
   * the job that already exists instead of making a second one.
   */
  private async bookVisit(organizationId: string, taskId: string, inspectionId: string) {
    if (process.env.JOBBER_TBP_WRITE_ENABLED !== 'true')
      // A separate switch from JOBBER_SYNC_ENABLED, because this is the only
      // path that creates work in somebody else's calendar. Publishing a plan
      // while this is off produces every inspection here and leaves the visits
      // queued — which is the right way to try the whole thing once.
      throw new JobberError(
        'Booking visits in Jobber is switched off (JOBBER_TBP_WRITE_ENABLED).',
        'JOBBER_TBP_WRITE_DISABLED',
        503,
      );

    const stop = await this.prisma.tbpQuarterPlanStop.findUnique({
      where: { inspectionId },
      select: {
        visitTitle: true,
        visitDetails: true,
        scheduledOn: true,
        zone: true,
        propertywareBuildingId: true,
        plan: { select: { quarterYear: true, quarterNumber: true } },
      },
    });
    if (!stop?.visitTitle || !stop.scheduledOn || !stop.propertywareBuildingId)
      throw new JobberError(
        'This inspection has no plan stop to book from.',
        'JOBBER_TBP_STOP_MISSING',
        500,
      );

    const link = await this.prisma.jobberPropertyLink.findFirst({
      where: {
        organizationId,
        propertywareBuildingId: stop.propertywareBuildingId,
        status: JobberLinkStatus.LINKED,
      },
      select: { jobberPropertyId: true },
    });
    if (!link)
      // Refused rather than guessed. Booking against the wrong property sends a
      // technician to somebody else's home.
      throw new JobberError(
        'This property is not linked to a Jobber property.',
        'JOBBER_PROPERTY_NOT_LINKED',
        422,
      );

    const existing = await this.prisma.jobberOutboundTask.findUnique({
      where: { id: taskId },
      select: { jobberJobId: true },
    });

    // Reuse the job a previous attempt created. Without this a failure between
    // the two mutations leaves an orphan job behind on every retry.
    let jobId = existing?.jobberJobId ?? null;
    if (!jobId) {
      const created = await this.client.request<{
        jobCreate: JobberUserErrors & { job?: { id: string } | null };
      }>(organizationId, JOB_CREATE_MUTATION, {
        input: {
          propertyId: link.jobberPropertyId,
          // The job title carries no address; the visit title does. That is the
          // office's convention, and the visit title is the one the importer
          // reads.
          title: jobTitle(stop.zone, stop.plan.quarterYear, stop.plan.quarterNumber),
          invoicing: TBP_JOB_INVOICING,
        },
      });
      this.assertNoUserErrors(created.jobCreate);
      jobId = created.jobCreate.job?.id ?? null;
      if (!jobId)
        throw new JobberError('Jobber created no job.', 'JOBBER_JOB_NOT_CREATED', 502);
      await this.prisma.jobberOutboundTask.update({
        where: { id: taskId },
        data: { jobberJobId: jobId },
      });
    }

    const date = stop.scheduledOn.toISOString().slice(0, 10);
    const booked = await this.client.request<{
      visitCreate: JobberUserErrors & { createdVisits?: { id: string }[] | null };
    }>(organizationId, VISIT_CREATE_MUTATION, {
      jobId,
      input: {
        visits: [
          {
            title: stop.visitTitle,
            instructions: stop.visitDetails,
            schedule: {
              // Date and timezone without a time: the visit is booked for a
              // whole day, which is exactly what `Inspection.scheduledAt`
              // (`@db.Date`) means. Inventing a clock time would put an
              // arrival promise on the technician's calendar that nothing here
              // can keep.
              startAt: { date, timezone: VISIT_TIMEZONE },
              endAt: { date, timezone: VISIT_TIMEZONE },
              // The office is told by the plan, not by four hundred pushes.
              notifyTeam: false,
            },
          },
        ],
      },
    });
    this.assertNoUserErrors(booked.visitCreate);

    const visitId = booked.visitCreate.createdVisits?.[0]?.id;
    if (!visitId)
      throw new JobberError('Jobber created no visit.', 'JOBBER_VISIT_NOT_CREATED', 502);

    await this.claimVisit(organizationId, taskId, inspectionId, visitId, jobId);
  }

  /**
   * Records the visit we just made as one this system already owns.
   *
   * The `JobberVisitImport` row is the important half. Without it the next
   * sync sees a visit it has never met, types it `AC_FILTER_DELIVERY` from its
   * title — which is in `TYPES_NOT_SYNCED` — and either skips it or, worse,
   * creates a second inspection for work that already has one. An `IMPORTED`
   * row carrying the inspection id routes it straight to `applyChanges`.
   */
  private async claimVisit(
    organizationId: string,
    taskId: string,
    inspectionId: string,
    jobberVisitId: string,
    jobberJobId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.jobberOutboundTask.update({
        where: { id: taskId },
        data: { jobberVisitId, jobberJobId },
      });
      await tx.inspection.update({
        where: { id: inspectionId },
        data: { jobberVisitId, jobberJobId, source: InspectionSource.JOBBER },
      });
      await tx.jobberVisitImport.upsert({
        where: { organizationId_jobberVisitId: { organizationId, jobberVisitId } },
        create: {
          organizationId,
          jobberVisitId,
          jobberJobId,
          status: JobberVisitImportStatus.IMPORTED,
          inspectionId,
          attempts: 0,
        },
        update: { status: JobberVisitImportStatus.IMPORTED, inspectionId, jobberJobId },
      });
    });
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
