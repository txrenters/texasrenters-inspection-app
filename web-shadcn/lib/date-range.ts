/**
 * Calendar dates, and the instants a date-bounded API query needs.
 *
 * Everything here is deliberately **local**. A coordinator picking "1 September"
 * means their own 1 September; the API compares against `scheduledAt`, a
 * timestamp, so getting the conversion wrong shifts results by a day in one
 * direction and silently truncates a range in the other.
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
 * The lower bound of a date filter: the first instant of that local day, as an
 * ISO string. `undefined` when nothing is picked, so it drops out of the query.
 */
export function dayStart(value: string | undefined) {
  return fromDateValue(value)?.toISOString();
}

/**
 * The upper bound: the **last** instant of that local day.
 *
 * Not midnight. The API's comparison is `lte` against a timestamp, so a bare
 * date would exclude everything scheduled after 00:00 on the very day the reader
 * chose — the end of the range would quietly go missing.
 */
export function dayEnd(value: string | undefined) {
  const date = fromDateValue(value);
  if (!date) return undefined;
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
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
