/**
 * Distances and times, in the units the technician driving actually reads.
 *
 * ## Miles here, metres on the console. Deliberately.
 *
 * Everything in `shared/` is SI -- `NAV_OFF_ROUTE_M`, `metersToManeuver`,
 * `distanceMeters` -- because arithmetic in mixed units is how a threshold
 * silently becomes three times itself. The office console prints those metres
 * as metres, and that is right for the office.
 *
 * The phone does not. It is read by a technician in Texas at the wheel, who
 * thinks in miles and feet and has one second to read the banner. "In 400 m,
 * turn right" is a sentence nobody in Houston has ever said out loud, and a
 * driver who has to convert it has stopped looking at the road.
 *
 * So the split is: metres everywhere inside, imperial only in the strings this
 * file makes, and nothing downstream converts again. Somebody will eventually
 * find the console in metres and the phone in miles and try to "fix" one of
 * them into the other -- this comment is why they should not.
 */

const FEET_PER_METER = 3.280_839_895;
const METERS_PER_MILE = 1_609.344;

/**
 * Below this, feet read better than a fraction of a mile.
 *
 * 0.1 mi is about 530 ft. A countdown of "0.1 mi" sits there unchanged for the
 * last twenty seconds of the approach, which is exactly the stretch where the
 * driver needs to know whether the turn is this junction or the next one. Feet
 * keep moving.
 */
const FEET_BELOW_METERS = 0.1 * METERS_PER_MILE;

/** Above this, the tenth of a mile is noise on a number nobody acts on yet. */
const WHOLE_MILES_ABOVE = 10;

/**
 * A distance, as the banner prints it.
 *
 * Feet are rounded to ten because GPS does not know the difference between 412
 * and 418 feet and a figure that precise invites the driver to believe it.
 */
export function formatDistance(meters: number): string {
  const safe = Number.isFinite(meters) && meters > 0 ? meters : 0;

  if (safe < FEET_BELOW_METERS) {
    const feet = Math.round((safe * FEET_PER_METER) / 10) * 10;
    // Never "0 ft" with a turn still ahead: the maneuver is at the driver's
    // bumper, not behind them, and "0 ft" reads as a bug.
    return `${Math.max(feet, 10)} ft`;
  }

  const miles = safe / METERS_PER_MILE;
  if (miles < WHOLE_MILES_ABOVE) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

/**
 * A duration, as the HUD prints it.
 *
 * Rounded to whole minutes throughout. Seconds on an ETA are a promise no
 * traffic-aware estimate can keep, and a ticking seconds field reads as a
 * countdown to something rather than as an estimate of it.
 */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.max(1, Math.round(safe / 60));

  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * The clock time an arrival is expected at, in the device's own locale.
 *
 * `undefined` rather than a fixed locale: the handset is set up by the person
 * holding it, and a technician whose phone is in 24-hour time should not be
 * handed "5:20 PM" because this file decided. Invalid input gives an em dash
 * rather than "Invalid Date", which is what `toLocaleTimeString` says.
 */
export function formatArrivalClock(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return '—';
  try {
    return new Date(epochMs).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Metres to miles, for the few places that need the number rather than the
 * string -- a threshold comparison, a test assertion.
 */
export function milesFromMeters(meters: number): number {
  return meters / METERS_PER_MILE;
}
