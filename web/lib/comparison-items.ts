/**
 * How a checklist item compared between move-in and move-out reads on screen,
 * kept apart from the components so it is testable without a browser.
 */

import type {
  AdminAreaComparison,
  AdminComparisonItem,
  AdminComparisonItemSide,
  ComparisonItemChange,
} from '@texasrenters/shared';

/** One side's grades in a few words: "Damaged, not working · dirty". Null was not graded. */
export function gradeText(side: AdminComparisonItemSide | null) {
  if (!side) return 'Not graded';
  const condition: string[] = [];
  if (side.undamaged === false) condition.push('damaged');
  if (side.working === false) condition.push('not working');
  if (!condition.length && (side.undamaged === true || side.working === true))
    condition.push('sound');
  const cleanliness =
    side.clean === false ? 'dirty' : side.clean === true && !condition.length ? 'clean' : null;
  const text = [condition.join(', '), cleanliness].filter(Boolean).join(' · ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Not graded';
}

/** Each change, named and coloured by what it means for the tenancy. */
export const CHANGE_META: Record<
  ComparisonItemChange,
  { label: string; variant: 'destructive' | 'warning' | 'success' | 'secondary' | 'outline' }
> = {
  NEW_DAMAGE: { label: 'New since move-in', variant: 'destructive' },
  NO_BASELINE: { label: 'Not graded at move-in', variant: 'warning' },
  ALREADY_DAMAGED: { label: 'Already at move-in', variant: 'secondary' },
  REPAIRED: { label: 'Repaired', variant: 'success' },
  NO_CHANGE: { label: 'No change', variant: 'outline' },
  NOT_GRADED: { label: 'Not graded at move-out', variant: 'outline' },
};

/**
 * The change as the table names it. "No change" claims the move-in recorded
 * the item sound, so an item it never graded says only what the move-out saw.
 */
export function changeMeta(item: Pick<AdminComparisonItem, 'change' | 'moveIn'>) {
  const meta = CHANGE_META[item.change];
  const ungradedBefore =
    !item.moveIn || (item.moveIn.undamaged === null && item.moveIn.working === null);
  if (item.change === 'NO_CHANGE' && ungradedBefore) return { ...meta, label: 'Sound at move-out' };
  return meta;
}

/** Across every room: how many items are new, already there, and need cleaning. */
export function itemTotals(areas: AdminAreaComparison[]) {
  const totals = { fresh: 0, freshRooms: 0, existing: 0, unknown: 0, cleaning: 0 };
  for (const area of areas) {
    const items = area.items ?? [];
    const fresh = items.filter((item) => item.change === 'NEW_DAMAGE').length;
    totals.fresh += fresh;
    if (fresh) totals.freshRooms += 1;
    totals.existing += items.filter((item) => item.change === 'ALREADY_DAMAGED').length;
    totals.unknown += items.filter((item) => item.change === 'NO_BASELINE').length;
    totals.cleaning += items.filter((item) => item.cleaning === 'NEEDS_CLEANING').length;
  }
  return totals;
}

/** A finding's decision, in a word, for the line under its item. */
export function findingStatus(reviewStatus: string) {
  if (reviewStatus === 'APPROVED') return 'Approved';
  if (reviewStatus === 'PENDING_REVIEW') return 'Needs review';
  return reviewStatus.charAt(0) + reviewStatus.slice(1).toLowerCase().replace(/_/g, ' ');
}
