import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus, TbpStopStatus } from '@prisma/client';
import {
  COVERAGE_DETAILS,
  COVERAGE_GROUPS,
  isTbpZone,
  type CoverageDetail,
  type CoverageGroup,
  type CoverageVisit,
  type QuarterCoverage,
  type QuarterCoverageLeaver,
  type QuarterCoverageProperty,
} from '@texasrenters/shared';

import { visitQuarter } from '../admin/admin.service';
import { packageMembership } from '../common/benefit-package';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { isDoneInspectionStatus } from '../common/inspection-done';
import { PrismaService } from '../common/prisma.service';
import { isTbpEnrolled } from '../integrations/propertyware/propertyware.tenant-report';
import { TBP_TITLE_MARKER } from './tbp-plan.service';

/**
 * Where every property in the benefit package stands for a quarter (the office,
 * 2026-11-20): completed, scheduled but not completed, not scheduled, or no
 * visit created at all.
 *
 * Counted by property, not by lease, and from every visit the quarter has at
 * the property: the plan's stops, a stop made for a lease that has ended since
 * (its new tenant moved in after it), and a visit booked straight in Jobber
 * under the programme's name. Matching by lease filed a property visited for
 * its old tenant under "none", and one re-booked in Jobber after its stop was
 * taken out of the plan likewise -- measured on production that day.
 *
 * Read only, from the database alone: no map, routing or Jobber call, however
 * often the tab is opened.
 */

/** A visit with the one number that decides which of a property's visits speaks for it. */
interface Candidate {
  buildingId: string;
  visit: CoverageVisit;
  /** 1 done, 2 booked, 3 in the plan with no booking, 4 taken out of the plan. */
  rank: 1 | 2 | 3 | 4;
}

const GROUP_OF_RANK: Record<Candidate['rank'], CoverageGroup> = {
  1: 'COMPLETED',
  2: 'SCHEDULED',
  3: 'NOT_SCHEDULED',
  4: 'NONE',
};

const dayOf = (date: Date | null | undefined) => date?.toISOString().slice(0, 10) ?? null;

function rankOf(visit: CoverageVisit): Candidate['rank'] {
  if (visit.inspectionStatus && isDoneInspectionStatus(visit.inspectionStatus as InspectionStatus)) return 1;
  // Not cancelled (those are left out) and not done: booked, under way, or asking for another visit.
  if (visit.inspectionStatus) return 2;
  return visit.stopStatus === TbpStopStatus.EXCLUDED ? 4 : 3;
}

function detailOf(candidate: Candidate, today: string): CoverageDetail {
  const { visit } = candidate;
  switch (candidate.rank) {
    case 1:
      return visit.inspectionStatus === InspectionStatus.COMPLETED ? 'FINISHED' : 'IN_REVIEW';
    case 2:
      return visit.scheduledOn && visit.scheduledOn < today ? 'PAST_DUE' : 'UPCOMING';
    case 3:
      return visit.stopStatus === TbpStopStatus.UNSCHEDULED
        ? 'NO_DAY'
        : visit.stopStatus === TbpStopStatus.BLOCKED
          ? 'NEEDS_PERSON'
          : 'NOT_SENT';
    default:
      return 'EXCLUDED';
  }
}

/**
 * Whether `next` speaks for its property better than `best`: the furthest
 * along first; then the current lease's over an ended one; then, among done
 * visits the latest, and among the rest the soonest.
 */
function betterThan(next: Candidate, best: Candidate): boolean {
  if (next.rank !== best.rank) return next.rank < best.rank;
  if (next.visit.previousLease !== best.visit.previousLease) return !next.visit.previousLease;
  const a = next.visit.scheduledOn ?? '';
  const b = best.visit.scheduledOn ?? '';
  if (a === b) return false;
  if (!a || !b) return Boolean(a);
  return next.rank === 1 ? a > b : a < b;
}

/** Still going ahead: booked, or waiting in the plan or on Jobber's Unscheduled list. */
const isOpen = (candidate: Candidate) => candidate.rank === 2 || candidate.rank === 3;

const DETAIL_ORDER = new Map(COVERAGE_DETAILS.map(({ detail }, index) => [detail, index]));

@Injectable()
export class QuarterCoverageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async coverage(organizationId: string, planId: string, now: Date = new Date()): Promise<QuarterCoverage> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { id: true, quarterYear: true, quarterNumber: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    const label = `Q${plan.quarterNumber} ${plan.quarterYear}`;
    const today = businessDate(now);

    const [membership, stops, jobberVisits] = await Promise.all([
      packageMembership(this.prisma, organizationId),
      this.prisma.tbpQuarterPlanStop.findMany({
        where: { organizationId, planId: plan.id },
        select: {
          id: true,
          propertywareBuildingId: true,
          propertywareTenantId: true,
          status: true,
          scheduledOn: true,
          inspectionType: true,
          jobberVisitId: true,
          blockedMessage: true,
          assignedTechnician: { select: { displayName: true } },
          tenant: { select: { isActive: true, propertywareBuildingId: true } },
          inspection: {
            select: {
              id: true,
              status: true,
              scheduledAt: true,
              jobberVisitId: true,
              assignments: { where: { isCurrent: true }, select: { technician: { select: { displayName: true } } }, take: 1 },
            },
          },
        },
      }),
      // Booked in Jobber under the programme's name, with no stop: the same
      // three-way rule the inspections list uses for its quarter filter.
      this.prisma.inspection.findMany({
        where: {
          organizationId,
          tbpPlanStop: { is: null },
          status: { not: InspectionStatus.CANCELLED },
          propertywareBuildingId: { not: null },
          AND: [
            { jobberVisitTitle: { contains: TBP_TITLE_MARKER, mode: 'insensitive' } },
            { jobberVisitTitle: { contains: label, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          propertywareBuildingId: true,
          status: true,
          scheduledAt: true,
          inspectionType: true,
          jobberVisitId: true,
          jobberVisitTitle: true,
          assignments: { where: { isCurrent: true }, select: { technician: { select: { displayName: true } } }, take: 1 },
        },
      }),
    ]);

    const candidates: Candidate[] = [];
    const add = (buildingId: string, visit: CoverageVisit) => candidates.push({ buildingId, visit, rank: rankOf(visit) });
    for (const stop of stops) {
      const buildingId = stop.propertywareBuildingId ?? stop.tenant.propertywareBuildingId;
      if (!buildingId) continue;
      // A cancelled inspection is no visit: the stop is what is left.
      const inspection = stop.inspection && stop.inspection.status !== InspectionStatus.CANCELLED ? stop.inspection : null;
      add(buildingId, {
        stopId: stop.id,
        inspectionId: inspection?.id ?? null,
        inspectionType: stop.inspectionType,
        scheduledOn: dayOf(inspection?.scheduledAt ?? stop.scheduledOn),
        technician: inspection?.assignments[0]?.technician.displayName ?? stop.assignedTechnician?.displayName ?? null,
        inspectionStatus: inspection?.status ?? null,
        stopStatus: stop.status,
        bookedInJobber: Boolean(inspection?.jobberVisitId ?? stop.jobberVisitId),
        fromJobber: false,
        previousLease: !stop.tenant.isActive,
        note: stop.blockedMessage,
      });
    }
    for (const inspection of jobberVisits) {
      // "Q4 2026" in some other part of the title is not the quarter it names.
      if (visitQuarter({ scheduledAt: inspection.scheduledAt, jobberVisitTitle: inspection.jobberVisitTitle }) !== label) continue;
      add(inspection.propertywareBuildingId!, {
        stopId: null,
        inspectionId: inspection.id,
        inspectionType: inspection.inspectionType,
        scheduledOn: dayOf(inspection.scheduledAt),
        technician: inspection.assignments[0]?.technician.displayName ?? null,
        inspectionStatus: inspection.status,
        stopStatus: null,
        bookedInJobber: Boolean(inspection.jobberVisitId),
        fromJobber: true,
        previousLease: false,
        note: null,
      });
    }

    const byBuilding = new Map<string, Candidate[]>();
    for (const candidate of candidates)
      byBuilding.set(candidate.buildingId, [...(byBuilding.get(candidate.buildingId) ?? []), candidate]);
    const bestOf = (list: Candidate[]) => list.reduce((best, next) => (betterThan(next, best) ? next : best));

    const inPackage = [...membership].filter(([, standing]) => standing.inPackage).map(([buildingId]) => buildingId);
    const leavers = [...byBuilding]
      .filter(([buildingId]) => membership.get(buildingId)?.inPackage !== true)
      .map(([buildingId, list]) => ({ buildingId, open: list.filter(isOpen) }))
      .filter(({ open }) => open.length);

    const [buildings, tenancies] = await Promise.all([
      this.prisma.propertywareBuilding.findMany({
        where: { organizationId, id: { in: [...inPackage, ...leavers.map(({ buildingId }) => buildingId)] } },
        select: { id: true, addressLine1: true, name: true, city: true },
      }),
      this.prisma.propertywareTenant.findMany({
        where: { organizationId, isActive: true, propertywareBuildingId: { in: inPackage } },
        select: { id: true, propertywareBuildingId: true, tbpEnrollment: true, zone: true, firstSyncedAt: true },
      }),
    ]);
    const buildingOf = new Map(buildings.map((building) => [building.id, building]));
    const addressOf = (buildingId: string) => {
      const building = buildingOf.get(buildingId);
      return building?.addressLine1?.trim() || building?.name || 'Unknown property';
    };
    // The leases the plan has a stop for, under any status: what adding a property would leave alone.
    const planned = new Set(stops.map((stop) => stop.propertywareTenantId));
    const leasesOf = new Map<string, { count: number; missing: number; zone: string | null; newest: Date | null }>();
    for (const tenancy of tenancies) {
      if (!isTbpEnrolled(tenancy.tbpEnrollment) || !isTbpZone(tenancy.zone)) continue;
      const buildingId = tenancy.propertywareBuildingId!;
      const was = leasesOf.get(buildingId) ?? { count: 0, missing: 0, zone: null, newest: null };
      leasesOf.set(buildingId, {
        count: was.count + 1,
        missing: was.missing + (planned.has(tenancy.id) ? 0 : 1),
        zone: was.zone ?? tenancy.zone?.trim() ?? null,
        newest: !was.newest || tenancy.firstSyncedAt > was.newest ? tenancy.firstSyncedAt : was.newest,
      });
    }

    const properties: QuarterCoverageProperty[] = inPackage.map((buildingId) => {
      const list = byBuilding.get(buildingId) ?? [];
      const best = list.length ? bestOf(list) : null;
      const leases = leasesOf.get(buildingId);
      return {
        buildingId,
        address: addressOf(buildingId),
        city: buildingOf.get(buildingId)?.city?.trim() || null,
        zone: leases?.zone ?? null,
        leases: leases?.count ?? 0,
        firstOnReport: leases?.newest?.toISOString() ?? null,
        group: best ? GROUP_OF_RANK[best.rank] : 'NONE',
        detail: best ? detailOf(best, today) : 'NOT_PLANNED',
        visit: best?.visit ?? null,
        previousLeaseOpen: list.filter((candidate) => candidate !== best && candidate.visit.previousLease && isOpen(candidate))
          .length,
        missingLeases: leases?.missing ?? 0,
      };
    });

    const leftWithOpenVisit: QuarterCoverageLeaver[] = leavers.map(({ buildingId, open }) => ({
      buildingId,
      address: addressOf(buildingId),
      city: buildingOf.get(buildingId)?.city?.trim() || null,
      visit: bestOf(open).visit,
    }));

    const groupOrder = (group: CoverageGroup) => COVERAGE_GROUPS.indexOf(group);
    return {
      planId: plan.id,
      quarterYear: plan.quarterYear,
      quarterNumber: plan.quarterNumber,
      today,
      properties: properties.sort(
        (a, b) =>
          groupOrder(a.group) - groupOrder(b.group) ||
          DETAIL_ORDER.get(a.detail)! - DETAIL_ORDER.get(b.detail)! ||
          (a.visit?.scheduledOn ?? '9999').localeCompare(b.visit?.scheduledOn ?? '9999') ||
          a.address.localeCompare(b.address),
      ),
      leftWithOpenVisit: leftWithOpenVisit.sort(
        (a, b) => (a.visit.scheduledOn ?? '9999').localeCompare(b.visit.scheduledOn ?? '9999') || a.address.localeCompare(b.address),
      ),
    };
  }
}
