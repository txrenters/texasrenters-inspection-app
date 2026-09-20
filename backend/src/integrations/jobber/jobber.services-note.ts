import {
  filterLabel,
  filtersNotChanged,
  formatPhotoStamp,
  installedSizes,
  parseVisitDetails,
  type ReportableVisitService,
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

export function jobberServicesNote(input: {
  report: VisitServicesReport;
  /** The visit's Details, to know whether it booked an occupied inspection. */
  details: string | null;
  /** Whether the inspection was walked: at least one area completed rather than skipped. */
  inspectionDone: boolean;
  technicianName: string | null;
  recordedAt: Date;
}): string | null {
  const lines: { order: number; text: string }[] = [];
  const completed: number[] = [];

  for (const service of Object.keys(OFFICE_NAME) as ReportableVisitService[]) {
    const outcome = input.report.services[service];
    if (!outcome) continue;
    const number = OFFICE_NUMBER[service];
    const label = number ? `${number}. ${OFFICE_NAME[service]}` : OFFICE_NAME[service];
    if (outcome.done) {
      if (number) completed.push(number);
      const sizes = service === 'filterChange' ? installedSizes(input.report) : [];
      lines.push({
        order: number ?? 10,
        text: `${label}: done${sizes.length ? ` (installed ${sizes.join(', ')})` : ''}`,
      });
      /**
       * And which register was missed, where the technician answered for each.
       *
       * "Filter Change: done" over a house whose upstairs register was painted
       * over is how the office comes to believe a filter is being changed. The
       * office asked for a photograph of each register (2026-09-18); this is
       * the other half of that answer.
       */
      if (service === 'filterChange')
        for (const filter of filtersNotChanged(input.report))
          lines.push({
            order: number ?? 10,
            text: `   ${filterLabel(filter)}: NOT changed. ${filter.reason ?? ''}`.trimEnd(),
          });
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
