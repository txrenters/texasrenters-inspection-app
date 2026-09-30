/**
 * The fastest order to visit a group's stops, by real drive times.
 *
 * Mapbox's Directions API already takes the fastest road from each stop to the
 * next -- but only in the order it is given, and a group built by clicking is
 * in the order it was clicked. A day that zigzags south, north and south again
 * is the fastest road through a slow order (the office, 2026-09-30: "suggest
 * the shortest drive time and not just draw it out on the map").
 *
 * So the order is worked out here: Mapbox's Matrix API gives the drive time
 * from every stop to every other -- one way, because one-way streets and
 * freeway exits make A to B and B to A different -- and the stops are put in
 * the order with the least total driving -- which stop comes first, which
 * next, which last, all chosen for the shortest drive. The office clicks a
 * group's properties in no particular order and asks for the best route
 * through them (2026-09-30: "I don't have an idea of what should come first").
 *
 * Exact for up to 13 stops (every order considered, by dynamic programming) --
 * which is every day the office plans -- and a local search beyond that.
 */

import { z } from 'zod';

import { MAPBOX_TOKEN } from '@/components/mapbox-token';

import type { LngLat } from './road-routes';

/** Drive seconds between two stops Mapbox found no road between: never chosen while there is another way. */
const UNREACHABLE_S = 1e7;

/**
 * Up to this many points the order is exact: 2^13 subsets, thirteen ends each,
 * about a million steps -- a few milliseconds. A free start adds a point, so
 * that is 13 stops.
 */
const EXACT_UP_TO = 14;

/** Seconds of driving through the stops in this order. */
export function pathSeconds(durations: readonly (readonly number[])[], order: readonly number[]): number {
  let total = 0;
  for (let index = 1; index < order.length; index += 1) total += durations[order[index - 1]!]![order[index]!]!;
  return total;
}

/**
 * The order with the least driving: which stop to start at, which to go to
 * next, which to end at.
 *
 * `durations[i][j]` is the drive from stop `i` to stop `j`, in seconds. The
 * answer lists the stops by index. With `fixedStart` stop 0 stays first and
 * only the rest are ordered.
 */
export function fastestOrder(
  durations: readonly (readonly number[])[],
  options: { fixedStart?: boolean } = {},
): number[] {
  const count = durations.length;
  if (count <= 1) return Array.from({ length: count }, (_, index) => index);
  if (options.fixedStart) {
    if (count === 2) return [0, 1];
    return count <= EXACT_UP_TO ? exactOrder(durations) : searchedOrder(durations);
  }
  // A free start: begin from a point that is no drive from anywhere, and the
  // best order out of it starts at whichever stop is best to start at.
  const padded = [
    new Array<number>(count + 1).fill(0),
    ...durations.map((row) => [0, ...row]),
  ];
  const order = count + 1 <= EXACT_UP_TO ? exactOrder(padded) : searchedOrder(padded);
  return order.slice(1).map((index) => index - 1);
}

/** Held-Karp: the cheapest path from 0 through each subset of the rest, ending at each of them. */
function exactOrder(durations: readonly (readonly number[])[]): number[] {
  const count = durations.length;
  const rest = count - 1;
  const subsets = 1 << rest;
  // cost[mask * rest + end]: the least driving from stop 0 through the stops in
  // `mask` (bit b is stop b + 1), ending at stop end + 1.
  const cost = new Float64Array(subsets * rest).fill(Number.POSITIVE_INFINITY);
  const previous = new Int8Array(subsets * rest).fill(-1);
  for (let end = 0; end < rest; end += 1) cost[(1 << end) * rest + end] = durations[0]![end + 1]!;

  for (let mask = 1; mask < subsets; mask += 1)
    for (let end = 0; end < rest; end += 1) {
      if (!(mask & (1 << end))) continue;
      const here = cost[mask * rest + end]!;
      if (here === Number.POSITIVE_INFINITY) continue;
      for (let next = 0; next < rest; next += 1) {
        if (mask & (1 << next)) continue;
        const wider = mask | (1 << next);
        const through = here + durations[end + 1]![next + 1]!;
        // Strictly less, so a tie keeps the first order found -- the same answer every time.
        if (through < cost[wider * rest + next]!) {
          cost[wider * rest + next] = through;
          previous[wider * rest + next] = end;
        }
      }
    }

  const full = subsets - 1;
  let end = 0;
  for (let candidate = 1; candidate < rest; candidate += 1)
    if (cost[full * rest + candidate]! < cost[full * rest + end]!) end = candidate;

  const reversed: number[] = [];
  let mask = full;
  while (end >= 0) {
    reversed.push(end + 1);
    const before = previous[mask * rest + end]!;
    mask &= ~(1 << end);
    end = before;
  }
  return [0, ...reversed.reverse()];
}

/**
 * Beyond 13 stops: the nearest stop each time, then any reversal of a run of
 * stops or move of one stop that shortens the drive, until none does.
 */
function searchedOrder(durations: readonly (readonly number[])[]): number[] {
  const count = durations.length;
  const order = [0];
  const left = new Set(Array.from({ length: count - 1 }, (_, index) => index + 1));
  while (left.size) {
    const from = order[order.length - 1]!;
    let best = -1;
    for (const stop of left) if (best < 0 || durations[from]![stop]! < durations[from]![best]!) best = stop;
    order.push(best);
    left.delete(best);
  }

  let current = pathSeconds(durations, order);
  for (let pass = 0, improved = true; improved && pass < 100; pass += 1) {
    improved = false;
    for (let start = 1; start < count - 1; start += 1)
      for (let stop = start + 1; stop < count; stop += 1) {
        const reversed = [...order.slice(0, start), ...order.slice(start, stop + 1).reverse(), ...order.slice(stop + 1)];
        const seconds = pathSeconds(durations, reversed);
        if (seconds < current - 1e-9) {
          order.splice(0, count, ...reversed);
          current = seconds;
          improved = true;
        }
      }
    for (let from = 1; from < count; from += 1)
      for (let to = 1; to < count; to += 1) {
        if (from === to) continue;
        const moved = [...order];
        const [stop] = moved.splice(from, 1);
        moved.splice(to, 0, stop!);
        const seconds = pathSeconds(durations, moved);
        if (seconds < current - 1e-9) {
          order.splice(0, count, ...moved);
          current = seconds;
          improved = true;
        }
      }
  }
  return order;
}

/* ------------------------------------------------------------------------ */
/* Drive times between every pair of stops, from Mapbox                      */
/* ------------------------------------------------------------------------ */

const MATRIX = 'https://api.mapbox.com/directions-matrix/v1/mapbox/driving';

/** The most stops Mapbox takes in one driving matrix; past it the answer is a 422. */
export const MAX_MATRIX_STOPS = 25;

export function matrixUrl(coordinates: readonly LngLat[], token: string): string {
  const path = coordinates.map(([longitude, latitude]) => `${longitude.toFixed(6)},${latitude.toFixed(6)}`).join(';');
  return `${MATRIX}/${path}?annotations=duration&access_token=${encodeURIComponent(token)}`;
}

const matrixSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  durations: z.array(z.array(z.number().nullable())).optional(),
});

/** What Mapbox answered, as drive seconds from each stop to each other -- or why it is not that. */
export function parseMatrix(body: unknown, count: number): number[][] {
  const parsed = matrixSchema.safeParse(body);
  if (!parsed.success) throw new Error('Mapbox sent back something that is not a table of drive times.');
  const { code, message, durations } = parsed.data;
  if (code !== 'Ok' || !durations) throw new Error(message ?? `Mapbox could not time the drives (${code}).`);
  if (durations.length !== count || durations.some((row) => row.length !== count))
    throw new Error('Mapbox timed a different number of stops.');
  return durations.map((row, from) => row.map((seconds, to) => (from === to ? 0 : (seconds ?? UNREACHABLE_S))));
}

type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface MatrixSourceOptions {
  token: string;
  fetch: Fetcher;
  /**
   * The least time between two requests starting. Mapbox allows sixty matrix
   * requests a minute; 1.1 seconds keeps well inside that however fast the
   * office clicks.
   */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface MatrixSource {
  /** Drive seconds between every pair of these stops, from memory when every pair is known. */
  durations(coordinates: readonly LngLat[]): Promise<number[][]>;
}

const pointKey = ([longitude, latitude]: LngLat) => `${longitude.toFixed(6)},${latitude.toFixed(6)}`;

export function createMatrixSource(options: MatrixSourceOptions): MatrixSource {
  const gapMs = options.gapMs ?? 1100;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  /** Drive seconds by "from|to": a pair once timed is never asked for again on this page. */
  const pairs = new Map<string, number>();
  let nextSlot = 0;
  /** One request at a time, in the order asked. */
  let line: Promise<unknown> = Promise.resolve();

  const known = (coordinates: readonly LngLat[]): number[][] | null => {
    const keys = coordinates.map(pointKey);
    const table: number[][] = [];
    for (const from of keys) {
      const row: number[] = [];
      for (const to of keys) {
        const seconds = from === to ? 0 : pairs.get(`${from}|${to}`);
        if (seconds === undefined) return null;
        row.push(seconds);
      }
      table.push(row);
    }
    return table;
  };

  const request = async (coordinates: readonly LngLat[], attempt = 0): Promise<number[][]> => {
    const slot = Math.max(now(), nextSlot);
    nextSlot = slot + gapMs;
    if (slot > now()) await sleep(slot - now());
    const response = await options.fetch(matrixUrl(coordinates, options.token));
    if (response.status === 429 && attempt < 3) {
      const seconds = Number(response.headers.get('retry-after'));
      await sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 2 ** attempt) * 1000);
      return request(coordinates, attempt + 1);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (body as { message?: unknown } | null)?.message;
      throw new Error(typeof message === 'string' ? message : `Mapbox answered ${response.status}.`);
    }
    return parseMatrix(body, coordinates.length);
  };

  return {
    durations(coordinates) {
      const cached = known(coordinates);
      if (cached) return Promise.resolve(cached);
      if (!options.token) return Promise.reject(new Error('There is no Mapbox token to time the drives with.'));
      if (coordinates.length > MAX_MATRIX_STOPS)
        return Promise.reject(new Error(`Mapbox times at most ${MAX_MATRIX_STOPS} stops at once.`));
      const result = line.then(() => request(coordinates));
      line = result.catch(() => undefined);
      return result.then((table) => {
        const keys = coordinates.map(pointKey);
        table.forEach((row, from) =>
          row.forEach((seconds, to) => {
            if (from !== to) pairs.set(`${keys[from]}|${keys[to]}`, seconds);
          }),
        );
        return table;
      });
    },
  };
}

let shared: MatrixSource | null = null;

/** The page's one source, so every group shares one queue and one memory of timed pairs. */
export function getMatrixSource(): MatrixSource {
  shared ??= createMatrixSource({ token: MAPBOX_TOKEN, fetch: (url) => fetch(url) });
  return shared;
}
