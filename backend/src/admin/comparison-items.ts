/**
 * Move-in against move-out, one checklist item at a time.
 *
 * The comparison used to count defects per room: some at move-in, some at
 * move-out, so "uncertain". On 5819 Flower Gate Dr (2026-10-01) that was every
 * room but two, because both inspections graded something damaged in nearly
 * every room. But both graded the *same items* (the checklist belongs to the
 * room, not the visit), so the question the office actually asks is
 * answerable: the entrance floor was damaged at move-in and still is, the
 * windows were fine at move-in and are damaged now.
 *
 * Pure, and given the rows rather than querying, so every rule here is
 * testable on its own.
 */
import { findingMatchesChecklistItem } from '../common/checklist-item-match';

export type ItemSide = {
  clean: boolean | null;
  undamaged: boolean | null;
  working: boolean | null;
  comment: string | null;
};

/**
 * What happened to one item between the two inspections, as far as damage
 * goes. Cleanliness is separate: a move-out is expected to need cleaning, and
 * that is the tenant's cleaning obligation, not harm to the property.
 */
export type ItemChange =
  /** Undamaged and working at move-in, damaged or not working now. */
  | 'NEW_DAMAGE'
  /** Damaged at move-in and still damaged. Not the tenant's. */
  | 'ALREADY_DAMAGED'
  /** Damaged at move-in, sound now. */
  | 'REPAIRED'
  /** Sound at both. */
  | 'NO_CHANGE'
  /** Damaged now, but the move-in never graded it: whether it is new is unknown. */
  | 'NO_BASELINE'
  /** The move-out never graded it. */
  | 'NOT_GRADED';

export type ItemCleaning = 'NEEDS_CLEANING' | 'ALREADY_DIRTY' | null;

export type ComparedItem = {
  itemId: string;
  label: string;
  /** Kept so the console can show each finding beside the item it is about. */
  keywords: string[];
  moveIn: ItemSide | null;
  moveOut: ItemSide | null;
  change: ItemChange;
  cleaning: ItemCleaning;
};

/** A checklist response as both inspections' rows are read. */
export type ChecklistRow = {
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
  comment: string | null;
  checklistItem: { id: string; label: string; keywords: string[]; responseType: string };
};

/** A move-out finding as the verdict weighs it. */
export type FindingSignal = {
  title: string;
  category: string;
  findingType: string;
  comparisonResult: string | null;
};

/** Damaged or not working: true; graded sound: false; not graded for damage: null. */
export function damageOf(side: ItemSide | null) {
  if (!side) return null;
  if (side.undamaged === false || side.working === false) return true;
  if (side.undamaged === true || side.working === true) return false;
  return null;
}

function dirtOf(side: ItemSide | null) {
  if (!side || side.clean === null) return null;
  return side.clean === false;
}

export function compareItem(moveIn: ItemSide | null, moveOut: ItemSide | null) {
  const before = damageOf(moveIn);
  const after = damageOf(moveOut);
  let change: ItemChange;
  if (after === null) change = 'NOT_GRADED';
  else if (after) change = before === null ? 'NO_BASELINE' : before ? 'ALREADY_DAMAGED' : 'NEW_DAMAGE';
  else change = before ? 'REPAIRED' : 'NO_CHANGE';
  const cleaning: ItemCleaning = dirtOf(moveOut)
    ? dirtOf(moveIn)
      ? 'ALREADY_DIRTY'
      : 'NEEDS_CLEANING'
    : null;
  return { change, cleaning };
}

function side(row: ChecklistRow | undefined): ItemSide | null {
  if (!row) return null;
  return {
    clean: row.isClean ?? null,
    undamaged: row.isUndamaged ?? null,
    working: row.isWorking ?? null,
    comment: row.comment?.trim() || null,
  };
}

/**
 * Pair one room's checklist across the two inspections by item. Only status
 * items: a reading or a line of text has no damaged or sound to compare. In the
 * move-out's order, then anything only the move-in answered.
 */
export function compareItems(moveInRows: ChecklistRow[], moveOutRows: ChecklistRow[]) {
  const status = (row: ChecklistRow) => row.checklistItem.responseType === 'STATUS';
  const before = new Map(moveInRows.filter(status).map((row) => [row.checklistItem.id, row]));
  const after = moveOutRows.filter(status);
  const ids = [
    ...after.map((row) => row.checklistItem.id),
    ...[...before.keys()].filter((id) => !after.some((row) => row.checklistItem.id === id)),
  ];
  return ids.map((itemId): ComparedItem => {
    const outRow = after.find((row) => row.checklistItem.id === itemId);
    const inRow = before.get(itemId);
    const item = (outRow ?? inRow)!.checklistItem;
    const moveIn = side(inRow);
    const moveOut = side(outRow);
    return {
      itemId,
      label: item.label,
      keywords: item.keywords,
      moveIn,
      moveOut,
      ...compareItem(moveIn, moveOut),
    };
  });
}

const MAX_NAMED = 6;

/** "Doors and locks, Walls and ceilings and 2 more" */
export function nameList(labels: string[]) {
  if (labels.length <= MAX_NAMED) return labels.join(', ');
  return `${labels.slice(0, MAX_NAMED).join(', ')} and ${labels.length - MAX_NAMED} more`;
}

function possiblyNew(finding: FindingSignal) {
  return (
    finding.findingType === 'POSSIBLE_NEW_DAMAGE' ||
    finding.comparisonResult === 'POSSIBLE_NEW_DAMAGE'
  );
}

export type ItemVerdict = {
  classification:
    | 'NEW_DAMAGE'
    | 'REQUIRES_REVIEW'
    | 'UNCHANGED'
    | 'RESOLVED';
  requiresReview: boolean;
  /**
   * The technician's checklist, in words. Printed on the comparison report,
   * which may reach a tenant, so it says only what the two inspections
   * recorded and never repeats an AI finding nobody has reviewed.
   */
  summary: string;
  /**
   * Why the AI's findings send the room to review, for the console only. Null
   * when they do not.
   */
  aiNote: string | null;
};

/**
 * One room's verdict from its items, or null when the two inspections have no
 * item both graded for damage -- then there is nothing to compare item by item
 * and the caller falls back to counting defects.
 *
 * `findings` are the move-out's, decided or not, and never the rejected ones:
 * a finding the office rejected is not damage. They can only send a room to
 * review; the checklist is what decides whether damage is new.
 */
export function itemVerdict(
  items: ComparedItem[],
  findings: FindingSignal[],
  weakMatch: boolean,
): ItemVerdict | null {
  const compared = items.filter(
    (item) => damageOf(item.moveIn) !== null && damageOf(item.moveOut) !== null,
  );
  if (!compared.length) return null;

  const labels = (change: ItemChange) =>
    items.filter((item) => item.change === change).map((item) => item.label);
  const fresh = labels('NEW_DAMAGE');
  const existing = labels('ALREADY_DAMAGED');
  const repaired = labels('REPAIRED');
  const unknown = labels('NO_BASELINE');
  const cleaning = items.filter((item) => item.cleaning === 'NEEDS_CLEANING').map((item) => item.label);

  const sentences: string[] = [];
  if (fresh.length) sentences.push(`New since move-in: ${nameList(fresh)}.`);
  if (unknown.length)
    sentences.push(`Damaged at move-out, but not graded at move-in: ${nameList(unknown)}.`);
  if (existing.length) sentences.push(`Already damaged at move-in: ${nameList(existing)}.`);
  if (repaired.length)
    sentences.push(`Damaged at move-in, not at move-out: ${nameList(repaired)}.`);
  if (!fresh.length && !unknown.length && !existing.length && !repaired.length)
    sentences.push('No change in condition on any item graded at both inspections.');
  if (cleaning.length) sentences.push(`Needs cleaning: ${nameList(cleaning)}.`);
  const summary = sentences.join(' ');

  // The AI's findings that claim new damage, against what the checklist says
  // about the item each is about.
  const claims = findings.filter(possiblyNew);
  const onItem = (finding: FindingSignal) =>
    items.find((item) => findingMatchesChecklistItem(finding, item));
  const worse = claims.filter((finding) => onItem(finding)?.change === 'ALREADY_DAMAGED');
  const unexplained = claims.filter((finding) => {
    const item = onItem(finding);
    return !item || item.change === 'NO_CHANGE' || item.change === 'REPAIRED' || item.change === 'NOT_GRADED';
  });
  const notes: string[] = [];
  if (worse.length)
    notes.push(
      `${worse.length} AI ${worse.length === 1 ? 'finding calls' : 'findings call'} damage new that the move-in already recorded; compare the photographs to see whether it got worse.`,
    );
  if (unexplained.length)
    notes.push(
      `${unexplained.length} AI ${unexplained.length === 1 ? 'finding suggests' : 'findings suggest'} new damage the checklist does not show.`,
    );
  const aiNote = notes.length ? notes.join(' ') : null;

  if (fresh.length) return { classification: 'NEW_DAMAGE', requiresReview: true, summary, aiNote };
  if (unknown.length || aiNote)
    return { classification: 'REQUIRES_REVIEW', requiresReview: true, summary, aiNote };
  // A category-only pairing is an inference about which room this is.
  if (weakMatch) return { classification: 'REQUIRES_REVIEW', requiresReview: true, summary, aiNote };
  if (repaired.length && !existing.length)
    return { classification: 'RESOLVED', requiresReview: false, summary, aiNote };
  return { classification: 'UNCHANGED', requiresReview: false, summary, aiNote };
}
