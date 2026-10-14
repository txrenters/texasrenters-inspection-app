import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  InspectionStatus,
  InspectionType,
  JobberOutboundKind,
  JobberOutboundStatus,
  JobberVisitImportStatus,
  TbpPlanStatus,
  TbpStopStatus,
  type Prisma,
} from '@prisma/client';

import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { type AuthenticatedUser, auditActor } from '../common/auth';
import { businessDate } from '../common/business-day';
import { eraseInspectionRows } from '../common/erase-inspection';
import { ApplicationError } from '../common/errors';
import { jobInWords } from '../common/job-in-words';
import { PrismaService } from '../common/prisma.service';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { TechnicianEventsGateway } from '../realtime/technician-events.gateway';

/** On a visit's import row once the office unscheduled it here: the visit it named is about to go. */
export const UNSCHEDULED_IN_CONSOLE = 'UNSCHEDULED_IN_CONSOLE';

/** Why a visit was left on its day. Each is work somebody did, or a decision somebody made. */
export type KeptReason =
  /** Started, recorded on, or finished: a record, not a booking. */
  | 'IN_USE'
  /** Called off by a person, who kept it as their record. */
  | 'CANCELLED'
  /** A second job on the same Jobber visit has work on it. */
  | 'COMPANION_IN_USE';

/** Which visits to take off their days: every one from a day on, or the ones named. */
export interface UnscheduleInput {
  /** `YYYY-MM-DD`: every visit of the quarter on this day or later. */
  from?: string;
  /** These visits, whatever their day. */
  stopIds?: string[];
}

export interface UnschedulePreview {
  /** Booked visits that go to Jobber's Unscheduled list (or, never sent there, back to the plan). */
  booked: number;
  /** Visits with a day that were never booked: they only lose the day. */
  notBooked: number;
  kept: { stopId: string; address: string | null; date: string | null; reason: KeptReason }[];
  firstDay: string | null;
  lastDay: string | null;
  /** Some of them are in Jobber and Jobber cannot be told: unscheduling is refused. */
  jobberSwitchedOff: boolean;
}

export interface UnscheduleSummary {
  planId: string;
  /** Moved to Jobber's Unscheduled list; their inspections were deleted. */
  unscheduled: number;
  /** Booked here but never in Jobber: their inspections were deleted, nothing to tell Jobber. */
  removed: number;
  /** Never booked: only their day was taken off. */
  daysCleared: number;
  kept: UnschedulePreview['kept'];
}

/** A visit with no day: where a stop goes when it is taken off one. */
const OFF_ITS_DAY = {
  inspectionId: null,
  scheduledOn: null,
  assignedTechnicianId: null,
  positionInDay: null,
  driveSecondsForecast: null,
  // Taken off by a person, so nothing a person placed is left to keep: the
  // next build groups it like any visit without a day.
  scheduleOverriddenAt: null,
  technicianOverriddenAt: null,
  blockedCode: null,
  blockedMessage: null,
} satisfies Prisma.TbpQuarterPlanStopUncheckedUpdateInput;

const CANDIDATE_SELECT = {
  id: true,
  status: true,
  scheduledOn: true,
  assignedTechnicianId: true,
  jobberJobId: true,
  tenant: { select: { addressLine1: true } },
  inspection: {
    select: {
      id: true,
      status: true,
      startedAt: true,
      scheduledAt: true,
      jobberVisitId: true,
      jobberJobId: true,
      assignments: { where: { isCurrent: true }, take: 1, select: { technicianId: true } },
      jobberCompanions: { select: { id: true } },
    },
  },
} satisfies Prisma.TbpQuarterPlanStopSelect;

type Candidate = Prisma.TbpQuarterPlanStopGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/**
 * Takes a published benefit-package quarter's visits off their days, so the
 * office can group them again (2026-10-15: "we should have a way to unschedule
 * them too ... starting next week unschedule all tbp that was scheduled so we
 * can regroup them").
 *
 * A booked visit is undone the way Jobber undoes one when it is moved to
 * Unscheduled there (`removeWithdrawnInspection`): its inspection is deleted,
 * only while nothing was done on it, and the plan stop waits without a day.
 * Jobber is told the same way round -- the visit goes to its Unscheduled list,
 * on the same job (`TBP_VISIT_UNSCHEDULE`) -- and publishing the stop again
 * gives that same visit its new day.
 *
 * Work somebody started, recorded or finished stays where it is, and so does a
 * visit a person called off: each is reported back, never quietly skipped.
 */
@Injectable()
export class TbpUnscheduleService {
  private readonly logger = new Logger(TbpUnscheduleService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // Optional so the service builds in tests without them; the module graph
    // spec proves the running app hands them over.
    @Optional() @Inject(TechnicianEventsGateway) private readonly technicianEvents?: TechnicianEventsGateway,
    @Optional() @Inject(CacheInvalidationService) private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

  /** What unscheduling would do, changing nothing: the console's confirmation. */
  async preview(user: AuthenticatedUser, planId: string, input: UnscheduleInput): Promise<UnschedulePreview> {
    const { booked, notBooked, kept } = await this.sorted(user, planId, input);
    const days = [...booked, ...notBooked].map(dayOf).filter((day): day is string => Boolean(day)).sort();
    return {
      booked: booked.length,
      notBooked: notBooked.length,
      kept,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      jobberSwitchedOff: booked.some((stop) => stop.inspection?.jobberVisitId) && !jobberCanBeTold(),
    };
  }

  async unschedule(user: AuthenticatedUser, planId: string, input: UnscheduleInput): Promise<UnscheduleSummary> {
    const { booked, notBooked, kept } = await this.sorted(user, planId, input);
    // Refused before anything is deleted: an inspection gone here while Jobber
    // keeps its day is exactly the disagreement this exists to prevent.
    if (booked.some((stop) => stop.inspection?.jobberVisitId) && !jobberCanBeTold())
      throw new ApplicationError(
        409,
        'JOBBER_EDITS_OFF',
        'Sending changes to Jobber is switched off, so these visits cannot be moved to its Unscheduled list. Unschedule them in Jobber instead.',
      );

    const touchedDays = new Map<string, { date: Date; technicianId: string }>();
    const remember = (stop: Candidate) => {
      if (stop.scheduledOn && stop.assignedTechnicianId)
        touchedDays.set(`${stop.scheduledOn.toISOString()}|${stop.assignedTechnicianId}`, {
          date: stop.scheduledOn,
          technicianId: stop.assignedTechnicianId,
        });
    };

    let unscheduled = 0;
    let removed = 0;
    const tell: { technicianId: string; inspectionId: string; detail: string }[] = [];
    // One visit at a time, each its own transaction: a quarter is a few hundred
    // and the pooler drops a long transaction (see `deleteInspections`).
    for (const stop of booked) {
      const outcome = await this.unscheduleBooked(user, planId, stop);
      if (outcome === 'IN_USE') {
        kept.push(keptRow(stop, 'IN_USE'));
        continue;
      }
      remember(stop);
      if (outcome.inJobber) unscheduled += 1;
      else removed += 1;
      if (outcome.tell) tell.push(outcome.tell);
    }

    if (notBooked.length) {
      notBooked.forEach(remember);
      await this.prisma.tbpQuarterPlanStop.updateMany({
        where: { id: { in: notBooked.map((stop) => stop.id) }, organizationId: user.organizationId, inspectionId: null },
        data: OFF_ITS_DAY,
      });
    }

    await this.recountDays(user.organizationId, planId, [...touchedDays.values()]);
    const publishedCount = await this.prisma.tbpQuarterPlanStop.count({
      where: { planId, organizationId: user.organizationId, status: { in: [TbpStopStatus.PUBLISHED, TbpStopStatus.UNSCHEDULED] } },
    });
    await this.prisma.tbpQuarterPlan.update({ where: { id: planId }, data: { publishedCount } });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action: 'TBP_PLAN_VISITS_UNSCHEDULED',
        entityType: 'TbpQuarterPlan',
        entityId: planId,
        metadata: {
          from: input.from ?? null,
          stopIds: input.stopIds?.length ?? null,
          unscheduled,
          removed,
          daysCleared: notBooked.length,
          kept: kept.length,
        },
      },
    });

    // After every commit. The technician is told only about a job they could be
    // on their way to; the rest leave the phone at its next refresh.
    for (const job of tell) this.technicianEvents?.publish(job.technicianId, job.inspectionId, 'CANCELLED', job.detail);
    if (unscheduled + removed)
      await this.cacheInvalidation?.publish({ type: 'inspection.changed', organizationId: user.organizationId });

    this.logger.log({
      event: 'tbp_plan_visits_unscheduled',
      organizationId: user.organizationId,
      planId,
      unscheduled,
      removed,
      daysCleared: notBooked.length,
      kept: kept.length,
    });
    return { planId, unscheduled, removed, daysCleared: notBooked.length, kept };
  }

  /**
   * The plan's visits the request names, sorted: booked and free to undo, with
   * a day and never booked, and left where they are with the reason.
   */
  private async sorted(user: AuthenticatedUser, planId: string, input: UnscheduleInput) {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId: user.organizationId },
      select: { status: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    if (
      plan.status !== TbpPlanStatus.DRAFT &&
      plan.status !== TbpPlanStatus.PUBLISHED &&
      plan.status !== TbpPlanStatus.PUBLISH_FAILED
    )
      throw new ApplicationError(
        409,
        'PLAN_NOT_EDITABLE',
        `This quarter is ${plan.status.toLowerCase()}. Wait for it to finish before unscheduling visits.`,
      );

    const named = input.stopIds?.length ? [...new Set(input.stopIds)] : null;
    if (!named && !input.from)
      throw new ApplicationError(422, 'NOTHING_TO_UNSCHEDULE', 'Choose the first day to unschedule from, or the visits.');
    // From a day on means from today on: a day gone by is a record of what
    // happened, and visits missed then are moved one at a time.
    if (!named && input.from! < businessDate())
      throw new ApplicationError(422, 'DATE_PASSED', 'Unschedule from today or a later day.');
    const from = input.from ? new Date(`${input.from}T00:00:00.000Z`) : null;

    const stops = await this.prisma.tbpQuarterPlanStop.findMany({
      where: {
        planId,
        organizationId: user.organizationId,
        ...(named
          ? { id: { in: named } }
          : {
              OR: [
                // The inspection's day decides, not the stop's: Jobber may have moved it.
                { inspection: { scheduledAt: { gte: from! } } },
                {
                  inspectionId: null,
                  scheduledOn: { gte: from! },
                  status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.BLOCKED, TbpStopStatus.UNSCHEDULED] },
                },
              ],
            }),
      },
      orderBy: [{ scheduledOn: 'asc' }, { positionInDay: 'asc' }],
      select: CANDIDATE_SELECT,
    });

    const booked: Candidate[] = [];
    const notBooked: Candidate[] = [];
    const kept: UnschedulePreview['kept'] = [];
    const inspected = stops.filter((stop) => stop.inspection);
    const worked = await this.workedOn(
      inspected.flatMap((stop) => [stop.inspection!.id, ...stop.inspection!.jobberCompanions.map((c) => c.id)]),
    );
    for (const stop of stops) {
      const inspection = stop.inspection;
      if (!inspection) {
        if (stop.scheduledOn && stop.status !== TbpStopStatus.EXCLUDED) notBooked.push(stop);
        continue;
      }
      if (inspection.status === InspectionStatus.CANCELLED) kept.push(keptRow(stop, 'CANCELLED'));
      else if (inspection.status !== InspectionStatus.SCHEDULED || inspection.startedAt || worked.has(inspection.id))
        kept.push(keptRow(stop, 'IN_USE'));
      else if (inspection.jobberCompanions.some((companion) => worked.has(companion.id)))
        kept.push(keptRow(stop, 'COMPANION_IN_USE'));
      else booked.push(stop);
    }
    return { booked, notBooked, kept };
  }

  /** Inspections with a recording, a photograph or a checklist answer on them. */
  private async workedOn(inspectionIds: string[]) {
    if (!inspectionIds.length) return new Set<string>();
    const [recorded, photographed, answered] = await Promise.all([
      this.prisma.inspectionMedia.findMany({
        where: { inspectionId: { in: inspectionIds } },
        select: { inspectionId: true },
        distinct: ['inspectionId'],
      }),
      this.prisma.inspectionPhoto.findMany({
        where: { inspectionId: { in: inspectionIds } },
        select: { inspectionId: true },
        distinct: ['inspectionId'],
      }),
      this.prisma.inspectionArea.findMany({
        where: {
          inspectionId: { in: inspectionIds },
          checklistResponses: {
            some: {
              OR: [
                { isClean: { not: null } },
                { isUndamaged: { not: null } },
                { isWorking: { not: null } },
                { textValue: { not: null } },
                { numericValue: { not: null } },
              ],
            },
          },
        },
        select: { inspectionId: true },
        distinct: ['inspectionId'],
      }),
    ]);
    return new Set([...recorded, ...photographed, ...answered].map((row) => row.inspectionId));
  }

  /**
   * One booked visit undone: its inspection (and an untouched second job of the
   * same visit) deleted, Jobber told, and the stop waiting without a day.
   *
   * The inspection is claimed under its row's lock first, so a technician
   * pressing Start at the same moment either wins -- and the visit is kept -- or
   * finds nothing to start.
   */
  private async unscheduleBooked(
    user: AuthenticatedUser,
    planId: string,
    stop: Candidate,
  ): Promise<'IN_USE' | { inJobber: boolean; tell: { technicianId: string; inspectionId: string; detail: string } | null }> {
    const inspection = stop.inspection!;
    const organizationId = user.organizationId;
    const inJobber = Boolean(inspection.jobberVisitId && inspection.jobberJobId);
    const done = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.inspection.updateMany({
        where: { id: inspection.id, organizationId, startedAt: null, status: InspectionStatus.SCHEDULED },
        data: { updatedAt: new Date() },
      });
      if (!count) return false;

      if (inJobber) {
        // Re-armed, not refused, when the stop was unscheduled before: it has
        // been given a day and a new visit since, and this is that visit.
        const visit = { jobberVisitId: inspection.jobberVisitId, jobberJobId: inspection.jobberJobId };
        await tx.jobberOutboundTask.upsert({
          where: {
            organizationId_tbpStopId_kind: {
              organizationId,
              tbpStopId: stop.id,
              kind: JobberOutboundKind.TBP_VISIT_UNSCHEDULE,
            },
          },
          create: {
            organizationId,
            tbpStopId: stop.id,
            kind: JobberOutboundKind.TBP_VISIT_UNSCHEDULE,
            createdById: user.id,
            ...visit,
          },
          update: {
            status: JobberOutboundStatus.PENDING,
            attempts: 0,
            nextAttemptAt: new Date(),
            lastError: null,
            sentAt: null,
            createdById: user.id,
            ...visit,
          },
        });
        // The dated visit is not an inspection any more: the sync leaves it be,
        // and the visit that replaces it is imported when it gets a day.
        await tx.jobberVisitImport.updateMany({
          where: { organizationId, jobberVisitId: inspection.jobberVisitId! },
          data: {
            status: JobberVisitImportStatus.IGNORED,
            inspectionId: null,
            failureCode: UNSCHEDULED_IN_CONSOLE,
            failureMessage: 'Unscheduled in the console: the visit went to Jobber’s Unscheduled list on the same job.',
          },
        });
      }

      await tx.timeSegment.updateMany({ where: { organizationId, inspectionId: inspection.id }, data: { inspectionId: null } });
      for (const companion of inspection.jobberCompanions) {
        await tx.timeSegment.updateMany({ where: { organizationId, inspectionId: companion.id }, data: { inspectionId: null } });
        await eraseInspectionRows(tx, companion.id);
      }
      const erased = await eraseInspectionRows(tx, inspection.id);

      await tx.tbpQuarterPlanStop.update({
        where: { id: stop.id },
        data: {
          ...OFF_ITS_DAY,
          // In Jobber with no day; or never sent there, so simply not booked.
          status: inJobber ? TbpStopStatus.UNSCHEDULED : TbpStopStatus.PLANNED,
          // The visit with no day is written here when Jobber has made it.
          jobberVisitId: null,
          jobberJobId: inJobber ? inspection.jobberJobId : null,
        },
      });

      const scheduledOn = inspection.scheduledAt.toISOString().slice(0, 10);
      await tx.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'INSPECTION_DELETED',
          entityType: 'Inspection',
          entityId: inspection.id,
          metadata: {
            source: 'CONSOLE',
            reason: 'TBP_VISIT_UNSCHEDULED',
            planId,
            stopId: stop.id,
            scheduledOn,
            technicianId: inspection.assignments[0]?.technicianId ?? null,
            jobberVisitId: inspection.jobberVisitId,
            companions: inspection.jobberCompanions.length,
            ...erased,
          },
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'TBP_VISIT_UNSCHEDULED',
          entityType: 'TbpQuarterPlanStop',
          entityId: stop.id,
          metadata: { planId, inspectionId: inspection.id, scheduledOn, toJobberUnscheduled: inJobber },
        },
      });
      return true;
    });
    if (!done) return 'IN_USE';

    const technicianId = inspection.assignments[0]?.technicianId;
    const soon = inspection.scheduledAt.toISOString().slice(0, 10) <= nextDay(businessDate());
    return {
      inJobber,
      tell:
        technicianId && soon
          ? { technicianId, inspectionId: inspection.id, detail: jobInWords(stop.tenant?.addressLine1, inspection.scheduledAt) }
          : null,
    };
  }

  /**
   * The days visits left, counted again from what is still on them.
   *
   * Not measured again: a published day's drive is Google's or Mapbox's, and
   * re-measuring a few hundred days costs a call each. Its drive stays as it
   * was until the next build or "Optimize route" -- what changes is how many
   * visits it holds, and a day left with none is gone.
   */
  private async recountDays(organizationId: string, planId: string, days: { date: Date; technicianId: string }[]) {
    for (const day of days) {
      const left = await this.prisma.tbpQuarterPlanStop.findMany({
        where: {
          planId,
          organizationId,
          scheduledOn: day.date,
          assignedTechnicianId: day.technicianId,
          status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.PUBLISHED] },
          OR: [{ inspectionId: null }, { inspection: { status: { not: InspectionStatus.CANCELLED } } }],
        },
        select: { onSiteMinutes: true, inspectionType: true },
      });
      const where = { planId, organizationId, date: day.date, technicianId: day.technicianId };
      if (!left.length) {
        await this.prisma.tbpQuarterPlanDay.deleteMany({ where });
        continue;
      }
      await this.prisma.tbpQuarterPlanDay.updateMany({
        where,
        data: {
          stopCount: left.length,
          onSiteMinutes: left.reduce((sum, stop) => sum + (stop.onSiteMinutes ?? 0), 0),
          hvacStopCount: left.filter((stop) => stop.inspectionType === InspectionType.HVAC).length,
        },
      });
    }
  }
}

/** Jobber hears of it only when both a visit may be booked and one deleted. */
function jobberCanBeTold() {
  const config = getJobberConfig();
  return config.tbpBookingEnabled && config.pushEditsEnabled;
}

function dayOf(stop: Candidate): string | null {
  const day = stop.inspection?.scheduledAt ?? stop.scheduledOn;
  return day ? day.toISOString().slice(0, 10) : null;
}

function keptRow(stop: Candidate, reason: KeptReason): UnschedulePreview['kept'][number] {
  return { stopId: stop.id, address: stop.tenant?.addressLine1 ?? null, date: dayOf(stop), reason };
}

/** The `YYYY-MM-DD` after this one. */
function nextDay(date: string) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
