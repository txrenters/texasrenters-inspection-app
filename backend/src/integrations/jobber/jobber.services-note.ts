import {
  filterLabel,
  filtersNotChanged,
  filtersRemoved,
  formatPhotoStamp,
  inspectionAssessesFilters,
  installedFiltersSummary,
  normalizeFilterSize,
  parseVisitDetails,
  type ReportableVisitService,
  type VisitFilterOutcome,
  type VisitServicesReport,
} from '@texasrenters/shared';

/**
 * The note a technician's services report becomes on the Jobber job.
 *
 * Written the way the office asks for it on every benefit-package visit:
 * "Indicate in the notes which services were completed by using the
 * corresponding numbers: 1.Filter Change 2.Pest Control 3.HVAC / Occupied
 * Inspection. Example: "1, 2"". The numbers come first, in that format, so a
 * coordinator scanning Jobber reads them as they always have; the lines under
 * them say what the numbers cannot -- why something was not done, and whether it
 * needs booking again.
 */

const OFFICE_NUMBER: Partial<Record<ReportableVisitService | 'occupiedInspection', number>> = {
  filterChange: 1,
  pestControl: 2,
  occupiedInspection: 3,
};

const OFFICE_NAME: Record<ReportableVisitService, string> = {
  filterChange: 'Filter Change',
  pestControl: 'Pest Control',
  fleaTreatment: 'Flea Treatment',
};

/** How many answered registers share this one's size and place. */
function sameRegisters(report: VisitServicesReport, of: VisitFilterOutcome): number {
  const place = (filter: VisitFilterOutcome) =>
    `${normalizeFilterSize(filter.size)}|${(filter.location ?? '').trim().toLowerCase()}`;
  return (report.filters ?? []).filter((filter) => place(filter) === place(of)).length;
}

export function jobberServicesNote(input: {
  report: VisitServicesReport;
  /** The visit's Details, to know whether it booked an occupied inspection. */
  details: string | null;
  /** The inspection's kind: an HVAC job answers a filter change nobody booked. */
  inspectionType?: string | null;
  /** Whether the inspection was walked: at least one area completed rather than skipped. */
  inspectionDone: boolean;
  technicianName: string | null;
  recordedAt: Date;
}): string | null {
  const lines: { order: number; text: string }[] = [];
  const completed: number[] = [];

  const booked = parseVisitDetails(input.details).services;
  const unbookedFilters = inspectionAssessesFilters(input.inspectionType) && !booked.filterChange;
  for (const service of Object.keys(OFFICE_NAME) as ReportableVisitService[]) {
    const outcome = input.report.services[service];
    if (!outcome) continue;
    // An HVAC job scores its filters on the AC filter change whether or not
    // the visit booked one (Moses, 2026-10-01). A change nobody booked is not
    // the office's "1." to tick, so the note says nothing of it.
    if (service === 'filterChange' && unbookedFilters) continue;
    const number = OFFICE_NUMBER[service];
    const label = number ? `${number}. ${OFFICE_NAME[service]}` : OFFICE_NAME[service];
    if (outcome.done) {
      if (number) completed.push(number);
      /**
       * Counted: "installed 3 filters: 1 × 12x24x1, 2 × 16x25x1". The invoice
       * is made from this line, and a list of sizes said "12x24x1, 16x25x1" for
       * three filters, two of them the same size (5706 Micah Ln, 2026-10-02).
       */
      const installed = service === 'filterChange' ? installedFiltersSummary(input.report) : null;
      lines.push({
        order: number ?? 10,
        text: `${label}: done${installed ? ` (installed ${installed})` : ''}`,
      });
      /**
       * And which register was missed, where the technician answered for each.
       *
       * "Filter Change: done" over a house whose upstairs register was painted
       * over is how the office comes to believe a filter is being changed. The
       * office asked for a photograph of each register (2026-09-18); this is
       * the other half of that answer.
       */
      if (service === 'filterChange') {
        for (const filter of filtersNotChanged(input.report))
          lines.push({
            order: number ?? 10,
            // "(2 of 2)" where the size is in that place more than once, or two
            // identical lines would not say which register was missed.
            text: `   ${filterLabel(filter, sameRegisters(input.report, filter))}: NOT changed. ${filter.reason ?? ''}`.trimEnd(),
          });
        // What the visit listed and the technician corrected: the office's
        // record of the property's filters is wrong until somebody fixes it.
        for (const filter of filtersRemoved(input.report))
          lines.push({ order: number ?? 10, text: `   ${filterLabel({ ...filter, actualSize: null })}: not at the property.` });
        for (const filter of input.report.filters ?? [])
          if (filter.actualSize && !filter.removed)
            lines.push({
              order: number ?? 10,
              text: `   Listed as ${filter.size}, actually ${filter.actualSize}.`,
            });
      }
    } else {
      lines.push({
        order: number ?? 10,
        text: `${label}: NOT done. ${outcome.reason ?? ''}`.trim() +
          (outcome.reschedule ? ' Needs to be rescheduled.' : ''),
      });
    }
  }

  if (parseVisitDetails(input.details).services.occupiedInspection) {
    if (input.inspectionDone) completed.push(3);
    lines.push({
      order: 3,
      text: `3. HVAC / Occupied Inspection: ${input.inspectionDone ? 'done' : 'NOT done'}`,
    });
  }

  if (!lines.length && !input.report.notes) return null;
  const recorded = formatPhotoStamp(input.recordedAt, 'DEVICE_CLOCK');
  return [
    `Services completed: ${completed.length ? completed.sort((a, b) => a - b).join(', ') : 'none'}`,
    ...lines.sort((a, b) => a.order - b.order).map((line) => line.text),
    input.report.notes ? `Notes: ${input.report.notes}` : null,
    `Recorded${input.technicianName ? ` by ${input.technicianName}` : ''} in the Texas Renters inspection app${
      recorded ? `, ${recorded}` : ''
    }.`,
  ]
    .filter(Boolean)
    .join('\n');
}
