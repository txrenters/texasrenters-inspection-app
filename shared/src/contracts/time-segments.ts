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
 * This is the rule that replaces the button. It is a pure function on purpose:
 * the phone runs it so a technician sees On-site change while they stand there,
 * and the server runs it as the authority, over the same fixes, so an invoice
 * never depends on a handset's arithmetic or its clock. When the two disagree
 * the server wins and the disagreement is worth a look.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not decide what any of this is worth. Whether driving time is paid to
 * a technician or billed to a homeowner is a question for the office and its
 * lawyer, and the answer is applied on top of these segments rather than baked
 * into them. Recording faithfully and charging correctly are two jobs, and
 * mixing them would mean re-deriving history every time a rule changed.
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

/** One recorded position, as the handset reported it. */
export interface SegmentFix {
  latitude: number;
  longitude: number;
  /** The reported radius of probable error. Null when the handset would not say. */
  accuracyMeters: number | null;
  /** Ground speed in metres per second, or null where the fix carries none. */
  speedMetersPerSecond: number | null;
  /** Epoch milliseconds, from the device at the moment of the fix. */
  at: number;
}

export type TimeSegmentCategory = 'ONSITE' | 'DRIVING' | 'GENERAL';

export interface ComputedSegment {
  category: TimeSegmentCategory;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
}

/**
 * A stretch the trail cannot account for.
 *
 * Reported rather than billed, and never silently closed over. A phone that
 * died, was left in a van, or was killed by a power manager leaves real work
 * unrecorded, and a system that answers that with zero takes money from
 * somebody who earned it. A gap is a question for a person.
 */
export interface TrackingGap {
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
}

export interface SegmentResult {
  segments: ComputedSegment[];
  gaps: TrackingGap[];
  /** Fixes thrown away for being too vague to place. Worth showing when a job looks thin. */
  discardedFixes: number;
}

/**
 * The settings, and why each is the number it is.
 *
 * Measured against a month of real jobs on 2026-09-23 rather than chosen.
 */
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
 * *no* visit — which is how 20 m lost 15 of 37 jobs outright in the replay.
 * The office asked for 6 m; this is why the answer was no.
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
   * 40 m in, 60 m out.
   *
   * The replay found the radius barely matters above 30 m: 30 m billed 65% of
   * what the manual buttons did and 100 m billed 66%, so the whole 6 m-versus-
   * 30 m argument was moot. 20 m is genuinely too tight -- it billed 42% and
   * lost 15 of 37 jobs entirely. 40 m sits on the flat part of that curve and
   * covers a technician parked on the street at a rooftop-geocoded property,
   * which 584 of our 589 active properties are.
   *
   * The exit radius is larger so a fix sitting on the boundary cannot flip the
   * state on noise alone.
   */
  enterRadiusMeters: 40,
  exitRadiusMeters: 60,

  /**
   * A crossing counts once it has held this long.
   *
   * Ninety seconds: long enough that a drive-past never registers, short enough
   * that the boundary costs little. The segment is backdated to the first fix
   * of the run that confirmed it, so the technician is not charged the dwell at
   * both ends of every visit -- three minutes a visit, over a quarter, is real
   * money taken from somebody.
   */
  dwellSeconds: 90,

  /**
   * Fixes vaguer than this cannot answer which side of a line they are on.
   *
   * 25 m keeps 90.5% of what our handsets actually reported over 30 days
   * (median 3 m, mean 9.7 m, worst 340 m). Deliberately far tighter than
   * `MAX_USEFUL_ACCURACY_M`, which is 500 m and exists to draw a map: a line on
   * a map that is half a kilometre out is untidy, and an invoice that is half a
   * kilometre out is wrong.
   */
  maxAccuracyMeters: 25,

  /** Sustained at or above this is a vehicle. 4.5 m/s is about 10 mph. */
  drivingSpeedMetersPerSecond: 4.5,

  /**
   * Longer than this between fixes and the trail is not answering.
   *
   * Five minutes. The recorder keeps a position every thirty seconds even when
   * the technician is standing still, so ten missed in a row is not somebody
   * being quiet -- it is the phone, the signal or the permission. Time inside a
   * gap is reported and not billed.
   */
  maxFixGapSeconds: 300,
} as const;

export type SegmentSettings = typeof SEGMENT_DEFAULTS;

/** Whether a fix is precise enough to be allowed a vote. */
const usable = (fix: SegmentFix, settings: SegmentSettings) =>
  fix.accuracyMeters === null || fix.accuracyMeters <= settings.maxAccuracyMeters;

/**
 * Which side of the boundary a fix falls, given where we already thought we were.
 *
 * Between the two radii is the hysteresis band, and the answer there is
 * whatever it was before -- which is the whole point of having two.
 */
function sideOf(
  fix: SegmentFix,
  geofence: SegmentGeofence,
  was: 'IN' | 'OUT',
): 'IN' | 'OUT' {
  const metres = haversineMeters(
    { latitude: fix.latitude, longitude: fix.longitude },
    { latitude: geofence.latitude, longitude: geofence.longitude },
  );
  if (metres <= geofence.enterRadiusMeters) return 'IN';
  if (metres > geofence.exitRadiusMeters) return 'OUT';
  return was;
}

/**
 * Whether one fix looks like a vehicle.
 *
 * A fix carrying no speed at all -- about a fifth of ours, and usually a phone
 * that is not moving -- reads as not driving, which is the safer answer. One
 * spurious reading cannot turn a stationary hour into a drive on its own: the
 * dwell in `splitByMotion` is what makes that decision.
 */
const isDriving = (fix: SegmentFix, settings: SegmentSettings): boolean =>
  (fix.speedMetersPerSecond ?? 0) >= settings.drivingSpeedMetersPerSecond;

/** A stretch of one category, before it is given a duration. */
interface Stretch {
  category: TimeSegmentCategory;
  from: number;
  to: number;
}

/**
 * Off-site time, split again by what the technician was doing.
 *
 * Leaving the property is one crossing, but the time after it is not one
 * thing: drive to a supplier, spend half an hour inside, drive back, and the
 * office wants those as four stretches rather than one. So an off-site run is
 * partitioned by motion.
 *
 * The same dwell guards it as guards the geofence, and for the same reason. A
 * minute at a traffic light is not the end of a drive, and a lorry passing a
 * parked van is not the start of one -- a change of motion has to hold before
 * it counts, and the stretch is backdated to where the change began.
 */
function splitByMotion(
  fixes: readonly SegmentFix[],
  from: number,
  to: number,
  settings: SegmentSettings,
): Stretch[] {
  if (!fixes.length) return [{ category: 'GENERAL', from, to }];

  const stretches: Stretch[] = [];
  let moving = isDriving(fixes[0]!, settings);
  let startedAt = from;
  let candidate: { moving: boolean; from: number } | null = null;

  for (const fix of fixes.slice(1)) {
    const now = isDriving(fix, settings);
    if (now === moving) {
      candidate = null;
      continue;
    }
    if (!candidate || candidate.moving !== now) {
      candidate = { moving: now, from: fix.at };
      continue;
    }
    if ((fix.at - candidate.from) / 1000 < settings.dwellSeconds) continue;

    stretches.push({ category: moving ? 'DRIVING' : 'GENERAL', from: startedAt, to: candidate.from });
    moving = now;
    startedAt = candidate.from;
    candidate = null;
  }
  stretches.push({ category: moving ? 'DRIVING' : 'GENERAL', from: startedAt, to });
  return stretches;
}

/**
 * The segments and gaps a trail implies for one property.
 *
 * `fixes` must be in time order and belong to one technician. Everything
 * outside the geofence is off-site, and off-site is split into driving and
 * general by the speed the handset reported.
 */
export function computeSegments(
  fixes: readonly SegmentFix[],
  geofence: SegmentGeofence,
  settings: SegmentSettings = SEGMENT_DEFAULTS,
): SegmentResult {
  const usableFixes = fixes.filter((fix) => usable(fix, settings));
  const discardedFixes = fixes.length - usableFixes.length;
  if (usableFixes.length < 2) return { segments: [], gaps: [], discardedFixes };

  // Where the boundary was crossed, before any of it is called time.
  const runs: { side: 'IN' | 'OUT'; from: number; to: number; fixes: SegmentFix[] }[] = [];
  let side: 'IN' | 'OUT' = sideOf(usableFixes[0]!, geofence, 'OUT');
  let current = { side, from: usableFixes[0]!.at, to: usableFixes[0]!.at, fixes: [usableFixes[0]!] };
  let candidate: { side: 'IN' | 'OUT'; from: number; fixes: SegmentFix[] } | null = null;

  const gaps: TrackingGap[] = [];

  for (const fix of usableFixes.slice(1)) {
    const sinceLast = (fix.at - current.to) / 1000;
    if (sinceLast > settings.maxFixGapSeconds) {
      // The trail stopped answering. Close what was open and record the hole.
      runs.push({ ...current });
      gaps.push({
        startedAt: current.to,
        endedAt: fix.at,
        durationSeconds: Math.round(sinceLast),
      });
      side = sideOf(fix, geofence, 'OUT');
      current = { side, from: fix.at, to: fix.at, fixes: [fix] };
      candidate = null;
      continue;
    }

    const at = sideOf(fix, geofence, side);
    if (at === side) {
      current.to = fix.at;
      current.fixes.push(fix);
      candidate = null;
      continue;
    }

    // A change of side, which is only a candidate until it has held.
    if (!candidate || candidate.side !== at) candidate = { side: at, from: fix.at, fixes: [fix] };
    else candidate.fixes.push(fix);

    if ((fix.at - candidate.from) / 1000 < settings.dwellSeconds) {
      current.to = fix.at;
      continue;
    }

    // Confirmed. The old run ends where the new one began, not where we
    // noticed -- otherwise the dwell is deducted from both sides of every visit.
    current.to = candidate.from;
    runs.push({ ...current });
    side = at;
    current = { side, from: candidate.from, to: fix.at, fixes: candidate.fixes };
    candidate = null;
  }
  runs.push({ ...current });

  const segments = runs
    .flatMap<Stretch>((run) =>
      run.side === 'IN'
        ? [{ category: 'ONSITE', from: run.from, to: run.to }]
        : splitByMotion(run.fixes, run.from, run.to, settings),
    )
    .map((stretch) => ({
      category: stretch.category,
      startedAt: stretch.from,
      endedAt: stretch.to,
      durationSeconds: Math.round((stretch.to - stretch.from) / 1000),
    }))
    // A run of one fix is an instant, not a stretch of time.
    .filter((segment) => segment.durationSeconds > 0);

  return { segments, gaps, discardedFixes };
}

/** Total seconds in one category, which is what an invoice line is made of. */
export const secondsIn = (
  segments: readonly ComputedSegment[],
  category: TimeSegmentCategory,
): number =>
  segments.reduce((sum, segment) => (segment.category === category ? sum + segment.durationSeconds : sum), 0);
