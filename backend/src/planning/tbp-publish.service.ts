import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InspectionType } from '@prisma/client';
import {
  InspectionSource,
  InspectionStatus,
  JobberOutboundKind,
  JobberOutboundStatus,
  Prisma,
  TbpPlanStatus,
  TbpStopStatus,
} from '@prisma/client';
import { withInspectionLink } from '@texasrenters/shared';

import { insertInspection, resolveInspectionPlan } from '../admin/inspection-creation';
import { allowsTechnicianCapture } from '../integrations/jobber/jobber.visit-type';
import { type AuthenticatedUser, auditActor } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * How many stops are published before the progress counter is updated.
 *
 * Small on purpose. `TRANSACTION_DEFAULTS` gives a transaction twenty seconds,
 * and several hundred inspections cannot be one — each stop is its own
 * transaction, and this only controls how often the console learns how far
 * along it is.
 */
const PROGRESS_CHUNK = 25;

/**
 * Where the console is, for the link a visit's Details carry back to its inspection.
 *
 * Exported because anything that rewrites a published visit's Details has to
 * put the same link back. `refreshFilterSizes` learned that the hard way: it
 * wrote the bare rendered text and would have stripped the technician's way
 * into the inspection out of every visit it touched.
 */
export function webOrigin(): string {
  return (process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '');
}

export interface PublishSummary {
  planId: string;
  published: number;
  adopted: number;
  /** Sent to Jobber with no day on them, for the office to schedule there. */
  unscheduled: number;
  failed: number;
  status: TbpPlanStatus;
}

@Injectable()
export class TbpPublishService {
  private readonly logger = new Logger(TbpPublishService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Turn a reviewed draft into real inspections, and queue the Jobber visits.
   *
   * Resumable, because it cannot be atomic. Several hundred stops at roughly
   * ten statements each is far beyond one transaction, so each stop commits on
   * its own and the plan's own status is the lock. Re-running after a failure
   * selects only stops with no inspection yet, so nothing is created twice.
   */
  async publish(user: AuthenticatedUser, planId: string): Promise<PublishSummary> {
    await this.claim(user, planId);

    let published = 0;
    let adopted = 0;
    let unscheduled = 0;
    let failed = 0;

    // Re-read each round rather than paging a snapshot: a stop published in the
    // previous round must drop out of the next query, and a `skip`/`take` over
    // a shrinking set silently steps past rows.
    for (;;) {
      const batch = await this.prisma.tbpQuarterPlanStop.findMany({
        where: {
          planId,
          organizationId: user.organizationId,
          // A visit the planner could not place is published too, with no day
          // on it (the office, 2026-09-20). Only one a coordinator excluded
          // deliberately stays out.
          status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.BLOCKED] },
          inspectionId: null,
        },
        orderBy: { sequence: 'asc' },
        take: PROGRESS_CHUNK,
        select: {
          id: true,
          sequence: true,
          scheduledOn: true,
          assignedTechnicianId: true,
          propertywareBuildingId: true,
          propertywareUnitId: true,
          propertywareLeaseId: true,
          jobberJobId: true,
          inspectionType: true,
          visitTitle: true,
          visitDetails: true,
        },
      });
      if (batch.length === 0) break;

      for (const stop of batch) {
        const outcome = stop.scheduledOn
          ? await this.publishStop(user, planId, stop)
          : await this.queueUnscheduled(user, planId, stop);
        if (outcome === 'PUBLISHED') published += 1;
        else if (outcome === 'ADOPTED') adopted += 1;
        else if (outcome === 'UNSCHEDULED') unscheduled += 1;
        else failed += 1;
      }

      await this.prisma.tbpQuarterPlan.update({
        where: { id: planId },
        data: { publishedCount: published + adopted + unscheduled },
      });
    }

    const status = failed > 0 ? TbpPlanStatus.PUBLISH_FAILED : TbpPlanStatus.PUBLISHED;
    await this.prisma.tbpQuarterPlan.update({
      where: { id: planId },
      data: {
        status,
        publishedAt: failed > 0 ? null : new Date(),
        publishedCount: published + adopted + unscheduled,
        lastError: failed > 0 ? `${failed} stop(s) could not be published.` : null,
      },
    });

    this.logger.log({
      event: 'tbp_plan_published',
      organizationId: user.organizationId,
      planId,
      published,
      adopted,
      unscheduled,
      failed,
      status,
    });

    return { planId, published, adopted, unscheduled, failed, status };
  }

  /**
   * Take the plan, or refuse.
   *
   * A conditional update from DRAFT is the lock. There is no general job lock
   * in this system — `PropertywareSyncLock` is bound to the Propertyware store
   * — and this needs one, because two coordinators clicking Publish within a
   * second of each other would otherwise both start creating the same quarter.
   * The update touching exactly one row is the proof that this caller won.
   *
   * A publish that failed part-way is claimed the same way, and its failed
   * stops go back to planned so this run tries them again -- otherwise
   * "publishing again picks up where it stopped" was a promise with no way to
   * keep it: the claim only took a DRAFT, and the loop only a PLANNED stop.
   */
  private async claim(user: AuthenticatedUser, planId: string) {
    const { count } = await this.prisma.tbpQuarterPlan.updateMany({
      where: {
        id: planId,
        organizationId: user.organizationId,
        // A published quarter that was rebuilt has visits to create again
        // (2026-09-20); one already publishing is left to the run that has it.
        status: { in: [TbpPlanStatus.DRAFT, TbpPlanStatus.PUBLISH_FAILED, TbpPlanStatus.PUBLISHED] },
      },
      data: {
        status: TbpPlanStatus.PUBLISHING,
        publishStartedAt: new Date(),
        publishedById: auditActor(user).actorUserId,
        lastError: null,
      },
    });
    if (count !== 1)
      throw new ApplicationError(
        409,
        'PLAN_NOT_DRAFT',
        'This plan is already publishing, published, or no longer a draft.',
      );

    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId: user.organizationId, status: TbpStopStatus.FAILED, inspectionId: null },
      data: { status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null },
    });
  }

  /**
   * One visit given a day after the quarter was published, made real at once.
   *
   * The office (2026-09-20) publishes a quarter with visits that have no day --
   * they go to Jobber's unscheduled work -- and then gives one a day here. The
   * plan is past publishing by then, so nothing else would ever create its
   * inspection: this does, the moment it has a day and somebody to take it.
   *
   * A visit already sitting in Jobber unscheduled is refused. Its job and visit
   * exist there; scheduling it in Jobber is what gives it a day, and the sync
   * brings it back here as an inspection on this same stop. Creating a second
   * job from here would put the same work in the calendar twice.
   */
  async placeOne(user: AuthenticatedUser, stopId: string): Promise<'PUBLISHED' | 'ADOPTED' | 'FAILED' | null> {
    const stop = await this.prisma.tbpQuarterPlanStop.findFirst({
      where: { id: stopId, organizationId: user.organizationId },
      select: {
        id: true,
        planId: true,
        sequence: true,
        status: true,
        inspectionId: true,
        jobberVisitId: true,
        scheduledOn: true,
        assignedTechnicianId: true,
        propertywareBuildingId: true,
        propertywareUnitId: true,
        propertywareLeaseId: true,
        jobberJobId: true,
        inspectionType: true,
        visitTitle: true,
        visitDetails: true,
      },
    });
    // Nothing to make real: it has its inspection, it was left out, or it still
    // has no day. Each is a normal state, not a failure.
    if (!stop || stop.inspectionId || stop.status === TbpStopStatus.EXCLUDED || !stop.scheduledOn) return null;
    if (stop.jobberVisitId)
      throw new ApplicationError(
        409,
        'VISIT_IS_IN_JOBBER',
        'This visit is already in Jobber with no day on it. Give it a day there, and it comes back here with the day it was given.',
      );

    // The queued unscheduled job, dropped: it has a day now, and the booking
    // that follows creates the job it belongs on.
    await this.prisma.jobberOutboundTask.deleteMany({
      where: {
        organizationId: user.organizationId,
        tbpStopId: stop.id,
        kind: JobberOutboundKind.TBP_JOB_UNSCHEDULED,
        status: { in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED] },
      },
    });

    const outcome = await this.publishStop(user, stop.planId, stop);
    if (outcome !== 'FAILED')
      await this.prisma.tbpQuarterPlan.update({
        where: { id: stop.planId },
        data: { publishedCount: { increment: 1 } },
      });
    return outcome;
  }

  /**
   * A visit with no day, put in Jobber's unscheduled work instead.
   *
   * The office (2026-09-20): "let's not make the needs attention as blocker for
   * publishing the TBP ... those needs to an attention should be reflected also
   * into the unscheduled appointment". Nothing is inspected until it has a day,
   * so no inspection is created here: the task carries the plan stop, the job
   * appears in Jobber with no day on it, and the visit comes back as an
   * inspection through the ordinary sync once the office schedules it there.
   *
   * The task is unique on (organization, stop, kind), so publishing a plan a
   * second time cannot make a second job in somebody's calendar.
   */
  private async queueUnscheduled(
    user: AuthenticatedUser,
    planId: string,
    stop: { id: string; sequence: number; propertywareBuildingId: string | null; visitTitle: string | null },
  ): Promise<'UNSCHEDULED' | 'FAILED'> {
    if (!stop.propertywareBuildingId || !stop.visitTitle)
      return this.fail(stop.id, 'NOT_ROUTED', 'This visit has no property or no title to book with.');

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.jobberOutboundTask.create({
          data: {
            organizationId: user.organizationId,
            tbpStopId: stop.id,
            kind: JobberOutboundKind.TBP_JOB_UNSCHEDULED,
            status: JobberOutboundStatus.PENDING,
          },
        });

        await tx.tbpQuarterPlanStop.update({
          where: { id: stop.id },
          data: { status: TbpStopStatus.UNSCHEDULED, blockedCode: null, blockedMessage: null },
        });

        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            ...auditActor(user),
            action: 'TBP_STOP_SENT_UNSCHEDULED',
            entityType: 'TbpQuarterPlanStop',
            entityId: stop.id,
            metadata: { planId, sequence: stop.sequence },
          },
        });
      });
      return 'UNSCHEDULED';
    } catch (error) {
      // Queued by an earlier publish: the stop is already Jobber's to schedule.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.prisma.tbpQuarterPlanStop.update({
          where: { id: stop.id },
          data: { status: TbpStopStatus.UNSCHEDULED, blockedCode: null, blockedMessage: null },
        });
        return 'UNSCHEDULED';
      }
      return this.fail(
        stop.id,
        error instanceof ApplicationError ? error.code : 'PUBLISH_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async publishStop(
    user: AuthenticatedUser,
    planId: string,
    stop: {
      id: string;
      sequence: number;
      scheduledOn: Date | null;
      assignedTechnicianId: string | null;
      propertywareBuildingId: string | null;
      propertywareUnitId: string | null;
      propertywareLeaseId: string | null;
      jobberJobId: string | null;
      inspectionType: InspectionType;
      visitTitle: string | null;
      visitDetails: string | null;
    },
  ): Promise<'PUBLISHED' | 'ADOPTED' | 'FAILED'> {
    if (!stop.propertywareBuildingId) return this.fail(stop.id, 'NOT_ROUTED', 'This stop has no property.');

    try {
      await this.prisma.$transaction(async (tx) => {
        const plan = await resolveInspectionPlan(tx, {
          organizationId: user.organizationId,
          buildingId: stop.propertywareBuildingId!,
          unitId: stop.propertywareUnitId,
          leaseId: stop.propertywareLeaseId,
          // HVAC or occupied, as the quarter's rule decided and the coordinator reviewed.
          inspectionType: stop.inspectionType,
          /**
           * The technician surveys a property whose areas nobody has approved.
           *
           * The same visit arriving from Jobber is created this way already
           * (`allowsTechnicianCapture`, read by the sync): what the technician
           * captures is a DRAFT against the property, and an administrator
           * still approves what becomes its permanent layout. Publishing was
           * stricter than the sync for no reason anyone chose -- it refused 41
           * of the office's 429 Q4 visits with "approve its areas before
           * creating an inspection" (2026-09-20), on properties whose tenants
           * are visited this quarter either way.
           */
          allowTechnicianAreaCapture: allowsTechnicianCapture(stop.inspectionType),
          scheduledAt: stop.scheduledOn!,
        });

        const inspection = await insertInspection(tx, plan, {
          priority: 'STANDARD',
          // Null, not the publishing coordinator. They approved a quarter; they
          // did not choose this property, this day or this technician, and
          // naming them as the creator of four hundred inspections would make
          // the audit trail say something nobody did.
          createdById: null,
          source: InspectionSource.MANUAL,
          status: InspectionStatus.SCHEDULED,
          // The visit's text on the inspection, as a console booking has it:
          // the technician reads it on the phone before the visit exists in
          // Jobber, and the booking sends what is here.
          jobberVisitTitle: stop.visitTitle,
          jobberVisitDetails: stop.visitDetails,
        });

        if (stop.visitDetails)
          // The link needs the inspection's id, so it is added once there is one.
          await tx.inspection.update({
            where: { id: inspection.id },
            data: {
              jobberVisitDetails: withInspectionLink(stop.visitDetails, `${webOrigin()}/inspections/${inspection.id}`),
            },
          });

        if (stop.assignedTechnicianId)
          await tx.inspectionAssignment.create({
            data: {
              inspectionId: inspection.id,
              technicianId: stop.assignedTechnicianId,
              // Also null: the plan chose this technician, not a person.
              assignedById: null,
              reason: 'Quarterly benefit-package plan',
              // Scoped to the stop, so a resumed publish cannot assign twice.
              idempotencyKey: `tbp-plan:${planId}:${stop.id}`,
            },
          });

        await tx.jobberOutboundTask.create({
          data: {
            organizationId: user.organizationId,
            inspectionId: inspection.id,
            kind: JobberOutboundKind.TBP_VISIT_CREATE,
            status: JobberOutboundStatus.PENDING,
            jobberJobId: stop.jobberJobId,
          },
        });

        await tx.tbpQuarterPlanStop.update({
          where: { id: stop.id },
          data: {
            status: TbpStopStatus.PUBLISHED,
            inspectionId: inspection.id,
            blockedCode: null,
            blockedMessage: null,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            ...auditActor(user),
            action: 'INSPECTION_CREATED_FROM_TBP_PLAN',
            entityType: 'Inspection',
            entityId: inspection.id,
            metadata: { planId, stopId: stop.id, sequence: stop.sequence, inspectionType: stop.inspectionType },
          },
        });
      });
      return 'PUBLISHED';
    } catch (error) {
      const existing = await this.adoptable(user, stop, error);
      if (existing) {
        await this.prisma.tbpQuarterPlanStop.update({
          where: { id: stop.id },
          data: { status: TbpStopStatus.PUBLISHED, inspectionId: existing },
        });
        return 'ADOPTED';
      }
      return this.fail(
        stop.id,
        error instanceof ApplicationError ? error.code : 'PUBLISH_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * The inspection this stop was going to create, already there.
   *
   * Exactly the half-published case: a previous run created the inspection and
   * died before writing it back onto the stop. `Inspection_scheduled_booking_key`
   * — the partial unique index — refuses the duplicate, and the right response
   * is to take ownership of the row rather than report a failure a coordinator
   * cannot act on.
   *
   * Only for that specific collision, and only an inspection of the stop's own
   * type. A 409 from the duplicate *check* is the same situation; anything else
   * is a real failure and is left alone.
   */
  private async adoptable(
    user: AuthenticatedUser,
    stop: {
      propertywareBuildingId: string | null;
      propertywareUnitId: string | null;
      scheduledOn: Date | null;
      inspectionType: InspectionType;
    },
    error: unknown,
  ) {
    const collision =
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
      (error instanceof ApplicationError && error.code === 'DUPLICATE_INSPECTION');
    if (!collision || !stop.propertywareBuildingId || !stop.scheduledOn) return null;

    const existing = await this.prisma.inspection.findFirst({
      where: {
        organizationId: user.organizationId,
        propertywareBuildingId: stop.propertywareBuildingId,
        propertywareUnitId: stop.propertywareUnitId,
        inspectionType: stop.inspectionType,
        scheduledAt: stop.scheduledOn,
        status: InspectionStatus.SCHEDULED,
      },
      select: { id: true },
    });
    return existing?.id ?? null;
  }

  private async fail(stopId: string, code: string, message: string) {
    await this.prisma.tbpQuarterPlanStop.update({
      where: { id: stopId },
      data: { status: TbpStopStatus.FAILED, blockedCode: code, blockedMessage: message.slice(0, 500) },
    });
    return 'FAILED' as const;
  }
}
