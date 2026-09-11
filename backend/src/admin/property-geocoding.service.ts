import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type GeocodePrecision,
  geocodableAddress,
  needsGeocoding,
  type PropertyPosition,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant } from '../database/tenant-context';
import { GOOGLE_GEOCODE_SOURCE, GoogleGeocodingClient } from './google-geocoding.client';

/**
 * Turns property addresses into points on a map.
 *
 * The US Census Bureau's geocoder rather than Google or Mapbox, for one
 * decisive reason: it needs no API key, so there is no provider secret to keep
 * out of the client, no billing relationship, and nothing to rotate. Every
 * property in this system is a US address, which is the only thing it handles.
 *
 * It is a street-segment geocoder — it interpolates along a road rather than
 * pointing at a roof — so its answers are recorded as `INTERPOLATED` and never
 * as `ROOFTOP`. That distinction is the whole reason precision is stored: it
 * would be easy, and wrong, to draw an interpolated point as though somebody
 * had surveyed the driveway.
 */
const CENSUS_ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

/** The Census benchmark that tracks current data rather than a frozen vintage. */
const BENCHMARK = 'Public_AR_Current';

export const GEOCODE_SOURCE = 'CENSUS';

/**
 * A free public service gets a strict timeout and a pause between calls.
 *
 * This is not rate limiting in the defensive sense — it is being a good guest
 * on infrastructure nobody is paying for. The backfill is not urgent; nothing
 * in the product is waiting on it.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const PAUSE_BETWEEN_REQUESTS_MS = 250;

interface CensusMatch {
  coordinates?: { x?: unknown; y?: unknown };
  matchedAddress?: unknown;
}

export interface GeocodeAnswer {
  latitude: number;
  longitude: number;
  precision: GeocodePrecision;
  matchedAddress: string | null;
  /**
   * Which geocoder answered.
   *
   * Stored rather than assumed, because it is the only way to tell a row that
   * has already been offered a rooftop lookup from one that has not -- which
   * is what stops the backfill re-asking Google about the same addresses for
   * ever.
   */
  source: string;
}

/**
 * Reads a Census response without trusting any of it.
 *
 * Exported for its tests. The trap this exists to prevent is the axis swap:
 * Census names its fields `x` and `y`, and `x` is the **longitude**. Reading
 * them positionally puts every Texas property in the Indian Ocean, and the
 * mistake is invisible until somebody looks at a map.
 */
export function parseCensusResponse(body: unknown): GeocodeAnswer | null {
  const matches = (body as { result?: { addressMatches?: unknown } } | null)?.result?.addressMatches;
  if (!Array.isArray(matches) || !matches.length) return null;

  const match = matches[0] as CensusMatch;
  const longitude = Number(match?.coordinates?.x);
  const latitude = Number(match?.coordinates?.y);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  // 0,0 is in the Atlantic and is what a geocoder returns when it has nothing.
  // No US address is within a thousand miles of it.
  if (latitude === 0 && longitude === 0) return null;

  return {
    latitude,
    longitude,
    precision: 'INTERPOLATED',
    matchedAddress: typeof match.matchedAddress === 'string' ? match.matchedAddress : null,
    source: GEOCODE_SOURCE,
  };
}

@Injectable()
export class PropertyGeocodingService {
  private readonly logger = new Logger(PropertyGeocodingService.name);

  /**
   * Read from the environment rather than injected, so that every existing
   * caller and test that constructs this with a Prisma double keeps working.
   * Without a key it reports `configured: false` and this class behaves
   * exactly as it did before.
   */
  private readonly google = new GoogleGeocodingClient(process.env.GOOGLE_SERVER_API_KEY);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * One address, one lookup. Returns null when nothing can place it.
   *
   * Google first, Census second. Not because Census is unreliable -- it places
   * these addresses perfectly well -- but because it interpolates along the
   * street, and measured against Google on four live properties it was 18, 18,
   * 61 and 75 metres from the roof. Seventy-five metres is several houses.
   *
   * The fallback is the point of keeping both. A missing key, an exhausted
   * quota or a Google outage degrades to a slightly worse coordinate rather
   * than to none, and no property stops appearing on the map because of a
   * billing problem.
   */
  async geocodeAddress(address: string): Promise<GeocodeAnswer | null> {
    if (this.google.configured) {
      const answer = await this.google.geocode(address);
      if (answer) return { ...answer, source: GOOGLE_GEOCODE_SOURCE };
    }
    return this.geocodeWithCensus(address);
  }

  /** The keyless fallback, and the only geocoder this used to have. */
  private async geocodeWithCensus(address: string): Promise<GeocodeAnswer | null> {
    const url = new URL(CENSUS_ENDPOINT);
    url.searchParams.set('address', address);
    url.searchParams.set('benchmark', BENCHMARK);
    url.searchParams.set('format', 'json');

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn({ event: 'geocode_http_error', status: response.status });
        return null;
      }
      return parseCensusResponse(await response.json());
    } catch (error) {
      // A geocoder being down is not an incident. The rows stay null and the
      // next run picks them up, which is why nothing here rethrows.
      this.logger.warn({
        event: 'geocode_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Looks up properties that have no coordinate, or whose address has changed
   * since the one they do have was derived from.
   *
   * Crosses organizations deliberately — this is maintenance, not work on
   * anybody's behalf — so it is wrapped in `withSystemTenant`. Without that the
   * row-level policies match nothing and it reports "nothing to do" for ever
   * while the map stays empty, which is the failure that would be hardest to
   * notice.
   */
  async geocodePending(limit: number) {
    return withSystemTenant(async () => {
      const candidates = await this.prisma.property.findMany({
        // A `geocodedFor` mismatch cannot be expressed against another column
        // in Prisma, so rows that already have a coordinate are re-checked in
        // memory by `needsGeocoding` below. The partial index covers the null
        // case, which is the one that matters at any size.
        where: { OR: [{ latitude: null }, { longitude: null }, { geocodedFor: null }] },
        select: {
          id: true,
          addressLine1: true,
          city: true,
          state: true,
          postalCode: true,
          latitude: true,
          longitude: true,
          geocodedFor: true,
        },
        take: limit,
      });

      const pending = candidates.filter((property) =>
        needsGeocoding({
          ...property,
          latitude: property.latitude?.toNumber() ?? null,
          longitude: property.longitude?.toNumber() ?? null,
        }),
      );
      if (!pending.length) return { examined: candidates.length, geocoded: 0, failed: 0 };

      let geocoded = 0;
      let failed = 0;

      for (const [index, property] of pending.entries()) {
        if (index > 0)
          await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_REQUESTS_MS));

        const address = geocodableAddress(property);
        const answer = await this.geocodeAddress(address);
        if (!answer) {
          failed += 1;
          continue;
        }

        await this.prisma.property.update({
          where: { id: property.id },
          data: {
            latitude: answer.latitude,
            longitude: answer.longitude,
            // The address we *sent*, not the one Census echoed back. This is
            // what makes a later edit detectable; storing the normalised match
            // would make every row look permanently stale.
            geocodedFor: address,
            geocodedAt: new Date(),
            geocodeSource: answer.source,
            geocodePrecision: answer.precision,
          },
        });
        geocoded += 1;
      }

      this.logger.log({ event: 'properties_geocoded', geocoded, failed });
      return { examined: candidates.length, geocoded, failed };
    });
  }

  /**
   * Every property the console can see that has been placed on a map.
   *
   * Reads `propertywareBuilding`, the same table `AdminService.properties()`
   * lists. It previously read `Property`, which is a different and much
   * smaller set — the rows the inspection workflow happens to have created —
   * so the map showed nine while the page beside it showed five hundred and
   * seventy and neither mentioned the other.
   *
   * `isActive` is what makes removal work. The Propertyware sync deactivates a
   * building that has gone, and it leaves the map on the next read with no
   * deletion path of its own to maintain.
   *
   * Rows without a coordinate are absent rather than sent with nulls: a map has
   * nothing to do with a property it cannot place.
   */
  async positions(user: AuthenticatedUser): Promise<PropertyPosition[]> {
    const rows = await this.prisma.propertywareBuilding.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        latitude: { not: null },
        longitude: { not: null },
      },
      select: {
        id: true,
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
        latitude: true,
        longitude: true,
        geocodePrecision: true,
      },
      orderBy: { name: 'asc' },
    });

    // Numbers, not Prisma `Decimal`s: a Decimal serialises to a *string*
    // through JSON, and a map given "-95.4012" plots nothing at all.
    //
    // The address parts are nullable on a synced record and not on the
    // contract, so they fall back to empty rather than being dropped — a pin
    // with a thin popup is still a property somebody can find.
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      addressLine1: row.addressLine1 ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      postalCode: row.postalCode ?? '',
      latitude: row.latitude?.toNumber() ?? 0,
      longitude: row.longitude?.toNumber() ?? 0,
      geocodePrecision: (row.geocodePrecision as GeocodePrecision | null) ?? null,
    }));
  }

  /**
   * Look up buildings that have never been placed, or whose address changed.
   *
   * The map's source, so this is the one that matters for coverage. Same rules
   * and the same `withSystemTenant` as the property pass below: maintenance
   * crosses organizations, and without the system tenant the row-level
   * policies match nothing and it reports "nothing to do" for ever.
   */
  async geocodePendingBuildings(limit: number, options: { upgradeCensus?: boolean } = {}) {
    /**
     * `upgradeCensus` re-asks about rows that already have a coordinate.
     *
     * Off by default and never set by the scheduler, deliberately. A row that
     * Google declines to place falls back to Census and keeps its CENSUS
     * source, so it would match again on the next pass -- harmless when a
     * person runs a bounded backfill, an endless loop if a cron does it.
     *
     * Pointless without a key, so it is ignored when there is none rather than
     * re-geocoding six hundred addresses with the geocoder that already
     * answered them.
     */
    const upgrading = Boolean(options.upgradeCensus) && this.google.configured;

    return withSystemTenant(async () => {
      const candidates = await this.prisma.propertywareBuilding.findMany({
        where: {
          isActive: true,
          addressLine1: { not: null },
          OR: [
            { latitude: null },
            { longitude: null },
            { geocodedFor: null },
            ...(upgrading ? [{ geocodeSource: GEOCODE_SOURCE }] : []),
          ],
        },
        select: {
          id: true,
          addressLine1: true,
          city: true,
          state: true,
          postalCode: true,
          latitude: true,
          longitude: true,
          geocodedFor: true,
          geocodeSource: true,
        },
        take: limit,
      });

      const pending = candidates.filter(
        (building) =>
          // An upgrade candidate has a perfectly good coordinate, so
          // `needsGeocoding` says no about it -- correctly, for the question it
          // is answering. This is a different question: not "is this placed"
          // but "is this placed as well as it could be".
          (upgrading && building.geocodeSource === GEOCODE_SOURCE) ||
          needsGeocoding({
            addressLine1: building.addressLine1 ?? '',
            city: building.city ?? '',
            state: building.state ?? '',
            postalCode: building.postalCode ?? '',
            latitude: building.latitude?.toNumber() ?? null,
            longitude: building.longitude?.toNumber() ?? null,
          geocodedFor: building.geocodedFor,
        }),
      );
      if (!pending.length) return { examined: candidates.length, geocoded: 0, failed: 0 };

      let geocoded = 0;
      let failed = 0;

      for (const [index, building] of pending.entries()) {
        if (index > 0)
          await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_REQUESTS_MS));

        const address = geocodableAddress({
          addressLine1: building.addressLine1 ?? '',
          city: building.city ?? '',
          state: building.state ?? '',
          postalCode: building.postalCode ?? '',
        });
        const answer = await this.geocodeAddress(address);
        if (!answer) {
          failed += 1;
          continue;
        }

        await this.prisma.propertywareBuilding.update({
          where: { id: building.id },
          data: {
            latitude: answer.latitude,
            longitude: answer.longitude,
            geocodedFor: address,
            geocodedAt: new Date(),
            geocodeSource: answer.source,
            geocodePrecision: answer.precision,
          },
        });
        geocoded += 1;
      }

      this.logger.log({ event: 'buildings_geocoded', geocoded, failed });
      return { examined: candidates.length, geocoded, failed };
    });
  }
}
