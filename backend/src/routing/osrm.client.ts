import { Injectable, Logger } from '@nestjs/common';

/**
 * A thin client for a self-hosted OSRM.
 *
 * Self-hosted rather than a routing API: no key to keep out of the client, no
 * per-request cost, no terms-of-service ceiling, and property coordinates never
 * leave our network. The trade is that OSRM has **no traffic data** — every
 * duration it returns is free-flow, the road network at its speed limits — so
 * callers must present these as estimates and never as arrival times.
 */

/** A point as the rest of this system writes one. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * OSRM wants `longitude,latitude`.
 *
 * **This is backwards from every other coordinate in this codebase** and is the
 * single easiest way to break routing invisibly: swapped, a Houston address
 * becomes a point in Antarctica, OSRM cheerfully reports no route, and the
 * feature looks merely broken rather than wrong. The Census geocoder has the
 * same trap in the opposite direction (`x` is longitude), so this file and that
 * one are the two places the axis order has to be right.
 *
 * Exported so a test can hold it to that.
 */
export function toOsrmCoordinates(points: readonly GeoPoint[]): string {
  return points.map((point) => `${point.longitude},${point.latitude}`).join(';');
}

export interface RouteLegSummary {
  distanceMeters: number;
  durationSeconds: number;
}

export interface OsrmRoute {
  distanceMeters: number;
  durationSeconds: number;
  legs: RouteLegSummary[];
  /** GeoJSON `[lon, lat]` pairs, as OSRM returns them. */
  geometry: [number, number][];
}

/** Reads a `/table` response without trusting it. Exported for its tests. */
export function parseTableResponse(body: unknown): number[][] | null {
  const payload = body as { code?: unknown; durations?: unknown } | null;
  if (payload?.code !== 'Ok' || !Array.isArray(payload.durations)) return null;

  const durations = payload.durations as unknown[];
  const matrix: number[][] = [];
  for (const row of durations) {
    if (!Array.isArray(row)) return null;
    // OSRM returns null for a pair it cannot connect — an island, a gated
    // estate, a coordinate off the network. Infinity keeps it comparable while
    // making it never chosen, which is exactly what "unreachable" should mean
    // to a solver. A zero here would make it look like the best stop of all.
    matrix.push(row.map((value) => (typeof value === 'number' ? value : Number.POSITIVE_INFINITY)));
  }
  return matrix.length ? matrix : null;
}

/** Reads a `/route` response without trusting it. Exported for its tests. */
export function parseRouteResponse(body: unknown): OsrmRoute | null {
  const payload = body as { code?: unknown; routes?: unknown } | null;
  if (payload?.code !== 'Ok' || !Array.isArray(payload.routes) || !payload.routes.length)
    return null;

  const route = payload.routes[0] as {
    distance?: unknown;
    duration?: unknown;
    legs?: unknown;
    geometry?: { coordinates?: unknown };
  };
  if (typeof route.distance !== 'number' || typeof route.duration !== 'number') return null;

  const legs = Array.isArray(route.legs)
    ? (route.legs as { distance?: unknown; duration?: unknown }[]).map((leg) => ({
        distanceMeters: typeof leg.distance === 'number' ? leg.distance : 0,
        durationSeconds: typeof leg.duration === 'number' ? leg.duration : 0,
      }))
    : [];

  const coordinates = Array.isArray(route.geometry?.coordinates)
    ? (route.geometry.coordinates as unknown[]).filter(
        (pair): pair is [number, number] =>
          Array.isArray(pair) && pair.length >= 2 && pair.every((value) => Number.isFinite(value)),
      )
    : [];

  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    legs,
    geometry: coordinates,
  };
}

/** A free public service gets a strict timeout; so does one of our own. */
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class OsrmClient {
  private readonly logger = new Logger(OsrmClient.name);

  /**
   * Absent configuration means routing is unavailable, and the caller says so.
   * A default pointing at a service that may not be running would turn a
   * missing feature into a timeout on every request.
   */
  get configured() {
    return Boolean(process.env.OSRM_URL);
  }

  private baseUrl() {
    return (process.env.OSRM_URL ?? '').replace(/\/$/, '');
  }

  private async get(path: string): Promise<unknown | null> {
    try {
      const response = await fetch(`${this.baseUrl()}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn({ event: 'osrm_http_error', status: response.status });
        return null;
      }
      return await response.json();
    } catch (error) {
      // Routing being down is not an incident: the day's stops are still known,
      // they simply arrive unordered. Nothing here rethrows.
      this.logger.warn({
        event: 'osrm_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Travel seconds between every pair, origin first. Null when unavailable. */
  async durations(points: readonly GeoPoint[]): Promise<number[][] | null> {
    if (!this.configured || points.length < 2) return null;
    return parseTableResponse(
      await this.get(`/table/v1/driving/${toOsrmCoordinates(points)}?annotations=duration`),
    );
  }

  /** The drive through `points` in the order given. Null when unavailable. */
  async route(points: readonly GeoPoint[]): Promise<OsrmRoute | null> {
    if (!this.configured || points.length < 2) return null;
    return parseRouteResponse(
      await this.get(
        `/route/v1/driving/${toOsrmCoordinates(points)}?overview=full&geometries=geojson`,
      ),
    );
  }
}
