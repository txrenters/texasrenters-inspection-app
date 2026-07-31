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

// Started work is judged against the calendar day, not the clock. A technician
// who begins at 9:05 for a 9:00 slot is not "5m late" in any useful sense —
// but one still working an inspection dated three days ago is genuinely behind.
const STARTED_GRACE_MS = 24 * 60 * 60 * 1000;

// A scheduled inspection is "due soon" once it is within this window of its
// start time, and "overdue" once the start time has passed.
export const DUE_SOON_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
// Lead time for the pre-emptive "upcoming" local notification.
export const UPCOMING_REMINDER_LEAD_MS = 60 * 60 * 1000; // 1 hour

export function inspectionUrgency(
  inspection: Pick<Inspection, 'status' | 'scheduledAt'>,
  now: number = Date.now(),
): InspectionUrgency | null {
  if (!WARNABLE_STATUSES.includes(inspection.status)) return null;
  const scheduledAt = new Date(inspection.scheduledAt).getTime();
  if (!Number.isFinite(scheduledAt)) return null;
  if (inspection.status === 'IN_PROGRESS') {
    // Already started, so "due soon" is meaningless — the only question left is
    // whether it has been open too long.
    return now - scheduledAt > STARTED_GRACE_MS ? 'overdue' : null;
  }
  if (scheduledAt < now) return 'overdue';
  if (scheduledAt - now <= DUE_SOON_WINDOW_MS) return 'due_soon';
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
