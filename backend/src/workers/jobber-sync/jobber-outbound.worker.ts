import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { tenancyZoneLabel, type VisitServicesReport } from '@texasrenters/shared';
import {
  InspectionAreaCompletionStatus,
  InspectionSource,
  InspectionStatus,
  JobberOutboundKind,
  JobberOutboundStatus,
  JobberVisitImportStatus,
  type Prisma,
} from '@prisma/client';

import { businessClockTime, businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import { jobberUserIdForEmail, linkedJobberProperty } from '../../integrations/jobber/jobber.booking';
import { getJobberConfig } from '../../integrations/jobber/jobber.config';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import { VISIT_EDIT_KINDS } from '../../integrations/jobber/jobber.outbound';
import { jobberServicesNote } from '../../integrations/jobber/jobber.services-note';
import {
  JOB_CLOSE_MUTATION,
  JOB_CREATE_MUTATION,
  JOB_NOTE_CREATE_MUTATION,
  JOB_VISITS_QUERY,
  TBP_JOB_INVOICING,
  VISIT_COMPLETE_MUTATION,
  VISIT_CREATE_MUTATION,
  VISIT_DELETE_MUTATION,
  VISIT_EDIT_ASSIGNED_USERS_MUTATION,
  VISIT_EDIT_MUTATION,
  VISIT_EDIT_SCHEDULE_MUTATION,
} from '../../integrations/jobber/jobber.queries';

/** How many failures before a task stops retrying and waits for a person. */
const MAX_ATTEMPTS = 6;

/** Share links pushed to Jobber live as long as the ones the office emails. */
const SHARE_LIFETIME_DAYS = 30;

const BATCH_SIZE = 25;

/** Failures a retry cannot fix, abandoned at once rather than after six tries. */
const PERMANENT_FAILURES = new Set(['JOBBER_BOOKING_CANCELLED', 'JOBBER_EDIT_INSPECTION_MISSING']);

/**
 * The timezone a booked visit's day is expressed in.
 *
 * Required by Jobber and not optional in `LocalDateTimeAttributes`. Texas is
 * one zone, so a constant is honest here -- and hardcoding the office rather
 * than reading the server’s clock is what stops a container in another region
 * booking every visit a day out.
 */
const VISIT_TIMEZONE = process.env.JOBBER_VISIT_TIMEZONE ?? 'America/Chicago';

/**
 * `Zone 1 - Q4 2026 Tenant Benefit Package`, as the office writes a job.
 *
 * The stop holds the zone as the tenant report does ("4", "Not Set"), so it is
 * labelled by the same rule as the stop's visit title.
 */
function jobTitle(zone: string | null, year: number, quarter: number): string {
  return [tenancyZoneLabel(zone), `Q${quarter} ${year} Tenant Benefit Package`].filter(Boolean).join(' - ');
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
        kind: { notIn: this.switchedOffKinds() },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH_SIZE,
    });

    for (const task of due) {
      result.processed += 1;
      try {
        await this.send(organizationId, task);
        await this.mark(task, {
          status: JobberOutboundStatus.SENT,
          sentAt: new Date(),
          attempts: task.attempts + 1,
          lastError: null,
        });
        result.sent += 1;
      } catch (error) {
        const attempts = task.attempts + 1;
        const message =
          error instanceof JobberError ? error.message : 'The Jobber update could not be sent.';
        const abandoned =
          attempts >= MAX_ATTEMPTS || (error instanceof JobberError && PERMANENT_FAILURES.has(error.code));
        await this.mark(task, {
          status: abandoned ? JobberOutboundStatus.ABANDONED : JobberOutboundStatus.FAILED,
          attempts,
          lastError: message,
          // Exponential, capped at an hour: a Jobber outage should not become
          // a retry storm against a rate limiter shared with the pull.
          nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000),
        });
        if (abandoned) result.abandoned += 1;
        else result.failed += 1;
        this.logger.warn(`Jobber push for inspection ${task.inspectionId} failed: ${message}`);
      }
    }
    return result;
  }

  /**
   * Records how an attempt went.
   *
   * A console edit can be re-armed by the office while it is being sent: a
   * second edit resets it to pending so the newer state goes next. So an edit
   * is marked only while it is still the attempt that was read -- otherwise
   * this would mark the newer edit sent without ever sending it. The other
   * kinds are never re-armed, and are marked as they always were.
   */
  private mark(
    task: { id: string; kind: JobberOutboundKind; attempts: number; nextAttemptAt: Date },
    data: Prisma.JobberOutboundTaskUpdateManyMutationInput,
  ) {
    if (!(VISIT_EDIT_KINDS as readonly JobberOutboundKind[]).includes(task.kind))
      return this.prisma.jobberOutboundTask.update({ where: { id: task.id }, data });
    return this.prisma.jobberOutboundTask.updateMany({
      where: { id: task.id, attempts: task.attempts, nextAttemptAt: task.nextAttemptAt },
      data,
    });
  }

  /**
   * The kinds whose switch is off, left waiting rather than attempted.
   *
   * Attempting them failed every time, and six failures abandon a task: a
   * quarter published while booking was off gave up on its visits about two
   * hours later, instead of waiting for the switch as its comment promised.
   */
  private switchedOffKinds(): JobberOutboundKind[] {
    return [
      ...(this.config.tbpBookingEnabled ? [] : [JobberOutboundKind.TBP_VISIT_CREATE]),
      ...(this.config.bookingEnabled ? [] : [JobberOutboundKind.VISIT_CREATE]),
      ...(this.config.pushEditsEnabled ? [] : VISIT_EDIT_KINDS),
    ];
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
      servicesNoteSentAt: Date | null;
      jobTitle: string | null;
    },
  ) {
    if (task.kind === JobberOutboundKind.TBP_VISIT_CREATE)
      return this.bookVisit(organizationId, task.id, task.inspectionId);
    if (task.kind === JobberOutboundKind.VISIT_CREATE) return this.bookInspectionVisit(organizationId, task);
    if (task.kind === JobberOutboundKind.VISIT_RESCHEDULE) return this.pushSchedule(organizationId, task);
    if (task.kind === JobberOutboundKind.VISIT_ASSIGN) return this.pushAssignment(organizationId, task);
    if (task.kind === JobberOutboundKind.VISIT_EDIT) return this.pushVisitText(organizationId, task);
    if (task.kind === JobberOutboundKind.VISIT_CANCEL) return this.pushCancellation(organizationId, task);

    // Only a completion reaches here, and a completion without a visit id is a
    // row that should never have been enqueued.
    if (!task.jobberVisitId)
      throw new JobberError(
        'This completion task has no Jobber visit to complete.',
        'JOBBER_TASK_MISSING_VISIT',
        500,
      );
    const jobberVisitId = task.jobberVisitId;
    // Before the completion, the order a technician would have done it in, and
    // so that a completion which then fails does not leave a finished visit
    // with no word on what was done.
    await this.sendServicesNote(organizationId, task);
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
   * Posts the technician's services report to the visit's job.
   *
   * A job note because Jobber has no note on a visit -- a visit's Notes tab is
   * its job's notes -- and the office's jobs carry one visit each. Marked sent
   * on its own, because the completion that follows can still fail and retry.
   */
  private async sendServicesNote(
    organizationId: string,
    task: { id: string; inspectionId: string; jobberJobId: string | null; servicesNoteSentAt: Date | null },
  ) {
    if (!this.config.pushServicesNote || !task.jobberJobId || task.servicesNoteSentAt) return;
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: task.inspectionId },
      select: {
        servicesReport: true,
        servicesReportedAt: true,
        submittedAt: true,
        jobberVisitDetails: true,
        areas: { select: { completionStatus: true } },
        assignments: {
          where: { isCurrent: true },
          take: 1,
          select: { technician: { select: { displayName: true } } },
        },
      },
    });
    if (!inspection?.servicesReport) return;
    const message = jobberServicesNote({
      report: inspection.servicesReport as unknown as VisitServicesReport,
      details: inspection.jobberVisitDetails,
      inspectionDone: inspection.areas.some((area) => area.completionStatus === InspectionAreaCompletionStatus.COMPLETED),
      technicianName: inspection.assignments[0]?.technician.displayName ?? null,
      recordedAt: inspection.servicesReportedAt ?? inspection.submittedAt ?? new Date(),
    });
    if (!message) return;
    const note = await this.client.request<{ jobCreateNote: JobberUserErrors }>(
      organizationId,
      JOB_NOTE_CREATE_MUTATION,
      { jobId: task.jobberJobId, input: { message } },
    );
    this.assertNoUserErrors(note.jobCreateNote);
    await this.prisma.jobberOutboundTask.update({
      where: { id: task.id },
      data: { servicesNoteSentAt: new Date() },
    });
  }

  /** Books a benefit-package visit for a published plan stop. */
  private async bookVisit(organizationId: string, taskId: string, inspectionId: string) {
    if (!this.config.tbpBookingEnabled)
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
        propertywareUnitId: true,
        plan: { select: { quarterYear: true, quarterNumber: true } },
      },
    });
    if (!stop?.visitTitle || !stop.scheduledOn || !stop.propertywareBuildingId)
      throw new JobberError(
        'This inspection has no plan stop to book from.',
        'JOBBER_TBP_STOP_MISSING',
        500,
      );

    const link = await this.bookableProperty(organizationId, {
      buildingId: stop.propertywareBuildingId,
      unitId: stop.propertywareUnitId,
    });
    await this.createVisitInJobber(organizationId, taskId, inspectionId, {
      jobberPropertyId: link.jobberPropertyId,
      // The job title carries no address; the visit title does. That is the
      // office's convention, and the visit title is the one the importer reads.
      jobTitle: jobTitle(stop.zone, stop.plan.quarterYear, stop.plan.quarterNumber),
      visitTitle: stop.visitTitle,
      instructions: stop.visitDetails,
      date: stop.scheduledOn.toISOString().slice(0, 10),
      teamMemberIds: [],
    });
  }

  /**
   * Books the visit a coordinator asked for when creating an occupied inspection.
   *
   * Read when it is sent rather than when it was queued: the day, and who is
   * assigned, may have changed in between. The title and Details were written
   * onto the inspection at creation -- the text the console previewed -- and
   * the job's title rides on the task.
   */
  private async bookInspectionVisit(
    organizationId: string,
    task: { id: string; inspectionId: string; jobTitle: string | null },
  ) {
    if (!this.config.bookingEnabled)
      throw new JobberError(
        'Booking visits in Jobber is switched off (JOBBER_BOOKING_ENABLED).',
        'JOBBER_BOOKING_DISABLED',
        503,
      );
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: task.inspectionId, organizationId },
      select: {
        status: true,
        scheduledAt: true,
        jobberVisitId: true,
        jobberVisitTitle: true,
        jobberVisitDetails: true,
        propertywareBuildingId: true,
        propertywareUnitId: true,
        assignments: {
          where: { isCurrent: true },
          take: 1,
          select: { technician: { select: { email: true } } },
        },
      },
    });
    // Booked already: the claim committed, and only marking the task sent did not.
    if (inspection?.jobberVisitId) return;
    if (!inspection || inspection.status === InspectionStatus.CANCELLED)
      throw new JobberError(
        'The inspection was cancelled before its visit was booked in Jobber.',
        'JOBBER_BOOKING_CANCELLED',
        409,
      );
    if (!inspection.jobberVisitTitle || !inspection.propertywareBuildingId)
      throw new JobberError('This inspection has no visit to book.', 'JOBBER_BOOKING_TEXT_MISSING', 500);

    const link = await this.bookableProperty(organizationId, {
      buildingId: inspection.propertywareBuildingId,
      unitId: inspection.propertywareUnitId,
    });
    const technicianJobberId = await jobberUserIdForEmail(
      this.prisma,
      organizationId,
      inspection.assignments[0]?.technician.email,
    );
    await this.createVisitInJobber(organizationId, task.id, task.inspectionId, {
      jobberPropertyId: link.jobberPropertyId,
      jobTitle: task.jobTitle ?? inspection.jobberVisitTitle,
      visitTitle: inspection.jobberVisitTitle,
      instructions: inspection.jobberVisitDetails,
      date: inspection.scheduledAt.toISOString().slice(0, 10),
      teamMemberIds: technicianJobberId ? [technicianJobberId] : [],
    });
  }

  /** The Jobber property to book against, or the reason there is none. */
  private async bookableProperty(organizationId: string, place: { buildingId: string; unitId: string | null }) {
    const link = await linkedJobberProperty(this.prisma, organizationId, place);
    if (link.status === 'LINKED') return link;
    // Refused rather than guessed. Booking against the wrong property sends a
    // technician to somebody else's home.
    throw link.status === 'AMBIGUOUS'
      ? new JobberError(
          'This property is linked to more than one Jobber property.',
          'JOBBER_PROPERTY_AMBIGUOUS',
          422,
        )
      : new JobberError('This property is not linked to a Jobber property.', 'JOBBER_PROPERTY_NOT_LINKED', 422);
  }

  /**
   * Creates the job and its one visit, then claims the visit as ours.
   *
   * Two mutations, because the office's own jobs are one-off with a single
   * visit each — 115 live TBP visits across 115 distinct jobs — so there is no
   * recurring job to hang a new visit on. `jobCreate` makes the job bare and
   * `visitCreate` supplies the title and instructions, rather than letting
   * Jobber mint the visit from the job's scheduling: the visit's instructions
   * are what `occupiedInspectionInDetails` reads to decide this is an occupied
   * inspection at all, and they have to be ours.
   *
   * Not transactional, and cannot be. If the job is created and the visit fails,
   * the job id is written to the task first so the retry books the visit onto
   * the job that already exists instead of making a second one.
   */
  private async createVisitInJobber(
    organizationId: string,
    taskId: string,
    inspectionId: string,
    booking: {
      jobberPropertyId: string;
      jobTitle: string;
      visitTitle: string;
      instructions: string | null;
      /** The whole day the visit is booked for, "2026-10-06". */
      date: string;
      /** Jobber user ids to put on the visit; empty books it unassigned. */
      teamMemberIds: string[];
    },
  ) {
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
          propertyId: booking.jobberPropertyId,
          title: booking.jobTitle,
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

    const date = booking.date;
    const booked = await this.client.request<{
      visitCreate: JobberUserErrors & { createdVisits?: { id: string }[] | null };
    }>(organizationId, VISIT_CREATE_MUTATION, {
      jobId,
      input: {
        visits: [
          {
            title: booking.visitTitle,
            instructions: booking.instructions,
            schedule: {
              // Date and timezone without a time: the visit is booked for a
              // whole day, which is exactly what `Inspection.scheduledAt`
              // (`@db.Date`) means. Inventing a clock time would put an
              // arrival promise on the technician's calendar that nothing here
              // can keep.
              startAt: { date, timezone: VISIT_TIMEZONE },
              endAt: { date, timezone: VISIT_TIMEZONE },
              // Nobody is notified by Jobber: the plan tells the office about a
              // quarter, and this app already tells a technician they are assigned.
              notifyTeam: false,
              ...(booking.teamMemberIds.length ? { teamMemberIdsToAssign: booking.teamMemberIds } : {}),
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

  /** The visit a console edit is for. Set when the edit was queued; its absence is a bad row. */
  private editedVisit(task: { jobberVisitId: string | null }): string {
    if (!task.jobberVisitId)
      throw new JobberError('This change has no Jobber visit to apply to.', 'JOBBER_TASK_MISSING_VISIT', 500);
    return task.jobberVisitId;
  }

  private async editedInspection<S extends Prisma.InspectionSelect>(
    organizationId: string,
    inspectionId: string,
    select: S,
  ) {
    const inspection = await this.prisma.inspection.findFirst({ where: { id: inspectionId, organizationId }, select });
    if (!inspection)
      throw new JobberError(
        'The inspection this change belongs to no longer exists.',
        'JOBBER_EDIT_INSPECTION_MISSING',
        404,
      );
    return inspection;
  }

  /**
   * Moves the visit to the inspection's day.
   *
   * A visit that had a clock time keeps it: the console moves the window to the
   * new day, and it is sent as that day and time in Texas. A whole-day visit
   * stays whole-day.
   */
  private async pushSchedule(organizationId: string, task: { inspectionId: string; jobberVisitId: string | null }) {
    const visitId = this.editedVisit(task);
    const inspection = await this.editedInspection(organizationId, task.inspectionId, {
      scheduledAt: true,
      scheduledStartAt: true,
      scheduledEndAt: true,
    });
    const day = inspection.scheduledAt.toISOString().slice(0, 10);
    const timed = Boolean(inspection.scheduledStartAt && inspection.scheduledEndAt);
    const at = (instant: Date | null) =>
      timed && instant
        ? { date: businessDate(instant), time: businessClockTime(instant), timezone: VISIT_TIMEZONE }
        : { date: day, timezone: VISIT_TIMEZONE };
    const response = await this.client.request<{ visitEditSchedule: JobberUserErrors }>(
      organizationId,
      VISIT_EDIT_SCHEDULE_MUTATION,
      { id: visitId, input: { startAt: at(inspection.scheduledStartAt), endAt: at(inspection.scheduledEndAt) } },
    );
    this.assertNoUserErrors(response.visitEditSchedule);
  }

  /**
   * Puts the inspection's current technician on the visit, or nobody.
   *
   * Nobody when there is no technician, and when Jobber has never reported a
   * user with their email: an unassigned Jobber visit is one the sync leaves
   * our assignment alone on, where the old assignee would be put back.
   */
  private async pushAssignment(organizationId: string, task: { inspectionId: string; jobberVisitId: string | null }) {
    const visitId = this.editedVisit(task);
    await this.editedInspection(organizationId, task.inspectionId, { id: true });
    const current = await this.prisma.inspectionAssignment.findFirst({
      where: { inspectionId: task.inspectionId, isCurrent: true },
      select: { technician: { select: { email: true } } },
    });
    const jobberUserId = current
      ? await jobberUserIdForEmail(this.prisma, organizationId, current.technician.email)
      : null;
    const response = await this.client.request<{ visitEditAssignedUsers: JobberUserErrors }>(
      organizationId,
      VISIT_EDIT_ASSIGNED_USERS_MUTATION,
      { visitId, input: { assignedUserIds: jobberUserId ? [jobberUserId] : [] } },
    );
    this.assertNoUserErrors(response.visitEditAssignedUsers);
  }

  /** Writes the inspection's visit title and Details onto the visit. */
  private async pushVisitText(organizationId: string, task: { inspectionId: string; jobberVisitId: string | null }) {
    const visitId = this.editedVisit(task);
    const inspection = await this.editedInspection(organizationId, task.inspectionId, {
      jobberVisitTitle: true,
      jobberVisitDetails: true,
    });
    const response = await this.client.request<{ visitEdit: JobberUserErrors }>(organizationId, VISIT_EDIT_MUTATION, {
      id: visitId,
      attributes: {
        ...(inspection.jobberVisitTitle != null ? { title: inspection.jobberVisitTitle } : {}),
        instructions: inspection.jobberVisitDetails ?? '',
      },
    });
    this.assertNoUserErrors(response.visitEdit);
  }

  /**
   * Takes a cancelled inspection's visit off Jobber's schedule.
   *
   * Closes the job with its open visits removed, which the office chose: the
   * job stays as closed history and can be reopened. Only when Jobber says the
   * job has no other open visit -- most of the office's jobs hold one, but 37 of
   * the ones imported hold two to five, and closing a job with other work on it
   * would take that work off the schedule too. Then only this visit is deleted,
   * and so it is when the job has more visits than one page shows.
   */
  private async pushCancellation(
    organizationId: string,
    task: { inspectionId: string; jobberVisitId: string | null; jobberJobId: string | null },
  ) {
    const visitId = this.editedVisit(task);
    const job = task.jobberJobId
      ? (
          await this.client.request<{
            job: { visits: { nodes: { id: string; isComplete: boolean }[]; pageInfo: { hasNextPage: boolean } } } | null;
          }>(organizationId, JOB_VISITS_QUERY, { id: task.jobberJobId })
        ).job
      : null;
    const onlyOpenVisit =
      job !== null &&
      !job.visits.pageInfo.hasNextPage &&
      job.visits.nodes.every((visit) => visit.id === visitId || visit.isComplete);
    if (task.jobberJobId && onlyOpenVisit) {
      const closed = await this.client.request<{ jobClose: JobberUserErrors }>(organizationId, JOB_CLOSE_MUTATION, {
        jobId: task.jobberJobId,
        input: { modifyIncompleteVisitsBy: 'DESTROY_ALL' },
      });
      this.assertNoUserErrors(closed.jobClose);
      return;
    }
    const deleted = await this.client.request<{ visitDelete: JobberUserErrors }>(organizationId, VISIT_DELETE_MUTATION, {
      visitIds: [visitId],
    });
    this.assertNoUserErrors(deleted.visitDelete);
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
