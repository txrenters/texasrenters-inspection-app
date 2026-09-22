/**
 * Turn-by-turn navigation: the vocabulary, and the thresholds it is judged by.
 *
 * The day route in `route-plan.ts` answers "where am I going and in what
 * order". This answers "which way do I turn, and when" -- a different question,
 * bought from a different (dearer) tier of Google's Routes API, and only ever
 * for the one leg being driven.
 *
 * ## Why one leg, and not the day
 *
 * `RouteService.planDay` draws the whole day in a single `computeRoutes` call.
 * Asking that call for `routes.legs.steps` would return steps for *every* leg:
 * a ten-stop Houston day is several hundred steps, each with its own encoded
 * polyline, and it would be re-fetched on every redraw of a route the
 * technician is nowhere near yet. Navigation asks for the active leg alone,
 * when it is actually being driven.
 *
 * ## The axis convention, stated once
 *
 * **Every coordinate in this file is `[latitude, longitude]`**, the same as
 * `TechnicianRoute.geometry`. Google's polylines decode latitude-first and
 * `decodePolyline` deliberately emits `[lon, lat]`, so `toLatLngPath` flips
 * once at the edge and nothing downstream flips again. Getting this wrong does
 * not fail loudly -- it draws a perfectly plausible route in the Indian Ocean
 * while every individual component looks correct. Tests assert the *sign* of
 * each value, never its position.
 */

/**
 * What the driver has to do at a step, reduced to the set worth drawing.
 *
 * Neither router's vocabulary survives contact with the other. Google gives a
 * flat enum (`TURN_SLIGHT_LEFT`, `ROUNDABOUT_RIGHT`, `FERRY_TRAIN`...); OSRM
 * gives a `type` plus a `modifier` that have to be read together (`turn` +
 * `slight left`). Mapping either one straight through would put the router's
 * name in front of the technician and leave the other router's steps unlabelled.
 *
 * So both are normalised onto this, which is deliberately *smaller* than
 * either: a maneuver only earns a member if it needs its own arrow. Anything
 * unrecognised becomes `CONTINUE`, which draws a straight arrow and reads the
 * router's own instruction text -- wrong-looking is better than absent, and the
 * instruction string is always right even when the enum is not.
 */
export type NavManeuver =
  | 'DEPART'
  | 'CONTINUE'
  | 'TURN_SLIGHT_LEFT'
  | 'TURN_LEFT'
  | 'TURN_SHARP_LEFT'
  | 'TURN_SLIGHT_RIGHT'
  | 'TURN_RIGHT'
  | 'TURN_SHARP_RIGHT'
  | 'UTURN_LEFT'
  | 'UTURN_RIGHT'
  | 'RAMP_LEFT'
  | 'RAMP_RIGHT'
  | 'MERGE'
  | 'FORK_LEFT'
  | 'FORK_RIGHT'
  | 'ROUNDABOUT_LEFT'
  | 'ROUNDABOUT_RIGHT'
  | 'FERRY'
  | 'ARRIVE';

/** Every member, for exhaustiveness checks and for icon tables. */
export const NAV_MANEUVERS: readonly NavManeuver[] = [
  'DEPART',
  'CONTINUE',
  'TURN_SLIGHT_LEFT',
  'TURN_LEFT',
  'TURN_SHARP_LEFT',
  'TURN_SLIGHT_RIGHT',
  'TURN_RIGHT',
  'TURN_SHARP_RIGHT',
  'UTURN_LEFT',
  'UTURN_RIGHT',
  'RAMP_LEFT',
  'RAMP_RIGHT',
  'MERGE',
  'FORK_LEFT',
  'FORK_RIGHT',
  'ROUNDABOUT_LEFT',
  'ROUNDABOUT_RIGHT',
  'FERRY',
  'ARRIVE',
] as const;

const GOOGLE_MANEUVERS: Readonly<Record<string, NavManeuver>> = {
  DEPART: 'DEPART',
  STRAIGHT: 'CONTINUE',
  NAME_CHANGE: 'CONTINUE',
  TURN_SLIGHT_LEFT: 'TURN_SLIGHT_LEFT',
  TURN_LEFT: 'TURN_LEFT',
  TURN_SHARP_LEFT: 'TURN_SHARP_LEFT',
  TURN_SLIGHT_RIGHT: 'TURN_SLIGHT_RIGHT',
  TURN_RIGHT: 'TURN_RIGHT',
  TURN_SHARP_RIGHT: 'TURN_SHARP_RIGHT',
  UTURN_LEFT: 'UTURN_LEFT',
  UTURN_RIGHT: 'UTURN_RIGHT',
  RAMP_LEFT: 'RAMP_LEFT',
  RAMP_RIGHT: 'RAMP_RIGHT',
  MERGE: 'MERGE',
  FORK_LEFT: 'FORK_LEFT',
  FORK_RIGHT: 'FORK_RIGHT',
  ROUNDABOUT_LEFT: 'ROUNDABOUT_LEFT',
  ROUNDABOUT_RIGHT: 'ROUNDABOUT_RIGHT',
  FERRY: 'FERRY',
  FERRY_TRAIN: 'FERRY',
};

/**
 * Google's `navigationInstruction.maneuver`, normalised.
 *
 * **Google has no arrival maneuver.** Its enum stops at `NAME_CHANGE`; the last
 * step of a leg carries text like "Destination will be on the right" and leaves
 * `maneuver` unset entirely. Mapped naively that makes the final instruction of
 * every drive an unknown one -- the single step the technician most needs drawn
 * correctly. The caller therefore passes `isLast`, and the arrival is
 * synthesised here rather than guessed at three call sites.
 */
export function maneuverFromGoogle(value: unknown, isLast: boolean): NavManeuver {
  if (isLast) return 'ARRIVE';
  if (typeof value !== 'string') return 'CONTINUE';
  return GOOGLE_MANEUVERS[value] ?? 'CONTINUE';
}

const OSRM_MODIFIERS: Readonly<Record<string, string>> = {
  'sharp left': 'SHARP_LEFT',
  'slight left': 'SLIGHT_LEFT',
  left: 'LEFT',
  'sharp right': 'SHARP_RIGHT',
  'slight right': 'SLIGHT_RIGHT',
  right: 'RIGHT',
  straight: 'STRAIGHT',
  uturn: 'UTURN',
};

/**
 * OSRM's `maneuver.type` + `maneuver.modifier`, normalised.
 *
 * OSRM is the fallback router and is **not configured in production** -- see
 * `routing-runs-on-google-not-osrm`. This exists so that a deployment which
 * does run OSRM produces the same enum rather than a second vocabulary nobody
 * drew icons for, not because it is the path normally taken.
 */
export function maneuverFromOsrm(type: unknown, modifier: unknown): NavManeuver {
  if (typeof type !== 'string') return 'CONTINUE';
  if (type === 'arrive') return 'ARRIVE';
  if (type === 'depart') return 'DEPART';
  if (type === 'merge') return 'MERGE';

  const side = OSRM_MODIFIERS[typeof modifier === 'string' ? modifier : ''] ?? 'STRAIGHT';
  const leftOrRight = side.endsWith('LEFT') ? 'LEFT' : side.endsWith('RIGHT') ? 'RIGHT' : null;

  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn')
    return leftOrRight === 'LEFT' ? 'ROUNDABOUT_LEFT' : 'ROUNDABOUT_RIGHT';
  if (type === 'fork') return leftOrRight === 'LEFT' ? 'FORK_LEFT' : 'FORK_RIGHT';
  if (type === 'on ramp' || type === 'off ramp')
    return leftOrRight === 'LEFT' ? 'RAMP_LEFT' : 'RAMP_RIGHT';
  if (side === 'UTURN') return leftOrRight === 'RIGHT' ? 'UTURN_RIGHT' : 'UTURN_LEFT';
  if (type === 'turn' || type === 'end of road' || type === 'continue') {
    if (side === 'STRAIGHT') return 'CONTINUE';
    return (`TURN_${side}` as NavManeuver);
  }
  return 'CONTINUE';
}

/** Whether a maneuver turns left, right, or neither. For arrow mirroring. */
export function maneuverSide(maneuver: NavManeuver): 'LEFT' | 'RIGHT' | null {
  if (maneuver.endsWith('LEFT')) return 'LEFT';
  if (maneuver.endsWith('RIGHT')) return 'RIGHT';
  return null;
}

/**
 * One instruction on the way to a stop.
 *
 * `polyline` is this step's own shape, `[latitude, longitude]`, and it always
 * begins where the previous step ended -- the steps of a leg laid end to end
 * reproduce the leg. That redundancy is on purpose: locating the driver within
 * a *step* is what drives the distance countdown, and doing it against the
 * whole leg would need an index into a path nothing else carries.
 *
 * `durationSeconds` comes from the Routes API's `staticDuration`, which is
 * free-flow, **not** traffic-aware. The leg's own duration is traffic-aware, so
 * the per-step figures do not sum to it and must never be presented as "time to
 * the next turn" beside a traffic-aware ETA -- in Houston at five o'clock the
 * gap is minutes. It is carried for ordering and for the step list, not for the
 * HUD.
 */
export interface NavigationStep {
  maneuver: NavManeuver;
  /** The router's own words: always right, even when the enum above is not. */
  instruction: string;
  /** The road being joined, when the router names one separately. */
  roadName: string | null;
  distanceMeters: number;
  /** Free-flow seconds. See the note above before printing this anywhere. */
  durationSeconds: number;
  /** `[latitude, longitude]`. Begins where the previous step ended. */
  polyline: readonly (readonly [number, number])[];
}

/**
 * The drive to one stop, in enough detail to navigate it.
 *
 * Deliberately not part of `TechnicianRoute`. That type describes a whole day
 * and is fetched on a timer for the suggested-order card; this is fetched when
 * somebody presses "start driving" and refetched when they leave the road.
 */
export interface NavigationLeg {
  /** The inspection being driven to. */
  toStopId: string;
  /** Where the leg was drawn from, `[latitude, longitude]`. */
  from: readonly [number, number];
  /** The stop itself, `[latitude, longitude]`. */
  to: readonly [number, number];
  distanceMeters: number;
  /** Traffic-aware when `source` is GOOGLE_TRAFFIC. The number the HUD prints. */
  durationSeconds: number;
  steps: readonly NavigationStep[];
  /** The whole leg, `[latitude, longitude]`. Steps laid end to end. */
  polyline: readonly (readonly [number, number])[];
  source: 'GOOGLE_TRAFFIC' | 'OSRM_FREE_FLOW';
  /** When it was drawn, so the client can tell a fresh leg from a held one. */
  drawnAt: string;
}

/**
 * How close, and how slow, counts as having arrived.
 *
 * **Both, not either.** `technician-timeline.ts` uses a 100 m radius alone to
 * decide a visit happened, which is right for a question asked after the fact.
 * Asked live it is wrong in a way that matters: residential stops sit 40 m
 * apart, and a technician doing 40 mph past the *next* house on the way to this
 * one passes within 100 m of it for several seconds. On radius alone the chain
 * would silently advance to a stop they are driving away from, reroute to it,
 * and speak the wrong instruction.
 *
 * 60 m is about a front garden plus GPS wander. 2.5 m/s is a brisk walk -- a
 * vehicle slowing into a driveway is under it, a vehicle passing is not.
 */
export const NAV_ARRIVAL_RADIUS_M = 60;
export const NAV_ARRIVAL_SPEED_MS = 2.5;

/**
 * How long the driver must stay inside the arrival radius before it counts.
 *
 * A single fix meeting both tests above is still a GPS spike. Traffic lights
 * outside a property, and a 60 m accuracy jump next to the right house, both
 * produce one. Requiring the condition to hold across several seconds costs a
 * beat on a genuine arrival and removes the spike entirely.
 */
export const NAV_ARRIVAL_DWELL_MS = 6_000;

/**
 * How far past a step's end the driver must be before the next one is shown.
 *
 * A parked or crawling phone's fix wanders ten to thirty metres. Without a
 * margin, a vehicle stopped at the lights *on* a step boundary flips between
 * two instructions on consecutive fixes -- and each flip would re-speak the
 * announcement. The margin is one-directional: the step index never decreases
 * without a full relocate, which only an off-route event triggers.
 */
export const NAV_STEP_ADVANCE_M = 25;

/**
 * How far from the drawn line counts as having left it, while navigating.
 *
 * Tighter than the console's `OFF_ROUTE_M` of 150 m, and for a different job.
 * 150 m answers "is the office's drawn line still describing this drive"; a
 * navigator has to notice a wrong turn before the technician has driven a block
 * on it. 50 m clears normal urban GPS wander and a divided carriageway, and
 * still catches the parallel street.
 */
export const NAV_OFF_ROUTE_M = 50;

/**
 * How many consecutive fixes must be off the line before it counts.
 *
 * One fix off the route is a tunnel, an overpass, or an urban canyon bouncing a
 * signal off a building -- not a wrong turn. Three in a row at driving speed is
 * a hundred metres or more of consistent disagreement, which is.
 */
export const NAV_OFF_ROUTE_FIXES = 3;

/**
 * The worst fix accuracy navigation will act on.
 *
 * `MAX_USEFUL_ACCURACY_M` in `technician-location.ts` is 500 m, chosen so a
 * tower fix is not drawn as a position on the office map. For turn-by-turn a
 * 200 m fix is worse than nothing: it snaps the marker to the wrong street,
 * advances the step, and speaks a turn that is not there. Navigation holds the
 * last good position instead and says the signal is poor.
 */
export const NAV_MAX_ACCURACY_M = 50;

/**
 * Below this speed, a reported course is noise rather than a heading.
 *
 * Matches `MOVING_SPEED_MS` in `technician-location.ts` and exists for the same
 * reason: GPS jitter alone gives a parked phone a low speed in a random
 * direction, so a course-up map spins on the spot. Under it the camera holds
 * its last heading.
 */
export const NAV_MOVING_SPEED_MS = 0.5;

/**
 * Where the voice speaks, in metres before the maneuver.
 *
 * Three announcements, which is what Google gives a surface street: far enough
 * out to change lane, close enough to commit, and at the turn itself. Each
 * fires once per step -- see `announcementsFor`, which takes what has already
 * been said so that a driver stopped at a light does not hear the same
 * instruction on every fix.
 *
 * Metric here because everything in this file is SI; the phone formats them
 * into miles and feet, because it is read by a technician in Texas. The console
 * stays metric because it is read by the office. That split is deliberate --
 * see `formatDistance` on the mobile side.
 */
export const NAV_ANNOUNCE_DISTANCES_M: readonly number[] = [1_600, 400, 60];
