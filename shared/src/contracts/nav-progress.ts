import { haversineMeters } from './route-plan.js';
import {
  NAV_ARRIVAL_DWELL_MS,
  NAV_ARRIVAL_RADIUS_M,
  NAV_ARRIVAL_SPEED_MS,
  NAV_MAX_ACCURACY_M,
  NAV_MOVING_SPEED_MS,
  NAV_OFF_ROUTE_FIXES,
  NAV_OFF_ROUTE_M,
  NAV_STEP_ADVANCE_M,
  NAV_ANNOUNCE_DISTANCES_M,
  type NavigationStep,
} from './navigation.js';

/**
 * Where the driver is on the leg they are driving, and what to say about it.
 *
 * All of it pure arithmetic over a polyline and a fix, so the whole of
 * navigation's judgement -- which step, how far to the turn, has it gone wrong,
 * have we arrived, what should be spoken -- is testable without a device, a
 * network, or a map. The screen is a renderer over this; it decides nothing.
 *
 * **Every coordinate is `[latitude, longitude]`.** See the note in
 * `navigation.ts`; the tests assert the sign of each value rather than its
 * position, because an axis swap draws a plausible route in the wrong ocean.
 */

type LatLng = readonly [number, number];
type LatLngPath = readonly LatLng[];

/**
 * A position fix, already cleaned of the platform's lies.
 *
 * `heading` and `speed` are null rather than -1. Both iOS and Android report
 * `-1` for "no course" and "no speed", and stored literally that is a heading
 * of minus one degree: every technician standing still points just west of
 * north, and a raw -1 speed reads as stationary while the vehicle is doing
 * seventy. `normaliseNavFix` is the one place that is fixed, and it runs on
 * every fix entering navigation.
 */
export interface NavFix {
  latitude: number;
  longitude: number;
  /** Metres of horizontal uncertainty, or null when the platform gave none. */
  accuracyMeters: number | null;
  /** Metres per second, or null when unknown. Never negative. */
  speedMetersPerSecond: number | null;
  /** Degrees clockwise from true north, 0-360, or null when unknown. */
  headingDegrees: number | null;
  /** Epoch milliseconds. */
  at: number;
}

/** The raw shape both platforms hand back, before any of it is believed. */
export interface RawFix {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  timestamp?: number | null;
}

/**
 * Turns a platform fix into one navigation will act on.
 *
 * Three separate lies are corrected here:
 *
 * - **`-1` for absent.** Both platforms use it for course and for speed.
 * - **A course of exactly zero with no speed.** Android reports heading 0
 *   rather than -1 when it has none, which is indistinguishable from due north
 *   except that the vehicle is not moving. Under `NAV_MOVING_SPEED_MS` the
 *   course is dropped whatever its value, so the camera holds instead of
 *   snapping north.
 * - **Negative accuracy.** Android uses it for "unknown" on some devices.
 */
export function normaliseNavFix(raw: RawFix, now: number): NavFix {
  const speed =
    typeof raw.speed === 'number' && raw.speed >= 0 && Number.isFinite(raw.speed)
      ? raw.speed
      : null;
  const moving = speed !== null && speed >= NAV_MOVING_SPEED_MS;
  const heading =
    moving &&
    typeof raw.heading === 'number' &&
    raw.heading >= 0 &&
    raw.heading <= 360 &&
    Number.isFinite(raw.heading)
      ? raw.heading % 360
      : null;
  const accuracy =
    typeof raw.accuracy === 'number' && raw.accuracy >= 0 && Number.isFinite(raw.accuracy)
      ? raw.accuracy
      : null;

  return {
    latitude: raw.latitude,
    longitude: raw.longitude,
    accuracyMeters: accuracy,
    speedMetersPerSecond: speed,
    headingDegrees: heading,
    at: typeof raw.timestamp === 'number' && raw.timestamp > 0 ? raw.timestamp : now,
  };
}

/**
 * Whether a fix is precise enough to steer by.
 *
 * A fix with no reported accuracy is trusted: some Android devices simply omit
 * it, and refusing every one of those would leave those handsets unable to
 * navigate at all. A fix that reports a bad number is refused -- it has told us
 * it does not know where it is.
 */
export function isUsableNavFix(fix: NavFix): boolean {
  return fix.accuracyMeters === null || fix.accuracyMeters <= NAV_MAX_ACCURACY_M;
}

/** Cumulative metres to each point of a path, and the total. */
export interface MeasuredPath {
  path: LatLngPath;
  /** `cumulative[i]` is metres from `path[0]` to `path[i]`. */
  cumulative: readonly number[];
  totalMeters: number;
}

/** Measures a path once so projections against it are not O(n) in distance. */
export function measurePath(path: LatLngPath): MeasuredPath {
  const cumulative: number[] = [0];
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    cumulative.push(
      cumulative[index - 1] +
        haversineMeters(
          { latitude: a[0], longitude: a[1] },
          { latitude: b[0], longitude: b[1] },
        ),
    );
  }
  return { path, cumulative, totalMeters: cumulative[cumulative.length - 1] ?? 0 };
}

/** Where a point falls on a measured path. */
export interface PathPosition {
  alongMeters: number;
  offsetMeters: number;
  /** The index of the segment's *end* point, so `path[segment-1] -> path[segment]`. */
  segment: number;
  snapped: LatLng;
}

/**
 * Projects a point onto a measured path, searching forward from a segment.
 *
 * `projectOntoPath` in `live-route.ts` takes the globally nearest segment over
 * the whole path, which is right for the console: it asks where a technician is
 * on a line drawn minutes ago, with no notion of progress along it.
 *
 * A navigator cannot use that. A leg routinely passes within metres of itself
 * -- a road driven out and back, a frontage road beside the motorway it feeds,
 * a cloverleaf -- and the globally nearest point on such a leg jumps to the
 * *other* pass. The step index jumps with it, the countdown resets, and the
 * voice speaks a turn that is two miles away. So the search starts at the
 * driver's current segment and only looks forward, with a short look-back
 * (`lookBackSegments`) so that a fix landing slightly behind the last one --
 * which ordinary GPS wander produces constantly -- does not fall off the path.
 */
export function projectOntoMeasuredPath(
  point: { latitude: number; longitude: number },
  measured: MeasuredPath,
  fromSegment = 1,
  lookBackSegments = 2,
): PathPosition | null {
  const { path, cumulative } = measured;
  if (path.length < 2) return null;

  const start = Math.max(1, Math.min(fromSegment - lookBackSegments, path.length - 1));
  let best: PathPosition | null = null;

  for (let index = start; index < path.length; index += 1) {
    const [aLat, aLng] = path[index - 1];
    const [bLat, bLng] = path[index];
    const segmentLength = cumulative[index] - cumulative[index - 1];

    // Metres per degree at this latitude, for a flat local frame around A. Exact
    // to well under a metre over the span of one polyline segment.
    const kx = 111_320 * Math.cos((aLat * Math.PI) / 180);
    const ky = 110_540;
    const abx = (bLng - aLng) * kx;
    const aby = (bLat - aLat) * ky;
    const apx = (point.longitude - aLng) * kx;
    const apy = (point.latitude - aLat) * ky;

    const lengthSquared = abx * abx + aby * aby;
    const t =
      lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSquared));
    const dx = apx - t * abx;
    const dy = apy - t * aby;
    const offsetMeters = Math.hypot(dx, dy);

    if (!best || offsetMeters < best.offsetMeters) {
      best = {
        alongMeters: cumulative[index - 1] + t * segmentLength,
        offsetMeters,
        segment: index,
        snapped: [aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t],
      };
    }
  }

  return best;
}

/** A leg's steps, laid end to end, with each step's span along the whole. */
export interface LegPath {
  measured: MeasuredPath;
  /** One entry per step: where it begins and ends along the leg. */
  bounds: readonly { startMeters: number; endMeters: number; startSegment: number }[];
}

/**
 * Lays a leg's steps end to end into one measurable path.
 *
 * Built from the *steps* rather than from `NavigationLeg.polyline`, and the
 * step boundaries are measured off that same geometry rather than taken from
 * each step's reported `distanceMeters`. Those two never quite agree -- the
 * router's distance is its own road-network figure and the polyline is a
 * simplification of it, a discrepancy `live-route.ts` already documents for
 * legs. Mixing them puts every boundary tens of metres out, which is precisely
 * the scale the step-advance margin works at, so the countdown would hand over
 * early on one step and late on the next.
 *
 * Steps share endpoints -- each begins where the last ended -- so the duplicate
 * is dropped, otherwise every boundary sits on a zero-length segment.
 */
export function buildLegPath(steps: readonly NavigationStep[]): LegPath {
  const path: LatLng[] = [];
  const spans: { startIndex: number; endIndex: number }[] = [];

  for (const step of steps) {
    const startIndex = Math.max(0, path.length - (path.length ? 1 : 0));
    for (let index = 0; index < step.polyline.length; index += 1) {
      const point = step.polyline[index];
      const last = path[path.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      path.push(point);
    }
    spans.push({ startIndex, endIndex: Math.max(0, path.length - 1) });
  }

  const measured = measurePath(path);
  const bounds = spans.map((span) => ({
    startMeters: measured.cumulative[span.startIndex] ?? 0,
    endMeters: measured.cumulative[span.endIndex] ?? measured.totalMeters,
    startSegment: Math.max(1, span.startIndex + 1),
  }));

  return { measured, bounds };
}

/** What navigation knows after folding in one fix. */
export interface NavProgress {
  /** The step being driven. Never decreases without `relocate`. */
  stepIndex: number;
  /** Metres to the end of the current step -- i.e. to the next maneuver. */
  metersToManeuver: number;
  /** Metres left of the whole leg. */
  metersRemaining: number;
  /** How far the fix is from the drawn line. */
  offsetMeters: number;
  /** Consecutive fixes spent beyond `NAV_OFF_ROUTE_M`. */
  offRouteFixes: number;
  /** True once that count reaches `NAV_OFF_ROUTE_FIXES`. */
  offRoute: boolean;
  /** The fix pulled onto the line, for drawing. Null while off route. */
  snapped: LatLng | null;
  /** Along the leg, for trimming the driven part of the line. */
  alongMeters: number;
}

/** The running state navigation carries between fixes. */
export interface NavProgressState {
  stepIndex: number;
  alongMeters: number;
  offRouteFixes: number;
}

export const INITIAL_NAV_PROGRESS: NavProgressState = {
  stepIndex: 0,
  alongMeters: 0,
  offRouteFixes: 0,
};

/**
 * Folds one fix into the running progress.
 *
 * Three rules, each of which exists because its absence produces a specific
 * visible fault:
 *
 * - **The step index only ever goes up.** A fix wandering back across a
 *   boundary would otherwise re-show the previous instruction and re-speak it.
 * - **It goes up only once the driver is `NAV_STEP_ADVANCE_M` past the
 *   boundary.** Sitting at a red light exactly on a boundary, consecutive fixes
 *   land either side of it; without the margin the banner alternates between
 *   two instructions several times a second.
 * - **Being off the line is counted, not acted on.** One fix beyond
 *   `NAV_OFF_ROUTE_M` is an overpass or an urban canyon. `NAV_OFF_ROUTE_FIXES`
 *   in a row is a wrong turn. The counter resets the moment a fix comes back.
 *
 * While off route, `snapped` is null and `metersToManeuver` holds its last
 * value rather than being recomputed against a line the driver is not on --
 * `splitRouteAtPosition` makes the same choice for the same reason, and a
 * remaining distance that leaps when somebody takes a wrong turn reads as a
 * bug rather than as information.
 */
export function advanceNavProgress(
  leg: LegPath,
  fix: NavFix,
  state: NavProgressState,
): { progress: NavProgress; state: NavProgressState } {
  const { measured, bounds } = leg;
  const current = Math.min(state.stepIndex, Math.max(0, bounds.length - 1));
  const fromSegment = bounds[current]?.startSegment ?? 1;
  const position = projectOntoMeasuredPath(fix, measured, fromSegment);

  if (!position) {
    const progress: NavProgress = {
      stepIndex: current,
      metersToManeuver: 0,
      metersRemaining: 0,
      offsetMeters: Number.POSITIVE_INFINITY,
      offRouteFixes: state.offRouteFixes,
      offRoute: state.offRouteFixes >= NAV_OFF_ROUTE_FIXES,
      snapped: null,
      alongMeters: state.alongMeters,
    };
    return { progress, state };
  }

  const wandered = position.offsetMeters > NAV_OFF_ROUTE_M;
  const offRouteFixes = wandered ? state.offRouteFixes + 1 : 0;
  const offRoute = offRouteFixes >= NAV_OFF_ROUTE_FIXES;

  // Never rewind. A fix behind the last one is wander, not reversing.
  const alongMeters = wandered
    ? state.alongMeters
    : Math.max(state.alongMeters, position.alongMeters);

  let stepIndex = current;
  while (
    stepIndex < bounds.length - 1 &&
    alongMeters > bounds[stepIndex].endMeters + NAV_STEP_ADVANCE_M
  ) {
    stepIndex += 1;
  }

  const bound = bounds[stepIndex];
  const metersToManeuver = Math.max(0, (bound?.endMeters ?? measured.totalMeters) - alongMeters);
  const metersRemaining = Math.max(0, measured.totalMeters - alongMeters);

  return {
    progress: {
      stepIndex,
      metersToManeuver,
      metersRemaining,
      offsetMeters: position.offsetMeters,
      offRouteFixes,
      offRoute,
      snapped: wandered ? null : position.snapped,
      alongMeters,
    },
    state: { stepIndex, alongMeters, offRouteFixes },
  };
}

/** What arrival detection remembers between fixes. */
export interface ArrivalState {
  /** When the driver first met both tests, or null. */
  since: number | null;
}

export const INITIAL_ARRIVAL: ArrivalState = { since: null };

/**
 * Whether the driver has arrived at a stop, and is not merely passing it.
 *
 * Distance **and** speed **and** time, for the reason set out beside
 * `NAV_ARRIVAL_RADIUS_M`: on radius alone, driving past the next house on the
 * way to this one silently advances the day's chain to a stop being driven away
 * from. A fix that is not usable neither confirms nor cancels -- a single
 * 200-metre spike beside the right house must not cancel a genuine arrival that
 * is already several seconds old.
 */
export function checkArrival(
  fix: NavFix,
  stop: { latitude: number; longitude: number },
  state: ArrivalState,
  roadEnd?: { latitude: number; longitude: number } | null,
): { arrived: boolean; state: ArrivalState } {
  if (!isUsableNavFix(fix)) return { arrived: false, state };

  // Measured to whichever is nearer, the property or the end of the drive.
  //
  // `stop` is the geocoded property point. Google snaps a destination to the
  // road it is on -- `planning.controller.ts` already documents this -- so the
  // polyline ends at the kerb, which on a deep lot or a gated drive is well
  // over the radius away from the geocode. Measured to the geocode alone, a
  // technician who parks exactly where the route told them to is never counted
  // as having arrived; measured to the road alone, one who pulls onto the
  // property is not either. The nearer of the two is the only honest test.
  const metres = Math.min(
    haversineMeters(fix, stop),
    roadEnd ? haversineMeters(fix, roadEnd) : Number.POSITIVE_INFINITY,
  );
  const slow =
    fix.speedMetersPerSecond === null || fix.speedMetersPerSecond <= NAV_ARRIVAL_SPEED_MS;

  if (metres > NAV_ARRIVAL_RADIUS_M || !slow) return { arrived: false, state: INITIAL_ARRIVAL };

  const since = state.since ?? fix.at;
  return { arrived: fix.at - since >= NAV_ARRIVAL_DWELL_MS, state: { since } };
}

/**
 * Which announcement to speak, given how far the turn is and what was said.
 *
 * Returns at most one distance, and only when the driver has just crossed it.
 * Speaking is otherwise driven by the fix rate, so a driver stopped at a light
 * 400 m from a turn would hear the same sentence once a second.
 *
 * `spoken` is the set of thresholds already used **for this step**; the caller
 * clears it when the step index changes. Crossing several thresholds at once --
 * which happens when a fix arrives after a signal gap -- speaks only the
 * nearest, because the far one is no longer true.
 */
export function announcementFor(
  metersToManeuver: number,
  spoken: ReadonlySet<number>,
): number | null {
  for (const threshold of [...NAV_ANNOUNCE_DISTANCES_M].sort((a, b) => a - b)) {
    if (metersToManeuver <= threshold && !spoken.has(threshold)) return threshold;
  }
  return null;
}

/**
 * Thins a path to what a small screen can actually show.
 *
 * A five-stop Houston day is several thousand points. Rebuilding SVG path data
 * for all of them on every fix drops the frame rate into single digits exactly
 * when the screen matters most -- approaching a turn. Ramer-Douglas-Peucker
 * with a tolerance in metres keeps every corner that is visible at the zoom
 * being drawn and discards the points that are not.
 *
 * Used for *drawing only*. Every measurement -- progress, distance to the
 * maneuver, off-route -- runs against the full-resolution path, because a
 * simplified line moves the road by the tolerance and that is the same order as
 * the off-route threshold.
 */
export function decimatePath(path: LatLngPath, toleranceMeters: number): LatLngPath {
  if (path.length <= 2 || toleranceMeters <= 0) return path;

  const keep = new Array<boolean>(path.length).fill(false);
  keep[0] = true;
  keep[path.length - 1] = true;

  const kx = 111_320 * Math.cos((path[0][0] * Math.PI) / 180);
  const ky = 110_540;
  const stack: [number, number][] = [[0, path.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    const ax = path[first][1] * kx;
    const ay = path[first][0] * ky;
    const bx = path[last][1] * kx;
    const by = path[last][0] * ky;
    const abx = bx - ax;
    const aby = by - ay;
    const lengthSquared = abx * abx + aby * aby;

    let worst = -1;
    let worstIndex = first;
    for (let index = first + 1; index < last; index += 1) {
      const px = path[index][1] * kx;
      const py = path[index][0] * ky;
      const t =
        lengthSquared === 0
          ? 0
          : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSquared));
      const distance = Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
      if (distance > worst) {
        worst = distance;
        worstIndex = index;
      }
    }

    if (worst > toleranceMeters) {
      keep[worstIndex] = true;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  return path.filter((_, index) => keep[index]);
}

/**
 * Cuts a whole day's line into one slice per stop, in order.
 *
 * This is what lets the chain be drawn -- the active leg bright, the later legs
 * dotted and numbered. The day route arrives as ONE polyline for the whole
 * drive with no leg boundaries in it, so the boundaries have to be found.
 *
 * **Not by walking the line looking for the closest approach to each stop.**
 * That is the obvious algorithm and it is wrong: distance from a fixed point
 * along a road is not unimodal. Every bend that momentarily points at the house
 * is a local minimum, so "cut at the first local minimum past the last cut"
 * cuts two streets early and hands the next leg a slice that starts behind the
 * driver. Each stop is projected onto the measured path instead, and the cut is
 * made at its `alongMeters` -- a single global answer per stop rather than a
 * walk that can stop early.
 *
 * The projections are forward-only, each starting from the last cut, for the
 * same reason `projectOntoMeasuredPath` is: a day that passes the same junction
 * twice would otherwise put stop 4's cut back at stop 1's.
 *
 * A stop whose nearest point on the line is further than `maxOffsetMeters` gets
 * an empty slice rather than a wrong one. That happens when the route was drawn
 * without it -- an unroutable address -- and a chain segment drawn to a house
 * the line never visits is worse than a gap the caller can label.
 */
export function splitPathAtStops(
  measured: MeasuredPath,
  stops: readonly { latitude: number; longitude: number }[],
  maxOffsetMeters = 200,
): readonly LatLngPath[] {
  if (measured.path.length < 2 || stops.length === 0) return stops.map(() => []);

  const cuts: number[] = [];
  let segment = 1;
  let previousAlong = 0;

  for (const stop of stops) {
    const position = projectOntoMeasuredPath(stop, measured, segment, 0);
    if (!position || position.offsetMeters > maxOffsetMeters) {
      cuts.push(Number.NaN);
      continue;
    }
    const along = Math.max(previousAlong, position.alongMeters);
    cuts.push(along);
    previousAlong = along;
    segment = position.segment;
  }

  const slices: LatLngPath[] = [];
  let startAlong = 0;

  for (const cut of cuts) {
    if (Number.isNaN(cut)) {
      slices.push([]);
      continue;
    }
    slices.push(slicePath(measured, startAlong, cut));
    startAlong = cut;
  }

  return slices;
}

/**
 * The part of a measured path between two distances along it.
 *
 * Both ends are interpolated exactly rather than snapped to the nearest shape
 * point, because on a motorway the next shape point can be hundreds of metres
 * away -- `splitRouteAtPosition` in `live-route.ts` makes the same choice, and
 * a chain whose legs visibly overlap or leave gaps at the stops looks like a
 * drawing fault rather than a rounding one.
 */
export function slicePath(
  measured: MeasuredPath,
  fromMeters: number,
  toMeters: number,
): LatLngPath {
  const { path, cumulative } = measured;
  if (path.length < 2 || toMeters <= fromMeters) return [];

  const pointAt = (meters: number): LatLng => {
    if (meters <= 0) return path[0];
    if (meters >= measured.totalMeters) return path[path.length - 1];
    let index = 1;
    while (index < path.length - 1 && cumulative[index] < meters) index += 1;
    const spanStart = cumulative[index - 1];
    const span = cumulative[index] - spanStart;
    const t = span === 0 ? 0 : (meters - spanStart) / span;
    const a = path[index - 1];
    const b = path[index];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  const between = path.filter(
    (_, index) => cumulative[index] > fromMeters && cumulative[index] < toMeters,
  );

  return [pointAt(fromMeters), ...between, pointAt(toMeters)];
}
