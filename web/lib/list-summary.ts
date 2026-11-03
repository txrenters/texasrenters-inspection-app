import { shiftDay } from '@/lib/clock';

/**
 * The arithmetic behind a list's summary strip in the Jobber-style shell
 * (components/list-summary): Jobber's "Overview" and its "Past 30 days 360
 * ↑ 29%" cards.
 */

export interface Trend {
  /** Whole percent, always positive; `direction` says which way. */
  percent: number;
  direction: 'up' | 'down' | 'flat';
}

/**
 * A count read for a strip: the total, undefined while it is still being read,
 * and null once the read has failed -- which the strip draws as a dash rather
 * than as a figure loading for ever.
 */
export function figureOf(query: { data?: { total: number }; isError: boolean }): number | null | undefined {
  return query.isError ? null : query.data?.total;
}

/** The change from one period to the next, or null when there is nothing to compare against. */
export function trendOf(current: number | null | undefined, previous: number | null | undefined): Trend | null {
  if (current == null || previous == null || previous === 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  return { percent: Math.abs(change), direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
}

/**
 * A run of whole Texas days, from `from` days after today to `to` days after
 * (negative is before), as the inspection list's date range.
 *
 * Each end is that day's UTC midnight: `Inspection.scheduledAt` is a date held
 * as its UTC midnight and compared by the UTC date of what it is given, so a
 * Texas instant would land on the neighbouring day at one end or the other.
 */
export function dayWindow(today: string, from: number, to: number) {
  return {
    scheduledFrom: `${shiftDay(today, from)}T00:00:00.000Z`,
    scheduledTo: `${shiftDay(today, to)}T00:00:00.000Z`,
  };
}

/** A list's address with only the filters that are set. */
export function listHref(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  return query ? `${path}?${query}` : path;
}
