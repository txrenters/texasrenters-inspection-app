import { Inject, Injectable } from '@nestjs/common';
import {
  dayTotals,
  driveToPlace,
  projectRemainder,
  secondsAtPlace,
  segmentDay,
  type DayTotals,
  type RemainderProjection,
  type TimelinePlace,
  type TimelineSegment,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { businessDayBounds } from '../common/business-day';
import { PrismaService } from '../common/prisma.service';
import { RouteService } from '../routing/route.service';

/**
 * How a technician's day actually went, as opposed to how it was planned.
 *
 * The planner allocates work in **stop counts** — every technician has a
 * `dailyStopCap`, and a fifteen-minute occupied visit spends as much of it as a
 * ninety-minute move-out. Planning in time needs measured time, and until now
 * nothing measured any.
 *
 * Read on demand rather than stored. The trail it is derived from is already
 * durable, the segmentation is pure and cheap, and a stored copy would be a
 * second version of the same day that could disagree with the first the moment
 * a late fix arrived from a handset that had been out of signal.
 */
@Injectable()
export class TechnicianTimelineService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RouteService) private readonly routes: RouteService,
  ) {}

  /**
   * One technician, one Texas day.
   *
   * The day is bounded in `America/Chicago`, not UTC. UTC midnight is 6 or 7pm
   * Texas the previous evening, so a UTC-bounded day would cut an evening shift
   * in half and file the back end of it under tomorrow.
   */
  async dayFor(user: AuthenticatedUser, technicianId: string, date: Date) {
    const { start, end } = businessDayBounds(date);

    /**
     * The stops are the places. Keyed by building rather than by inspection,
     * because two inspections at one address on one day are **one visit** —
     * attributing the time to each separately would report it twice and put
     * the average visit length out by a factor nobody could see.
     */
    const assignments = await this.prisma.inspectionAssignment.findMany({
      where: {
        isCurrent: true,
        technicianId,
        inspection: {
          organizationId: user.organizationId,
          scheduledAt: { gte: start, lt: end },
        },
      },
      select: {
        inspection: {
          select: {
            id: true,
            propertywareBuildingId: true,
            propertywareBuilding: {
              select: { id: true, name: true, latitude: true, longitude: true },
            },
          },
        },
      },
    });

    const places = new Map<
      string,
      { propertyName: string; latitude: number; longitude: number; inspectionIds: string[] }
    >();
    for (const row of assignments) {
      const building = row.inspection.propertywareBuilding;
      // A stop with no coordinate cannot be a place on a trail. It is still a
      // real inspection, and it is carried out separately rather than silently
      // dropped, so "you have five stops and I can time four" is visible.
      if (!building?.latitude || !building.longitude) continue;
      const existing = places.get(building.id);
      if (existing) existing.inspectionIds.push(row.inspection.id);
      else
        places.set(building.id, {
          propertyName: building.name,
          latitude: building.latitude.toNumber(),
          longitude: building.longitude.toNumber(),
          inspectionIds: [row.inspection.id],
        });
    }

    const fixes = await this.prisma.technicianLocationPing.findMany({
      where: {
        organizationId: user.organizationId,
        technicianId,
        recordedAt: { gte: start, lt: end },
      },
      select: { latitude: true, longitude: true, recordedAt: true },
      orderBy: { recordedAt: 'asc' },
    });

    const timelinePlaces: TimelinePlace[] = [...places.entries()].map(([id, place]) => ({
      id,
      latitude: place.latitude,
      longitude: place.longitude,
    }));

    const segments = segmentDay(
      // Numbers, not Prisma `Decimal`s: a Decimal is not a number to arithmetic
      // and would make every distance NaN, which reads as "never near anything".
      fixes.map((fix) => ({
        latitude: fix.latitude.toNumber(),
        longitude: fix.longitude.toNumber(),
        recordedAt: fix.recordedAt.toISOString(),
      })),
      timelinePlaces,
    );

    const inspectionToBuilding = new Map<string, string>();
    for (const [buildingId, place] of places)
      for (const inspectionId of place.inspectionIds)
        inspectionToBuilding.set(inspectionId, buildingId);

    const stops = [...places.entries()].map(([buildingId, place]) => ({
      buildingId,
      propertyName: place.propertyName,
      inspectionIds: place.inspectionIds,
      onSiteSeconds: secondsAtPlace(segments, buildingId),
      driveToSeconds: driveToPlace(segments, buildingId),
    }));

    const unplaceable = assignments
      .filter((row) => !row.inspection.propertywareBuilding?.latitude)
      .map((row) => row.inspection.id);

    /**
     * A stop nobody has been to yet is one still to do.
     *
     * Read from the trail rather than from inspection status on purpose: an
     * inspection can sit un-submitted for hours after the technician has driven
     * away, and a projection built on paperwork would keep a finished property
     * in the remaining work all afternoon.
     */
    const remainingIds = new Set(
      stops.filter((stop) => stop.onSiteSeconds === 0).map((stop) => stop.buildingId),
    );

    /**
     * Real drive times where the router can give them.
     *
     * `planDay` orders the remainder from where the technician is now, which is
     * the only ordering a projection should use -- the planned order stopped
     * being the truth the moment they deviated from it. It never throws;
     * routing being unavailable leaves the legs empty and each stop falls back
     * to the per-visit figure, which the projection says it is doing.
     */
    const route = await this.routes
      .planDay(user.organizationId, technicianId, date)
      .catch(() => null);

    const driveByBuilding = new Map<string, number>();
    route?.stops.forEach((stop, index) => {
      const leg = route.legs[index];
      const buildingId = inspectionToBuilding.get(stop.inspectionId);
      if (leg && buildingId) driveByBuilding.set(buildingId, leg.durationSeconds);
    });

    const remaining = [...remainingIds].map((buildingId) => ({
      driveSeconds: driveByBuilding.get(buildingId) ?? null,
    }));

    return {
      technicianId,
      segments,
      totals: dayTotals(segments),
      stops,
      projection: projectRemainder(segments, remaining),
      /** Assigned, but with no coordinate to time them against. */
      untimedInspectionIds: unplaceable,
    } satisfies TechnicianDayTimeline;
  }
}

export interface TechnicianDayTimeline {
  technicianId: string;
  segments: TimelineSegment[];
  totals: DayTotals;
  projection: RemainderProjection;
  stops: {
    buildingId: string;
    propertyName: string;
    inspectionIds: string[];
    onSiteSeconds: number;
    driveToSeconds: number | null;
  }[];
  untimedInspectionIds: string[];
}
