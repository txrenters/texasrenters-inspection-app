import { Logger } from '@nestjs/common';
import type { GeocodePrecision } from '@texasrenters/shared';

/**
 * Google's Geocoder, for the one thing the Census geocoder cannot do: roofs.
 *
 * The Census service interpolates along a street segment -- it divides a block
 * by its house-number range and picks a point -- so its answer is a place on
 * the road outside roughly the right property. Measured against Google on four
 * live addresses it was 18, 18, 61 and 75 metres out. On a suburban street 75
 * metres is several houses down, which is the difference between a technician
 * parking outside the inspection and parking outside a stranger's.
 *
 * Census stays as the fallback rather than being replaced. It needs no key and
 * costs nothing, so a missing key, an exhausted quota or a Google outage
 * degrades to a slightly worse coordinate instead of to no coordinate at all.
 *
 * Never throws. A geocoder being unavailable is not an incident -- the row
 * stays as it is and the next run picks it up.
 */

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_TIMEOUT_MS = 15_000;

export const GOOGLE_GEOCODE_SOURCE = 'GOOGLE';

export interface GoogleGeocodeAnswer {
  latitude: number;
  longitude: number;
  precision: GeocodePrecision;
  matchedAddress: string | null;
}

/**
 * Google's `location_type`, in the three levels this system already models.
 *
 * `GEOMETRIC_CENTER` is the centre of a street segment or polyline, which is
 * the same kind of claim the Census geocoder makes, so it maps to the same
 * value rather than inventing a fourth level. `APPROXIMATE` is a city or a
 * postcode -- deliberately mapped to `CENTROID`, which `TRUSTWORTHY_PRECISIONS`
 * already excludes from being drawn as "this is the property".
 */
export function precisionFromLocationType(locationType: unknown): GeocodePrecision {
  switch (locationType) {
    case 'ROOFTOP':
      return 'ROOFTOP';
    case 'RANGE_INTERPOLATED':
    case 'GEOMETRIC_CENTER':
      return 'INTERPOLATED';
    default:
      return 'CENTROID';
  }
}

/**
 * Reads a Google response without trusting any of it.
 *
 * Exported for its tests. Google answers `200 OK` with a `status` field for
 * every outcome including refusal, so an HTTP check alone would read
 * `REQUEST_DENIED` as a successful geocode of nothing.
 */
export function parseGoogleResponse(body: unknown): GoogleGeocodeAnswer | null {
  const payload = body as {
    status?: unknown;
    results?: { geometry?: { location?: { lat?: unknown; lng?: unknown }; location_type?: unknown };
      formatted_address?: unknown }[];
  } | null;

  if (payload?.status !== 'OK') return null;
  const first = payload.results?.[0];
  if (!first) return null;

  const latitude = Number(first.geometry?.location?.lat);
  const longitude = Number(first.geometry?.location?.lng);

  // The same shape checks the Census parser makes, for the same reason: a
  // coordinate that is not a coordinate must never reach a map.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  // 0,0 is in the Atlantic and is what a geocoder returns when it has nothing.
  if (latitude === 0 && longitude === 0) return null;

  return {
    latitude,
    longitude,
    precision: precisionFromLocationType(first.geometry?.location_type),
    matchedAddress:
      typeof first.formatted_address === 'string' ? first.formatted_address : null,
  };
}

export class GoogleGeocodingClient {
  private readonly logger = new Logger(GoogleGeocodingClient.name);

  constructor(private readonly apiKey: string | undefined) {}

  /** Whether there is a key to spend at all. */
  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async geocode(address: string): Promise<GoogleGeocodeAnswer | null> {
    if (!this.apiKey) return null;

    const url = new URL(ENDPOINT);
    url.searchParams.set('address', address);
    url.searchParams.set('key', this.apiKey);
    // US only. Every property in this system is a US address, and the bias
    // keeps a bare street name from matching a road of the same name abroad.
    url.searchParams.set('components', 'country:US');

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn({ event: 'google_geocode_http_error', status: response.status });
        return null;
      }

      const body = (await response.json()) as { status?: unknown; error_message?: unknown };
      /**
       * A refusal is logged loudly and a miss is not.
       *
       * `ZERO_RESULTS` is an ordinary answer about one address. `REQUEST_DENIED`
       * and `OVER_QUERY_LIMIT` are facts about the account, and they would
       * otherwise be indistinguishable from "no address matched" -- every row
       * would quietly fall back to Census for ever and the upgrade would look
       * like it had simply not worked.
       *
       * The URL is never logged: it carries the key.
       */
      if (body?.status !== 'OK' && body?.status !== 'ZERO_RESULTS')
        this.logger.error({
          event: 'google_geocode_refused',
          status: body?.status,
          message: typeof body?.error_message === 'string' ? body.error_message : undefined,
        });

      return parseGoogleResponse(body);
    } catch (error) {
      this.logger.warn({
        event: 'google_geocode_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
