/**
 * Calendar dates as the console's pickers and filters exchange them.
 *
 * A date picked is a calendar date, carried as `yyyy-MM-dd` and built from a
 * Date's local parts so the picker never moves it.
 *
 * A filter on `scheduledAt` sends that string as it is (`scheduledOn`): the
 * column is a date, so a day is an equality. It used to be widened to the
 * instants of a Texas day, and against a date column those bounds reached into
 * the next day's visits (2026-10-07). For an instant -- a time something
 * happened -- the Texas day's bounds are `businessDayRange` in `clock.ts`.
 */

/**
 * Formats a Date as the `yyyy-MM-dd` string the forms and filters exchange.
 *
 * Built from local parts rather than `toISOString`, which converts to UTC and
 * would hand back the previous day for anyone west of Greenwich after their
 * local midnight — booking an inspection a day earlier than the one clicked.
 */
export function toDateValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parses `yyyy-MM-dd` as a local date, for the same reason. */
export function fromDateValue(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
