import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus } from '@prisma/client';
import {
  type RouteLeg,
  type RouteStop,
  shortestRouteOrder,
  type TechnicianRoute,
} from '@texasrenters/shared';

import { PrismaService } from '../common/prisma.service';
import { type GeoPoint, OsrmClient } from './osrm.client';

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

@Injectable()
export class RouteService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OsrmClient) private readonly osrm: OsrmClient,
  ) {}

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
      estimated: true,
    };

    // Without a position there is no starting point, and without at least one
    // stop there is nothing to order. Both return the stops unordered rather
    // than an error: the day is still known, it simply has no route yet.
    if (!origin || !routable.length) return empty;

    const points: GeoPoint[] = [origin, ...routable];
    const matrix = await this.osrm.durations(points);
    if (!matrix) return empty;

    const order = shortestRouteOrder(matrix);
    const ordered = order.map((index) => routable[index - 1]).filter(Boolean) as RouteStop[];

    const drive = await this.osrm.route([origin, ...ordered]);
    if (!drive) return { ...empty, stops: ordered };

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
      estimated: true,
    };
  }
}
