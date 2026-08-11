/**
 * Every display format the app uses, in one place.
 *
 * The old app defined `formatDate` in `components/shared.tsx` next to the table
 * primitives, so importing a date formatter pulled in the whole UI kit — which
 * is why the PDF renderer ended up with its own copy that drifted.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const DATE_ONLY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
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
