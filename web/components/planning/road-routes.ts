/**
 * Road routes for the groups on the Groups map, from the Mapbox Directions API.
 *
 * A straight line from stop to stop says nothing about the river between them
 * or the freeway with one exit, and the office asked for the drive itself
 * (2026-09-30): the route along the roads, in stop order, with how long it
 * takes and how far it is, each leg as well as the whole.
 *
 * Asked for with the token the map already draws with -- a public `pk.` token,
 * which the Directions API accepts with its default scopes. Each answer is
 * cached by the exact stops in their exact order, in memory and in this
 * browser's storage beside the grouping's autosave, so a group that has not
 * changed is never asked for again, not even after a reload. Requests go out
 * two at a time and at most four a second, well inside Mapbox's 300 a minute,
 * so a file of forty groups fills in over a few seconds rather than tripping it.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';

import { MAPBOX_TOKEN } from '@/components/mapbox-token';

import { hashText } from './manual-grouping';

/** `[longitude, latitude]`, as Mapbox and GeoJSON have it. */
export type LngLat = [number, number];

export interface RoadLeg {
  /** Driving time from the stop before, in seconds. */
  durationS: number;
  distanceM: number;
}

export interface RoadRoute {
  /** The drive through every stop in order, along the roads. */
  geometry: LngLat[];
  durationS: number;
  distanceM: number;
  /** One per step from a stop to the next: stop 1 to 2 is `legs[0]`. */
  legs: RoadLeg[];
  /** Where each stop falls on `geometry`, by vertex: leg `i` runs from `splits[i]` to `splits[i + 1]`. */
  splits: number[];
}

export type RouteView =
  /** Fewer than two stops: nothing to drive. */
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ok'; route: RoadRoute }
  /** Mapbox could not route it; the map falls back to straight lines. */
  | { status: 'error'; message: string };

const DIRECTIONS = 'https://api.mapbox.com/directions/v5/mapbox/driving';

/** The most stops Mapbox takes in one driving request; past it the answer is a 422. */
export const MAX_WAYPOINTS = 25;

/** A leg this long or longer is called out: 15 minutes (the office, 2026-09-30). */
export const SLOW_LEG_S = 15 * 60;

const METRES_PER_MILE = 1609.344;

/** The stops, in order, as the cache knows them: six decimals is ten centimetres. */
export function routeKey(coordinates: readonly LngLat[]): string {
  return coordinates.map(([longitude, latitude]) => `${longitude.toFixed(6)},${latitude.toFixed(6)}`).join(';');
}

/** One Directions request: driving, the whole route as GeoJSON, full detail. */
export function directionsUrl(coordinates: readonly LngLat[], token: string): string {
  const path = coordinates.map(([longitude, latitude]) => `${longitude.toFixed(6)},${latitude.toFixed(6)}`).join(';');
  return `${DIRECTIONS}/${path}?geometries=geojson&overview=full&access_token=${encodeURIComponent(token)}`;
}

/** Stops in runs of 25 at most, each run starting where the last ended, so the legs join up. */
export function waypointChunks<T>(coordinates: readonly T[]): T[][] {
  if (coordinates.length <= MAX_WAYPOINTS) return [[...coordinates]];
  const chunks: T[][] = [];
  for (let start = 0; start < coordinates.length - 1; start += MAX_WAYPOINTS - 1)
    chunks.push(coordinates.slice(start, start + MAX_WAYPOINTS));
  return chunks;
}

/**
 * Where each stop falls on the drawn route, by vertex.
 *
 * `overview=full` gives one line for the whole drive and no line per leg, but
 * it also gives each stop's snapped position, which lies on that line. Found
 * searching forwards from the last one, so a route that passes a stop twice
 * splits where it arrives there in order.
 */
export function splitAtWaypoints(geometry: readonly LngLat[], waypoints: readonly LngLat[]): number[] {
  const splits = [0];
  let from = 0;
  for (let index = 1; index < waypoints.length - 1; index += 1) {
    const [longitude, latitude] = waypoints[index]!;
    let best = from;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let vertex = from; vertex < geometry.length; vertex += 1) {
      const distance = (geometry[vertex]![0] - longitude) ** 2 + (geometry[vertex]![1] - latitude) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
        // On the line itself: this is where the route arrives, not a later pass.
        if (distance < 1e-12) break;
      }
    }
    splits.push(best);
    from = best;
  }
  splits.push(Math.max(0, geometry.length - 1));
  return splits;
}

/** The road under one leg, from the stop before to this one. */
export function legGeometry(route: RoadRoute, leg: number): LngLat[] {
  return route.geometry.slice(route.splits[leg], (route.splits[leg + 1] ?? route.geometry.length - 1) + 1);
}

const directionsSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  routes: z
    .array(
      z.object({
        duration: z.number(),
        distance: z.number(),
        geometry: z.object({ coordinates: z.array(z.tuple([z.number(), z.number()])) }),
        legs: z.array(z.object({ duration: z.number(), distance: z.number() })),
      }),
    )
    .optional(),
  waypoints: z.array(z.object({ location: z.tuple([z.number(), z.number()]) })).optional(),
});

/** What Mapbox answered, checked, as a route -- or why it is not one. */
export function parseDirections(body: unknown, requested: readonly LngLat[]): RoadRoute {
  const parsed = directionsSchema.safeParse(body);
  if (!parsed.success) throw new Error('Mapbox sent back something that is not a route.');
  const { code, message, routes, waypoints } = parsed.data;
  const route = routes?.[0];
  if (code !== 'Ok' || !route) throw new Error(message ?? `Mapbox could not route it (${code}).`);
  if (route.legs.length !== requested.length - 1) throw new Error('Mapbox routed a different number of stops.');
  const geometry = route.geometry.coordinates as LngLat[];
  return {
    geometry,
    durationS: route.duration,
    distanceM: route.distance,
    legs: route.legs.map((leg) => ({ durationS: leg.duration, distanceM: leg.distance })),
    splits: splitAtWaypoints(geometry, (waypoints?.map((point) => point.location) ?? requested) as LngLat[]),
  };
}

/** Routes of consecutive runs of stops, as one route through them all. */
export function mergeRoutes(parts: readonly RoadRoute[]): RoadRoute {
  const [first, ...rest] = parts;
  if (!first) throw new Error('Nothing to join.');
  return rest.reduce<RoadRoute>(
    (joined, part) => {
      // The run starts where the last one ended: that point is already there.
      const offset = joined.geometry.length - 1;
      return {
        geometry: [...joined.geometry, ...part.geometry.slice(1)],
        durationS: joined.durationS + part.durationS,
        distanceM: joined.distanceM + part.distanceM,
        legs: [...joined.legs, ...part.legs],
        splits: [...joined.splits, ...part.splits.slice(1).map((split) => split + offset)],
      };
    },
    { ...first },
  );
}

/* ------------------------------------------------------------------------ */
/* Kept in the browser: an encoded polyline, not a list of numbers           */
/* ------------------------------------------------------------------------ */

/**
 * Google's polyline encoding, five decimals (about a metre). A route of two
 * thousand points is about twelve kilobytes this way against sixty as JSON, so
 * a whole quarter's routes fit in the browser's storage beside the autosave.
 */
export function encodePolyline(points: readonly LngLat[]): string {
  let output = '';
  let previousLatitude = 0;
  let previousLongitude = 0;
  const encode = (value: number) => {
    let current = value < 0 ? ~(value << 1) : value << 1;
    while (current >= 0x20) {
      output += String.fromCharCode((0x20 | (current & 0x1f)) + 63);
      current >>= 5;
    }
    output += String.fromCharCode(current + 63);
  };
  for (const [longitude, latitude] of points) {
    const latitudeE5 = Math.round(latitude * 1e5);
    const longitudeE5 = Math.round(longitude * 1e5);
    encode(latitudeE5 - previousLatitude);
    encode(longitudeE5 - previousLongitude);
    previousLatitude = latitudeE5;
    previousLongitude = longitudeE5;
  }
  return output;
}

export function decodePolyline(text: string): LngLat[] {
  const points: LngLat[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const decode = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = text.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < text.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < text.length) {
    latitude += decode();
    longitude += decode();
    points.push([longitude / 1e5, latitude / 1e5]);
  }
  return points;
}

/** Beside the grouping's autosave, in this browser. */
export const ROUTE_CACHE_KEY = 'texasrenters:manual-grouping:routes:v1';

/** More routes than a quarter has groups, several times over; the oldest go first. */
const MAX_STORED = 400;

const storedSchema = z.object({
  g: z.string(),
  s: z.array(z.number().int().min(0)),
  d: z.number(),
  m: z.number(),
  l: z.array(z.tuple([z.number(), z.number()])),
  t: z.number(),
});
type StoredRoute = z.infer<typeof storedSchema>;

const deflate = (route: RoadRoute, now: number): StoredRoute => ({
  g: encodePolyline(route.geometry),
  s: route.splits,
  d: route.durationS,
  m: route.distanceM,
  l: route.legs.map((leg) => [leg.durationS, leg.distanceM]),
  t: now,
});

function inflate(stored: StoredRoute): RoadRoute | null {
  const geometry = decodePolyline(stored.g);
  if (stored.s.length !== stored.l.length + 1 || stored.s.some((split) => split >= geometry.length)) return null;
  return {
    geometry,
    durationS: stored.d,
    distanceM: stored.m,
    legs: stored.l.map(([durationS, distanceM]) => ({ durationS, distanceM })),
    splits: stored.s,
  };
}

/* ------------------------------------------------------------------------ */
/* The store: one per page, shared by both views                             */
/* ------------------------------------------------------------------------ */

type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface RouteStoreOptions {
  token: string;
  fetch: Fetcher;
  /** `localStorage`, or null where there is none. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Requests in flight at once. */
  concurrency?: number;
  /** The least time between two requests starting: 250ms is four a second. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RouteStore {
  /** What is known of a route: cached, being fetched, failed -- or undefined, not yet asked. */
  view(key: string): RouteView | undefined;
  /** The route, from the cache when it is there, from Mapbox when it is not. */
  ensure(key: string, coordinates: readonly LngLat[]): Promise<RoadRoute>;
  subscribe(listener: () => void): () => void;
  version(): number;
}

interface Job {
  key: string;
  coordinates: readonly LngLat[];
  resolve: (route: RoadRoute) => void;
  reject: (error: Error) => void;
}

export function createRouteStore(options: RouteStoreOptions): RouteStore {
  const concurrency = options.concurrency ?? 2;
  const gapMs = options.gapMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const memory = new Map<string, { view: RouteView; promise?: Promise<RoadRoute> }>();
  const listeners = new Set<() => void>();
  const queue: Job[] = [];
  let persisted: Record<string, StoredRoute> | null = null;
  let version = 0;
  let active = 0;
  let nextSlot = 0;

  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const stored = (): Record<string, StoredRoute> => {
    if (persisted) return persisted;
    persisted = {};
    try {
      const raw = options.storage?.getItem(ROUTE_CACHE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object')
        for (const [hash, value] of Object.entries(parsed)) {
          const entry = storedSchema.safeParse(value);
          if (entry.success) persisted[hash] = entry.data;
        }
    } catch {
      // Unreadable or refused: start empty, and routes are fetched again.
    }
    return persisted;
  };

  const save = () => {
    const all = stored();
    const newestFirst = Object.entries(all).sort((left, right) => right[1].t - left[1].t);
    for (const [hash] of newestFirst.slice(MAX_STORED)) delete all[hash];
    try {
      options.storage?.setItem(ROUTE_CACHE_KEY, JSON.stringify(all));
    } catch {
      // Full: keep the newest half and try once more; failing that, memory alone.
      for (const [hash] of newestFirst.slice(Math.floor(MAX_STORED / 2))) delete all[hash];
      try {
        options.storage?.setItem(ROUTE_CACHE_KEY, JSON.stringify(all));
      } catch {
        /* Routes stay cached for this page. */
      }
    }
  };

  const view = (key: string): RouteView | undefined => {
    const known = memory.get(key);
    if (known) return known.view;
    const kept = stored()[hashText(key)];
    const route = kept ? inflate(kept) : null;
    if (!route) return undefined;
    const entry = { view: { status: 'ok', route } as const };
    memory.set(key, entry);
    return entry.view;
  };

  /** One Directions request, spaced from the last and retried when Mapbox asks for a pause. */
  const request = async (coordinates: readonly LngLat[], attempt = 0): Promise<RoadRoute> => {
    const slot = Math.max(now(), nextSlot);
    nextSlot = slot + gapMs;
    if (slot > now()) await sleep(slot - now());
    const response = await options.fetch(directionsUrl(coordinates, options.token));
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
    return parseDirections(body, coordinates);
  };

  const run = async (job: Job) => {
    try {
      if (!options.token) throw new Error('There is no Mapbox token to ask for routes with.');
      const parts: RoadRoute[] = [];
      for (const chunk of waypointChunks(job.coordinates)) parts.push(await request(chunk));
      const route = mergeRoutes(parts);
      memory.set(job.key, { view: { status: 'ok', route } });
      stored()[hashText(job.key)] = deflate(route, now());
      save();
      job.resolve(route);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The route could not be fetched.';
      memory.set(job.key, { view: { status: 'error', message } });
      job.reject(error instanceof Error ? error : new Error(message));
    } finally {
      changed();
    }
  };

  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift()!;
      active += 1;
      void run(job).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  return {
    view,
    ensure(key, coordinates) {
      const known = view(key);
      if (known?.status === 'ok') return Promise.resolve(known.route);
      const entry = memory.get(key);
      if (entry?.promise) return entry.promise;
      // A failure stands for this page: asking again is a reload, not a loop.
      if (known?.status === 'error') return Promise.reject(new Error(known.message));
      const promise = new Promise<RoadRoute>((resolve, reject) => queue.push({ key, coordinates, resolve, reject }));
      memory.set(key, { view: { status: 'loading' }, promise });
      changed();
      pump();
      return promise;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

let shared: RouteStore | null = null;

/** The page's one store, so both views -- and every group in them -- share one cache and one queue. */
export function getRouteStore(): RouteStore {
  if (shared) return shared;
  let storage: Storage | null = null;
  try {
    storage = typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    storage = null;
  }
  shared = createRouteStore({
    token: MAPBOX_TOKEN,
    fetch: (url) => fetch(url),
    storage,
  });
  return shared;
}

/* ------------------------------------------------------------------------ */
/* In components                                                             */
/* ------------------------------------------------------------------------ */

export interface RouteRequest {
  id: string;
  coordinates: LngLat[];
}

const noVersion = () => 0;

/**
 * The road route of each group, by its id, asked for as groups change.
 *
 * Asked for 600ms after the stops last changed, so clicking five properties in
 * a row asks once and not five times. A group already cached answers at once,
 * debounce or not. Everything reads as loading until the page has mounted: the
 * cache lives in the browser, and a server render that read it differently
 * would not match.
 */
export function useRoadRoutes(requests: readonly RouteRequest[], debounceMs = 600): ReadonlyMap<string, RouteView> {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const store = mounted ? getRouteStore() : null;
  const version = useSyncExternalStore(store?.subscribe ?? subscribeNowhere, store?.version ?? noVersion, noVersion);

  const keyed = useMemo(
    () => requests.map((request) => ({ ...request, key: routeKey(request.coordinates) })),
    [requests],
  );
  const latest = useRef(keyed);
  latest.current = keyed;
  const wanted = keyed
    .filter((request) => request.coordinates.length >= 2)
    .map((request) => request.key)
    .join('|');

  useEffect(() => {
    if (!store || !wanted) return;
    const timer = setTimeout(() => {
      for (const request of latest.current)
        if (request.coordinates.length >= 2) void store.ensure(request.key, request.coordinates).catch(() => undefined);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, store, wanted]);

  return useMemo(() => {
    const views = new Map<string, RouteView>();
    for (const request of keyed) {
      if (request.coordinates.length < 2) views.set(request.id, { status: 'none' });
      else views.set(request.id, store?.view(request.key) ?? { status: 'loading' });
    }
    return views;
    // `version` is what changes when a route arrives.
  }, [keyed, store, version]);
}

function subscribeNowhere() {
  return () => undefined;
}

/* ------------------------------------------------------------------------ */
/* Said in words                                                             */
/* ------------------------------------------------------------------------ */

/** "8 min", "1 h 12 min", "5 h". */
export function formatDrive(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * "61.8 km". The office works in kilometres (2026-09-30); the files it
 * imports and exports keep their miles columns, and are converted for show.
 */
export const formatKm = (metres: number) => `${(metres / 1000).toFixed(1)} km`;

/** A figure in miles, as the office's files write them, in metres. */
export const milesToMetres = (miles: number) => miles * METRES_PER_MILE;

/**
 * The point halfway along a line, by distance -- where a leg's drive time is
 * written on the map, so it sits on the leg it belongs to rather than on a
 * stop. Measured flat, with longitude narrowed to its width here.
 */
export function midpointOf(points: readonly LngLat[]): LngLat {
  if (points.length < 2) return points[0] ?? [0, 0];
  const narrow = Math.cos(((points[0]![1] ?? 0) * Math.PI) / 180);
  const lengths = points.slice(1).map((point, index) =>
    Math.hypot((point[0] - points[index]![0]) * narrow, point[1] - points[index]![1]),
  );
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length && length > 0) {
      const share = remaining / length;
      const [from, to] = [points[index]!, points[index + 1]!];
      return [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share];
    }
    remaining -= length;
  }
  return points[points.length - 1]!;
}
