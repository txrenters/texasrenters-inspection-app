/**
 * Laying a quarter's stops out over technician-days.
 *
 * Pure and dependency-free, like the rotation beside it, so the decisions here
 * can be argued with in a test rather than inferred from a plan somebody has
 * already published.
 *
 * ## The office's rules (2026-09-18)
 *
 * - **The whole crew, every planned day, from the quarter's first**, until every
 *   visit has a day (`layoutEveryDay`). The office would rather the crew's days
 *   were full than the quarter's visits spread thin across it: "all 3 should
 *   have schedules per day, it doesn't matter if they can finish all the TBP in
 *   a month". So a quarter's visits are done in its first weeks, in last
 *   quarter's order.
 * - **Nine to twelve visits a day** (`minStopsPerDay`, `maxStopsPerDay`), at most
 *   six hours inspecting, and the driving between them kept as short as that
 *   allows, never capped.
 * - **Each crew member has one zone a week** (`zoneTechnicians`, from
 *   `weeklyZoneTechnicians`), and each day starts from the earliest visit left in
 *   it. A crew member whose zone has nothing left takes the zone nobody has that
 *   week, and then the zone nearest their home.
 * - **A property within five minutes of a day's visits joins the day**, whatever
 *   zone it is in (`NEIGHBOUR_MINUTES`): "we will still follow the zoning but if
 *   there's a property that is near ... like 5 mins away then let's add it to
 *   the group also."
 * - **A zone too far for a day's drive is a trip** (`tripZones`): its visits go on
 *   back-to-back days of the crew member living nearest it, driven down once.
 * - **Move-outs are anchors** (`DayAnchor`): on a day the technician who handles
 *   move-outs has one, the day's visits are the ones nearest it, from any zone,
 *   and the move-out counts an hour on site (the office, 2026-09-17: "we should
 *   be doing TBPs around those").
 *
 * Each day is grown nearest first, and the days are then improved together
 * (`improveWorking`): a visit moves, or two visits trade places, between days
 * that may take them whenever that shortens the driving, and a day still short
 * of nine takes the cheapest visits from fuller ones.
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
  /** Who took this tenancy's visit last quarter. */
  previousTechnicianId?: string | null;
  /** The zone it is in, as a number. */
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
   * Who has each zone that day, `zone -> technician`: whose zone each day of
   * theirs starts in. Absent: days are not given out by zone.
   */
  zoneTechnicians?: Readonly<Record<string, string>>;
}

export interface DayLimits {
  /** Time spent inspecting in one technician-day. */
  maxOnSiteMinutes: number;
  /** Visits every day holds at least. */
  minStopsPerDay: number;
  /** Visits one day holds at most. */
  maxStopsPerDay: number;
}

export const DEFAULT_DAY_LIMITS: DayLimits = { maxOnSiteMinutes: 6 * 60, minStopsPerDay: 9, maxStopsPerDay: 12 };

/**
 * How near, by the estimated drive, a property in another zone has to be to a
 * day's visits to join them: five minutes (the office, 2026-09-18).
 */
export const NEIGHBOUR_MINUTES = 5;

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
 * A fixed appointment a technician-day is built around: a move-out already booked.
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
}

/** Why no day was built around an anchor. */
export type AnchorSkipReason = 'NOT_A_PLANNED_DAY' | 'TECHNICIAN_NOT_WORKING' | 'DAY_TAKEN';

const ANCHOR_STOP_PREFIX = 'anchor:';

/** An anchor as a stop in its day's route, measured and ordered with the visits. */
export function anchorAsStop(anchor: DayAnchor): PlannableStop {
  return {
    stopId: `${ANCHOR_STOP_PREFIX}${anchor.id}`,
    sequence: 0,
    latitude: anchor.latitude,
    longitude: anchor.longitude,
    onSiteMinutes: anchor.onSiteMinutes,
    inspectionType: 'MOVE_OUT',
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
 * A drive guessed from the straight line, used only to lay the quarter out.
 *
 * Every day is then measured on real roads (`QuarterPlannerService`), so this
 * only has to rank one grouping of visits against another. Three minutes to get
 * going plus a minute and a half per straight-line kilometre. Against Google's
 * traffic-aware legs on the Q4 2026 plan it read 49 hours where Google read 44:
 * close from one to ten kilometres, long below a kilometre and past twenty.
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
  /** How near a property in another zone has to be to join a day, by the estimated drive. */
  neighbourMinutes?: number;
}

const DAY_MS = 86_400_000;

/**
 * What a day that already has its nine may still take: a visit adding no more
 * driving than this, or twice the day's average leg where the day is spread
 * out. A visit across town waits for a day of its own instead of stretching a
 * full day to twelve.
 */
const LOCAL_HOP_MINUTES = 15;

/** A saving smaller than this, in estimated minutes, is noise rather than a shorter day. */
const SAVING_MINUTES = 0.5;

/** Changes made across one set of days. Each only ever shortens the driving; this bounds a pathological case. */
const MAX_IMPROVEMENT_ROUNDS = 2000;

/** Candidates tried against the days, best estimate first, before a round gives up. */
const CONFIRMED_PER_ROUND = 25;

/** A day being grown: its visits in driving order, the drive between them, and the time on site. */
interface Draft {
  path: PlannableStop[];
  drive: number;
  onSite: number;
}

const stopsCap = (limits: DayLimits) => Math.min(limits.maxStopsPerDay, MAX_STOPS_PER_DAY);

const pathMinutes = (path: readonly Point[], drive: DriveEstimate) => {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += drive(path[index - 1]!, path[index]!);
  return total;
};

/** The shortest order found through a path whose two ends are both free (2-opt). */
function polished(path: readonly PlannableStop[], drive: DriveEstimate): Omit<Draft, 'onSite'> {
  let best = [...path];
  let cost = pathMinutes(best, drive);
  for (let improved = true; improved; ) {
    improved = false;
    for (let from = 0; from < best.length - 1; from += 1)
      for (let to = from + 1; to < best.length; to += 1) {
        const next = [...best.slice(0, from), ...best.slice(from, to + 1).reverse(), ...best.slice(to + 1)];
        const nextCost = pathMinutes(next, drive);
        if (nextCost + 1e-9 < cost) {
          best = next;
          cost = nextCost;
          improved = true;
        }
      }
  }
  return { path: best, drive: cost };
}

/** Where a stop adds least driving to an open path -- the ends count, since nobody drives back -- and how much. */
function cheapestInsertion(path: readonly PlannableStop[], stop: PlannableStop, drive: DriveEstimate) {
  if (path.length === 0) return { at: 0, added: 0 };
  let at = 0;
  let added = drive(stop, path[0]!);
  const atEnd = drive(path[path.length - 1]!, stop);
  if (atEnd < added) {
    added = atEnd;
    at = path.length;
  }
  for (let index = 1; index < path.length; index += 1) {
    const between = drive(path[index - 1]!, stop) + drive(stop, path[index]!) - drive(path[index - 1]!, path[index]!);
    if (between < added) {
      added = between;
      at = index;
    }
  }
  return { at, added };
}

/** The driving saved by taking a stop out of an open path, the rest kept in order. */
function removalSaving(path: readonly PlannableStop[], stop: PlannableStop, drive: DriveEstimate) {
  const at = path.indexOf(stop);
  if (at === -1 || path.length <= 1) return 0;
  if (at === 0) return drive(path[0]!, path[1]!);
  if (at === path.length - 1) return drive(path[at - 1]!, path[at]!);
  return drive(path[at - 1]!, stop) + drive(stop, path[at + 1]!) - drive(path[at - 1]!, path[at + 1]!);
}

/** The day with one more visit, or null when it would not fit; put where it adds least driving. */
function withVisit(day: Draft, stop: PlannableStop, limits: DayLimits, drive: DriveEstimate): Draft | null {
  if (day.path.length >= stopsCap(limits) || day.onSite + stop.onSiteMinutes > limits.maxOnSiteMinutes) return null;
  const { at, added } = cheapestInsertion(day.path, stop, drive);
  return {
    path: [...day.path.slice(0, at), stop, ...day.path.slice(at)],
    drive: day.drive + added,
    onSite: day.onSite + stop.onSiteMinutes,
  };
}

/** Whether, once a day has its minimum, the next visit would take it across town. */
function acrossTown(day: Draft, added: number, limits: DayLimits) {
  const averageLeg = day.path.length > 1 ? day.drive / (day.path.length - 1) : 0;
  return day.path.length >= limits.minStopsPerDay && added > Math.max(LOCAL_HOP_MINUTES, 2 * averageLeg);
}

/**
 * A day built around its anchors: the visits nearest them, nearest first, up to
 * the day's maximum -- and once it has its minimum, not a visit across town.
 *
 * The anchors count their time on site but not toward the number of visits: a
 * move-out day still holds nine to twelve benefit-package visits besides it (the
 * office, 2026-09-17).
 */
function fillAroundAnchors(
  anchors: readonly DayAnchor[],
  candidates: readonly PlannableStop[],
  limits: DayLimits,
  drive: DriveEstimate,
): { visits: PlannableStop[]; drive: number; onSite: number } {
  let path = polished(anchors.map(anchorAsStop), drive).path;
  let driven = pathMinutes(path, drive);
  let onSite = anchors.reduce((total, anchor) => total + anchor.onSiteMinutes, 0);
  const visits: PlannableStop[] = [];
  const left = new Set(candidates);
  while (visits.length < stopsCap(limits)) {
    let best: { stop: PlannableStop; at: number; added: number } | null = null;
    for (const stop of left) {
      if (onSite + stop.onSiteMinutes > limits.maxOnSiteMinutes) continue;
      const { at, added } = cheapestInsertion(path, stop, drive);
      if (!best || added < best.added) best = { stop, at, added };
    }
    if (!best) break;
    const averageLeg = path.length > 1 ? driven / (path.length - 1) : 0;
    if (visits.length >= limits.minStopsPerDay && best.added > Math.max(LOCAL_HOP_MINUTES, 2 * averageLeg)) break;
    path = [...path.slice(0, best.at), best.stop, ...path.slice(best.at)];
    driven += best.added;
    onSite += best.stop.onSiteMinutes;
    visits.push(best.stop);
    left.delete(best.stop);
  }
  const ordered = polished(path, drive);
  return { visits: ordered.path.filter((stop) => anchorIdOf(stop) === null), drive: ordered.drive, onSite };
}

const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`);

const zoneOf = (stop: PlannableStop) => stop.zone ?? '';

/**
 * The same estimate, worked out once per pair of places.
 *
 * Improving a quarter's days asks for the same drives many thousands of times,
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

/** A technician-day being improved, with the zone it was built for (null: not given out by zone). */
interface Working {
  date: string;
  technicianId: string;
  day: PlannableDay;
  zone: string | null;
  path: PlannableStop[];
  drive: number;
  onSite: number;
}

interface ImproveContext {
  limits: DayLimits;
  drive: DriveEstimate;
  /** Whether a day may take a visit. */
  allows: (stop: PlannableStop, day: Working) => boolean;
}

/**
 * Shorten the driving across a set of days, and bring short ones up to the minimum.
 *
 * 1. A visit moves to another day, or two visits trade days, whenever that
 *    shortens the two days' driving together -- to a day that may take it, never
 *    taking a day under the minimum or over the maximum.
 * 2. A day still short takes the cheapest visits from fuller days, when they have
 *    enough to bring it to the minimum; otherwise its visits go to days with
 *    room, and the short day goes.
 * 3. The moves and swaps again, around what that changed.
 */
function improveWorking(days: Working[], { limits, drive, allows }: ImproveContext) {
  const cap = stopsCap(limits);
  const shortest = new Map<string, Omit<Draft, 'onSite'>>();
  // The best order found from any first stop, 2-opt from each, remembered by the set of stops.
  const best = (stops: readonly PlannableStop[]) => {
    const key = stops.map((stop) => stop.stopId).sort().join('|');
    let found = shortest.get(key);
    if (!found) {
      found = { path: [...stops], drive: pathMinutes(stops, drive) };
      for (const first of stops) {
        const order = [first];
        const left = new Set(stops.filter((stop) => stop !== first));
        while (left.size) {
          const last = order[order.length - 1]!;
          let next: PlannableStop | null = null;
          for (const stop of left) if (!next || drive(last, stop) < drive(last, next)) next = stop;
          order.push(next!);
          left.delete(next!);
        }
        const tried = polished(order, drive);
        if (tried.drive + 1e-9 < found.drive) found = tried;
      }
      shortest.set(key, found);
    }
    return found;
  };
  const set = (day: Working, stops: readonly PlannableStop[]) => {
    const found = best(stops);
    day.path = found.path;
    day.drive = found.drive;
    day.onSite = stops.reduce((total, stop) => total + stop.onSiteMinutes, 0);
  };
  const roomFor = (day: Working, stop: PlannableStop) =>
    day.path.length < cap && day.onSite + stop.onSiteMinutes <= limits.maxOnSiteMinutes;

  for (const day of days) set(day, day.path);

  /**
   * The best change first, each round: the move or swap whose estimate saves most
   * that the days, ordered again, confirm. Taking the first that saved anything
   * could strand a visit: a three-minute move filling a day to its minimum would
   * block the thirty-minute one that took a visit back across town.
   */
  const search = () => {
    for (let round = 0; round < MAX_IMPROVEMENT_ROUNDS; round += 1) {
      const changes: { estimate: number; apply: () => boolean }[] = [];

      for (const from of days) {
        if (from.path.length <= limits.minStopsPerDay) continue;
        for (const stop of from.path) {
          const saved = removalSaving(from.path, stop, drive);
          for (const to of days) {
            if (to === from || to.path.length === 0 || !roomFor(to, stop) || !allows(stop, to)) continue;
            const estimate = cheapestInsertion(to.path, stop, drive).added - saved;
            if (estimate >= -SAVING_MINUTES) continue;
            changes.push({
              estimate,
              apply: () => {
                const rest = from.path.filter((other) => other !== stop);
                if (best(rest).drive + best([...to.path, stop]).drive + SAVING_MINUTES >= from.drive + to.drive) return false;
                set(to, [...to.path, stop]);
                set(from, rest);
                return true;
              },
            });
          }
        }
      }

      for (const [index, left] of days.entries())
        for (const right of days.slice(index + 1)) {
          if (left.path.length === 0 || right.path.length === 0) continue;
          for (const one of left.path) {
            if (!allows(one, right)) continue;
            const outOfLeft = removalSaving(left.path, one, drive);
            const intoRight = cheapestInsertion(right.path, one, drive).added;
            for (const other of right.path) {
              if (
                !allows(other, left) ||
                left.onSite - one.onSiteMinutes + other.onSiteMinutes > limits.maxOnSiteMinutes ||
                right.onSite - other.onSiteMinutes + one.onSiteMinutes > limits.maxOnSiteMinutes
              )
                continue;
              // Inserted beside the stop leaving, a visit is counted a little long; the confirmation is exact.
              const estimate =
                intoRight - outOfLeft + cheapestInsertion(left.path, other, drive).added - removalSaving(right.path, other, drive);
              if (estimate >= -SAVING_MINUTES) continue;
              changes.push({
                estimate,
                apply: () => {
                  const nextLeft = [...left.path.filter((stop) => stop !== one), other];
                  const nextRight = [...right.path.filter((stop) => stop !== other), one];
                  if (best(nextLeft).drive + best(nextRight).drive + SAVING_MINUTES >= left.drive + right.drive) return false;
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

  for (const short of days.filter((day) => day.path.length > 0 && day.path.length < limits.minStopsPerDay)) {
    const needed = limits.minStopsPerDay - short.path.length;
    const spare = days.reduce(
      (total, donor) =>
        donor === short
          ? total
          : total +
            Math.min(
              Math.max(0, donor.path.length - limits.minStopsPerDay),
              donor.path.filter((stop) => allows(stop, short)).length,
            ),
      0,
    );
    if (spare >= needed)
      while (short.path.length < limits.minStopsPerDay) {
        let pick: { stop: PlannableStop; donor: Working; price: number } | null = null;
        for (const donor of days) {
          if (donor === short || donor.path.length <= limits.minStopsPerDay) continue;
          for (const stop of donor.path) {
            if (!allows(stop, short) || !roomFor(short, stop)) continue;
            const price = cheapestInsertion(short.path, stop, drive).added - removalSaving(donor.path, stop, drive);
            if (!pick || price < pick.price) pick = { stop, donor, price };
          }
        }
        if (!pick) break;
        const { stop, donor } = pick;
        set(donor, donor.path.filter((other) => other !== stop));
        set(short, [...short.path, stop]);
      }
    if (short.path.length >= limits.minStopsPerDay) continue;

    // Still short: its visits go to days with room, if every one of them can.
    const room = new Map(days.map((day) => [day, { count: day.path.length, onSite: day.onSite }]));
    const moves: [PlannableStop, Working][] = [];
    for (const stop of short.path) {
      const target = days
        .filter((day) => {
          const left = room.get(day)!;
          return (
            day !== short &&
            day.path.length > 0 &&
            allows(stop, day) &&
            left.count < cap &&
            left.onSite + stop.onSiteMinutes <= limits.maxOnSiteMinutes
          );
        })
        .map((day) => ({ day, added: cheapestInsertion(day.path, stop, drive).added }))
        .sort((left, right) => left.added - right.added)[0]?.day;
      if (!target) break;
      room.get(target)!.count += 1;
      room.get(target)!.onSite += stop.onSiteMinutes;
      moves.push([stop, target]);
    }
    if (moves.length !== short.path.length) continue;
    for (const [stop, target] of moves) set(target, [...target.path, stop]);
    set(short, []);
  }

  search();
}

/**
 * Which zone a crew member's day starts in: their own for the week while it has
 * visits left, then the zone nobody has that week, then the zone nearest their
 * home -- or, with no home on file, the zone with most visits left.
 */
function zoneForDay(
  day: PlannableDay,
  technicianId: string,
  pool: readonly PlannableStop[],
  home: Point | undefined,
): string {
  const withVisits = new Set(pool.map(zoneOf));
  const owners = day.zoneTechnicians ?? {};
  const own = Object.keys(owners).find((zone) => owners[zone] === technicianId);
  if (own !== undefined && withVisits.has(own)) return own;
  const idle = [...withVisits].filter((zone) => owners[zone] === undefined);
  const choices = idle.length ? idle : [...withVisits];
  const score = (zone: string) => {
    const members = pool.filter((stop) => zoneOf(stop) === zone);
    return home ? Math.min(...members.map((stop) => haversineMeters(home, stop))) : -members.length;
  };
  return choices.sort((left, right) => score(left) - score(right) || left.localeCompare(right))[0]!;
}

/**
 * One day, grown nearest first from the earliest visit left in its zone.
 *
 * It takes, whichever adds least driving, a visit of its zone or one of any zone
 * within the neighbour drive of the visits it has; and once it has its minimum,
 * it stops at a visit across town.
 */
function growDay(
  zone: string | null,
  pool: readonly PlannableStop[],
  limits: DayLimits,
  drive: DriveEstimate,
  neighbourMinutes: number,
): Draft {
  const own = zone === null ? pool : pool.filter((stop) => zoneOf(stop) === zone);
  const others = zone === null ? [] : pool.filter((stop) => zoneOf(stop) !== zone);
  const seed = own[0]!;
  let day: Draft = { path: [seed], drive: 0, onSite: seed.onSiteMinutes };
  const taken = new Set([seed]);
  const near = new Set<PlannableStop>();
  const meet = (added: PlannableStop) => {
    for (const stop of others) if (!near.has(stop) && drive(stop, added) <= neighbourMinutes) near.add(stop);
  };
  meet(seed);

  for (;;) {
    let best: { stop: PlannableStop; next: Draft } | null = null;
    for (const stop of [...own, ...near]) {
      if (taken.has(stop)) continue;
      const next = withVisit(day, stop, limits, drive);
      if (next && (!best || next.drive < best.next.drive)) best = { stop, next };
    }
    if (!best || acrossTown(day, best.next.drive - day.drive, limits)) break;
    day = best.next;
    taken.add(best.stop);
    meet(best.stop);
  }
  return day;
}

/**
 * A day short of the minimum, brought up to it with the nearest of what nobody
 * else's zone needed that day: a crew member whose zone ran out still has a full
 * day, as the office wants, rather than going home at lunch.
 */
function toppedUp(day: Draft, pool: readonly PlannableStop[], limits: DayLimits, drive: DriveEstimate): Draft {
  let topped = day;
  const left = new Set(pool);
  while (topped.path.length < limits.minStopsPerDay) {
    let best: { stop: PlannableStop; next: Draft } | null = null;
    for (const stop of left) {
      const next = withVisit(topped, stop, limits, drive);
      if (next && (!best || next.drive < best.next.drive)) best = { stop, next };
    }
    if (!best) break;
    topped = best.next;
    left.delete(best.stop);
  }
  return topped;
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

/** The visits in a chain, each the nearest to the one before, from the one nearest `start`. */
function chained(stops: readonly PlannableStop[], start: Point | undefined, drive: DriveEstimate) {
  const left = new Set(stops);
  let from: Point | undefined = start;
  const chain: PlannableStop[] = [];
  while (left.size) {
    let next: PlannableStop | null = null;
    for (const stop of left) if (!next || (from && drive(from, stop) < drive(from, next))) next = stop;
    chain.push(next!);
    left.delete(next!);
    from = next!;
  }
  return chain;
}

/**
 * A far zone's visits as a trip: back-to-back days of one crew member.
 *
 * The crew member living nearest the zone goes, on the first run of days in a
 * row they are free and qualified for all of it; with no run for them, the next
 * nearest. The visits are chained nearest to nearest from the one nearest their
 * home, cut into the trip's days, and the days improved together.
 */
function planTrip(
  zone: string,
  members: readonly PlannableStop[],
  days: readonly PlannableDay[],
  crew: readonly string[],
  context: {
    limits: DayLimits;
    drive: DriveEstimate;
    homes: ReadonlyMap<string, Point> | undefined;
    unavailable: (key: string) => boolean;
  },
): AssignedCrew[] | null {
  const { limits, drive, homes } = context;
  const onSite = members.reduce((total, stop) => total + stop.onSiteMinutes, 0);
  const count = Math.max(Math.ceil(members.length / stopsCap(limits)), Math.ceil(onSite / limits.maxOnSiteMinutes));
  const middle = {
    latitude: members.reduce((total, stop) => total + stop.latitude, 0) / members.length,
    longitude: members.reduce((total, stop) => total + stop.longitude, 0) / members.length,
  };
  const fromHome = (technicianId: string) => {
    const home = homes?.get(technicianId);
    return home ? haversineMeters(home, middle) : Number.POSITIVE_INFINITY;
  };
  // Stable, so the crew's own order settles a tie and puts anyone without a home last.
  for (const technicianId of [...crew].sort((left, right) => fromHome(left) - fromHome(right))) {
    const run = firstRun(
      days,
      count,
      (day) =>
        !context.unavailable(crewKey(day.date, technicianId)) &&
        members.every((stop) => qualified(day, technicianId, stop)),
    );
    if (!run) continue;
    const chain = chained(members, homes?.get(technicianId), drive);
    const size = Math.ceil(chain.length / count);
    const working: Working[] = run.map((day, index) => ({
      date: day.date,
      technicianId,
      day,
      zone,
      path: chain.slice(index * size, (index + 1) * size),
      drive: 0,
      onSite: 0,
    }));
    improveWorking(working, { limits, drive, allows: () => true });
    const trip = working.filter((day) => day.path.length > 0);
    return trip.map((day, index) => ({
      date: day.date,
      technicianId,
      stops: day.path,
      onSiteMinutes: day.onSite,
      driveMinutes: day.drive,
      trip: { zone, day: index + 1, days: trip.length },
    }));
  }
  return null;
}

/**
 * Give every stop a day and a technician: the whole crew every planned day, from
 * the quarter's first, until every visit has one.
 *
 * 0. A far zone's visits are a trip, on back-to-back days fixed first
 *    (`planTrip`).
 * 1. Then day by day. First each crew member with a move-out that day, whose day
 *    takes the visits nearest it from any zone (`fillAroundAnchors`); then
 *    whoever still has visits in their zone of the week, and then everyone
 *    else, each day grown from the earliest visit left in their zone, taking
 *    neighbours from other zones as it goes (`growDay`, `zoneForDay`); and last,
 *    a day short of the minimum topped up with the nearest of what is left
 *    (`toppedUp`).
 * 2. The days are improved together (`improveWorking`): a visit may move to a day
 *    of its own zone, or to one where it is a neighbour.
 */
export function layoutEveryDay(
  stops: readonly PlannableStop[],
  days: readonly PlannableDay[],
  options: LayoutOptions = {},
): QuarterAssignment {
  const limits = options.limits ?? DEFAULT_DAY_LIMITS;
  const drive = remembered(options.driveMinutes ?? estimatedDriveMinutes);
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

  // Last quarter's order: whoever was first then is first now.
  const place = new Map(stops.map((stop, index) => [stop.stopId, options.rotation?.position.get(stop.stopId) ?? index]));
  const ordered = [...stops].sort(
    (left, right) => place.get(left.stopId)! - place.get(right.stopId)! || left.sequence - right.sequence,
  );
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

  // 0. Trips, on days fixed before anything else is laid out.
  const crew = [...new Set(days.flatMap((day) => day.technicianIds))];
  const onTrip = new Set<string>();
  for (const zone of [...new Set(options.tripZones ?? [])].sort()) {
    const members = [...left].filter((stop) => zoneOf(stop) === zone);
    if (members.length === 0) continue;
    for (const stop of members) left.delete(stop);
    const trip = planTrip(zone, members, days, crew, {
      limits,
      drive,
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

  // 1. Every crew member, every planned day, until nothing is left: each day's
  // move-outs and zones first -- whoever still has visits in their own zone
  // before anyone helping out -- and then short days topped up with the rest.
  const zoned = days.some((day) => day.zoneTechnicians);
  const working: Working[] = [];
  const poolFor = (day: PlannableDay, technicianId: string) => [...left].filter((stop) => qualified(day, technicianId, stop));
  for (const day of days) {
    const owners = day.zoneTechnicians ?? {};
    const hasOwnZone = (technicianId: string) =>
      [...left].some((stop) => owners[zoneOf(stop)] === technicianId && qualified(day, technicianId, stop));
    const free = day.technicianIds.filter((technicianId) => {
      const key = crewKey(day.date, technicianId);
      return !options.taken?.has(key) && !onTrip.has(key);
    });
    const order = [
      ...free.filter((technicianId) => anchored.has(crewKey(day.date, technicianId))),
      ...free.filter((technicianId) => !anchored.has(crewKey(day.date, technicianId)) && hasOwnZone(technicianId)),
      ...free.filter((technicianId) => !anchored.has(crewKey(day.date, technicianId)) && !hasOwnZone(technicianId)),
    ];
    const todays: Working[] = [];
    for (const technicianId of order) {
      const pool = poolFor(day, technicianId);
      const dayAnchors = anchored.get(crewKey(day.date, technicianId));
      if (dayAnchors) {
        const filled = fillAroundAnchors(dayAnchors, pool, limits, drive);
        for (const visit of filled.visits) left.delete(visit);
        crews.push({
          date: day.date,
          technicianId,
          stops: filled.visits,
          onSiteMinutes: filled.onSite,
          driveMinutes: filled.drive,
          anchors: dayAnchors,
        });
        continue;
      }
      if (pool.length === 0) continue;
      const zone = zoned ? zoneForDay(day, technicianId, pool, options.homes?.get(technicianId)) : null;
      const grown = growDay(zone, pool, limits, drive, neighbourMinutes);
      for (const visit of grown.path) left.delete(visit);
      todays.push({ date: day.date, technicianId, day, zone, ...grown });
    }
    for (const today of todays) {
      if (today.path.length >= limits.minStopsPerDay) continue;
      const topped = toppedUp(today, poolFor(day, today.technicianId), limits, drive);
      for (const visit of topped.path) left.delete(visit);
      Object.assign(today, topped);
    }
    working.push(...todays);
  }
  for (const stop of left) unplaced.push({ stopId: stop.stopId, reason: 'NO_CAPACITY' });

  // 2. The least driving, and every day brought up to the minimum where it can
  // be: a zone's days together, as a visit moves only to a day of its own zone
  // or one it is a neighbour of -- which, but for a day's edges, is its zone's.
  const neighbour = (stop: PlannableStop, path: readonly PlannableStop[]) =>
    path.some((other) => other !== stop && drive(stop, other) <= neighbourMinutes);
  const byZone = new Map<string, Working[]>();
  for (const day of working) byZone.set(day.zone ?? '', [...(byZone.get(day.zone ?? '') ?? []), day]);
  for (const zoneDays of byZone.values())
    improveWorking(zoneDays, {
      limits,
      drive,
      allows: (stop, day) =>
        qualified(day.day, day.technicianId, stop) &&
        (day.zone === null || zoneOf(stop) === day.zone || neighbour(stop, day.path)),
    });
  for (const day of working)
    if (day.path.length)
      crews.push({ date: day.date, technicianId: day.technicianId, stops: day.path, onSiteMinutes: day.onSite, driveMinutes: day.drive });

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
