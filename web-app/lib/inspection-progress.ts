import type { AdminInspectionStatus } from '@texasrenters/shared';

/**
 * The inspection lifecycle as four steps an administrator can act on.
 *
 * The page used to show the raw status as a badge, which meant "In progress"
 * appeared beside "In progress" beside "In progress" — the same two words
 * standing for capture still running, review not started, and finalization
 * unavailable. Reading it told you nothing about which of those was true.
 *
 * Pure so the mapping is testable without a renderer, and so every status has a
 * defined answer rather than falling through to a default nobody chose.
 */

export type StepState = 'complete' | 'active' | 'pending' | 'blocked';

export interface ProgressStep {
  key: 'capture' | 'submission' | 'review' | 'finalized';
  label: string;
  state: StepState;
  /** What this step means right now, in the administrator's terms. */
  detail: string;
}

const STEP_LABELS: Record<ProgressStep['key'], string> = {
  capture: 'Capture',
  submission: 'Technician submission',
  review: 'Admin review',
  finalized: 'Finalized',
};

/**
 * Which step each status sits on, and how far along the earlier ones are.
 *
 * Expressed as an index rather than per-status booleans: every step before the
 * current one is complete by definition, which is what stops the four states
 * drifting out of agreement with each other.
 */
const STATUS_POSITION: Record<AdminInspectionStatus, number> = {
  SCHEDULED: 0,
  IN_PROGRESS: 0,
  TECHNICIAN_SUBMITTED: 1,
  PROCESSING: 1,
  REVIEW_REQUIRED: 2,
  UNDER_REVIEW: 2,
  TBD: 2,
  FOLLOW_UP_REQUIRED: 2,
  COMPLETED: 3,
  CANCELLED: -1,
};

const ACTIVE_DETAIL: Partial<Record<AdminInspectionStatus, string>> = {
  SCHEDULED: 'Not started',
  IN_PROGRESS: 'Technician is capturing evidence',
  TECHNICIAN_SUBMITTED: 'Submitted, awaiting processing',
  PROCESSING: 'Transcribing and analysing evidence',
  REVIEW_REQUIRED: 'Findings need a decision',
  UNDER_REVIEW: 'Review in progress',
  TBD: 'Marked to be determined',
  FOLLOW_UP_REQUIRED: 'Follow-up requested from the technician',
  COMPLETED: 'Finalized',
  CANCELLED: 'Inspection cancelled',
};

export function inspectionProgress(status: AdminInspectionStatus): ProgressStep[] {
  const position = STATUS_POSITION[status];
  const keys: ProgressStep['key'][] = ['capture', 'submission', 'review', 'finalized'];

  return keys.map((key, index) => {
    // Cancelled is not a point on the path — nothing after it will happen, and
    // showing three "pending" steps would imply otherwise.
    if (position === -1)
      return {
        key,
        label: STEP_LABELS[key],
        state: index === 0 ? ('blocked' as const) : ('pending' as const),
        detail: index === 0 ? 'Inspection cancelled' : '',
      };

    const state: StepState =
      index < position ? 'complete' : index === position ? 'active' : 'pending';
    return {
      key,
      label: STEP_LABELS[key],
      state,
      detail: state === 'active' ? (ACTIVE_DETAIL[status] ?? '') : '',
    };
  });
}

/**
 * The one action worth emphasising, given where the inspection is.
 *
 * Finalization was previously offered from the moment the page loaded, so the
 * most prominent control was usually one nobody could take.
 */
export function primaryActionLabel(status: AdminInspectionStatus): string | null {
  if (status === 'COMPLETED' || status === 'CANCELLED') return null;
  if (STATUS_POSITION[status] === 0) return 'View technician progress';
  if (STATUS_POSITION[status] === 1) return 'Review evidence';
  return 'Finalize inspection';
}
