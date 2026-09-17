import type { JobFile, JobLastVisit } from '../domain/models';

import { formatVisitDay } from './visit-window';

/**
 * The office's file on a tenancy, as rows for the job screen.
 *
 * A technician used to have the coordinator's Details and nothing else, so the
 * filter sizes the office holds, the plan the tenant is on and what the last
 * visit flagged were all in the console and nowhere they could be read at the
 * door (the office, 2026-09-18).
 *
 * Every row is dropped when its fact is missing, and the card is not shown at
 * all when nothing is left: the tenant report records a building rather than a
 * unit, so a duplex often resolves to nothing, and a column of blank labels
 * reads as a fault in the app.
 */

export interface JobFileRow {
  label: string;
  value: string;
}

const DAY = { month: 'short', day: 'numeric', year: 'numeric' } as const;
/** A date as the report writes it, when it writes one at all. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A date as a day, and anything else as written.
 *
 * `lastFilterDelivery` and `lastOccupiedInspection` come from the tenant report
 * as free text: "June 2026" and "2026-06-18" both appear, and rewriting the
 * first would be inventing a day nobody recorded.
 */
const dayOrText = (value: string) => (ISO_DAY.test(value) ? formatVisitDay(value, DAY) : value);

/** The filters the office believes are fitted, and where they are. */
function filtersRow(file: JobFile): string | null {
  const sizes = file.filterSizes.filter(Boolean).join(', ');
  const parts = [sizes, file.filterLocation?.trim()].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export function jobFileRows(file: JobFile | undefined): JobFileRow[] {
  if (!file) return [];
  // The sizes on file are not the same claim as the visit's own list: the
  // Details say what this visit booked, this says what the office holds.
  const filters = filtersRow(file);
  const rows: (JobFileRow | null)[] = [
    file.tenantNames.length ? { label: 'Tenant', value: file.tenantNames.join(', ') } : null,
    file.plan ? { label: 'Plan', value: file.plan } : null,
    file.hvacPlan ? { label: 'HVAC plan', value: file.hvacPlan } : null,
    filters ? { label: 'Filters on file', value: filters } : null,
    file.lastFilterDelivery
      ? { label: 'Last filters', value: dayOrText(file.lastFilterDelivery) }
      : null,
    file.lastHvacInspection ? { label: 'Last HVAC', value: dayOrText(file.lastHvacInspection) } : null,
    file.lastOccupiedInspection
      ? { label: 'Last occupied', value: dayOrText(file.lastOccupiedInspection) }
      : null,
    file.movedIn ? { label: 'Moved in', value: dayOrText(file.movedIn) } : null,
    file.leaseEnds ? { label: 'Lease ends', value: dayOrText(file.leaseEnds) } : null,
  ];
  return rows.filter((row): row is JobFileRow => row !== null);
}

export interface LastVisitNotes {
  /** "Jun 18, 2026 · occupied inspection". */
  when: string;
  notes: JobFileRow[];
}

/**
 * What the last visit here left the office to pass on.
 *
 * Only what somebody wrote: a visit that flagged nothing answers null, so the
 * card appears when there is something to act on and never as an empty frame.
 */
export function lastVisitNotes(visit: JobLastVisit | undefined): LastVisitNotes | null {
  if (!visit) return null;
  const notes: JobFileRow[] = [];
  if (visit.nextInspectionAlert?.trim())
    notes.push({ label: 'Watch for', value: visit.nextInspectionAlert.trim() });
  if (visit.maintenanceComments?.trim())
    notes.push({ label: 'Maintenance', value: visit.maintenanceComments.trim() });
  if (!notes.length) return null;
  const kind = visit.type.replaceAll('_', ' ').toLowerCase();
  return { when: `${formatVisitDay(visit.scheduledAt, DAY)} · ${kind} inspection`, notes };
}
