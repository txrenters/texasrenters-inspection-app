import { parseVisitDetails } from './visit-details.js';
import { REPORTABLE_VISIT_SERVICES, VISIT_SERVICE_LABEL } from './visit-services.js';

/**
 * A job in one line (the office, 2026-11-06: "on the title, include all the
 * necessary details, like the job type, occupied or not, TBP or not").
 *
 * A job is more than its inspection type: a benefit-package visit filed as an
 * occupied inspection is also a filter change and pest control, and the page
 * used to say only "Occupied". So its work is read from what was booked --
 * the services in the visit's Details, then the inspection, then the other job
 * the same visit booked -- as "AC filter change + Pest control + Occupied
 * inspection".
 */

const INSPECTION_WORDS: Record<string, string> = {
  MOVE_IN: 'Move-in inspection',
  OCCUPIED: 'Occupied inspection',
  BACK_TO_MARKET: 'Back-to-market inspection',
  MOVE_OUT: 'Move-out inspection',
  HVAC: 'HVAC inspection',
  ROOF: 'Roof inspection',
  SUPRA_LOCKBOX_PLACEMENT: 'Supra lockbox placement',
  SUPRA_LOCKBOX_REMOVAL: 'Supra lockbox removal',
  AC_FILTER_DELIVERY: 'AC filter delivery',
};

/** "Occupied inspection", or the type in plain words for one this list has not met. */
export function inspectionWords(type: string): string {
  const known = INSPECTION_WORDS[type];
  if (known) return known;
  const words = type.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface JobWorkSource {
  inspectionType: string;
  jobberVisitDetails?: string | null;
  /** The other job the same visit booked, either way round. */
  jobberCompanionOf?: { inspectionType: string } | null;
  jobberCompanions?: readonly { inspectionType: string }[];
}

/** What the job is for, each thing once: the services booked, then the inspection, then the visit's other job. */
export function jobWork(job: JobWorkSource): string[] {
  const read = parseVisitDetails(job.jobberVisitDetails);
  const names: string[] = [
    ...REPORTABLE_VISIT_SERVICES.filter((service) => read.services[service]).map((service) => VISIT_SERVICE_LABEL[service]),
    ...read.services.other,
  ];
  // A filter delivery is the filter change it already says.
  if (job.inspectionType !== 'AC_FILTER_DELIVERY' || !read.services.filterChange) names.push(inspectionWords(job.inspectionType));
  if (read.services.occupiedInspection) names.push(inspectionWords('OCCUPIED'));
  for (const other of [job.jobberCompanionOf, ...(job.jobberCompanions ?? [])])
    if (other) names.push(inspectionWords(other.inspectionType));

  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "AC filter change + Pest control + Occupied inspection". */
export const jobWorkLine = (job: JobWorkSource) => jobWork(job).join(' + ');

/** A title that books a benefit-package visit: the office writes it both ways. */
const TBP_TITLE = /tenant\s+benefit\s+package|\btbp\b/i;

/**
 * Whether this job is a benefit-package visit: on a quarter's plan, or booked
 * as one in Jobber (the office, 2026-11-06: the visit decides, not the
 * tenancy). A tenant's enrolment is a separate question, and can change after
 * the visit was booked.
 */
export const isTbpVisit = (job: { onPlan: boolean; jobberVisitTitle?: string | null }) =>
  job.onPlan || TBP_TITLE.test(job.jobberVisitTitle ?? '');

/** The zone a visit's title names: "... - Zone 1 - ...". */
export function visitZone(title: string | null | undefined): string | null {
  return /\bzone\s*(\d+)\b/i.exec(title ?? '')?.[1] ?? null;
}
