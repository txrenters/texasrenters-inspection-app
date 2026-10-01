import type { AreaReviewStatus } from '@texasrenters/shared';

/**
 * Wording and tone per area status. Never colour alone — each carries a label.
 *
 * Shared by the area list and the photo sheet, so one area reads the same in
 * both views.
 */
export const STATUS_META: Record<
  AreaReviewStatus,
  { label: string; variant: 'secondary' | 'warning' | 'success' | 'info' | 'destructive' }
> = {
  NOT_STARTED: { label: 'Not started', variant: 'secondary' },
  // Not 'warning'. A skipped area is a decision the technician recorded with a
  // reason, not a fault to chase — colouring it like incomplete evidence sends
  // reviewers looking for a recording that was never going to exist.
  SKIPPED: { label: 'Skipped', variant: 'secondary' },
  EVIDENCE_INCOMPLETE: { label: 'Evidence incomplete', variant: 'warning' },
  EVIDENCE_READY: { label: 'Evidence ready', variant: 'success' },
  ANALYSIS_PROCESSING: { label: 'Analysing', variant: 'info' },
  FINDINGS_NEED_REVIEW: { label: 'Findings need review', variant: 'warning' },
  REVIEWED: { label: 'Reviewed', variant: 'success' },
  FOLLOW_UP_REQUIRED: { label: 'Follow-up required', variant: 'destructive' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};
