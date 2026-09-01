import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InspectionSource,
  InspectionStatus,
  Prisma,
  JobberConnectionStatus,
  JobberLinkStatus,
  JobberVisitImportStatus,
} from '@prisma/client';
import type { InspectionType } from '@prisma/client';

import {
  insertInspection,
  resolveInspectionPlan,
} from '../../admin/inspection-creation';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import { getJobberConfig } from '../../integrations/jobber/jobber.config';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import { JobberMappingService } from '../../integrations/jobber/jobber.mapping.service';
import { VISITS_QUERY } from '../../integrations/jobber/jobber.queries';
import { jobberVisitsPageSchema, type JobberVisit } from '../../integrations/jobber/jobber.schemas';
import {
  allowsTechnicianCapture,
  resolveVisitType,
  visitTypeRules,
} from '../../integrations/jobber/jobber.visit-type';

/**
 * Page size.
 *
 * Jobber prices a connection as `first` × requested fields. This query selects
 * roughly twenty, so 25 nodes costs ~500 points against a 10,000 bucket that
 * refills at 500/second — one page per second, indefinitely, with headroom.
 */
const PAGE_SIZE = 25;

/** A guard against a filter that does not narrow the way we think it does. */
const MAX_PAGES = 200;

export interface JobberSyncResult {
  correlationId: string;
  visitsSeen: number;
  imported: number;
  rescheduled: number;
  unmatched: number;
  rejected: number;
  skipped: number;
}

/**
 * The clock window a visit carries, or nulls when it has none.
 *
 * Jobber returns a `startAt` even for an all-day visit, so `allDay` is the only
 * honest signal that there is no time. Storing that midnight instead would put
 * "12:00 AM" in front of a technician for a visit nobody timed.
 */
function visitWindow(visit: JobberVisit) {
  if (visit.allDay || !visit.startAt) return { start: null, end: null };
  return {
    start: new Date(visit.startAt),
    end: visit.endAt ? new Date(visit.endAt) : null,
  };
}

const sameInstant = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** The day a timestamp falls on, as the DATE column stores it. */
const dayOf = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);

@Injectable()
export class JobberSyncWorker {
  private readonly logger = new Logger(JobberSyncWorker.name);
  private readonly config = getJobberConfig();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
    @Inject(JobberMappingService) private readonly mapping: JobberMappingService,
  ) {}

  /**
   * One pass over an organization's Jobber calendar.
   *
   * Every visit ends in a recorded outcome — imported, held, or refused with a
   * code. Nothing is dropped silently, because a visit this sync ignored is a
   * property visit nobody is going to.
   */
  async run(organizationId: string): Promise<JobberSyncResult> {
    const correlationId = randomUUID();
    const result: JobberSyncResult = {
      correlationId,
      visitsSeen: 0,
      imported: 0,
      rescheduled: 0,
      unmatched: 0,
      rejected: 0,
      skipped: 0,
    };
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (connection?.status !== JobberConnectionStatus.CONNECTED)
      throw new JobberError(
        'This organization has not authorized Jobber.',
        'JOBBER_NOT_CONNECTED',
        409,
      );

    await this.prisma.jobberConnection.update({
      where: { organizationId },
      data: { lastSyncStartedAt: new Date(), lastSyncError: null },
    });

    try {
      // Built once for the whole run rather than per visit: the building set is
      // small, and re-reading it per page would be the most expensive thing here.
      const index = await this.mapping.buildingIndex(organizationId);
      const rules = visitTypeRules();
      const window = this.window();
      let cursor: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { data, cost } = await this.client.requestDetailed(
          organizationId,
          VISITS_QUERY,
          { first: PAGE_SIZE, after: cursor, ...window },
          correlationId,
        );
        const parsed = jobberVisitsPageSchema.safeParse(data);
        if (!parsed.success)
          // A shape we do not recognise stops the run. Continuing would mean
          // writing inspections from fields we cannot vouch for.
          throw new JobberError(
            'Jobber returned visits in an unexpected shape.',
            'JOBBER_VISIT_SCHEMA_MISMATCH',
            502,
          );

        for (const visit of parsed.data.visits.nodes) {
          result.visitsSeen += 1;
          await this.processVisit(organizationId, visit, index, rules, result);
        }

        const { hasNextPage, endCursor } = parsed.data.visits.pageInfo;
        if (!hasNextPage || !endCursor) break;
        cursor = endCursor;
        await this.pace(cost);
      }

      await this.prisma.jobberConnection.update({
        where: { organizationId },
        data: { lastSyncCompletedAt: new Date(), lastSyncVisitCount: result.visitsSeen },
      });
      return result;
    } catch (error) {
      const message =
        error instanceof JobberError || error instanceof ApplicationError
          ? error.message
          : 'The Jobber sync failed.';
      await this.prisma.jobberConnection.update({
        where: { organizationId },
        data: { lastSyncError: message },
      });
      throw error;
    }
  }

  /**
   * The slice of calendar this sync cares about.
   *
   * A moving window, not an "updated since" cursor. A visit moved from next
   * week to next month has to be seen at both ends for the move to register,
   * and an incremental cursor keyed on modification time would show it once, in
   * a window that no longer contains it.
   */
  private window() {
    const now = Date.now();
    const day = 86_400_000;
    return {
      startAfter: new Date(now - this.config.syncLookbackDays * day).toISOString(),
      startBefore: new Date(now + this.config.syncHorizonDays * day).toISOString(),
    };
  }

  /**
   * Waits out the leaky bucket when a page has drained it.
   *
   * Jobber refuses a query whose estimated cost exceeds what is currently
   * available, so pacing on the returned balance avoids the refusal rather than
   * recovering from it. Doing nothing while there is headroom keeps a small
   * calendar fast.
   */
  private async pace(cost?: { throttleStatus: { currentlyAvailable: number; restoreRate: number } }) {
    if (!cost?.throttleStatus) return;
    const { currentlyAvailable, restoreRate } = cost.throttleStatus;
    const needed = PAGE_SIZE * 20;
    if (currentlyAvailable >= needed || restoreRate <= 0) return;
    const seconds = (needed - currentlyAvailable) / restoreRate;
    await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 30) * 1_000));
  }

  private async processVisit(
    organizationId: string,
    visit: JobberVisit,
    index: Map<string, string[]>,
    rules: Record<InspectionType, string[]>,
    result: JobberSyncResult,
  ) {
    const existing = await this.prisma.jobberVisitImport.findUnique({
      where: { organizationId_jobberVisitId: { organizationId, jobberVisitId: visit.id } },
      select: { id: true, status: true, inspectionId: true },
    });

    // A visit a person has already ruled out stays ruled out. Re-deciding it
    // every run is how a queue somebody cleared fills straight back up.
    if (existing?.status === JobberVisitImportStatus.IGNORED) {
      result.skipped += 1;
      return;
    }

    const record = await this.prisma.jobberVisitImport.upsert({
      where: { organizationId_jobberVisitId: { organizationId, jobberVisitId: visit.id } },
      create: {
        organizationId,
        jobberVisitId: visit.id,
        jobberJobId: visit.job?.id ?? null,
        payload: visit as object,
        attempts: 1,
        lastAttemptAt: new Date(),
      },
      update: {
        jobberJobId: visit.job?.id ?? null,
        payload: visit as object,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
      select: { id: true },
    });

    if (existing?.status === JobberVisitImportStatus.IMPORTED && existing.inspectionId) {
      await this.applyChanges(organizationId, visit, existing.inspectionId, result);
      return;
    }

    if (!visit.property?.id) {
      await this.reject(record.id, 'JOBBER_VISIT_HAS_NO_PROPERTY', 'This visit has no property in Jobber.', result);
      return;
    }
    if (!visit.startAt) {
      // Unscheduled in Jobber. Held rather than refused: it becomes importable
      // the moment somebody puts it on a day, with no human step here.
      await this.hold(record.id, JobberVisitImportStatus.PENDING, 'JOBBER_VISIT_UNSCHEDULED', 'This visit has no date in Jobber yet.', result);
      return;
    }

    const link = await this.mapping.resolveProperty(
      organizationId,
      {
        jobberPropertyId: visit.property.id,
        jobberClientId: visit.client?.id ?? null,
        jobberClientName: visit.client?.name ?? null,
        addressLine1: visit.property.address?.street1 ?? null,
        addressLine2: visit.property.address?.street2 ?? null,
        city: visit.property.address?.city ?? null,
        state: visit.property.address?.province ?? null,
        postalCode: visit.property.address?.postalCode ?? null,
      },
      index,
    );
    if (link.status !== JobberLinkStatus.LINKED || !link.propertywareBuildingId) {
      await this.prisma.jobberVisitImport.update({
        where: { id: record.id },
        data: {
          linkId: link.id,
          status: JobberVisitImportStatus.UNMATCHED_PROPERTY,
          failureCode: 'JOBBER_PROPERTY_UNMATCHED',
          failureMessage: link.unresolvedReason ?? 'This Jobber property is not mapped yet.',
        },
      });
      result.unmatched += 1;
      return;
    }

    const type = resolveVisitType(visit.title, rules);
    if (type.outcome !== 'RESOLVED') {
      await this.reject(
        record.id,
        type.outcome === 'AMBIGUOUS' ? 'JOBBER_VISIT_TYPE_AMBIGUOUS' : 'JOBBER_VISIT_TYPE_UNKNOWN',
        type.outcome === 'AMBIGUOUS'
          ? `This visit's title matches ${type.matches.length} inspection types. Rename it or set the type by hand.`
          : 'No inspection type matches this visit title.',
        result,
        link.id,
      );
      return;
    }

    try {
      const inspectionId = await this.prisma.$transaction(async (tx) => {
        const plan = await resolveInspectionPlan(tx, {
          organizationId,
          buildingId: link.propertywareBuildingId!,
          unitId: link.propertywareUnitId,
          leaseId: link.propertywareLeaseId,
          inspectionType: type.inspectionType,
          // Only for the off-cycle types — see allowsTechnicianCapture. Without
          // it these are refused outright on a property with no approved plan,
          // which is currently every property in this portfolio.
          allowTechnicianAreaCapture: allowsTechnicianCapture(type.inspectionType),
          scheduledAt: dayOf(visit.startAt!),
          scheduledStartAt: visitWindow(visit).start,
          scheduledEndAt: visitWindow(visit).end,
        });
        const inspection = await insertInspection(tx, plan, {
          priority: 'STANDARD',
          // No human created this, and attributing it to one would put a name
          // against a decision nobody made.
          createdById: null,
          source: InspectionSource.JOBBER,
          jobberVisitId: visit.id,
          jobberJobId: visit.job?.id ?? null,
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            action: 'INSPECTION_CREATED_FROM_JOBBER',
            entityType: 'Inspection',
            entityId: inspection.id,
            metadata: {
              jobberVisitId: visit.id,
              jobberJobId: visit.job?.id ?? null,
              inspectionType: type.inspectionType,
              areasInspected: plan.scopedAreas.length,
            },
          },
        });
        return inspection.id;
      });
      await this.prisma.jobberVisitImport.update({
        where: { id: record.id },
        data: {
          linkId: link.id,
          status: JobberVisitImportStatus.IMPORTED,
          inspectionId,
          failureCode: null,
          failureMessage: null,
        },
      });
      result.imported += 1;
    } catch (error) {
      // A scheduling rule refusing this visit is information, not a crash: the
      // office needs to see "no approved areas" against the visit that hit it.
      // Anything that is not an ApplicationError is a real fault and stops the run.
      if (!(error instanceof ApplicationError)) throw error;
      await this.reject(record.id, error.code, error.message, result, link.id);
    }
  }

  /**
   * Applies a Jobber-side change to an inspection we already created.
   *
   * The ownership split is enforced here: Jobber owns the schedule, and only
   * until a technician arrives. Once `startedAt` is set, a reschedule becomes a
   * note for the office instead of a silent move — evidence is already being
   * collected against the original visit, and `finalizedAt` freezes it for good.
   */
  private async applyChanges(
    organizationId: string,
    visit: JobberVisit,
    inspectionId: string,
    result: JobberSyncResult,
  ) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        scheduledAt: true,
        scheduledStartAt: true,
        scheduledEndAt: true,
      },
    });
    if (!inspection) {
      result.skipped += 1;
      return;
    }
    if (!visit.startAt) {
      result.skipped += 1;
      return;
    }
    /**
     * The schedule itself is the comparison, because `Visit` has no `updatedAt`.
     *
     * That turned out to be the better signal regardless: it detects the change
     * this sync exists to propagate, rather than firing on any edit to any
     * field. Our own `updatedAt` is unusable here — it moves every time a
     * technician touches the inspection, so ordinary local progress would read
     * as a reschedule.
     */
    const window = visitWindow(visit);
    const changed =
      inspection.scheduledAt.getTime() !== dayOf(visit.startAt).getTime() ||
      !sameInstant(inspection.scheduledStartAt, window.start) ||
      !sameInstant(inspection.scheduledEndAt, window.end);
    if (!changed) {
      result.skipped += 1;
      return;
    }
    if (inspection.startedAt || inspection.status !== InspectionStatus.SCHEDULED) {
      await this.prisma.jobberVisitImport.updateMany({
        where: { organizationId, jobberVisitId: visit.id },
        data: {
          failureCode: 'JOBBER_RESCHEDULE_NEEDS_REVIEW',
          failureMessage:
            'Jobber moved this visit after the inspection was already under way. Someone has to decide what happens to the work already recorded.',
        },
      });
      result.skipped += 1;
      return;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.inspection.update({
          where: { id: inspectionId },
          data: {
            scheduledAt: dayOf(visit.startAt!),
            scheduledStartAt: window.start,
            scheduledEndAt: window.end,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            action: 'INSPECTION_RESCHEDULED_FROM_JOBBER',
            entityType: 'Inspection',
            entityId: inspectionId,
            metadata: { jobberVisitId: visit.id, scheduledAt: visit.startAt },
          },
        });
      });
      result.rescheduled += 1;
    } catch (error) {
      /**
       * Jobber moved this visit onto a day that already holds the same booking.
       *
       * `Inspection_scheduled_booking_key` refuses it, and rightly — but a
       * clash on one visit must not end the run and strand every visit after
       * it, so this is recorded against that visit and the sync moves on. It
       * needs a person either way: the office has two bookings for the same
       * work and only they can say which survives.
       */
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        await this.prisma.jobberVisitImport.updateMany({
          where: { organizationId, jobberVisitId: visit.id },
          data: {
            failureCode: 'JOBBER_RESCHEDULE_CLASHES',
            failureMessage:
              'Jobber moved this visit onto a day that already has the same inspection booked.',
          },
        });
        result.skipped += 1;
        return;
      }
      throw error;
    }
  }

  private async reject(
    importId: string,
    failureCode: string,
    failureMessage: string,
    result: JobberSyncResult,
    linkId?: string,
  ) {
    await this.prisma.jobberVisitImport.update({
      where: { id: importId },
      data: { status: JobberVisitImportStatus.REJECTED, failureCode, failureMessage, ...(linkId ? { linkId } : {}) },
    });
    result.rejected += 1;
  }

  private async hold(
    importId: string,
    status: JobberVisitImportStatus,
    failureCode: string,
    failureMessage: string,
    result: JobberSyncResult,
  ) {
    await this.prisma.jobberVisitImport.update({
      where: { id: importId },
      data: { status, failureCode, failureMessage },
    });
    result.skipped += 1;
  }
}
