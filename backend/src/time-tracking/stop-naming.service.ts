import { Inject, Injectable, Logger } from '@nestjs/common';
import { TimeSegmentCategory, TimeStopPlaceKind } from '@prisma/client';
import { haversineMeters } from '@texasrenters/shared';

import { PrismaService } from '../common/prisma.service';
import { withSystemTenant } from '../database/tenant-context';
import { OpenStreetMapPlacesClient } from './openstreetmap-places.client';

/**
 * What a stop away from the properties was: "The Home Depot", "Home", a
 * property with no visit that day, or a street address.
 *
 * Cheapest first, and our own data before anybody else's:
 *
 * 1. **Home**, where the technician said their day starts. Checked first so a
 *    stop there is never sent anywhere, and shown only as "Home" -- the office
 *    has no use for the address on a timesheet.
 * 2. **A property we manage** that had no visit that day: its address.
 * 3. **A stop already named** close by, so the same store visited every week
 *    is asked about once.
 * 4. **OpenStreetMap**, for everything else.
 *
 * Run after each sweep, a few at a time, rather than while the day is read:
 * reading a day is the timesheet's arithmetic and must not wait on the
 * internet, and a month recalculated at once would otherwise ask hundreds of
 * questions in one request.
 */

/** A stop this close to home was at home. A front door and a street's parking. */
const HOME_WITHIN_METERS = 150;
/** This close to a property's pin is at that property. */
const PROPERTY_WITHIN_METERS = 40;
/** This close to a stop already named is the same place. */
const SAME_PLACE_WITHIN_METERS = 60;
/** Roughly that many metres, in degrees, for a box the database can search. */
const DEGREES_PER_METER = 1 / 111_320;

export interface StopPlace {
  kind: TimeStopPlaceKind;
  name: string | null;
  address: string | null;
}

@Injectable()
export class StopNamingService {
  private readonly logger = new Logger(StopNamingService.name);

  /** Stops named per sweep. A sweep is five minutes; a day has a handful. */
  static readonly BATCH = 20;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OpenStreetMapPlacesClient) private readonly openStreetMap: OpenStreetMapPlacesClient,
  ) {}

  /**
   * Name the stops still waiting for one, newest first.
   *
   * Across organizations, so as the system; every lookup below is still
   * scoped to the stop's own organization. A stop whose lookup could not be
   * made is left for the next sweep. Never throws.
   */
  async nameWaiting(): Promise<{ named: number; waiting: number }> {
    try {
      return await withSystemTenant(async () => {
        const waiting = await this.prisma.timeSegment.findMany({
          where: {
            category: TimeSegmentCategory.STOP,
            placeNamedAt: null,
            placeLatitude: { not: null },
            placeLongitude: { not: null },
          },
          select: {
            id: true,
            organizationId: true,
            technicianId: true,
            placeLatitude: true,
            placeLongitude: true,
          },
          orderBy: { startedAt: 'desc' },
          take: StopNamingService.BATCH,
        });

        let named = 0;
        for (const stop of waiting) {
          const position = { latitude: Number(stop.placeLatitude), longitude: Number(stop.placeLongitude) };
          const place = await this.placeFor(stop.organizationId, stop.technicianId, position);
          if (!place) continue;
          await this.prisma.timeSegment.updateMany({
            // Only if it still has no name: the same stop read twice must not
            // be looked up twice and written twice.
            where: { id: stop.id, organizationId: stop.organizationId, placeNamedAt: null },
            data: {
              placeKind: place.kind,
              placeName: place.name,
              placeAddress: place.address,
              placeNamedAt: new Date(),
            },
          });
          named += 1;
        }
        if (named) this.logger.log({ event: 'time_stops_named', named, waiting: waiting.length });
        return { named, waiting: waiting.length };
      });
    } catch (error) {
      this.logger.error({
        event: 'time_stop_naming_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return { named: 0, waiting: 0 };
    }
  }

  /**
   * What one stop was. Undefined when it could not be found out yet -- the
   * lookup was unreachable -- so it is asked again rather than marked unknown.
   */
  async placeFor(
    organizationId: string,
    technicianId: string,
    position: { latitude: number; longitude: number },
  ): Promise<StopPlace | undefined> {
    const home = await this.prisma.technicianPlanningProfile.findFirst({
      where: { organizationId, technicianId },
      select: { homeLatitude: true, homeLongitude: true },
    });
    if (
      home?.homeLatitude &&
      home.homeLongitude &&
      haversineMeters(position, { latitude: Number(home.homeLatitude), longitude: Number(home.homeLongitude) }) <=
        HOME_WITHIN_METERS
    )
      return { kind: TimeStopPlaceKind.HOME, name: 'Home', address: null };

    const property = this.nearest(
      await this.prisma.propertywareBuilding.findMany({
        where: { organizationId, ...this.boxAround(position, PROPERTY_WITHIN_METERS, 'latitude', 'longitude') },
        select: { addressLine1: true, latitude: true, longitude: true },
        take: 20,
      }),
      position,
      PROPERTY_WITHIN_METERS,
      (row) => ({ latitude: Number(row.latitude), longitude: Number(row.longitude) }),
    );
    if (property?.addressLine1)
      return { kind: TimeStopPlaceKind.PROPERTY, name: property.addressLine1, address: null };

    // Home is somebody's own and a property is matched above, so only places
    // OpenStreetMap named are worth borrowing.
    const known = this.nearest(
      await this.prisma.timeSegment.findMany({
        where: {
          organizationId,
          category: TimeSegmentCategory.STOP,
          placeKind: { in: [TimeStopPlaceKind.BUSINESS, TimeStopPlaceKind.ADDRESS] },
          ...this.boxAround(position, SAME_PLACE_WITHIN_METERS, 'placeLatitude', 'placeLongitude'),
        },
        select: { placeKind: true, placeName: true, placeAddress: true, placeLatitude: true, placeLongitude: true },
        orderBy: { placeNamedAt: 'desc' },
        take: 20,
      }),
      position,
      SAME_PLACE_WITHIN_METERS,
      (row) => ({ latitude: Number(row.placeLatitude), longitude: Number(row.placeLongitude) }),
    );
    if (known?.placeKind) return { kind: known.placeKind, name: known.placeName, address: known.placeAddress };

    if (!this.openStreetMap.enabled) return { kind: TimeStopPlaceKind.UNKNOWN, name: null, address: null };
    const answer = await this.openStreetMap.placeAt(position);
    if (answer === undefined) return undefined;
    if (answer === null) return { kind: TimeStopPlaceKind.UNKNOWN, name: null, address: null };
    return { kind: TimeStopPlaceKind[answer.kind], name: answer.name, address: answer.address };
  }

  /** A square the database can search, a little larger than the circle wanted. */
  private boxAround<Latitude extends string, Longitude extends string>(
    position: { latitude: number; longitude: number },
    metres: number,
    latitude: Latitude,
    longitude: Longitude,
  ) {
    const dLatitude = metres * DEGREES_PER_METER;
    const dLongitude = dLatitude / Math.cos((position.latitude * Math.PI) / 180);
    return {
      [latitude]: { gte: position.latitude - dLatitude, lte: position.latitude + dLatitude },
      [longitude]: { gte: position.longitude - dLongitude, lte: position.longitude + dLongitude },
    } as Record<Latitude | Longitude, { gte: number; lte: number }>;
  }

  private nearest<Row>(
    rows: Row[],
    position: { latitude: number; longitude: number },
    withinMetres: number,
    where: (row: Row) => { latitude: number; longitude: number },
  ): Row | null {
    let best: { row: Row; metres: number } | null = null;
    for (const row of rows) {
      const at = where(row);
      if (!Number.isFinite(at.latitude) || !Number.isFinite(at.longitude)) continue;
      const metres = haversineMeters(position, at);
      if (metres <= withinMetres && (!best || metres < best.metres)) best = { row, metres };
    }
    return best?.row ?? null;
  }
}
