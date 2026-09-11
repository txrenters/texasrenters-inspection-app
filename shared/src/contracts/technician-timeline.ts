import { haversineMeters } from './route-plan.js';

/**
 * What a technician's day actually looked like, read off their location trail.
 *
 * The planner works in **stop counts**: every technician has a `dailyStopCap`,
 * and a fifteen-minute occupied visit costs exactly as much of it as a
 * ninety-minute move-out. That is the thing this exists to fix — you cannot
 * plan in time until you can measure it, and nothing here has ever measured it.
 *
 * Deliberately derived rather than reported. A technician already tells the app
 * when they start and submit an inspection, and those timestamps are real, but
 * they answer a different question: when the *form* was open. Somebody who
 * starts the paperwork in the car and submits it from the next driveway
 * produces perfectly good timestamps describing a visit that did not happen
 * that way. The trail knows where they were.
 *
 * Pure, and in `shared`, because the same segmentation has to answer four
 * questions that would otherwise drift apart: how long a visit took, how long
 * the drive between two took, what the whole shift came to, and whether
 * somebody is running behind. One reading of the day, four readers.
 */

/** One position report, in the only shape this needs. */
export interface TimelineFix {
  latitude: number;
  longitude: number;
  /** ISO 8601, from the handset's clock when the fix was taken. */
  recordedAt: string;
}

/** Somewhere the day was supposed to happen. */
export interface TimelinePlace {
  id: string;
  latitude: number;
  longitude: number;
}

/**
 * How close counts as "here".
 *
 * A hundred metres, which is wider than it sounds and deliberately so. The
 * question is not which house somebody stood in — it is how long the visit
 * took. A radius tight enough to separate neighbours would sit inside ordinary
 * GPS error, and the segment would flicker between arrived and left while a
 * technician stood still in a hallway, turning one visit into six.
 *
 * Two stops close enough to overlap resolve to the nearer one rather than to
 * both, which is the only answer that keeps a visit whole.
 */
export const ARRIVAL_RADIUS_M = 100;

/**
 * Below this, they drove past rather than stopped.
 *
 * Five minutes. A route frequently passes the next stop on the way to this one,
 * and without a floor every such pass becomes a visit — inflating the number of
 * visits and deflating the average length of one, which is the exact figure
 * this is being built to produce.
 */
export const MIN_VISIT_MS = 5 * 60_000;

/**
 * A silence longer than this is not evidence of anything.
 *
 * Twenty minutes. Handsets go quiet indoors, and a gap *bounded by the same
 * place on both sides* is the most ordinary thing in this data: it is what an
 * inspection looks like from outside. Those are kept as part of the visit. A
 * gap bounded by two different places is travel. A gap at the very start or end
 * of the day is nothing at all, because there is no second side to say what it
 * was.
 */
export const MAX_TRUSTED_GAP_MS = 20 * 60_000;

export type SegmentKind = 'AT_PLACE' | 'TRAVELLING';

export interface TimelineSegment {
  kind: SegmentKind;
  /** Where they were, or null while travelling between places. */
  placeId: string | null;
  startedAt: string;
  endedAt: string;
  seconds: number;
}

/** The nearest place within the arrival radius, or null out on the road. */
export function placeOf(
  fix: { latitude: number; longitude: number },
  places: readonly TimelinePlace[],
  radiusMeters = ARRIVAL_RADIUS_M,
): string | null {
  let best: { id: string; metres: number } | null = null;
  for (const place of places) {
    const metres = haversineMeters(fix, place);
    if (metres <= radiusMeters && (!best || metres < best.metres)) best = { id: place.id, metres };
  }
  return best?.id ?? null;
}

/**
 * A day's fixes, folded into the places it was spent and the drives between.
 *
 * Sorted by `recordedAt` before anything else, and that matters: a handset back
 * from a dead zone delivers its queue after live fixes have already arrived, so
 * folding them in arrival order would interleave an hour-old position into the
 * present and cut a visit in half.
 */
export function segmentDay(
  fixes: readonly TimelineFix[],
  places: readonly TimelinePlace[],
  options: { radiusMeters?: number; minVisitMs?: number; maxGapMs?: number } = {},
): TimelineSegment[] {
  const radiusMeters = options.radiusMeters ?? ARRIVAL_RADIUS_M;
  const minVisitMs = options.minVisitMs ?? MIN_VISIT_MS;
  const maxGapMs = options.maxGapMs ?? MAX_TRUSTED_GAP_MS;

  const ordered = [...fixes]
    .map((fix) => ({ fix, at: Date.parse(fix.recordedAt) }))
    .filter((row) => Number.isFinite(row.at))
    .sort((left, right) => left.at - right.at);
  if (ordered.length < 2) return [];

  /** Runs of consecutive fixes sharing a label, gaps included. */
  const runs: { placeId: string | null; from: number; to: number }[] = [];
  for (const row of ordered) {
    const placeId = placeOf(row.fix, places, radiusMeters);
    const current = runs[runs.length - 1];

    if (current && current.placeId === placeId) {
      /**
       * A long silence extends a run only while we know where they were.
       *
       * At a place, the silence *is* the inspection — a handset indoors stops
       * reporting and the visit carries on. On the road there is nothing to
       * support the claim, so a gap longer than the trusted window starts a
       * fresh run rather than inventing a continuous drive across it.
       */
      if (placeId !== null || row.at - current.to <= maxGapMs) current.to = row.at;
      else runs.push({ placeId, from: row.at, to: row.at });
      continue;
    }
    runs.push({ placeId, from: row.at, to: row.at });
  }

  /**
   * Passing the next stop on the way to this one is not a visit.
   *
   * Demoted to travel rather than dropped, so the time still belongs to the
   * day: deleting it would leave the drives either side failing to meet, and
   * the shift total would quietly lose minutes nobody could account for.
   */
  const demoted = runs.map((run) =>
    run.placeId !== null && run.to - run.from < minVisitMs ? { ...run, placeId: null } : run,
  );

  /**
   * Demotion can leave two travelling runs adjacent; usually they are one
   * drive, and joining them is right.
   *
   * Not across an untrusted silence, though. The gap check above deliberately
   * split the run there, and merging unconditionally would put it straight back
   * together — asserting two hours of continuous driving on the evidence of two
   * fixes at either end of it.
   */
  const merged: typeof demoted = [];
  for (const run of demoted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.placeId === null &&
      run.placeId === null &&
      run.from - previous.to <= maxGapMs
    )
      previous.to = run.to;
    else merged.push({ ...run });
  }

  return merged
    .map((run, index) => {
      const previous = merged[index - 1];
      const next = merged[index + 1];

      /**
       * A visit spans its own fixes. A drive spans the gap between the two
       * visits it joins — so it starts at the last fix at the property behind
       * it, not at the first fix out on the road, and ends at the first fix at
       * the property ahead.
       *
       * Without that, every journey of every day silently loses the minutes
       * spent walking to the van, and the two numbers fail to meet.
       *
       * Only stretched to meet a *place*. A travelling run whose neighbour is
       * also travelling is one the gap check separated on purpose, and reaching
       * across to it would re-join what was split.
       */
      const isPlace = run.placeId !== null;
      const from = !isPlace && previous?.placeId != null ? previous.to : run.from;
      const to = !isPlace && next?.placeId != null ? next.from : run.to;

      return {
        kind: isPlace ? ('AT_PLACE' as const) : ('TRAVELLING' as const),
        placeId: run.placeId,
        startedAt: new Date(from).toISOString(),
        endedAt: new Date(to).toISOString(),
        seconds: Math.max(0, Math.round((to - from) / 1000)),
      };
    })
    // A zero-length run is an artefact of a single fix, not a fact about a day.
    .filter((segment) => segment.seconds > 0);
}

export interface DayTotals {
  /** Seconds spent at the places of the day. */
  onSiteSeconds: number;
  /** Seconds between them. */
  travellingSeconds: number;
  /** First fix to last, which is the only honest span of a shift. */
  shiftSeconds: number;
  visits: number;
}

/**
 * What the day came to.
 *
 * `shiftSeconds` is measured end to end rather than summed from the segments,
 * so it stays true when a gap was too long to attribute to either side. On-site
 * and travelling therefore need not add up to it, and the difference is honest:
 * it is the part of the day the trail cannot account for. Presenting a total
 * that always reconciled would mean quietly assigning unexplained time to
 * whichever bucket was adjacent.
 */
export function dayTotals(segments: readonly TimelineSegment[]): DayTotals {
  if (!segments.length)
    return { onSiteSeconds: 0, travellingSeconds: 0, shiftSeconds: 0, visits: 0 };

  let onSiteSeconds = 0;
  let travellingSeconds = 0;
  let visits = 0;
  for (const segment of segments)
    if (segment.kind === 'AT_PLACE') {
      onSiteSeconds += segment.seconds;
      visits += 1;
    } else travellingSeconds += segment.seconds;

  const start = Date.parse(segments[0].startedAt);
  const end = Date.parse(segments[segments.length - 1].endedAt);
  return {
    onSiteSeconds,
    travellingSeconds,
    shiftSeconds: Math.max(0, Math.round((end - start) / 1000)),
    visits,
  };
}

/**
 * How long was spent at one place, across every separate visit to it.
 *
 * Summed rather than taken from the longest, because a technician who leaves to
 * fetch something from the van and comes back has made one visit in two parts,
 * and the time it took is both of them.
 */
export function secondsAtPlace(segments: readonly TimelineSegment[], placeId: string): number {
  return segments
    .filter((segment) => segment.kind === 'AT_PLACE' && segment.placeId === placeId)
    .reduce((total, segment) => total + segment.seconds, 0);
}

/**
 * The drive that reached a place, in seconds, or null if nothing preceded it.
 *
 * Null on the first place of the day is correct rather than missing: the
 * journey from home is only a fact once we know they set off from home, which
 * is a different question with its own answer.
 */
export function driveToPlace(
  segments: readonly TimelineSegment[],
  placeId: string,
): number | null {
  const at = segments.findIndex(
    (segment) => segment.kind === 'AT_PLACE' && segment.placeId === placeId,
  );
  if (at <= 0) return null;
  const before = segments[at - 1];
  return before.kind === 'TRAVELLING' ? before.seconds : null;
}

/**
 * How much of the day is left, and when it will end.
 *
 * Deliberately *not* built on `scheduledStartAt`. That column exists on
 * `Inspection`, and on 2026-09-12 it was set on **0 of the 189 inspections
 * scheduled in the previous thirty days** -- as was `scheduledEndAt`. A
 * detector comparing arrival against a scheduled clock time would have
 * compared against null on every row and reported everybody on time for ever,
 * which is worse than not having it: it looks like an answer.
 *
 * So lateness here is a projection, not a comparison. Remaining drive time is
 * known from the route; remaining on-site time is the part that was
 * unknowable until this file could measure it. A dispatcher reading
 * "projected finish 18:40" at two in the afternoon can still move the work.
 */
export interface RemainderProjection {
  /** ISO 8601. When the last stop of the day is expected to be finished. */
  projectedFinishAt: string;
  remainingSeconds: number;
  stopsRemaining: number;
  /** Seconds per visit used for the projection. */
  perVisitSeconds: number;
  /**
   * Whether `perVisitSeconds` came from this technician's own day or from the
   * fallback.
   *
   * Carried because the two are very different claims and a projection that
   * hides which one it used invites a decision the evidence does not support.
   * A day with no completed visits yet has nothing to measure.
   */
  basis: 'MEASURED' | 'ESTIMATED';
}

/**
 * The fallback length of a visit, when the day has not yet measured one.
 *
 * Forty minutes, which is deliberately a round unremarkable number rather than
 * a derived one: it is a placeholder that the `basis` field labels as such, and
 * dressing it up as precise would be the problem this whole feature exists to
 * remove.
 */
export const ASSUMED_VISIT_SECONDS = 40 * 60;

export function projectRemainder(
  segments: readonly TimelineSegment[],
  remaining: { driveSeconds: number | null }[],
  options: { now?: number; assumedVisitSeconds?: number } = {},
): RemainderProjection {
  const now = options.now ?? Date.now();
  const assumed = options.assumedVisitSeconds ?? ASSUMED_VISIT_SECONDS;

  /**
   * Measured from *completed* visits only.
   *
   * A visit still in progress is the last segment of the day and is still
   * accumulating: at five minutes in it looks like a five-minute visit.
   * Including it drags the average down all morning and makes the projection
   * optimistic exactly when somebody is already running behind — so it is
   * excluded from the numerator *and* the denominator, not just counted
   * differently.
   */
  const last = segments[segments.length - 1];
  const finished = segments.filter(
    (segment) => segment.kind === 'AT_PLACE' && segment !== last,
  );
  const measured = finished.length
    ? Math.round(finished.reduce((total, s) => total + s.seconds, 0) / finished.length)
    : null;

  const perVisitSeconds = measured ?? assumed;
  const driving = remaining.reduce(
    // A stop whose drive we could not route still has to be driven to. Falling
    // back to the per-visit figure is crude, and it is much less wrong than
    // counting the journey as instantaneous.
    (total, stop) => total + (stop.driveSeconds ?? perVisitSeconds),
    0,
  );

  const remainingSeconds = driving + remaining.length * perVisitSeconds;
  return {
    projectedFinishAt: new Date(now + remainingSeconds * 1000).toISOString(),
    remainingSeconds,
    stopsRemaining: remaining.length,
    perVisitSeconds,
    basis: measured === null ? 'ESTIMATED' : 'MEASURED',
  };
}
