/**
 * Days as the Jobs list's calendar names them: Texas days, `YYYY-MM-DD`.
 *
 * Strings rather than Dates on purpose. A visit's `scheduledAt` is a date
 * column -- midnight UTC -- and every bug this app has had with it came from
 * turning it into an instant and back in the phone's own zone: a visit booked
 * for Oct 7 printed as "Oct 6" in Texas. A day that never becomes an instant
 * cannot drift.
 */

export type JobDay = string;

/** The office's zone. Every technician works in it, whatever their phone says. */
export const JOB_TIME_ZONE = 'America/Chicago';

const DAY_MS = 86_400_000;

function utcNoon(day: JobDay): Date {
  // Noon, so no arithmetic below can tip it into a neighbouring day.
  return new Date(`${day}T12:00:00.000Z`);
}

function dayOfUtc(date: Date): JobDay {
  return date.toISOString().slice(0, 10);
}

/**
 * Today in Texas.
 *
 * Read through `Intl` with the zone named, so a phone set to another zone --
 * or one that has travelled -- still opens on the office's today. Falls back to
 * the phone's own date only if the platform cannot do zones at all.
 */
export function texasToday(now: Date = new Date()): JobDay {
  try {
    const text = new Intl.DateTimeFormat('en-US', {
      timeZone: JOB_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).format(now);
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (match) {
      const [, month, day, year] = match;
      return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
    }
  } catch {
    // Fall through to the phone's own calendar.
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(day: JobDay, count: number): JobDay {
  return dayOfUtc(new Date(utcNoon(day).getTime() + count * DAY_MS));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: JobDay, to: JobDay): number {
  return Math.round((utcNoon(to).getTime() - utcNoon(from).getTime()) / DAY_MS);
}

/** Every day from `from` to `to`, both included. */
export function dayRange(from: JobDay, to: JobDay): JobDay[] {
  const count = daysBetween(from, to);
  return Array.from({ length: Math.max(0, count + 1) }, (_, index) => addDays(from, index));
}

/** The day a visit is booked for, straight from its date column. */
export function jobDayOf(scheduledAt: string): JobDay {
  return scheduledAt.slice(0, 10);
}

function format(day: JobDay, options: Intl.DateTimeFormatOptions): string {
  return utcNoon(day).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

/** "Tue" and "7", for a cell of the day strip. */
export function dayCell(day: JobDay): { weekday: string; date: string } {
  return { weekday: format(day, { weekday: 'short' }), date: String(Number(day.slice(8, 10))) };
}

/**
 * The day as a heading: "Today", "Tomorrow", "Yesterday", or "Thu, Oct 9" --
 * with the year only when it is not this one.
 */
export function dayHeading(day: JobDay, today: JobDay): string {
  const offset = daysBetween(today, day);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  return format(day, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  });
}

/** The full day, for a screen reader: "Tuesday, October 7, 2026". */
export function daySpoken(day: JobDay): string {
  return format(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/** A month as `YYYY-MM`. */
export type JobMonth = string;

export function monthOf(day: JobDay): JobMonth {
  return day.slice(0, 7);
}

export function addMonths(month: JobMonth, count: number): JobMonth {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(year, monthNumber - 1 + count, 1, 12));
  return dayOfUtc(date).slice(0, 7);
}

export function monthTitle(month: JobMonth): string {
  return format(`${month}-01`, { month: 'long', year: 'numeric' });
}

/**
 * The month as calendar rows, Sunday first: each row seven cells, a day or null
 * for the blanks before the 1st and after the last.
 */
export function monthGrid(month: JobMonth): (JobDay | null)[][] {
  const first = `${month}-01`;
  const leading = utcNoon(first).getUTCDay();
  const last = addDays(`${addMonths(month, 1)}-01`, -1);
  const cells: (JobDay | null)[] = [...Array<null>(leading).fill(null), ...dayRange(first, last)];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, row) => cells.slice(row * 7, row * 7 + 7));
}
