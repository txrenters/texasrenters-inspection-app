import type { Inspection } from '../domain/models';

export type InspectionUrgency = 'overdue' | 'due_soon' | 'scheduled';

// Statuses that can still be late.
//
// This was `['SCHEDULED']` only, on the reasoning that a started inspection is
// being worked and no longer needs warning about. That holds for an hour; it
// does not hold for the inspection still sitting at IN_PROGRESS eight days
// after its scheduled date, which is the one most worth surfacing and was the
// only kind showing no indicator at all.
const WARNABLE_STATUSES: readonly Inspection['status'][] = ['SCHEDULED', 'IN_PROGRESS'];

// How many days past its date a started inspection may run before it is late.
// A technician still finishing today's work at 6pm is not behind; one still
// holding an inspection dated three days ago is.
const STARTED_GRACE_DAYS = 1;

// Lead time for the pre-emptive "upcoming" local notification.
export const UPCOMING_REMINDER_LEAD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Day number for a date-only `scheduledAt`, read in UTC.
 *
 * The column is a DATE and Prisma serialises it as midnight UTC, so the day the
 * administrator picked is the value's *UTC* day. Reading local parts instead
 * would move it: midnight UTC is the previous evening in Texas, so every
 * inspection would appear scheduled a day early.
 */
function scheduledDayNumber(scheduledAt: string): number | null {
  const parsed = new Date(scheduledAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()) / 86_400_000);
}

/** Day number for "now", read in the technician's own timezone. */
function currentDayNumber(now: number): number {
  const local = new Date(now);
  // Built from local parts so the boundary is the technician's midnight, not
  // Greenwich's. In Manila the two are eight hours apart, and comparing against
  // UTC marked today's work overdue from 8am.
  return Math.floor(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000);
}

/**
 * How late an inspection is, in whole days.
 *
 * Compared day-to-day rather than instant-to-instant, because an inspection is
 * now scheduled to a date with no time. Treating midnight as a deadline made
 * work booked for today read as overdue for most of that day.
 */
export function inspectionUrgency(
  inspection: Pick<Inspection, 'status' | 'scheduledAt'>,
  now: number = Date.now(),
): InspectionUrgency | null {
  if (!WARNABLE_STATUSES.includes(inspection.status)) return null;
  const scheduledDay = scheduledDayNumber(inspection.scheduledAt);
  if (scheduledDay === null) return null;
  const today = currentDayNumber(now);

  if (inspection.status === 'IN_PROGRESS') {
    // Already started, so "due soon" is meaningless — the only question left is
    // whether it has been open too long.
    return today - scheduledDay > STARTED_GRACE_DAYS ? 'overdue' : null;
  }
  // Overdue only once its day has fully passed. An inspection booked for today
  // is due today, all day.
  if (scheduledDay < today) return 'overdue';
  if (scheduledDay === today) return 'due_soon';
  return 'scheduled';
}

export interface InspectionAlerts {
  overdue: Inspection[];
  dueSoon: Inspection[];
  overdueCount: number;
  dueSoonCount: number;
  alertCount: number;
}

export function collectInspectionAlerts(
  inspections: Inspection[],
  now: number = Date.now(),
): InspectionAlerts {
  const overdue: Inspection[] = [];
  const dueSoon: Inspection[] = [];
  for (const inspection of inspections) {
    const urgency = inspectionUrgency(inspection, now);
    if (urgency === 'overdue') overdue.push(inspection);
    else if (urgency === 'due_soon') dueSoon.push(inspection);
  }
  return {
    overdue,
    dueSoon,
    overdueCount: overdue.length,
    dueSoonCount: dueSoon.length,
    alertCount: overdue.length + dueSoon.length,
  };
}
