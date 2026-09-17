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

/**
 * One filter register, as the technician answered for it.
 *
 * A photograph of each one, showing the size printed on the filter (Moses, via
 * the office, 2026-09-18): a single photograph of "the filter change" says
 * nothing about the second register in a house with two.
 */
export interface VisitFilterOutcome {
  /** Normalised, as `normalizeFilterSize` writes it: "20x25x1". */
  size: string;
  /** Where the visit's Details said it goes, when they said. */
  location: string | null;
  /** Which register of this size and place, 1-based, for a house with two the same. */
  slot: number;
  changed: boolean;
  /** Why it was not changed. Required when it was not; null when it was. */
  reason: string | null;
  /**
   * The photograph of it, in the job's AC filters area.
   *
   * `photoKey` is the key the handset gave the photograph when it took it, and
   * is what a technician standing in a basement can offer: the image itself
   * uploads from the queue like every other photograph here, and the server
   * fills in `photoId` once it has arrived. One of the two is required when the
   * filter was changed.
   */
  photoId: string | null;
  photoKey?: string | null;
  /** Listed by the visit's Details, rather than found on site by the technician. */
  booked: boolean;
}

export interface VisitServicesReport {
  services: Partial<Record<ReportableVisitService, VisitServiceOutcome>>;
  /**
   * Each filter register answered for, once the office asked for a photograph
   * of each (2026-09-18). Absent on a report made before that, which is why
   * `filtersInstalled` is still the list the office reads.
   */
  filters?: VisitFilterOutcome[];
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

/** One register the visit booked a filter for, as the checklist asks about it. */
export interface BookedFilter {
  size: string;
  location: string | null;
  /** 1-based among the registers of the same size in the same place. */
  slot: number;
  /** A thick media filter, which the office changes only twice a year. */
  media: boolean;
}

/**
 * The most registers one visit is asked about.
 *
 * Generous — the largest real list measured was four — and here only so a
 * mistyped quantity ("(20 pcs)") cannot ask a technician for twenty
 * photographs.
 */
export const MAX_BOOKED_FILTERS = 12;

/**
 * Every register the visit's Details booked a filter for, one entry each.
 *
 * Expanded by quantity, because "20x25x1 (2 pcs)" is two registers and the
 * office wants a photograph of each. Sizes are normalised so the list reads in
 * one spelling whatever the coordinator typed.
 */
export function bookedFilters(details: Pick<VisitDetails, 'filters'>): BookedFilter[] {
  const filters: BookedFilter[] = [];
  for (const filter of details.filters) {
    const size = normalizeFilterSize(filter.size);
    const location = filter.location?.trim() || null;
    const quantity = Math.max(1, Math.min(filter.quantity, MAX_BOOKED_FILTERS));
    for (let slot = 1; slot <= quantity; slot += 1) {
      if (filters.length >= MAX_BOOKED_FILTERS) return filters;
      filters.push({ size, location, slot, media: filter.media });
    }
  }
  return filters;
}

/** How a filter is named on screen and in the office's note: "20x25x1 · upstairs hallway (2 of 2)". */
export function filterLabel(filter: BookedFilter | VisitFilterOutcome, total = 1): string {
  const place = 'location' in filter && filter.location ? ` · ${filter.location}` : '';
  const which = total > 1 ? ` (${filter.slot} of ${total})` : '';
  return `${filter.size}${place}${which}`;
}

/** Identity of a register, so an answer can be matched to what was booked. */
export const filterKey = (filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>) =>
  `${normalizeFilterSize(filter.size)}|${(filter.location ?? '').trim().toLowerCase()}|${filter.slot}`;

/** How many registers share this size and place, for "(2 of 2)". */
const slotsOf = (filters: readonly Pick<BookedFilter, 'size' | 'location'>[], of: Pick<BookedFilter, 'size' | 'location'>) =>
  filters.filter(
    (filter) =>
      normalizeFilterSize(filter.size) === normalizeFilterSize(of.size) &&
      (filter.location ?? '').trim().toLowerCase() === (of.location ?? '').trim().toLowerCase(),
  ).length;

/**
 * What still stops a report from being complete, in words for the technician.
 *
 * Empty when every booked service is answered, every one not done says why, and
 * every filter register the visit booked is either photographed as changed or
 * says why it was not. The same rule gates the submit button and the API, so a
 * technician is never told "done" by the phone and "incomplete" by the server.
 *
 * `filters` is what the visit's Details booked (`bookedFilters`). The registers
 * are checked only when the report itself carries a `filters` array — a phone
 * built before the office asked for a photograph of each sends none, and must
 * still be able to submit. An empty array is the new shape with nothing
 * answered, and is checked.
 */
export function servicesReportProblems(
  booked: readonly ReportableVisitService[],
  report: Pick<VisitServicesReport, 'services' | 'filters'> | null | undefined,
  filters: readonly BookedFilter[] = [],
): string[] {
  const problems: string[] = [];
  for (const service of booked) {
    const outcome = report?.services[service];
    if (!outcome) problems.push(`Mark ${IN_SENTENCE[service]} done or not done.`);
    else if (!outcome.done && !outcome.reason?.trim())
      problems.push(`Say why ${IN_SENTENCE[service]} was not done.`);
  }
  // Only for a filter change that happened: a change the technician has already
  // said did not happen, with a reason, is answered.
  if (!report?.services.filterChange?.done) return problems;
  // An older phone sends no registers at all. It answers the filter change as
  // one service, as it always did.
  if (report.filters === undefined) return problems;
  const answers = new Map((report.filters ?? []).map((filter) => [filterKey(filter), filter]));
  for (const filter of filters) {
    const label = filterLabel(filter, slotsOf(filters, filter));
    const answer = answers.get(filterKey(filter));
    if (!answer) problems.push(`Answer for the ${label} filter.`);
    else if (answer.changed && !answer.photoId && !answer.photoKey)
      problems.push(`Photograph the ${label} filter.`);
    else if (!answer.changed && !answer.reason?.trim())
      problems.push(`Say why the ${label} filter was not changed.`);
  }
  // A register the technician found on site rather than one the office listed.
  for (const answer of report.filters ?? []) {
    if (answer.booked) continue;
    if (answer.changed && !answer.photoId && !answer.photoKey)
      problems.push(`Photograph the ${filterLabel(answer)} filter you found.`);
  }
  return problems;
}

/**
 * The sizes actually installed, for the office's note.
 *
 * From the per-register answers where the report has them, and from
 * `filtersInstalled` otherwise, so a report made before the office asked for a
 * photograph of each register still reads the same way.
 */
export function installedSizes(
  report: Pick<VisitServicesReport, 'filters' | 'filtersInstalled'> | null | undefined,
): string[] {
  if (!report) return [];
  if (!report.filters?.length) return [...new Set(report.filtersInstalled)];
  return [...new Set(report.filters.filter((filter) => filter.changed).map((filter) => filter.size))];
}

/** The registers the technician did not change, with the reason each time. */
export function filtersNotChanged(
  report: Pick<VisitServicesReport, 'filters'> | null | undefined,
): VisitFilterOutcome[] {
  return (report?.filters ?? []).filter((filter) => !filter.changed);
}

/** The booked services the technician asked to have booked again. */
export function servicesToReschedule(report: VisitServicesReport | null | undefined): ReportableVisitService[] {
  if (!report) return [];
  return REPORTABLE_VISIT_SERVICES.filter((service) => {
    const outcome = report.services[service];
    return Boolean(outcome && !outcome.done && outcome.reschedule);
  });
}
