import type { RemainderProjection, TechnicianRoute } from '@texasrenters/shared';

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
