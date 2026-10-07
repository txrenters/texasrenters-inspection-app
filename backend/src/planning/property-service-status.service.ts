import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InspectionStatus, InspectionType, TbpStopStatus } from '@prisma/client';
import type {
  PropertyServiceChange,
  PropertyServiceStillBooked,
  PropertyServiceView,
  SetPropertyServiceStatusInput,
} from '@texasrenters/shared';

import { leftBenefitPackage, SERVICE_STATUS_VIEW_SELECT, serviceStatusView } from '../admin/property-service-status';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { LeaseInspectionScheduler } from './lease-inspections.scheduler';
import { LeaseInspectionService } from './lease-inspections.service';

/**
 * The two switches on a property's Details tab (the office, 2026-10-08).
 *
 * Propertyware is told late when an owner ends the management contract or a
 * property leaves the tenant benefit package, and until it is, everything here
 * went on booking visits there. These say it first:
 *
 * - **Management ended** stops everything. The lease schedule is run for the
 *   property at once: the move-outs and move-ins it booked there and nobody has
 *   touched are cancelled -- in Jobber too, and their technician told -- and it
 *   books nothing more. The benefit-package visits stop as well.
 * - **Benefit package opted out** stops only the quarterly occupied and HVAC
 *   visits. Move-ins and move-outs go on.
 *
 * Either way a quarter's visits there that were never published leave the
 * plan, and nothing a person booked, started or published is cancelled by
 * itself: it is listed, for the office to cancel or keep. Turning a switch off
 * undoes what it did -- the lease schedule books again, the visits rejoin the
 * plan -- and every turn is audited with who made it.
 */

/** Why a quarter's visit left the plan, so turning the switch off knows which ones to put back. */
const LEFT_PACKAGE_CODE = 'PROPERTY_LEFT_PACKAGE';

/** The benefit package's visits: occupied in one quarter, HVAC in the next. */
const PACKAGE_VISIT_TYPES: InspectionType[] = [InspectionType.OCCUPIED, InspectionType.HVAC];

/** Booked and not done: what a switch would have stopped, had it been on sooner. */
const OPEN_STATUSES: InspectionStatus[] = [InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS];

const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);

@Injectable()
export class PropertyServiceStatusService {
  private readonly logger = new Logger(PropertyServiceStatusService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LeaseInspectionService) private readonly leases: LeaseInspectionService,
    @Inject(LeaseInspectionScheduler) private readonly leaseSchedule: LeaseInspectionScheduler,
    @Optional() @Inject(CacheInvalidationService) private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

  async view(user: AuthenticatedUser, buildingId: string, now = new Date()): Promise<PropertyServiceView> {
    const building = await this.building(user, buildingId);
    const status = serviceStatusView(building.serviceStatus);
    return {
      status,
      stillBooked:
        (status.managementEnded || status.tbpOptedOut) && user.permissions.includes('inspections:read')
          ? await this.stillBooked(user.organizationId, buildingId, Boolean(status.managementEnded), now)
          : [],
      leaseScheduleOn: this.leaseSchedule.describe().enabled,
    };
  }

  async set(
    user: AuthenticatedUser,
    buildingId: string,
    input: SetPropertyServiceStatusInput,
    now = new Date(),
  ): Promise<PropertyServiceChange> {
    const { organizationId } = user;
    const building = await this.building(user, buildingId);
    const before = building.serviceStatus;
    const by = auditActor(user).actorUserId;

    const turned = {
      managementEnded:
        input.managementEnded !== undefined && input.managementEnded !== Boolean(before?.managementEndedAt)
          ? input.managementEnded
          : null,
      tbpOptedOut:
        input.tbpOptedOut !== undefined && input.tbpOptedOut !== Boolean(before?.tbpOptedOutAt) ? input.tbpOptedOut : null,
    };
    if (turned.managementEnded === null && turned.tbpOptedOut === null)
      return { ...(await this.view(user, buildingId, now)), calledOff: 0, booked: 0 };

    const after = {
      managementEndedAt:
        turned.managementEnded === null ? (before?.managementEndedAt ?? null) : turned.managementEnded ? now : null,
      tbpOptedOutAt: turned.tbpOptedOut === null ? (before?.tbpOptedOutAt ?? null) : turned.tbpOptedOut ? now : null,
    };
    const data = {
      ...(turned.managementEnded === null
        ? {}
        : { managementEndedAt: after.managementEndedAt, managementEndedById: turned.managementEnded ? by : null }),
      ...(turned.tbpOptedOut === null
        ? {}
        : { tbpOptedOutAt: after.tbpOptedOutAt, tbpOptedOutById: turned.tbpOptedOut ? by : null }),
    };
    const leftBefore = leftBenefitPackage(before);
    const leftAfter = leftBenefitPackage(after);
    const today = businessDate(now);

    const stops = await this.prisma.$transaction(async (tx) => {
      await tx.propertyServiceStatus.upsert({
        where: { buildingId },
        create: { organizationId, buildingId, ...data },
        update: data,
      });

      // The quarter's visits there: out of the plan while it is out of the
      // package, back in when it is not. Only ones never published -- a visit
      // in Jobber or on somebody's day is listed below for a person instead.
      let stopsMoved = 0;
      if (!leftBefore && leftAfter)
        ({ count: stopsMoved } = await tx.tbpQuarterPlanStop.updateMany({
          where: {
            organizationId,
            propertywareBuildingId: buildingId,
            inspectionId: null,
            status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.BLOCKED, TbpStopStatus.FAILED] },
            OR: [{ scheduledOn: null }, { scheduledOn: { gte: dateOf(today) } }],
          },
          data: {
            status: TbpStopStatus.EXCLUDED,
            blockedCode: LEFT_PACKAGE_CODE,
            blockedMessage: after.managementEndedAt
              ? 'The owner ended the management of this property (switched on on its page).'
              : 'This property opted out of the benefit package (switched on on its page).',
          },
        }));
      else if (leftBefore && !leftAfter)
        ({ count: stopsMoved } = await tx.tbpQuarterPlanStop.updateMany({
          where: {
            organizationId,
            propertywareBuildingId: buildingId,
            inspectionId: null,
            status: TbpStopStatus.EXCLUDED,
            blockedCode: LEFT_PACKAGE_CODE,
          },
          data: { status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null },
        }));

      for (const [flag, on] of Object.entries(turned) as ['managementEnded' | 'tbpOptedOut', boolean | null][]) {
        if (on === null) continue;
        await tx.auditLog.create({
          data: {
            organizationId,
            ...auditActor(user),
            action: `${flag === 'managementEnded' ? 'PROPERTY_MANAGEMENT_ENDED' : 'PROPERTY_TBP_OPTED_OUT'}_${on ? 'SET' : 'CLEARED'}`,
            entityType: 'PropertywareBuilding',
            entityId: buildingId,
            metadata: { planStopsMoved: stopsMoved },
          },
        });
      }
      return stopsMoved;
    });
    this.cacheInvalidation?.bump('propertyDetails', organizationId);

    // The lease schedule, for this property and now rather than overnight. Only
    // while it runs at all: switched off, it books nothing, and the switch must
    // not book either. A failure here leaves the switch set -- tonight's run
    // does the same work.
    let calledOff = 0;
    let booked = 0;
    if (turned.managementEnded !== null && this.leaseSchedule.describe().enabled) {
      try {
        const run = await this.leases.run(organizationId, { now, buildingId });
        calledOff = run.counts.CALL_OFF;
        booked = run.counts.BOOK;
      } catch (error) {
        this.logger.warn({
          event: 'property_service_lease_run_failed',
          organizationId,
          buildingId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log({
      event: 'property_service_status_set',
      organizationId,
      buildingId,
      managementEnded: Boolean(after.managementEndedAt),
      tbpOptedOut: Boolean(after.tbpOptedOutAt),
      planStopsMoved: stops,
      calledOff,
      booked,
    });
    return { ...(await this.view(user, buildingId, now)), calledOff, booked };
  }

  private async building(user: AuthenticatedUser, buildingId: string) {
    const building = await this.prisma.propertywareBuilding.findFirst({
      where: { id: buildingId, organizationId: user.organizationId },
      select: { id: true, serviceStatus: { select: SERVICE_STATUS_VIEW_SELECT } },
    });
    if (!building) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'That property was not found.');
    return building;
  }

  /**
   * What is still booked there from today that the switches say should not be:
   * everything once the management ended, the benefit-package visits otherwise.
   */
  private async stillBooked(
    organizationId: string,
    buildingId: string,
    managementEnded: boolean,
    now: Date,
  ): Promise<PropertyServiceStillBooked[]> {
    const inspections = await this.prisma.inspection.findMany({
      where: {
        organizationId,
        propertywareBuildingId: buildingId,
        status: { in: OPEN_STATUSES },
        scheduledAt: { gte: dateOf(businessDate(now)) },
        ...(managementEnded ? {} : { inspectionType: { in: PACKAGE_VISIT_TYPES } }),
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 50,
      select: {
        id: true,
        inspectionType: true,
        status: true,
        scheduledAt: true,
        assignments: {
          where: { isCurrent: true },
          select: { technician: { select: { displayName: true } } },
          take: 1,
        },
      },
    });
    return inspections.map((inspection) => ({
      inspectionId: inspection.id,
      inspectionType: inspection.inspectionType,
      status: inspection.status,
      scheduledOn: inspection.scheduledAt.toISOString().slice(0, 10),
      technician: inspection.assignments[0]?.technician.displayName ?? null,
    }));
  }
}
