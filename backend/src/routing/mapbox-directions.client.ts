import { Injectable, Logger } from '@nestjs/common';

import type { GeoPoint, OsrmRoute } from './osrm.client';
import { parseRouteResponse, toOsrmCoordinates } from './osrm.client';

/**
 * Road routes from Mapbox, which is what the console's maps already draw on.
 *
 * Added because the office was reading a quarter against straight dashed lines
 * between its stops. The day map draws whatever geometry the planner hands it,
 * the planner asked Google, and that account's billing had lapsed — so every
 * day came back undrawn, with "No drive times could be measured for this day"
 * printed above a map of chords across Houston.
 *
 * **The response parser is OSRM's, deliberately.** Mapbox Directions *is* OSRM
 * behind a hosted API: same `code: "Ok"`, same `routes[0].distance`,
 * `.duration`, `.legs[]` and `.geometry.coordinates`. Reusing
 * `parseRouteResponse` means there is one place that decides what a trustworthy
 * route response looks like, rather than two that can drift.
 *
 * `mapbox/driving`, not `driving-traffic`. The office asked for times worked
 * out from the road rather than from whatever the traffic happens to be at the
 * moment a quarter is built — a plan for November should not be shaped by a
 * Tuesday afternoon on I-45. Free-flow is also stable: rebuilding the same
 * quarter twice gives the same answer.
 */

/** A point as the rest of this system writes one. */
export type { GeoPoint } from './osrm.client';

/**
 * Mapbox takes at most 25 coordinates in one request.
 *
 * A technician day is nine or ten stops and comfortably inside that, but a
 * technician's live route can be longer, and a limit that is usually not
 * reached is the kind that fails in production rather than in review.
 */
export const MAX_COORDINATES = 25;

/** A hosted API gets a strict timeout; a plan redraw must not hang on it. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Split a run of points into requests, each overlapping the last by one.
 *
 * The overlap is the join: a leg has to start where the previous one ended, so
 * chunk two begins at the point chunk one finished on. Without it the drive
 * between the 25th and 26th stop is simply missing, and the line jumps.
 *
 * Exported for its tests, because getting this wrong loses exactly one leg per
 * boundary and looks like rounding.
 */
export function chunkForRequests(count: number, max = MAX_COORDINATES): [number, number][] {
  if (count <= max) return count >= 2 ? [[0, count]] : [];
  const chunks: [number, number][] = [];
  let start = 0;
  while (start < count - 1) {
    const end = Math.min(start + max, count);
    chunks.push([start, end]);
    start = end - 1;
  }
  return chunks;
}

/**
 * Travel seconds and metres between every pair, as the planner needs them.
 *
 * Exported for its tests. Mapbox returns `null` for a pair it cannot connect --
 * an island, a gated estate, a coordinate off the network -- and that becomes
 * `Infinity` here for the same reason OSRM's does: it keeps the value
 * comparable while making it never chosen, which is what "unreachable" should
 * mean to a solver. A zero would make it look like the best stop of all.
 */
export function parseMatrixResponse(
  body: unknown,
): { durations: number[][]; distances: number[][] } | null {
  const payload = body as { code?: unknown; durations?: unknown; distances?: unknown } | null;
  if (payload?.code !== 'Ok' || !Array.isArray(payload.durations)) return null;

  const grid = (rows: unknown): number[][] | null => {
    if (!Array.isArray(rows)) return null;
    const out: number[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) return null;
      out.push(
        (row as unknown[]).map((value) =>
          typeof value === 'number' ? value : Number.POSITIVE_INFINITY,
        ),
      );
    }
    return out.length ? out : null;
  };

  const durations = grid(payload.durations);
  if (!durations) return null;
  /**
   * Distances are asked for but not depended on. The planner uses them to
   * report how far a day drives; a matrix without them is still a matrix it
   * can order a day with, and refusing the whole answer over the softer half
   * would be trading a measured day for an estimated one.
   */
  const distances = grid(payload.distances) ?? durations.map((row) => row.map(() => 0));
  return { durations, distances };
}

/** Join consecutive routes into one, without repeating the shared point. */
export function stitch(parts: readonly OsrmRoute[]): OsrmRoute | null {
  if (!parts.length) return null;
  const geometry: [number, number][] = [];
  const legs = [];
  let distanceMeters = 0;
  let durationSeconds = 0;
  for (const [index, part] of parts.entries()) {
    distanceMeters += part.distanceMeters;
    durationSeconds += part.durationSeconds;
    legs.push(...part.legs);
    // The first coordinate of every part after the first is the last
    // coordinate of the one before it.
    geometry.push(...(index === 0 ? part.geometry : part.geometry.slice(1)));
  }
  return { distanceMeters, durationSeconds, legs, geometry };
}

@Injectable()
export class MapboxDirectionsClient {
  private readonly logger = new Logger(MapboxDirectionsClient.name);

  /**
   * Absent configuration means Mapbox routing is unavailable and the caller
   * falls back, rather than every request spending ten seconds discovering
   * that a missing token is still missing.
   */
  get configured() {
    return Boolean(process.env.MAPBOX_TOKEN);
  }

  private token() {
    return process.env.MAPBOX_TOKEN ?? '';
  }

  private async get(path: string): Promise<unknown | null> {
    try {
      const response = await fetch(`https://api.mapbox.com${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        // The status and Mapbox's own code, never the URL: the token is in the
        // query string, and a log line is not a place to publish it.
        this.logger.warn({
          event: 'mapbox_directions_http_error',
          status: response.status,
          code: (body as { code?: unknown } | null)?.code ?? null,
        });
        return body;
      }
      return await response.json();
    } catch (error) {
      // Routing being unavailable is not an incident: the day's stops are still
      // known, they are simply drawn as straight lines. Nothing here rethrows.
      this.logger.warn({
        event: 'mapbox_directions_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The drive through `points` in the order given. Null when unavailable.
   *
   * `overview=full` because this geometry is drawn on a map somebody zooms
   * into; `simplified`, the default, visibly cuts corners off a junction.
   */
  async route(points: readonly GeoPoint[]): Promise<OsrmRoute | null> {
    if (!this.configured || points.length < 2) return null;

    const chunks = chunkForRequests(points.length);
    const parts: OsrmRoute[] = [];
    for (const [start, end] of chunks) {
      const coordinates = toOsrmCoordinates(points.slice(start, end));
      const part = parseRouteResponse(
        await this.get(
          `/directions/v5/mapbox/driving/${coordinates}` +
            `?geometries=geojson&overview=full&access_token=${encodeURIComponent(this.token())}`,
        ),
      );
      // One failed chunk makes the whole line wrong rather than short, because
      // the stops it covers would be silently dropped from the middle of a
      // route that still looks complete.
      if (!part) return null;
      parts.push(part);
    }
    return stitch(parts);
  }

  /**
   * Travel seconds and metres between every pair, origin first.
   *
   * What the quarter planner orders a day with. Null when unavailable, which
   * the caller reads as "measure it in a straight line instead".
   *
   * **Not chunked, unlike `route`.** A matrix is every pair against every
   * other, so it cannot be split into overlapping runs and joined back up the
   * way a line can — the pairs that span two chunks would simply be missing. A
   * day past the limit is refused rather than half-answered, and falls back to
   * the straight-line estimate, which is at least wrong in a way the console
   * already reports. Days here are nine or ten stops and a home.
   */
  async matrix(points: readonly GeoPoint[]) {
    if (!this.configured || points.length < 2 || points.length > MAX_COORDINATES) return null;
    return parseMatrixResponse(
      await this.get(
        `/directions-matrix/v1/mapbox/driving/${toOsrmCoordinates(points)}` +
          `?annotations=duration,distance&access_token=${encodeURIComponent(this.token())}`,
      ),
    );
  }
}
