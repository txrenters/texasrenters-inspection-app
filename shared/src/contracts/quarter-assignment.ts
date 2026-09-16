/**
 * Laying a quarter's stops out over technician-days.
 *
 * Pure and dependency-free, like the rotation beside it, so the decisions here
 * can be argued with in a test rather than inferred from a plan somebody has
 * already published.
 *
 * ## The office's rules (2026-09-16)
 *
 * - A technician's day is at most **six hours inspecting** and **ninety minutes
 *   driving between its properties**. The drive from home is not counted; the
 *   day is still driven from home, which the planner routes separately.
 * - Every visit takes thirty minutes, so a day holds up to twelve, and a day
 *   should hold **at least nine** (`minStopsPerDay`). Where the properties due
 *   are too spread out for nine inside the ninety minutes, the day holds fewer:
 *   the limits are rules, and nine is the aim.
 * - Each week each technician on the crew has one zone (`zoneTechnicians`, from
 *   `weeklyZoneTechnicians`), and a visit goes only to whoever has its zone.
 * - A visit stays near last quarter's week: at most `WINDOW_DAYS` from its day in
 *   the rotation, so a tenant's visits stay about ninety days apart.
 *
 * ## Full days, grown nearest first
 *
 * The first layout kept the rotation order and aimed each visit at its own day
 * of the quarter. On the real Q4 2026 visits that gave 115 days of 3.2 visits
 * and 150 hours of driving: a day took whatever fell due, wherever it was. So
 * each zone's days are grown instead. Start from the visit due earliest, add the
 * visit that adds least driving among those due inside the window, and stop when
 * the day is full. A day left short is then folded into the zone's other days,
 * where every one of its visits fits. The same visits came out as 48 days of 8.1
 * visits and 98 hours of driving, every day inside the limits (dry run on the
 * production plan, 2026-09-16).
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
  /** Driving between one day's properties, first to last. The drive from home is not counted. */
  maxDriveMinutes: number;
  /** Visits a day should hold at least, where the properties due allow it. */
  minStopsPerDay: number;
}

export const DEFAULT_DAY_LIMITS: DayLimits = { maxOnSiteMinutes: 6 * 60, maxDriveMinutes: 90, minStopsPerDay: 9 };

/**
 * How far a visit may move from its day in last quarter's rotation, in calendar
 * days: "a week or two" (the office, 2026-09-16).
 */
export const WINDOW_DAYS = 14;

/**
 * The most stops one day can hold, whatever the minutes say.
 *
 * Not the office's limit -- theirs is time -- but Google's: a day is routed
 * with one matrix of every stop against every other, and a matrix over 625
 * elements is refused. Twenty-four stops in six hours is fifteen minutes a
 * visit, which no visit here takes.
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
  /** Between the stops, first to last. Estimated for any leg not yet measured. */
  driveMinutes: number;
  /** Laid out or given a stop in this pass, so a drive measured before no longer describes the day. */
  changed: boolean;
}

export type UnplacedReason = 'NO_WORKING_DAYS' | 'NO_QUALIFIED_TECHNICIAN' | 'NO_CAPACITY' | 'LONGER_THAN_A_DAY';

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

/** `date|technicianId`, the identity of a technician-day. */
export const crewKey = (date: string, technicianId: string) => `${date}|${technicianId}`;

/**
 * A drive guessed from the straight line, used only to lay the quarter out.
 *
 * Every day is then measured on real roads (`QuarterPlannerService`), and a
 * day that measures over the limit is repaired, so this only has to be close.
 * Three minutes to get going plus a minute and a half per straight-line
 * kilometre. Against Google's traffic-aware legs on the Q4 2026 plan it read
 * 49 hours where Google read 44: close from one to ten kilometres, long below
 * a kilometre and past twenty, which is the side to be wrong on against a limit.
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
}

const DAY_MS = 86_400_000;

/**
 * What a day that already has its nine may still take: a visit adding no more
 * driving than this, or twice the day's average leg where the day is spread
 * out. A visit across town starts a day of its own instead of stretching a
 * full day to twelve and leaving its neighbours a short one.
 */
const LOCAL_HOP_MINUTES = 15;

/** A day being grown: its visits in driving order, the drive between them, and the time on site. */
interface Draft {
  path: PlannableStop[];
  drive: number;
  onSite: number;
}

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

/**
 * The day with one more visit, or null when it would not fit.
 *
 * Put where it adds least driving -- the ends count, since nobody drives back to
 * the first property -- and the whole day re-ordered when that is what keeps it
 * inside the drive limit.
 */
function withVisit(day: Draft, stop: PlannableStop, limits: DayLimits, drive: DriveEstimate): Draft | null {
  if (day.path.length >= MAX_STOPS_PER_DAY || day.onSite + stop.onSiteMinutes > limits.maxOnSiteMinutes) return null;
  if (day.path.length === 0) return { path: [stop], drive: 0, onSite: stop.onSiteMinutes };
  let at = 0;
  let added = drive(stop, day.path[0]!);
  const atEnd = drive(day.path[day.path.length - 1]!, stop);
  if (atEnd < added) {
    added = atEnd;
    at = day.path.length;
  }
  for (let index = 1; index < day.path.length; index += 1) {
    const between =
      drive(day.path[index - 1]!, stop) + drive(stop, day.path[index]!) - drive(day.path[index - 1]!, day.path[index]!);
    if (between < added) {
      added = between;
      at = index;
    }
  }
  let next = { path: [...day.path.slice(0, at), stop, ...day.path.slice(at)], drive: day.drive + added };
  if (next.drive > limits.maxDriveMinutes) next = polished(next.path, drive);
  return next.drive <= limits.maxDriveMinutes + 1e-9 ? { ...next, onSite: day.onSite + stop.onSiteMinutes } : null;
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

/**
 * Give every stop a day and a technician: full days, by zone, near their week.
 *
 * Each zone on its own, because only its technician of the week can take it:
 * 1. Days are grown from the stop due earliest, adding whichever stop due inside
 *    the window adds least driving, until the next would break a limit -- or,
 *    once the day has its nine, would take it across town (`LOCAL_HOP_MINUTES`).
 * 2. A day short of `minStopsPerDay` gives its stops to the zone's other days when
 *    all of them fit, moving one stop of a full day on to a third to make room;
 *    or joins another short day when the two fit as one.
 * 3. Each day then takes the day of the week its zone's technician works that is
 *    nearest the middle of its stops' due dates.
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
  if (days.length === 0) {
    for (const stop of stops) unplaced.push({ stopId: stop.stopId, reason: 'NO_WORKING_DAYS' });
    return { placed: [], crews: [], unplaced, capacity };
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
  const groups = [...new Set(byRotation.map((stop) => (zoned ? (stop.zone ?? '') : '')))];
  for (const group of groups) {
    const slots = days.flatMap((day) =>
      (zoned ? (day.zoneTechnicians?.[group] ? [day.zoneTechnicians[group]!] : []) : day.technicianIds)
        .filter((technicianId) => day.technicianIds.includes(technicianId) && !options.taken?.has(crewKey(day.date, technicianId)))
        .map((technicianId) => ({ day, technicianId, time: Date.parse(`${day.date}T00:00:00Z`) })),
    );
    const members = byRotation.filter((stop) => (zoned ? (stop.zone ?? '') : '') === group);
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
          if (merged.path.length > MAX_STOPS_PER_DAY || onSite > limits.maxOnSiteMinutes || merged.drive > limits.maxDriveMinutes + 1e-9)
            continue;
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
      crews.push({
        date: slot.day.date,
        technicianId: slot.technicianId,
        stops: day.path,
        onSiteMinutes: day.onSite,
        driveMinutes: day.drive,
        changed: true,
      });
    }
  }

  crews.sort((left, right) => left.date.localeCompare(right.date) || left.technicianId.localeCompare(right.technicianId));
  const placed = crews.flatMap((crew) =>
    crew.stops.map((stop, index) => ({ stopId: stop.stopId, date: crew.date, technicianId: crew.technicianId, position: index + 1 })),
  );
  return { placed, crews, unplaced, capacity };
}

/**
 * Stops a measured day could not keep, given to other days that can take them.
 *
 * Each stop goes to the day that adds least driving among those its zone's
 * technician has inside the window, that it was not just taken off (`avoid`),
 * and that it fits. Only when no such day can take it does it get a day of its
 * own, on the free day of the week nearest its due date: a property too far from
 * the rest for any full day is exactly where the office accepts a short one
 * (2026-09-16). What has neither is returned for a person.
 */
export function foldIntoDays(
  displaced: readonly PlannableStop[],
  crews: readonly AssignedCrew[],
  days: readonly PlannableDay[],
  options: LayoutOptions & { avoid?: ReadonlyMap<string, ReadonlySet<string>> } = {},
): { crews: AssignedCrew[]; unplaced: { stopId: string; reason: UnplacedReason }[] } {
  const limits = options.limits ?? DEFAULT_DAY_LIMITS;
  const drive = options.driveMinutes ?? estimatedDriveMinutes;
  const window = (options.windowDays ?? WINDOW_DAYS) * DAY_MS;
  const dueOf = dueDates(displaced, days, options.rotation);
  const dayOf = new Map(days.map((day) => [day.date, day]));
  const next = crews.map((crew) => ({ ...crew, stops: [...crew.stops] }));
  const unplaced: { stopId: string; reason: UnplacedReason }[] = [];

  for (const stop of [...displaced].sort((a, b) => dueOf.get(a.stopId)! - dueOf.get(b.stopId)! || a.sequence - b.sequence)) {
    let best: { crew: AssignedCrew; draft: Draft } | null = null;
    for (const crew of next) {
      const day = dayOf.get(crew.date);
      if (!day) continue;
      const owner = day.zoneTechnicians ? day.zoneTechnicians[stop.zone ?? ''] : crew.technicianId;
      const list = day.qualified?.[stop.inspectionType];
      if (owner !== crew.technicianId || (list && !list.includes(crew.technicianId))) continue;
      if (options.avoid?.get(stop.stopId)?.has(crewKey(crew.date, crew.technicianId))) continue;
      if (Math.abs(Date.parse(`${crew.date}T00:00:00Z`) - dueOf.get(stop.stopId)!) > window) continue;
      const draft = withVisit({ path: crew.stops, drive: crew.driveMinutes, onSite: crew.onSiteMinutes }, stop, limits, drive);
      if (draft && (!best || draft.drive - crew.driveMinutes < best.draft.drive - best.crew.driveMinutes)) best = { crew, draft };
    }
    if (!best) {
      const due = dueOf.get(stop.stopId)!;
      const used = new Set(next.map((crew) => crewKey(crew.date, crew.technicianId)));
      const free = days
        .flatMap((day) =>
          (day.zoneTechnicians ? (day.zoneTechnicians[stop.zone ?? ''] ? [day.zoneTechnicians[stop.zone ?? '']!] : []) : day.technicianIds).map(
            (technicianId) => ({ day, technicianId, time: Date.parse(`${day.date}T00:00:00Z`) }),
          ),
        )
        .filter(({ day, technicianId, time }) => {
          const key = crewKey(day.date, technicianId);
          const list = day.qualified?.[stop.inspectionType];
          return (
            day.technicianIds.includes(technicianId) &&
            (!list || list.includes(technicianId)) &&
            !used.has(key) &&
            !options.taken?.has(key) &&
            !options.avoid?.get(stop.stopId)?.has(key) &&
            Math.abs(time - due) <= window &&
            stop.onSiteMinutes <= limits.maxOnSiteMinutes
          );
        })
        .sort((left, right) => Math.abs(left.time - due) - Math.abs(right.time - due) || left.time - right.time);
      if (free.length === 0) {
        unplaced.push({ stopId: stop.stopId, reason: 'NO_CAPACITY' });
        continue;
      }
      next.push({
        date: free[0]!.day.date,
        technicianId: free[0]!.technicianId,
        stops: [stop],
        onSiteMinutes: stop.onSiteMinutes,
        driveMinutes: 0,
        changed: true,
      });
      continue;
    }
    best.crew.stops = best.draft.path;
    best.crew.driveMinutes = best.draft.drive;
    best.crew.onSiteMinutes = best.draft.onSite;
    best.crew.changed = true;
  }
  return { crews: next, unplaced };
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
