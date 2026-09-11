import { Injectable, Logger } from '@nestjs/common';

import type { GeoPoint } from './osrm.client';

/**
 * Google's Routes API, for the one thing OSRM cannot do: traffic.
 *
 * OSRM stays the default. It is self-hosted, keyless, costs nothing per request
 * and never sends a tenant's address to a third party — and for *ordering* a
 * day's stops, free-flow times are almost always the same answer as
 * traffic-aware ones, because the ordering depends on which stop is nearer, not
 * on how long the drive takes.
 *
 * This exists because a *forecast* is a different claim from an ordering. Once
 * a plan tells somebody a day will take five hours, free-flow is no longer good
 * enough: in Houston at 5pm it is optimistic in a way that is structurally
 * biased rather than randomly wrong, and the person who discovers that is a
 * technician running late.
 *
 * Never throws. Routing being unavailable is not an incident — the plan is
 * still produced, and the forecast says it is unavailable rather than inventing
 * a number.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * One server key, unless somebody splits them later.
 *
 * `GOOGLE_SERVER_API_KEY` is the key restricted to this host's IP addresses,
 * with Geocoding and Routes enabled on it. The older `GOOGLE_ROUTES_API_KEY`
 * still wins where it is set, so splitting the two is a deployment change
 * rather than a code one.
 *
 * Never the browser key. A key carries exactly one application restriction:
 * the browser key is restricted by HTTP referrer, and a server sends none, so
 * Google refuses it outright for these APIs.
 */
function apiKey(): string {
  return process.env.GOOGLE_ROUTES_API_KEY ?? process.env.GOOGLE_SERVER_API_KEY ?? '';
}

/**
 * The line on the map, plus a duration per leg.
 *
 * `legs.duration` rather than `staticDuration`: the first accounts for traffic
 * at the departure time and the second does not, and the difference is the
 * entire reason to be calling Google rather than a free-flow router.
 */
const ROUTE_FIELD_MASK =
  'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,' +
  'routes.legs.duration,routes.legs.distanceMeters';

/**
 * Google bills per element, and an element is one origin-destination pair.
 *
 * A technician-day of ten stops plus an origin is 121 elements. A quarter of
 * roughly a hundred and twenty technician-days is some fifteen thousand — real
 * money, but bounded. Building one matrix over all four hundred stops instead
 * would be a hundred and sixty thousand elements *per solve*, and the planner
 * solves more than once. That gap is the entire reason the assignment phase
 * works in straight-line distance and only the per-day sequencing comes here.
 *
 * The cap is a guard against a caller that has forgotten this: it refuses
 * rather than quietly spending.
 */
export const MAX_MATRIX_ELEMENTS = 625;

/**
 * The fields to ask for, and no more.
 *
 * Routes API requires an explicit field mask and bills a higher tier for some
 * fields, so this is a cost decision as well as a payload one. `condition` is
 * included because a route Google could not compute comes back as a row with no
 * duration rather than as an error.
 */
const MATRIX_FIELD_MASK = 'originIndex,destinationIndex,duration,distanceMeters,condition';

export interface RouteMatrix {
  /** `[origin][destination]` seconds. Unreachable pairs are `Infinity`. */
  durations: number[][];
  /** `[origin][destination]` metres. Unreachable pairs are `Infinity`. */
  distances: number[][];
}

/**
 * Reads a computeRouteMatrix response without trusting it. Exported for tests.
 *
 * The response is a flat list of `{originIndex, destinationIndex, ...}` in no
 * guaranteed order, so this fills a matrix by index rather than by position —
 * reading it positionally is the kind of mistake that produces a plausible
 * route to the wrong houses.
 */
export function parseRouteMatrix(body: unknown, size: number): RouteMatrix | null {
  if (!Array.isArray(body) || size <= 0) return null;

  const durations = squareOf(size);
  const distances = squareOf(size);

  for (const entry of body as Record<string, unknown>[]) {
    const origin = entry?.originIndex;
    const destination = entry?.destinationIndex;
    if (typeof origin !== 'number' || typeof destination !== 'number') continue;
    if (origin < 0 || origin >= size || destination < 0 || destination >= size) continue;
    // Anything but ROUTE_EXISTS means Google could not connect the pair. Left
    // as Infinity so a solver treats it as unreachable rather than free.
    if (entry.condition !== 'ROUTE_EXISTS') continue;

    const seconds = parseDuration(entry.duration);
    if (seconds === null) continue;
    durations[origin][destination] = seconds;
    distances[origin][destination] =
      typeof entry.distanceMeters === 'number' ? entry.distanceMeters : Number.POSITIVE_INFINITY;
  }

  // A response that filled nothing is not a matrix of unreachable pairs, it is
  // a response we failed to understand. Saying so lets the caller fall back.
  const filled = durations.some((row) => row.some((value) => Number.isFinite(value)));
  return filled ? { durations, distances } : null;
}

/**
 * `"123s"` — Routes API returns a protobuf Duration, not a number.
 *
 * Fractional seconds are legal in that format (`"1.5s"`), so this parses as a
 * float; truncating would quietly lose a little on every leg of every route.
 */
export function parseDuration(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.endsWith('s')) return null;
  const seconds = Number.parseFloat(value.slice(0, -1));
  return Number.isFinite(seconds) ? seconds : null;
}

function squareOf(size: number): number[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => Number.POSITIVE_INFINITY),
  );
}

function waypoint(point: GeoPoint) {
  return {
    waypoint: {
      location: {
        // latLng, spelled out. Google takes an object here rather than the
        // `lon,lat` string OSRM wants, which removes the axis trap — but only
        // if nobody "helpfully" swaps them to match the other client.
        latLng: { latitude: point.latitude, longitude: point.longitude },
      },
    },
  };
}

/**
 * Google's encoded polyline, as `[longitude, latitude]` pairs.
 *
 * **The order is deliberate and it is not Google's.** The algorithm yields
 * latitude first; OSRM returns GeoJSON, which is `[lon, lat]`; and
 * `RouteService` hands whichever it got to one `toLatLngPath`. Emitting
 * Google's native order here would put every route in the Indian Ocean while
 * both clients looked individually correct -- the same axis trap the Census
 * geocoder set, where `x` is the longitude.
 *
 * The format itself: base64-ish chunks of five bits, each value a delta from
 * the previous point, zig-zag encoded so negatives survive.
 */
export function decodePolyline(encoded: unknown): [number, number][] {
  if (typeof encoded !== 'string' || !encoded) return [];

  const path: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    // Longitude first. See above.
    path.push([lng / 1e5, lat / 1e5]);
  }
  return path;
}

/**
 * Reads a computeRoutes response without trusting it. Exported for tests.
 *
 * An empty `routes` array is Google saying it could not connect the points,
 * which is a fact the caller must be able to act on -- not an error and not a
 * zero-length route.
 */
export function parseComputedRoute(body: unknown): GoogleRoute | null {
  const route = (body as { routes?: unknown[] } | null)?.routes?.[0] as
    | {
        duration?: unknown;
        distanceMeters?: unknown;
        polyline?: { encodedPolyline?: unknown };
        legs?: { duration?: unknown; distanceMeters?: unknown }[];
      }
    | undefined;
  if (!route) return null;

  const durationSeconds = parseDuration(route.duration);
  if (durationSeconds === null) return null;

  return {
    durationSeconds,
    distanceMeters: typeof route.distanceMeters === 'number' ? route.distanceMeters : 0,
    legs: (route.legs ?? []).map((leg) => ({
      durationSeconds: parseDuration(leg?.duration) ?? 0,
      distanceMeters: typeof leg?.distanceMeters === 'number' ? leg.distanceMeters : 0,
    })),
    geometry: decodePolyline(route.polyline?.encodedPolyline),
  };
}

export interface GoogleRoute {
  distanceMeters: number;
  durationSeconds: number;
  legs: { distanceMeters: number; durationSeconds: number }[];
  /** GeoJSON order, `[lon, lat]`, matching what OSRM returns. */
  geometry: [number, number][];
}

@Injectable()
export class GoogleRoutesClient {
  private readonly logger = new Logger(GoogleRoutesClient.name);

  /**
   * Absent configuration means traffic-aware routing is unavailable, which the
   * caller reports rather than papering over. Server-side key only: this must
   * never be the browser key, which is referrer-restricted and would be refused
   * here anyway.
   */
  get configured() {
    return Boolean(apiKey());
  }

  /**
   * Traffic-aware seconds and metres between every pair of points.
   *
   * `departureTime` is the day being planned, at a nominal start of the working
   * day, because a quarter is planned months ahead and Google's traffic model
   * needs to know *when*. Asking about a Tuesday morning and driving on a
   * Friday evening is a different road.
   */
  async matrix(points: readonly GeoPoint[], departureTime: Date): Promise<RouteMatrix | null> {
    if (!this.configured || points.length < 2) return null;

    const elements = points.length * points.length;
    if (elements > MAX_MATRIX_ELEMENTS) {
      this.logger.warn({
        event: 'google_routes_matrix_refused',
        elements,
        limit: MAX_MATRIX_ELEMENTS,
        reason: 'A matrix this size is billed per element; the caller should be batching by day.',
      });
      return null;
    }

    // Google refuses a departureTime in the past. A plan regenerated after the
    // quarter has started would otherwise fail every remaining day at once.
    const departure = departureTime.getTime() > Date.now() ? departureTime : new Date(Date.now() + 60_000);

    const body = await this.post(MATRIX_URL, MATRIX_FIELD_MASK, {
      origins: points.map(waypoint),
      destinations: points.map(waypoint),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: departure.toISOString(),
    });
    return body === null ? null : parseRouteMatrix(body, points.length);
  }

  /**
   * The drive through these points in the order given, with traffic.
   *
   * Ordering is the caller's job and happens against the matrix first; this
   * only draws and times the order it is handed. Intermediates are **not**
   * optimised by Google here for that reason -- asking it to reorder would
   * silently discard a sequence the service chose from the technician's
   * current position.
   *
   * `TRAFFIC_AWARE` rather than `TRAFFIC_AWARE_OPTIMAL`: the first is the
   * cheaper tier and accurate enough for a day's plan, and the second is billed
   * higher for a difference measured in a minute or two.
   */
  async route(points: readonly GeoPoint[], departureTime?: Date): Promise<GoogleRoute | null> {
    if (!this.configured || points.length < 2) return null;

    // Google refuses a departure in the past, and "now" is what a live route
    // wants anyway -- this is the drive the technician is about to make.
    const departure =
      departureTime && departureTime.getTime() > Date.now()
        ? departureTime
        : new Date(Date.now() + 60_000);

    const body = await this.post(ROUTES_URL, ROUTE_FIELD_MASK, {
      origin: waypoint(points[0]).waypoint,
      destination: waypoint(points[points.length - 1]).waypoint,
      intermediates: points.slice(1, -1).map((point) => waypoint(point).waypoint),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      polylineEncoding: 'ENCODED_POLYLINE',
      departureTime: departure.toISOString(),
    });
    return body === null ? null : parseComputedRoute(body);
  }

  private async post(
    url: string,
    fieldMask: string,
    payload: unknown,
  ): Promise<unknown | null> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // Header, never a query parameter. A key in a URL lands in access
          // logs, proxy logs and error reports.
          'X-Goog-Api-Key': apiKey(),
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        this.logger.warn({
          event: 'google_routes_http_error',
          status: response.status,
          // The message only. Google echoes the request on some errors, and the
          // request is a list of the addresses we are about to inspect.
          message:
            (detail as { error?: { message?: unknown } } | null)?.error?.message ?? null,
        });
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn({
        event: 'google_routes_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
