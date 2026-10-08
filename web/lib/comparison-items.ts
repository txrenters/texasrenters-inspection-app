/**
 * How a checklist item compared between move-in and move-out reads on screen,
 * kept apart from the components so it is testable without a browser.
 */

import { comparisonGradeText } from '@texasrenters/shared';
import type {
  AdminAreaComparison,
  AdminComparisonFinding,
  AdminComparisonItem,
  AdminComparisonItemSide,
  ComparisonItemChange,
} from '@texasrenters/shared';

/**
 * One side's grades in a few words: "Damaged, not working · dirty". Null was
 * not graded. The comparison report's own words (`comparisonGradeText`), so
 * the review table and the document an owner or tenant reads cannot disagree.
 */
export function gradeText(side: AdminComparisonItemSide | null) {
  return comparisonGradeText(side, 'Not graded');
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
  if (item.change === 'NO_CHANGE' && ungradedBefore) return { ...meta, label: 'Good at move-out' };
  return meta;
}

/** A finding the office has not confirmed or rejected yet. */
export function isWaiting(finding: Pick<AdminComparisonFinding, 'reviewStatus'>) {
  return finding.reviewStatus === 'PENDING_REVIEW';
}

/**
 * Worth a row in the room's table: something changed, needs cleaning, or the
 * office confirmed a finding about it. The rest is one click away.
 */
export function itemChanged(item: AdminComparisonItem) {
  return (
    (item.change !== 'NO_CHANGE' && item.change !== 'NOT_GRADED') ||
    item.cleaning === 'NEEDS_CLEANING' ||
    item.findings.some((finding) => !isWaiting(finding))
  );
}

/** Findings in the room still to confirm, on its items and on none. */
export function waitingCount(area: Pick<AdminAreaComparison, 'items' | 'otherFindings'>) {
  const onItems = (area.items ?? []).flatMap((item) => item.findings);
  return [...onItems, ...(area.otherFindings ?? [])].filter(isWaiting).length;
}

/**
 * Where a room stands, for the filters (2026-10-09). The office came to this
 * page and met 25 rooms of equal weight, eleven of them with nothing to
 * compare; it now opens on the ones that need something.
 */
export type RoomFilter = 'attention' | 'damage' | 'cleaning' | 'oneSide' | 'all';

const ONE_SIDE = new Set(['MISSING_BASELINE', 'MISSING_MOVE_OUT_EVIDENCE']);

export function roomStanding(area: Pick<AdminAreaComparison, 'classification' | 'items'>) {
  const oneSide = ONE_SIDE.has(area.classification);
  const damage = area.classification === 'NEW_DAMAGE' || area.classification === 'WORSENED';
  const cleaning = (area.items ?? []).some((item) => item.cleaning === 'NEEDS_CLEANING');
  const undated = area.classification === 'NOT_COMPARABLE';
  return { oneSide, damage, cleaning, undated };
}

export function roomInFilter(
  area: Pick<AdminAreaComparison, 'classification' | 'items'>,
  filter: RoomFilter,
) {
  const room = roomStanding(area);
  switch (filter) {
    case 'attention':
      return !room.oneSide && (room.damage || room.cleaning || room.undated);
    case 'damage':
      return room.damage;
    case 'cleaning':
      return !room.oneSide && !room.damage && room.cleaning;
    case 'oneSide':
      return room.oneSide;
    default:
      return true;
  }
}

/**
 * A room in a few words, for its line in the list: "8 new · 1 already at
 * move-in · 8 to clean".
 */
export function roomDigest(
  area: Pick<AdminAreaComparison, 'classification' | 'items' | 'fromRecording' | 'moveOutAreaId'>,
) {
  const items = area.items ?? [];
  const count = (change: ComparisonItemChange) => items.filter((item) => item.change === change).length;
  const room = roomStanding(area);
  if (room.oneSide) {
    if (area.classification === 'MISSING_BASELINE') return ['Move-out only'];
    return [area.moveOutAreaId ? 'No move-out photos or video' : 'Move-in only'];
  }
  const fresh = count('NEW_DAMAGE');
  const confirmed = room.damage ? (area.fromRecording?.length ?? 0) : 0;
  const parts = [
    fresh ? `${fresh} new` : null,
    confirmed ? `${confirmed} confirmed from video` : null,
    count('ALREADY_DAMAGED') ? `${count('ALREADY_DAMAGED')} already at move-in` : null,
    count('NO_BASELINE') ? `${count('NO_BASELINE')} not graded at move-in` : null,
    count('REPAIRED') ? `${count('REPAIRED')} repaired` : null,
    room.cleaning ? `${items.filter((item) => item.cleaning === 'NEEDS_CLEANING').length} to clean` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts : ['Nothing changed'];
}

function compact(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which move-in room this one was compared with, said only when it is not
 * plainly the same room: a different name, or a pairing somebody should check.
 * Replaces "normalized name · 80%", which told the office how, not what.
 */
export function pairingNote(
  area: Pick<AdminAreaComparison, 'areaName' | 'moveInAreaName' | 'matchMethod'>,
) {
  if (!area.moveInAreaName) return null;
  const check =
    area.matchMethod === 'AI_SUGGESTED'
      ? 'by AI'
      : area.matchMethod === 'AREA_CATEGORY'
        ? 'by room type'
        : null;
  if (!check && compact(area.moveInAreaName) === compact(area.areaName)) return null;
  return { name: area.moveInAreaName, check };
}

/**
 * Across every room: how many items are new, already there, and need cleaning.
 * New counts what the office confirmed from the recording too, in the rooms
 * whose verdict is new damage -- the report's own count, so the two agree.
 */
export function itemTotals(areas: AdminAreaComparison[]) {
  const totals = { fresh: 0, freshRooms: 0, existing: 0, unknown: 0, cleaning: 0 };
  for (const area of areas) {
    const items = area.items ?? [];
    const damage = roomStanding(area).damage;
    const fresh = damage
      ? items.filter((item) => item.change === 'NEW_DAMAGE').length + (area.fromRecording?.length ?? 0)
      : 0;
    totals.fresh += fresh;
    if (damage) totals.freshRooms += 1;
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
