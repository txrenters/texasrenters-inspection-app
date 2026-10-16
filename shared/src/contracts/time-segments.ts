import { haversineMeters } from './route-plan.js';

/**
 * Turning a trail of location fixes into time somebody is paid for.
 *
 * The office asked for automatic time tracking to replace Start job / End job,
 * because a technician is paid by the hour and a homeowner is invoiced from the
 * same number, and a button pressed by hand serves neither well. A month of
 * real jobs measured on 2026-09-23 found it wrong in both directions: one visit
 * recorded 43.9 hours because End job was never pressed, and others recorded
 * seven and eight minutes for visits the trail shows ran to two hours.
 *
 * This is the rule that replaces the button, and it reads a **day**, not a job.
 * The first version read each job on its own, and two weeks of production
 * showed what that costs: a technician with 36 hours on site had three minutes
 * of everything else, because the drive between two properties belonged to
 * neither job and so to nobody; two jobs at one building were each given the
 * whole stay; and every few minutes a phone went quiet indoors cut a visit in
 * two and left a row for the office to settle by hand -- 59 of them in a
 * fortnight. A day has none of those problems: every minute between the first
 * arrival and the last departure is in exactly one place, a property or the
 * time between properties.
 *
 * It is a pure function on purpose: the server runs it as the authority, over
 * the fixes it was sent, so a timesheet never depends on a handset's
 * arithmetic or its clock.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not decide what any of this is worth. Whether general time is paid
 * to a technician or billed to a homeowner is a question for the office, and
 * the answer is applied on top of these stretches rather than baked into them.
 * Recording faithfully and charging correctly are two jobs, and mixing them
 * would mean re-deriving history every time a rule changed.
 */

/** Where a property is, and how close counts as being there. */
export interface SegmentGeofence {
  latitude: number;
  longitude: number;
  /** Inside this, the technician has arrived. */
  enterRadiusMeters: number;
  /** Outside this, they have left. Larger than the entry radius; see `SEGMENT_DEFAULTS`. */
  exitRadiusMeters: number;
}

/** One of the properties a technician is due at on the day being read. */
export interface DayFence extends SegmentGeofence {
  /** Whatever the caller knows the property by. Handed back on its stretches. */
  id: string;
}

/** One recorded position, as the handset reported it. */
export interface SegmentFix {
  latitude: number;
  longitude: number;
  /** The reported radius of probable error. Null when the handset would not say. */
  accuracyMeters: number | null;
  /** Epoch milliseconds, from the device at the moment of the fix. */
  at: number;
}

/**
 * `DRIVING` is no longer written. Everything away from a property is general
 * time, and rows from before that are added into it wherever they are read --
 * except a stop: somewhere that is not a property, where the technician stood
 * still long enough to be doing something there (the office, 2026-10-17: a
 * supply run to the hardware store). A stop is its own figure on the
 * timesheet, so general time is the drive.
 */
export type TimeSegmentCategory = 'ONSITE' | 'DRIVING' | 'GENERAL' | 'STOP';

/** A stretch of the day: at one property, at a stop, or on the road between. */
export interface LedgerStretch {
  category: 'ONSITE' | 'GENERAL' | 'STOP';
  /** The property the technician was at. Null for general time and stops. */
  fenceId: string | null;
  /** Where a stop was: the middle of the fixes that made it. Only on a stop. */
  position?: { latitude: number; longitude: number };
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  /**
   * How much of this stretch the trail was silent for.
   *
   * Counted, not left out -- see `computeDayLedger` for the rule -- and carried
   * so the office can see which hours were measured and which were filled in.
   * A total with an hour of silence inside it is still the best answer there
   * is, but it is not the same kind of answer.
   */
  quietSeconds: number;
}

export interface DayLedger {
  stretches: LedgerStretch[];
  /** Fixes thrown away for being too vague to place. Worth showing when a day looks thin. */
  discardedFixes: number;
}

/**
 * What the office is allowed to set a property's radius to.
 *
 * Here rather than in the API so the console can refuse a number before it is
 * sent, the server can refuse it again, and the phone reads the same rule --
 * three places that must not disagree about what a geofence is.
 *
 * **10 m floor.** The handsets report a median accuracy of 3 m and 73% of
 * fixes at 6 m or better, but 9.5% are worse than 25 m. A radius tighter than
 * the error it is measured with does not record a shorter visit, it records
 * *no* visit. The office asked for 6 m; this is why the answer was no.
 *
 * **500 m ceiling.** Past that a circle stops describing a property and starts
 * describing its neighbourhood, and a technician working next door would be
 * billed to this one.
 */
export const GEOFENCE_RADIUS_BOUNDS = { minMeters: 10, maxMeters: 500 } as const;

/**
 * Why a proposed geofence is not allowed, or null when it is.
 *
 * Returns the sentence a person should read, not a code: the office is the
 * only caller that acts on it, and every caller here would otherwise write its
 * own wording for the same rule.
 */
export function geofenceRadiusProblem(enterRadiusMeters: number, exitRadiusMeters: number): string | null {
  const { minMeters, maxMeters } = GEOFENCE_RADIUS_BOUNDS;
  for (const [what, value] of [
    ['arrival', enterRadiusMeters],
    ['departure', exitRadiusMeters],
  ] as const) {
    if (!Number.isInteger(value))
      return `Give the ${what} distance in whole metres.`;
    if (value < minMeters || value > maxMeters)
      return `The ${what} distance has to be between ${minMeters} and ${maxMeters} metres.`;
  }
  /**
   * The gap is the whole point, not a formality.
   *
   * Equal radii put a technician standing near the edge in and out of the
   * property every time a fix wobbles, which is exactly the flapping the two
   * numbers exist to prevent -- and each flap ends one segment and starts
   * another, so an hour on site becomes a column of one-minute rows.
   */
  if (exitRadiusMeters <= enterRadiusMeters)
    return 'The departure distance has to be larger than the arrival distance, or the clock will start and stop every time a position wobbles.';
  return null;
}

export const SEGMENT_DEFAULTS = {
  /**
   * 20 m in, 30 m out.
   *
   * The office's number, asked for on 2026-10-06: the circle should be the
   * property and not the street outside it, so a technician parked at the kerb
   * is not yet on site. It was 40 and 60.
   *
   * 20 m is close to what the handsets can measure, and the first replay, on
   * 2026-09-23, said so bluntly -- at 20 m it found 42% of the hours and lost
   * 15 of 37 jobs outright. Two things have changed since. The recorder keeps
   * a fix every thirty seconds standing still, where it used to keep none; and
   * a stretch the trail is silent for is no longer dropped, it stays with the
   * property when the technician was inside before and after it. A tight
   * radius used to lose the visit. Now it moves minutes at the edge of one
   * from on site to general time, and the day's total stands either way.
   *
   * A property on a large lot, or a complex whose pin is the leasing office,
   * needs a radius of its own. That is what `PropertyGeofence` is for.
   *
   * The exit radius is larger so a fix sitting on the boundary cannot flip the
   * state on noise alone.
   */
  enterRadiusMeters: 20,
  exitRadiusMeters: 30,

  /**
   * A crossing counts once it has held this long.
   *
   * Ninety seconds: long enough that a drive-past never registers, short enough
   * that the boundary costs little. The stretch is backdated to the first fix
   * of the run that confirmed it, so the dwell is not taken off both ends of
   * every visit -- three minutes a visit, over a quarter, is real money.
   */
  dwellSeconds: 90,

  /**
   * Fixes vaguer than this cannot answer which side of a line they are on.
   *
   * 25 m keeps 90.5% of what our handsets actually reported over 30 days
   * (median 3 m, mean 9.7 m, worst 340 m). Deliberately far tighter than
   * `MAX_USEFUL_ACCURACY_M`, which is 500 m and exists to draw a map: a line on
   * a map that is half a kilometre out is untidy, and a timesheet that is half
   * a kilometre out is wrong.
   */
  maxAccuracyMeters: 25,

  /**
   * Longer than this between fixes and the trail was not answering.
   *
   * Five minutes. The recorder keeps a position every thirty seconds even when
   * the technician is standing still, so ten missed in a row is not somebody
   * being quiet -- it is the phone, the signal or the walls of the house.
   */
  maxFixGapSeconds: 300,

  /**
   * A stop is this long ...
   *
   * Five minutes, the shortest anybody runs into a store for: past a red light,
   * a train crossing, a queue at a junction. Shorter waits stay general time.
   */
  stopMinSeconds: 300,

  /**
   * ... within this of one spot.
   *
   * 75 m, because a stop is a car park and a store, not a front room: a
   * technician walking from the van to the back of a hardware store is a
   * hundred metres from where they parked at the far end of it, and the phone
   * indoors wanders tens of metres more.
   */
  stopRadiusMeters: 75,

  /**
   * Fixes vaguer than this cannot say where a stop was.
   *
   * Four times the circle's 25 m. A stop does not have to decide which side of
   * a line somebody is on, only roughly where they stood, and inside a steel
   * building the phone rarely does better than 50 m. The trail on the map
   * draws to the same limit.
   */
  stopMaxAccuracyMeters: 100,

  /**
   * Not a stop this close to a property they had a visit at.
   *
   * The kerb outside, the neighbour's drive the van was left in, the end of a
   * big lot past the 30 m circle: those minutes belong to the visit's
   * surroundings and stay general time, or every visit would grow a stop on
   * either side of it.
   *
   * 150 m, from 30 days of production trails replayed on 2026-10-17. At 100 m
   * there were 28 stops; the 13 between 100 and 150 m from a visit property
   * every one sat directly before or after the time inside that same
   * property's circle, and was almost all silent phone (137 of 153 minutes) --
   * the visit, carried through a quiet phone some way from the pin, not a trip
   * anywhere. Nothing at all fell between 150 and 200 m; the 15 left were 5 to
   * 26 minutes, all over half a kilometre from any visit.
   */
  stopPropertyMarginMeters: 150,
} as const;

export type SegmentSettings = typeof SEGMENT_DEFAULTS;

/** Whether a fix is precise enough to be allowed a vote. */
const usable = (fix: SegmentFix, settings: SegmentSettings) =>
  fix.accuracyMeters === null || fix.accuracyMeters <= settings.maxAccuracyMeters;

/** The id of the property a technician is at, or null for between properties. */
type Place = string | null;

/**
 * Where a fix puts the technician, given where we already thought they were.
 *
 * Inside a property's arrival distance is at that property -- the nearest one,
 * where two neighbours both claim the fix, so walking from one house to the
 * house next door ends the first visit instead of stretching it over both.
 * Otherwise, between the two radii of the property they were already at is
 * still there: that band is the hysteresis, and the answer in it is whatever
 * it was before, which is the whole point of having two numbers.
 */
function placeOf(fix: SegmentFix, fences: readonly DayFence[], was: Place): Place {
  let nearest: { id: string; metres: number } | null = null;
  let metresFromWas: number | null = null;
  for (const fence of fences) {
    const metres = haversineMeters(
      { latitude: fix.latitude, longitude: fix.longitude },
      { latitude: fence.latitude, longitude: fence.longitude },
    );
    if (fence.id === was && metres <= fence.exitRadiusMeters) metresFromWas = metres;
    if (metres <= fence.enterRadiusMeters && (!nearest || metres < nearest.metres))
      nearest = { id: fence.id, metres };
  }
  if (nearest) return nearest.id;
  return metresFromWas === null ? null : was;
}

/** A stretch in one place, before it is given a duration. */
interface Run {
  place: Place;
  from: number;
  to: number;
  quietSeconds: number;
}

/**
 * A technician's day, as the trail accounts for it.
 *
 * `fixes` must be in time order and belong to one technician; `fences` are the
 * properties they are due at that day. The answer runs from the first arrival
 * to the last departure and has no holes in it: each stretch is on site at one
 * property, a stop somewhere that is not one, or general time on the road
 * between them.
 *
 * **The drive in and the drive home are not in it.** The day starts when the
 * technician first arrives at a property and ends when they leave the last
 * one; the office decided that on 2026-10-06. A day with no arrival at all is
 * an empty ledger, not a day of general time.
 *
 * **A silent trail does not stop the clock.** A phone inside a house loses the
 * sky; one in a pocket is put to sleep; one runs flat. When the trail goes
 * quiet for longer than `maxFixGapSeconds`:
 *
 * - found at the same property afterwards, the technician was there the whole
 *   time, and the stretch continues through the silence;
 * - found anywhere else, they left at some moment nobody recorded. The visit
 *   ends at the last fix that saw them there and the silence is general time.
 *
 * Both are the office's decision, and both replace a list of unaccounted-for
 * stretches that somebody had to settle one at a time before anyone was paid.
 * The silence is still counted on each stretch (`quietSeconds`), because hours
 * that were filled in should be told apart from hours that were measured.
 */
export function computeDayLedger(
  fixes: readonly SegmentFix[],
  fences: readonly DayFence[],
  settings: SegmentSettings = SEGMENT_DEFAULTS,
): DayLedger {
  const usableFixes = fixes.filter((fix) => usable(fix, settings));
  const discardedFixes = fixes.length - usableFixes.length;
  if (usableFixes.length < 2 || !fences.length) return { stretches: [], discardedFixes };

  const first = usableFixes[0]!;
  const runs: Run[] = [];
  let current: Run = { place: placeOf(first, fences, null), from: first.at, to: first.at, quietSeconds: 0 };
  let candidate: { place: Place; from: number } | null = null;
  let lastAt = first.at;

  for (const fix of usableFixes.slice(1)) {
    const sinceLast = (fix.at - lastAt) / 1000;
    const at = placeOf(fix, fences, current.place);

    if (sinceLast > settings.maxFixGapSeconds) {
      // Whatever was being confirmed, the silence has outlasted it.
      candidate = null;
      if (at === current.place) {
        current.to = fix.at;
        current.quietSeconds += sinceLast;
      } else {
        runs.push({ ...current, to: lastAt });
        runs.push({ place: null, from: lastAt, to: fix.at, quietSeconds: sinceLast });
        current = { place: at, from: fix.at, to: fix.at, quietSeconds: 0 };
      }
      lastAt = fix.at;
      continue;
    }
    lastAt = fix.at;

    if (at === current.place) {
      current.to = fix.at;
      candidate = null;
      continue;
    }

    // Somewhere new, which is only a candidate until it has held.
    if (!candidate || candidate.place !== at) candidate = { place: at, from: fix.at };
    if ((fix.at - candidate.from) / 1000 < settings.dwellSeconds) {
      current.to = fix.at;
      continue;
    }

    // Confirmed. The old stretch ends where the new one began, not where we
    // noticed -- otherwise the dwell is deducted from both sides of every visit.
    runs.push({ ...current, to: candidate.from });
    current = { place: at, from: candidate.from, to: fix.at, quietSeconds: 0 };
    candidate = null;
  }
  runs.push(current);

  // A run of one fix is an instant, not a stretch of time. Dropped before the
  // neighbours are joined, so the two halves it sat between become one.
  const joined: Run[] = [];
  for (const run of runs) {
    if (run.to <= run.from) continue;
    const before = joined[joined.length - 1];
    if (before && before.place === run.place && before.to === run.from) {
      before.to = run.to;
      before.quietSeconds += run.quietSeconds;
    } else joined.push({ ...run });
  }

  // First arrival to last departure. Everything outside that is the drive in
  // and the drive home.
  const firstOnsite = joined.findIndex((run) => run.place !== null);
  if (firstOnsite === -1) return { stretches: [], discardedFixes };
  let lastOnsite = joined.length - 1;
  while (joined[lastOnsite]!.place === null) lastOnsite -= 1;

  // Between properties, where the technician stood still somewhere is a stop
  // and the rest is the drive. Only between: before the first arrival and
  // after the last departure is not the day (the office, 2026-10-17).
  const stopFixes = fixes.filter(
    (fix) => fix.accuracyMeters === null || fix.accuracyMeters <= settings.stopMaxAccuracyMeters,
  );
  const stretches: LedgerStretch[] = [];
  for (const run of joined.slice(firstOnsite, lastOnsite + 1)) {
    if (run.place !== null) {
      stretches.push(stretchOf(run, 'ONSITE'));
      continue;
    }
    const stops = stopsBetween(stopFixes, run.from, run.to, fences, settings);
    if (!stops.length) {
      stretches.push(stretchOf(run, 'GENERAL'));
      continue;
    }
    // The silences inside the drive, given to whichever piece they fell in.
    const quiet = (from: number, to: number) => quietBetween(usableFixes, from, to, settings);
    const drive = (start: number, end: number) =>
      stretchOf({ place: null, from: start, to: end, quietSeconds: quiet(start, end) }, 'GENERAL');
    let from = run.from;
    for (const stop of stops) {
      if (stop.from > from) stretches.push(drive(from, stop.from));
      stretches.push({
        ...stretchOf({ place: null, from: stop.from, to: stop.to, quietSeconds: quiet(stop.from, stop.to) }, 'STOP'),
        position: stop.position,
      });
      from = stop.to;
    }
    if (run.to > from) stretches.push(drive(from, run.to));
  }

  return { stretches, discardedFixes };
}

function stretchOf(run: Run, category: LedgerStretch['category']): LedgerStretch {
  return {
    category,
    fenceId: run.place,
    startedAt: run.from,
    endedAt: run.to,
    durationSeconds: Math.round((run.to - run.from) / 1000),
    quietSeconds: Math.round(run.quietSeconds),
  };
}

/**
 * How long the trail was silent between two moments: every gap longer than
 * `maxFixGapSeconds` between usable fixes, as far as it falls inside. The same
 * silences `computeDayLedger` counts, so a drive cut in pieces around a stop
 * keeps the quiet it had, shared out where it actually happened.
 */
function quietBetween(fixes: readonly SegmentFix[], from: number, to: number, settings: SegmentSettings): number {
  let seconds = 0;
  for (let index = 1; index < fixes.length; index += 1) {
    const before = fixes[index - 1]!.at;
    const after = fixes[index]!.at;
    if (after <= from || before >= to || (after - before) / 1000 <= settings.maxFixGapSeconds) continue;
    seconds += (Math.min(after, to) - Math.max(before, from)) / 1000;
  }
  return seconds;
}

interface FoundStop {
  from: number;
  to: number;
  position: { latitude: number; longitude: number };
}

/**
 * Where, between two properties, the technician stood still long enough to
 * be doing something: `stopMinSeconds` within `stopRadiusMeters` of one spot.
 *
 * Fixes join a stop while they stay near the middle of the ones before them.
 * One or two thrown further and straight back are skipped rather than ending
 * it -- a phone inside a store does that every few minutes, and nobody walks
 * across the car park and back in thirty seconds. A silence does not end a
 * stop either, if the phone turns up in the same place afterwards: the same
 * benefit of the doubt a quiet phone gets at a property.
 *
 * A stop is timed from its first fix to its last and placed at their median,
 * so the throws that did get in do not drag it across the road.
 */
function stopsBetween(
  fixes: readonly SegmentFix[],
  from: number,
  to: number,
  fences: readonly DayFence[],
  settings: SegmentSettings,
): FoundStop[] {
  const inside = fixes.filter((fix) => fix.at >= from && fix.at <= to);
  const near = (centre: { latitude: number; longitude: number }, fix: SegmentFix) =>
    haversineMeters(centre, fix) <= settings.stopRadiusMeters;
  const stops: FoundStop[] = [];
  let index = 0;
  while (index < inside.length) {
    const cluster: SegmentFix[] = [inside[index]!];
    let centre = { latitude: inside[index]!.latitude, longitude: inside[index]!.longitude };
    let next = index + 1;
    while (next < inside.length) {
      const fix = inside[next]!;
      if (near(centre, fix)) {
        cluster.push(fix);
        centre = {
          latitude: centre.latitude + (fix.latitude - centre.latitude) / cluster.length,
          longitude: centre.longitude + (fix.longitude - centre.longitude) / cluster.length,
        };
        next += 1;
        continue;
      }
      const returns =
        cluster.length >= 3
          ? [1, 2].find((ahead) => {
              const later = inside[next + ahead];
              return later !== undefined && near(centre, later);
            })
          : undefined;
      if (returns === undefined) break;
      next += returns;
    }

    const first = cluster[0]!;
    const last = cluster[cluster.length - 1]!;
    if ((last.at - first.at) / 1000 >= settings.stopMinSeconds) {
      const position = {
        latitude: median(cluster.map((fix) => fix.latitude)),
        longitude: median(cluster.map((fix) => fix.longitude)),
      };
      const byAProperty = fences.some(
        (fence) => haversineMeters(position, fence) <= settings.stopPropertyMarginMeters,
      );
      if (!byAProperty) stops.push({ from: first.at, to: last.at, position });
    }
    index = next;
  }
  return stops;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The stretches with certain intervals cut out of them.
 *
 * An hour a person has decided -- a correction, or time credited by hand -- is
 * no longer the trail's to answer. Reading the day again must leave that hour
 * alone *and* must not write its own version of it underneath, or the same
 * hour is on the timesheet twice and somebody is paid for both. So the kept
 * intervals are removed from what the trail says before it is written, and a
 * stretch that straddles one comes back as the pieces either side.
 */
export function withoutIntervals(
  stretches: readonly LedgerStretch[],
  kept: readonly { startedAt: number; endedAt: number }[],
): LedgerStretch[] {
  const holes = [...kept].sort((left, right) => left.startedAt - right.startedAt);
  return stretches.flatMap((stretch) => {
    const pieces: LedgerStretch[] = [];
    let from = stretch.startedAt;
    const piece = (to: number) => {
      const durationSeconds = Math.round((to - from) / 1000);
      if (durationSeconds <= 0) return;
      pieces.push({
        ...stretch,
        startedAt: from,
        endedAt: to,
        durationSeconds,
        // Shared out by length. Where in the stretch the silence fell is not
        // kept, and a piece cannot have been quiet for longer than it lasted.
        quietSeconds: stretch.durationSeconds
          ? Math.min(durationSeconds, Math.round((stretch.quietSeconds * durationSeconds) / stretch.durationSeconds))
          : 0,
      });
    };
    for (const hole of holes) {
      if (hole.endedAt <= from || hole.startedAt >= stretch.endedAt) continue;
      piece(Math.max(from, hole.startedAt));
      from = Math.max(from, hole.endedAt);
    }
    if (from < stretch.endedAt) piece(stretch.endedAt);
    return pieces;
  });
}

/** Total seconds in one category, which is what a timesheet column is made of. */
export const secondsIn = (
  stretches: readonly Pick<LedgerStretch, 'category' | 'durationSeconds'>[],
  category: LedgerStretch['category'],
): number =>
  stretches.reduce((sum, stretch) => (stretch.category === category ? sum + stretch.durationSeconds : sum), 0);
