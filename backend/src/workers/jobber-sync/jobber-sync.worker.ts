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
import { InspectionType } from '@prisma/client';

import {
  insertInspection,
  resolveInspectionPlan,
} from '../../admin/inspection-creation';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import { getJobberConfig } from '../../integrations/jobber/jobber.config';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import {
  JobberMappingService,
  type BuildingIndex,
} from '../../integrations/jobber/jobber.mapping.service';
import {
  visitsQuery,
  VISIT_BY_ID_QUERY,
  VISIT_DETAILS_FIELD,
} from '../../integrations/jobber/jobber.queries';
import { jobberVisitsPageSchema, type JobberVisit } from '../../integrations/jobber/jobber.schemas';
import {
  allowsTechnicianCapture,
  isSyncedType,
  notSyncedReason,
  namesAnInspection,
  NOT_AN_INSPECTION_REASON,
  resolveVisitType,
  visitTypeRules,
  occupiedInspectionInDetails,
  type VisitTypeResolution,
} from '../../integrations/jobber/jobber.visit-type';
import {
  resolveAssignment,
  unknownAssigneeReason,
} from '../../integrations/jobber/jobber.assignment';

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

/**
 * How many times a throttled page is retried before the run gives up.
 *
 * Five, with doubling waits, is roughly four minutes of patience — far longer
 * than Jobber's bucket needs to refill, and short enough that a genuine outage
 * still ends the run rather than hanging on it.
 */
const THROTTLE_RETRIES = 5;
const THROTTLE_BACKOFF_SECONDS = 5;

export interface JobberSyncResult {
  correlationId: string;
  visitsSeen: number;
  imported: number;
  rescheduled: number;
  unmatched: number;
  rejected: number;
  /** Already finished in Jobber. Counted separately because it is the largest
   * group by far and is not a problem — 90 of the first 211 visits. */
  alreadyComplete: number;
  /** Typed, but a type this integration does not import. Also not a problem. */
  notSynced: number;
  /** Technicians copied across from Jobber this run. */
  assigned: number;
  /**
   * Inspections closed because Jobber says the visit is finished.
   *
   * Distinct from `alreadyComplete`, which counts visits that were finished
   * before we ever imported them. This counts inspections that existed here,
   * were never worked in this app, and have now been closed to match Jobber.
   */
  completedFromJobber: number;
  skipped: number;
  /**
   * Jobber still had more pages when the run stopped.
   *
   * `MAX_PAGES × PAGE_SIZE` is 5,000 visits, and the loop simply falls out at
   * the cap. Before this the result was indistinguishable from a complete run:
   * a truncated sync reported a number and nothing said the number was partial.
   * That matters most for exactly the case this field was added for — widening
   * the window to backfill a quarter, where the visit count is unknown in
   * advance and the cap is reachable.
   */
  truncated: boolean;
}

/** The slice of calendar a run covers. ISO 8601, as Jobber's filter wants. */
export interface JobberSyncWindow {
  startAfter: string;
  startBefore: string;
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

/**
 * Jobber saying the details field does not exist, rather than any other error.
 *
 * Matched on the field name as well as the phrasing so an unrelated validation
 * failure is never mistaken for this one and silently swallowed -- that would
 * turn a real schema mismatch into a sync that quietly drops data.
 */
function mentionsUnknownDetailsField(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.toLowerCase();
  return (
    text.includes(VISIT_DETAILS_FIELD) &&
    (text.includes("doesn't exist") ||
      text.includes('does not exist') ||
      text.includes('undefined field') ||
      text.includes('cannot query field'))
  );
}

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
  async run(organizationId: string, over?: JobberSyncWindow): Promise<JobberSyncResult> {
    const correlationId = randomUUID();
    const result: JobberSyncResult = {
      correlationId,
      visitsSeen: 0,
      imported: 0,
      rescheduled: 0,
      unmatched: 0,
      rejected: 0,
      alreadyComplete: 0,
      notSynced: 0,
      assigned: 0,
      completedFromJobber: 0,
      skipped: 0,
      truncated: false,
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
      /**
       * The rolling window unless a caller names one.
       *
       * The scheduled sync wants the moving window and always will. A backfill
       * wants a fixed slice of the past -- the third quarter, say -- which the
       * rolling one cannot reach: the lookback is seven days, so anything older
       * than a week is invisible to every run no matter how often it runs. That
       * is why only September appeared in the console.
       */
      const window = over ?? this.window();
      let cursor: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { data, cost } = await this.fetchVisitsPageWithRetry(
          organizationId,
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
        // The last page allowed, and Jobber has more. Said out loud rather
        // than left as a number that looks complete.
        if (page === MAX_PAGES - 1) {
          result.truncated = true;
          this.logger.warn({
            event: 'jobber_sync_truncated',
            correlationId,
            visitsSeen: result.visitsSeen,
            reason: `Stopped at the ${MAX_PAGES}-page cap with more visits pending.`,
          });
        }
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
   * Processes exactly one visit, for the webhook path.
   *
   * Deliberately the same `processVisit` the paged sync uses. A webhook tells
   * us *that* a visit changed and nothing more — the payload carries only an
   * id — so this fetches it and hands it to the one place that knows what a
   * visit is allowed to become. A second writer here would drift from the
   * sync's rules the first time either changed.
   *
   * The building index is rebuilt for a single visit, which is wasteful and
   * fine: it is one query over ~145 rows, against a webhook that must return
   * inside a second and is therefore already running off the request thread.
   */
  async syncVisit(organizationId: string, jobberVisitId: string): Promise<JobberSyncResult> {
    const correlationId = randomUUID();
    const result: JobberSyncResult = {
      correlationId,
      visitsSeen: 0,
      imported: 0,
      rescheduled: 0,
      unmatched: 0,
      rejected: 0,
      alreadyComplete: 0,
      notSynced: 0,
      assigned: 0,
      completedFromJobber: 0,
      skipped: 0,
      truncated: false,
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

    const data = await this.client.request(
      organizationId,
      VISIT_BY_ID_QUERY,
      { ids: [jobberVisitId] },
      correlationId,
    );
    const parsed = jobberVisitsPageSchema.safeParse(data);
    if (!parsed.success)
      throw new JobberError(
        'Jobber returned a visit in an unexpected shape.',
        'JOBBER_VISIT_SCHEMA_MISMATCH',
        502,
      );
    const visit = parsed.data.visits.nodes[0];
    // Deleted in Jobber between the webhook firing and this fetch, or never
    // visible to us. Not an error: the periodic sweep is what reconciles
    // anything this path cannot see.
    if (!visit) {
      result.skipped += 1;
      return result;
    }

    result.visitsSeen = 1;
    await this.processVisit(
      organizationId,
      visit,
      await this.mapping.buildingIndex(organizationId),
      visitTypeRules(),
      result,
    );
    return result;
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
    // Capped, but generously. Thirty seconds was not enough to outlast a
    // drained bucket on a quarter-wide backfill: the next page fired early,
    // Jobber answered THROTTLED, and the run ended. The cap exists to stop a
    // pathological sleep, not to cut a legitimate one short.
    await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 120) * 1_000));
  }

  /**
   * One page of visits, dropping the details field if Jobber rejects it.
   *
   * `instructions` is the only field in that query whose name is not proven
   * against this account pinned schema -- it was added to read
   * "+ Occupied Inspection" out of a Tenant Benefit Package visit. An unknown
   * field fails the *whole* query in GraphQL, so without this a wrong guess
   * would stop every sync to gain one enrichment.
   *
   * Remembered for the life of the process rather than retried per page: the
   * answer cannot change mid-run, and retrying each page would double every
   * request for the whole run.
   */
  private detailsFieldRejected = false;

  /**
   * The same page, after waiting out a throttle.
   *
   * `JobberClient` already decides that a THROTTLED response is recoverable and
   * sets `retryable` on the error — and nothing read it, so the sync aborted on
   * a failure it had itself labelled as temporary. A quarter-wide backfill died
   * this way after importing forty inspections: the work was done, the run
   * reported a rejection, and the remaining pages were simply never fetched.
   *
   * Retrying the *same cursor* rather than advancing, because a rejected page
   * returned nothing — moving on would skip the visits it would have carried,
   * silently, which is the one outcome worse than stopping.
   */
  private async fetchVisitsPageWithRetry(
    organizationId: string,
    variables: Record<string, unknown>,
    correlationId?: string,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.fetchVisitsPage(organizationId, variables, correlationId);
      } catch (error) {
        const recoverable = error instanceof JobberError && error.retryable;
        if (!recoverable || attempt >= THROTTLE_RETRIES) throw error;
        // Jobber's bucket refills on a clock, so waiting longer each time is
        // the whole remedy; there is nothing to negotiate.
        const seconds = Math.min(2 ** attempt * THROTTLE_BACKOFF_SECONDS, 120);
        this.logger.warn({
          event: 'jobber_sync_throttled_retry',
          correlationId,
          attempt: attempt + 1,
          waitingSeconds: seconds,
        });
        await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
      }
    }
  }

  private async fetchVisitsPage(
    organizationId: string,
    variables: Record<string, unknown>,
    correlationId?: string,
  ) {
    try {
      return await this.client.requestDetailed(
        organizationId,
        visitsQuery(this.detailsFieldRejected ? null : VISIT_DETAILS_FIELD),
        variables,
        correlationId,
      );
    } catch (error) {
      if (this.detailsFieldRejected || !mentionsUnknownDetailsField(error)) throw error;
      this.detailsFieldRejected = true;
      this.logger.warn({
        event: 'jobber_visit_details_field_rejected',
        field: VISIT_DETAILS_FIELD,
        // Said explicitly because the consequence is silent otherwise: the sync
        // keeps working and only the occupied-inspection rule stops firing.
        consequence: 'Occupied inspections inside filter-delivery visits will not be detected.',
      });
      return this.client.requestDetailed(
        organizationId,
        visitsQuery(null),
        variables,
        correlationId,
      );
    }
  }

  private async processVisit(
    organizationId: string,
    visit: JobberVisit,
    index: BuildingIndex,
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

    /**
     * Work that had already happened before we ever saw it.
     *
     * The window reaches seven days into the past, so a normal run sees plenty
     * of finished visits — 90 of the first 211. Turning those into inspections
     * would put jobs on a technician's phone that somebody already did.
     *
     * Checked after the imported branch on purpose: a visit completed *since*
     * we created its inspection keeps that inspection and its link, because the
     * work it represents is real and may still be under review here.
     *
     * Jobber cannot express "not completed" in its filter — `status` takes a
     * single enum value and `ACTIVE` returns everything — so this is the only
     * place the distinction can be made.
     */
    const titled = resolveVisitType(visit.title, rules);
    /**
     * A filter delivery whose details say a walkthrough happens too.
     *
     * This office books both as one visit -- "Q3 2026 Tenant Benefit Package"
     * with details reading "Filter Change ... + Occupied Inspection" -- so the
     * title alone typed it a delivery and dropped it. Seventy-three of them,
     * and not one occupied inspection had ever reached this system.
     *
     * Only ever upgrades a delivery, never anything else: see
     * `occupiedInspectionInDetails` for why free text must not overrule a title
     * somebody chose.
     */
    const type: VisitTypeResolution =
      titled.outcome === 'RESOLVED' &&
      titled.inspectionType === InspectionType.AC_FILTER_DELIVERY &&
      occupiedInspectionInDetails(visit.instructions)
        ? { outcome: 'RESOLVED', inspectionType: InspectionType.OCCUPIED }
        : titled;

    const isComplete = Boolean(visit.completedAt || visit.visitStatus === 'COMPLETED');

    /**
     * A move-in that was walked before we ever saw it.
     *
     * Kept, where every other finished visit is skipped, because this one has a
     * job left to do here: it is the baseline a later move-out is compared
     * against. Jobber closes a move-in when the visit completes, and the
     * walkthrough itself happened in Inspect & Cloud, so the record arrives
     * finished and empty — which is exactly the shape the report import
     * consumes. Without it there is nothing to seed, and the move-out has
     * nothing to compare against.
     *
     * Recorded `COMPLETED`, never `SCHEDULED`. That is what answers the concern
     * the skip was written for: the technician queue is `SCHEDULED` and
     * `IN_PROGRESS` only, so a finished visit cannot reappear as work somebody
     * already did.
     *
     * Deliberately move-ins alone. Of the 130 finished visits sitting here, 47
     * are filter deliveries and 77 carry a job number for a title and no type
     * at all; importing those would be inventing history rather than recovering
     * it. Only a move-in is owed a baseline.
     */
    const isRecoverableMoveIn =
      type.outcome === 'RESOLVED' &&
      type.inspectionType === InspectionType.MOVE_IN &&
      Boolean(visit.property?.id) &&
      Boolean(visit.startAt);

    if (isComplete && !isRecoverableMoveIn) {
      await this.prisma.jobberVisitImport.update({
        where: { id: record.id },
        data: {
          status: JobberVisitImportStatus.SKIPPED_COMPLETE,
          failureCode: null,
          failureMessage: null,
        },
      });
      result.alreadyComplete += 1;
      return;
    }

    /**
     * Other work, not an inspection.
     *
     * The maintenance calendar is most of what Jobber holds — cleaning, a water
     * leak, drywall, a smoke alarm, and repair work orders on the very
     * equipment the type rules name. Ten of those resolved to HVAC and were
     * imported as inspections; eighteen more matched nothing and were *refused*,
     * which put them in the console as a queue of work waiting for a person.
     * Neither was ever going to become an inspection.
     *
     * Skipped rather than refused, for the reason the filter-delivery branch
     * below gives: this is a decision already made, not a question for someone.
     *
     * Placed after the completed branch so a finished visit keeps
     * SKIPPED_COMPLETE, which says more about it than this would — and before
     * the property is resolved, which is the ordering `notSyncedReason` had to
     * learn: resolving first put work we never import into the mapping queue as
     * addresses to reconcile.
     */
    if (!namesAnInspection(visit.title, visit.instructions)) {
      await this.prisma.jobberVisitImport.update({
        where: { id: record.id },
        data: {
          status: JobberVisitImportStatus.SKIPPED_NOT_SYNCED,
          failureCode: null,
          failureMessage: NOT_AN_INSPECTION_REASON,
        },
      });
      result.notSynced += 1;
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

    /**
     * Typed, but a type this integration does not import.
     *
     * Checked before the outcome branch below so it reads as a decision rather
     * than a failure: filter delivery resolves perfectly well, it simply is not
     * an inspection.
     *
     * And checked before the property is resolved, which is the ordering that
     * matters. Resolving the property first meant a filter delivery at an
     * unmapped address created a mapping-queue entry — so the console listed
     * properties to map on behalf of work it was never going to import. Five of
     * six live entries were exactly that.
     */
    if (type.outcome === 'RESOLVED' && !isSyncedType(type.inspectionType)) {
      await this.prisma.jobberVisitImport.update({
        where: { id: record.id },
        data: {
          status: JobberVisitImportStatus.SKIPPED_NOT_SYNCED,
          failureCode: null,
          failureMessage: notSyncedReason(type.inspectionType),
        },
      });
      result.notSynced += 1;
      return;
    }
    if (type.outcome !== 'RESOLVED') {
      await this.reject(
        record.id,
        type.outcome === 'AMBIGUOUS' ? 'JOBBER_VISIT_TYPE_AMBIGUOUS' : 'JOBBER_VISIT_TYPE_UNKNOWN',
        type.outcome === 'AMBIGUOUS'
          ? `This visit's title matches ${type.matches.length} inspection types. Rename it or set the type by hand.`
          : 'No inspection type matches this visit title.',
        result,
      );
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
          // Only ever set for the recovered move-ins above: work Jobber had
          // already closed arrives finished, and must not read as scheduled.
          ...(isComplete
            ? {
                status: InspectionStatus.COMPLETED,
                completedAt: visit.completedAt ? new Date(visit.completedAt) : new Date(),
              }
            : {}),
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
      await this.applyAssignment(organizationId, visit, inspectionId, result);
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

    /**
     * Assignment is reconciled on every pass, not only at import.
     *
     * This is the case that actually matters here. Coordinators schedule 15 to
     * 30 days ahead and attach a technician afterwards, so the visit almost
     * always arrives before its assignee does. Copying assignment only at
     * creation would leave every one of those inspections unassigned for good.
     */
    await this.applyAssignment(organizationId, visit, inspectionId, result);

    /**
     * Jobber says the visit is finished.
     *
     * Checked before the reschedule comparison: a completed visit is not a
     * move, and comparing its window would either do nothing or mistake the
     * completion for a change of plan.
     */
    if (visit.completedAt || visit.visitStatus === 'COMPLETED') {
      await this.completeFromJobber(organizationId, visit, inspection, result);
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

  /**
   * Puts Jobber's technician on our inspection, when we recognise them.
   *
   * Never guesses. About half the assignees on a live calendar are Jobber users
   * this app does not know, and putting the wrong technician on an inspection
   * sends the wrong person to somebody's home. An unrecognised assignee is
   * recorded by name against the visit and the inspection stays unassigned,
   * which the console already surfaces on its own.
   *
   * Work in progress is left alone: once a technician has started, reassigning
   * underneath them would move evidence they are actively collecting.
   */
  /**
   * Closes an inspection because Jobber says its visit is finished.
   *
   * Technicians are still working in Jobber while this app is rolled out, so
   * the common case is a visit completed there that was never opened here.
   * Without this the inspection sits SCHEDULED for ever: the sync window only
   * reaches seven days back, so once the visit falls out of it nothing will
   * ever look at that inspection again.
   *
   * COMPLETED, but deliberately **not** finalized. `finalizedAt` is an
   * administrator's sign-off on a report, it freezes the evidence permanently,
   * and spec §11 reserves it for a human — none of which a webhook may claim,
   * least of all for an inspection that holds no evidence at all. Everything
   * that governs frozen evidence keys on `finalizedAt` rather than the status,
   * so leaving it null keeps all of it correct. `completedAt` carries Jobber's
   * own timestamp, because that is when the work actually finished.
   *
   * Work under way here is never touched. Once a technician has started, this
   * app holds evidence and its own lifecycle owns the outcome — an
   * administrator finalizes it. That guard is also what stops a loop: our own
   * completion push makes Jobber fire VISIT_COMPLETE straight back at us, and
   * by then the inspection is submitted or finalized, so it is left alone.
   */
  private async completeFromJobber(
    organizationId: string,
    visit: JobberVisit,
    inspection: { id: string; status: InspectionStatus; startedAt: Date | null },
    result: JobberSyncResult,
  ) {
    if (inspection.startedAt || inspection.status !== InspectionStatus.SCHEDULED) {
      result.skipped += 1;
      return;
    }

    const completedAt = visit.completedAt ? new Date(visit.completedAt) : new Date();
    await this.prisma.$transaction(async (tx) => {
      /**
       * The status is re-asserted in the WHERE clause.
       *
       * The read above ran outside this transaction, so a technician who
       * started the inspection in between would otherwise have their work
       * closed underneath them by a webhook.
       */
      const { count } = await tx.inspection.updateMany({
        where: { id: inspection.id, organizationId, status: InspectionStatus.SCHEDULED, startedAt: null },
        data: { status: InspectionStatus.COMPLETED, completedAt },
      });
      if (count === 0) return;
      await tx.auditLog.create({
        data: {
          organizationId,
          action: 'INSPECTION_COMPLETED_FROM_JOBBER',
          entityType: 'Inspection',
          entityId: inspection.id,
          metadata: {
            jobberVisitId: visit.id,
            completedAt: visit.completedAt ?? null,
            // Recorded because it is the whole point: no inspection was carried
            // out in this app, so there is no report behind this completion.
            capturedInApp: false,
          },
        },
      });
      result.completedFromJobber += 1;
    });
  }

  private async applyAssignment(
    organizationId: string,
    visit: JobberVisit,
    inspectionId: string,
    result: JobberSyncResult,
  ) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: { startedAt: true, status: true },
    });
    if (!inspection) return;

    const current = await this.prisma.inspectionAssignment.findFirst({
      where: { inspectionId, isCurrent: true },
      select: { id: true, technicianId: true },
    });

    /**
     * Work already under way here keeps the technician it has.
     *
     * Reassigning an inspection somebody has started or finished would rewrite
     * who did it, which is exactly what this guard exists to prevent.
     *
     * But it used to refuse anything that was not SCHEDULED, and that was too
     * broad. A move-in the sync recovers arrives *created* complete — Jobber
     * closed it before we ever saw the visit — so it has never had an
     * assignment for a later pass to overwrite. Recording the first one is not
     * a rewrite; that assignee is the history, not a change to it. 144 recovered
     * inspections read "Unassigned" for this reason while Jobber knew all along
     * who had walked them.
     *
     * So the refusal now needs both halves: the work has begun *and* somebody is
     * already named against it.
     */
    const worked = Boolean(inspection.startedAt) || inspection.status !== InspectionStatus.SCHEDULED;
    if (worked && current) return;

    const resolution = await resolveAssignment(this.prisma, organizationId, visit);
    if (resolution.outcome === 'NO_ASSIGNEE') return;
    if (resolution.outcome === 'UNKNOWN_ASSIGNEE') {
      await this.prisma.jobberVisitImport.updateMany({
        where: { organizationId, jobberVisitId: visit.id },
        data: { failureMessage: unknownAssigneeReason(resolution.misses) },
      });
      return;
    }

    if (current?.technicianId === resolution.match.technicianId) return;

    await this.prisma.$transaction(async (tx) => {
      if (current)
        await tx.inspectionAssignment.update({
          where: { id: current.id },
          data: {
            isCurrent: false,
            status: 'UNASSIGNED',
            endedAt: new Date(),
            reason: 'Reassigned in Jobber.',
          },
        });
      await tx.inspectionAssignment.create({
        data: {
          inspectionId,
          technicianId: resolution.match.technicianId,
          // Null on purpose: no person here made this call. See the migration.
          assignedById: null,
          reason: `Assigned in Jobber to ${resolution.match.email}.`,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          action: current ? 'INSPECTION_REASSIGNED_FROM_JOBBER' : 'INSPECTION_ASSIGNED_FROM_JOBBER',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: {
            jobberVisitId: visit.id,
            technicianId: resolution.match.technicianId,
            matchedOn: resolution.match.email,
          },
        },
      });
    });
    result.assigned += 1;
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
