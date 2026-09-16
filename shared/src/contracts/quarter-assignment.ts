/**
 * Laying a quarter's stops out over technician-days.
 *
 * Pure and dependency-free, like the rotation beside it, so the decisions here
 * can be argued with in a test rather than inferred from a plan somebody has
 * already published.
 *
 * ## The office's limits
 *
 * Stated on 2026-09-16: a technician's day is at most **six hours inspecting**
 * and **ninety minutes driving**, and the ninety minutes count the drive from
 * home to the first property as well as the drives between properties -- an
 * eight-hour day with its breaks. The drive home is not counted, and the number
 * of stops is not limited: eleven properties is a fine day if it keeps inside
 * both.
 *
 * So a day is measured in minutes, never in stops. The on-site minutes are the
 * visits' own lengths (an HVAC inspection takes longer than an occupied one);
 * the drive is the route from home through the day's stops in its best order.
 *
 * ## Zones
 *
 * Each week each technician on the crew has one zone, and a stop goes only to
 * whoever has its zone that week (`zoneTechnicians`, from
 * `weeklyZoneTechnicians`). Nobody crosses town, and a stop whose zone has
 * nobody on its day moves to the nearest day that does.
 *
 * ## Why there is no clustering pass
 *
 * The obvious design is k-means over every stop in the quarter, then a routing
 * pass per cluster. It is not what this does, because the input is already
 * clustered and re-clustering it would throw that away.
 *
 * The office sequences benefit-package visits **by zone**, and it shows in
 * their own calendar: of Q3 2026's 52 technician-days, 24 covered a single zone
 * and 25 covered two. The rotation order inherits that grouping -- it was
 * recovered from those visits in the first place, and is carried forward every
 * quarter after -- so consecutive stops in the rotation are usually neighbours
 * already.
 *
 * That makes the honest algorithm a simple one: keep the order, cut it into
 * days, and decide geography only *within* a day and between neighbouring days,
 * which is where drive time actually accrues.
 */

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
  /** Who took this tenancy's visit last quarter, preferred when a day is opened. */
  previousTechnicianId?: string | null;
  /** The zone it is in, as a number. Only whoever has the zone that day can take it. */
  zone?: string | null;
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
   * Who has each zone that day, `zone -> technician`. A stop in a zone goes only
   * to that zone's technician, and a zone missing here has nobody that day.
   * Absent: days are not given out by zone, and a stop with no zone is open to
   * anyone qualified.
   */
  zoneTechnicians?: Readonly<Record<string, string>>;
}

export interface DayLimits {
  /** Time spent inspecting in one technician-day. */
  maxOnSiteMinutes: number;
  /** Driving in one technician-day: from home to the first property, and between the properties. */
  maxDriveMinutes: number;
}

export const DEFAULT_DAY_LIMITS: DayLimits = { maxOnSiteMinutes: 6 * 60, maxDriveMinutes: 90 };

/**
 * The most stops one day can hold, whatever the minutes say.
 *
 * Not the office's limit -- theirs is time -- but Google's: a day is routed
 * with one matrix of every stop against every other, and a matrix over 625
 * elements is refused. Twenty-four stops in six hours is fifteen minutes a
 * visit, which no visit here takes.
 */
export const MAX_STOPS_PER_DAY = 24;

/**
 * How far a stop may move from its rotation day to join a technician already
 * out nearby, before a second technician is sent out on its own day.
 */
export const NEARBY_DAYS = 2;

export interface PlacedStop {
  stopId: string;
  date: string;
  technicianId: string;
  /** 1-based position within that technician's day. */
  position: number;
}

export interface AssignedCrew {
  date: string;
  technicianId: string;
  /** In driving order. */
  stops: PlannableStop[];
  onSiteMinutes: number;
  /** From home when the technician has one, and between the stops. Estimated for any leg not yet measured. */
  driveMinutes: number;
  /** Given a stop in this pass, so a drive measured before it no longer describes the day. */
  changed: boolean;
}

export type UnplacedReason =
  | 'NO_WORKING_DAYS'
  | 'NO_QUALIFIED_TECHNICIAN'
  | 'NO_CAPACITY'
  | 'LONGER_THAN_A_DAY'
  /** Every technician who could take it lives further from it than the day's drive allows. */
  | 'OUT_OF_REACH';

export interface QuarterAssignment {
  placed: PlacedStop[];
  crews: AssignedCrew[];
  unplaced: { stopId: string; reason: UnplacedReason }[];
  /** Demand against what the quarter could hold, for the capacity warning. */
  capacity: { stops: number; onSiteMinutes: number; availableMinutes: number };
}

interface Point {
  latitude: number;
  longitude: number;
}

/** Minutes between two places. */
export type DriveEstimate = (from: Point, to: Point) => number;

/**
 * A drive guessed from the straight line, used only to lay the quarter out.
 *
 * Every day is then measured on real roads (`QuarterPlannerService`), and a
 * day that measures over the limit is repaired, so this only has to be close.
 * It leans long: three minutes to get going plus a minute and a half per
 * straight-line kilometre is about 30 km/h on a road a third longer than the
 * line -- slower than the suburbs for a long leg, which is the side to be
 * wrong on against a limit.
 */
export function estimatedDriveMinutes(from: Point, to: Point): number {
  const kilometres = haversineMeters(from, to) / 1000;
  // Two tenancies in one building are no drive at all.
  return kilometres < 0.05 ? 0 : 3 + kilometres * 1.5;
}

export interface AssignmentOptions {
  limits?: DayLimits;
  driveMinutes?: DriveEstimate;
  /**
   * Lower is preferred when a technician is sent out on a day for a visit of
   * this kind: the office gives each kind to its own technicians.
   */
  technicianRank?: (technicianId: string, inspectionType: string) => number;
  /**
   * Each stop's place in the whole quarter's rotation, when only some of the
   * quarter's stops are being placed -- a repair pass placing the stops a
   * measured day could not keep. Without it, the stops given are the rotation.
   */
  rotation?: { position: ReadonlyMap<string, number>; size: number };
  /** Days already laid out, which stops may join but never leave. */
  existing?: readonly { date: string; technicianId: string; stops: readonly PlannableStop[]; driveMinutes: number }[];
  /** Technician-days a stop must not join, as `date|technicianId`: the days it was measured not to fit. */
  avoid?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Where each technician's day starts. The drive from there to the first stop
   * counts against the day's drive limit (the office, 2026-09-16); a technician
   * missing here starts at their first stop.
   */
  homes?: ReadonlyMap<string, Point>;
}

interface Crew {
  technicianId: string;
  stops: PlannableStop[];
  onSite: number;
  drive: number;
  changed: boolean;
}

/** `date|technicianId`, the identity of a technician-day. */
export const crewKey = (date: string, technicianId: string) => `${date}|${technicianId}`;

/**
 * Give every stop a day, a technician, and a place in that day's drive.
 *
 * Stops arrive in rotation order and keep it: stop *i* of *n* is aimed at the
 * day *i/n* of the way through the quarter, so whoever was first last quarter
 * is first again and a tenant's visits stay about ninety days apart. Nothing
 * here reorders the rotation to suit a route. A stop moves off its day only to
 * fit the limits, and then to the nearest day that can take it.
 *
 * For each stop, in this order, and only ever with a technician qualified for
 * it -- the one who has its zone that day, when days are given out by zone:
 * 1. a technician already out on its day, if the stop fits their day;
 * 2. a technician sent out on its day, if nobody who could take it is out yet;
 * 3. a technician out within `NEARBY_DAYS`, rather than a second one on its day;
 * 4. a technician sent out the next day, if nobody who could take it is out yet;
 * 5. a second technician on its day;
 * 6. the nearest day, either side, that can take it at all.
 */
export function assignQuarter(
  stops: readonly PlannableStop[],
  days: readonly PlannableDay[],
  options: AssignmentOptions = {},
): QuarterAssignment {
  const limits = options.limits ?? DEFAULT_DAY_LIMITS;
  const drive = options.driveMinutes ?? estimatedDriveMinutes;
  const rank = options.technicianRank ?? (() => 0);
  const capacity = {
    stops: stops.length,
    onSiteMinutes: stops.reduce((total, stop) => total + stop.onSiteMinutes, 0),
    availableMinutes: days.reduce((total, day) => total + day.technicianIds.length * limits.maxOnSiteMinutes, 0),
  };

  const crewsByDay: Crew[][] = days.map(() => []);
  const dayIndex = new Map(days.map((day, index) => [day.date, index]));
  const load = new Map<string, number>();
  const addLoad = (technicianId: string, minutes: number) =>
    load.set(technicianId, (load.get(technicianId) ?? 0) + minutes);

  for (const crew of options.existing ?? []) {
    const index = dayIndex.get(crew.date);
    if (index === undefined) continue;
    const onSite = crew.stops.reduce((total, stop) => total + stop.onSiteMinutes, 0);
    crewsByDay[index]!.push({
      technicianId: crew.technicianId,
      stops: [...crew.stops],
      onSite,
      drive: crew.driveMinutes,
      changed: false,
    });
    addLoad(crew.technicianId, onSite);
  }

  const qualifiedOn = (day: PlannableDay, technicianId: string, stop: PlannableStop) => {
    const list = day.qualified?.[stop.inspectionType];
    return (
      day.technicianIds.includes(technicianId) &&
      (!list || list.includes(technicianId)) &&
      // By zone, when days are given out by zone: its technician that day, and nobody else.
      (!day.zoneTechnicians || !stop.zone || day.zoneTechnicians[stop.zone] === technicianId)
    );
  };
  const homeOf = (technicianId: string) => options.homes?.get(technicianId);
  /** Whether a technician's home is near enough that a day of this stop alone keeps inside the drive. */
  const withinReach = (technicianId: string, stop: PlannableStop) => {
    const home = homeOf(technicianId);
    return !home || drive(home, stop) <= limits.maxDriveMinutes + 1e-9;
  };
  /** Whether anybody who could take this stop is already out on a day. */
  const outFor = (stop: PlannableStop, index: number) =>
    crewsByDay[index]!.some((crew) => qualifiedOn(days[index]!, crew.technicianId, stop));
  const avoided = (stop: PlannableStop, date: string, technicianId: string) =>
    options.avoid?.get(stop.stopId)?.has(crewKey(date, technicianId)) ?? false;

  const join = (stop: PlannableStop, index: number) => {
    const day = days[index]!;
    let best: { crew: Crew; route: PlannableStop[]; drive: number } | null = null;
    for (const crew of crewsByDay[index]!) {
      if (crew.stops.length >= MAX_STOPS_PER_DAY) continue;
      if (!qualifiedOn(day, crew.technicianId, stop)) continue;
      if (avoided(stop, day.date, crew.technicianId)) continue;
      if (crew.onSite + stop.onSiteMinutes > limits.maxOnSiteMinutes) continue;
      const insertion = cheapestInsertion(crew.stops, crew.drive, stop, drive, homeOf(crew.technicianId));
      if (insertion.drive > limits.maxDriveMinutes + 1e-9) continue;
      if (!best || insertion.drive - crew.drive < best.drive - best.crew.drive) best = { crew, ...insertion };
    }
    if (!best) return false;
    best.crew.stops = best.route;
    best.crew.drive = best.drive;
    best.crew.onSite += stop.onSiteMinutes;
    best.crew.changed = true;
    addLoad(best.crew.technicianId, stop.onSiteMinutes);
    return true;
  };

  const open = (stop: PlannableStop, index: number) => {
    const day = days[index]!;
    const out = new Set(crewsByDay[index]!.map((crew) => crew.technicianId));
    const candidates = day.technicianIds.filter(
      (technicianId) =>
        !out.has(technicianId) &&
        qualifiedOn(day, technicianId, stop) &&
        !avoided(stop, day.date, technicianId) &&
        withinReach(technicianId, stop),
    );
    if (candidates.length === 0) return false;
    // Last quarter's technician first, so the tenant sees the same face; then
    // whoever the office sends most on this kind of visit; then whoever has
    // the least so far.
    // The day's own order ends it, so the choice is total and repeatable.
    const technicianId = [...candidates].sort(
      (left, right) =>
        Number(right === stop.previousTechnicianId) - Number(left === stop.previousTechnicianId) ||
        rank(left, stop.inspectionType) - rank(right, stop.inspectionType) ||
        (load.get(left) ?? 0) - (load.get(right) ?? 0) ||
        day.technicianIds.indexOf(left) - day.technicianIds.indexOf(right),
    )[0]!;
    const home = homeOf(technicianId);
    crewsByDay[index]!.push({
      technicianId,
      stops: [stop],
      onSite: stop.onSiteMinutes,
      drive: home ? drive(home, stop) : 0,
      changed: true,
    });
    addLoad(technicianId, stop.onSiteMinutes);
    return true;
  };

  const place = (stop: PlannableStop, target: number) => {
    const inRange = (index: number) => index >= 0 && index < days.length;
    if (join(stop, target)) return true;
    if (!outFor(stop, target) && open(stop, target)) return true;
    for (let offset = 1; offset <= NEARBY_DAYS; offset += 1)
      for (const index of [target - offset, target + offset]) if (inRange(index) && join(stop, index)) return true;
    // Start the next day rather than send a second technician out today. Where
    // the rotation crosses from one zone to the next, the stops of the new zone
    // that were aimed at today would otherwise go out as a day of one or two.
    if (inRange(target + 1) && !outFor(stop, target + 1) && open(stop, target + 1)) return true;
    if (open(stop, target)) return true;
    // Outward rather than only forward, so a full week does not push every
    // later stop back and cascade the whole quarter. Earlier wins a tie: a
    // stop that cannot sit on its own day is better a day early than late.
    for (let offset = 1; offset < days.length; offset += 1)
      for (const index of [target - offset, target + offset])
        if (inRange(index) && (join(stop, index) || open(stop, index))) return true;
    return false;
  };

  const unplaced: { stopId: string; reason: UnplacedReason }[] = [];
  const ordered = [...stops].sort((left, right) => left.sequence - right.sequence);

  if (days.length === 0) {
    for (const stop of ordered) unplaced.push({ stopId: stop.stopId, reason: 'NO_WORKING_DAYS' });
  } else {
    const size = Math.max(1, options.rotation?.size ?? ordered.length);
    for (const [index, stop] of ordered.entries()) {
      if (stop.onSiteMinutes > limits.maxOnSiteMinutes) {
        unplaced.push({ stopId: stop.stopId, reason: 'LONGER_THAN_A_DAY' });
        continue;
      }
      const position = options.rotation?.position.get(stop.stopId) ?? index;
      const target = Math.min(days.length - 1, Math.max(0, Math.floor((position * days.length) / size)));
      if (place(stop, target)) continue;
      const qualified = days.flatMap((day) =>
        day.technicianIds.filter((technicianId) => qualifiedOn(day, technicianId, stop)),
      );
      unplaced.push({
        stopId: stop.stopId,
        reason: !qualified.length
          ? 'NO_QUALIFIED_TECHNICIAN'
          : qualified.some((technicianId) => withinReach(technicianId, stop))
            ? 'NO_CAPACITY'
            : 'OUT_OF_REACH',
      });
    }
  }

  const crews: AssignedCrew[] = [];
  const placed: PlacedStop[] = [];
  crewsByDay.forEach((dayCrews, index) => {
    const date = days[index]!.date;
    for (const crew of dayCrews) {
      crews.push({
        date,
        technicianId: crew.technicianId,
        stops: crew.stops,
        onSiteMinutes: crew.onSite,
        driveMinutes: crew.drive,
        changed: crew.changed,
      });
      crew.stops.forEach((stop, position) =>
        placed.push({ stopId: stop.stopId, date, technicianId: crew.technicianId, position: position + 1 }),
      );
    }
  });

  return { placed, crews, unplaced, capacity };
}

/**
 * Where a stop adds the least driving to a day, and the day's drive after it.
 *
 * The day is a path, not a loop -- nobody drives back to the first property --
 * so the ends are candidates too, and joining one costs a single leg. With a
 * home the path starts there, so a stop put first costs the drive from home.
 */
function cheapestInsertion(
  route: readonly PlannableStop[],
  currentDrive: number,
  stop: PlannableStop,
  drive: DriveEstimate,
  home?: Point,
): { route: PlannableStop[]; drive: number } {
  if (route.length === 0) return { route: [stop], drive: home ? drive(home, stop) : 0 };
  let bestAt = 0;
  let bestAdded = Number.POSITIVE_INFINITY;
  for (let at = 0; at <= route.length; at += 1) {
    const before: Point | undefined = at === 0 ? home : route[at - 1];
    const after = route[at];
    const added =
      (before ? drive(before, stop) : 0) + (after ? drive(stop, after) : 0) - (before && after ? drive(before, after) : 0);
    if (added < bestAdded) {
      bestAdded = added;
      bestAt = at;
    }
  }
  return { route: [...route.slice(0, bestAt), stop, ...route.slice(bestAt)], drive: currentDrive + bestAdded };
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
