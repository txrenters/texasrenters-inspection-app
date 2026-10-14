import { Inject, Injectable, Logger } from '@nestjs/common';
import { TbpPackageChangeKind } from '@prisma/client';
import {
  type GroupInsertion,
  type GroupSuggestion,
  type GroupTemplateChanges,
  type PackageChangeGroup,
  type PackageLeaver,
  type PackageNewcomer,
  type PackageUnplaced,
  insertionNeighbours,
  MAX_STOPS_PER_DAY,
  nearestGroups,
} from '@texasrenters/shared';

import { SERVICE_STATUS_VIEW_SELECT } from '../admin/property-service-status';
import { firstOnReport, packageHistory, packageStanding, type PackageTenancy } from '../common/benefit-package';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MapboxDirectionsClient } from '../routing/mapbox-directions.client';
import type { GeoPoint } from '../routing/osrm.client';
import { GroupTemplateService } from './group-template.service';

/**
 * What changed in the benefit package under one group template (the office,
 * 2026-10-15): which of its properties left the package, the group each is
 * still in and why; and which properties joined and are in no group, with the
 * groups each would fit best by the driving it adds.
 *
 * Read only. A leaver stays in its group until the office takes it out, and a
 * newcomer goes nowhere until the office puts it somewhere; a quarter built
 * from the template places a newcomer itself, the same way the suggestion is
 * worked out, but nobody saw where until now.
 */

/** How many groups a newcomer is offered. */
const SUGGESTIONS = 3;

/** How many newcomers are timed on the road at once. */
const ROAD_CONCURRENCY = 4;

/** How long a road matrix is kept: the roads do not move, but a member can. */
const ROAD_CACHE_MS = 30 * 60 * 1000;
const ROAD_CACHE_SIZE = 1000;

/** A position, rounded to the metre, as a cache key. */
const keyOf = (point: GeoPoint) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;

@Injectable()
export class GroupTemplateChangesService {
  private readonly logger = new Logger(GroupTemplateChangesService.name);
  private readonly roads = new Map<string, { at: number; seconds: number[][] }>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GroupTemplateService) private readonly templates: GroupTemplateService,
    @Inject(MapboxDirectionsClient) private readonly mapbox: MapboxDirectionsClient,
  ) {}

  async changes(organizationId: string, templateId: string): Promise<GroupTemplateChanges> {
    const template = await this.prisma.tbpGroupTemplate.findFirst({
      where: { id: templateId, organizationId },
      select: {
        id: true,
        revision: true,
        groups: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            position: true,
            name: true,
            color: true,
            target: true,
            members: {
              orderBy: { position: 'asc' },
              select: { buildingId: true, building: { select: { addressLine1: true, name: true } } },
            },
          },
        },
      },
    });
    if (!template) throw new ApplicationError(404, 'TEMPLATE_NOT_FOUND', 'This group template does not exist.');

    const { properties } = await this.templates.properties(organizationId);
    const drawn = new Map(properties.map((property) => [property.buildingId, property]));

    const groupOf = new Map<string, { group: PackageChangeGroup; address: string }>();
    for (const group of template.groups) {
      const ref: PackageChangeGroup = { id: group.id, position: group.position, name: group.name, color: group.color };
      for (const member of group.members)
        groupOf.set(member.buildingId, {
          group: ref,
          address: member.building.addressLine1?.trim() || member.building.name,
        });
    }

    const { leavers, unplaced } = await this.gone(organizationId, groupOf, drawn);
    const newcomers = await this.newcomers(organizationId, template.groups, groupOf, drawn);
    return { templateId: template.id, revision: template.revision, leavers, unplaced, newcomers };
  }

  /** The template's members the Group maker no longer draws: left the package, or still in it without a position. */
  private async gone(
    organizationId: string,
    groupOf: ReadonlyMap<string, { group: PackageChangeGroup; address: string }>,
    drawn: ReadonlyMap<string, unknown>,
  ): Promise<{ leavers: PackageLeaver[]; unplaced: PackageUnplaced[] }> {
    const ids = [...groupOf.keys()].filter((buildingId) => !drawn.has(buildingId));
    if (!ids.length) return { leavers: [], unplaced: [] };
    const [buildings, tenancies, history] = await Promise.all([
      this.prisma.propertywareBuilding.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, serviceStatus: { select: SERVICE_STATUS_VIEW_SELECT } },
      }),
      this.prisma.propertywareTenant.findMany({
        where: { organizationId, propertywareBuildingId: { in: ids } },
        select: { propertywareBuildingId: true, isActive: true, tbpEnrollment: true, zone: true, deactivatedAt: true },
      }),
      packageHistory(this.prisma, organizationId, ids, TbpPackageChangeKind.LEFT),
    ]);
    const switchesOf = new Map(buildings.map((building) => [building.id, building.serviceStatus]));
    const tenanciesOf = new Map<string, PackageTenancy[]>();
    for (const tenancy of tenancies) {
      const buildingId = tenancy.propertywareBuildingId!;
      tenanciesOf.set(buildingId, [...(tenanciesOf.get(buildingId) ?? []), tenancy]);
    }

    const leavers: PackageLeaver[] = [];
    const unplaced: PackageUnplaced[] = [];
    for (const buildingId of ids) {
      const { group, address } = groupOf.get(buildingId)!;
      const standing = packageStanding(switchesOf.get(buildingId), tenanciesOf.get(buildingId) ?? []);
      if (standing.inPackage) unplaced.push({ buildingId, address, group });
      else
        leavers.push({
          buildingId,
          address,
          group,
          // What Propertyware said carries no date of its own; the package's
          // history, kept since 2026-10-15, says when the sync saw it.
          reasons: standing.reasons.map((reason) => {
            if (reason.since) return reason;
            const seen = history.get(buildingId)?.find((change) => change.reason === reason.code);
            return seen ? { ...reason, since: seen.occurredAt.toISOString() } : reason;
          }),
        });
    }
    const byGroup = <T extends { group: PackageChangeGroup; address: string }>(left: T, right: T) =>
      left.group.position - right.group.position || left.address.localeCompare(right.address);
    return { leavers: leavers.sort(byGroup), unplaced: unplaced.sort(byGroup) };
  }

  /** Properties in the package that no group names, each with the groups it would fit best. */
  private async newcomers(
    organizationId: string,
    groups: readonly {
      id: string;
      position: number;
      name: string;
      color: string;
      target: number;
      members: readonly { buildingId: string }[];
    }[],
    groupOf: ReadonlyMap<string, unknown>,
    drawn: ReadonlyMap<
      string,
      { buildingId: string; address: string; city: string | null; zone: string | null; latitude: number; longitude: number }
    >,
  ): Promise<PackageNewcomer[]> {
    const fresh = [...drawn.values()].filter((property) => !groupOf.has(property.buildingId));
    if (!fresh.length) return [];

    // Each group's members still in the package, in its driving order: what a day of it would visit.
    const paths = groups.map((group) => {
      const members = group.members.flatMap((member) => {
        const property = drawn.get(member.buildingId);
        return property
          ? [{ address: property.address, point: { latitude: property.latitude, longitude: property.longitude } }]
          : [];
      });
      return {
        id: group.id,
        ref: { id: group.id, position: group.position, name: group.name, color: group.color } satisfies PackageChangeGroup,
        target: group.target,
        members,
        points: members.map((member) => member.point),
      };
    });
    const pathOf = new Map(paths.map((path) => [path.id, path]));

    const freshIds = fresh.map((property) => property.buildingId);
    const [onReport, joins] = await Promise.all([
      firstOnReport(this.prisma, organizationId, freshIds),
      packageHistory(this.prisma, organizationId, freshIds, TbpPackageChangeKind.JOINED),
    ]);

    const results: PackageNewcomer[] = new Array<PackageNewcomer>(fresh.length);
    let next = 0;
    const work = async () => {
      while (next < fresh.length) {
        const index = next;
        next += 1;
        const property = fresh[index]!;
        const point = { latitude: property.latitude, longitude: property.longitude };
        const ranked = nearestGroups(point, paths, { limit: SUGGESTIONS });
        results[index] = {
          buildingId: property.buildingId,
          address: property.address,
          city: property.city,
          zone: property.zone,
          firstOnReport: onReport.get(property.buildingId) ?? null,
          joinedAt: joins.get(property.buildingId)?.[0]?.occurredAt.toISOString() ?? null,
          suggestions: await this.timed(point, ranked, pathOf),
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(ROAD_CONCURRENCY, fresh.length) }, work));
    return results.sort((left, right) => left.address.localeCompare(right.address));
  }

  /**
   * The suggested groups, timed on the road where a router answers.
   *
   * Ranked first in a straight line, the planner's own estimate, then the
   * cheapest place in each of the few groups is timed by Mapbox: the drive in
   * from the member before it and on to the member after, less the drive it
   * replaces. One small matrix per newcomer. When no router answers, the
   * estimate stands and says so.
   */
  private async timed(
    point: GeoPoint,
    ranked: readonly GroupInsertion[],
    pathOf: ReadonlyMap<
      string,
      { ref: PackageChangeGroup; target: number; members: { address: string; point: GeoPoint }[] }
    >,
  ): Promise<GroupSuggestion[]> {
    const points: GeoPoint[] = [point];
    const slot = new Map<string, number>();
    const indexOf = (groupId: string, member: number) => {
      const key = `${groupId}:${member}`;
      let index = slot.get(key);
      if (index === undefined) {
        index = points.length;
        points.push(pathOf.get(groupId)!.members[member]!.point);
        slot.set(key, index);
      }
      return index;
    };
    const legs = ranked.map((insertion) => {
      const path = pathOf.get(insertion.groupId)!;
      const { before, after } = insertionNeighbours(insertion.at, path.members.length);
      return {
        before: before === null ? null : indexOf(insertion.groupId, before),
        after: after === null ? null : indexOf(insertion.groupId, after),
        nearest: insertion.nearest ? indexOf(insertion.groupId, insertion.nearest.index) : null,
      };
    });
    const seconds = await this.road(points);

    const suggestions = ranked.map((insertion, index): GroupSuggestion => {
      const path = pathOf.get(insertion.groupId)!;
      const leg = legs[index]!;
      let addedMinutes = insertion.addedMinutes;
      let nearestMinutes = insertion.nearest?.minutes ?? null;
      let timing: GroupSuggestion['timing'] = 'ESTIMATE';
      if (seconds) {
        const minutes = (from: number, to: number) => seconds[from]![to]! / 60;
        const road =
          (leg.before !== null ? minutes(leg.before, 0) : 0) +
          (leg.after !== null ? minutes(0, leg.after) : 0) -
          (leg.before !== null && leg.after !== null ? minutes(leg.before, leg.after) : 0);
        const fromNearest = leg.nearest !== null ? minutes(leg.nearest, 0) : null;
        if (Number.isFinite(road) && (fromNearest === null || Number.isFinite(fromNearest))) {
          addedMinutes = road;
          nearestMinutes = fromNearest;
          timing = 'ROAD';
        }
      }
      const members = path.members.length;
      return {
        group: path.ref,
        members,
        target: path.target,
        hasRoom: members < path.target && members < MAX_STOPS_PER_DAY,
        addedMinutes: Math.max(0, Math.round(addedMinutes)),
        timing,
        nearest:
          insertion.nearest && nearestMinutes !== null
            ? { address: path.members[insertion.nearest.index]!.address, minutes: Math.max(0, Math.round(nearestMinutes)) }
            : null,
      };
    });
    // On the road the order can change; a full group never jumps one with room that adds the same.
    return suggestions.sort(
      (left, right) =>
        left.addedMinutes - right.addedMinutes ||
        Number(right.hasRoom) - Number(left.hasRoom) ||
        (left.nearest?.minutes ?? Infinity) - (right.nearest?.minutes ?? Infinity),
    );
  }

  /** Seconds between every pair on the road, kept a while; null when Mapbox does not answer. */
  private async road(points: readonly GeoPoint[]): Promise<number[][] | null> {
    if (points.length < 2) return null;
    const key = points.map(keyOf).join('|');
    const kept = this.roads.get(key);
    if (kept && Date.now() - kept.at < ROAD_CACHE_MS) return kept.seconds;
    try {
      const matrix = await this.mapbox.matrix(points);
      if (!matrix) return null;
      if (this.roads.size >= ROAD_CACHE_SIZE) this.roads.delete(this.roads.keys().next().value!);
      this.roads.set(key, { at: Date.now(), seconds: matrix.durations });
      return matrix.durations;
    } catch (error) {
      this.logger.warn(`Road times for a group suggestion failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
