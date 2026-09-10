import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InspectionSource,
  InspectionStatus,
  InspectionType,
  JobberOutboundKind,
  JobberOutboundStatus,
  Prisma,
  TbpPlanStatus,
  TbpStopStatus,
} from '@prisma/client';

import { insertInspection, resolveInspectionPlan } from '../admin/inspection-creation';
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

export interface PublishSummary {
  planId: string;
  published: number;
  adopted: number;
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
    let failed = 0;

    // Re-read each round rather than paging a snapshot: a stop published in the
    // previous round must drop out of the next query, and a `skip`/`take` over
    // a shrinking set silently steps past rows.
    for (;;) {
      const batch = await this.prisma.tbpQuarterPlanStop.findMany({
        where: {
          planId,
          organizationId: user.organizationId,
          status: TbpStopStatus.PLANNED,
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
        },
      });
      if (batch.length === 0) break;

      for (const stop of batch) {
        const outcome = await this.publishStop(user, planId, stop);
        if (outcome === 'PUBLISHED') published += 1;
        else if (outcome === 'ADOPTED') adopted += 1;
        else failed += 1;
      }

      await this.prisma.tbpQuarterPlan.update({
        where: { id: planId },
        data: { publishedCount: published + adopted },
      });
    }

    const status = failed > 0 ? TbpPlanStatus.PUBLISH_FAILED : TbpPlanStatus.PUBLISHED;
    await this.prisma.tbpQuarterPlan.update({
      where: { id: planId },
      data: {
        status,
        publishedAt: failed > 0 ? null : new Date(),
        publishedCount: published + adopted,
        lastError: failed > 0 ? `${failed} stop(s) could not be published.` : null,
      },
    });

    this.logger.log({
      event: 'tbp_plan_published',
      organizationId: user.organizationId,
      planId,
      published,
      adopted,
      failed,
      status,
    });

    return { planId, published, adopted, failed, status };
  }

  /**
   * Take the plan, or refuse.
   *
   * A conditional update from DRAFT is the lock. There is no general job lock
   * in this system — `PropertywareSyncLock` is bound to the Propertyware store
   * — and this needs one, because two coordinators clicking Publish within a
   * second of each other would otherwise both start creating the same quarter.
   * The update touching exactly one row is the proof that this caller won.
   */
  private async claim(user: AuthenticatedUser, planId: string) {
    const blocked = await this.prisma.tbpQuarterPlanStop.count({
      where: { planId, organizationId: user.organizationId, status: TbpStopStatus.BLOCKED },
    });
    if (blocked > 0)
      // Refused rather than skipped. A blocked stop is a tenancy nobody will
      // inspect this quarter, and publishing around it makes that invisible —
      // the coordinator can exclude it deliberately, which is a decision with
      // a reason attached.
      throw new ApplicationError(
        409,
        'PLAN_HAS_BLOCKED_STOPS',
        `${blocked} stop(s) still need attention. Resolve or exclude them before publishing.`,
      );

    const { count } = await this.prisma.tbpQuarterPlan.updateMany({
      where: { id: planId, organizationId: user.organizationId, status: TbpPlanStatus.DRAFT },
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
    },
  ): Promise<'PUBLISHED' | 'ADOPTED' | 'FAILED'> {
    if (!stop.propertywareBuildingId || !stop.scheduledOn)
      return this.fail(stop.id, 'NOT_ROUTED', 'This stop has no property or no scheduled day.');

    try {
      await this.prisma.$transaction(async (tx) => {
        const plan = await resolveInspectionPlan(tx, {
          organizationId: user.organizationId,
          buildingId: stop.propertywareBuildingId!,
          unitId: stop.propertywareUnitId,
          leaseId: stop.propertywareLeaseId,
          inspectionType: InspectionType.OCCUPIED,
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
            metadata: { planId, stopId: stop.id, sequence: stop.sequence },
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
   * Only for that specific collision. A 409 from the duplicate *check* is the
   * same situation; anything else is a real failure and is left alone.
   */
  private async adoptable(
    user: AuthenticatedUser,
    stop: { propertywareBuildingId: string | null; propertywareUnitId: string | null; scheduledOn: Date | null },
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
        inspectionType: InspectionType.OCCUPIED,
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
