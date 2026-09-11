import type { ComparisonClassification } from '@texasrenters/shared';

import { humanize } from '@/lib/format';

/**
 * How a comparison verdict is named and coloured, in one place.
 *
 * The review panel and the printable comparison report both show these, and a
 * row that reads "New damage" in red on screen must not read "Requires review"
 * in amber on the document somebody disputes. Shared so the two cannot drift.
 */
export const CLASSIFICATIONS: ReadonlyArray<{ value: ComparisonClassification; label: string }> = [
  { value: 'UNCHANGED', label: 'Unchanged' },
  { value: 'IMPROVED', label: 'Improved' },
  { value: 'NEW_DAMAGE', label: 'New damage' },
  { value: 'WORSENED', label: 'Worsened' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'MISSING_BASELINE', label: 'Missing baseline' },
  { value: 'MISSING_MOVE_OUT_EVIDENCE', label: 'Missing move-out evidence' },
  { value: 'NOT_COMPARABLE', label: 'Not comparable' },
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
