/**
 * Laying a quarter's stops out over technician-days.
 *
 * Pure and dependency-free, like the rotation beside it, so the decisions here
 * can be argued with in a test rather than inferred from a plan somebody has
 * already published.
 *
 * ## The office's rules (2026-09-17)
 *
 * - **Nine to twelve visits every day** (`minStopsPerDay`, `maxStopsPerDay`). A
 *   visit takes eight to fifteen minutes, twenty at most, so nine a day is always
 *   doable: the days are made full first, and the driving is what is kept as
 *   short as the visits allow. There is no limit on the drive between a day's
 *   properties; a day is never left short of nine to keep it down.
 * - At most six hours inspecting, which twelve twenty-minute visits never reach.
 * - Each week each technician on the crew has one zone (`zoneTechnicians`, from
 *   `weeklyZoneTechnicians`), and a visit goes only to whoever has its zone.
 * - A visit stays within three weeks of last quarter's week (`WINDOW_DAYS`), so a
 *   tenant's visits stay about ninety days apart. Only a visit that would
 *   otherwise leave a day short of nine goes further.
 * - **Move-outs are anchors** (`DayAnchor`): on a day the technician who handles
 *   move-outs has one, the day's visits are the ones nearest it, from any zone,
 *   and the move-out counts an hour on site (the office, 2026-09-17: "we should
 *   be doing TBPs around those").
 *
 * ## Full days, then the least driving
 *
 * Each zone's days are grown nearest first from the visit due earliest, a short
 * day is folded into the zone's others, and each day is given a day of the week.
 * Grown greedily, a day takes whatever is near at the time: with the old ninety
 * minutes lifted, that alone made days of up to 204 minutes between properties
 * on the Q4 2026 visits. So the days are then improved (`improveDays`): a visit
 * moves, or two visits trade places, between a zone's days near their weeks
 * whenever that shortens the driving, and a day still short of nine takes the
 * cheapest visits from its zone's fuller days. The same visits came out as 37
 * days of 10.6 visits and 89 minutes between properties a day, where the
 * ninety-minute limit had made 47 days of 8.3, 24 of them short of nine (dry run
 * on the production plan, 2026-09-17).
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
   * Absent: days are not given out by zone, and anyone available can take a stop.
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
 * How far a visit may move from its day in last quarter's rotation, in calendar
 * days: three weeks (the office, 2026-09-17). Two left the thin zones unable to
 * make days of nine.
 */
export const WINDOW_DAYS = 21;

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

export type UnplacedReason = 'NO_WORKING_DAYS' | 'NO_QUALIFIED_TECHNICIAN' | 'NO_CAPACITY' | 'LONGER_THAN_A_DAY';

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
  /**
   * Each stop's place in the whole quarter's rotation, and the rotation's size:
   * a stop at position i of n is due i/n of the way through the quarter's days.
   * Without it, the stops given are the rotation, in the order given.
   */
  rotation?: { position: ReadonlyMap<string, number>; size: number };
  /** How far a visit may move from its day in the rotation, in calendar days. */
  windowDays?: number;
  /** Technician-days already taken, as `date|technicianId`: a coordinator's own days. */
  taken?: ReadonlySet<string>;
  /**
   * Appointments days are built around. On each one's date its technician's day
   * takes the visits nearest it, from any zone, before the zones are laid out.
   */
  anchors?: readonly DayAnchor[];
}

const DAY_MS = 86_400_000;

/**
 * What a day that already has its nine may still take: a visit adding no more
 * driving than this, or twice the day's average leg where the day is spread
 * out. A visit across town starts a day of its own instead of stretching a
 * full day to twelve and leaving its neighbours a short one.
 */
const LOCAL_HOP_MINUTES = 15;

/** A saving smaller than this, in estimated minutes, is noise rather than a shorter day. */
const SAVING_MINUTES = 0.5;

/** Changes made across one set of days. Each only ever shortens the driving; this bounds a pathological case. */
const MAX_IMPROVEMENT_ROUNDS = 2000;

/**
 * How many windows from its week a visit may go to keep a day from falling short
 * of the minimum: two, six weeks. Unbounded, a move-out day that took a thin
 * zone's December visits pushed the last three to October, 49 to 76 days early,
 * and a tenant visited that far off their cycle is worse off than a short day
 * (dry run on the production Q4 plan, 2026-09-17).
 */
const LEFTOVER_REACH = 2;

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

/** When each stop is due: its share of the rotation, as a day of the quarter. */
function dueDates(stops: readonly PlannableStop[], days: readonly PlannableDay[], rotation: LayoutOptions['rotation']) {
  const size = Math.max(1, rotation?.size ?? stops.length);
  return new Map(
    stops.map((stop, index) => {
      const position = rotation?.position.get(stop.stopId) ?? index;
      const day = days[Math.min(days.length - 1, Math.max(0, Math.floor((position * days.length) / size)))]!;
      return [stop.stopId, Date.parse(`${day.date}T00:00:00Z`)];
    }),
  );
}

const midpoint = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Whether a technician may take a stop on a day: available, qualified for its kind, and holding its zone. */
function canTake(day: PlannableDay, technicianId: string, stop: PlannableStop) {
  const list = day.qualified?.[stop.inspectionType];
  if (!day.technicianIds.includes(technicianId) || (list && !list.includes(technicianId))) return false;
  return !day.zoneTechnicians || day.zoneTechnicians[stop.zone ?? ''] === technicianId;
}

/** A technician-day being improved. */
interface Working {
  date: string;
  technicianId: string;
  day: PlannableDay;
  time: number;
  path: PlannableStop[];
  drive: number;
  onSite: number;
}

interface ImproveContext {
  limits: DayLimits;
  drive: DriveEstimate;
  window: number;
  dueOf: (stop: PlannableStop) => number;
}

/**
 * Shorten the driving across a set of days, and bring short ones up to the minimum.
 *
 * 1. A visit moves to another day, or two visits trade days, whenever that
 *    shortens the two days' driving together -- to a day whose technician can
 *    take it and that is near the visit's week, never taking a day under the
 *    minimum or over the maximum.
 * 2. A day still short takes the cheapest visits from fuller days near their
 *    weeks, when they have enough to bring it to the minimum. Otherwise its
 *    visits go to days with room: near their weeks if they can, and otherwise the
 *    day nearest in time up to `LEFTOVER_REACH` windows away -- a day of nine
 *    comes first, but not at the cost of a tenant's quarterly rhythm.
 * 3. The moves and swaps again, around what that changed.
 */
function improveWorking(days: Working[], { limits, drive, window, dueOf }: ImproveContext) {
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
  const near = (stop: PlannableStop, day: Working, span = window) =>
    canTake(day.day, day.technicianId, stop) && Math.abs(day.time - dueOf(stop)) <= span;
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
            if (to === from || to.path.length === 0 || !roomFor(to, stop) || !near(stop, to)) continue;
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
            if (!near(one, right)) continue;
            const outOfLeft = removalSaving(left.path, one, drive);
            const intoRight = cheapestInsertion(right.path, one, drive).added;
            for (const other of right.path) {
              if (
                !near(other, left) ||
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
          : total + Math.min(Math.max(0, donor.path.length - limits.minStopsPerDay), donor.path.filter((stop) => near(stop, short)).length),
      0,
    );
    if (spare >= needed)
      while (short.path.length < limits.minStopsPerDay) {
        let pick: { stop: PlannableStop; donor: Working; price: number } | null = null;
        for (const donor of days) {
          if (donor === short || donor.path.length <= limits.minStopsPerDay) continue;
          for (const stop of donor.path) {
            if (!near(stop, short) || !roomFor(short, stop)) continue;
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

    for (const span of [window, LEFTOVER_REACH * window]) {
      const room = new Map(days.map((day) => [day, { count: day.path.length, onSite: day.onSite }]));
      const moves: [PlannableStop, Working][] = [];
      for (const stop of short.path) {
        const target = days
          .filter((day) => {
            const left = room.get(day)!;
            return (
              day !== short &&
              day.path.length > 0 &&
              near(stop, day, span) &&
              left.count < cap &&
              left.onSite + stop.onSiteMinutes <= limits.maxOnSiteMinutes
            );
          })
          .map((day) => ({
            day,
            // Near its week first; beyond it, the day nearest in time.
            weeks: Math.abs(day.time - dueOf(stop)) <= window ? 0 : Math.abs(day.time - dueOf(stop)),
            added: cheapestInsertion(day.path, stop, drive).added,
          }))
          .sort((left, right) => left.weeks - right.weeks || left.added - right.added)[0]?.day;
        if (!target) break;
        room.get(target)!.count += 1;
        room.get(target)!.onSite += stop.onSiteMinutes;
        moves.push([stop, target]);
      }
      if (moves.length !== short.path.length) continue;
      for (const [stop, target] of moves) set(target, [...target.path, stop]);
      set(short, []);
      break;
    }
  }

  search();
}

/**
 * Days made better where they stand: the driving shortened, and short days
 * brought up to the minimum, without a day moving date or technician.
 *
 * What `layoutFullDays` does last, for days a caller already has. A stop is due
 * on its rotation day when a rotation is given, and otherwise on the day it is
 * on now, so none moves further than the window from where it is.
 */
export function improveDays(
  crews: readonly AssignedCrew[],
  days: readonly PlannableDay[],
  options: LayoutOptions = {},
): AssignedCrew[] {
  const limits = options.limits ?? DEFAULT_DAY_LIMITS;
  const drive = options.driveMinutes ?? estimatedDriveMinutes;
  const dayOf = new Map(days.map((day) => [day.date, day]));
  const rotationDue = options.rotation
    ? dueDates(
        crews.flatMap((crew) => crew.stops),
        days,
        options.rotation,
      )
    : null;
  const current = new Map(crews.flatMap((crew) => crew.stops.map((stop) => [stop.stopId, dayTime(crew.date)] as const)));
  // A day built around an anchor is left as it is: its visits are there for the anchor.
  const anchored = (crew: AssignedCrew) => Boolean(crew.anchors?.length);
  const working: Working[] = crews.flatMap((crew) => {
    const day = dayOf.get(crew.date);
    return day && !anchored(crew)
      ? [{ date: crew.date, technicianId: crew.technicianId, day, time: dayTime(crew.date), path: [...crew.stops], drive: crew.driveMinutes, onSite: crew.onSiteMinutes }]
      : [];
  });
  improveWorking(working, {
    limits,
    drive,
    window: (options.windowDays ?? WINDOW_DAYS) * DAY_MS,
    dueOf: (stop) => rotationDue?.get(stop.stopId) ?? current.get(stop.stopId)!,
  });
  const untouched = crews.filter((crew) => !dayOf.has(crew.date) || anchored(crew));
  return [
    ...working
      .filter((day) => day.path.length > 0)
      .map((day) => ({ date: day.date, technicianId: day.technicianId, stops: day.path, onSiteMinutes: day.onSite, driveMinutes: day.drive })),
    ...untouched,
  ].sort((left, right) => left.date.localeCompare(right.date) || left.technicianId.localeCompare(right.technicianId));
}

/**
 * Give every stop a day and a technician: full days, by zone, near their week,
 * for the least driving.
 *
 * 0. A day with an anchor comes first: its technician's day on the anchor's date
 *    takes the visits nearest the anchor that are due inside the window, from
 *    any zone (`fillAroundAnchors`), and those visits and that day are out of
 *    the zones' layout.
 *
 * Then each zone on its own, because only its technician of the week can take it:
 * 1. Days are grown from the stop due earliest, adding whichever stop due inside
 *    the window adds least driving, until the day is full -- or, once it has its
 *    nine, until the next would take it across town (`LOCAL_HOP_MINUTES`).
 * 2. A day short of `minStopsPerDay` gives its stops to the zone's other days when
 *    all of them fit, moving one stop of a full day on to a third to make room;
 *    or joins another short day when the two fit as one.
 * 3. Each day then takes the day of the week its zone's technician works that is
 *    nearest the middle of its stops' due dates.
 * 4. The zone's days are improved (`improveDays`).
 */
export function layoutFullDays(
  stops: readonly PlannableStop[],
  days: readonly PlannableDay[],
  options: LayoutOptions = {},
): QuarterAssignment {
  const limits = options.limits ?? DEFAULT_DAY_LIMITS;
  const drive = options.driveMinutes ?? estimatedDriveMinutes;
  const window = (options.windowDays ?? WINDOW_DAYS) * DAY_MS;
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

  const due = dueDates(stops, days, options.rotation);
  const dueOf = (stop: PlannableStop) => due.get(stop.stopId)!;
  const byRotation = [...stops].sort((left, right) => dueOf(left) - dueOf(right) || left.sequence - right.sequence);
  const zoned = days.some((day) => day.zoneTechnicians);
  const qualified = (day: PlannableDay, technicianId: string, stop: PlannableStop) => {
    const list = day.qualified?.[stop.inspectionType];
    return day.technicianIds.includes(technicianId) && (!list || list.includes(technicianId));
  };

  const crews: AssignedCrew[] = [];

  // 0. Days built around anchors, earliest first.
  const dayOn = new Map(days.map((day) => [day.date, day]));
  const anchorDays = new Map<string, DayAnchor[]>();
  for (const anchor of options.anchors ?? []) {
    const key = crewKey(anchor.date, anchor.technicianId);
    anchorDays.set(key, [...(anchorDays.get(key) ?? []), anchor]);
  }
  const anchoredDays = new Set<string>();
  const anchoredVisits = new Set<PlannableStop>();
  for (const [key, dayAnchors] of [...anchorDays].sort(([left], [right]) => left.localeCompare(right))) {
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
    if (reason || !day) {
      for (const anchor of dayAnchors) skippedAnchors.push({ anchorId: anchor.id, reason: reason ?? 'NOT_A_PLANNED_DAY' });
      continue;
    }
    const time = dayTime(date);
    const candidates = byRotation.filter(
      (stop) =>
        !anchoredVisits.has(stop) &&
        stop.onSiteMinutes <= limits.maxOnSiteMinutes &&
        qualified(day, technicianId, stop) &&
        Math.abs(dueOf(stop) - time) <= window,
    );
    const filled = fillAroundAnchors(dayAnchors, candidates, limits, drive);
    for (const visit of filled.visits) anchoredVisits.add(visit);
    anchoredDays.add(key);
    crews.push({
      date,
      technicianId,
      stops: filled.visits,
      onSiteMinutes: filled.onSite,
      driveMinutes: filled.drive,
      anchors: dayAnchors,
    });
  }

  const groups = [...new Set(byRotation.map((stop) => (zoned ? (stop.zone ?? '') : '')))];
  for (const group of groups) {
    const slots = days.flatMap((day) =>
      (zoned ? (day.zoneTechnicians?.[group] ? [day.zoneTechnicians[group]!] : []) : day.technicianIds)
        .filter(
          (technicianId) =>
            day.technicianIds.includes(technicianId) &&
            !options.taken?.has(crewKey(day.date, technicianId)) &&
            !anchoredDays.has(crewKey(day.date, technicianId)),
        )
        .map((technicianId) => ({ day, technicianId, time: dayTime(day.date) })),
    );
    const members = byRotation.filter(
      (stop) => (zoned ? (stop.zone ?? '') : '') === group && !anchoredVisits.has(stop),
    );
    const placeable: PlannableStop[] = [];
    for (const stop of members) {
      if (stop.onSiteMinutes > limits.maxOnSiteMinutes) unplaced.push({ stopId: stop.stopId, reason: 'LONGER_THAN_A_DAY' });
      else if (!slots.some((slot) => qualified(slot.day, slot.technicianId, stop)))
        unplaced.push({ stopId: stop.stopId, reason: 'NO_QUALIFIED_TECHNICIAN' });
      else placeable.push(stop);
    }

    // 1. Grow full days from the stop due earliest.
    const left = new Set(placeable);
    let drafts: Draft[] = [];
    for (const seed of placeable) {
      if (!left.has(seed)) continue;
      left.delete(seed);
      let day: Draft = { path: [seed], drive: 0, onSite: seed.onSiteMinutes };
      const candidates = placeable.filter((stop) => left.has(stop) && Math.abs(dueOf(stop) - dueOf(seed)) <= window);
      for (;;) {
        let best: { stop: PlannableStop; next: Draft } | null = null;
        for (const stop of candidates) {
          if (!left.has(stop)) continue;
          const next = withVisit(day, stop, limits, drive);
          if (next && (!best || next.drive - day.drive < best.next.drive - day.drive)) best = { stop, next };
        }
        if (!best) break;
        const averageLeg = day.path.length > 1 ? day.drive / (day.path.length - 1) : 0;
        if (day.path.length >= limits.minStopsPerDay && best.next.drive - day.drive > Math.max(LOCAL_HOP_MINUTES, 2 * averageLeg)) break;
        day = best.next;
        left.delete(best.stop);
      }
      drafts.push(day);
    }

    // 2. Fold short days away.
    const middle = (day: Draft) => midpoint(day.path.map(dueOf));
    const inWindow = (stop: PlannableStop, day: Draft) => Math.abs(dueOf(stop) - middle(day)) <= window;
    const nearestOther = (stop: PlannableStop, others: readonly Draft[]) =>
      Math.min(...others.flatMap((day) => day.path.map((other) => haversineMeters(stop, other))));
    for (let changed = true; changed; ) {
      changed = false;
      const shorts = drafts.filter((day) => day.path.length < limits.minStopsPerDay).sort((a, b) => a.path.length - b.path.length);
      for (const short of shorts) {
        if (!drafts.includes(short)) continue;
        const others = drafts.filter((day) => day !== short);
        if (others.length === 0) break;
        const trial = new Map(others.map((day) => [day, { ...day, path: [...day.path] }]));
        // The stop hardest to place first: the one farthest from every other day.
        const toMove = [...short.path].sort((a, b) => nearestOther(b, others) - nearestOther(a, others));
        let folded = true;
        for (const stop of toMove) {
          let best: { day: Draft; next: Draft } | null = null;
          for (const day of others) {
            const state = trial.get(day)!;
            if (!inWindow(stop, state)) continue;
            const next = withVisit(state, stop, limits, drive);
            if (next && (!best || next.drive - state.drive < best.next.drive - trial.get(best.day)!.drive)) best = { day, next };
          }
          if (!best)
            // Room made in a full day: one of its stops moves on to a third day.
            for (const day of others) {
              const state = trial.get(day)!;
              if (!inWindow(stop, state)) continue;
              for (const bumped of state.path) {
                const rest = polished(state.path.filter((other) => other !== bumped), drive);
                const next = withVisit({ ...rest, onSite: state.onSite - bumped.onSiteMinutes }, stop, limits, drive);
                if (!next) continue;
                const third = others.find(
                  (other) => other !== day && inWindow(bumped, trial.get(other)!) && withVisit(trial.get(other)!, bumped, limits, drive),
                );
                if (!third) continue;
                trial.set(third, withVisit(trial.get(third)!, bumped, limits, drive)!);
                best = { day, next };
                break;
              }
              if (best) break;
            }
          if (!best) {
            folded = false;
            break;
          }
          trial.set(best.day, best.next);
        }
        if (folded) {
          drafts = others.map((day) => trial.get(day)!);
          changed = true;
          continue;
        }
        for (const other of drafts.filter((day) => day !== short && day.path.length < limits.minStopsPerDay)) {
          const merged = polished([...short.path, ...other.path], drive);
          const onSite = short.onSite + other.onSite;
          if (merged.path.length > stopsCap(limits) || onSite > limits.maxOnSiteMinutes) continue;
          const day = { ...merged, onSite };
          if (!day.path.every((stop) => inWindow(stop, day))) continue;
          drafts = [...drafts.filter((existing) => existing !== short && existing !== other), day];
          changed = true;
          break;
        }
      }
    }

    // 3. A day of the week for each: the zone's technician's, nearest its stops' middle due date.
    const free = [...slots];
    const working: Working[] = [];
    for (const day of [...drafts].sort((a, b) => middle(a) - middle(b))) {
      const fits = free.filter((slot) => day.path.every((stop) => qualified(slot.day, slot.technicianId, stop)));
      if (fits.length === 0) {
        const reason = free.length ? 'NO_QUALIFIED_TECHNICIAN' : 'NO_CAPACITY';
        for (const stop of day.path) unplaced.push({ stopId: stop.stopId, reason });
        continue;
      }
      const want = middle(day);
      const slot = fits.reduce((best, candidate) => (Math.abs(candidate.time - want) < Math.abs(best.time - want) ? candidate : best));
      free.splice(free.indexOf(slot), 1);
      working.push({ date: slot.day.date, technicianId: slot.technicianId, day: slot.day, time: slot.time, ...day });
    }

    // 4. The least driving, and every day brought up to the minimum where the zone's visits allow it.
    improveWorking(working, { limits, drive, window, dueOf });
    for (const day of working)
      if (day.path.length)
        crews.push({ date: day.date, technicianId: day.technicianId, stops: day.path, onSiteMinutes: day.onSite, driveMinutes: day.drive });
  }

  crews.sort((left, right) => left.date.localeCompare(right.date) || left.technicianId.localeCompare(right.technicianId));
  const placed = crews.flatMap((crew) =>
    crew.stops.map((stop, index) => ({ stopId: stop.stopId, date: crew.date, technicianId: crew.technicianId, position: index + 1 })),
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
