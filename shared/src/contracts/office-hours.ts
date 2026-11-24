import { usFederalHolidays } from './quarter-plan.js';

/**
 * When a technician's location may be recorded and shared: office hours only.
 *
 * Monday to Friday, 7 AM up to 6 PM Texas time, and never on a weekend or a US
 * federal holiday (the office, 2026-11-24). This replaces "the whole time they
 * are signed in" (2026-09-16): a phone left signed in over a weekend recorded
 * and sent where its owner went on their own time.
 *
 * One rule in one place, asked at every step a position passes through. The
 * phone does not start recording outside these hours, stops when they end, and
 * drops any fix taken outside them before it is queued or sent; the API refuses
 * one that arrives anyway, from a phone still running an older build.
 *
 * Read by the fix's own time (`recordedAt`), not by when it arrives: a fix from
 * 5:55 PM held back by a dead zone and sent at 6:10 PM is still an office-hours
 * fix, and one from Saturday is refused whenever it turns up.
 *
 * The hour either side of the office's own 8 to 5 is deliberate: it keeps the
 * drive to the first property and a visit that runs late on the map and the
 * timesheet. Days the office names as closed beyond the federal holidays are
 * not included -- the phone has no way to know them.
 */

/** The office's zone. Every technician works in it, whatever their phone says. */
export const OFFICE_TIME_ZONE = 'America/Chicago';

/** Minutes after midnight, Texas time, when sharing starts: 7:00 AM. */
export const OFFICE_HOURS_START_MINUTE = 7 * 60;

/** Minutes after midnight, Texas time, when sharing stops: 6:00 PM, not included. */
export const OFFICE_HOURS_END_MINUTE = 18 * 60;

/** The hours, as a technician or the office reads them. */
export const OFFICE_HOURS_TEXT = 'Monday to Friday, 7 AM to 6 PM';

/** A moment as the office's wall clock reads it. */
export interface OfficeClock {
  /** `YYYY-MM-DD`, the Texas day. */
  date: string;
  /** 0 for Sunday to 6 for Saturday. */
  weekday: number;
  /** Minutes after Texas midnight. */
  minute: number;
}

const HOUR_MS = 3_600_000;
const MAX_OFFSET_MINUTES = 14 * 60;

let texasFormat: Intl.DateTimeFormat | null = null;

/**
 * Texas's offset from UTC at an instant, read through `Intl` with the zone
 * named, so a phone set to another zone still keeps Texas hours.
 *
 * Remembered per UTC hour. The phone asks this for every fix in its queue --
 * up to five thousand of them, on every send -- and the offset can only change
 * on a daylight-saving boundary, which is always on the hour.
 */
const offsetByHour = new Map<number, number>();

function texasOffsetMinutes(time: number): number {
  const hour = Math.floor(time / HOUR_MS);
  const known = offsetByHour.get(hour);
  if (known !== undefined) return known;

  let offset: number | null = null;
  try {
    texasFormat ??= new Intl.DateTimeFormat('en-US', {
      timeZone: OFFICE_TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = texasFormat.formatToParts(new Date(hour * HOUR_MS));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((entry) => entry.type === type)?.value);
    const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'));
    const minutes = Math.round((wall - hour * HOUR_MS) / 60_000);
    if (Number.isFinite(minutes) && Math.abs(minutes) <= MAX_OFFSET_MINUTES) offset = minutes;
  } catch {
    // Falls through to the device's own zone below.
  }
  // A platform that cannot do zones uses its own clock: every technician's
  // phone is in Texas, and this is what `texasToday` on the phone does too.
  if (offset === null) offset = -new Date(time).getTimezoneOffset();

  if (offsetByHour.size > 2_000) offsetByHour.clear();
  offsetByHour.set(hour, offset);
  return offset;
}

/** An instant as the office's wall clock reads it. */
export function officeClock(at: number | Date): OfficeClock {
  const time = typeof at === 'number' ? at : at.getTime();
  const wall = new Date(time + texasOffsetMinutes(time) * 60_000);
  return {
    date: wall.toISOString().slice(0, 10),
    weekday: wall.getUTCDay(),
    minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
  };
}

const holidaysByYear = new Map<number, ReadonlySet<string>>();

function holidaysOf(year: number): ReadonlySet<string> {
  let holidays = holidaysByYear.get(year);
  if (!holidays) {
    holidays = new Set(usFederalHolidays(year));
    holidaysByYear.set(year, holidays);
  }
  return holidays;
}

/** Whether a Texas day (`YYYY-MM-DD`) is a working day: a weekday that is not a federal holiday. */
export function isOfficeDay(date: string): boolean {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (!Number.isFinite(weekday) || weekday === 0 || weekday === 6) return false;
  return !holidaysOf(Number(date.slice(0, 4))).has(date);
}

/**
 * Whether location may be recorded and shared at this instant.
 *
 * False for anything that is not a real time, so a fix with an unreadable
 * clock is never taken as an office-hours one.
 */
export function isWithinOfficeHours(at: number | Date): boolean {
  const time = typeof at === 'number' ? at : at.getTime();
  if (!Number.isFinite(time)) return false;
  const clock = officeClock(time);
  return (
    isOfficeDay(clock.date) &&
    clock.minute >= OFFICE_HOURS_START_MINUTE &&
    clock.minute < OFFICE_HOURS_END_MINUTE
  );
}
