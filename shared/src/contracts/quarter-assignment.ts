/**
 * Spreading a quarter's stops across working days and technicians.
 *
 * Pure and dependency-free, like the rotation beside it, so the decisions here
 * can be argued with in a test rather than inferred from a plan somebody has
 * already published.
 *
 * ## Why there is no clustering pass
 *
 * The obvious design is k-means over every stop in the quarter, then a routing
 * pass per cluster. It is not what this does, because the input is already
 * clustered and re-clustering it would throw that away.
 *
 * The office sequences benefit-package visits **by zone**, and it shows in
 * their own calendar: of the first fifteen days of live TBP visits, eight
 * covered a single zone and the rest covered two. `Zone 1` is written into the
 * visit titles. The rotation order inherits that grouping — it was recovered
 * from those visits in the first place, and carried forward every quarter after
 * — so consecutive stops in the rotation are usually neighbours already.
 *
 * That makes the honest algorithm a simple one: keep the order, cut it into
 * days, and only decide geography *within* a day, which is the only place drive
 * time actually accrues. A technician drives between their own stops, never
 * between days.
 */

import { haversineMeters } from './route-plan.js';

/** A stop that can be placed: it has a rotation position and a location. */
export interface PlannableStop {
  stopId: string;
  /** 1-based rotation position, from `carryForwardOrder`. */
  sequence: number;
  latitude: number;
  longitude: number;
}

export interface PlannableTechnician {
  technicianId: string;
  /**
   * How many benefit-package stops this person takes in a day.
   *
   * Ten by default rather than seven. Seven would keep every day inside
   * `MAX_EXACT_STOPS`, where `shortestRouteOrder` solves exactly — but the
   * office's own calendar runs five to twelve, and booking a day they would
   * never book is a worse error than ordering ten stops with nearest-neighbour
   * and 2-opt instead of by exhaustive search.
   */
  dailyStopCap: number;
}

/** One working day, and who may take an occupied inspection on it. */
export interface PlannableDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Qualified *and* available that day — expiry is evaluated per date. */
  technicianIds: string[];
}

export interface PlacedStop {
  stopId: string;
  date: string;
  technicianId: string;
  /** 1-based position within that technician's day. */
  position: number;
}

export type UnplacedReason = 'NO_WORKING_DAYS' | 'NO_QUALIFIED_TECHNICIAN' | 'NO_CAPACITY';

export interface QuarterAssignment {
  placed: PlacedStop[];
  unplaced: { stopId: string; reason: UnplacedReason }[];
  /** Demand against what the quarter could hold, for the capacity warning. */
  capacity: { stops: number; slots: number };
}

export const DEFAULT_DAILY_STOP_CAP = 10;

/**
 * Assign every stop a day, a technician, and a position in that day.
 *
 * Stops arrive in rotation order and keep it: stop *i* of *n* lands on the day
 * *i/n* of the way through the quarter. Nothing here reorders the rotation to
 * suit a route — the office's order is a promise to a tenant about roughly when
 * somebody will knock, and drive time is not a good enough reason to break it.
 */
export function assignQuarter(
  stops: readonly PlannableStop[],
  technicians: readonly PlannableTechnician[],
  days: readonly PlannableDay[],
  sequenceDay: (dayStops: readonly PlannableStop[]) => PlannableStop[] = nearestNeighbourOrder,
): QuarterAssignment {
  const capacity = { stops: stops.length, slots: totalSlots(technicians, days) };
  if (stops.length === 0) return { placed: [], unplaced: [], capacity };
  if (days.length === 0)
    return {
      placed: [],
      unplaced: stops.map((stop) => ({ stopId: stop.stopId, reason: 'NO_WORKING_DAYS' as const })),
      capacity,
    };

  const capOf = new Map(technicians.map((tech) => [tech.technicianId, tech.dailyStopCap]));
  const ordered = [...stops].sort((left, right) => left.sequence - right.sequence);

  // Which day strict rotation puts each stop on. Spread across the quarter
  // rather than packed to capacity from day one: the programme runs all quarter
  // and finishing in three weeks would leave nine with nobody to inspect.
  const buckets: PlannableStop[][] = Array.from({ length: days.length }, () => []);
  const unplaced: { stopId: string; reason: UnplacedReason }[] = [];

  for (const [index, stop] of ordered.entries()) {
    const target = Math.min(
      days.length - 1,
      Math.floor((index * days.length) / ordered.length),
    );
    const placedOn = nearestDayWithRoom(buckets, days, capOf, target);
    if (placedOn === null) {
      unplaced.push({
        stopId: stop.stopId,
        reason: days.some((day) => dayCapacity(day, capOf) > 0)
          ? 'NO_CAPACITY'
          : 'NO_QUALIFIED_TECHNICIAN',
      });
      continue;
    }
    buckets[placedOn].push(stop);
  }

  const placed: PlacedStop[] = [];
  for (const [index, dayStops] of buckets.entries()) {
    if (dayStops.length === 0) continue;
    for (const crew of splitAmongTechnicians(dayStops, days[index].technicianIds, capOf)) {
      sequenceDay(crew.stops).forEach((stop, position) => {
        placed.push({
          stopId: stop.stopId,
          date: days[index].date,
          technicianId: crew.technicianId,
          position: position + 1,
        });
      });
    }
  }

  return { placed, unplaced, capacity };
}

/**
 * The day nearest the rotation's choice that still has room.
 *
 * Searches outward rather than only forward, so a full week does not push every
 * later stop back and cascade the whole quarter. A stop that cannot sit on its
 * own day is better a day early than a fortnight late.
 */
function nearestDayWithRoom(
  buckets: readonly PlannableStop[][],
  days: readonly PlannableDay[],
  capOf: ReadonlyMap<string, number>,
  target: number,
): number | null {
  for (let offset = 0; offset < days.length; offset += 1) {
    for (const candidate of offset === 0 ? [target] : [target - offset, target + offset]) {
      if (candidate < 0 || candidate >= days.length) continue;
      if (buckets[candidate].length < dayCapacity(days[candidate], capOf)) return candidate;
    }
  }
  return null;
}

function dayCapacity(day: PlannableDay, capOf: ReadonlyMap<string, number>): number {
  return day.technicianIds.reduce(
    (total, id) => total + (capOf.get(id) ?? DEFAULT_DAILY_STOP_CAP),
    0,
  );
}

function totalSlots(
  technicians: readonly PlannableTechnician[],
  days: readonly PlannableDay[],
): number {
  const capOf = new Map(technicians.map((tech) => [tech.technicianId, tech.dailyStopCap]));
  return days.reduce((total, day) => total + dayCapacity(day, capOf), 0);
}

export interface TechnicianDay {
  technicianId: string;
  stops: PlannableStop[];
}

/**
 * Split one day's stops between the technicians working it.
 *
 * Geography decides here and only here. The stops of a single day are usually
 * one or two zones already, so this is a short walk rather than a clustering
 * problem: seed each technician with the stop furthest from the others, then
 * give every remaining stop to whichever crew it is nearest.
 *
 * Deterministic throughout — the seeds are chosen by distance and ties fall to
 * the stop order, which is itself the rotation.
 */
export function splitAmongTechnicians(
  dayStops: readonly PlannableStop[],
  technicianIds: readonly string[],
  capOf: ReadonlyMap<string, number>,
): TechnicianDay[] {
  if (technicianIds.length === 0) return [];

  // Only open as many crews as the day actually needs. Spreading six stops
  // across four technicians gives four people a half-empty drive each.
  const needed = Math.max(
    1,
    Math.min(
      technicianIds.length,
      minimumCrews(dayStops.length, technicianIds, capOf),
    ),
  );
  const crews: TechnicianDay[] = technicianIds
    .slice(0, needed)
    .map((technicianId) => ({ technicianId, stops: [] }));
  if (crews.length === 1) return [{ technicianId: crews[0].technicianId, stops: [...dayStops] }];

  const remaining = [...dayStops];
  // Seed each crew with the stop furthest from every seed already chosen, so
  // two crews never start next door to each other and then interleave.
  for (const crew of crews) {
    const seeds = crews.flatMap((other) => other.stops);
    const pick = seeds.length === 0 ? 0 : indexOfFurthest(remaining, seeds);
    crew.stops.push(...remaining.splice(pick, 1));
  }

  for (const stop of remaining) {
    const open = crews.filter(
      (crew) => crew.stops.length < (capOf.get(crew.technicianId) ?? DEFAULT_DAILY_STOP_CAP),
    );
    const target = (open.length > 0 ? open : crews).reduce((best, crew) =>
      distanceToCrew(stop, crew) < distanceToCrew(stop, best) ? crew : best,
    );
    target.stops.push(stop);
  }

  return crews.filter((crew) => crew.stops.length > 0);
}

function minimumCrews(
  stopCount: number,
  technicianIds: readonly string[],
  capOf: ReadonlyMap<string, number>,
): number {
  let covered = 0;
  let crews = 0;
  for (const id of technicianIds) {
    if (covered >= stopCount) break;
    covered += capOf.get(id) ?? DEFAULT_DAILY_STOP_CAP;
    crews += 1;
  }
  return crews;
}

function indexOfFurthest(
  candidates: readonly PlannableStop[],
  from: readonly PlannableStop[],
): number {
  let bestIndex = 0;
  let bestDistance = -1;
  for (const [index, candidate] of candidates.entries()) {
    const nearest = Math.min(...from.map((seed) => haversineMeters(candidate, seed)));
    if (nearest > bestDistance) {
      bestDistance = nearest;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function distanceToCrew(stop: PlannableStop, crew: TechnicianDay): number {
  if (crew.stops.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...crew.stops.map((placed) => haversineMeters(stop, placed)));
}

/**
 * A straight-line ordering, used when no road matrix is available.
 *
 * Deliberately the fallback rather than the answer: `shortestRouteOrder` with a
 * real duration matrix is what the planner uses when routing is configured.
 * This exists so a plan is still produced — and still ordered sensibly — when
 * it is not, rather than presenting the rotation order as if it were a route.
 */
export function nearestNeighbourOrder(dayStops: readonly PlannableStop[]): PlannableStop[] {
  if (dayStops.length <= 2) return [...dayStops];
  const remaining = [...dayStops];
  const ordered = [remaining.shift()!];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
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
