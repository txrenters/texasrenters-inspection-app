import type { TechnicianRoute } from '@texasrenters/shared';

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
