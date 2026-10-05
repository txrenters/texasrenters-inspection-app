import { InspectionStatus } from '@prisma/client';
import { FINISHED_INSPECTION_STATUSES } from '@texasrenters/shared';

/**
 * The visit is done: the technician has submitted it, and everything after.
 *
 * **The office's rule (2026-10-05): submitted is done.** Nobody finalizes any
 * more. The maintenance admins review the findings and generate the reports,
 * and a visit is finished the moment the technician submits it -- which is when
 * Jobber is told the visit is complete and the technician's paid time stops.
 * Code that waited for COMPLETED (an administrator's finalize, or Jobber's own
 * completion) left a submitted inspection looking open for ever: the next
 * technician lost the last visit's note, the "completed" counts stopped moving,
 * and a walked visit could still be rescheduled and its edits pushed to Jobber.
 *
 * The same list the route map already uses for "the technician has been and
 * done the visit", so the two cannot disagree. It leaves out
 * FOLLOW_UP_REQUIRED, which asks for another visit, and CANCELLED.
 */
export const DONE_INSPECTION_STATUSES: InspectionStatus[] = FINISHED_INSPECTION_STATUSES.map(
  (status) => InspectionStatus[status],
);

/** Whether an inspection's visit is done. */
export function isDoneInspectionStatus(status: InspectionStatus): boolean {
  return DONE_INSPECTION_STATUSES.includes(status);
}
