/**
 * Position reports from a technician's handset.
 *
 * The rules live here rather than in the ingest DTO because they are the same
 * questions the handset should ask before queueing a point at all: sending a
 * fix the server will only reject wastes the one thing a phone in the field is
 * short of, which is signal.
 */

/**
 * How many fixes one request may carry.
 *
 * A handset that has been out of signal for an hour has a lot to say, and
 * asking it to send them one at a time is how a queue never drains. Capped so
 * a single request cannot ask the database for an unbounded write.
 */
export const MAX_LOCATION_BATCH = 200;

/**
 * How far ahead of the server a device's clock may be and still be believed.
 *
 * Phone clocks drift and time zones are set wrongly, so a small tolerance is
 * ordinary. A fix minutes in the future is not drift — it is a wrong clock, and
 * storing it would put a point in a trail before the technician got there.
 */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * The coarsest fix worth recording, in metres.
 *
 * A phone with no satellites falls back to the cell tower and reports
 * kilometres of uncertainty. Drawing that as a position is the map claiming
 * something nobody knows, so it is dropped at the door rather than stored and
 * filtered later.
 */
export const MAX_USEFUL_ACCURACY_M = 500;

export interface TechnicianLocationFix {
  latitude: number;
  longitude: number;
  /** ISO 8601, taken from the handset's clock when the fix was made. */
  recordedAt: string;
  accuracyMeters?: number | null;
  batteryPercent?: number | null;
}

export type LocationFixRejection =
  'IMPOSSIBLE_COORDINATE' | 'UNREADABLE_TIMESTAMP' | 'FUTURE_TIMESTAMP' | 'TOO_IMPRECISE';

/**
 * Why this fix cannot be stored, or `null` if it can.
 *
 * Returns the reason rather than a boolean so the caller can say which fixes
 * it dropped and why. A batch that silently loses half its points is the
 * failure mode this whole feature is most likely to have, and it would look
 * exactly like a technician standing still.
 */
export function rejectLocationFix(
  fix: TechnicianLocationFix,
  now = Date.now(),
): LocationFixRejection | null {
  const { latitude, longitude } = fix;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 'IMPOSSIBLE_COORDINATE';
  if (latitude < -90 || latitude > 90) return 'IMPOSSIBLE_COORDINATE';
  if (longitude < -180 || longitude > 180) return 'IMPOSSIBLE_COORDINATE';

  const recordedAt = Date.parse(fix.recordedAt);
  if (Number.isNaN(recordedAt)) return 'UNREADABLE_TIMESTAMP';
  if (recordedAt > now + MAX_CLOCK_SKEW_MS) return 'FUTURE_TIMESTAMP';

  // Absent accuracy is accepted: some devices simply do not report it, and
  // refusing those would silently exclude whole handset models.
  if (
    fix.accuracyMeters !== undefined &&
    fix.accuracyMeters !== null &&
    fix.accuracyMeters > MAX_USEFUL_ACCURACY_M
  )
    return 'TOO_IMPRECISE';

  return null;
}

/** The fixes worth sending or storing, in the order they were taken. */
export function usableLocationFixes<T extends TechnicianLocationFix>(
  fixes: readonly T[],
  now = Date.now(),
): T[] {
  return [...fixes]
    .filter((fix) => rejectLocationFix(fix, now) === null)
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
}

/**
 * A technician's most recent known position, as the console receives it.
 *
 * Coordinates are numbers here because the API converts them at its edge: the
 * database column is a decimal, and a Prisma `Decimal` serialises to a string
 * through JSON, which a map cannot plot.
 *
 * `recordedAt` is when the handset took the fix. The age of that is the whole
 * story on a map — a position from six hours ago is not a lie, but drawing it
 * the same as one from a minute ago would be — so it travels with the point
 * and the console decides how to show it.
 */
export interface TechnicianPosition {
  id: string;
  technicianId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  batteryPercent: number | null;
  recordedAt: string;
  technician: { id: string; displayName: string } | null;
}
