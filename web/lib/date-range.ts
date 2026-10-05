import { businessDayRange } from './clock';

/**
 * Calendar dates, and the instants a date-bounded API query needs.
 *
 * A date picked is a calendar date, carried as `yyyy-MM-dd` and built from a
 * Date's local parts so the picker never moves it. The instants a query sends
 * are **Texas** midnights (the office, 2026-10-06: "we are not using Manila
 * time"): "1 September" from the Manila office is the field's 1 September, not
 * a day that ended thirteen hours before it.
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

/**
 * The lower bound of a date filter: the first instant of that Texas day, as an
 * ISO string. `undefined` when nothing is picked, so it drops out of the query.
 */
export function dayStart(value: string | undefined) {
  return value ? businessDayRange(value)?.from : undefined;
}

/**
 * The upper bound: the **last** instant of that Texas day.
 *
 * Not midnight. The API's comparison is `lte` against a timestamp, so a bare
 * date would exclude everything scheduled after 00:00 on the very day the reader
 * chose — the end of the range would quietly go missing.
 */
export function dayEnd(value: string | undefined) {
  return value ? businessDayRange(value)?.to : undefined;
}

/**
 * A human label for a range, including the open-ended cases.
 *
 * "through", never "before": both bounds include the day picked, and "before 30
 * Sept" over a list that contains the 30th would be a lie.
 */
export function rangeLabel(from: string, to: string) {
  const short = (value: string) =>
    fromDateValue(value)?.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }) ?? '';
  if (from && to) return `${short(from)} – ${short(to)}`;
  return from ? `from ${short(from)}` : `through ${short(to)}`;
}
