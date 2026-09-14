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
 *
 * The finish and the arrival at each stop are one calculation. They used to be
 * two -- this one for the finish, and a separate estimate on the route for each
 * stop -- and they disagreed about the visit under way: the finish counted it
 * as already done, the stops as a whole visit still to come. On the live map
 * that put every arrival half an hour late and the finish forty minutes before
 * the last stop could be.
 */

/** When a stop still ahead will be reached. */
export interface StopArrival {
  inspectionId: string;
  /** ISO 8601. */
  arriveAt: string;
  /** Seconds of driving between now and this stop, visits excluded. */
  driveSeconds: number;
}

/** The visit under way: the day's last segment, at one of the stops still to do. */
export interface CurrentVisit {
  placeId: string;
  /** Every inspection at the place. Two at one address are one visit. */
  inspectionIds: string[];
  /** ISO 8601. When the trail first put them there. */
  arrivedAt: string;
  /** How long they have been there, to now. */
  onSiteSeconds: number;
  /** What is left of a visit by the per-visit figure. Never below zero. */
  remainingSeconds: number;
}

export interface RemainderProjection {
  /**
   * ISO 8601. When the last stop is expected to be finished.
   *
   * Null on a day that is not under way. Everything here counts from now, so
   * for tomorrow or last Tuesday a finish time would be this afternoon's clock
   * pinned to somebody else's day.
   */
  projectedFinishAt: string | null;
  remainingSeconds: number;
  /** Stops not yet started. The visit under way is `current`, not one of these. */
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
  /** The visit under way, or null when they are not at one of the stops left. */
  current: CurrentVisit | null;
  /**
   * Every stop still ahead in the drawn order, with when it will be reached.
   *
   * Missing for a stop that has no place in that order -- no coordinate, no
   * road to it, or already behind them on the line -- which still counts toward
   * the finish. Empty on a day that is not under way.
   */
  arrivals: StopArrival[];
}

/** One inspection still to do, and the place on the trail it is at. */
export interface WorkStop {
  inspectionId: string;
  /** Null for a stop with no coordinate, which the trail can never put anybody at. */
  placeId: string | null;
}

/** The work still assigned for the day, as the route arranged it. */
export interface RemainingWork {
  /** In driving order. */
  ordered: readonly WorkStop[];
  /**
   * `legs[i]` is the drive that reaches `ordered[i]`. Shorter than `ordered`,
   * or empty, where routing was unavailable.
   */
  legs: readonly { durationSeconds: number; distanceMeters: number }[];
  /** How far down the drawn line the technician already is, 0 to 1. */
  progress: number;
  /** Still to do but with no place in the order: no coordinate, or no road to it. */
  unordered: readonly WorkStop[];
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

/**
 * The rest of the day: the visit under way, when each stop ahead is reached,
 * and when the last one is done.
 *
 * Walks the stops in the order the route drew them, from where the technician
 * is. Each stop is one of four things:
 *
 * - **Where they are now.** Only what is left of a visit is still to come --
 *   the per-visit figure less the time already there, never below zero. A
 *   visit that has run long leaves nothing, and the times after it slide
 *   forward with the clock, which is exactly what running late looks like.
 * - **Visited and left.** Takes no more time, whatever its paperwork says -- an
 *   inspection can sit unsubmitted for hours after the technician has driven
 *   away. The line still passes through it, so its drive still counts toward
 *   the next stop.
 * - **Ahead.** The drive to it, then a visit.
 * - **Still to do but not in the order** -- no coordinate, no road to it, or
 *   behind them on the line. No arrival time, because the order has no place
 *   for it, but it still has to be driven to and done, so it counts toward the
 *   finish with the per-visit figure standing in for the drive it could not be
 *   given. Crude, and much less wrong than counting the journey as nothing.
 *
 * Two inspections at one place are one visit: the second gets the first's
 * arrival and adds no time.
 */
export function projectRemainder(
  segments: readonly TimelineSegment[],
  work: RemainingWork,
  options: {
    now?: number;
    assumedVisitSeconds?: number;
    /** Whether the day is the one happening now. Defaults to true. */
    underway?: boolean;
  } = {},
): RemainderProjection {
  const now = options.now ?? Date.now();
  const assumed = options.assumedVisitSeconds ?? ASSUMED_VISIT_SECONDS;
  const underway = options.underway ?? true;

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

  const everyStop = [...work.ordered, ...work.unordered];

  /**
   * The visit under way is the day's last segment, when that is at a stop
   * still to do.
   *
   * Timed to now rather than to the last fix: a handset indoors goes quiet for
   * most of an inspection, and the visit carries on regardless. At a place that
   * is no longer on the list -- its inspection already submitted -- nothing of
   * it is left to wait for.
   */
  const here =
    underway && last?.kind === 'AT_PLACE' && last.placeId !== null ? last : null;
  const hereIds = here
    ? everyStop.filter((stop) => stop.placeId === here.placeId).map((stop) => stop.inspectionId)
    : [];
  let current: CurrentVisit | null = null;
  if (here?.placeId && hereIds.length) {
    const onSiteSeconds = Math.max(0, Math.round((now - Date.parse(here.startedAt)) / 1000));
    current = {
      placeId: here.placeId,
      inspectionIds: [...new Set(hereIds)],
      arrivedAt: here.startedAt,
      onSiteSeconds,
      remainingSeconds: Math.max(0, perVisitSeconds - onSiteSeconds),
    };
  }

  const visited = new Set(finished.map((segment) => segment.placeId));
  if (current) visited.delete(current.placeId);

  const isHere = (stop: WorkStop) => current !== null && stop.placeId === current.placeId;
  const isVisited = (stop: WorkStop) => stop.placeId !== null && visited.has(stop.placeId);
  const keyOf = (stop: WorkStop) => stop.placeId ?? `inspection:${stop.inspectionId}`;

  /** Seconds from now, per place, at which a stop is reached. */
  const reachedAt = new Map<string, number>();
  const unplaced = new Set<string>();
  const arrivals: StopArrival[] = [];

  let clock = current?.remainingSeconds ?? 0;
  let drivingTotal = 0;
  /** Driving since the last stop that had work, carried to the next one that does. */
  let drivingPending = 0;

  /**
   * Where along the drawn line the walk starts.
   *
   * At a stop, from that stop: everything before it in the order is behind
   * them, whatever the line says. Otherwise from how far down the line their
   * position projects, with the arrival radius as slack -- somebody pulling up
   * outside a stop has not yet passed it.
   */
  let hereIndex = -1;
  work.ordered.forEach((stop, index) => {
    if (isHere(stop)) hereIndex = index;
  });
  const legs = work.legs.slice(0, work.ordered.length);
  const totalDistance = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const progress = Number.isFinite(work.progress) ? Math.max(0, Math.min(1, work.progress)) : 0;
  const along = progress * totalDistance;
  let legStart = 0;

  work.ordered.forEach((stop, index) => {
    const leg = legs[index];
    if (!leg) {
      if (!isHere(stop) && !isVisited(stop)) unplaced.add(keyOf(stop));
      return;
    }
    const legEnd = legStart + leg.distanceMeters;

    let behind: boolean;
    let drive: number;
    if (hereIndex >= 0) {
      behind = index <= hereIndex;
      drive = behind ? 0 : leg.durationSeconds;
    } else {
      behind = legEnd + ARRIVAL_RADIUS_M <= along;
      // A leg with no length -- two stops at one address -- has no drive left
      // and must not divide by zero into NaN.
      const left =
        leg.distanceMeters > 0 ? (legEnd - Math.max(along, legStart)) / leg.distanceMeters : 0;
      drive = behind ? 0 : leg.durationSeconds * Math.max(0, Math.min(1, left));
    }
    legStart = legEnd;

    if (isHere(stop)) return;
    if (isVisited(stop)) {
      drivingPending += drive;
      return;
    }
    const key = keyOf(stop);
    if (behind) {
      if (!reachedAt.has(key)) unplaced.add(key);
      return;
    }

    drivingPending += drive;
    const already = reachedAt.get(key);
    if (already !== undefined) {
      arrivals.push({
        inspectionId: stop.inspectionId,
        arriveAt: new Date(now + already * 1000).toISOString(),
        driveSeconds: Math.round(drivingTotal),
      });
      return;
    }

    clock += drivingPending;
    drivingTotal += drivingPending;
    drivingPending = 0;
    reachedAt.set(key, clock);
    unplaced.delete(key);
    arrivals.push({
      inspectionId: stop.inspectionId,
      arriveAt: new Date(now + clock * 1000).toISOString(),
      driveSeconds: Math.round(drivingTotal),
    });
    clock += perVisitSeconds;
  });

  for (const stop of work.unordered)
    if (!isHere(stop) && !isVisited(stop) && !reachedAt.has(keyOf(stop)))
      unplaced.add(keyOf(stop));

  const remainingSeconds = Math.round(clock + unplaced.size * perVisitSeconds * 2);
  return {
    projectedFinishAt: underway ? new Date(now + remainingSeconds * 1000).toISOString() : null,
    remainingSeconds,
    stopsRemaining: reachedAt.size + unplaced.size,
    perVisitSeconds,
    basis: measured === null ? 'ESTIMATED' : 'MEASURED',
    current,
    arrivals: underway ? arrivals : [],
  };
}

/**
 * A technician's day as the console receives it.
 *
 * Here rather than beside the service that builds it, for the same reason every
 * other response shape is: the web app cannot import from the backend, and a
 * second hand-written copy of this on the client is how the two drift.
 */
export interface TechnicianDayTimeline {
  technicianId: string;
  segments: TimelineSegment[];
  totals: DayTotals;
  projection: RemainderProjection;
  stops: {
    /**
     * Keyed by building, not by inspection. Two inspections at one address on
     * one day are one visit, and timing them separately reports the same
     * minutes twice.
     */
    buildingId: string;
    propertyName: string;
    inspectionIds: string[];
    onSiteSeconds: number;
    driveToSeconds: number | null;
  }[];
  /** Assigned, but with no coordinate to time them against. */
  untimedInspectionIds: string[];
}
