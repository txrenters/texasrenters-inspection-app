import { Inject, Injectable, Logger } from '@nestjs/common';
import { TimeSegmentCategory, TimeStopPlaceKind } from '@prisma/client';
import { haversineMeters } from '@texasrenters/shared';

import { PrismaService } from '../common/prisma.service';
import { withSystemTenant } from '../database/tenant-context';
import { OpenStreetMapPlacesClient } from './openstreetmap-places.client';

/**
 * What a stop away from the properties was: "The Home Depot", "Home", a
 * property with no visit that day, or a street address -- and, for a business,
 * what kind of place it is: a hardware store, a convenience store, a gas
 * station (the office, 2026-11-04).
 *
 * Cheapest first, and our own data before anybody else's:
 *
 * 1. **Home**, where the technician said their day starts. Checked first so a
 *    stop there is never sent anywhere, and shown only as "Home" -- the office
 *    has no use for the address on a timesheet.
 * 2. **A property we manage** that had no visit that day: its address.
 * 3. **A stop already named** close by, so the same store visited every week
 *    is asked about once.
 * 4. **OpenStreetMap**, for everything else. Free, and capped per day anyway
 *    (`OpenStreetMapPlacesClient`).
 *
 * Run after each sweep, a few at a time, rather than while the day is read:
 * reading a day is the timesheet's arithmetic and must not wait on the
 * internet, and a month recalculated at once would otherwise ask hundreds of
 * questions in one request. The timesheet page itself never asks anybody
 * anything; it reads what this has written.
 *
 * **One failure ends the sweep's asking.** When OpenStreetMap cannot be asked
 * -- down, refusing, or today's ceiling reached -- the rest of the batch would
 * only fail the same way, so they wait for the next sweep. While it is down
 * that is at most two requests every five minutes, not twenty stops' worth.
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
  /**
   * OpenStreetMap's tag for a business, "shop=hardware". Null for anything
   * that is not a business, and for a business named before the kind was kept.
   */
  category: string | null;
}

/**
 * Written as a business's category once OpenStreetMap was asked and gave none,
 * so the stop is asked about once rather than on every sweep.
 */
export const NO_CATEGORY = '';

type Position = { latitude: number; longitude: number };

@Injectable()
export class StopNamingService {
  private readonly logger = new Logger(StopNamingService.name);

  /** Stops named per sweep. A sweep is five minutes; a day has a handful. */
  static readonly BATCH = 20;
  /**
   * Stops named before the kind of place was kept, given one per sweep after
   * the new ones. Only those still within the trail's thirty days have a
   * position to ask with, so this runs out by itself.
   */
  static readonly CATEGORY_BATCH = 5;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OpenStreetMapPlacesClient) private readonly openStreetMap: OpenStreetMapPlacesClient,
  ) {}

  /**
   * Name the stops still waiting for one, newest first, then give a kind of
   * place to businesses named before it was kept.
   *
   * Across organizations, so as the system; every lookup below is still
   * scoped to the stop's own organization. A stop whose lookup could not be
   * made is left for the next sweep, and so is every stop after it. Never
   * throws.
   */
  async nameWaiting(): Promise<{ named: number; waiting: number; categorized: number }> {
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
        let unreachable = false;
        for (const stop of waiting) {
          const position = { latitude: Number(stop.placeLatitude), longitude: Number(stop.placeLongitude) };
          const place = await this.placeFor(stop.organizationId, stop.technicianId, position);
          if (!place) {
            unreachable = true;
            break;
          }
          await this.prisma.timeSegment.updateMany({
            // Only if it still has no name: the same stop read twice must not
            // be looked up twice and written twice.
            where: { id: stop.id, organizationId: stop.organizationId, placeNamedAt: null },
            data: {
              placeKind: place.kind,
              placeName: place.name,
              placeAddress: place.address,
              placeCategory: place.category,
              placeNamedAt: new Date(),
            },
          });
          named += 1;
        }
        const categorized = unreachable ? 0 : await this.categorizeNamed();
        if (named || categorized)
          this.logger.log({ event: 'time_stops_named', named, categorized, waiting: waiting.length });
        return { named, waiting: waiting.length, categorized };
      });
    } catch (error) {
      this.logger.error({
        event: 'time_stop_naming_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return { named: 0, waiting: 0, categorized: 0 };
    }
  }

  /**
   * What one stop was. Undefined when it could not be found out yet -- the
   * lookup was unreachable -- so it is asked again rather than marked unknown.
   */
  async placeFor(organizationId: string, technicianId: string, position: Position): Promise<StopPlace | undefined> {
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
      return { kind: TimeStopPlaceKind.HOME, name: 'Home', address: null, category: null };

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
      return { kind: TimeStopPlaceKind.PROPERTY, name: property.addressLine1, address: null, category: null };

    // Home is somebody's own and a property is matched above, so only places
    // OpenStreetMap named are worth borrowing.
    const known = await this.knownNear(organizationId, position);
    // A business named before its kind was kept is still worth its name, but
    // not its missing kind: asked once more, it gets both.
    if (known?.placeKind && !(known.placeKind === TimeStopPlaceKind.BUSINESS && known.placeCategory === null))
      return {
        kind: known.placeKind,
        name: known.placeName,
        address: known.placeAddress,
        category: known.placeCategory,
      };

    if (!this.openStreetMap.enabled) return { kind: TimeStopPlaceKind.UNKNOWN, name: null, address: null, category: null };
    const answer = await this.openStreetMap.placeAt(position);
    if (answer === undefined) return undefined;
    if (answer === null) return { kind: TimeStopPlaceKind.UNKNOWN, name: null, address: null, category: null };
    return {
      kind: TimeStopPlaceKind[answer.kind],
      name: answer.name,
      address: answer.address,
      category: answer.kind === 'BUSINESS' ? (answer.category ?? NO_CATEGORY) : null,
    };
  }

  /**
   * The kind of place for businesses named before it was kept, a few a
   * sweep. Borrowed from a stop close by that has one; asked of OpenStreetMap
   * otherwise. The name stays as it was either way. Stops at the first lookup
   * that cannot be made.
   */
  private async categorizeNamed(): Promise<number> {
    if (!this.openStreetMap.enabled) return 0;
    const unsorted = await this.prisma.timeSegment.findMany({
      where: {
        category: TimeSegmentCategory.STOP,
        placeKind: TimeStopPlaceKind.BUSINESS,
        placeCategory: null,
        placeLatitude: { not: null },
        placeLongitude: { not: null },
      },
      select: { id: true, organizationId: true, placeLatitude: true, placeLongitude: true },
      orderBy: { startedAt: 'desc' },
      take: StopNamingService.CATEGORY_BATCH,
    });

    let categorized = 0;
    for (const stop of unsorted) {
      const position = { latitude: Number(stop.placeLatitude), longitude: Number(stop.placeLongitude) };
      const known = await this.knownNear(stop.organizationId, position, { categorized: true });
      let category = known?.placeCategory ?? null;
      if (category === null) {
        const answer = await this.openStreetMap.businessAt(position);
        if (answer === undefined) break;
        category = answer?.category ?? NO_CATEGORY;
      }
      await this.prisma.timeSegment.updateMany({
        where: { id: stop.id, organizationId: stop.organizationId, placeCategory: null },
        data: { placeCategory: category },
      });
      categorized += 1;
    }
    return categorized;
  }

  /** The nearest stop already named by OpenStreetMap, in the same organization. */
  private async knownNear(organizationId: string, position: Position, options: { categorized?: boolean } = {}) {
    return this.nearest(
      await this.prisma.timeSegment.findMany({
        where: {
          organizationId,
          category: TimeSegmentCategory.STOP,
          placeKind: options.categorized
            ? TimeStopPlaceKind.BUSINESS
            : { in: [TimeStopPlaceKind.BUSINESS, TimeStopPlaceKind.ADDRESS] },
          ...(options.categorized ? { placeCategory: { not: null } } : {}),
          ...this.boxAround(position, SAME_PLACE_WITHIN_METERS, 'placeLatitude', 'placeLongitude'),
        },
        select: {
          placeKind: true,
          placeName: true,
          placeAddress: true,
          placeCategory: true,
          placeLatitude: true,
          placeLongitude: true,
        },
        orderBy: { placeNamedAt: 'desc' },
        take: 20,
      }),
      position,
      SAME_PLACE_WITHIN_METERS,
      (row) => ({ latitude: Number(row.placeLatitude), longitude: Number(row.placeLongitude) }),
    );
  }

  /** A square the database can search, a little larger than the circle wanted. */
  private boxAround<Latitude extends string, Longitude extends string>(
    position: Position,
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
    position: Position,
    withinMetres: number,
    where: (row: Row) => Position,
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
