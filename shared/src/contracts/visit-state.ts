import { FINISHED_INSPECTION_STATUSES } from './route-plan.js';

/**
 * Where a visit stands, in the office's words.
 *
 * Submitted is done (the office, 2026-10-05): the visit ends when the technician
 * submits it -- Jobber is told, their paid time stops -- and what follows is the
 * office's review of the findings, which is not the visit's. So the six
 * statuses from a submission on (Submitted, Processing, Review required, Under
 * review, To be determined, Completed) are one answer: Done. Or, when the
 * technician recorded that they could not get in, that.
 *
 * The inspection page, the list's column and the list's filter all say these,
 * so a visit reads the same wherever it is seen. Until 2026-10-07 the list said
 * "Review required" for a visit the inspection page called "Done".
 */
export type VisitState =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'PARTIALLY_COMPLETE'
  | 'COULD_NOT_GET_IN'
  | 'FOLLOW_UP'
  | 'CANCELLED';

/** The words a technician's "could not get in" submission starts its reason with. */
export const COULD_NOT_GET_IN_PREFIX = 'Could not get in';

export const VISIT_STATES: ReadonlyArray<{ value: VisitState; label: string }> = [
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'DONE', label: 'Complete' },
  { value: 'PARTIALLY_COMPLETE', label: 'Partially complete' },
  { value: 'COULD_NOT_GET_IN', label: 'Could not get in' },
  { value: 'FOLLOW_UP', label: 'Follow-up required' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function visitStateLabel(state: VisitState) {
  return VISIT_STATES.find((entry) => entry.value === state)?.label ?? state;
}

/**
 * What a submitted visit still owes (the office, 2026-11-17: "as long as one of
 * the jobs is not finished, don't mark the status complete, instead say
 * partially complete").
 *
 * A job on the visit is a booked service -- pest control, a filter change --
 * or the other inspection the same Jobber visit booked. One is still owed
 * while the technician's "not done, book it again" is with the office, or
 * booked again and not yet done, or while the other inspection is still to
 * happen. The office dismissing the request takes the job off the visit.
 *
 * Worked out by the server (`visitOpenWork`), because it is read from the
 * reschedule requests and from the other inspection, which a list row does
 * not carry.
 */
export interface VisitOpenWork {
  /** The booked services not done and still owed, as `REPORTABLE_VISIT_SERVICES` names them. */
  services: string[];
  /** The types of the inspections booked on the same visit that are still to be done. */
  inspections: string[];
}

export const hasOpenWork = (work: VisitOpenWork | null | undefined) =>
  Boolean(work && (work.services.length || work.inspections.length));

/** One inspection's visit state, from its status, why it could not be completed and what it still owes. */
export function visitStateOf(inspection: {
  status: string;
  completionBlockedReason?: string | null;
  openWork?: VisitOpenWork | null;
}): VisitState {
  if (inspection.status === 'CANCELLED') return 'CANCELLED';
  if ((FINISHED_INSPECTION_STATUSES as readonly string[]).includes(inspection.status)) {
    // Nothing was done on a visit nobody could get into: that is its own answer.
    if (inspection.completionBlockedReason?.trim().startsWith(COULD_NOT_GET_IN_PREFIX))
      return 'COULD_NOT_GET_IN';
    return hasOpenWork(inspection.openWork) ? 'PARTIALLY_COMPLETE' : 'DONE';
  }
  if (inspection.status === 'FOLLOW_UP_REQUIRED') return 'FOLLOW_UP';
  if (inspection.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  return 'SCHEDULED';
}

/** The technician has been: done, with or without something still owed. Review and the report start here. */
export function isWorkedVisit(state: VisitState) {
  return state === 'DONE' || state === 'PARTIALLY_COMPLETE';
}

/** Still to happen: a visit somebody has to be sent to. */
export function isUpcomingVisit(state: VisitState) {
  return state === 'SCHEDULED' || state === 'IN_PROGRESS' || state === 'FOLLOW_UP';
}
