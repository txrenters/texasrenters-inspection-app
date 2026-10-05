import {
  bookedFilters,
  filterAssessed,
  filterKey,
  filterLabel,
  inspectionAssessesFilters,
  jobServices,
  MAX_BOOKED_FILTERS,
  normalizeFilterSize,
  parseVisitDetails,
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
    const answer = answers.get(filterKey(filter));
    // The answer's label, which carries a size the technician corrected.
    return { filter, total, label: filterLabel(answer ?? filter, total), answer };
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
    rows.push({ filter, total: 1, label: filterLabel(answer), answer });
  }
  return rows;
}

/**
 * The slot a filter found on site should take.
 *
 * A register is identified by `filterKey` -- size, place and slot together --
 * and the Add sheet always wrote slot 1. So adding a filter that matched a
 * register the visit already listed did not add anything: it answered that
 * register instead, marking it unchanged and "Found on site", and the row the
 * technician expected never appeared. Reported as adding a filter failing
 * silently (2026-09-22).
 *
 * Slots are per size *and* place, which is what `filterLabel` counts for
 * "(2 of 2)", so two 20x25x1 filters in different rooms are both slot 1 and
 * that is correct. The lowest free one is taken rather than the count plus
 * one: a technician who adds two, removes the first and adds another should
 * get slot 1 back, not slot 3.
 */
export function nextFilterSlot(
  visitDetails: string | null | undefined,
  report: VisitServicesReport | null | undefined,
  of: Pick<BookedFilter, 'size' | 'location'>,
): number {
  /**
   * Normalised the way `filterKey` normalises, not the way `sameSizeAndPlace`
   * compares. That helper tests the raw strings, which is right for counting
   * "(2 of 2)" off one parsed list, and wrong here: a booked "20X25X1" and a
   * typed "20x25x1" are one register to `filterKey` and two to it, so slot 1
   * would look free and the collision would survive the fix.
   */
  const place = (filter: Pick<BookedFilter, 'size' | 'location'>) =>
    `${normalizeFilterSize(filter.size)}|${(filter.location ?? '').trim().toLowerCase()}`;
  const wanted = place(of);
  const here = (filter: Pick<BookedFilter, 'size' | 'location'>) => place(filter) === wanted;
  const taken = new Set<number>();
  for (const filter of bookedFilters(parseVisitDetails(visitDetails)))
    if (here(filter)) taken.add(filter.slot);
  for (const answer of report?.filters ?? []) if (here(answer)) taken.add(answer.slot);
  let slot = 1;
  while (taken.has(slot)) slot += 1;
  return slot;
}

/**
 * What a job asks of its filters.
 *
 * `assess` on an HVAC job: each filter is scored too (Moses, 2026-10-01).
 * `changeAsked` when the visit booked a filter change: each listed filter is
 * then photographed as changed or said why not. An HVAC visit that booked none
 * asks the scores alone.
 */
export interface FilterRules {
  assess: boolean;
  changeAsked: boolean;
}

/** The rules for a job, from its Details and its kind. */
export function filterRulesFor(visitDetails: string | null | undefined, inspectionType: string | null | undefined): FilterRules {
  const assess = inspectionAssessesFilters(inspectionType);
  return { assess, changeAsked: !assess || parseVisitDetails(visitDetails).services.filterChange };
}

/** Whether a filter needs nothing more, under a job's rules. */
export function filterRowSettled(row: FilterRow, rules: FilterRules): boolean {
  const answer = row.answer;
  // Not at the property: removing it was the answer.
  if (answer?.removed) return true;
  if (!answer) return false;
  // A photograph taken in a basement has only the key the handset gave it until
  // its upload lands, and the register is answered either way.
  const photographed = Boolean(answer.photoId || answer.photoKey);
  const change = answer.changed ? photographed : rules.changeAsked ? Boolean(answer.reason?.trim()) : true;
  return change && (!rules.assess || filterAssessed(answer));
}

/** How far through the registers the technician is. */
function filtersState(
  rows: FilterRow[],
  rules: FilterRules = { assess: false, changeAsked: true },
): { state: JobTaskState; detail: string | null } {
  if (!rows.length) return { state: 'TODO', detail: 'No sizes given — check the filters on site' };
  const live = rows.filter((row) => !row.answer?.removed);
  const started = rows.filter(
    (row) =>
      row.answer &&
      (row.answer.removed || row.answer.changed || row.answer.reason?.trim() || filterAssessed(row.answer)),
  );
  const settled = rows.filter((row) => filterRowSettled(row, rules));
  const plural = live.length === 1 ? '' : 's';
  // One photograph of them all, stacked (the office, 2026-09-29), and on an
  // HVAC job a score for each (Moses, 2026-10-01).
  if (!started.length)
    return {
      state: 'TODO',
      detail: rules.assess
        ? `${live.length} filter${plural} · ${rules.changeAsked ? 'score each, one photo' : 'score each'}`
        : `${live.length} filter${plural} · one photo`,
    };
  if (settled.length < rows.length)
    return { state: 'PART', detail: `${settled.length} of ${rows.length} answered` };
  const removed = rows.length - live.length;
  const gone = removed ? ` · ${removed} not there` : '';
  if (!rules.changeAsked) return { state: 'DONE', detail: `${live.length} scored${gone}` };
  const missed = live.filter((row) => !row.answer!.changed).length;
  return {
    state: 'DONE',
    detail:
      (missed ? `${live.length - missed} changed · ${missed} not changed` : `${live.length} changed`) + gone,
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

  // An HVAC job always has its AC filter change: its filters are scored there
  // (Moses, 2026-10-01), booked or not.
  for (const service of jobServices(details, input.inspectionType)) {
    const outcome = report?.services[service];
    if (service === 'filterChange') {
      const rows = filterRows(input.visitDetails, report);
      const rules = filterRulesFor(input.visitDetails, input.inspectionType);
      // Not done is an answer about the whole service, and the registers are
      // then not asked about at all.
      const whole =
        outcome && !outcome.done
          ? { state: 'NOT_DONE' as JobTaskState, detail: outcome.reason || 'Not done' }
          : outcome?.done
            ? filtersState(rows, rules)
            : { state: 'TODO' as JobTaskState, detail: filtersState(rows, rules).detail };
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
          ? // "rebook" because the office reads it as its to-do (the office, 2026-09-29).
            `${outcome.reason || 'Not done'}${outcome.reschedule ? ' · rebook' : ''}`
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
  inspectionType?: string | null,
): string[] {
  const details = parseVisitDetails(visitDetails);
  return servicesReportProblems(
    jobServices(details, inspectionType),
    report ?? { services: {}, filters: [] },
    bookedFilters(details),
    { assessFilters: inspectionAssessesFilters(inspectionType) },
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
    // What else was said about it -- its scores, a corrected size -- stays.
    ...existing,
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

/**
 * A register the technician found on site, added but not yet answered.
 *
 * Adding one used to go through `withFilterAnswer` with
 * `{ changed: false, reason: 'Found on site' }`, which had two consequences
 * nobody wanted. The new card drew itself with a red cross reading "Not changed
 * — Found on site", so a technician who had just successfully added a filter
 * was looking at what a refusal looks like; and `withFilterAnswer` ticks the
 * whole AC filter change as done, so merely *finding* a filter claimed the
 * service had been carried out. Both were reported as adding a filter failing
 * (2026-09-23).
 *
 * So the register is added unanswered: a plain card with Photograph on it,
 * exactly like one the office listed. `servicesReportProblems` asks nothing of
 * an unbooked register until it is claimed as changed, so this cannot let an
 * unphotographed filter through submission either.
 */
export function withAddedFilter(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const key = filterKey(filter);
  if ((current.filters ?? []).some((entry) => filterKey(entry) === key)) return current;
  const added: VisitFilterOutcome = {
    size: filter.size,
    location: filter.location,
    slot: filter.slot,
    changed: false,
    reason: null,
    photoId: null,
    photoKey: null,
    booked: false,
  };
  return { ...current, filters: [...(current.filters ?? []), added] };
}

/** Whether a register has actually been answered, as against merely added. */
export const filterAnswered = (answer: VisitFilterOutcome | undefined): boolean =>
  Boolean(answer && (answer.changed || answer.reason?.trim()));

/** The report without a register the technician added and then removed. */
export function withoutFilter(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const key = filterKey(filter);
  return { ...current, filters: (current.filters ?? []).filter((entry) => filterKey(entry) !== key) };
}

/**
 * One filter's entry with something changed on it, made if it has none yet --
 * a filter the visit listed is answered for the first time this way. Answering
 * anything about a filter is working the filter change, so the service is
 * marked done the way `withFilterAnswer` marks it.
 */
function withFilterEntry(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
  change: (entry: VisitFilterOutcome) => VisitFilterOutcome,
  options: { booked?: boolean } = {},
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const key = filterKey(filter);
  const existing = (current.filters ?? []).find((entry) => filterKey(entry) === key);
  const next = change(
    existing ?? {
      size: filter.size,
      location: filter.location,
      slot: filter.slot,
      changed: false,
      reason: null,
      photoId: null,
      photoKey: null,
      booked: options.booked ?? true,
    },
  );
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

/**
 * One filter scored, on an HVAC job: Clean, Undamaged, Working, or a comment
 * where it could not be (Moses, 2026-10-01). Only what the tap changed is
 * passed, and folded into what is there.
 */
export function withFilterAssessment(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
  patch: Partial<Pick<VisitFilterOutcome, 'isClean' | 'isUndamaged' | 'isWorking' | 'comment'>>,
  options: { booked?: boolean } = {},
): VisitServicesReport {
  return withFilterEntry(report, filter, (entry) => ({ ...entry, ...patch }), options);
}

/**
 * A filter the visit listed, taken off as not at the property -- or put back.
 * Removed, it is answered by its removal and nothing else is asked of it.
 */
export function withFilterRemoved(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
  removed: boolean,
): VisitServicesReport {
  return withFilterEntry(report, filter, (entry) =>
    removed
      ? { ...entry, removed: true, changed: false, reason: null, photoId: null, photoKey: null }
      : { ...entry, removed: false },
  );
}

/**
 * The size a filter really is, when it is not the size listed. The listed size
 * stays the register's identity; the same size as listed clears the correction.
 */
export function withFilterSize(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
  size: string,
  options: { booked?: boolean } = {},
): VisitServicesReport {
  const actual = normalizeFilterSize(size);
  return withFilterEntry(
    report,
    filter,
    (entry) => ({ ...entry, actualSize: actual === normalizeFilterSize(filter.size) ? null : actual }),
    options,
  );
}

/**
 * "Not changed" taken back on an HVAC job, keeping the filter's scores: into
 * the photograph when there is one, and outstanding when there is not.
 * (`withFilterInPhoto` drops a listed filter's entry instead, which on an HVAC
 * job would throw its scores away.)
 */
export function withFilterUndeclined(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
  photo: { photoKey: string | null; photoId: string | null } | null,
): VisitServicesReport {
  return withFilterEntry(report, filter, (entry) =>
    photo ? { ...entry, changed: true, reason: null, ...photo } : { ...entry, changed: false, reason: null },
  );
}

/** A register somebody declined, with the reason the office acts on. */
export const filterDeclined = (answer: VisitFilterOutcome | undefined): boolean =>
  Boolean(answer && !answer.changed && answer.reason?.trim());

/**
 * The report with one photograph for every filter (the office, 2026-09-29).
 *
 * The technician stacks the filters with their sizes facing the camera and
 * takes one picture, instead of photographing each register in turn. Every
 * register not declined is answered as changed and points at that picture: a
 * register the visit listed, and one added on site alike.
 *
 * A new photograph replaces the old one outright. `withFilterAnswer` keeps a
 * `photoId` the answer does not carry, so a retake left each register on the
 * photograph it replaced -- the server resolves `photoId` before `photoKey` --
 * and the retake never reached the office.
 *
 * The server needs nothing new: it resolves each register's key on its own, so
 * one key on several registers resolves to the one photograph on each.
 */
export function withFiltersPhoto(
  report: VisitServicesReport | null | undefined,
  visitDetails: string | null | undefined,
  photoKey: string,
): VisitServicesReport {
  let next = report ?? EMPTY_REPORT;
  for (const row of filterRows(visitDetails, next)) {
    if (filterDeclined(row.answer) || row.answer?.removed) continue;
    next = withFilterAnswer(next, row.filter, { changed: true, photoKey });
  }
  return {
    ...next,
    filters: (next.filters ?? []).map((filter) =>
      filter.changed && filter.photoKey === photoKey ? { ...filter, photoId: null } : filter,
    ),
  };
}

/**
 * The report with a discarded photograph taken back out of it.
 *
 * A filter's or a service's photograph is written into the checklist the moment
 * the shutter fires (`withFiltersPhoto`, `withServicePhoto`), before the image
 * leaves the phone -- and the camera offers it back to discard for fifteen
 * seconds. Discarding deleted the image and left the answers pointing at it: a
 * photograph that could never arrive, which the submission check counts as
 * taken and the console showed as "still uploading" for ever (5706 Micah Ln,
 * 2026-10-02). The registers stay changed and ask for their photograph again,
 * so a retake is the way on.
 */
export function withoutPhoto(
  report: VisitServicesReport | null | undefined,
  photoKey: string,
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const services: VisitServicesReport['services'] = { ...current.services };
  for (const service of Object.keys(services) as ReportableVisitService[]) {
    const outcome = services[service];
    if (outcome?.photoKey === photoKey && !outcome.photoId) services[service] = { ...outcome, photoKey: null };
  }
  return {
    ...current,
    services,
    filters: (current.filters ?? []).map((filter) =>
      filter.photoKey === photoKey && !filter.photoId ? { ...filter, photoKey: null } : filter,
    ),
  };
}

/**
 * The photograph the filters share, once one has been taken.
 *
 * The first changed register's, which after `withFiltersPhoto` is every changed
 * register's. A job answered one register at a time on an older build can
 * carry several; the screen only needs to know that one exists and whether it
 * has arrived.
 */
export function filtersPhoto(
  rows: readonly FilterRow[],
): { photoKey: string | null; photoId: string | null } | null {
  const answer = rows.find((row) => row.answer?.changed && (row.answer.photoKey || row.answer.photoId))?.answer;
  return answer ? { photoKey: answer.photoKey ?? null, photoId: answer.photoId ?? null } : null;
}

/**
 * A declined register taken back: into the photograph when there is one, and
 * unanswered when there is not.
 *
 * "Not changed" pressed by mistake used to be undone only by photographing the
 * register again. The filters are photographed together now, so the register
 * simply rejoins the picture that is already there.
 */
export function withFilterInPhoto(
  report: VisitServicesReport | null | undefined,
  filter: Pick<BookedFilter, 'size' | 'location' | 'slot'>,
  photo: { photoKey: string | null; photoId: string | null } | null,
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  if (photo) return withFilterAnswer(current, filter, { changed: true, ...photo });
  const key = filterKey(filter);
  return {
    ...current,
    filters: (current.filters ?? []).flatMap((entry) => {
      if (filterKey(entry) !== key) return [entry];
      // A register the office listed is unanswered when it has no entry; one
      // found on site keeps its entry, because the entry is all there is of it.
      return entry.booked === false
        ? [{ ...entry, changed: false, reason: null, photoId: null, photoKey: null }]
        : [];
    }),
  };
}

/** One line of the Add filters sheet: a size, and how many of it. */
export interface FilterEntry {
  size: string;
  quantity: number;
}

/**
 * Several filters found on site, added in one go.
 *
 * The Add sheet took one size at a time, so a house with two sizes was two
 * trips through it (the office, 2026-09-29: "not add a filter for this size
 * then add another filter for this size"). Each is added unanswered, like a
 * single one, and takes the next free slot of its size -- worked out against
 * the report as it grows, so two of one size become slots 1 and 2 rather than
 * both claiming the first. Capped at `MAX_BOOKED_FILTERS`, like the visit's own.
 */
export function withAddedFilters(
  report: VisitServicesReport | null | undefined,
  visitDetails: string | null | undefined,
  entries: readonly FilterEntry[],
): VisitServicesReport {
  let next = report ?? EMPTY_REPORT;
  for (const entry of entries) {
    const size = normalizeFilterSize(entry.size);
    for (let count = 0; count < Math.min(entry.quantity, MAX_BOOKED_FILTERS); count += 1) {
      if (filterRows(visitDetails, next).length >= MAX_BOOKED_FILTERS) return next;
      next = withAddedFilter(next, {
        size,
        location: null,
        slot: nextFilterSlot(visitDetails, next, { size, location: null }),
      });
    }
  }
  return next;
}

/**
 * The report with a service's answer taken back: unticked, so End job asks
 * about it again.
 */
export function withoutServiceAnswer(
  report: VisitServicesReport | null | undefined,
  service: ReportableVisitService,
): VisitServicesReport {
  const current = report ?? EMPTY_REPORT;
  const services = { ...current.services };
  delete services[service];
  return { ...current, filters: current.filters ?? [], services };
}

/** What a service left unticked at End job is recorded as. */
export const UNTICKED_REASON = 'Not done on this visit';

/**
 * The line the office reads for a service not done: the reason picked, then the
 * note, whichever were given -- and the same words End job uses when neither
 * was, because the server refuses a "not done" with no reason.
 */
export function notDoneReason(choice: string | null, note: string): string {
  return [choice, note.trim()].filter(Boolean).join(' — ') || UNTICKED_REASON;
}

/**
 * Every service left unticked, answered as not done and to be booked again.
 *
 * End job used to stop and ask why for each one. The office, 2026-09-29: a
 * technician who has done the filters and the inspection but not the pest
 * control must be able to end the job, and the office must still be able to
 * tell that pest control never happened -- so it is written down as not done,
 * with a rebook, rather than asked about. A reason or a note can still be given
 * on the row beforehand ("Not done"), and that answer is kept.
 */
export function withUntickedNotDone(
  report: VisitServicesReport | null | undefined,
  services: readonly ReportableVisitService[],
): VisitServicesReport {
  let next = report ?? EMPTY_REPORT;
  for (const service of services) {
    if (next.services[service]) continue;
    next = withServiceAnswer(next, service, { done: false, reason: UNTICKED_REASON, reschedule: true });
  }
  return next;
}

/**
 * Pest control's checkbox (the office, 2026-09-18: "Pest control just a check
 * box"). Ticking it marks the service done; unticking takes the answer away,
 * and a service answered not done is ticked done when it is tapped.
 */
export function toggledService(
  report: VisitServicesReport | null | undefined,
  service: ReportableVisitService,
): VisitServicesReport {
  return report?.services[service]?.done
    ? withoutServiceAnswer(report, service)
    : withServiceAnswer(report, service, { done: true, reason: null, reschedule: false });
}
