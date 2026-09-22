import {
  INITIAL_ARRIVAL,
  INITIAL_NAV_PROGRESS,
  NAV_ANNOUNCE_DISTANCES_M,
  NAV_ARRIVAL_RADIUS_M,
  advanceNavProgress,
  announcementFor,
  buildLegPath,
  checkArrival,
  haversineMeters,
  isUsableNavFix,
  type ArrivalState,
  type LegPath,
  type NavFix,
  type NavProgress,
  type NavProgressState,
  type NavigationLeg,
  type NavigationStep,
} from '@texasrenters/shared';

import { announcementSentence, type NavAnnouncement } from './announcer';

/**
 * The whole judgement of turn-by-turn navigation, as a pure reducer.
 *
 * No React, no network, no clock of its own: every decision is a function of
 * the day route, the leg being driven, one fix, and `now`. That is what makes a
 * complete simulated journey -- depart, turn, wander off, come back, arrive,
 * move to the next stop -- something `mobile/tests/nav-session.test.ts` can
 * drive in a few milliseconds without a device, a network, or a map. The screen
 * is a renderer over this; it decides nothing.
 *
 * The arithmetic itself is not here. `shared/src/contracts/nav-progress.ts`
 * owns where the driver is on the line, whether they have arrived, and which
 * announcement is due, because the console and the backend have to agree with
 * the phone about all three. This owns the *session*: which stop is being
 * driven to, what happens when the line no longer describes the drive, and what
 * happens after arriving.
 *
 * **Every coordinate is `[latitude, longitude]`.** Texas is latitude ~29-30
 * (positive) and longitude ~-95 (negative). An axis swap here does not throw --
 * it draws a plausible drive in the Indian Ocean -- so the tests assert the
 * sign of each value rather than its position.
 */

/**
 * Where a session is.
 *
 * - `IDLE` -- nothing running, or the day is finished.
 * - `DRIVING` -- on the line, following it.
 * - `OFF_ROUTE` -- the line no longer describes the drive, and we have just
 *   said so.
 * - `REROUTING` -- still off the line, with a new one asked for and not yet
 *   here.
 * - `ARRIVED` -- at the target stop, counting down before moving on.
 * - `ADVANCING` -- the chain has moved to the next stop and its drive has been
 *   asked for.
 * - `NO_ROUTE` -- navigation is refusing, and `blocked` says why.
 */
export type NavPhase =
  | 'IDLE'
  | 'DRIVING'
  | 'OFF_ROUTE'
  | 'REROUTING'
  | 'ARRIVED'
  | 'ADVANCING'
  | 'NO_ROUTE';

/**
 * Why navigation will not start.
 *
 * `ORIGIN_OUTSIDE_SERVICE_AREA` is the one that matters most and is the least
 * obvious. OSRM does not refuse a coordinate it cannot place: given a position
 * in the Philippines it snapped to the nearest road in its Texas extract and
 * answered a plausible four-hour drive. Navigating that would put a technician
 * on a motorway at the wrong end of a continent with a voice telling them to
 * bear right. A refusal that says so is the only safe answer.
 *
 * `NO_ROUTED_STOPS` is the same class of fault seen from the other side: the
 * planner returns `stops` even for a day it could not route, so a chain built
 * from `stops` would draw a numbered order for a route that does not exist. The
 * chain here is built from `legs` for exactly that reason.
 */
export type NavBlockReason =
  | 'NO_DAY_ROUTE'
  | 'ORIGIN_OUTSIDE_SERVICE_AREA'
  | 'NO_ROUTED_STOPS'
  | 'STOP_NOT_ROUTABLE';

/**
 * The part of `TechnicianRoute` navigation reads.
 *
 * Structural rather than the contract type itself, and every field the phone's
 * zod schema currently strips is optional, so this accepts both the full
 * `TechnicianRoute` the backend sends and the narrower object
 * `technician-route-schema.ts` parses today. An optional field that arrives as
 * `undefined` means *unknown*, never *false* -- see `blockedBecause`, which
 * only refuses on an explicit `true`.
 */
export interface NavDayStop {
  inspectionId: string;
  propertyName: string;
  latitude: number;
  longitude: number;
}

export interface NavDayRoute {
  stops: readonly NavDayStop[];
  legs: readonly { fromStopId: string | null; toStopId: string }[];
  originOutsideServiceArea?: boolean;
  unroutable?: readonly { inspectionId: string }[];
}

/**
 * The least time between two reroute requests.
 *
 * **The backend has no throttle of its own.** The console's 15-second spacing
 * lives in `web/app/(admin)/map/page.tsx` and protects nothing but the console;
 * a handset asking on every fix would ask twenty times a minute, at the dearer
 * per-leg tier of the Routes API, for as long as somebody drove down a road we
 * had not drawn. So the phone protects the budget itself.
 *
 * Twenty seconds rather than the console's fifteen, because the first request
 * is not throttled at all -- it goes the instant `NAV_OFF_ROUTE_FIXES` latches,
 * which is the reroute that matters. This spacing only bounds the retries after
 * it, and a driver who is still off the line twenty seconds later has genuinely
 * gone somewhere else.
 */
export const NAV_REROUTE_MIN_SPACING_MS = 20_000;

/**
 * How long a failed or unanswered leg request waits before being asked again.
 *
 * Shorter than a reroute because there is nothing on screen to drive by until
 * it answers, and a technician staring at "Finding the route" is stopped.
 */
export const NAV_LEG_RETRY_MS = 10_000;

/**
 * How long "Arrived" stands before the chain moves to the next stop.
 *
 * Derived from `arrivedAt` and compared against `now` on every tick -- never a
 * `setInterval`. Android stops JavaScript timers the moment the app leaves the
 * screen, and a countdown built on one would freeze in a technician's pocket
 * and then fire late; this one is simply true or not true whenever it is next
 * asked, whether that is a fix, a foregrounding, or a render.
 *
 * Fifteen seconds is long enough to read the property name and press "Stay
 * here", and short enough that a technician who has parked and is walking to
 * the door does not have to touch the phone at all.
 */
export const NAV_ADVANCE_COUNTDOWN_MS = 15_000;

/** After this long with no usable fix, the screen says the signal is poor. */
export const NAV_SIGNAL_LOST_MS = 20_000;

export interface NavSessionState {
  phase: NavPhase;
  blocked: NavBlockReason | null;
  /** The stops still to drive, in order, starting with the target. */
  chain: readonly string[];
  /** The stop being driven to. `inspectionId`, never a bare `id` -- see below. */
  targetStopId: string | null;
  /**
   * Which leg the progress below belongs to: its stop and when it was drawn.
   *
   * A reroute answers with a leg to the same stop, so the stop alone cannot
   * tell a fresh line from the one being driven. Progress measured against the
   * old line and applied to the new one puts the driver most of a leg along a
   * road they have not started.
   */
  legKey: string | null;
  progress: NavProgressState;
  lastProgress: NavProgress | null;
  arrival: ArrivalState;
  /** The nearest stop that is *not* the target, while dwelling at one. */
  nearbyStopId: string | null;
  nearbyArrival: ArrivalState;
  /** A stop arrived at that the chain was not heading for. */
  unplannedArrivalStopId: string | null;
  spokenStepIndex: number;
  spokenThresholds: readonly number[];
  rerouteAskedAt: number | null;
  legAskedAt: number | null;
  /** Wall clock, so the countdown after it can be compared against `now`. */
  arrivedAt: number | null;
  /** When a fix last reached navigation. Wall clock, not the device stamp. */
  lastFixAt: number | null;
  signalPoor: boolean;
  /**
   * The last heading worth believing, held rather than cleared.
   *
   * `normaliseNavFix` drops the course of any fix under `NAV_MOVING_SPEED_MS`,
   * because GPS jitter alone gives a parked phone a low speed in a random
   * direction. Clearing the heading on those fixes would spin a course-up map
   * on the spot at every red light, so the last moving heading is held until
   * there is a new one.
   */
  headingDegrees: number | null;
}

/**
 * What the session asks the outside world to do.
 *
 * Returned rather than performed, so the reducer stays synchronous and the test
 * can assert that a reroute was asked for exactly once without a network in
 * sight. `useNavigationSession` is the only thing that carries them out.
 *
 * Note that nothing here carries a field called `id`. `reconcileMobileState` in
 * `TexasRentersProviders.tsx` treats any `{ id: string }` as a revisioned
 * entity and will merge it back into cached state -- which for a navigation
 * object means resurrecting a stop the server has since removed from the day.
 * Everything is `...StopId`.
 */
export type NavEffect =
  | {
      kind: 'FETCH_LEG';
      toStopId: string;
      /** Where to draw from, `[latitude, longitude]`, or null to let the server use the last reported position. */
      from: readonly [number, number] | null;
      reason: 'START' | 'REROUTE' | 'NEXT_STOP';
    }
  | { kind: 'ANNOUNCE'; announcement: NavAnnouncement }
  | { kind: 'ARRIVED'; toStopId: string }
  | { kind: 'ARRIVED_OFF_PLAN'; toStopId: string }
  | { kind: 'DAY_COMPLETE' };

/** Everything the screen draws, and nothing it has to work out for itself. */
export interface NavSessionView {
  phase: NavPhase;
  blocked: NavBlockReason | null;
  targetStopId: string | null;
  targetStop: NavDayStop | null;
  /** The instruction being driven, or null before the leg has arrived. */
  step: NavigationStep | null;
  /** The one after it, for the "then" line under the banner. */
  nextStep: NavigationStep | null;
  stepIndex: number;
  metersToManeuver: number;
  metersRemaining: number;
  secondsRemaining: number;
  /** Epoch milliseconds, for the arrival clock. Null before the leg arrives. */
  arrivalEpochMs: number | null;
  /** The fix pulled onto the line, `[latitude, longitude]`. Null while off it. */
  snapped: readonly [number, number] | null;
  headingDegrees: number | null;
  /** How far off the drawn line the last fix was. Null before the first one. */
  offsetMeters: number | null;
  signalPoor: boolean;
  stopsRemaining: number;
  /** A stop arrived at that was not the target, for the screen to offer. */
  unplannedArrivalStopId: string | null;
  /** When the chain moves on by itself. Null unless `phase` is `ARRIVED`. */
  advanceAtEpochMs: number | null;
  dayComplete: boolean;
}

export interface NavSessionInput {
  dayRoute: NavDayRoute | null;
  /** The drive to the target. Ignored when it is for some other stop. */
  leg: NavigationLeg | null;
  fix: NavFix | null;
  now: number;
}

export interface NavSessionStep {
  state: NavSessionState;
  view: NavSessionView;
  effects: readonly NavEffect[];
}

export const INITIAL_NAV_SESSION: NavSessionState = {
  phase: 'IDLE',
  blocked: null,
  chain: [],
  targetStopId: null,
  legKey: null,
  progress: INITIAL_NAV_PROGRESS,
  lastProgress: null,
  arrival: INITIAL_ARRIVAL,
  nearbyStopId: null,
  nearbyArrival: INITIAL_ARRIVAL,
  unplannedArrivalStopId: null,
  spokenStepIndex: -1,
  spokenThresholds: [],
  rerouteAskedAt: null,
  legAskedAt: null,
  arrivedAt: null,
  lastFixAt: null,
  signalPoor: false,
  headingDegrees: null,
};

/**
 * The day's driving order, taken from `legs` and never from `stops`.
 *
 * `RouteService.planDay` returns every stop it was given, including the ones it
 * could not route to -- a property that never geocoded is in `stops` and in
 * `unroutable` at the same time. A chain built from `stops` would therefore
 * hand the technician an ordinal for a stop no route exists to, and the first
 * thing navigation would do with it is ask for a leg that cannot be drawn.
 * `legs` is the planner's actual answer.
 */
export function chainFromLegs(route: NavDayRoute | null): readonly string[] {
  if (!route) return [];
  const known = new Set(route.stops.map((stop) => stop.inspectionId));
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const leg of route.legs) {
    if (!known.has(leg.toStopId) || seen.has(leg.toStopId)) continue;
    seen.add(leg.toStopId);
    chain.push(leg.toStopId);
  }
  return chain;
}

/**
 * Begins a session, optionally at a stop other than the first.
 *
 * Runs one tick straight away rather than returning a bare state, so the
 * refusals below are applied before anything is shown and the first leg request
 * comes back in the same call.
 */
export function startNavSession(
  dayRoute: NavDayRoute | null,
  options: { now: number; fix?: NavFix | null; toStopId?: string | null },
): NavSessionStep {
  const chain = chainFromLegs(dayRoute);
  const wanted = options.toStopId ?? null;
  const from = wanted !== null && chain.includes(wanted) ? chain.indexOf(wanted) : 0;
  const remaining = chain.slice(from);
  const target = remaining[0] ?? null;

  /**
   * No target is two different facts, and they must not look alike.
   *
   * A day with nothing left in it is finished, which is `IDLE`. A day whose
   * route never arrived, or which the planner could not route at all, is a
   * refusal -- and starting that as `IDLE` would tell a technician with five
   * jobs waiting that their day was over. `NO_ROUTE` sends it into
   * `blockedBecause` below, which says which of the two it is.
   */
  const emptyDay = dayRoute !== null && dayRoute.stops.length === 0;

  return advanceNavSession(
    {
      ...INITIAL_NAV_SESSION,
      chain: remaining,
      targetStopId: target,
      phase: target !== null ? 'DRIVING' : emptyDay ? 'IDLE' : 'NO_ROUTE',
    },
    { dayRoute, leg: null, fix: options.fix ?? null, now: options.now },
  );
}

/** Ends a session. The screen stops; the shift's own recording is untouched. */
export function stopNavSession(dayRoute: NavDayRoute | null, now: number): NavSessionStep {
  return {
    state: INITIAL_NAV_SESSION,
    view: viewOf(INITIAL_NAV_SESSION, dayRoute, null, null, now),
    effects: [],
  };
}

/**
 * Moves the chain on without waiting for the countdown.
 *
 * The "Next stop" button, and the same path the countdown takes, so a technician
 * who presses it gets exactly what waiting would have given them.
 */
export function skipToNextStop(state: NavSessionState, input: NavSessionInput): NavSessionStep {
  const effects: NavEffect[] = [];
  const moved = moveToNextStop(state, input, effects);
  return advanceInto(moved, input, effects);
}

/**
 * Folds one fix -- or just the clock -- into the session.
 *
 * `fix` may be null. The countdown after an arrival, the leg retry and the
 * poor-signal notice all have to keep working on a parked phone, which earns no
 * new fixes at all: `shift-tracking.ts` asks for one every three seconds *or*
 * every ten metres, and a stationary handset satisfies neither. So the caller
 * ticks this with the clock alone when nothing has moved.
 */
export function advanceNavSession(
  state: NavSessionState,
  input: NavSessionInput,
): NavSessionStep {
  const effects: NavEffect[] = [];
  return advanceInto(state, input, effects);
}

function advanceInto(
  state: NavSessionState,
  input: NavSessionInput,
  effects: NavEffect[],
): NavSessionStep {
  const { dayRoute, fix, now } = input;
  let next: NavSessionState = { ...state };

  // Re-checked every tick rather than once at the start: a day route refetched
  // mid-drive can lose a stop, or start reporting an origin we must refuse.
  const blocked = blockedBecause(dayRoute, next.targetStopId, next.phase);
  if (blocked) {
    next = { ...next, phase: 'NO_ROUTE', blocked };
    return { state: next, view: viewOf(next, dayRoute, null, null, now), effects };
  }
  if (next.phase === 'NO_ROUTE') {
    // Whatever was wrong has been put right -- usually a refetched route.
    next = { ...next, phase: next.targetStopId === null ? 'IDLE' : 'DRIVING', blocked: null };
  }

  // A leg for some other stop is a leg that has not arrived yet: the reroute or
  // the next-stop request is still in flight and this is the one it replaces.
  // Measuring against it would count progress along a road nobody is on.
  const leg =
    input.leg && next.targetStopId !== null && input.leg.toStopId === next.targetStopId
      ? input.leg
      : null;

  if (next.phase === 'IDLE') {
    return { state: next, view: viewOf(next, dayRoute, leg, null, now), effects };
  }

  if (fix !== null) {
    next = {
      // `now`, not `fix.at`: this is when a fix last *reached* navigation, and
      // it is compared against `now` to decide whether the signal has gone. A
      // fix carrying an old device timestamp has still just arrived.
      ...next,
      lastFixAt: now,
      signalPoor: !isUsableNavFix(fix),
      headingDegrees: fix.headingDegrees ?? next.headingDegrees,
    };
  }

  const usable = fix !== null && isUsableNavFix(fix);
  let progress: NavProgress | null = next.lastProgress;

  if (leg) {
    const key = legKeyOf(leg);
    if (key !== next.legKey) {
      next = onFreshLeg(next, key);
      progress = null;
    }

    if (usable && fix) {
      const folded = advanceNavProgress(legPathFor(leg), fix, next.progress);
      progress = folded.progress;
      next = { ...next, progress: folded.state, lastProgress: folded.progress };
      next = handleOffRoute(next, folded.progress, fix, now, effects);
      next = speakIfDue(next, leg, folded.progress, dayRoute, effects);
    }
  }

  if (fix !== null) {
    next = checkArrivals(next, dayRoute, fix, now, effects);
  }

  // Timestamp arithmetic, so it is as true on a fix as it is on a render as it
  // is on the first foregrounding after the phone was in a pocket.
  if (
    next.phase === 'ARRIVED' &&
    next.arrivedAt !== null &&
    now - next.arrivedAt >= NAV_ADVANCE_COUNTDOWN_MS
  ) {
    next = moveToNextStop(next, input, effects);
  }

  next = askForLegIfMissing(next, leg, fix, now, effects);

  return { state: next, view: viewOf(next, dayRoute, leg, progress, now), effects };
}

function blockedBecause(
  route: NavDayRoute | null,
  targetStopId: string | null,
  phase: NavPhase,
): NavBlockReason | null {
  if (phase === 'IDLE') return null;
  if (!route) return 'NO_DAY_ROUTE';
  // Only an explicit `true`. The phone's route schema strips this field today,
  // so it arrives as `undefined` -- which is "nobody said", not "all is well",
  // and refusing on it would refuse every route on this bundle.
  if (route.originOutsideServiceArea === true) return 'ORIGIN_OUTSIDE_SERVICE_AREA';
  // Stops the planner returned but produced no drivable chain for. Either it
  // routed nothing, or every leg names a stop that is not in `stops` -- both of
  // which would otherwise read on screen as a finished day.
  if (targetStopId === null) return route.stops.length > 0 ? 'NO_ROUTED_STOPS' : null;
  if (route.unroutable?.some((entry) => entry.inspectionId === targetStopId))
    return 'STOP_NOT_ROUTABLE';
  if (!route.stops.some((stop) => stop.inspectionId === targetStopId)) return 'STOP_NOT_ROUTABLE';
  return null;
}

/** A new line to drive: everything measured against the old one is discarded. */
function onFreshLeg(state: NavSessionState, legKey: string): NavSessionState {
  return {
    ...state,
    legKey,
    progress: INITIAL_NAV_PROGRESS,
    lastProgress: null,
    spokenStepIndex: -1,
    spokenThresholds: [],
    rerouteAskedAt: null,
    legAskedAt: null,
    phase:
      state.phase === 'OFF_ROUTE' || state.phase === 'REROUTING' || state.phase === 'ADVANCING'
        ? 'DRIVING'
        : state.phase,
  };
}

/**
 * Off the line, and what to do about it.
 *
 * The phase goes `OFF_ROUTE` on the fix that latches it and `REROUTING` only on
 * a later fix, once the request has actually been in flight for a beat. That
 * ordering is on purpose: the driver should be told they are off the route the
 * instant we know, and a phase that flickers through `REROUTING` for a single
 * frame and back tells them nothing. `shared`'s `advanceNavProgress` has
 * already done the counting -- one fix beyond the threshold is an overpass, and
 * `NAV_OFF_ROUTE_FIXES` in a row is a wrong turn.
 */
function handleOffRoute(
  state: NavSessionState,
  progress: NavProgress,
  fix: NavFix,
  now: number,
  effects: NavEffect[],
): NavSessionState {
  if (!progress.offRoute) {
    if (state.phase === 'OFF_ROUTE' || state.phase === 'REROUTING') {
      // Back on the line under their own steam. A reroute already asked for may
      // still arrive; it will simply replace a line they are on.
      return { ...state, phase: 'DRIVING', rerouteAskedAt: null };
    }
    return state;
  }

  if (state.phase === 'ARRIVED' || state.phase === 'ADVANCING') return state;

  const mayAsk =
    state.rerouteAskedAt === null || now - state.rerouteAskedAt >= NAV_REROUTE_MIN_SPACING_MS;

  if (mayAsk && state.targetStopId !== null) {
    effects.push({
      kind: 'FETCH_LEG',
      toStopId: state.targetStopId,
      from: [fix.latitude, fix.longitude],
      reason: 'REROUTE',
    });
    return { ...state, phase: 'OFF_ROUTE', rerouteAskedAt: now };
  }

  return { ...state, phase: 'REROUTING' };
}

/**
 * The one announcement that is due, if any.
 *
 * Only while `DRIVING`: reading out a turn from a line the driver has left is
 * worse than silence, because it is confidently wrong.
 *
 * **Every threshold at or beyond the one that fires is marked as used, not just
 * the one spoken.** `announcementFor` returns the nearest unspoken threshold at
 * or under the remaining distance, so a driver who comes out of a tunnel 350 m
 * from a turn hears "In a quarter of a mile" -- correct -- and then, on the very
 * next fix at 340 m, would hear "In one mile", because 1600 is still unspoken
 * and 340 is under it. The far announcement stopped being true the moment the
 * near one fired.
 */
function speakIfDue(
  state: NavSessionState,
  leg: NavigationLeg,
  progress: NavProgress,
  route: NavDayRoute | null,
  effects: NavEffect[],
): NavSessionState {
  if (state.phase !== 'DRIVING' || progress.offRoute) return state;

  let next = state;
  if (progress.stepIndex !== next.spokenStepIndex) {
    /**
     * A step shorter than a threshold never gets that announcement.
     *
     * `announcementFor` fires any threshold the remaining distance is under,
     * and it does not know how long the step is. On a 300-metre step that means
     * "In one mile, turn left" spoken the instant the step becomes current --
     * every threshold above the step's own length is already true before the
     * driver has moved. Marking those as used at the boundary is the caller's
     * job, which is exactly what `spoken` is for.
     */
    const stepLength = leg.steps[progress.stepIndex]?.distanceMeters ?? 0;
    next = {
      ...next,
      spokenStepIndex: progress.stepIndex,
      spokenThresholds: NAV_ANNOUNCE_DISTANCES_M.filter((distance) => distance >= stepLength),
    };
  }

  const threshold = announcementFor(progress.metersToManeuver, new Set(next.spokenThresholds));
  if (threshold === null) return next;

  const used = new Set(next.spokenThresholds);
  for (const distance of NAV_ANNOUNCE_DISTANCES_M) if (distance >= threshold) used.add(distance);

  const step = leg.steps[progress.stepIndex];
  if (step) {
    effects.push({
      kind: 'ANNOUNCE',
      announcement: {
        thresholdMeters: threshold,
        stepIndex: progress.stepIndex,
        sentence: announcementSentence(
          step,
          threshold,
          stopById(route, state.targetStopId)?.propertyName ?? null,
        ),
      },
    });
  }

  return { ...next, spokenThresholds: [...used] };
}

/**
 * Arrival, at the stop being driven to and at any other.
 *
 * Both tests come from `checkArrival`: inside the radius, under walking pace,
 * for `NAV_ARRIVAL_DWELL_MS`. Driving past a stop at speed is not an arrival,
 * which is the whole reason speed is in there -- Houston residential stops sit
 * forty metres apart and a van doing forty past the next house is within the
 * radius of it for several seconds.
 *
 * Arriving somewhere that is *not* the target is reported rather than acted on.
 * A technician who stops at the wrong house, or takes a job out of order, has
 * done something the office may want to know about; silently advancing the
 * chain to it would rewrite the day from the passenger seat.
 */
function checkArrivals(
  state: NavSessionState,
  route: NavDayRoute | null,
  fix: NavFix,
  /**
   * The tick's clock, which is what `arrivedAt` is stamped with.
   *
   * Not `fix.at`. The dwell test inside `checkArrival` compares fix timestamps
   * against each other, which is right; the countdown afterwards compares
   * `arrivedAt` against `now`, and `now` is the wall clock. A fix delivered in
   * a batch after a signal gap carries a timestamp minutes old, and stamping
   * the arrival with it would hand the technician a countdown that had already
   * run out -- the chain would move to the next stop as they opened the door.
   */
  now: number,
  effects: NavEffect[],
): NavSessionState {
  let next = state;

  const target = stopById(route, next.targetStopId);
  if (target) {
    const outcome = checkArrival(fix, target, next.arrival);
    next = { ...next, arrival: outcome.state };
    if (outcome.arrived && next.phase !== 'ARRIVED' && next.phase !== 'ADVANCING') {
      effects.push({ kind: 'ARRIVED', toStopId: target.inspectionId });
      next = { ...next, phase: 'ARRIVED', arrivedAt: now };
    }
  }

  const nearby = nearestOtherStop(route, next.chain, next.targetStopId, fix);
  if (nearby?.inspectionId !== next.nearbyStopId) {
    next = {
      ...next,
      nearbyStopId: nearby?.inspectionId ?? null,
      nearbyArrival: INITIAL_ARRIVAL,
      unplannedArrivalStopId: null,
    };
  }
  if (nearby) {
    const outcome = checkArrival(fix, nearby, next.nearbyArrival);
    next = { ...next, nearbyArrival: outcome.state };
    if (outcome.arrived && next.unplannedArrivalStopId !== nearby.inspectionId) {
      effects.push({ kind: 'ARRIVED_OFF_PLAN', toStopId: nearby.inspectionId });
      next = { ...next, unplannedArrivalStopId: nearby.inspectionId };
    }
  }

  return next;
}

function moveToNextStop(
  state: NavSessionState,
  input: NavSessionInput,
  effects: NavEffect[],
): NavSessionState {
  const chain = state.chain.filter((stopId) => stopId !== state.targetStopId);
  const target = chain[0] ?? null;

  const moved: NavSessionState = {
    ...INITIAL_NAV_SESSION,
    chain,
    targetStopId: target,
    lastFixAt: state.lastFixAt,
    signalPoor: state.signalPoor,
    headingDegrees: state.headingDegrees,
    phase: target === null ? 'IDLE' : 'ADVANCING',
  };

  if (target === null) {
    effects.push({ kind: 'DAY_COMPLETE' });
    return moved;
  }

  effects.push({
    kind: 'FETCH_LEG',
    toStopId: target,
    from: input.fix ? [input.fix.latitude, input.fix.longitude] : null,
    reason: 'NEXT_STOP',
  });
  return { ...moved, legAskedAt: input.now };
}

/**
 * Asks for the drive when there is none, and keeps asking until there is.
 *
 * Throttled by `NAV_LEG_RETRY_MS` rather than fired on every fix: a stop the
 * router cannot draw would otherwise be asked for once every three seconds for
 * as long as the screen was open.
 */
function askForLegIfMissing(
  state: NavSessionState,
  leg: NavigationLeg | null,
  fix: NavFix | null,
  now: number,
  effects: NavEffect[],
): NavSessionState {
  if (leg) return state.legAskedAt === null ? state : { ...state, legAskedAt: null };
  if (state.targetStopId === null) return state;
  if (state.phase !== 'DRIVING' && state.phase !== 'ADVANCING') return state;
  if (state.legAskedAt !== null && now - state.legAskedAt < NAV_LEG_RETRY_MS) return state;

  effects.push({
    kind: 'FETCH_LEG',
    toStopId: state.targetStopId,
    from: fix ? [fix.latitude, fix.longitude] : null,
    reason: state.phase === 'ADVANCING' ? 'NEXT_STOP' : 'START',
  });
  return { ...state, legAskedAt: now };
}

function viewOf(
  state: NavSessionState,
  route: NavDayRoute | null,
  leg: NavigationLeg | null,
  progress: NavProgress | null,
  now: number,
): NavSessionView {
  const target = stopById(route, state.targetStopId);
  const stepIndex = progress?.stepIndex ?? state.progress.stepIndex;
  const step = leg?.steps[stepIndex] ?? null;
  const nextStep = leg?.steps[stepIndex + 1] ?? null;

  const measured = leg ? legPathFor(leg).measured.totalMeters : 0;
  const metersRemaining = progress
    ? progress.metersRemaining
    : (leg?.distanceMeters ?? 0);

  /**
   * The remaining seconds, pro-rated by the remaining distance.
   *
   * The router gives one duration for the whole leg and will not price a
   * partial one without being asked again, so this is the only honest figure
   * available between reroutes. The denominator is the measured polyline rather
   * than `leg.distanceMeters` because the numerator is measured off the same
   * geometry -- the router's own distance and its polyline never quite agree,
   * and mixing them makes the ETA drift by a few per cent at every step.
   */
  const fraction = measured > 0 ? Math.min(1, Math.max(0, metersRemaining / measured)) : 1;
  const secondsRemaining = leg ? leg.durationSeconds * (progress ? fraction : 1) : 0;

  const signalPoor =
    state.signalPoor ||
    (state.phase !== 'IDLE' &&
      state.lastFixAt !== null &&
      now - state.lastFixAt > NAV_SIGNAL_LOST_MS);

  return {
    phase: state.phase,
    blocked: state.blocked,
    targetStopId: state.targetStopId,
    targetStop: target,
    step,
    nextStep,
    stepIndex,
    metersToManeuver: progress?.metersToManeuver ?? step?.distanceMeters ?? 0,
    metersRemaining,
    secondsRemaining,
    arrivalEpochMs: leg ? now + secondsRemaining * 1_000 : null,
    snapped: progress?.snapped ?? null,
    headingDegrees: state.headingDegrees,
    offsetMeters: progress?.offsetMeters ?? null,
    signalPoor,
    stopsRemaining: state.chain.length,
    unplannedArrivalStopId: state.unplannedArrivalStopId,
    advanceAtEpochMs:
      state.phase === 'ARRIVED' && state.arrivedAt !== null
        ? state.arrivedAt + NAV_ADVANCE_COUNTDOWN_MS
        : null,
    dayComplete: state.phase === 'IDLE' && state.targetStopId === null && state.chain.length === 0,
  };
}

function stopById(route: NavDayRoute | null, stopId: string | null): NavDayStop | null {
  if (!route || stopId === null) return null;
  return route.stops.find((stop) => stop.inspectionId === stopId) ?? null;
}

/** The nearest stop still to come that is not the one being driven to. */
function nearestOtherStop(
  route: NavDayRoute | null,
  chain: readonly string[],
  targetStopId: string | null,
  fix: NavFix,
): NavDayStop | null {
  if (!route) return null;
  let best: NavDayStop | null = null;
  let bestMeters = NAV_ARRIVAL_RADIUS_M;

  for (const stopId of chain) {
    if (stopId === targetStopId) continue;
    const stop = stopById(route, stopId);
    if (!stop) continue;
    const metres = haversineMeters(fix, stop);
    if (metres <= bestMeters) {
      best = stop;
      bestMeters = metres;
    }
  }

  return best;
}

/**
 * The leg's steps laid end to end, measured once per leg.
 *
 * `buildLegPath` walks every point of every step; at a fix every three seconds
 * over a leg of several hundred points that is work done four hundred times an
 * hour for an answer that cannot change. Keyed on the leg object itself, so a
 * replaced leg is measured again and the old measurement is collected with it
 * -- there is no cache to invalidate and nothing to go stale.
 */
const legPaths = new WeakMap<NavigationLeg, LegPath>();

export function legPathFor(leg: NavigationLeg): LegPath {
  const cached = legPaths.get(leg);
  if (cached) return cached;
  const built = buildLegPath(leg.steps);
  legPaths.set(leg, built);
  return built;
}

function legKeyOf(leg: NavigationLeg): string {
  return `${leg.toStopId}@${leg.drawnAt}`;
}
