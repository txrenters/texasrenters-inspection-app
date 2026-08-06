import type { InspectionStatus } from '../domain/models';

/**
 * How an inspection status reads to the technician holding the phone.
 *
 * The office cares about the difference between PROCESSING, REVIEW_REQUIRED,
 * UNDER_REVIEW and TBD. The technician does not — from the field all four mean
 * the same thing: the work is handed over and nobody is waiting on them. They
 * collapse to one label deliberately, rather than leaking the review workflow's
 * vocabulary onto a screen that cannot act on it.
 *
 * Every status is spelled out. The screens used to hold a three-entry map with
 * a fallback that printed the raw enum, so submitting an inspection replaced
 * "In Progress" with a grey pill reading "TECHNICIAN SUBMITTED" — the one
 * moment a technician most needs to see that their work landed.
 */
export type InspectionStatusTone =
  | 'assigned'
  | 'active'
  | 'submitted'
  | 'review'
  | 'attention'
  | 'done'
  | 'closed';

export interface InspectionStatusPresentation {
  label: string;
  tone: InspectionStatusTone;
}

const PRESENTATION: Record<InspectionStatus, InspectionStatusPresentation> = {
  SCHEDULED: { label: 'Assigned', tone: 'assigned' },
  IN_PROGRESS: { label: 'In Progress', tone: 'active' },
  TECHNICIAN_SUBMITTED: { label: 'Submitted', tone: 'submitted' },
  PROCESSING: { label: 'With Office', tone: 'review' },
  REVIEW_REQUIRED: { label: 'With Office', tone: 'review' },
  UNDER_REVIEW: { label: 'With Office', tone: 'review' },
  TBD: { label: 'With Office', tone: 'review' },
  // The one post-submission state that can become the technician's problem
  // again, so it is not collapsed into "With Office".
  FOLLOW_UP_REQUIRED: { label: 'Follow-up Needed', tone: 'attention' },
  COMPLETED: { label: 'Completed', tone: 'done' },
  CANCELLED: { label: 'Cancelled', tone: 'closed' },
};

export function inspectionStatusPresentation(
  status: InspectionStatus | string,
): InspectionStatusPresentation {
  return (
    PRESENTATION[status as InspectionStatus] ?? {
      // A status this build has never heard of: say so rather than printing an
      // enum, and never imply the work is finished.
      label: 'Unknown',
      tone: 'review',
    }
  );
}

export const inspectionStatusLabel = (status: InspectionStatus | string) =>
  inspectionStatusPresentation(status).label;

/**
 * Tone → NativeWind classes, shared so the list and the detail screen cannot
 * disagree about what "submitted" looks like. Both previously carried their own
 * inline ternaries over three statuses and painted everything else the same
 * colour as "assigned".
 *
 * Icons stay with the screens: they are components, and only the list shows one.
 */
export const INSPECTION_STATUS_TONE_CLASS: Record<
  InspectionStatusTone,
  { bg: string; text: string }
> = {
  assigned: { bg: 'bg-chart-4/15', text: 'text-chart-4' },
  active: { bg: 'bg-chart-2/15', text: 'text-chart-2' },
  submitted: { bg: 'bg-chart-3/15', text: 'text-chart-3' },
  review: { bg: 'bg-muted', text: 'text-muted-foreground' },
  attention: { bg: 'bg-destructive/15', text: 'text-destructive' },
  done: { bg: 'bg-chart-3/15', text: 'text-chart-3' },
  closed: { bg: 'bg-muted', text: 'text-muted-foreground' },
};

/**
 * Statuses where the technician still owns the inspection.
 *
 * Mirrors the backend's technician queue, which is SCHEDULED + IN_PROGRESS —
 * anything else has left the field and shows on the handset as a record rather
 * than a task.
 */
const FIELD_ACTIVE: readonly InspectionStatus[] = ['SCHEDULED', 'IN_PROGRESS'];

export const isFieldActive = (status: InspectionStatus | string) =>
  FIELD_ACTIVE.includes(status as InspectionStatus);

/**
 * True once the technician's capture has been handed to the office.
 *
 * CANCELLED is excluded: a cancelled inspection was never submitted, and
 * showing it as handed over would credit work that did not happen.
 */
export const isSubmittedToOffice = (status: InspectionStatus | string) =>
  !isFieldActive(status) && status !== 'CANCELLED';
