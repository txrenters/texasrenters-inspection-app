import type { Inspection } from '../domain/models';

type Scheduled = Pick<Inspection, 'scheduledAt' | 'scheduledStartAt' | 'scheduledEndAt'>;

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const isValid = (iso: string | undefined): iso is string =>
  Boolean(iso) && !Number.isNaN(new Date(iso!).getTime());

/**
 * The clock window a visit was booked for, or null when it was booked to a day.
 *
 * Null is the important case and the common one: only visits scheduled in
 * Jobber carry a time, and `scheduledAt` is a date column whose midnight is an
 * artefact of storage, not a booking. Rendering that midnight would tell a
 * technician to be somewhere at 12:00 AM, so a visit with no start time shows
 * only its day and this returns null rather than a formatted fiction.
 *
 * An en dash rather than a hyphen: this is a range, and the row it sits in
 * already uses one for every other range.
 */
export function formatVisitWindow(inspection: Scheduled): string | null {
  if (!isValid(inspection.scheduledStartAt)) return null;
  const start = time(inspection.scheduledStartAt);
  if (!isValid(inspection.scheduledEndAt)) return start;
  const end = time(inspection.scheduledEndAt);
  // A zero-length window is a point in time, not a range. Jobber sends these
  // for visits somebody gave a start but no duration.
  return end === start ? start : `${start} – ${end}`;
}

/**
 * When the visit actually starts, for counting down to.
 *
 * Falls back to `scheduledAt` so a day-booked inspection keeps behaving exactly
 * as it did. This is deliberately NOT used to decide whether something is
 * overdue — that stays a whole-day comparison, because treating midnight as a
 * deadline once marked every one of today's inspections late by breakfast.
 */
export function visitStartInstant(inspection: Scheduled): string {
  return isValid(inspection.scheduledStartAt) ? inspection.scheduledStartAt : inspection.scheduledAt;
}

/**
 * The date, plus the window when there is one, as one line.
 *
 * Used for accessibility labels, where a screen reader gets one string and the
 * visible split between date and time is not available to it.
 */
export function formatVisitDateAndWindow(inspection: Scheduled, date: string): string {
  const window = formatVisitWindow(inspection);
  return window ? `${date}, ${window}` : date;
}
