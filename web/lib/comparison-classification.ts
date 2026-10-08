import type { ComparisonClassification } from '@texasrenters/shared';

import { humanize } from '@/lib/format';

/**
 * How a comparison verdict is named and coloured, in one place.
 *
 * The review panel and the printable comparison report both show these, and a
 * row that reads "New damage" in red on screen must not read "Requires review"
 * in amber on the document somebody disputes. Shared so the two cannot drift.
 */
// In the words the report uses (2026-10-09): "Missing baseline" told the office
// what the code lacked, not what happened to the room.
export const CLASSIFICATIONS: ReadonlyArray<{ value: ComparisonClassification; label: string }> = [
  { value: 'UNCHANGED', label: 'No new damage' },
  { value: 'IMPROVED', label: 'Better than at move-in' },
  { value: 'NEW_DAMAGE', label: 'New damage' },
  { value: 'WORSENED', label: 'Worse than at move-in' },
  { value: 'RESOLVED', label: 'Better than at move-in' },
  { value: 'MISSING_BASELINE', label: 'Not at move-in' },
  { value: 'MISSING_MOVE_OUT_EVIDENCE', label: 'Not at move-out' },
  { value: 'NOT_COMPARABLE', label: "Can't tell what's new" },
  { value: 'REQUIRES_REVIEW', label: 'Requires review' },
];

export function classLabel(value: string) {
  return CLASSIFICATIONS.find((option) => option.value === value)?.label ?? humanize(value);
}

/**
 * What each classification means for the tenancy, expressed as a tone.
 *
 * Grouping them by consequence is the point: "new damage" and "worsened" are
 * the two that cost someone money, and they should not look like "improved".
 */
export const CLASSIFICATION_VARIANT: Record<
  string,
  'success' | 'destructive' | 'warning' | 'secondary'
> = {
  UNCHANGED: 'secondary',
  IMPROVED: 'success',
  RESOLVED: 'success',
  NEW_DAMAGE: 'destructive',
  WORSENED: 'destructive',
  MISSING_BASELINE: 'warning',
  MISSING_MOVE_OUT_EVIDENCE: 'warning',
  NOT_COMPARABLE: 'secondary',
  REQUIRES_REVIEW: 'warning',
};
