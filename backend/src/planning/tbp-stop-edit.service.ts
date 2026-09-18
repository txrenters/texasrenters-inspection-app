import { Inject, Injectable } from '@nestjs/common';
import { type Prisma, TbpPlanStatus, TbpStopStatus, TbpUnitResolution, UserRole } from '@prisma/client';
import {
  type Quarter,
  type TbpInspectionType,
  nextQuarter,
  quarterLabel,
  quarterStart,
  unitFilterSizes,
} from '@texasrenters/shared';

import { type AuthenticatedUser, auditActor } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { benefitPackageInspectionInDetails } from '../integrations/jobber/jobber.visit-type';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpPlanService, planVisitDetails, visitTitle } from './tbp-plan.service';

/** A coordinator's change to one visit in a draft; anything left out stays as it is. */
export interface PlanStopEdit {
  /** `YYYY-MM-DD`, from the plan's first day to its quarter's last. */
  scheduledOn?: string;
  assignedTechnicianId?: string;
  /** One of the building's units. */
  propertywareUnitId?: string;
  visitTitle?: string;
  visitDetails?: string;
  onSiteMinutes?: number;
  inspectionType?: TbpInspectionType;
}

export interface PlanStopEditResult {
  id: string;
  /** What changed; empty when the edit changed nothing. */
  changed: (keyof PlanStopEdit)[];
}

/** A technician a visit can be given to, for the console's picker. */
export interface PlanTechnician {
  id: string;
  displayName: string;
  /** Place in the benefit-package crew's zone rotation; null is not on the crew. */
  crewOrder: number | null;
  hasHome: boolean;
}

/** What makes a Jobber visit this programme's; the same phrase `TBP_TITLE_MARKER` looks for. */
const TBP_TITLE = /tenant benefit package/i;

/** Routing's block on a visit no day could take: a person giving it a day and a technician settles it. */
const NOT_PLACED = 'NOT_PLACED';
/** Generation's block on a tenancy in a building of several units: a person choosing the unit settles it. */
const UNIT_REQUIRED = 'UNIT_REQUIRED';

const NAMED: Record<TbpInspectionType, string> = { OCCUPIED: 'an occupied inspection', HVAC: 'an HVAC inspection' };

const dateOf = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

/**
 * A day of the plan, as `YYYY-MM-DD`, or the reason it is not one.
 *
 * Any day from the plan's first -- the quarter's, or up to fifteen days either
 * side of it (the office, 2026-09-19) -- to the quarter's last: a weekend, a
 * holiday or a Monday kept for rescheduled visits is the office's to choose for
 * one visit, and the console says what the day is.
 */
export function dayInQuarter(value: string, quarter: Quarter, startsOn?: string | null): string {
  const day = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(day.getTime()) || dateOf(day) !== value)
    throw new ApplicationError(422, 'INVALID_DATE', 'Choose a day on the calendar.');
  const first = startsOn ? new Date(`${startsOn}T00:00:00.000Z`) : quarterStart(quarter);
  if (day < first || day >= quarterStart(nextQuarter(quarter)))
    throw new ApplicationError(
      422,
      'DATE_OUTSIDE_QUARTER',
      startsOn
        ? `Choose a day from ${startsOn} to the end of ${quarterLabel(quarter)}: this plan holds that quarter’s visits.`
        : `Choose a day in ${quarterLabel(quarter)}: this plan holds that quarter’s visits.`,
    );
  return value;
}

/** Why Details cannot be sent for this kind of visit, or null when they can. */
export function detailsProblem(details: string, inspectionType: TbpInspectionType): string | null {
  const named = benefitPackageInspectionInDetails(details);
  if (named === inspectionType) return null;
  if (inspectionType === 'HVAC')
    return 'Keep “HVAC Inspection” on the services line, the one joining services with “+”: it is how Jobber’s visit is read as an HVAC inspection.';
  return named
    ? `These Details name ${NAMED[named]} on their services line, but this visit is ${NAMED[inspectionType]}. Change the kind of visit instead.`
    : 'Keep “Occupied Inspection” in the Details: it is how Jobber’s visit is read as an occupied inspection.';
}

@Injectable()
export class TbpStopEditService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TbpPlanService) private readonly plans: TbpPlanService,
    @Inject(QuarterPlannerService) private readonly planner: QuarterPlannerService,
  ) {}

  /**
   * A coordinator's change to one visit in a draft, made from the visit's window.
   *
   * The office edits a draft in place (2026-09-16): the day, the technician,
   * the unit, the title and Details Jobber is sent, the kind of visit and how
   * long it takes. Each change is marked as a person's, so a rebuild keeps it,
   * and the days it touches are measured again at once. Checked the way the
   * visit will be read: the title keeps "Tenant Benefit Package", and the
   * Details name the inspection the visit is.
   *
   * A visit routing could not place is placed by giving it a day and a
   * technician; a tenancy in a building of several units, by choosing its unit.
   * Nothing is refused for making a day long -- the day shows over its limits.
   */
  async edit(user: AuthenticatedUser, stopId: string, input: PlanStopEdit): Promise<PlanStopEditResult> {
    const organizationId = user.organizationId;
    const stop = await this.prisma.tbpQuarterPlanStop.findFirst({
      where: { id: stopId, organizationId },
      select: {
        id: true,
        planId: true,
        status: true,
        blockedCode: true,
        inspectionId: true,
        inspectionType: true,
        scheduledOn: true,
        assignedTechnicianId: true,
        propertywareBuildingId: true,
        propertywareUnitId: true,
        officeDetails: true,
        visitTitle: true,
        visitTitleOverriddenAt: true,
        visitDetails: true,
        visitDetailsOverriddenAt: true,
        onSiteMinutes: true,
        hvacFilterSizes: true,
        plan: { select: { status: true, quarterYear: true, quarterNumber: true, maxOnSiteMinutes: true, startsOn: true } },
        tenant: {
          select: {
            addressLine1: true,
            zone: true,
            hvacFilterSizes: true,
            hvacFilterLocation: true,
            managementPlan: true,
            hvacPlan: true,
          },
        },
      },
    });
    if (!stop) throw new ApplicationError(404, 'STOP_NOT_FOUND', 'This visit does not exist.');
    if (
      stop.plan.status !== TbpPlanStatus.DRAFT ||
      stop.inspectionId ||
      stop.status === TbpStopStatus.PUBLISHED ||
      stop.status === TbpStopStatus.EXCLUDED
    )
      throw new ApplicationError(
        409,
        'STOP_NOT_EDITABLE',
        'Only a visit in a draft plan that has not been published or left out can be changed.',
      );

    const quarter: Quarter = { year: stop.plan.quarterYear, quarter: stop.plan.quarterNumber as Quarter['quarter'] };
    const changed: PlanStopEditResult['changed'] = [];
    const now = new Date();
    const data: Prisma.TbpQuarterPlanStopUncheckedUpdateInput = {};

    // Everything is checked before anything is written, so a refused edit
    // leaves the visit as it was.
    const date =
      input.scheduledOn !== undefined && input.scheduledOn !== dateOf(stop.scheduledOn)
        ? dayInQuarter(input.scheduledOn, quarter, dateOf(stop.plan.startsOn))
        : dateOf(stop.scheduledOn);
    const technicianId =
      input.assignedTechnicianId !== undefined && input.assignedTechnicianId !== stop.assignedTechnicianId
        ? await this.technician(organizationId, input.assignedTechnicianId)
        : stop.assignedTechnicianId;
    const unit =
      input.propertywareUnitId !== undefined && input.propertywareUnitId !== stop.propertywareUnitId
        ? await this.unit(organizationId, stop.propertywareBuildingId, input.propertywareUnitId)
        : null;
    const title = input.visitTitle === undefined ? undefined : this.title(input.visitTitle);
    const length =
      input.onSiteMinutes !== undefined && input.onSiteMinutes !== stop.onSiteMinutes
        ? this.length(input.onSiteMinutes, stop.plan.maxOnSiteMinutes)
        : undefined;
    const inspectionType = (input.inspectionType ?? stop.inspectionType) as TbpInspectionType;
    const details = input.visitDetails === undefined ? undefined : this.details(input.visitDetails, inspectionType);

    // The kind of visit first: its Details and length follow it, and anything
    // else this edit sets is laid over them.
    let onSiteMinutes = stop.onSiteMinutes;
    let visitDetails = stop.visitDetails;
    if (input.inspectionType !== undefined && input.inspectionType !== stop.inspectionType) {
      const typed = await this.plans.setInspectionType(user, stop.id, input.inspectionType);
      onSiteMinutes = typed.onSiteMinutes;
      visitDetails = typed.visitDetails;
      changed.push('inspectionType');
    }

    // When, and with whom: placed by a person as a whole, so the day and the
    // technician stay together through a rebuild, whichever was changed.
    const before = { date: dateOf(stop.scheduledOn), technicianId: stop.assignedTechnicianId };
    const moved = date !== before.date || technicianId !== before.technicianId;
    if (date !== before.date) {
      data.scheduledOn = new Date(`${date}T00:00:00.000Z`);
      changed.push('scheduledOn');
    }
    if (technicianId !== before.technicianId) {
      data.assignedTechnicianId = technicianId;
      changed.push('assignedTechnicianId');
    }
    if (moved) {
      if (date) data.scheduleOverriddenAt = now;
      if (technicianId) data.technicianOverriddenAt = now;
    }

    // The unit, with its own filter sizes and, unless a person wrote them, a
    // title at its door and Details from those sizes.
    let currentTitle = stop.visitTitle;
    if (unit) {
      const sizes = unitFilterSizes(stop.tenant.hvacFilterSizes, unit.chosen, unit.units) ?? stop.tenant.hvacFilterSizes;
      Object.assign(data, {
        propertywareUnitId: unit.chosen.id,
        unitResolution: TbpUnitResolution.MANUAL,
        unitOverriddenAt: now,
        hvacFilterSizes: sizes,
      });
      if (!stop.visitTitleOverriddenAt) {
        currentTitle = visitTitle(
          { addressLine1: unit.chosen.addressLine1 ?? stop.tenant.addressLine1, zone: stop.tenant.zone },
          quarter,
        );
        data.visitTitle = currentTitle;
      }
      if (!stop.visitDetailsOverriddenAt) {
        visitDetails = planVisitDetails({ ...stop.tenant, hvacFilterSizes: sizes }, inspectionType, stop.officeDetails);
        data.visitDetails = visitDetails;
      }
      changed.push('propertywareUnitId');
    }

    if (title !== undefined && title !== currentTitle) {
      Object.assign(data, { visitTitle: title, visitTitleOverriddenAt: now });
      changed.push('visitTitle');
    }
    if (details !== undefined && details !== visitDetails) {
      Object.assign(data, { visitDetails: details, visitDetailsOverriddenAt: now });
      changed.push('visitDetails');
    }
    if (length !== undefined && length !== onSiteMinutes) {
      Object.assign(data, { onSiteMinutes: length, onSiteMinutesOverriddenAt: now });
      onSiteMinutes = length;
      changed.push('onSiteMinutes');
    }

    // A block this edit settles. The unit settles UNIT_REQUIRED, but the visit
    // still needs a day: routing's block says so until it has one.
    let status = stop.status;
    let blockedCode = stop.blockedCode;
    if (status === TbpStopStatus.BLOCKED && blockedCode === UNIT_REQUIRED && unit) {
      blockedCode = date && technicianId ? null : NOT_PLACED;
      Object.assign(data, {
        blockedCode,
        blockedMessage: blockedCode ? 'Its unit is set. Rebuild the plan to give it a day, or choose its day and technician.' : null,
        ...(blockedCode ? {} : { status: TbpStopStatus.PLANNED }),
      });
      if (!blockedCode) status = TbpStopStatus.PLANNED;
    } else if (status === TbpStopStatus.BLOCKED && blockedCode === NOT_PLACED && (moved || unit) && date && technicianId) {
      status = TbpStopStatus.PLANNED;
      Object.assign(data, { status, blockedCode: null, blockedMessage: null });
    }

    if (Object.keys(data).length) await this.prisma.tbpQuarterPlanStop.update({ where: { id: stop.id }, data });
    if (changed.length === 0) return { id: stop.id, changed };

    // The days it touched, measured again: the one it left and the one it
    // joined, or its own when how long it takes changed.
    const lengthChanged = onSiteMinutes !== stop.onSiteMinutes;
    const days = new Map<string, { date: string; technicianId: string }>();
    if (moved || lengthChanged) {
      if (stop.status === TbpStopStatus.PLANNED && before.date && before.technicianId)
        days.set(`${before.date}|${before.technicianId}`, { date: before.date, technicianId: before.technicianId });
      if (status === TbpStopStatus.PLANNED && date && technicianId) days.set(`${date}|${technicianId}`, { date, technicianId });
    }
    if (days.size) await this.planner.measureDays(organizationId, stop.planId, [...days.values()]);

    if (status !== stop.status) {
      const blockedCount = await this.prisma.tbpQuarterPlanStop.count({
        where: { planId: stop.planId, organizationId, status: TbpStopStatus.BLOCKED },
      });
      await this.prisma.tbpQuarterPlan.update({ where: { id: stop.planId }, data: { blockedCount } });
    }

    // Which fields, and the day, technician and length either side. Never the
    // title or Details themselves: they carry the address and whatever was typed.
    const edited = changed.filter((field) => field !== 'inspectionType');
    if (edited.length)
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'TBP_PLAN_STOP_EDITED',
          entityType: 'TbpQuarterPlanStop',
          entityId: stop.id,
          metadata: {
            planId: stop.planId,
            fields: edited,
            ...(moved ? { from: before, to: { date, technicianId } } : {}),
            ...(changed.includes('onSiteMinutes') ? { onSiteMinutes: { from: stop.onSiteMinutes, to: length } } : {}),
            ...(unit ? { unit: { from: stop.propertywareUnitId, to: unit.chosen.id } } : {}),
            ...(status !== stop.status ? { status: { from: stop.status, to: status } } : {}),
          },
        },
      });

    return { id: stop.id, changed };
  }

  /**
   * The technicians a visit can be given to: the crew first, in its order,
   * then everyone else active with the technician role -- somebody off the crew
   * may cover a day -- with whether a home is on file, which is where a day's
   * drive is counted from.
   */
  async technicians(organizationId: string): Promise<PlanTechnician[]> {
    const [people, profiles] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: { isActive: true, memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } } },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
      this.prisma.technicianPlanningProfile.findMany({
        where: { organizationId },
        select: { technicianId: true, isPlannable: true, tbpZoneOrder: true, homeLatitude: true, homeLongitude: true },
      }),
    ]);
    const profileOf = new Map(profiles.map((row) => [row.technicianId, row]));
    return people
      .map((person) => {
        const profile = profileOf.get(person.id);
        return {
          id: person.id,
          displayName: person.displayName,
          crewOrder: profile?.isPlannable && profile.tbpZoneOrder != null ? profile.tbpZoneOrder : null,
          hasHome: profile?.homeLatitude != null && profile.homeLongitude != null,
        };
      })
      .sort(
        (left, right) =>
          (left.crewOrder ?? Number.POSITIVE_INFINITY) - (right.crewOrder ?? Number.POSITIVE_INFINITY) ||
          left.displayName.localeCompare(right.displayName),
      );
  }

  private async technician(organizationId: string, technicianId: string): Promise<string> {
    const technician = await this.prisma.userProfile.findFirst({
      where: {
        id: technicianId,
        isActive: true,
        memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
      },
      select: { id: true },
    });
    if (!technician) throw new ApplicationError(422, 'NOT_A_TECHNICIAN', 'Choose an active technician.');
    return technician.id;
  }

  private async unit(organizationId: string, buildingId: string | null, unitId: string) {
    const units = buildingId
      ? await this.prisma.propertywareUnit.findMany({
          where: { organizationId, buildingId, isActive: true },
          select: { id: true, name: true, addressLine1: true },
          orderBy: { name: 'asc' },
        })
      : [];
    const chosen = units.find((candidate) => candidate.id === unitId);
    if (!chosen) throw new ApplicationError(422, 'NOT_A_UNIT_OF_THE_BUILDING', 'Choose one of this property’s units.');
    return { chosen, units };
  }

  private title(value: string): string {
    const title = value.replace(/\s+/g, ' ').trim();
    if (!title) throw new ApplicationError(422, 'VISIT_TITLE_REQUIRED', 'A visit needs a title.');
    if (!TBP_TITLE.test(title))
      throw new ApplicationError(
        422,
        'VISIT_TITLE_NOT_TBP',
        'Keep “Tenant Benefit Package” in the title: it is how Jobber’s visit is known as this programme’s.',
      );
    return title;
  }

  private details(value: string, inspectionType: TbpInspectionType): string {
    const details = value.replace(/\r\n?/g, '\n').trim();
    if (!details) throw new ApplicationError(422, 'VISIT_DETAILS_REQUIRED', 'A visit needs its Details.');
    const problem = detailsProblem(details, inspectionType);
    if (problem) throw new ApplicationError(422, 'VISIT_DETAILS_INSPECTION', problem);
    return details;
  }

  private length(minutes: number, maxOnSiteMinutes: number): number {
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > maxOnSiteMinutes)
      throw new ApplicationError(
        422,
        'INVALID_VISIT_LENGTH',
        `A visit takes from 5 to ${maxOnSiteMinutes} minutes: no longer than a whole day on site.`,
      );
    return minutes;
  }
}
