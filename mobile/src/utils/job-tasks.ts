import {
  bookedFilters,
  filterKey,
  filterLabel,
  parseVisitDetails,
  reportableServices,
  servicesReportProblems,
  VISIT_SERVICE_LABEL,
  type BookedFilter,
  type ReportableVisitService,
  type VisitFilterOutcome,
  type VisitServicesReport,
} from '@texasrenters/shared';

/**
 * The job's tasks, in the order the office numbers them.
 *
 * The office's own instruction on every benefit-package visit reads "1.Filter
 * Change 2.Pest Control 3.HVAC / Occupied Inspection", and asks for the numbers
 * back in the Jobber notes. The checklist on the phone is that list (the office,
 * 2026-09-18): ticked as the work happens rather than remembered at the end,
 * with a photograph of each filter register, and an optional one for pest
 * control or a flea treatment.
 *
 * Which tasks a job has comes from the visit's Details, so a visit that books
 * only a filter change shows only that, and the inspection is a task like the
 * others — tapping it opens the areas.
 */

export type JobTaskKind =
  /** Ticked in place: done, or not done with a reason. */
  | 'SERVICE'
  /** Opens the registers, each with its own photograph. */
  | 'FILTERS'
  /** Opens the areas, which is the inspection itself. */
  | 'INSPECTION';

export type JobTaskState =
  | 'TODO'
  /** Some of it answered: registers photographed, or areas walked. */
  | 'PART'
  | 'DONE'
  /** Answered as not done, with a reason. */
  | 'NOT_DONE';

export interface JobTask {
  /** `filterChange`, `pestControl`, `fleaTreatment`, or `inspection`. */
  key: ReportableVisitService | 'inspection';
  /** The office's number for it, where they number it. */
  number: number | null;
  title: string;
  kind: JobTaskKind;
  state: JobTaskState;
  /** What the row says under its title, when there is something to say. */
  detail: string | null;
}

/** The office's numbers, as their instruction writes them. */
const OFFICE_NUMBER: Partial<Record<ReportableVisitService | 'inspection', number>> = {
  filterChange: 1,
  pestControl: 2,
  inspection: 3,
};

/** What each kind of inspection is called as a task. */
const INSPECTION_TITLE: Record<string, string> = {
  OCCUPIED: 'Occupied inspection',
  HVAC: 'HVAC inspection',
  MOVE_IN: 'Move-in inspection',
  MOVE_OUT: 'Move-out inspection',
  BACK_TO_MARKET: 'Back-to-market inspection',
  ROOF: 'Roof inspection',
};

export interface FilterRow {
  filter: BookedFilter;
  /** How many registers share this size and place, for "(2 of 2)". */
  total: number;
  label: string;
  /** The technician's answer for it, once they have given one. */
  answer?: VisitFilterOutcome;
}

const sameSizeAndPlace = (left: BookedFilter, right: BookedFilter) =>
  left.size === right.size && (left.location ?? '') === (right.location ?? '');

/**
 * The registers the checklist asks about: the ones the visit listed, then any
 * the technician found on site.
 *
 * A register found on site carries no booking, so it is listed after the
 * booked ones and can be removed again; a booked one always stays, because the
 * office asked about it.
 */
export function filterRows(
  visitDetails: string | null | undefined,
  report: VisitServicesReport | null | undefined,
): FilterRow[] {
  const booked = bookedFilters(parseVisitDetails(visitDetails));
  const answers = new Map((report?.filters ?? []).map((filter) => [filterKey(filter), filter]));
  const rows = booked.map((filter) => {
    const total = booked.filter((other) => sameSizeAndPlace(filter, other)).length;
    return { filter, total, label: filterLabel(filter, total), answer: answers.get(filterKey(filter)) };
  });
  const bookedKeys = new Set(booked.map((filter) => filterKey(filter)));
  for (const answer of report?.filters ?? []) {
    if (bookedKeys.has(filterKey(answer))) continue;
    const filter: BookedFilter = {
      size: answer.size,
      location: answer.location,
      slot: answer.slot,
      media: false,
    };
    rows.push({ filter, total: 1, label: filterLabel(filter), answer });
  }
  return rows;
}

/** How far through the registers the technician is. */
function filtersState(rows: FilterRow[]): { state: JobTaskState; detail: string | null } {
  if (!rows.length) return { state: 'TODO', detail: 'No sizes given — check the filters on site' };
  const answered = rows.filter((row) => row.answer);
  // A photograph taken in a basement has only the key the handset gave it until
  // its upload lands, and the register is answered either way.
  const settled = answered.filter((row) =>
    row.answer!.changed ? row.answer!.photoId || row.answer!.photoKey : row.answer!.reason,
  );
  if (!answered.length) return { state: 'TODO', detail: `${rows.length} to photograph` };
  if (settled.length < rows.length)
    return { state: 'PART', detail: `${settled.length} of ${rows.length} answered` };
  const missed = settled.filter((row) => !row.answer!.changed).length;
  return {
    state: 'DONE',
    detail: missed ? `${rows.length - missed} changed · ${missed} not changed` : `${rows.length} changed`,
  };
}

export interface JobTasksInput {
  visitDetails?: string | null;
  inspectionType: string;
  report?: VisitServicesReport | null;
  /** The areas, from the job's own progress. */
  areas: { completed: number; total: number };
}

export function jobTasks(input: JobTasksInput): JobTask[] {
  const details = parseVisitDetails(input.visitDetails);
  const report = input.report ?? null;
  const tasks: JobTask[] = [];

  for (const service of reportableServices(details)) {
    const outcome = report?.services[service];
    if (service === 'filterChange') {
      const rows = filterRows(input.visitDetails, report);
      // Not done is an answer about the whole service, and the registers are
      // then not asked about at all.
      const whole =
        outcome && !outcome.done
          ? { state: 'NOT_DONE' as JobTaskState, detail: outcome.reason || 'Not done' }
          : outcome?.done
            ? filtersState(rows)
            : { state: 'TODO' as JobTaskState, detail: filtersState(rows).detail };
      tasks.push({
        key: service,
        number: OFFICE_NUMBER[service] ?? null,
        title: VISIT_SERVICE_LABEL[service],
        kind: 'FILTERS',
        ...whole,
      });
      continue;
    }
    tasks.push({
      key: service,
      number: OFFICE_NUMBER[service] ?? null,
      title: VISIT_SERVICE_LABEL[service],
      kind: 'SERVICE',
      state: !outcome ? 'TODO' : outcome.done ? 'DONE' : 'NOT_DONE',
      detail: !outcome
        ? null
        : !outcome.done
          ? outcome.reason || 'Not done'
          : // The photograph is optional, so it is mentioned only when there is one.
            outcome.photoId
            ? 'Done · photo'
            : outcome.photoKey
              ? 'Done · photo sending'
              : null,
    });
  }

  /**
   * The inspection, when there is one to walk.
   *
   * From the areas rather than from the Details: a visit whose Details nobody
   * filled in still has its areas, and an occupied inspection the Details say
   * is not needed still appears as the type of the job.
   */
  if (input.areas.total > 0 || details.services.occupiedInspection) {
    const { completed, total } = input.areas;
    tasks.push({
      key: 'inspection',
      number: OFFICE_NUMBER.inspection ?? null,
      title: INSPECTION_TITLE[input.inspectionType] ?? 'Inspection',
      kind: 'INSPECTION',
      state: total > 0 && completed >= total ? 'DONE' : completed > 0 ? 'PART' : 'TODO',
      detail: total > 0 ? `${completed} of ${total} areas` : 'No areas yet',
    });
  }

  return tasks;
}

/**
 * What still has to be answered before the job can be submitted.
 *
 * The same rule the API runs (`servicesReportProblems`), given the registers
 * this visit booked, so the phone and the server never disagree about whether
 * a job is ready.
 */
export function jobChecklistProblems(
  visitDetails: string | null | undefined,
  report: VisitServicesReport | null | undefined,
): string[] {
  const details = parseVisitDetails(visitDetails);
  return servicesReportProblems(
    reportableServices(details),
    report ?? { services: {}, filters: [] },
    bookedFilters(details),
  );
}

/** An empty report, for the first answer on a job nobody has ticked. */
const EMPTY_REPORT: VisitServicesReport = { services: {}, filters: [], filtersInstalled: [], notes: null };

/**
 * The report with one service answered.
 *
 * Whole-report writes, because that is what the API takes: the checklist is
 * stored as one document, so the newest send wins and a queued tick cannot
 * half-apply.
 */
export function withServiceAnswer(
  report: VisitServicesReport | null | undefined,
  service: ReportableVisitService,
  answer: { done: boolean; reason: string | null; reschedule: boolean },
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const existing = current.services[service];
  return {
    ...current,
    filters: current.filters ?? [],
    services: {
      ...current.services,
      [service]: {
        ...answer,
        // A photograph already taken stays with a service still done, and goes
        // with one now said not to have happened: it would evidence nothing.
        ...(answer.done && (existing?.photoKey || existing?.photoId)
          ? { photoKey: existing.photoKey ?? null, photoId: existing.photoId ?? null }
          : {}),
      },
    },
  };
}

/**
 * The report with a service's optional photograph attached.
 *
 * Taking one means the service happened, so the service is marked done if it
 * was not already. The photograph travels in the upload queue like every other
 * one, and the key the handset gave it is what the answer carries meanwhile.
 */
export function withServicePhoto(
  report: VisitServicesReport | null | undefined,
  service: ReportableVisitService,
  photoKey: string,
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const existing = current.services[service];
  return {
    ...current,
    filters: current.filters ?? [],
    services: {
      ...current.services,
      [service]: { done: true, reason: null, reschedule: false, ...(existing?.done ? existing : {}), photoKey, photoId: null },
    },
  };
}

/**
 * The report with one filter register answered.
 *
 * Answering a register also marks the filter change itself done, because that
 * is what answering one means: the technician was at the register. A filter
 * change that did not happen at all is answered as a service instead
 * (`withServiceAnswer`), and then the registers are not asked about.
 */
export function withFilterAnswer(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
  answer: { changed: boolean; reason?: string | null; photoKey?: string | null; photoId?: string | null },
  options: { booked?: boolean } = {},
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const key = filterKey(filter);
  const existing = (current.filters ?? []).find((entry) => filterKey(entry) === key);
  const next: VisitFilterOutcome = {
    size: filter.size,
    location: filter.location,
    slot: filter.slot,
    changed: answer.changed,
    reason: answer.changed ? null : (answer.reason ?? existing?.reason ?? null),
    // Kept from the answer already given where this one does not carry it, so
    // marking a photographed register changed again does not drop its
    // photograph.
    photoId: answer.changed ? (answer.photoId ?? existing?.photoId ?? null) : null,
    photoKey: answer.changed ? (answer.photoKey ?? existing?.photoKey ?? null) : null,
    booked: options.booked ?? existing?.booked ?? true,
  };
  const filters = existing
    ? (current.filters ?? []).map((entry) => (filterKey(entry) === key ? next : entry))
    : [...(current.filters ?? []), next];
  return {
    ...current,
    filters,
    services: {
      ...current.services,
      filterChange: current.services.filterChange?.done
        ? current.services.filterChange
        : { done: true, reason: null, reschedule: false },
    },
  };
}

/** The report without a register the technician added and then removed. */
export function withoutFilter(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const key = filterKey(filter);
  return { ...current, filters: (current.filters ?? []).filter((entry) => filterKey(entry) !== key) };
}
