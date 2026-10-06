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
  | 'COULD_NOT_GET_IN'
  | 'FOLLOW_UP'
  | 'CANCELLED';

/** The words a technician's "could not get in" submission starts its reason with. */
export const COULD_NOT_GET_IN_PREFIX = 'Could not get in';

export const VISIT_STATES: ReadonlyArray<{ value: VisitState; label: string }> = [
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'DONE', label: 'Done' },
  { value: 'COULD_NOT_GET_IN', label: 'Could not get in' },
  { value: 'FOLLOW_UP', label: 'Follow-up required' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function visitStateLabel(state: VisitState) {
  return VISIT_STATES.find((entry) => entry.value === state)?.label ?? state;
}

/** One inspection's visit state, from its status and why it could not be completed. */
export function visitStateOf(inspection: {
  status: string;
  completionBlockedReason?: string | null;
}): VisitState {
  if (inspection.status === 'CANCELLED') return 'CANCELLED';
  if ((FINISHED_INSPECTION_STATUSES as readonly string[]).includes(inspection.status))
    return inspection.completionBlockedReason?.trim().startsWith(COULD_NOT_GET_IN_PREFIX)
      ? 'COULD_NOT_GET_IN'
      : 'DONE';
  if (inspection.status === 'FOLLOW_UP_REQUIRED') return 'FOLLOW_UP';
  if (inspection.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  return 'SCHEDULED';
}

/** Still to happen: a visit somebody has to be sent to. */
export function isUpcomingVisit(state: VisitState) {
  return state === 'SCHEDULED' || state === 'IN_PROGRESS' || state === 'FOLLOW_UP';
}
