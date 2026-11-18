/**
 * Inventory counts (2026-11-19, phase 6 of the inventory and purchasing
 * plan): monthly, quarterly and yearly. Somebody counts what is on the shelf
 * without being shown what the console expects; the differences are reviewed
 * by somebody else, each with a reason, and posting writes one adjustment
 * movement an item that differed.
 *
 * - Monthly: the items chosen for it (the fast movers), in one place.
 * - Quarterly: everything in one place.
 * - Yearly: everything, everywhere. Stock does not move while it is open.
 *
 * A difference worth more than `RECOUNT_OVER_CENTS` is counted a second time
 * before anybody may approve it. The person who counted never approves, and
 * is never shown the expected numbers while the count is open. Nothing here
 * calls anything billed.
 */

export const STOCK_COUNT_KINDS = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type StockCountKind = (typeof STOCK_COUNT_KINDS)[number];

export const STOCK_COUNT_KIND_LABEL: Record<StockCountKind, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', YEARLY: 'Yearly' };
export const STOCK_COUNT_COVERS: Record<StockCountKind, string> = {
  MONTHLY: 'The fast movers, in one place',
  QUARTERLY: 'Everything in one place',
  YEARLY: 'Everything, everywhere. Stock is frozen',
};

export const STOCK_COUNT_STATUSES = ['OPEN', 'COUNTING', 'REVIEW', 'POSTED', 'CANCELLED'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];
export const STOCK_COUNT_STATUS_LABEL: Record<StockCountStatus, string> = {
  OPEN: 'Open',
  COUNTING: 'Counting',
  REVIEW: 'Review differences',
  POSTED: 'Posted',
  CANCELLED: 'Cancelled',
};
/** A count that is not finished: it holds its place, and a yearly one holds all stock still. */
export const STOCK_COUNT_OPEN_STATUSES: readonly StockCountStatus[] = ['OPEN', 'COUNTING', 'REVIEW'];

export const STOCK_COUNT_REASONS = ['TAKEN_WITHOUT_WITHDRAWAL', 'RETURNED_WITHOUT_RETURN', 'DAMAGED', 'MISCOUNTED_BEFORE', 'NOT_KNOWN'] as const;
export type StockCountReason = (typeof STOCK_COUNT_REASONS)[number];
export const STOCK_COUNT_REASON_LABEL: Record<StockCountReason, string> = {
  TAKEN_WITHOUT_WITHDRAWAL: 'Taken without a withdrawal',
  RETURNED_WITHOUT_RETURN: 'Returned without a return',
  DAMAGED: 'Damaged',
  MISCOUNTED_BEFORE: 'Miscounted before',
  NOT_KNOWN: 'Not known',
};
/** The reasons that fit a difference: nothing short was "returned", nothing over was "taken" or "damaged". */
export function stockCountReasonsFor(difference: number): StockCountReason[] {
  return difference < 0 ? ['TAKEN_WITHOUT_WITHDRAWAL', 'DAMAGED', 'MISCOUNTED_BEFORE', 'NOT_KNOWN'] : ['RETURNED_WITHOUT_RETURN', 'MISCOUNTED_BEFORE', 'NOT_KNOWN'];
}

/** A difference worth more than this, either way, is counted a second time before it can be approved. */
export const RECOUNT_OVER_CENTS = 2500;
/** The lines one count may hold. A yearly count of a few hundred items in a dozen places stays well under it. */
export const MOST_COUNT_LINES = 5000;
/** The counts the Counts tab lists, newest first. */
export const STOCK_COUNTS_SHOWN = 60;

export const stockCountNumber = (sequence: number) => `CNT-${String(sequence).padStart(4, '0')}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Monthly count, November 2026", "Quarterly count, Q4 2026", "Yearly count, 2026": named for the Texas day it was started. */
export function stockCountTitle(kind: StockCountKind, day: string): string {
  const year = day.slice(0, 4);
  const month = Number(day.slice(5, 7));
  if (kind === 'MONTHLY') return `Monthly count, ${MONTHS[month - 1]} ${year}`;
  if (kind === 'QUARTERLY') return `Quarterly count, Q${Math.ceil(month / 3)} ${year}`;
  return `Yearly count, ${year}`;
}

/** The day a count of this kind is next due: the last day of the month, the quarter or the year `day` is in. */
export function stockCountDue(kind: StockCountKind, day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const last = kind === 'MONTHLY' ? month : kind === 'QUARTERLY' ? Math.ceil(month / 3) * 3 : 12;
  // Day 0 of the month after is the last day of this one.
  return new Date(Date.UTC(year, last, 0)).toISOString().slice(0, 10);
}

/** Whether a count started on `startedOn` is the one for the month, quarter or year that `day` is in. */
export function stockCountCoversPeriod(kind: StockCountKind, startedOn: string, day: string): boolean {
  return stockCountDue(kind, startedOn) === stockCountDue(kind, day);
}

/** What a difference is worth, and whether it has to be counted again before anybody approves it. */
export function stockCountDifference(expected: number, counted: number, unitCostCents: number): { difference: number; valueCents: number; needsRecount: boolean } {
  const difference = counted - expected;
  const valueCents = difference * unitCostCents;
  return { difference, valueCents, needsRecount: Math.abs(valueCents) > RECOUNT_OVER_CENTS };
}

export interface StartStockCountInput {
  kind: StockCountKind;
  /** The place counted; null for a yearly count, which is everywhere. */
  placeId: string | null;
  /** A monthly count's items. Ignored for the others, which take everything. */
  itemIds: string[];
  note: string | null;
  /** Made once by the page, so a second click or a retry starts one count. */
  requestKey: string;
}

/** What was counted, a line. Null is "not counted yet". */
export interface SaveStockCountInput {
  lines: { lineId: string; counted: number | null }[];
}

export interface PostStockCountInput {
  /** Why each line that differed did. */
  reasons: { lineId: string; reason: StockCountReason }[];
}

export interface CancelStockCountInput {
  reason: string;
}

export interface StockCountLineRow {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  place: { id: string; name: string };
  /** Null while it waits to be counted, or counted again. */
  counted: number | null;
  /** Not handed in yet: the counter may still type it. Says nothing of what was expected. */
  waiting: boolean;
  /** A second count was asked for. */
  recount: boolean;
  /** What the console expected when the count was handed in. Null while hidden: always for the person counting until it is posted. */
  expected: number | null;
  difference: number | null;
  valueCents: number | null;
  reason: StockCountReason | null;
}

export interface StockCountSummary {
  id: string;
  number: string;
  kind: StockCountKind;
  title: string;
  status: StockCountStatus;
  place: { id: string; name: string } | null;
  /** The Texas day it was started. */
  day: string;
  lines: number;
  counted: number;
  countedBy: string | null;
  /** What posting it changed, at cost; null until it is posted. */
  netValueCents: number | null;
}

export interface StockCountDetail extends StockCountSummary {
  note: string | null;
  startedBy: string;
  startedAt: string;
  submittedAt: string | null;
  approvedBy: string | null;
  postedAt: string | null;
  cancelled: { by: string; at: string; reason: string } | null;
  /** True when the expected numbers are shown to this person. */
  reviewing: boolean;
  /** Lines that matched, and that differed; null while the expected numbers are hidden. */
  matched: number | null;
  different: number | null;
  rows: StockCountLineRow[];
  /** What this person may do now. */
  can: { count: boolean; recount: boolean; post: boolean; cancel: boolean };
}

export interface StockCountScheduleRow {
  kind: StockCountKind;
  /** The day the next one is due. */
  due: string;
  /** This period's count, when it has been started. */
  current: { id: string; number: string; status: StockCountStatus } | null;
  /** The last one posted, whenever it was. */
  lastPosted: { number: string; day: string } | null;
}

export interface StockCountList {
  counts: StockCountSummary[];
  schedule: StockCountScheduleRow[];
}

/** What the "Start a count" form chooses from. */
export interface StockCountChoices {
  places: { id: string; name: string }[];
  items: { id: string; code: string; name: string }[];
  /** What has been taken out of each place in the last 90 days, most first: a monthly count's suggestion. */
  fastMovers: { placeId: string; itemId: string }[];
}

/** Why a count cannot be started, in the office's words; null when it can. */
export function startStockCountProblem(input: Pick<StartStockCountInput, 'kind' | 'placeId' | 'itemIds'>): string | null {
  if (input.kind !== 'YEARLY' && !input.placeId) return 'Choose the place to count.';
  if (input.kind === 'MONTHLY' && !input.itemIds.length) return 'Choose at least one item to count.';
  return null;
}
