/**
 * Every display format the app uses, in one place.
 *
 * The old app defined `formatDate` in `components/shared.tsx` next to the table
 * primitives, so importing a date formatter pulled in the whole UI kit — which
 * is why the PDF renderer ended up with its own copy that drifted.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const DATE_ONLY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
/**
 * For a value that is a *day*, not an instant.
 *
 * `Inspection.scheduledAt` is a Postgres `date`, serialised as midnight UTC.
 * Rendering it through the reader's time zone moves it: `2026-09-03T00:00:00Z`
 * reads as September 3rd in Manila and **September 2nd in Texas**, which is
 * every office this system serves. Pinning the formatter to UTC makes the day
 * displayed the day stored, for everyone.
 */
const SCHEDULED_DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** The em dash, used everywhere a value is genuinely absent. */
export const EMPTY = '—';

export function formatDateTime(value?: string | Date | null) {
  if (!value) return EMPTY;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EMPTY : DATE_TIME.format(date);
}

export function formatDate(value?: string | Date | null) {
  if (!value) return EMPTY;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EMPTY : DATE_ONLY.format(date);
}

/**
 * A scheduled day, shown as the day it is.
 *
 * Use this for `scheduledAt` and never `formatDate` or `formatDateTime`. Those
 * localise, which is correct for an instant and wrong for a date — and
 * `formatDateTime` additionally printed a time that does not exist, so every
 * inspection in the list claimed to be at 8:00 AM because that is what midnight
 * UTC looks like from Manila.
 */
export function formatScheduledDate(value?: string | Date | null) {
  if (!value) return EMPTY;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EMPTY : SCHEDULED_DAY.format(date);
}

export function formatCurrency(value?: number | string | null) {
  if (value === null || value === undefined || value === '') return EMPTY;
  const amount = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(amount) ? CURRENCY.format(amount) : EMPTY;
}

export function formatCount(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : EMPTY;
}

/**
 * Relative time, for anything a person reads to judge freshness — "synced 4
 * minutes ago" answers the question an absolute timestamp makes them compute.
 */
const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function formatRelative(value?: string | Date | null, now: Date = new Date()) {
  if (!value) return EMPTY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EMPTY;
  const delta = date.getTime() - now.getTime();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return 'just now';
}

export function formatAddress(item?: {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
} | null) {
  if (!item) return EMPTY;
  return [item.addressLine1, item.city, item.state].filter(Boolean).join(', ') || EMPTY;
}

/** `REVIEW_REQUIRED` → `Review required`. For enums with no StatusBadge entry. */
export function humanize(value?: string | null) {
  if (!value) return EMPTY;
  return value
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

export function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

/**
 * A driving duration, rounded to something a person would say out loud.
 *
 * Minutes, or hours and minutes past an hour. Never seconds: these come from a
 * routing engine with no traffic data, and "23 min" already claims more
 * precision than free-flow timing can support — "23 min 41 s" would be a
 * fiction with a decimal point.
 */
export function formatDuration(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EMPTY;

  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** Distance in miles, which is what everybody here reads. */
export function formatDistance(meters?: number | null) {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return EMPTY;
  const miles = meters / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}
