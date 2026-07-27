/**
 * Lease expiry, defined once so the API summary, the properties list, and the
 * property detail page all agree on what "expiring soon" means.
 *
 * Two dates in a Propertyware lease answer different questions and must not be
 * conflated:
 *
 * - `endDate` — when the lease *term* ends. This is renewal-planning data.
 * - `scheduledMoveOutDate` — when the tenant is scheduled to leave, typically
 *   set once notice is given. This is turnover/inspection-scheduling data, and
 *   may be earlier than, later than, or absent alongside the term end.
 *
 * Expiry here always means the term end. Scheduled move-outs are counted
 * separately and neither value is ever substituted for the other.
 */

/** Horizon for "ending soon", matching the usual renewal-conversation window. */
export const LEASE_EXPIRING_SOON_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days from `now` until `endDate`. Negative when already past, null when
 * there is no usable date. Both sides are floored to UTC midnight so a lease
 * ending today reads as 0 rather than a fraction of a day.
 */
export function daysUntilLeaseEnd(
  endDate: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!endDate) return null;
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  if (Number.isNaN(end.getTime())) return null;
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((endDay - today) / MS_PER_DAY);
}

export type LeaseExpiryStatus = 'EXPIRED' | 'EXPIRING_SOON' | 'ACTIVE' | 'UNKNOWN';

export function leaseExpiryStatus(
  endDate: string | Date | null | undefined,
  now: Date = new Date(),
): LeaseExpiryStatus {
  const days = daysUntilLeaseEnd(endDate, now);
  if (days === null) return 'UNKNOWN';
  if (days < 0) return 'EXPIRED';
  return days <= LEASE_EXPIRING_SOON_DAYS ? 'EXPIRING_SOON' : 'ACTIVE';
}

/** Short, display-ready phrasing for a lease end date. */
export function leaseExpiryLabel(
  endDate: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  const days = daysUntilLeaseEnd(endDate, now);
  if (days === null) return 'No end date';
  if (days < 0) return `Ended ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'Ends today';
  return `Ends in ${days} day${days === 1 ? '' : 's'}`;
}
