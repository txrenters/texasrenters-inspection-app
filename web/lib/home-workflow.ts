import type { JobberDayRow, RescheduleRequestKind, RescheduleRequestView } from '@texasrenters/shared';

import { shiftDay } from '@/lib/clock';
import { statusGroup } from '@/lib/schedule-calendar';

/**
 * Home in the Jobber-style shell (components/home), laid out as Jobber's: a
 * greeting, the Workflow cards, and today's visits. The arithmetic behind it,
 * apart from the page so each rule is testable.
 */

/**
 * "Good morning" by the READER's clock, not Texas's. The greeting is about the
 * person at the screen -- the office reads from Manila -- while every date and
 * time on the page stays Texas and says so.
 */
export function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "Tuesday, November 3": the Texas business day, as a date is read (noon UTC is that date everywhere). */
export function texasDayLabel(today: string): string {
  return new Date(`${today}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The first word of a display name, for "Good evening, Ada". */
export function firstName(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/u)[0];
  return first || null;
}

/** Today's visits as Jobber's Home groups them. Cancelled visits are not work, so they are left out. */
export interface TodayBuckets {
  active: JobberDayRow[];
  /** Still to happen, including a visit Jobber has that is not an inspection here yet. */
  remaining: JobberDayRow[];
  done: JobberDayRow[];
}

export function todayBuckets(rows: readonly JobberDayRow[]): TodayBuckets {
  const buckets: TodayBuckets = { active: [], remaining: [], done: [] };
  for (const row of rows) {
    const group = statusGroup(row);
    if (group === 'active') buckets.active.push(row);
    else if (group === 'done') buckets.done.push(row);
    else if (group === 'upcoming' || group === 'jobber') buckets.remaining.push(row);
  }
  return buckets;
}

/**
 * The newest day an overdue visit can be on: yesterday, sent as its UTC
 * midnight.
 *
 * `Inspection.scheduledAt` is a date held as its UTC midnight, and Prisma
 * compares a DATE column by the UTC date of what it is given. A Texas
 * end-of-day instant for yesterday (05:59Z today) has *today's* UTC date, and
 * would file all of today's visits as overdue.
 */
export function overdueCutoff(today: string): string {
  return `${shiftDay(today, -1)}T00:00:00.000Z`;
}

/** How many overdue visits Home lists before "See all". */
export const OVERDUE_LISTED = 8;

/**
 * Booked for an earlier day and never started: the list's own "Scheduled"
 * state, up to yesterday, the most recent first (yesterday's miss is the one
 * somebody can still do something about).
 */
export function overdueQuery(today: string) {
  return {
    status: 'SCHEDULED',
    scheduledTo: overdueCutoff(today),
    scheduledOrder: 'desc',
    page: 1,
    pageSize: OVERDUE_LISTED,
  } as const;
}

/** Follow-up required, counted as a one-row page of the list it links to. */
export const FOLLOW_UP_QUERY = { status: 'FOLLOW_UP', page: 1, pageSize: 1 } as const;

/** The open reschedule requests by why they were asked. */
export function rescheduleBreakdown(items: readonly RescheduleRequestView[]): Record<RescheduleRequestKind, number> {
  const counts: Record<RescheduleRequestKind, number> = { BEFORE_VISIT: 0, NO_ACCESS: 0, SERVICES_NOT_DONE: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}
