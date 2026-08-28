import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus } from '@prisma/client';
import {
  haversineMeters,
  type RouteLeg,
  type RouteStop,
  shortestRouteOrder,
  type TechnicianAssignments,
  type TechnicianRoute,
} from '@texasrenters/shared';

import { PrismaService } from '../common/prisma.service';
import { OsrmClient } from './osrm.client';

/**
 * A technician's day, in the order it should be driven.
 *
 * Two things this deliberately does not do. It does not store the order — there
 * is no `sequence` column, and adding one would assert that the technician is
 * expected to follow this, which is a dispatch policy nobody has set. And it
 * does not promise arrival times: `Inspection.scheduledAt` is a date with no
 * time of day, so no appointment exists to be early or late for.
 */

/**
 * Work that is finished or abandoned is not somewhere to drive to.
 *
 * `TECHNICIAN_SUBMITTED` and everything after it means the technician has left
 * the property; routing them back to it would pad the day with a journey that
 * has no reason to happen.
 */
const VISITABLE: InspectionStatus[] = [
  InspectionStatus.SCHEDULED,
  InspectionStatus.IN_PROGRESS,
  InspectionStatus.FOLLOW_UP_REQUIRED,
];

/**
 * OSRM's `[lon, lat]` path as `[lat, lng]`, which is what draws a map.
 *
 * Exported for its test. This is the third place in this codebase where the
 * two orders meet -- the Census geocoder puts longitude in `x`, OSRM takes
 * `lon,lat`, and Leaflet wants `lat,lng` -- and each time the failure is
 * silent: the line simply appears somewhere else on Earth.
 */
export function toLatLngPath(
  path: readonly [number, number][],
): [number, number][] {
  return path.map(([longitude, latitude]) => [latitude, longitude]);
}

/**
 * The closest stop as the crow flies, and how far that is.
 *
 * Only used when no road route exists, which is the one case where "nearest"
 * cannot be answered by driving time. Null for an empty day, so the console has
 * nothing to draw rather than a line to nowhere.
 */
function nearestByAir(
  origin: { latitude: number; longitude: number },
  stops: readonly RouteStop[],
): TechnicianRoute['airTravel'] {
  let best: TechnicianRoute['airTravel'] = null;

  for (const stop of stops) {
    const distanceMeters = Math.round(haversineMeters(origin, stop));
    if (!best || distanceMeters < best.distanceMeters)
      best = { inspectionId: stop.inspectionId, distanceMeters };
  }

  return best;
}

@Injectable()
export class RouteService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OsrmClient) private readonly osrm: OsrmClient,
  ) {}

  /**
   * Everyone with work today, and which properties it is at.
   *
   * One query for the whole roster rather than a route each: the console panel
   * needs to list people and highlight their properties, which is a grouping
   * problem, not a routing one. Planning a route per technician to answer it
   * would call OSRM once per person to draw a list.
   *
   * Technicians with nothing scheduled are absent rather than listed empty --
   * a dispatcher scanning the panel wants the people who are working, and a
   * row saying "no stops" for everyone off that day is noise.
   */
  async assignmentsByTechnician(
    organizationId: string,
    date: Date,
  ): Promise<TechnicianAssignments[]> {
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const assignments = await this.prisma.inspectionAssignment.findMany({
      where: {
        isCurrent: true,
        inspection: {
          organizationId,
          status: { in: VISITABLE },
          scheduledAt: { gte: dayStart, lt: dayEnd },
        },
      },
      select: {
        technicianId: true,
        technician: { select: { displayName: true } },
        inspection: {
          select: {
            id: true,
            propertywareBuildingId: true,
            inspectionType: true,
            status: true,
            // Both, for the same reason the route planner reads both: a real
            // inspection names a synced building, and `Property` exists only
            // where the inspection workflow happened to create one.
            propertywareBuilding: { select: { name: true } },
            property: { select: { name: true } },
          },
        },
      },
    });

    const byTechnician = new Map<string, TechnicianAssignments>();
    for (const assignment of assignments) {
      const existing = byTechnician.get(assignment.technicianId) ?? {
        technicianId: assignment.technicianId,
        displayName: assignment.technician?.displayName ?? 'Unknown technician',
        stops: [],
      };

      const inspection = assignment.inspection;
      existing.stops.push({
        inspectionId: inspection.id,
        // Null is carried rather than filtered. The technician still has to go
        // there; it simply cannot be pointed at on a map.
        buildingId: inspection.propertywareBuildingId,
        propertyName:
          inspection.propertywareBuilding?.name ??
          inspection.property?.name ??
          'Unknown property',
        inspectionType: inspection.inspectionType,
        status: inspection.status,
      });

      byTechnician.set(assignment.technicianId, existing);
    }

    for (const entry of byTechnician.values())
      // By property, because the day has no order of its own: `scheduledAt` is
      // a date with no clock value, so any sequence beyond alphabetical would
      // be invented. The suggested driving order lives on the route endpoint,
      // where it is computed rather than implied.
      entry.stops.sort((left, right) => left.propertyName.localeCompare(right.propertyName));

    return [...byTechnician.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  /**
   * Plan one technician's day.
   *
   * `date` is a plain calendar day because that is the only granularity the
   * schema has. Everything scheduled for it and still worth visiting is a stop.
   */
  async planDay(
    organizationId: string,
    technicianId: string,
    date: Date,
  ): Promise<TechnicianRoute> {
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const assignments = await this.prisma.inspectionAssignment.findMany({
      where: {
        technicianId,
        isCurrent: true,
        inspection: {
          organizationId,
          status: { in: VISITABLE },
          scheduledAt: { gte: dayStart, lt: dayEnd },
        },
      },
      select: {
        inspection: {
          select: {
            id: true,
            // Both, and the building first.
            //
            // A real inspection carries `propertywareBuildingId` and leaves
            // `propertyId` null -- `Property` rows only exist where the
            // inspection workflow happened to create one. Reading only the
            // `property` relation therefore found nothing on real data and
            // reported every stop as unplaceable, while passing a test built
            // on fabricated rows that had `propertyId` set.
            //
            // The building is also what the map draws, so a route and a pin
            // now refer to the same record rather than two views of a
            // property that may not agree.
            propertywareBuilding: {
              select: {
                id: true,
                name: true,
                addressLine1: true,
                city: true,
                latitude: true,
                longitude: true,
              },
            },
            property: {
              select: {
                id: true,
                name: true,
                addressLine1: true,
                city: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
      },
    });

    const routable: RouteStop[] = [];
    const unroutable: TechnicianRoute['unroutable'] = [];

    for (const { inspection } of assignments) {
      // The synced building is the truth for where a property is; the
      // `Property` row is a fallback for the handful of inspections created
      // through the floor-plan or technician paths.
      const property = inspection.propertywareBuilding ?? inspection.property;
      // Carried, not dropped. A property that never geocoded cannot be routed
      // to, and quietly omitting it turns "you have five inspections" into a
      // route of four with nothing to explain the difference.
      if (!property?.latitude || !property.longitude) {
        unroutable.push({
          inspectionId: inspection.id,
          propertyName: property?.name ?? 'Unknown property',
          reason: 'NO_COORDINATES',
        });
        continue;
      }
      routable.push({
        inspectionId: inspection.id,
        propertyId: property.id,
        propertyName: property.name,
        // Nullable on a synced record and not on the contract. An empty string
        // rather than dropping the stop: a thin label is still a place to
        // drive to, a missing stop is a property nobody is told about.
        addressLine1: property.addressLine1 ?? '',
        city: property.city ?? '',
        latitude: property.latitude.toNumber(),
        longitude: property.longitude.toNumber(),
      });
    }

    const position = await this.prisma.technicianLocationPing.findFirst({
      where: { organizationId, technicianId },
      orderBy: { recordedAt: 'desc' },
      select: { latitude: true, longitude: true, recordedAt: true },
    });

    const origin = position
      ? {
          latitude: position.latitude.toNumber(),
          longitude: position.longitude.toNumber(),
          recordedAt: position.recordedAt.toISOString(),
        }
      : null;

    const empty: TechnicianRoute = {
      technicianId,
      origin,
      stops: routable,
      legs: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      unroutable,
      geometry: [],
      originOutsideServiceArea: false,
      airTravel: null,
      estimated: true,
    };

    // Without a position there is no starting point, and without at least one
    // stop there is nothing to order. Both return the stops unordered rather
    // than an error: the day is still known, it simply has no route yet.
    if (!origin || !routable.length) return empty;

    let stops = routable;
    let matrix = await this.osrm.durations([origin, ...stops]);

    if (!matrix) {
      // The matrix refuses the whole request when any one point is off the
      // road network, and does not say which. Ask per point.
      //
      // This is the branch that used to not exist, and its absence is what
      // drew a four-hour drive from a technician who was on another continent:
      // OSRM answered `Ok` for a point it had quietly relocated, so there was
      // never a failure to handle.
      const reachable = await this.osrm.snappable([origin, ...stops]);

      // Null means OSRM could not be asked, which is an outage rather than a
      // fact about any of these points. Blaming the technician's position for
      // it would be a confident wrong answer of exactly the kind this whole
      // change is about.
      if (!reachable) return empty;

      // The origin first, because a route without a starting point is not a
      // shorter route -- it is a different question. Starting from the first
      // stop instead would silently answer that different question.
      if (!reachable[0])
        return {
          ...empty,
          originOutsideServiceArea: true,
          // The nearest stop, so the console can draw one line and give one
          // number rather than a fan of them. Nearest by great-circle because
          // there is no road distance to sort by -- that is the whole problem.
          airTravel: nearestByAir(origin, stops),
        };

      const kept: RouteStop[] = [];
      stops.forEach((stop, index) => {
        if (reachable[index + 1]) kept.push(stop);
        else
          // Moved rather than dropped, so the panel still lists the property
          // and can say why it is not in the drive. A geocode that landed in
          // open water is a data fault worth seeing, not one worth hiding.
          unroutable.push({
            inspectionId: stop.inspectionId,
            propertyName: stop.propertyName,
            reason: 'OUTSIDE_SERVICE_AREA',
          });
      });

      if (!kept.length) return { ...empty, stops: [], unroutable };

      stops = kept;
      matrix = await this.osrm.durations([origin, ...stops]);
      if (!matrix) return { ...empty, stops, unroutable };
    }

    const order = shortestRouteOrder(matrix);
    const ordered = order.map((index) => stops[index - 1]).filter(Boolean) as RouteStop[];

    const drive = await this.osrm.route([origin, ...ordered]);
    if (!drive) return { ...empty, stops: ordered, unroutable };

    // OSRM returns one leg per consecutive pair, so leg `i` arrives at stop
    // `i`. The first has no `fromStopId` because it starts at the technician.
    const legs: RouteLeg[] = drive.legs.map((leg, index) => ({
      fromStopId: index === 0 ? null : (ordered[index - 1]?.inspectionId ?? null),
      toStopId: ordered[index]?.inspectionId ?? '',
      distanceMeters: Math.round(leg.distanceMeters),
      durationSeconds: Math.round(leg.durationSeconds),
    }));

    return {
      technicianId,
      origin,
      stops: ordered,
      legs,
      totalDistanceMeters: Math.round(drive.distanceMeters),
      totalDurationSeconds: Math.round(drive.durationSeconds),
      unroutable,
      geometry: toLatLngPath(drive.geometry),
      // False by construction: getting here means the origin snapped to a road.
      originOutsideServiceArea: false,
      airTravel: null,
      estimated: true,
    };
  }
}
