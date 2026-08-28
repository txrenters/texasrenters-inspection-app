/**
 * Work that was due on a day that has passed.
 *
 * The console showed four current assignments above a route with one stop and
 * no way to tell where the other three went. They were scheduled for days that
 * had already passed, which means they appear on no day's route and nothing
 * said so — four green "Current" badges over three invisible jobs.
 */

/**
 * Statuses that still require somebody to drive to the property.
 *
 * The same set the route planner visits. Anything from `TECHNICIAN_SUBMITTED`
 * onward means the technician has left, so a past date is simply history rather
 * than a debt — marking a completed inspection overdue would train people to
 * ignore the flag.
 */
const STILL_TO_VISIT = new Set(['SCHEDULED', 'IN_PROGRESS', 'FOLLOW_UP_REQUIRED']);

/**
 * The calendar day an inspection is scheduled for, as `yyyy-MM-dd`.
 *
 * **Sliced, never parsed.** `Inspection.scheduledAt` is a Postgres `date` and
 * serialises as `2026-08-25T00:00:00.000Z`. Turning that into a `Date` and
 * asking for the local day answers *the twenty-fourth* anywhere behind UTC —
 * which is every office this system serves. The date is already written in the
 * only form it has; reading the first ten characters keeps it that way.
 */
export function scheduledDay(scheduledAt: string | null | undefined): string | null {
  if (!scheduledAt) return null;
  const day = scheduledAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Today where the reader is, as `yyyy-MM-dd`.
 *
 * `en-CA` because it is the shortest way to get an ISO-shaped date out of the
 * browser's own locale machinery. `toISOString` would be UTC and would call a
 * Texas evening tomorrow.
 */
export function localToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA');
}

/**
 * Whether this assignment is work that should already have happened.
 *
 * Current assignments only: a superseded one is somebody else's problem now,
 * and flagging it would blame this technician for a job that was taken off
 * them. Compared as strings, both being `yyyy-MM-dd`, which orders correctly
 * and involves no timezone at any point.
 */
export function isOverdue({
  isCurrent,
  scheduledAt,
  status,
  today,
}: {
  isCurrent: boolean;
  scheduledAt: string | null | undefined;
  status: string | null | undefined;
  today: string;
}): boolean {
  if (!isCurrent) return false;
  if (!status || !STILL_TO_VISIT.has(status)) return false;

  const day = scheduledDay(scheduledAt);
  if (!day) return false;

  return day < today;
}
