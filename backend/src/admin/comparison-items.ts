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
  /**
   * The office confirmed it from the recording (APPROVED -- an edit is stored
   * as an approval too). Only a confirmed finding moves a verdict: the same
   * rule that decides whether the report prints it.
   */
  confirmed: boolean;
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

/**
 * What a room's verdict can be. There is no "requires review": the office
 * reviews the recordings and confirms the findings, and the report is drawn
 * from that and from the technician's checklist (the office, 2026-10-07: the
 * maintenance admin "will not going to mark review every everything that was
 * recorded"). Where the record cannot say whether damage is new, the verdict
 * says exactly that -- NOT_COMPARABLE -- rather than waiting on a person.
 */
export type RoomVerdict = 'NEW_DAMAGE' | 'WORSENED' | 'NOT_COMPARABLE' | 'UNCHANGED' | 'RESOLVED';

export type ItemVerdict = {
  classification: RoomVerdict;
  /**
   * The technician's checklist, and the findings the office confirmed, in
   * words. Printed on the comparison report, which may reach a tenant, so it
   * never repeats an AI finding nobody has confirmed.
   */
  summary: string;
  /**
   * What the office confirmed from the recording as new or worse, by title --
   * listed on the report beside the checklist's new items, since no item
   * carries it.
   */
  fromRecording: string[];
  /** For the console only: AI findings here still waiting to be confirmed. */
  aiNote: string | null;
};

/** The titles of the findings of new damage the office confirmed. */
export function confirmedNewDamage(findings: FindingSignal[]) {
  return findings
    .filter((finding) => finding.confirmed && possiblyNew(finding))
    .map((finding) => finding.title);
}

/**
 * The AI's findings of new damage in a room that the office has not yet
 * confirmed or rejected, said for the console. They are not on the report and
 * move no verdict until confirmed; confirming one refreshes the comparison.
 */
export function waitingNote(findings: FindingSignal[]) {
  const waiting = findings.filter((finding) => !finding.confirmed && possiblyNew(finding)).length;
  if (!waiting) return null;
  return waiting === 1
    ? '1 AI finding of new damage here is waiting to be confirmed from the recording; it joins the report once confirmed.'
    : `${waiting} AI findings of new damage here are waiting to be confirmed from the recording; they join the report once confirmed.`;
}

/**
 * One room's verdict from its items, or null when the two inspections have no
 * item both graded for damage -- then there is nothing to compare item by item
 * and the caller falls back to counting defects.
 *
 * `findings` are the move-out's, never the rejected ones. A confirmed finding
 * of new damage is new damage, whatever the checklist shows -- the office saw
 * it on the recording -- and on an item the move-in already had damaged it is
 * the item getting worse. An unconfirmed one moves nothing.
 */
export function itemVerdict(items: ComparedItem[], findings: FindingSignal[]): ItemVerdict | null {
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

  // What the office confirmed from the recording, against the item each is
  // about. A finding on an item the checklist already calls new adds nothing.
  const onItem = (finding: FindingSignal) =>
    items.find((item) => findingMatchesChecklistItem(finding, item));
  const confirmed = findings.filter((finding) => finding.confirmed && possiblyNew(finding));
  const worse = confirmed.filter((finding) => onItem(finding)?.change === 'ALREADY_DAMAGED');
  const beyondChecklist = confirmed.filter((finding) => {
    const change = onItem(finding)?.change;
    return change !== 'ALREADY_DAMAGED' && change !== 'NEW_DAMAGE';
  });
  const titles = (list: FindingSignal[]) => nameList(list.map((finding) => finding.title));

  const sentences: string[] = [];
  if (fresh.length) sentences.push(`New since move-in: ${nameList(fresh)}.`);
  if (beyondChecklist.length)
    sentences.push(`Confirmed from the move-out recording: ${titles(beyondChecklist)}.`);
  if (worse.length)
    sentences.push(`Worse than at move-in, confirmed from the move-out recording: ${titles(worse)}.`);
  if (unknown.length)
    sentences.push(`Damaged at move-out, but not graded at move-in: ${nameList(unknown)}.`);
  if (existing.length) sentences.push(`Already damaged at move-in: ${nameList(existing)}.`);
  if (repaired.length)
    sentences.push(`Damaged at move-in, not at move-out: ${nameList(repaired)}.`);
  if (sentences.length === 0)
    sentences.push('No change in condition on any item graded at both inspections.');
  if (cleaning.length) sentences.push(`Needs cleaning: ${nameList(cleaning)}.`);
  const verdict = (classification: RoomVerdict): ItemVerdict => ({
    classification,
    summary: sentences.join(' '),
    fromRecording: [...beyondChecklist, ...worse].map((finding) => finding.title),
    aiNote: waitingNote(findings),
  });

  if (fresh.length || beyondChecklist.length) return verdict('NEW_DAMAGE');
  if (worse.length) return verdict('WORSENED');
  if (unknown.length) return verdict('NOT_COMPARABLE');
  if (repaired.length && !existing.length) return verdict('RESOLVED');
  return verdict('UNCHANGED');
}
