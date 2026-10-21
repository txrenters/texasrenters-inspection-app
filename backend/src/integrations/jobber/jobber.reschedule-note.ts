import { formatPhotoStamp } from '@texasrenters/shared';

/**
 * The notes a reschedule request puts on its visit's job in Jobber (2026-10-21).
 *
 * A job note, as the services report is, because Jobber has no note on a visit
 * and the office's jobs carry one visit each. Written for a coordinator who
 * works in Jobber and never opens the console: what was asked, by whom, and
 * that nothing has moved until the office says so -- or that the office
 * decided not to book it again, and why.
 */

const WEEKDAY_DAY = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Mon, Oct 27, 2026" for a `@db.Date` day, read in UTC so it is never the day before. */
function dayName(date: Date) {
  return WEEKDAY_DAY.format(date);
}

export function rescheduleRequestedNote(input: {
  reason: string;
  preferredOn: Date | null;
  scheduledAt: Date;
  technicianName: string | null;
  requestedAt: Date;
}): string {
  const stamp = formatPhotoStamp(input.requestedAt, 'DEVICE_CLOCK');
  return [
    `Reschedule requested${input.technicianName ? ` by ${input.technicianName}` : ''} in the Texas Renters inspection app${
      stamp ? `, ${stamp}` : ''
    }: ${input.reason.trim()}`,
    input.preferredOn ? `Suggested day: ${dayName(input.preferredOn)}.` : null,
    `The visit stays on ${dayName(input.scheduledAt)} until the office moves it.`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function rescheduleDismissedNote(input: {
  /** The visit was still to happen: the request asked to move it. */
  beforeVisit: boolean;
  dismissReason: string | null;
  scheduledAt: Date;
  dismissedBy: string | null;
}): string {
  const by = input.dismissedBy ? ` by ${input.dismissedBy}` : '';
  const why = input.dismissReason?.trim() ? `: ${input.dismissReason.trim()}` : '.';
  return input.beforeVisit
    ? `Reschedule request dismissed${by}${why}\nThe visit stays on ${dayName(input.scheduledAt)}.`
    : `Not booked again, decided${by} in the Texas Renters inspection app${why}`;
}
