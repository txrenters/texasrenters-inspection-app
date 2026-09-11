/**
 * "Today" means today in Texas, wherever the reader or the server happens to be.
 *
 * The work is in Texas. The office is frequently in Manila, thirteen or fourteen
 * hours ahead, and the server keeps UTC — so three clocks disagree about which
 * day it is, and only one of them is the day a technician is driving around in.
 *
 * This was computed from UTC midnight, which is 6 or 7 p.m. Texas the *previous*
 * evening. So between roughly 6 p.m. and midnight a technician's "today" already
 * held tomorrow's work, and anything genuinely scheduled for that evening was
 * filed under the following day.
 */

/** Texas, in the only form `Intl` will accept. Handles CST/CDT on its own. */
export const BUSINESS_TIME_ZONE = 'America/Chicago';

/**
 * The calendar date in Texas right now, as `YYYY-MM-DD`.
 *
 * `en-CA` because its short date format *is* ISO 8601, which avoids parsing a
 * localised string back into parts.
 */
export function businessDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The instants a Texas calendar day starts and ends, for a `scheduledAt` range.
 *
 * Derived by asking what UTC offset Texas is on *at that moment* rather than
 * assuming one: the state is on CST for part of the year and CDT for the rest,
 * and a hard-coded −6 puts every summer query an hour out. The two March and
 * November days when the offset changes are the ones that would otherwise be
 * silently wrong.
 */
export function businessDayBounds(now: Date = new Date()): { start: Date; end: Date } {
  const date = businessDate(now);

  /**
   * Midnight in Texas, as a UTC instant.
   *
   * Found by formatting a candidate instant *back* into Texas time and reading
   * the difference. One pass is enough: the offset at the candidate and the
   * offset at the answer differ only inside the one-hour discontinuity of a
   * daylight-saving change, and midnight is never inside it in this zone.
   */
  const naiveMidnight = new Date(`${date}T00:00:00.000Z`);
  const offsetMs = naiveMidnight.getTime() - zonedTime(naiveMidnight).getTime();
  const start = new Date(naiveMidnight.getTime() + offsetMs);

  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** The same instant, re-read as though the clock on the wall were UTC. */
function zonedTime(instant: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';

  // `hour` comes back as `24` at midnight under `hour12: false`, which is a
  // valid ISO hour for the *previous* day and would otherwise land a day out.
  const hour = at('hour') === '24' ? '00' : at('hour');
  return new Date(
    `${at('year')}-${at('month')}-${at('day')}T${hour}:${at('minute')}:${at('second')}.000Z`,
  );
}
