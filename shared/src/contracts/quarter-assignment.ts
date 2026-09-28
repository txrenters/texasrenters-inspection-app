/**
 * Laying a quarter's stops out over technician-days.
 *
 * Pure and dependency-free, like the rotation beside it, so the decisions here
 * can be argued with in a test rather than inferred from a plan somebody has
 * already published.
 *
 * ## The office's rules (2026-09-19)
 *
 * - **Days of nine, grouped for the least driving** (`minStopsPerDay`): "group
 *   the properties into 9 and make sure those grouping is the least drive time,
 *   that way we can still add more properties to the schedule". The visits are
 *   cut into groups of nine, each as tight as the properties allow (`groupsOf`),
 *   and a day is one group.
 * - **A tenth where the properties are on top of each other**
 *   (`maxStopsPerDay`, the office, 2026-09-20): "minimum of 9 vists maximum of
 *   10". Past its nine a day takes a tenth visit only while it is within five
 *   minutes' drive of the day (`closeMinutes`) -- so a day in one neighbourhood
 *   is ten and a day across a spread-out zone stays at nine. The office asked
 *   for twelve and fifteen earlier the same day and settled on ten, so the
 *   maximum is a plan's own setting and not a constant here.
 * - **No day starved while the day beside it is full** (`evenOut`,
 *   2026-09-20): "some are just 6, some are just 1 some 4, 2 etc. this clearly
 *   is not optimized". A group short of nine takes visits from fuller groups
 *   near it while they keep more than it does, so a neighbourhood of
 *   twenty-seven visits is three days of nine rather than ten, ten and seven.
 *   A day holds fewer than nine only where there is nothing within the longest
 *   drive allowed to fill it with.
 * - **Never more than twenty minutes between two properties**
 *   (`maxLegMinutes`): "I don't want to see a grouping that from one property to
 *   other property that will get more than 20mins of drive time". A property
 *   further than that from every visit left is not added to make up a nine, so
 *   a day holds fewer only where the properties are that far apart. The drive
 *   from home is not a leg between properties and is not held to it.
 * - **The whole crew, every planned day, from the first** (2026-09-18), until
 *   every visit has a day: "all 3 should have schedules per day, it doesn't
 *   matter if they can finish all the TBP in a month". So a month's visits are
 *   done in its first weeks, a group a day each, in last quarter's order.
 * - **Each crew member has one zone a week** (`zoneTechnicians`, from
 *   `weeklyZoneTechnicians`): their day is a group of their zone of the week
 *   while it has any, then of the zone nobody has that week, then of the zone
 *   nearest their home.
 * - **A property within five minutes of a group joins it**, whatever zone it is
 *   in (`NEIGHBOUR_MINUTES`): "we will still follow the zoning but if there's a
 *   property that is near ... like 5 mins away then let's add it to the group
 *   also."
 * - **A zone too far for a day's drive is a trip** (`tripZones`): its groups go
 *   on back-to-back days of the crew member living nearest it, driven down once.
 * - **The quarter is finished as early as the crew can** (2026-09-20): "if a
 *   technician can finish the visits as early as possible that's good, if they
 *   can finish it in a month then that's good, we don't realy need to fill out
 *   all the month on each quarter". Every visit is laid out over every planned
 *   day at once, days are filled from the plan's first, and the quarter ends
 *   when the visits do. A property is still taken up in the order of its last
 *   quarter -- the month it was visited in orders it (`month`), it no longer
 *   holds it back -- so the visits done first last quarter are done first
 *   again. This replaced a month-by-month layout (2026-09-18) that left the end
 *   of each month a handful of visits, and days of one and two with it.
 * - **A visit with nowhere left to go joins the day that adds least driving**
 *   (`squeezeIn`, 2026-09-20): sooner a fuller day than a tenancy nobody
 *   visits. Only after everything else, and still never more than the
 *   longest drive allowed between two properties, or past the day's visits and
 *   its six hours.
 * - **Move-outs and move-ins are anchors** (`DayAnchor`): on a day a crew member
 *   has one, the day's visits are the ones nearest it, from any zone, and it is
 *   routed with them (2026-09-17: "we should be doing TBPs around those"). Each
 *   counts an hour on site and **takes the place of three visits**
 *   (`ANCHOR_VISITS`, 2026-09-18): six besides one, three besides two.
 */

import type { Quarter } from './quarter-plan.js';
import { haversineMeters } from './route-plan.js';

/** A stop that can be placed: it has a rotation position, a location and a length. */
export interface PlannableStop {
  stopId: string;
  /** 1-based rotation position, from `carryForwardOrder`. */
  sequence: number;
  latitude: number;
  longitude: number;
  /** How long the visit takes on site, in minutes. */
  onSiteMinutes: number;
  /** The kind of visit, which decides who is qualified to take it. */
  inspectionType: string;
  /** Who took this tenancy's visit last quarter. */
  previousTechnicianId?: string | null;
  /** The zone it is in, as a number. */
  zone?: string | null;
  /**
   * The month of the quarter its visit was in last quarter, 1 to 3. It orders
   * the visits -- last quarter's first month is taken up first -- and, since
   * 2026-09-20, no longer holds a visit back to that month of this quarter.
   * Absent: no visit last quarter, taken up with the second month's.
   */
  month?: number;
}

/** One working day, and who can be sent out on it. */
export interface PlannableDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Available that day -- expiry is evaluated per date. */
  technicianIds: string[];
  /**
   * Who is qualified for each kind of visit that day. A kind missing here is
   * open to everybody in `technicianIds`.
   */
  qualified?: Readonly<Record<string, readonly string[]>>;
  /**
   * Who has each zone that day, `zone -> technician`: whose zone each day of
   * theirs is in. Absent: days are not given out by zone.
   */
  zoneTechnicians?: Readonly<Record<string, string>>;
}

export interface DayLimits {
  /** Time spent inspecting in one technician-day. */
  maxOnSiteMinutes: number;
  /**
   * The visits the planner puts on a day: nine (the office, 2026-09-19). Fewer
   * only where the properties are further apart than `maxLegMinutes`.
   */
  minStopsPerDay: number;
  /**
   * The most visits a day may hold: ten (the office, 2026-09-20, "minimum of 9
   * vists maximum of 10"). Past its nine a day only takes a visit within
   * `closeMinutes` of it.
   */
  maxStopsPerDay: number;
  /**
   * How near a visit has to be for a day to take its tenth, in minutes of
   * estimated drive: five (the office, 2026-09-20, "2-5 mins away").
   * Absent: `NEIGHBOUR_MINUTES`.
   */
  closeMinutes?: number;
  /**
   * The longest drive, by the estimate, between two of a day's properties:
   * twenty minutes (the office, 2026-09-19). Absent: `MAX_LEG_MINUTES`.
   */
  maxLegMinutes?: number;
}

/** The longest drive the office allows between two of a day's properties, in minutes (2026-09-19). */
export const MAX_LEG_MINUTES = 20;

/**
 * How near, by the estimated drive, a property has to be to a group's visits to
 * join them from another zone (the office, 2026-09-18), or to be the tenth on a
 * day of nine (2026-09-20): five minutes.
 */
export const NEIGHBOUR_MINUTES = 5;

export const DEFAULT_DAY_LIMITS: DayLimits = {
  maxOnSiteMinutes: 6 * 60,
  minStopsPerDay: 9,
  maxStopsPerDay: 10,
  maxLegMinutes: MAX_LEG_MINUTES,
  closeMinutes: NEIGHBOUR_MINUTES,
};

/**
 * The most stops one day can hold, whatever the office's own maximum says.
 *
 * Google's limit rather than the office's: a day is routed with one matrix of
 * every stop and the home against every other, and a matrix over 625 elements
 * is refused.
 */
export const MAX_STOPS_PER_DAY = 24;

export interface PlacedStop {
  stopId: string;
  date: string;
  technicianId: string;
  /** 1-based position within that technician's day. */
  position: number;
}

/** A day of a trip to a zone too far for a day's drive. */
export interface TripDay {
  zone: string;
  /** Which day of the trip: 1 is the day driven down. */
  day: number;
  /** How many days the trip is. */
  days: number;
}

export interface AssignedCrew {
  date: string;
  technicianId: string;
  /** In driving order. */
  stops: PlannableStop[];
  onSiteMinutes: number;
  /** Between the stops, first to last, estimated. */
  driveMinutes: number;
  /** The appointments the day is built around, when it is. `onSiteMinutes` includes theirs. */
  anchors?: DayAnchor[];
  /** Set on the days of a trip to a far zone. */
  trip?: TripDay;
}

/**
 * A fixed appointment a technician-day is built around: a move-out or move-in already booked.
 *
 * Not a stop to place -- it has its day and its technician already -- but a place
 * the day's visits gather round, and time on site. Routed with the visits
 * (`anchorAsStop`), and never placed or published: it is its own inspection.
 */
export interface DayAnchor {
  /** The anchoring inspection. */
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  technicianId: string;
  latitude: number;
  longitude: number;
  onSiteMinutes: number;
  /** What it is: a move-out unless it says. */
  kind?: 'MOVE_OUT' | 'MOVE_IN';
}

/** Why no day was built around an anchor. */
export type AnchorSkipReason = 'NOT_A_PLANNED_DAY' | 'TECHNICIAN_NOT_WORKING' | 'DAY_TAKEN';

/**
 * How many benefit-package visits each move-out or move-in takes the place of
 * on its day: the hour it counts, in visits planned at twenty minutes (the
 * office, 2026-09-18).
 */
export const ANCHOR_VISITS = 3;

/**
 * The visits a day holds beside its move-outs and move-ins: `min` is the nine
 * the planner puts on it, and `max` the ten it may reach where the properties
 * are within five minutes of each other -- three fewer at each end for each
 * one, and never fewer than none.
 */
export function dayVisitRange(limits: DayLimits, anchors: number): { min: number; max: number } {
  const fewer = ANCHOR_VISITS * Math.max(0, anchors);
  return {
    min: Math.max(0, limits.minStopsPerDay - fewer),
    max: Math.max(0, Math.min(limits.maxStopsPerDay, MAX_STOPS_PER_DAY) - fewer),
  };
}

const ANCHOR_STOP_PREFIX = 'anchor:';

/** An anchor as a stop in its day's route, measured and ordered with the visits. */
export function anchorAsStop(anchor: DayAnchor): PlannableStop {
  return {
    stopId: `${ANCHOR_STOP_PREFIX}${anchor.id}`,
    sequence: 0,
    latitude: anchor.latitude,
    longitude: anchor.longitude,
    onSiteMinutes: anchor.onSiteMinutes,
    inspectionType: anchor.kind ?? 'MOVE_OUT',
    zone: null,
  };
}

/** The anchor's id when a route stop is one (`anchorAsStop`), and null for a visit. */
export function anchorIdOf(stop: Pick<PlannableStop, 'stopId'>): string | null {
  return stop.stopId.startsWith(ANCHOR_STOP_PREFIX) ? stop.stopId.slice(ANCHOR_STOP_PREFIX.length) : null;
}

export type UnplacedReason =
  | 'NO_WORKING_DAYS'
  | 'NO_QUALIFIED_TECHNICIAN'
  | 'NO_CAPACITY'
  | 'LONGER_THAN_A_DAY'
  /** A far zone's trip found no run of days in a row to go on. */
  | 'NO_TRIP_DAYS';

export interface QuarterAssignment {
  placed: PlacedStop[];
  crews: AssignedCrew[];
  unplaced: { stopId: string; reason: UnplacedReason }[];
  /** Anchors no day could be built around, and why. */
  skippedAnchors: { anchorId: string; reason: AnchorSkipReason }[];
  /** Demand against what the quarter could hold, for the capacity warning. */
  capacity: { stops: number; onSiteMinutes: number; availableMinutes: number };
}

interface Point {
  latitude: number;
  longitude: number;
}

/** Minutes between two places. */
export type DriveEstimate = (from: Point, to: Point) => number;

/** `date|technicianId`, the identity of a technician-day. */
export const crewKey = (date: string, technicianId: string) => `${date}|${technicianId}`;

/**
 * A drive guessed from the straight line.
 *
 * Three minutes to get going plus a minute and a half per straight-line
 * kilometre. The three minutes are parking, walking and pulling out again,
 * which is why a neighbour two streets away is not free.
 *
 * **This is now the answer, not only the ranking.** It used to lay the quarter
 * out and every day was then measured again on Google's traffic-aware roads.
 * The office asked for an average from the distance instead of live traffic,
 * and the measurement says they are right to: against Google's own legs on the
 * Q4 2026 plan this read 7.5 minutes a leg where Google read 7.8, and 49 hours
 * over the quarter where Google read 44. Within a few per cent, for no key, no
 * billing account and no per-element charge — and a quarter that can be
 * rebuilt when somebody's card has expired, which is the state the office was
 * in when this changed.
 *
 * Where it is least accurate is below a kilometre and past twenty, and both
 * read long. Neither matters much here: a day's legs average three kilometres,
 * and a leg past twenty is one the office has asked never to plan.
 */
export function estimatedDriveMinutes(from: Point, to: Point): number {
  const kilometres = haversineMeters(from, to) / 1000;
  // Two tenancies in one building are no drive at all.
  return kilometres < 0.05 ? 0 : 3 + kilometres * 1.5;
}

export interface LayoutOptions {
  limits?: DayLimits;
  driveMinutes?: DriveEstimate;
  /** Each stop's place in last quarter's order. Without it, the stops given are the order. */
  rotation?: { position: ReadonlyMap<string, number> };
  /** Technician-days already taken, as `date|technicianId`: a coordinator's own days. */
  taken?: ReadonlySet<string>;
  /**
   * Appointments days are built around. On each one's date its technician's day
   * takes the visits nearest it, from any zone.
   */
  anchors?: readonly DayAnchor[];
  /** Where each crew member lives: for the zone nearest home, and who makes a trip. */
  homes?: ReadonlyMap<string, Point>;
  /** Zones too far for a day's drive from home, laid out as trips. */
  tripZones?: readonly string[];
  /** How near a property in another zone has to be to join a group, by the estimated drive. */
  neighbourMinutes?: number;
  /** The plan's quarter, for whoever needs to name it. */
  quarter?: Quarter;
}

const DAY_MS = 86_400_000;

/** A saving smaller than this, in estimated minutes, is noise rather than a shorter day. */
const SAVING_MINUTES = 0.5;

/** Where a visit with no last quarter goes in the order: with the second month's. */
const NEW_VISIT_MONTH = 2;

/**
 * How many times the groups are evened out (`evenOut`).
 *
 * Each round leaves the sizes closer together than the one before, so a few are
 * enough: the first lifts the short groups, and the rest settle what filling
 * them left short in turn.
 */
const EVENING_ROUNDS = 3;

/** Changes made across one set of groups. Each only ever shortens the driving; this bounds a pathological case. */
const MAX_IMPROVEMENT_ROUNDS = 2000;

/** Candidates tried against the groups, best estimate first, before a round gives up. */
const CONFIRMED_PER_ROUND = 25;

/**
 * How many visits next to each other move between groups at once, beside one at
 * a time: a pair or a run of three left on the wrong day is a detour no single
 * move undoes, because moving any one of them alone makes its group's drive
 * longer before it makes it shorter.
 */
const RUNS_MOVED = [2, 3];

/**
 * How many groupings are grown before the one that drives least is kept: the two
 * ways of starting, then randomised tries of each.
 *
 * Growing a group nearest-first is a good guess, not the best answer, and which
 * guess wins differs from one part of town to the next. The office's priority is
 * the least driving (2026-09-19), so several are tried and measured.
 */
const GROUPINGS_TRIED = 6;

/** How many of the cheapest visits a randomised grouping picks between. */
const NEXT_VISIT_CHOICES = 3;

/**
 * The draw a randomised grouping uses, from a fixed start.
 *
 * Fixed, so the same quarter always comes out the same: a plan that changed
 * every time it was rebuilt could not be checked against the last one.
 */
function draws(): () => number {
  let seed = 1;
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

/**
 * The most visits left over of an area that join days already holding their
 * nine, up to the office's twelve, rather than make a day of their own.
 */
const LEFTOVER_VISITS = 2;

/**
 * What a leg longer than the office allows adds to what a day costs: more than
 * any day of legs within the limit could ever drive, so no choice here makes one
 * while another way exists (`pricedLegs`).
 */
const OVER_LEG = 10_000;

/** The estimate, with every leg longer than the office allows priced out (`OVER_LEG`). */
function pricedLegs(drive: DriveEstimate, maxLegMinutes: number): DriveEstimate {
  return (from, to) => {
    const minutes = drive(from, to);
    return minutes > maxLegMinutes ? minutes + OVER_LEG : minutes;
  };
}

/** Whether a cost, or what a change adds to one, includes a leg longer than the office allows. */
const overLong = (cost: number) => cost >= OVER_LEG / 2;

/** Stops in driving order, and what driving them costs by the estimate used. */
interface Path {
  path: PlannableStop[];
  cost: number;
}

const pathMinutes = (path: readonly Point[], drive: DriveEstimate) => {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += drive(path[index - 1]!, path[index]!);
  return total;
};

/** The shortest order found through a path whose two ends are both free (2-opt). */
function polished(path: readonly PlannableStop[], cost: DriveEstimate): Path {
  let best = [...path];
  let total = pathMinutes(best, cost);
  for (let improved = true; improved; ) {
    improved = false;
    for (let from = 0; from < best.length - 1; from += 1)
      for (let to = from + 1; to < best.length; to += 1) {
        const next = [...best.slice(0, from), ...best.slice(from, to + 1).reverse(), ...best.slice(to + 1)];
        const nextTotal = pathMinutes(next, cost);
        if (nextTotal + 1e-9 < total) {
          best = next;
          total = nextTotal;
          improved = true;
        }
      }
  }
  return { path: best, cost: total };
}

/** Where a stop adds least to an open path -- the ends count, since nobody drives back -- and how much. */
function cheapestInsertion(path: readonly PlannableStop[], stop: PlannableStop, cost: DriveEstimate) {
  if (path.length === 0) return { at: 0, added: 0 };
  let at = 0;
  let added = cost(stop, path[0]!);
  const atEnd = cost(path[path.length - 1]!, stop);
  if (atEnd < added) {
    added = atEnd;
    at = path.length;
  }
  for (let index = 1; index < path.length; index += 1) {
    const between = cost(path[index - 1]!, stop) + cost(stop, path[index]!) - cost(path[index - 1]!, path[index]!);
    if (between < added) {
      added = between;
      at = index;
    }
  }
  return { at, added };
}

/** What taking a stop out of an open path saves, the rest kept in order. */
function removalSaving(path: readonly PlannableStop[], stop: PlannableStop, cost: DriveEstimate) {
  const at = path.indexOf(stop);
  if (at === -1 || path.length <= 1) return 0;
  if (at === 0) return cost(path[0]!, path[1]!);
  if (at === path.length - 1) return cost(path[at - 1]!, path[at]!);
  return cost(path[at - 1]!, stop) + cost(stop, path[at + 1]!) - cost(path[at - 1]!, path[at + 1]!);
}

/** What taking a run of stops out of an open path saves, the rest kept in order. */
function runRemovalSaving(path: readonly PlannableStop[], at: number, length: number, cost: DriveEstimate) {
  const before = at > 0 ? path[at - 1]! : null;
  const after = at + length < path.length ? path[at + length]! : null;
  // The legs inside the run travel with it, so only the two ends change.
  let saved = 0;
  if (before) saved += cost(before, path[at]!);
  if (after) saved += cost(path[at + length - 1]!, after);
  if (before && after) saved -= cost(before, after);
  return saved;
}

/** Where a run of stops adds least to an open path, either way round, and how much. */
function cheapestRunInsertion(path: readonly PlannableStop[], run: readonly PlannableStop[], cost: DriveEstimate) {
  if (path.length === 0) return { added: 0 };
  let added = Number.POSITIVE_INFINITY;
  for (const [head, tail] of [
    [run[0]!, run[run.length - 1]!],
    [run[run.length - 1]!, run[0]!],
  ]) {
    added = Math.min(added, cost(tail, path[0]!), cost(path[path.length - 1]!, head));
    for (let index = 1; index < path.length; index += 1)
      added = Math.min(added, cost(path[index - 1]!, head) + cost(tail, path[index]!) - cost(path[index - 1]!, path[index]!));
  }
  return { added };
}

/**
 * A day built around its anchors: the visits nearest them, nearest first, as
 * many as the day takes beside them -- nine, three fewer for each
 * (`dayVisitRange`, the office, 2026-09-18) -- and its tenth while that one is
 * within five minutes of the day (2026-09-20). None that would
 * make a drive between two of the day's stops longer than the office allows.
 */
function fillAroundAnchors(
  anchors: readonly DayAnchor[],
  candidates: readonly PlannableStop[],
  limits: DayLimits,
  cost: DriveEstimate,
  drive: DriveEstimate,
): { visits: PlannableStop[]; drive: number; onSite: number } {
  const range = dayVisitRange(limits, anchors.length);
  const close = limits.closeMinutes ?? NEIGHBOUR_MINUTES;
  let path = polished(anchors.map(anchorAsStop), cost).path;
  let onSite = anchors.reduce((total, anchor) => total + anchor.onSiteMinutes, 0);
  const visits: PlannableStop[] = [];
  const left = new Set(candidates);
  while (visits.length < range.max) {
    let best: { stop: PlannableStop; at: number; added: number } | null = null;
    for (const stop of left) {
      if (onSite + stop.onSiteMinutes > limits.maxOnSiteMinutes) continue;
      const { at, added } = cheapestInsertion(path, stop, cost);
      if (!overLong(added) && (!best || added < best.added)) best = { stop, at, added };
    }
    // Past the visits the day holds beside its move-outs, only one on its doorstep.
    if (!best || (visits.length >= range.min && best.added > close)) break;
    path = [...path.slice(0, best.at), best.stop, ...path.slice(best.at)];
    onSite += best.stop.onSiteMinutes;
    visits.push(best.stop);
    left.delete(best.stop);
  }
  const ordered = polished(path, cost).path;
  return { visits: ordered.filter((stop) => anchorIdOf(stop) === null), drive: pathMinutes(ordered, drive), onSite };
}

const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`);

const zoneOf = (stop: PlannableStop) => stop.zone ?? '';

/**
 * The same estimate, worked out once per pair of places.
 *
 * Grouping a quarter's visits asks for the same drives many thousands of times,
 * and each is a great-circle distance. Keyed by the objects themselves, which
 * stay the same for a whole layout.
 */
function remembered(drive: DriveEstimate): DriveEstimate {
  const cache = new Map<Point, Map<Point, number>>();
  return (from, to) => {
    let row = cache.get(from);
    if (!row) cache.set(from, (row = new Map()));
    let minutes = row.get(to);
    if (minutes === undefined) row.set(to, (minutes = drive(from, to)));
    return minutes;
  };
}

/** Whether a technician may take a stop on a day: working it, and qualified for its kind. */
function qualified(day: PlannableDay, technicianId: string, stop: PlannableStop) {
  const list = day.qualified?.[stop.inspectionType];
  return day.technicianIds.includes(technicianId) && (!list || list.includes(technicianId));
}

/** The middle of some places, by latitude and longitude: near enough across one city. */
function middleOf(points: readonly Point[]): Point {
  return {
    latitude: points.reduce((total, point) => total + point.latitude, 0) / points.length,
    longitude: points.reduce((total, point) => total + point.longitude, 0) / points.length,
  };
}

/** Visits being made into a day: in driving order, what driving them costs, and the time on site. */
interface Group {
  /** The zone it was started in; null when days are not given out by zone. */
  zone: string | null;
  path: PlannableStop[];
  /** The estimate between its stops, first to last, with a leg longer than allowed priced out. */
  cost: number;
  onSite: number;
}

/** How the visits are grouped into days. */
interface GroupRules {
  /** The visits a group holds before it asks how near the next one is: the office's nine. */
  size: number;
  /** The most a group holds at all, where the properties are close together: the office's ten. */
  most: number;
  /** How near a visit must be, in minutes, for a group past its nine to take it. */
  close: number;
  limits: DayLimits;
  /** The estimate, a leg longer than the office allows priced out (`pricedLegs`). */
  cost: DriveEstimate;
  /** The estimate itself: who is a neighbour. */
  drive: DriveEstimate;
  neighbourMinutes: number;
  /** Whether a group keeps to the zone it started in, neighbours apart. */
  zoned: boolean;
}

/**
 * Whether a group has room for a visit that adds `added` minutes of driving: up
 * to its nine, anything the other rules allow; past that, only a visit within
 * five minutes of the day (the office, 2026-09-20). `however` takes a visit
 * that would otherwise be a day of its own, near or not.
 */
function hasRoom(members: readonly PlannableStop[], added: number, rules: GroupRules, however = false) {
  if (members.length >= rules.most) return false;
  return members.length < rules.size || however || added <= rules.close;
}

/** Whether a group has room for a run of visits moved together, by the same rule. */
function hasRoomForRun(members: readonly PlannableStop[], run: number, added: number, rules: GroupRules) {
  if (members.length + run > rules.most) return false;
  return members.length + run <= rules.size || added <= rules.close * run;
}

/** Whether a visit may be in a group: one of its zone, or within the neighbour drive of another of its visits. */
function belongs(stop: PlannableStop, zone: string | null, path: readonly PlannableStop[], rules: GroupRules) {
  return (
    !rules.zoned ||
    zone === null ||
    zoneOf(stop) === zone ||
    path.some((other) => other !== stop && rules.drive(stop, other) <= rules.neighbourMinutes)
  );
}

/**
 * Where each group starts: the visit furthest out of what is left (`edge`), or
 * the one with fewest others left within the longest drive allowed, and of
 * those the furthest out (`loneliest`).
 */
type GroupStart = 'edge' | 'loneliest';

/**
 * The visits cut into groups, each grown nearest first from the visit furthest
 * out of what is left.
 *
 * From the edge inward, on purpose. A group started in the middle of town takes
 * the visits around it and leaves the outlying ones to make up a day from
 * whatever is left near them -- which is how a day ends up with three visits on
 * one side of town and six on the other. Started at the edge, each group takes
 * the outlying visits first, and what is left at the end is in the middle,
 * where everything is near. A group takes whichever visit adds least driving,
 * of its zone or a neighbour, until it has its nine or every visit left would
 * need a drive longer than the office allows.
 */
function grownGroups(pool: readonly PlannableStop[], rules: GroupRules, start: GroupStart, draw: (() => number) | null): Group[] {
  const left = new Set(pool);
  const middle = middleOf(pool);
  const groups: Group[] = [];
  while (left.size) {
    let seed: PlannableStop | null = null;
    let seedScore = Number.NEGATIVE_INFINITY;
    for (const stop of left) {
      // Furthest out first; from the loneliest first, the visits with fewest others in reach -- up to a group's worth.
      let score = haversineMeters(middle, stop);
      if (start === 'loneliest') {
        let reach = 0;
        for (const other of left) if (other !== stop && !overLong(rules.cost(stop, other))) reach += 1;
        score -= Math.min(reach, rules.size) * 1e9;
      }
      if (score > seedScore) {
        seed = stop;
        seedScore = score;
      }
    }
    left.delete(seed!);
    const group: Group = { zone: rules.zoned ? zoneOf(seed!) : null, path: [seed!], cost: 0, onSite: seed!.onSiteMinutes };
    while (group.path.length < rules.most) {
      const candidates: { stop: PlannableStop; at: number; added: number }[] = [];
      for (const stop of left) {
        if (group.onSite + stop.onSiteMinutes > rules.limits.maxOnSiteMinutes || !belongs(stop, group.zone, group.path, rules))
          continue;
        const { at, added } = cheapestInsertion(group.path, stop, rules.cost);
        if (!overLong(added) && hasRoom(group.path, added, rules)) candidates.push({ stop, at, added });
      }
      if (candidates.length === 0) break;
      candidates.sort((left, right) => left.added - right.added || left.stop.stopId.localeCompare(right.stop.stopId));
      // The cheapest visit, or one of the cheapest few when this grouping is a randomised try.
      const taken = candidates[draw ? Math.floor(draw() * Math.min(NEXT_VISIT_CHOICES, candidates.length)) : 0]!;
      group.path.splice(taken.at, 0, taken.stop);
      group.cost += taken.added;
      group.onSite += taken.stop.onSiteMinutes;
      left.delete(taken.stop);
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Shorten the driving across the groups, and have fewer of them where the visits allow.
 *
 * 1. A visit moves to another group, or two visits trade groups, whenever that
 *    shortens the two groups' driving together -- into a group it may be in,
 *    with room, and never making a drive between two stops longer than allowed.
 * 2. A group short of nine goes, smallest first, when every one of its visits
 *    fits in another group: a day fewer.
 * 3. The moves and swaps again, around what that changed.
 */
function improveGroups(groups: Group[], rules: GroupRules): Group[] {
  const { size, limits, cost } = rules;
  const shortest = new Map<string, Path>();
  // The best order found from any first stop, 2-opt from each, remembered by the set of stops.
  const best = (stops: readonly PlannableStop[]): Path => {
    const key = stops.map((stop) => stop.stopId).sort().join('|');
    let found = shortest.get(key);
    if (!found) {
      found = { path: [...stops], cost: pathMinutes(stops, cost) };
      for (const first of stops) {
        const order = [first];
        const left = new Set(stops.filter((stop) => stop !== first));
        while (left.size) {
          const last = order[order.length - 1]!;
          let next: PlannableStop | null = null;
          for (const stop of left) if (!next || cost(last, stop) < cost(last, next)) next = stop;
          order.push(next!);
          left.delete(next!);
        }
        const tried = polished(order, cost);
        if (tried.cost + 1e-9 < found.cost) found = tried;
      }
      shortest.set(key, found);
    }
    return found;
  };
  const set = (group: Group, stops: readonly PlannableStop[]) => {
    const found = best(stops);
    group.path = found.path;
    group.cost = found.cost;
    group.onSite = stops.reduce((total, stop) => total + stop.onSiteMinutes, 0);
  };
  const roomFor = (group: Group, stop: PlannableStop, added: number, however = false) =>
    hasRoom(group.path, added, rules, however) && group.onSite + stop.onSiteMinutes <= limits.maxOnSiteMinutes;
  const allows = (stop: PlannableStop, group: Group) => belongs(stop, group.zone, group.path, rules);

  for (const group of groups) set(group, group.path);

  /**
   * The best change first, each round: the move or swap whose estimate saves most
   * that the groups, ordered again, confirm. Taking the first that saved anything
   * could strand a visit: a three-minute move filling a group would block the
   * thirty-minute one that took a visit back across town.
   */
  const search = () => {
    for (let round = 0; round < MAX_IMPROVEMENT_ROUNDS; round += 1) {
      const changes: { estimate: number; apply: () => boolean }[] = [];

      for (const from of groups) {
        if (from.path.length <= 1) continue;
        for (const stop of from.path) {
          const saved = removalSaving(from.path, stop, cost);
          for (const to of groups) {
            if (to === from || to.path.length === 0 || !allows(stop, to)) continue;
            const added = cheapestInsertion(to.path, stop, cost).added;
            if (!roomFor(to, stop, added)) continue;
            const estimate = added - saved;
            if (estimate >= -SAVING_MINUTES) continue;
            changes.push({
              estimate,
              apply: () => {
                const rest = from.path.filter((other) => other !== stop);
                if (best(rest).cost + best([...to.path, stop]).cost + SAVING_MINUTES >= from.cost + to.cost) return false;
                set(to, [...to.path, stop]);
                set(from, rest);
                return true;
              },
            });
          }
        }
      }

      // Runs of two or three visits next to each other, moved together.
      for (const from of groups) {
        for (const length of RUNS_MOVED) {
          if (from.path.length <= length) continue;
          for (let at = 0; at + length <= from.path.length; at += 1) {
            const run = from.path.slice(at, at + length);
            const saved = runRemovalSaving(from.path, at, length, cost);
            const runOnSite = run.reduce((total, stop) => total + stop.onSiteMinutes, 0);
            for (const to of groups) {
              if (
                to === from ||
                to.path.length === 0 ||
                to.onSite + runOnSite > limits.maxOnSiteMinutes ||
                !run.every((stop) => allows(stop, to))
              )
                continue;
              const added = cheapestRunInsertion(to.path, run, cost).added;
              if (!hasRoomForRun(to.path, length, added, rules)) continue;
              const estimate = added - saved;
              if (estimate >= -SAVING_MINUTES) continue;
              changes.push({
                estimate,
                apply: () => {
                  const rest = from.path.filter((stop) => !run.includes(stop));
                  if (best(rest).cost + best([...to.path, ...run]).cost + SAVING_MINUTES >= from.cost + to.cost) return false;
                  set(to, [...to.path, ...run]);
                  set(from, rest);
                  return true;
                },
              });
            }
          }
        }
      }

      for (const [index, left] of groups.entries())
        for (const right of groups.slice(index + 1)) {
          if (left.path.length === 0 || right.path.length === 0) continue;
          for (const one of left.path) {
            if (!allows(one, right)) continue;
            const outOfLeft = removalSaving(left.path, one, cost);
            const intoRight = cheapestInsertion(right.path, one, cost).added;
            for (const other of right.path) {
              if (
                !allows(other, left) ||
                left.onSite - one.onSiteMinutes + other.onSiteMinutes > limits.maxOnSiteMinutes ||
                right.onSite - other.onSiteMinutes + one.onSiteMinutes > limits.maxOnSiteMinutes
              )
                continue;
              // Inserted beside the stop leaving, a visit is counted a little long; the confirmation is exact.
              const estimate =
                intoRight - outOfLeft + cheapestInsertion(left.path, other, cost).added - removalSaving(right.path, other, cost);
              if (estimate >= -SAVING_MINUTES) continue;
              changes.push({
                estimate,
                apply: () => {
                  const nextLeft = [...left.path.filter((stop) => stop !== one), other];
                  const nextRight = [...right.path.filter((stop) => stop !== other), one];
                  if (best(nextLeft).cost + best(nextRight).cost + SAVING_MINUTES >= left.cost + right.cost) return false;
                  set(left, nextLeft);
                  set(right, nextRight);
                  return true;
                },
              });
            }
          }
        }

      changes.sort((left, right) => left.estimate - right.estimate);
      if (!changes.slice(0, CONFIRMED_PER_ROUND).some((change) => change.apply())) break;
    }
  };
  search();

  /**
   * A short group's visits shared out among the groups holding fewer than
   * `room`, each where it adds least driving and makes no drive longer than
   * allowed -- or null when one of them fits nowhere. `anyZone` lets a visit
   * join another zone's group.
   */
  const sharedOut = (short: Group, anyZone: boolean, however: boolean) => {
    const joined = new Map<Group, PlannableStop[]>();
    for (const stop of short.path) {
      let target: { group: Group; members: PlannableStop[]; added: number } | null = null;
      for (const group of groups) {
        if (group === short || group.path.length === 0) continue;
        const members = joined.get(group) ?? group.path;
        const onSite = members.reduce((total, member) => total + member.onSiteMinutes, 0);
        if (onSite + stop.onSiteMinutes > limits.maxOnSiteMinutes) continue;
        if (!anyZone && !belongs(stop, group.zone, members, rules)) continue;
        // Nothing within the longest drive allowed of the group, nothing to try.
        if (!members.some((member) => !overLong(cost(stop, member)))) continue;
        const added = best([...members, stop]).cost - best(members).cost;
        if (!hasRoom(members, added, rules, however)) continue;
        if (!overLong(added) && (!target || added < target.added)) target = { group, members: [...members, stop], added };
      }
      if (!target) return null;
      joined.set(target.group, target.members);
    }
    return joined;
  };

  /**
   * A day fewer wherever a short group's visits all fit in other groups, the
   * smallest first. A group short of nine is what is left over of an area, and
   * the office's zoning holds for it as for any day -- only one or two visits
   * left over may cross into a neighbouring zone's day, because a technician
   * sent out for one visit is a day nobody would plan.
   */
  const dissolve = (largest: number, anyZone: boolean, however: boolean) => {
    for (const short of groups.filter((group) => group.path.length <= largest).sort((left, right) => left.path.length - right.path.length)) {
      if (short.path.length === 0 || short.path.length > largest) continue;
      const joined = sharedOut(short, anyZone, however);
      if (!joined) continue;
      for (const [group, members] of joined) set(group, members);
      set(short, []);
    }
  };
  // A group short of nine is shared out even where the visits are not within
  // five minutes of the group taking them (`however`): the office would rather
  // drive a little further than send a technician out for six (2026-09-20).
  /**
   * A group short of nine fills from the fuller groups around it.
   *
   * The office (2026-09-20), on a quarter of days of six, four, two and one:
   * "this clearly is not optimized". They were not short of properties -- each
   * had dozens within the twenty minutes allowed, on days that were already
   * full. A group gives up a visit only while it keeps its own nine and more
   * than the group taking it, so twenty-seven visits are three days of nine
   * rather than ten, ten and seven, and a day of nine is never broken up to
   * make two of six. The visit moved is the one that costs least to move; zones
   * and the longest drive allowed hold, so a day alone in its corner of the map
   * stays as it is.
   *
   * It runs after the driving has been shortened, not before: a day of nine is
   * what the office asked for, and a few minutes more driving is what it costs.
   */
  const evenOut = () => {
    const fill = (into: Group) => {
      let taken: { from: Group; stop: PlannableStop; estimate: number } | null = null;
      for (const from of groups) {
        // Only from a group that keeps its nine, and keeps more than this one:
        // ten, ten and seven are three days of nine, and nine and three are not
        // two days of six.
        if (from === into || from.path.length <= size || from.path.length <= into.path.length + 1) continue;
        for (const stop of from.path) {
          if (!allows(stop, into) || into.onSite + stop.onSiteMinutes > limits.maxOnSiteMinutes) continue;
          const added = cheapestInsertion(into.path, stop, cost).added;
          if (overLong(added)) continue;
          const estimate = added - removalSaving(from.path, stop, cost);
          if (!taken || estimate < taken.estimate) taken = { from, stop, estimate };
        }
      }
      if (!taken) return false;
      const { from, stop } = taken;
      set(into, [...into.path, stop]);
      set(from, from.path.filter((other) => other !== stop));
      return true;
    };
    for (let round = 0; round < EVENING_ROUNDS; round += 1) {
      const short = groups
        .filter((group) => group.path.length > 0 && group.path.length < size)
        .sort((left, right) => left.path.length - right.path.length);
      if (!short.length) return;
      let moved = false;
      for (const group of short) while (group.path.length < size && fill(group)) moved = true;
      if (!moved) return;
    }
  };

  dissolve(size - 1, false, true);
  dissolve(LEFTOVER_VISITS, true, true);
  search();
  evenOut();

  return groups.filter((group) => group.path.length > 0);
}

/**
 * What is left of the visits, as the planner's days: grouped from the edge
 * inward, then improved together.
 *
 * Several groupings are grown -- both kinds of start, then randomised tries --
 * and each improved. The one kept is the one that drives least of those that
 * take the fewest days. Driving is the office's priority (2026-09-19), and days
 * come first only because a technician's whole day is not worth trading for a
 * few minutes of it: the office's nine a day settles how many days there are,
 * and the choice between groupings is then the driving alone.
 */
function groupsOf(pool: readonly PlannableStop[], rules: GroupRules): Group[] {
  if (pool.length === 0) return [];
  const draw = draws();
  let chosen: { groups: Group[]; cost: number } | null = null;
  for (let attempt = 0; attempt < GROUPINGS_TRIED; attempt += 1) {
    const start: GroupStart = attempt % 2 === 0 ? 'edge' : 'loneliest';
    const groups = improveGroups(grownGroups(pool, rules, start, attempt < 2 ? null : draw), rules);
    const cost = groups.reduce((total, group) => total + group.cost, 0);
    const better =
      !chosen ||
      groups.length < chosen.groups.length ||
      (groups.length === chosen.groups.length && cost < chosen.cost - 1e-9);
    if (better) chosen = { groups, cost };
  }
  return chosen!.groups;
}

/**
 * The group a crew member's day takes: the first in last quarter's order of
 * their zone of the week while it has one, then of the zone nobody has that
 * week, then of the zone nearest their home -- or, with no home on file, the
 * zone with most visits left.
 */
function groupFor(
  day: PlannableDay,
  technicianId: string,
  groups: readonly Group[],
  home: Point | undefined,
  rank: (group: Group) => number,
): Group {
  const owners = day.zoneTechnicians ?? {};
  const inZone = (zone: string) =>
    groups.filter((group) => (group.zone ?? '') === zone).sort((left, right) => rank(left) - rank(right));
  const zones = [...new Set(groups.map((group) => group.zone ?? ''))];
  const own = Object.keys(owners).find((zone) => owners[zone] === technicianId);
  if (own !== undefined && zones.includes(own)) return inZone(own)[0]!;
  const idle = zones.filter((zone) => owners[zone] === undefined);
  const choices = idle.length ? idle : zones;
  const score = (zone: string) => {
    const members = inZone(zone).flatMap((group) => group.path);
    return home ? Math.min(...members.map((stop) => haversineMeters(home, stop))) : -members.length;
  };
  return inZone(choices.sort((left, right) => score(left) - score(right) || left.localeCompare(right))[0]!)[0]!;
}

/** The first run of `count` planned days in a row -- no weekend or closed day between -- that `usable` accepts. */
function firstRun(days: readonly PlannableDay[], count: number, usable: (day: PlannableDay) => boolean) {
  for (let start = 0; start + count <= days.length; start += 1) {
    const run = days.slice(start, start + count);
    const inARow = run.every((day, index) => index === 0 || dayTime(day.date) - dayTime(run[index - 1]!.date) === DAY_MS);
    if (inARow && run.every(usable)) return run;
  }
  return null;
}

/** Groups in the order a trip drives them: the one nearest `start` first, then each the nearest to the one before. */
function chainedGroups(groups: readonly Group[], start: Point | undefined, drive: DriveEstimate) {
  const left = new Set(groups);
  let from: Point | undefined = start;
  const chain: Group[] = [];
  while (left.size) {
    let next: Group | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const group of left) {
      const minutes = from ? Math.min(...group.path.map((stop) => drive(from!, stop))) : 0;
      if (!next || minutes < nearest) {
        next = group;
        nearest = minutes;
      }
    }
    chain.push(next!);
    left.delete(next!);
    from = middleOf(next!.path);
  }
  return chain;
}

/**
 * A far zone's visits as a trip: back-to-back days of one crew member.
 *
 * The visits are grouped as any are, a day a group. The crew member living
 * nearest the zone goes, on the first run of days in a row they are free and
 * qualified for all of it; with no run for them, the next nearest. The group
 * nearest their home is the day driven down, and each day after takes the
 * group nearest the one before.
 */
function planTrip(
  zone: string,
  members: readonly PlannableStop[],
  days: readonly PlannableDay[],
  crew: readonly string[],
  context: {
    rules: GroupRules;
    homes: ReadonlyMap<string, Point> | undefined;
    unavailable: (key: string) => boolean;
  },
): AssignedCrew[] | null {
  const { rules, homes } = context;
  const groups = groupsOf(members, rules);
  const middle = middleOf(members);
  const fromHome = (technicianId: string) => {
    const home = homes?.get(technicianId);
    return home ? haversineMeters(home, middle) : Number.POSITIVE_INFINITY;
  };
  // Stable, so the crew's own order settles a tie and puts anyone without a home last.
  for (const technicianId of [...crew].sort((left, right) => fromHome(left) - fromHome(right))) {
    const run = firstRun(
      days,
      groups.length,
      (day) =>
        !context.unavailable(crewKey(day.date, technicianId)) &&
        members.every((stop) => qualified(day, technicianId, stop)),
    );
    if (!run) continue;
    const trip = chainedGroups(groups, homes?.get(technicianId), rules.drive);
    return trip.map((group, index) => ({
      date: run[index]!.date,
      technicianId,
      stops: group.path,
      onSiteMinutes: group.onSite,
      driveMinutes: pathMinutes(group.path, rules.drive),
      trip: { zone, day: index + 1, days: trip.length },
    }));
  }
  return null;
}

/**
 * The visits nothing could group, squeezed into the days that have room.
 *
 * The last thing tried. A visit no group could take -- the crew's days in its
 * month are all full, or it sits between two areas -- joins whichever day adds
 * least driving, move-outs and all. The office would rather a day ran to its
 * tenth than leave a tenancy unvisited (2026-09-20), so the five minutes and
 * the zoning do not apply here; the longest drive allowed between two
 * properties, the day's visits and its six hours still do.
 */
function squeezeIn(
  crews: AssignedCrew[],
  left: Set<PlannableStop>,
  dayOn: ReadonlyMap<string, PlannableDay>,
  limits: DayLimits,
  cost: DriveEstimate,
  drive: DriveEstimate,
) {
  for (const stop of [...left]) {
    let best: { crew: AssignedCrew; path: PlannableStop[]; added: number } | null = null;
    for (const crew of crews) {
      const day = dayOn.get(crew.date);
      if (!day || !qualified(day, crew.technicianId, stop)) continue;
      if (crew.stops.length >= dayVisitRange(limits, crew.anchors?.length ?? 0).max) continue;
      if (crew.onSiteMinutes + stop.onSiteMinutes > limits.maxOnSiteMinutes) continue;
      const path = [...(crew.anchors ?? []).map(anchorAsStop), ...crew.stops];
      const { at, added } = cheapestInsertion(path, stop, cost);
      if (overLong(added) || (best && added >= best.added)) continue;
      best = { crew, path: [...path.slice(0, at), stop, ...path.slice(at)], added };
    }
    if (!best) continue;
    const ordered = polished(best.path, cost).path;
    best.crew.stops = ordered.filter((one) => anchorIdOf(one) === null);
    best.crew.onSiteMinutes += stop.onSiteMinutes;
    best.crew.driveMinutes = pathMinutes(ordered, drive);
    left.delete(stop);
  }
}

/**
 * Give every stop a day and a technician: the whole crew every planned day, a
 * group of nine each, from the first day until every visit has one -- and the
 * days after that empty, because the office would rather the quarter were
 * finished early than spread over it (2026-09-20).
 *
 * 0. A far zone's visits are a trip, on back-to-back days fixed first
 *    (`planTrip`).
 * 1. Then day by day. First each crew member with a move-out or move-in that
 *    day, whose day takes the visits nearest it from any zone, three fewer for
 *    each (`fillAroundAnchors`). Then everyone else takes a group of what is
 *    left (`groupsOf`): of their zone of the week while it has one, then of the
 *    zone nobody has, then of the zone nearest home, and in each zone the group
 *    holding the visit first in last quarter's order (`groupFor`).
 *
 * The groups are made once from everything left, and made again only after a
 * move-out's day took visits out of them.
 */
export function layoutEveryDay(
  stops: readonly PlannableStop[],
  days: readonly PlannableDay[],
  options: LayoutOptions = {},
): QuarterAssignment {
  const limits = options.limits ?? DEFAULT_DAY_LIMITS;
  const drive = remembered(options.driveMinutes ?? estimatedDriveMinutes);
  const cost = pricedLegs(drive, limits.maxLegMinutes ?? MAX_LEG_MINUTES);
  const neighbourMinutes = options.neighbourMinutes ?? NEIGHBOUR_MINUTES;
  const capacity = {
    stops: stops.length,
    onSiteMinutes: stops.reduce((total, stop) => total + stop.onSiteMinutes, 0),
    availableMinutes: days.reduce((total, day) => total + day.technicianIds.length * limits.maxOnSiteMinutes, 0),
  };
  const unplaced: QuarterAssignment['unplaced'] = [];
  const skippedAnchors: QuarterAssignment['skippedAnchors'] = [];
  if (days.length === 0) {
    for (const stop of stops) unplaced.push({ stopId: stop.stopId, reason: 'NO_WORKING_DAYS' });
    for (const anchor of options.anchors ?? []) skippedAnchors.push({ anchorId: anchor.id, reason: 'NOT_A_PLANNED_DAY' });
    return { placed: [], crews: [], unplaced, skippedAnchors, capacity };
  }

  // Last quarter's order: whoever was first then is first now, and the month of
  // the quarter they were visited in before the place within it. A visit with no
  // month -- new this quarter -- goes with the second month's, so it is neither
  // always first nor always last (2026-09-20).
  const before = new Map(stops.map((stop, index) => [stop.stopId, options.rotation?.position.get(stop.stopId) ?? index]));
  const ordered = [...stops].sort(
    (left, right) =>
      (left.month ?? NEW_VISIT_MONTH) - (right.month ?? NEW_VISIT_MONTH) ||
      before.get(left.stopId)! - before.get(right.stopId)! ||
      left.sequence - right.sequence,
  );
  // Where each visit comes in that order: which group a day takes first (`rank`).
  const place = new Map(ordered.map((stop, index) => [stop.stopId, index]));
  const left = new Set<PlannableStop>();
  for (const stop of ordered) {
    if (stop.onSiteMinutes > limits.maxOnSiteMinutes) unplaced.push({ stopId: stop.stopId, reason: 'LONGER_THAN_A_DAY' });
    else if (!days.some((day) => day.technicianIds.some((technicianId) => qualified(day, technicianId, stop))))
      unplaced.push({ stopId: stop.stopId, reason: 'NO_QUALIFIED_TECHNICIAN' });
    else left.add(stop);
  }

  // The move-outs a day can be built around; the rest say why not.
  const dayOn = new Map(days.map((day) => [day.date, day]));
  const byDay = new Map<string, DayAnchor[]>();
  for (const anchor of options.anchors ?? []) {
    const key = crewKey(anchor.date, anchor.technicianId);
    byDay.set(key, [...(byDay.get(key) ?? []), anchor]);
  }
  const anchored = new Map<string, DayAnchor[]>();
  for (const [key, dayAnchors] of [...byDay].sort(([one], [other]) => one.localeCompare(other))) {
    const { date, technicianId } = dayAnchors[0]!;
    const day = dayOn.get(date);
    // A weekend, a holiday or a Monday kept for rescheduled visits has no planned day to build.
    const reason: AnchorSkipReason | null = !day
      ? 'NOT_A_PLANNED_DAY'
      : !day.technicianIds.includes(technicianId)
        ? 'TECHNICIAN_NOT_WORKING'
        : options.taken?.has(key)
          ? 'DAY_TAKEN'
          : null;
    if (reason) for (const anchor of dayAnchors) skippedAnchors.push({ anchorId: anchor.id, reason });
    else anchored.set(key, dayAnchors);
  }

  const crews: AssignedCrew[] = [];
  const zoned = days.some((day) => day.zoneTechnicians);
  const dayRange = dayVisitRange(limits, 0);
  const rules: GroupRules = {
    size: dayRange.min,
    most: dayRange.max,
    close: limits.closeMinutes ?? NEIGHBOUR_MINUTES,
    limits,
    cost,
    drive,
    neighbourMinutes,
    zoned,
  };

  // 0. Trips, on days fixed before anything else is laid out.
  const crew = [...new Set(days.flatMap((day) => day.technicianIds))];
  const onTrip = new Set<string>();
  for (const zone of [...new Set(options.tripZones ?? [])].sort()) {
    const members = [...left].filter((stop) => zoneOf(stop) === zone);
    if (members.length === 0) continue;
    for (const stop of members) left.delete(stop);
    const trip = planTrip(zone, members, days, crew, {
      rules: { ...rules, zoned: false },
      homes: options.homes,
      unavailable: (key) => Boolean(options.taken?.has(key)) || anchored.has(key) || onTrip.has(key),
    });
    if (!trip) {
      for (const stop of members) unplaced.push({ stopId: stop.stopId, reason: 'NO_TRIP_DAYS' });
      continue;
    }
    for (const day of trip) onTrip.add(crewKey(day.date, day.technicianId));
    crews.push(...trip);
  }

  // 1. Every crew member, every planned day, until nothing is left: the day's
  // move-outs first, then a group each -- whoever still has one in their own
  // zone before anyone helping out.
  const rank = (group: Group) => Math.min(...group.path.map((stop) => place.get(stop.stopId)!));
  // What is left, grouped: kept while days take whole groups of it, made again when a move-out's day breaks one.
  let groups: Group[] | null = null;
  for (const day of days) {
    const free = day.technicianIds.filter((technicianId) => {
      const key = crewKey(day.date, technicianId);
      return !options.taken?.has(key) && !onTrip.has(key);
    });
    for (const technicianId of free) {
      const dayAnchors = anchored.get(crewKey(day.date, technicianId));
      if (!dayAnchors) continue;
      const filled = fillAroundAnchors(
        dayAnchors,
        [...left].filter((stop) => qualified(day, technicianId, stop)),
        limits,
        cost,
        drive,
      );
      if (filled.visits.length) groups = null;
      for (const visit of filled.visits) left.delete(visit);
      crews.push({
        date: day.date,
        technicianId,
        stops: filled.visits,
        onSiteMinutes: filled.onSite,
        driveMinutes: filled.drive,
        anchors: dayAnchors,
      });
    }

    const others = free.filter((technicianId) => !anchored.has(crewKey(day.date, technicianId)));
    if (others.length === 0 || left.size === 0) continue;
    const today: Group[] = (groups ??= groupsOf([...left], rules));
    const owners = day.zoneTechnicians ?? {};
    const canTake = (technicianId: string, group: Group) => group.path.every((stop) => qualified(day, technicianId, stop));
    const hasOwnZone = (technicianId: string) =>
      today.some((group) => owners[group.zone ?? ''] === technicianId && canTake(technicianId, group));
    for (const technicianId of [...others.filter(hasOwnZone), ...others.filter((technicianId) => !hasOwnZone(technicianId))]) {
      const theirs = today.filter((group) => canTake(technicianId, group));
      if (theirs.length === 0) continue;
      const group = groupFor(day, technicianId, theirs, options.homes?.get(technicianId), rank);
      today.splice(today.indexOf(group), 1);
      for (const visit of group.path) left.delete(visit);
      crews.push({
        date: day.date,
        technicianId,
        stops: group.path,
        onSiteMinutes: group.onSite,
        driveMinutes: pathMinutes(group.path, drive),
      });
    }
  }
  // Sooner a fuller day than a tenancy nobody visits (the office, 2026-09-20).
  if (left.size) squeezeIn(crews, left, dayOn, limits, cost, drive);
  for (const stop of left) unplaced.push({ stopId: stop.stopId, reason: 'NO_CAPACITY' });

  crews.sort((one, other) => one.date.localeCompare(other.date) || one.technicianId.localeCompare(other.technicianId));
  const placed = crews.flatMap((crewDay) =>
    crewDay.stops.map((stop, index) => ({
      stopId: stop.stopId,
      date: crewDay.date,
      technicianId: crewDay.technicianId,
      position: index + 1,
    })),
  );
  return { placed, crews, unplaced, skippedAnchors, capacity };
}

/**
 * A straight-line ordering, used when no road matrix is available.
 *
 * Deliberately the fallback rather than the answer: `shortestOpenPathOrder`
 * with a real duration matrix is what the planner uses when routing is
 * configured. This exists so a plan is still produced -- and still ordered
 * sensibly -- when it is not, rather than presenting the rotation order as if
 * it were a route.
 */
export function nearestNeighbourOrder<T extends Point>(dayStops: readonly T[]): T[] {
  if (dayStops.length <= 2) return [...dayStops];
  const remaining = [...dayStops];
  const ordered = [remaining.shift()!];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1]!;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, candidate] of remaining.entries()) {
      const distance = haversineMeters(last, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    ordered.push(...remaining.splice(bestIndex, 1));
  }
  return ordered;
}
