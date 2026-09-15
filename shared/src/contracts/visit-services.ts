import type { VisitDetails } from './visit-details.js';

/**
 * What a technician reports about the services a Jobber visit booked.
 *
 * The office's own instruction on every benefit-package visit is to "indicate
 * in the notes which services were completed by using the corresponding
 * numbers" -- typed by hand into Jobber, after the fact, by a technician who
 * had just done the work in this app. This is that report, asked for before the
 * inspection can be submitted: each booked service done or not done, and for
 * one not done, why, and whether it has to be booked again.
 *
 * The occupied inspection itself is not asked about: submitting it is the
 * answer.
 */

export const REPORTABLE_VISIT_SERVICES = ['filterChange', 'pestControl', 'fleaTreatment'] as const;
export type ReportableVisitService = (typeof REPORTABLE_VISIT_SERVICES)[number];

export const VISIT_SERVICE_LABEL: Record<ReportableVisitService, string> = {
  filterChange: 'AC filter change',
  pestControl: 'Pest control',
  fleaTreatment: 'Flea treatment',
};

/** The same names mid-sentence, where "AC" still has to read as AC. */
const IN_SENTENCE: Record<ReportableVisitService, string> = {
  filterChange: 'AC filter change',
  pestControl: 'pest control',
  fleaTreatment: 'flea treatment',
};

export interface VisitServiceOutcome {
  done: boolean;
  /** Why it was not done. Required when it was not; null when it was. */
  reason: string | null;
  /** The office should book this service again. Only ever true when not done. */
  reschedule: boolean;
}

export interface VisitServicesReport {
  services: Partial<Record<ReportableVisitService, VisitServiceOutcome>>;
  /** The filter sizes actually installed: "20x25x1". */
  filtersInstalled: string[];
  /** Anything else for the office: a filter not replaced, a size not listed. */
  notes: string | null;
}

/** A filter size as a technician types it: "20x25x1", "12 x 36". */
export const FILTER_SIZE_PATTERN = /^\s*\d+(?:\.\d+)?\s*[xX×]\s*\d+(?:\.\d+)?(?:\s*[xX×]\s*\d+(?:\.\d+)?)?\s*$/;

export const MAX_SERVICE_REASON = 500;

/** "20 X 25 x 1" becomes "20x25x1", so the office reads one spelling. */
export function normalizeFilterSize(size: string): string {
  return size.replace(/\s+/g, '').replace(/[X×]/g, 'x');
}

/** The services a visit's Details booked that the technician reports on, in the office's order. */
export function reportableServices(details: Pick<VisitDetails, 'services'>): ReportableVisitService[] {
  return REPORTABLE_VISIT_SERVICES.filter((service) => details.services[service]);
}

/**
 * What still stops a report from being complete, in words for the technician.
 *
 * Empty when every booked service is answered and every one not done says why.
 * The same rule gates the submit button and the API, so a technician is never
 * told "done" by the phone and "incomplete" by the server.
 */
export function servicesReportProblems(
  booked: readonly ReportableVisitService[],
  report: Pick<VisitServicesReport, 'services'> | null | undefined,
): string[] {
  const problems: string[] = [];
  for (const service of booked) {
    const outcome = report?.services[service];
    if (!outcome) problems.push(`Mark ${IN_SENTENCE[service]} done or not done.`);
    else if (!outcome.done && !outcome.reason?.trim())
      problems.push(`Say why ${IN_SENTENCE[service]} was not done.`);
  }
  return problems;
}

/** The booked services the technician asked to have booked again. */
export function servicesToReschedule(report: VisitServicesReport | null | undefined): ReportableVisitService[] {
  if (!report) return [];
  return REPORTABLE_VISIT_SERVICES.filter((service) => {
    const outcome = report.services[service];
    return Boolean(outcome && !outcome.done && outcome.reschedule);
  });
}
