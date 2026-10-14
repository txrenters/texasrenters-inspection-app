import { Inject, Injectable } from '@nestjs/common';
import { TbpPackageChangeKind, TbpStopStatus } from '@prisma/client';
import {
  previousQuarter,
  type PackageLeftReasonCode,
  type Quarter,
  type QuarterPackageChanges,
  type QuarterPackageEvent,
  type QuarterPackageJoiner,
  type QuarterPackageLeaver,
  type QuarterVisitPlace,
} from '@texasrenters/shared';

import { firstOnReport, packageHistory, packageMembership } from '../common/benefit-package';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * The benefit package's changes as a quarter sees them (the office,
 * 2026-10-15): "we should have a way to know if a property has opted out or
 * left the TBP ... where was that, what group", and "if there's a new tbp ...
 * we should know also".
 *
 * Last quarter's plan is what "was" means: a property it visited that is out
 * of the package now has left, with the day and group it was visited in; one in
 * the package now that it did not visit is new, with where this quarter put it
 * -- or nowhere, when the quarter was built before it joined. Read only.
 */

/** The most history the tab lists; the office reads the latest, not years of it. */
const HISTORY_LIMIT = 200;

const dayKey = (technicianId: string, date: Date) => `${technicianId}|${date.toISOString().slice(0, 10)}`;

/**
 * Which of a building's visits says most about where it is, lowest first: one
 * still going ahead, then one with a day, then the earliest day. A building of
 * several units has a visit for each.
 */
const rankOf = (place: QuarterVisitPlace) =>
  `${place.status === TbpStopStatus.EXCLUDED ? 1 : 0}${place.scheduledOn ? 0 : 1}${place.scheduledOn ?? ''}`;

@Injectable()
export class QuarterPackageChangesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async changes(organizationId: string, planId: string): Promise<QuarterPackageChanges> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { id: true, quarterYear: true, quarterNumber: true, quarterStartsOn: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    const before = previousQuarter({ year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] });
    const previous = await this.prisma.tbpQuarterPlan.findFirst({
      where: { organizationId, quarterYear: before.year, quarterNumber: before.quarter },
      select: { id: true, quarterYear: true, quarterNumber: true, quarterStartsOn: true },
    });

    const [thisQuarter, lastQuarter] = await Promise.all([
      this.places(organizationId, plan.id),
      previous ? this.places(organizationId, previous.id) : Promise.resolve(new Map<string, QuarterVisitPlace>()),
    ]);
    // Visited last quarter: planned, published or done -- not one taken out of it.
    const visited = new Set(
      [...lastQuarter].filter(([, place]) => place.status !== TbpStopStatus.EXCLUDED).map(([buildingId]) => buildingId),
    );

    // Everyone in the package now, and the ones a plan names that no tenancy is placed at any more.
    const membership = await packageMembership(this.prisma, organizationId);
    const unread = [...new Set([...visited, ...thisQuarter.keys()])].filter((buildingId) => !membership.has(buildingId));
    if (unread.length)
      for (const [buildingId, standing] of await packageMembership(this.prisma, organizationId, unread))
        membership.set(buildingId, standing);

    const leaverIds = [...new Set([...visited, ...thisQuarter.keys()])].filter(
      (buildingId) => membership.get(buildingId)?.inPackage === false,
    );
    const joinerIds = previous
      ? [...membership].filter(([buildingId, standing]) => standing.inPackage && !visited.has(buildingId)).map(([id]) => id)
      : [];

    const since = previous?.quarterStartsOn ?? plan.quarterStartsOn;
    const [events, historyCount, leaves, joins, onReport] = await Promise.all([
      this.prisma.tbpPackageChange.findMany({
        where: { organizationId, occurredAt: { gte: since } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        take: HISTORY_LIMIT,
        select: {
          id: true,
          buildingId: true,
          kind: true,
          source: true,
          reason: true,
          detail: true,
          actorName: true,
          occurredAt: true,
        },
      }),
      this.prisma.tbpPackageChange.count({ where: { organizationId, occurredAt: { gte: since } } }),
      packageHistory(this.prisma, organizationId, leaverIds, TbpPackageChangeKind.LEFT),
      packageHistory(this.prisma, organizationId, joinerIds, TbpPackageChangeKind.JOINED),
      firstOnReport(this.prisma, organizationId, joinerIds),
    ]);
    const addressOf = await this.addresses(organizationId, [
      ...new Set([...leaverIds, ...joinerIds, ...events.map((event) => event.buildingId)]),
    ]);

    const left: QuarterPackageLeaver[] = leaverIds.map((buildingId) => ({
      buildingId,
      address: addressOf.get(buildingId) ?? 'Unknown property',
      // What Propertyware said carries no date of its own; the history saw it go.
      reasons: membership.get(buildingId)!.reasons.map((reason) => {
        if (reason.since) return reason;
        const seen = leaves.get(buildingId)?.find((change) => change.reason === reason.code);
        return seen ? { ...reason, since: seen.occurredAt.toISOString() } : reason;
      }),
      lastQuarter: lastQuarter.get(buildingId) ?? null,
      thisQuarter: thisQuarter.get(buildingId) ?? null,
    }));
    const joined: QuarterPackageJoiner[] = joinerIds.map((buildingId) => ({
      buildingId,
      address: addressOf.get(buildingId) ?? 'Unknown property',
      joinedAt: joins.get(buildingId)?.[0]?.occurredAt.toISOString() ?? null,
      firstOnReport: onReport.get(buildingId) ?? null,
      thisQuarter: thisQuarter.get(buildingId) ?? null,
    }));
    const history: QuarterPackageEvent[] = events.map((event) => ({
      id: event.id,
      buildingId: event.buildingId,
      address: addressOf.get(event.buildingId) ?? 'Unknown property',
      kind: event.kind,
      source: event.source,
      reason: event.reason as PackageLeftReasonCode | null,
      detail: event.detail,
      by: event.actorName,
      occurredAt: event.occurredAt.toISOString(),
    }));

    return {
      planId: plan.id,
      previous: previous
        ? { planId: previous.id, quarterYear: previous.quarterYear, quarterNumber: previous.quarterNumber }
        : null,
      left: left.sort(
        (a, b) =>
          (a.lastQuarter?.group?.position ?? Infinity) - (b.lastQuarter?.group?.position ?? Infinity) ||
          a.address.localeCompare(b.address),
      ),
      // A joiner the quarter has not placed first: it is the one to act on.
      joined: joined.sort(
        (a, b) =>
          Number(Boolean(a.thisQuarter)) - Number(Boolean(b.thisQuarter)) ||
          (a.thisQuarter?.scheduledOn ?? '').localeCompare(b.thisQuarter?.scheduledOn ?? '') ||
          a.address.localeCompare(b.address),
      ),
      history,
      historyMore: Math.max(0, historyCount - history.length),
    };
  }

  /** Each building's visit in a plan, with its day's technician and template group. */
  private async places(organizationId: string, planId: string): Promise<Map<string, QuarterVisitPlace>> {
    const [stops, days] = await Promise.all([
      this.prisma.tbpQuarterPlanStop.findMany({
        where: { organizationId, planId, propertywareBuildingId: { not: null } },
        select: {
          propertywareBuildingId: true,
          status: true,
          scheduledOn: true,
          assignedTechnicianId: true,
          assignedTechnician: { select: { displayName: true } },
        },
      }),
      this.prisma.tbpQuarterPlanDay.findMany({
        where: { organizationId, planId, templateGroupPosition: { not: null } },
        select: {
          technicianId: true,
          date: true,
          templateGroupPosition: true,
          templateGroupName: true,
          templateGroupColor: true,
        },
      }),
    ]);
    const groupOf = new Map(
      days.map((day) => [
        dayKey(day.technicianId, day.date),
        {
          position: day.templateGroupPosition!,
          name: day.templateGroupName ?? `Group ${day.templateGroupPosition}`,
          color: day.templateGroupColor ?? '#64748b',
        },
      ]),
    );
    const places = new Map<string, QuarterVisitPlace>();
    for (const stop of stops) {
      const place: QuarterVisitPlace = {
        status: stop.status,
        scheduledOn: stop.scheduledOn?.toISOString().slice(0, 10) ?? null,
        technician: stop.assignedTechnician?.displayName ?? null,
        group:
          stop.scheduledOn && stop.assignedTechnicianId
            ? (groupOf.get(dayKey(stop.assignedTechnicianId, stop.scheduledOn)) ?? null)
            : null,
      };
      const buildingId = stop.propertywareBuildingId!;
      const was = places.get(buildingId);
      if (!was || rankOf(place) < rankOf(was)) places.set(buildingId, place);
    }
    return places;
  }

  private async addresses(organizationId: string, buildingIds: readonly string[]): Promise<Map<string, string>> {
    if (!buildingIds.length) return new Map();
    const buildings = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId, id: { in: [...buildingIds] } },
      select: { id: true, addressLine1: true, name: true },
    });
    return new Map(buildings.map((building) => [building.id, building.addressLine1?.trim() || building.name]));
  }
}
