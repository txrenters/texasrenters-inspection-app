import {
  isFinishedStatus,
  type AssignedStop,
  type RemainderProjection,
  type TechnicianDayTimeline,
  type TechnicianRoute,
} from '@texasrenters/shared';

import { businessTimeOfDay } from './clock';

/**
 * Reading a planned route apart from a refused one.
 *
 * This lives in one place because it did not, and that is exactly how the bug
 * happened. Three separate components each decided for themselves whether a
 * route existed, all three asked `stops.length`, and all three were wrong in
 * the same way. Fixing one of them left the other two printing a drive that had
 * been correctly refused.
 */

/**
 * Whether this route actually is one.
 *
 * **Legs, not stops.** `stops` is the day's work and the planner returns it
 * whether or not anything was routed — the inspections exist either way. A leg
 * is produced only when the routing engine returned a drive, so this is true
 * exactly when there is an order and a time worth showing.
 *
 * It is false whenever `originOutsideServiceArea` is set, which is what keeps a
 * refusal from ever being displayed next to a duration. Reading `stops` instead
 * produced "1 min driving · 0.0 mi · suggested order" under a message saying
 * there was no suggested order — a zero total, rendered as a minute because
 * `formatDuration` floors at one.
 */
export function isPlanned(route: TechnicianRoute | null | undefined): route is TechnicianRoute {
  return Boolean(route?.legs.length);
}

/**
 * Stops the router refused because nothing drivable is near them.
 *
 * Distinct from a stop with no coordinate at all: this one has a coordinate and
 * it is wrong — an address geocoded into open water, or outside the region the
 * routing extract covers. Worth saying differently because the fix is different.
 */
export function offRoadNetwork(route: TechnicianRoute | null | undefined): Set<string> {
  return new Set(
    (route?.unroutable ?? [])
      .filter((entry) => entry.reason === 'OUTSIDE_SERVICE_AREA')
      .map((entry) => entry.inspectionId),
  );
}

/**
 * How to describe the stops the route could not include.
 *
 * Two reasons, two different faults, and the old copy only described one of
 * them: "the address could not be placed on the map" is true of a property that
 * never geocoded and false of one that geocoded into the Gulf.
 */
export function describeUnroutable(route: TechnicianRoute): string | null {
  const missing = route.unroutable.filter((entry) => entry.reason === 'NO_COORDINATES');
  const offNetwork = route.unroutable.filter((entry) => entry.reason === 'OUTSIDE_SERVICE_AREA');

  const parts: string[] = [];
  if (missing.length)
    parts.push(
      `${names(missing)} ${missing.length === 1 ? 'has' : 'have'} no location on file`,
    );
  if (offNetwork.length)
    parts.push(
      `${names(offNetwork)} ${offNetwork.length === 1 ? 'is' : 'are'} not near a road we can route on`,
    );

  return parts.length ? `${parts.join('; ')}.` : null;
}

function names(entries: { propertyName: string }[]) {
  return entries.map((entry) => entry.propertyName).join(', ');
}

/** "1 stop", not "1 stops". */
/**
 * What the drive times are, in one sentence, or null when nothing was timed.
 *
 * Said only where it is true. This was a fixed "estimated from speed limits,
 * without traffic" under every route -- written when OSRM was the only router,
 * and false on every route once Google, which times against traffic, became
 * the one answering.
 */
export function timingNote(route: TechnicianRoute | null | undefined): string | null {
  switch (route?.source) {
    case 'GOOGLE_TRAFFIC':
      return 'Drive times include traffic.';
    case 'OSRM_FREE_FLOW':
      return 'Estimated from speed limits, without traffic.';
    default:
      return null;
  }
}

export function pluralStops(count: number) {
  return `${count} ${count === 1 ? 'stop' : 'stops'}`;
}

/**
 * Where a route starts, in words.
 *
 * A route from somebody's house and a route from where they are standing are
 * different claims. Drawn identically, a dispatcher reading "34 min driving" at
 * nine in the morning cannot tell whether that is the day ahead of somebody who
 * has not left home or of somebody already halfway through it.
 *
 * The last-seen time is in Texas, where the work is, rather than wherever the
 * reader happens to be -- the office is frequently in Manila.
 */
export function describeOrigin(route: TechnicianRoute): string | null {
  switch (route.originKind) {
    case 'LIVE':
      return 'from their live position';
    case 'HOME':
      return 'from home';
    case 'LAST_KNOWN': {
      const time = businessTimeOfDay(route.origin?.recordedAt);
      return time ? `from where they were last seen at ${time}` : 'from where they were last seen';
    }
    default:
      return null;
  }
}

/**
 * A stop's expected arrival, as a time of day in Texas, or null if it has none.
 *
 * Read from the day's projection rather than from the route, because only the
 * projection knows how long somebody has already been at the stop they are on.
 * Null for that stop, for one already behind them, and on a day that is not
 * under way -- a panel would otherwise print a time as though it were a
 * forecast.
 */
export function arrivalTime(
  projection: RemainderProjection | null | undefined,
  inspectionId: string,
): string | null {
  const arrival = projection?.arrivals.find((entry) => entry.inspectionId === inspectionId);
  return businessTimeOfDay(arrival?.arriveAt);
}

/** How long they have been at this stop, if it is the visit under way; otherwise null. */
export function onSiteSeconds(
  projection: RemainderProjection | null | undefined,
  inspectionId: string,
): number | null {
  const current = projection?.current;
  return current?.inspectionIds.includes(inspectionId) ? current.onSiteSeconds : null;
}

/**
 * The stops in the order they should be driven, when that is known.
 *
 * The route only carries stops it could place, so anything it dropped is
 * appended rather than lost -- a property with no coordinate is still work,
 * and a list that quietly held fewer inspections than the count above it
 * would be the worse failure.
 */
export function orderStops(stops: AssignedStop[], route: TechnicianRoute | null | undefined) {
  // Guarded on the same predicate as everything else: a refused plan still
  // carries stops, in whatever order the database returned them, and quietly
  // reordering the panel to match would present that as a recommendation.
  if (!isPlanned(route)) return stops;

  const byInspection = new Map(stops.map((stop) => [stop.inspectionId, stop]));
  const ordered = route.stops
    .map((stop) => byInspection.get(stop.inspectionId))
    .filter((stop): stop is AssignedStop => Boolean(stop));

  const seen = new Set(ordered.map((stop) => stop.inspectionId));
  return [...ordered, ...stops.filter((stop) => !seen.has(stop.inspectionId))];
}

/**
 * What a stop is to the day so far.
 *
 * - `FINISHED` -- handed in. Greyed out, kept as the day's history.
 * - `CURRENT` -- where the technician is now, by their location trail.
 * - `NEXT` -- the first stop still ahead of them. Green on the list and the map.
 * - `AHEAD` -- everything after it.
 */
export type DayStopRole = 'FINISHED' | 'CURRENT' | 'NEXT' | 'AHEAD';

export interface DayStopListing {
  stop: AssignedStop;
  role: DayStopRole;
  /** Where the stop sits in the drawn route -- its number and its leg. Null when it is not in it. */
  routeIndex: number | null;
}

const finishedTime = (iso: string | null) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/**
 * A technician's day as the list shows it.
 *
 * Finished stops first, in the order they were handed in: they used to vanish
 * the moment they were submitted, so by the afternoon the panel showed only
 * what was left and nothing of what had been done. Then what is left, in the
 * order the route drives it.
 *
 * `NEXT` only exists where there is a route. Without one the remaining stops
 * are in no order at all, and calling one of them next would be a
 * recommendation nobody made.
 */
export function listDay(
  stops: AssignedStop[],
  route: TechnicianRoute | null | undefined,
  currentInspectionIds: readonly string[] | null | undefined,
): DayStopListing[] {
  const current = new Set(currentInspectionIds ?? []);
  const finished = stops
    .filter((stop) => isFinishedStatus(stop.status))
    .sort((left, right) => finishedTime(left.finishedAt) - finishedTime(right.finishedAt));
  const remaining = orderStops(
    stops.filter((stop) => !isFinishedStatus(stop.status)),
    route,
  );
  const planned = isPlanned(route) ? route : null;
  const nextId = planned
    ? remaining.find(
        (stop) =>
          !current.has(stop.inspectionId) &&
          planned.stops.some((entry) => entry.inspectionId === stop.inspectionId),
      )?.inspectionId
    : undefined;

  return [
    ...finished.map((stop) => ({ stop, role: 'FINISHED' as const, routeIndex: null })),
    ...remaining.map((stop) => {
      const index = planned
        ? planned.stops.findIndex((entry) => entry.inspectionId === stop.inspectionId)
        : -1;
      const role: DayStopRole = current.has(stop.inspectionId)
        ? 'CURRENT'
        : stop.inspectionId === nextId
          ? 'NEXT'
          : 'AHEAD';
      return { stop, role, routeIndex: index === -1 ? null : index };
    }),
  ];
}

/**
 * A visit's actual times, from the inspection itself.
 *
 * Started when the technician pressed Start in the app, finished when they
 * submitted. The location trail can only estimate a visit, and it goes quiet
 * whenever a phone stops reporting -- it called a day of ten visits "1 min
 * driving". These are what the office asked to see.
 */
export interface ActualVisit {
  startedAt: string;
  submittedAt: string | null;
  /** Submitted minus started; for a visit still under way, so far. */
  onSiteSeconds: number | null;
  inProgress: boolean;
  /**
   * From submitting the previous visit to starting this one: the drive from
   * one property to the next, including whatever else happened on the way.
   * Null for the first visit of the day, for a second inspection at the same
   * property, and when the two visits overlapped.
   */
  driveSeconds: number | null;
  /** The property that drive started from. */
  fromPropertyName: string | null;
}

/** Every started visit of a day, keyed by inspection. */
export function actualVisits(
  stops: readonly AssignedStop[],
  now: number = Date.now(),
): Map<string, ActualVisit> {
  const started = stops
    .filter((stop) => stop.startedAt && Number.isFinite(Date.parse(stop.startedAt)))
    .sort((left, right) => Date.parse(left.startedAt!) - Date.parse(right.startedAt!));
  const visits = new Map<string, ActualVisit>();
  for (const stop of started) {
    const start = Date.parse(stop.startedAt!);
    const submit = stop.submittedAt ? Date.parse(stop.submittedAt) : Number.NaN;
    const submitted = Number.isFinite(submit) && submit >= start;
    // The visit handed in most recently before this one began.
    const previous = started
      .filter((other) => other !== stop && other.submittedAt)
      .map((other) => ({ other, at: Date.parse(other.submittedAt!) }))
      .filter(({ at }) => Number.isFinite(at) && at <= start)
      .sort((left, right) => right.at - left.at)[0];
    const sameProperty = Boolean(
      previous && stop.buildingId && previous.other.buildingId === stop.buildingId,
    );
    const drove = previous && !sameProperty ? previous : null;
    visits.set(stop.inspectionId, {
      startedAt: stop.startedAt!,
      submittedAt: submitted ? stop.submittedAt! : null,
      onSiteSeconds: submitted
        ? Math.round((submit - start) / 1000)
        : stop.submittedAt
          ? null
          : Math.max(0, Math.round((now - start) / 1000)),
      inProgress: !stop.submittedAt,
      driveSeconds: drove ? Math.round((start - drove.at) / 1000) : null,
      fromPropertyName: drove ? drove.other.propertyName : null,
    });
  }
  return visits;
}

/**
 * The day's actual time, added up: on site across every visit started, and
 * driving across every drive between them. Null when nothing was started in
 * the app, so a caller can fall back to the location trail.
 */
export function actualDayTotals(visits: ReadonlyMap<string, ActualVisit>) {
  if (!visits.size) return null;
  let onSiteSeconds = 0;
  let driveSeconds = 0;
  let submitted = 0;
  for (const visit of visits.values()) {
    onSiteSeconds += visit.onSiteSeconds ?? 0;
    driveSeconds += visit.driveSeconds ?? 0;
    if (visit.submittedAt) submitted += 1;
  }
  return { visits: visits.size, submitted, onSiteSeconds, driveSeconds, totalSeconds: onSiteSeconds + driveSeconds };
}

/** How long one visit took: the drive that reached it, the time there, and both. */
export interface VisitTimes {
  driveSeconds: number | null;
  onSiteSeconds: number;
  totalSeconds: number;
}

/**
 * The measured time of a visit, from the day's location trail.
 *
 * Null when the trail never put the technician at the place -- a handset that
 * was not reporting, or a stop handed in from somewhere else. Nothing is
 * inferred from when the paperwork was opened and submitted, which describes
 * the form rather than the visit.
 */
export function visitTimes(
  timeline: TechnicianDayTimeline | null | undefined,
  inspectionId: string,
): VisitTimes | null {
  const place = timeline?.stops.find((entry) => entry.inspectionIds.includes(inspectionId));
  if (!place || place.onSiteSeconds <= 0) return null;
  return {
    driveSeconds: place.driveToSeconds,
    onSiteSeconds: place.onSiteSeconds,
    totalSeconds: place.onSiteSeconds + (place.driveToSeconds ?? 0),
  };
}

/**
 * The finished part of the day, added up.
 *
 * Each place counted once, however many inspections were handed in at it: two
 * inspections at one address are one visit on the trail, and adding its time
 * twice would inflate exactly the figure this exists to report.
 */
export function historyTotals(
  timeline: TechnicianDayTimeline | null | undefined,
  listings: readonly DayStopListing[],
) {
  const finished = listings.filter((listing) => listing.role === 'FINISHED');
  const places = new Map<string, VisitTimes>();
  for (const { stop } of finished) {
    const place = timeline?.stops.find((entry) => entry.inspectionIds.includes(stop.inspectionId));
    const times = visitTimes(timeline, stop.inspectionId);
    if (place && times) places.set(place.buildingId, times);
  }
  let driveSeconds = 0;
  let onSiteSeconds = 0;
  for (const times of places.values()) {
    driveSeconds += times.driveSeconds ?? 0;
    onSiteSeconds += times.onSiteSeconds;
  }
  return {
    finished: finished.length,
    measured: places.size,
    driveSeconds,
    onSiteSeconds,
    totalSeconds: driveSeconds + onSiteSeconds,
  };
}
