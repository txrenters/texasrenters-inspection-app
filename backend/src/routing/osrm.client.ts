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

/**
 * How far from a coordinate OSRM may look for a road before giving up.
 *
 * **Without this OSRM never gives up at all**, and that is the whole reason it
 * is here. The extract is Texas only, but a coordinate outside Texas is not
 * rejected: OSRM snaps it to the nearest road in the graph however distant, and
 * returns `code: "Ok"` with a duration computed from that substituted point.
 *
 * Measured against our own container: `123.806345, 8.481640` (the Philippines)
 * came back snapped to `-93.390923, 31.050802` -- a road in east Texas, some
 * twelve thousand kilometres away -- and `/table` reported a four-hour drive to
 * Houston without a hint that anything was wrong. The map drew it. That is the
 * failure mode this constant exists to stop, and it is the dangerous kind:
 * confident, plausible, and entirely fabricated.
 *
 * Five kilometres is generous for a road network -- rural Texas addresses sit
 * well inside it -- while being far tighter than an ocean. Verified that a
 * Houston pair still routes normally under it.
 */
const SNAP_RADIUS_METERS = 5_000;

/** `radiuses` takes one value per coordinate, in the same order. */
function snapRadiuses(count: number): string {
  return Array.from({ length: count }, () => String(SNAP_RADIUS_METERS)).join(';');
}

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
        // The body is returned rather than swallowed. OSRM reports a refused
        // coordinate as a 400 carrying `code: "NoSegment"`, and that is a
        // different fact from the service being unreachable -- one means the
        // point is off the road network, the other means we know nothing at
        // all. Callers can only tell them apart if the body survives.
        //
        // Both parsers below already reject any body whose `code` is not
        // `Ok`, so handing them an error body changes nothing for them.
        const body: unknown = await response.json().catch(() => null);
        this.logger.warn({
          event: 'osrm_http_error',
          status: response.status,
          code: (body as { code?: unknown } | null)?.code ?? null,
        });
        return body;
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

  /**
   * Travel seconds between every pair, origin first. Null when unavailable.
   *
   * Null now also covers "one of these points is nowhere near a road", which
   * `radiuses` turns from a silently substituted answer into an HTTP 400. The
   * caller cannot tell which point from this alone -- `snappable` answers that,
   * and is only worth calling once this has already failed.
   */
  async durations(points: readonly GeoPoint[]): Promise<number[][] | null> {
    if (!this.configured || points.length < 2) return null;
    return parseTableResponse(
      await this.get(
        `/table/v1/driving/${toOsrmCoordinates(points)}?annotations=duration` +
          `&radiuses=${snapRadiuses(points.length)}`,
      ),
    );
  }

  /** The drive through `points` in the order given. Null when unavailable. */
  async route(points: readonly GeoPoint[]): Promise<OsrmRoute | null> {
    if (!this.configured || points.length < 2) return null;
    return parseRouteResponse(
      await this.get(
        `/route/v1/driving/${toOsrmCoordinates(points)}?overview=full&geometries=geojson` +
          `&radiuses=${snapRadiuses(points.length)}`,
      ),
    );
  }

  /**
   * Which of these points sit near a road we can actually route on.
   *
   * One `/nearest` call each, in parallel, under the same radius the matrix
   * uses. Asking per point rather than reading the `/table` error message: OSRM
   * names only the first coordinate it could not match, and it names it in
   * English prose, so a system depending on that string would break on an OSRM
   * upgrade and would still learn about one point at a time.
   *
   * Called only after `durations` has already returned null, so the ordinary
   * path costs one request and this costs nothing.
   *
   * **Null means "cannot tell", not "all bad".** If OSRM is unreachable every
   * point would otherwise look unroutable, and the console would blame the
   * technician's position for what is actually an outage. A single point that
   * fails to answer at all is enough to refuse the whole diagnosis.
   */
  async snappable(points: readonly GeoPoint[]): Promise<boolean[] | null> {
    if (!this.configured || !points.length) return null;

    const results = await Promise.all(
      points.map(async (point) => {
        const body = (await this.get(
          `/nearest/v1/driving/${toOsrmCoordinates([point])}` +
            `?number=1&radiuses=${SNAP_RADIUS_METERS}`,
        )) as { code?: unknown } | null;

        // No body at all is a dead service; a body saying anything other than
        // `Ok` -- in practice `NoSegment` -- is a point off the network.
        if (body === null || typeof body !== 'object') return null;
        return body.code === 'Ok';
      }),
    );

    return results.some((result) => result === null) ? null : (results as boolean[]);
  }
}
