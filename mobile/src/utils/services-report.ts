import {
  FILTER_SIZE_PATTERN,
  normalizeFilterSize,
  parseVisitDetails,
  reportableServices,
  servicesReportProblems,
  VISIT_SERVICE_LABEL,
  type ReportableVisitService,
  type VisitServicesReport,
} from '@texasrenters/shared';

/**
 * The services checklist a technician answers before submitting a visit.
 *
 * Every benefit-package visit books a filter change and pest control alongside
 * the occupied inspection, and the office asked for each to be marked done
 * before submission -- and for one not done, why, and whether to book it again.
 * The rules live here so the review screen's submit button and the API run the
 * same check (`servicesReportProblems`), and so they can be tested without a
 * screen.
 */

/** One booked service, as it is being answered. `done` is null until chosen. */
export interface ServiceAnswer {
  done: boolean | null;
  reason: string;
  reschedule: boolean;
}

/** The checklist's answers, kept on the phone until the inspection is submitted. */
export interface ServicesDraft {
  services: Partial<Record<ReportableVisitService, ServiceAnswer>>;
  /** Booked filter sizes the technician did not install. Everything else booked was. */
  sizesNotInstalled: string[];
  /** Sizes installed that the visit did not list, as typed: "16x25x1, 14x20x1". */
  otherSizes: string;
  notes: string;
}

export const EMPTY_SERVICES_DRAFT: ServicesDraft = {
  services: {},
  sizesNotInstalled: [],
  otherSizes: '',
  notes: '',
};

export const UNANSWERED: ServiceAnswer = { done: null, reason: '', reschedule: false };

export interface ServicesToReport {
  services: { key: ReportableVisitService; label: string }[];
  /** The filter sizes the visit booked, each once. */
  bookedSizes: string[];
}

/** What the visit booked that the technician has to answer for. */
export function servicesToReport(visitDetails: string | null | undefined): ServicesToReport {
  const read = parseVisitDetails(visitDetails);
  return {
    services: reportableServices(read).map((key) => ({ key, label: VISIT_SERVICE_LABEL[key] })),
    bookedSizes: [...new Set(read.filters.map((filter) => filter.size))],
  };
}

/** The sizes typed as "other sizes installed", split and checked. */
export function readOtherSizes(text: string): { valid: string[]; invalid: string[] } {
  const parts = text
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    valid: parts.filter((part) => FILTER_SIZE_PATTERN.test(part)).map(normalizeFilterSize),
    invalid: parts.filter((part) => !FILTER_SIZE_PATTERN.test(part)),
  };
}

/** The report the answers make, as the API takes it. */
export function reportFromDraft(ask: ServicesToReport, draft: ServicesDraft): VisitServicesReport {
  const services: VisitServicesReport['services'] = {};
  for (const { key } of ask.services) {
    const answer = draft.services[key];
    if (!answer || answer.done === null) continue;
    services[key] = {
      done: answer.done,
      reason: answer.done ? null : answer.reason.trim() || null,
      reschedule: !answer.done && answer.reschedule,
    };
  }
  const installed = services.filterChange?.done
    ? [
        ...ask.bookedSizes.filter((size) => !draft.sizesNotInstalled.includes(size)),
        ...readOtherSizes(draft.otherSizes).valid,
      ]
    : [];
  return { services, filtersInstalled: [...new Set(installed)], notes: draft.notes.trim() || null };
}

/** What still stops submission, in the order the checklist asks. Empty when ready. */
export function draftProblems(ask: ServicesToReport, draft: ServicesDraft): string[] {
  const problems = servicesReportProblems(
    ask.services.map((service) => service.key),
    reportFromDraft(ask, draft),
  );
  const invalid = readOtherSizes(draft.otherSizes).invalid;
  if (draft.services.filterChange?.done && invalid.length)
    problems.push(`"${invalid[0]}" is not a filter size. Write it like 20x25x1.`);
  return problems;
}
