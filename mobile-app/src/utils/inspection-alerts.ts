import type { Inspection } from '../domain/models';

export type InspectionUrgency = 'overdue' | 'due_soon' | 'scheduled';

// Only un-started, non-cancelled inspections can be "late" — once a technician
// begins (IN_PROGRESS or later), it is being worked and no longer warns.
const WARNABLE_STATUSES: ReadonlyArray<Inspection['status']> = ['SCHEDULED'];

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
