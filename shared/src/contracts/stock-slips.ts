import type { StockPlaceKind } from './inventory.js';

/**
 * Withdrawals, returns and moves (2026-11-19, phase 5 of the inventory and
 * purchasing plan). A slip is the paper for stock leaving a place, coming
 * back, or going from one place to another: who took it, from where, for
 * which visit. Posting it writes the stock movements; it is never edited,
 * only reversed.
 *
 * In this phase the office records them. Stock goes out at what it cost on
 * average, so what a visit used is known in money as well as in units.
 * Nobody takes out more than is there. Nothing here calls anything billed.
 */

export const STOCK_SLIP_KINDS = ['WITHDRAWAL', 'RETURN', 'TRANSFER'] as const;
export type StockSlipKind = (typeof STOCK_SLIP_KINDS)[number];

export const STOCK_SLIP_KIND_LABEL: Record<StockSlipKind, string> = {
  WITHDRAWAL: 'Withdrawal',
  RETURN: 'Return',
  TRANSFER: 'Move',
};

/** Each kind has its own series: WD-0031, RT-0004, TR-0012. */
const PREFIX: Record<StockSlipKind, string> = { WITHDRAWAL: 'WD', RETURN: 'RT', TRANSFER: 'TR' };
export const stockSlipSeries = (kind: StockSlipKind) => PREFIX[kind] as 'WD' | 'RT' | 'TR';

export function stockSlipNumber(kind: StockSlipKind, sequence: number): string {
  return `${PREFIX[kind]}-${String(sequence).padStart(4, '0')}`;
}

/** The lines a slip may hold at most: more is a count, not a slip. */
export const MOST_SLIP_LINES = 50;
/** The slips the Withdrawals tab lists, newest first. */
export const STOCK_SLIPS_SHOWN = 100;

export interface PostStockSlipInput {
  kind: StockSlipKind;
  /** Who took it or brought it back. A move between places has nobody. */
  technicianId: string | null;
  /** Where it leaves: a withdrawal's and a move's. */
  fromPlaceId: string | null;
  /** Where it goes: a return's and a move's. */
  toPlaceId: string | null;
  /** The visit it was used on, or brought back from; null for a van restock or office use. */
  inspectionId: string | null;
  note: string | null;
  /** Made once by the page for this slip, so a second click or a retry posts nothing twice. */
  requestKey: string;
  lines: { itemId: string; quantity: number }[];
}

export interface ReverseStockSlipInput {
  reason: string;
}

/**
 * Why a slip cannot be posted yet, in the office's words; null when it can.
 * `onHand` is what is in the place it leaves, by item. The page says this
 * before the button is pressed and the server refuses with the same sentence.
 */
export function stockSlipProblem(
  slip: Pick<PostStockSlipInput, 'kind' | 'technicianId' | 'fromPlaceId' | 'toPlaceId' | 'lines'>,
  onHand: ReadonlyMap<string, number>,
  name: (itemId: string) => string,
): string | null {
  if (slip.kind !== 'TRANSFER' && !slip.technicianId) return slip.kind === 'RETURN' ? 'Say who is bringing it back.' : 'Say who is taking it.';
  if (slip.kind !== 'RETURN' && !slip.fromPlaceId) return 'Choose where it is taken from.';
  if (slip.kind !== 'WITHDRAWAL' && !slip.toPlaceId) return 'Choose where it goes.';
  if (slip.kind === 'TRANSFER' && slip.fromPlaceId === slip.toPlaceId) return 'Choose two different places.';
  if (!slip.lines.length) return 'Add at least one item.';
  if (slip.kind === 'RETURN') return null;
  for (const line of slip.lines) {
    const there = onHand.get(line.itemId) ?? 0;
    if (line.quantity > there) return there ? `Only ${there} of ${name(line.itemId)} ${there === 1 ? 'is' : 'are'} there.` : `None of ${name(line.itemId)} is there.`;
  }
  return null;
}

export interface StockSlipRow {
  id: string;
  number: string;
  kind: StockSlipKind;
  /** The Texas day it happened. */
  day: string;
  technician: { id: string; name: string } | null;
  from: { id: string; name: string } | null;
  to: { id: string; name: string } | null;
  /** The visit it was for: what kind, and where. */
  visit: { id: string; title: string; address: string | null } | null;
  note: string | null;
  lines: { itemCode: string; itemName: string; quantity: number; unitCostCents: number }[];
  /** What it took out, or brought back, at cost. */
  costCents: number;
  by: string;
  at: string;
  reversed: { by: string; at: string; reason: string } | null;
}

export interface StockSlipList {
  slips: StockSlipRow[];
}

/** What the slip form chooses from, and what is where. Read when the tab opens and when the technician or the day changes. */
export interface StockSlipChoices {
  technicians: { id: string; name: string }[];
  places: { id: string; name: string; kind: StockPlaceKind; technicianId: string | null }[];
  items: { id: string; code: string; name: string; unit: string }[];
  /** On hand of each item in each place; a pair that is not listed has none. */
  levels: { itemId: string; placeId: string; quantity: number }[];
  /** The chosen technician's visits for the day; empty with no technician. */
  visits: { id: string; title: string; address: string | null }[];
  /** The Texas day the visits are for. */
  day: string;
}
