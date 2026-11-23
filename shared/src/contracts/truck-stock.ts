import { MOST_STOCK_QUANTITY } from './inventory.js';

/**
 * The truck on the phone, round 2 (the office, 2026-11-24, approved on the
 * Inventory Screens canvas). A technician sees what is on their truck and what
 * is running low, and asks the office for more. The phone still never moves
 * stock: an ask is only an ask, and the office fills it with a move from the
 * Storeroom on the console, as it moves stock today.
 *
 * "Running low" is below the level the office keeps on that truck for that
 * item ("keep at least", set on Places). Nothing here calls anything billed.
 */

/** An item the phone can name: for a search, and to tell a code that is no item from one that is not on the truck. */
export interface PhoneCatalogItem {
  itemId: string;
  code: string;
  name: string;
  unit: string;
}

/** The phone is handed at most this many items to search: an office's own list never comes near it. */
export const MOST_PHONE_CATALOG = 2000;

// ── Keep at least, per truck (the console's Places) ──────────────────────

/** The most one truck may be set to keep of an item. */
export const MOST_KEEP_AT_LEAST = 10_000;
/** The items one save may set: a truck holds far fewer kinds. */
export const MOST_KEEP_LEVELS = 300;

export interface TruckKeepLevel {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  /** Null when nothing is kept on this truck of it. */
  keepAtLeast: number | null;
  onHand: number;
}

/** A truck's keep levels, for the console: every item in use, those kept or held there first. */
export interface TruckKeepLevels {
  place: { id: string; name: string; code: string };
  levels: TruckKeepLevel[];
}

export interface SaveTruckKeepLevelsInput {
  /** Each item to set; `keepAtLeast` null or 0 keeps none of it there. Items not sent stay as they are. */
  levels: { itemId: string; keepAtLeast: number | null }[];
}

/** Below what the office keeps on the truck: the phone says it is running low and puts it on an ask. */
export function runningLow(item: { onHand: number; keepAtLeast: number | null }): boolean {
  return item.keepAtLeast !== null && item.keepAtLeast > 0 && item.onHand < item.keepAtLeast;
}

/** What to ask for to bring it back up to what is kept; none when it is not running low. */
export function askToKeep(item: { onHand: number; keepAtLeast: number | null }): number {
  return runningLow(item) ? item.keepAtLeast! - Math.max(0, item.onHand) : 0;
}

// ── Asks from the trucks ──────────────────────────────────────────────────

export const TRUCK_ASK_STATUSES = ['ASKED', 'FILLED'] as const;
export type TruckAskStatus = (typeof TRUCK_ASK_STATUSES)[number];
export const TRUCK_ASK_STATUS_LABEL: Record<TruckAskStatus, string> = { ASKED: 'Asked', FILLED: 'Filled' };

export const MOST_ASK_LINES = 50;
/** A truck waits on at most this many asks at once: more is one ask with more lines. */
export const MOST_OPEN_ASKS = 5;

export interface TruckAskLine {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  quantity: number;
}

export interface TruckAsk {
  id: string;
  place: { id: string; name: string };
  askedBy: { id: string; name: string };
  at: string;
  note: string | null;
  status: TruckAskStatus;
  lines: TruckAskLine[];
  /** The move that filled it, once the office posted it. */
  filled: { slipNumber: string; at: string; by: string } | null;
}

/** The console's asks: waiting ones oldest first, then the latest filled. */
export interface TruckAskList {
  asks: TruckAsk[];
}

/** Ask the office for more (the phone). Who asks comes from the sign-in, never the body. */
export interface AskForTruckStockInput {
  placeId: string;
  lines: { itemId: string; quantity: number }[];
  note: string | null;
  /** Made once by the phone for this ask, and kept with it until the server answers: sent again it asks once. */
  clientRequestId: string;
}

/** Why an ask cannot be sent yet, in the technician's words; null when it can. */
export function truckAskProblem(lines: readonly { quantity: number }[]): string | null {
  const asked = lines.filter((line) => line.quantity > 0);
  if (!asked.length) return 'Tick what you need, with how many.';
  if (asked.length > MOST_ASK_LINES) return `One ask holds at most ${MOST_ASK_LINES} items.`;
  if (asked.some((line) => !Number.isInteger(line.quantity) || line.quantity > MOST_STOCK_QUANTITY)) return 'Each number is a whole number of units.';
  return null;
}

// ── My truck, on the phone ────────────────────────────────────────────────

export interface MyTruckItem {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  onHand: number;
  keepAtLeast: number | null;
}

export interface MyTruck {
  id: string;
  name: string;
  /** The technician is named on it; false for a truck nobody is named on. */
  mine: boolean;
  /** The Texas day its last posted count was taken; null when it was never counted. */
  lastCountedOn: string | null;
  /** What is on it, and anything kept on it that has run out, by code. */
  items: MyTruckItem[];
  /** This technician's asks for it: waiting ones, then the latest filled. */
  asks: TruckAsk[];
}

export interface MyTruckSlip {
  id: string;
  number: string;
  kind: 'WITHDRAWAL' | 'RETURN';
  at: string;
  place: string;
  /** The job it was for: where. */
  job: { id: string; address: string | null } | null;
  lines: { code: string; name: string; quantity: number }[];
  reversed: boolean;
}

/** The phone's My truck: the trucks this technician may use, their own first, and their latest slips across jobs. */
export interface MyTrucks {
  trucks: MyTruck[];
  slips: MyTruckSlip[];
  /** Every item in use: an ask may be for one not on the truck, and a scan tells a code that is no item from one not on it. */
  catalog: PhoneCatalogItem[];
}

/** The latest slips My truck lists. */
export const MY_TRUCK_SLIPS = 10;
