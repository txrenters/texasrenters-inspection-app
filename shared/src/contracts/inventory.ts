/**
 * Inventory (2026-11-19, phase 1 of the inventory and purchasing plan): what
 * the office stocks, where it is kept, who it is bought from, and the stock
 * ledger.
 *
 * On hand is never typed. Every change to stock is one movement, written once
 * and never edited, and on hand is the sum of the movements. A mistake is put
 * right by a second movement that reverses the first. This phase has two kinds
 * of movement: the opening balance that brings in what is on the shelf today,
 * and its reversal. Receiving, withdrawals and counts add their own kinds in
 * later phases.
 *
 * Quantities are whole units of whatever the item is counted in (each, box,
 * jug). Money is cents. Nothing here calls anything billed.
 */

export const STOCK_PLACE_KINDS = ['STOCKROOM', 'VAN'] as const;
export type StockPlaceKind = (typeof STOCK_PLACE_KINDS)[number];

export const STOCK_MOVEMENT_KINDS = ['OPENING_BALANCE', 'REVERSAL', 'RECEIPT', 'WITHDRAWAL', 'RETURN', 'TRANSFER'] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/** A typo of extra zeros stops here; no shelf in the office holds this many of anything. */
export const MOST_STOCK_QUANTITY = 100_000;
/** $100,000.00 for one unit: far past anything stocked, and still inside an integer once multiplied by a quantity. */
export const MOST_UNIT_COST_CENTS = 10_000_000;
/** The movements an item's page shows, newest first. */
export const STOCK_MOVEMENTS_SHOWN = 200;

/**
 * A category's prefix, which starts every code of its items: a letter, then
 * one to five letters or digits. "FLT", "PST".
 */
export const STOCK_PREFIX = /^[A-Z][A-Z0-9]{1,5}$/;

/**
 * An item's code (2026-11-19): its category's prefix and the category's next
 * number, at least four digits. "FLT-0012". The console gives it; nobody
 * types one, so two items never share a code and none is misspelled.
 */
export function stockCode(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, '0')}`;
}

/** One entry per code or name, whatever its case or spacing. */
export function stockKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export type StockStatus = 'ENOUGH' | 'LOW' | 'OUT';

/**
 * Out at nothing; low at or below the reorder level, as the office set it; else
 * enough. An item with no reorder level (0) is never low, only out.
 */
export function stockStatus(onHand: number, reorderLevel: number): StockStatus {
  if (onHand <= 0) return 'OUT';
  return reorderLevel > 0 && onHand <= reorderLevel ? 'LOW' : 'ENOUGH';
}

/** What one unit on the shelf cost on average; null with nothing on hand. */
export function averageCostCents(valueCents: number, onHand: number): number | null {
  return onHand > 0 ? Math.round(valueCents / onHand) : null;
}

/** A company's books, as the invoices know them: its Xero organisation. */
export interface StockCompany {
  tenantId: string;
  name: string;
}

export interface StockPlaceRow {
  id: string;
  name: string;
  kind: StockPlaceKind;
  /** A van's technician; null for the stockroom or a van nobody drives yet. */
  technicianId: string | null;
  technicianName: string | null;
  active: boolean;
}

/** A kind of stock, whose prefix starts its items' codes. */
export interface StockCategoryRow {
  id: string;
  name: string;
  prefix: string;
  /** The code its next item will be given. */
  nextCode: string;
  itemCount: number;
  active: boolean;
}

export interface StockItemRow {
  id: string;
  /** Given by the console from the item's category when it is added; never changed. */
  code: string;
  name: string;
  /** What it is counted in: "each", "box", "jug". */
  unit: string;
  /** Null only for an item added before categories gave the codes. */
  category: { id: string; name: string } | null;
  /** The company whose books it belongs to; null until the office chooses. */
  company: StockCompany | null;
  reorderLevel: number;
  reorderQuantity: number;
  usualVendor: { id: string; name: string } | null;
  active: boolean;
  onHand: number;
  inStockrooms: number;
  inVans: number;
  /** What is on hand, at what it cost. */
  valueCents: number;
  status: StockStatus;
}

/** The Stock tab: every item with what is on hand, and what its filters and forms choose from. */
export interface StockList {
  items: StockItemRow[];
  places: StockPlaceRow[];
  companies: StockCompany[];
  vendors: { id: string; name: string }[];
  categories: StockCategoryRow[];
}

/** A new category needs its name and prefix. The prefix can change only until it has numbered an item. */
export interface SaveStockCategoryInput {
  name?: string;
  prefix?: string;
  active?: boolean;
}

export interface StockLevelRow {
  placeId: string;
  placeName: string;
  kind: StockPlaceKind;
  quantity: number;
}

export interface StockMovementRow {
  id: string;
  kind: StockMovementKind;
  /** The Texas day it happened, YYYY-MM-DD. */
  day: string;
  placeId: string;
  placeName: string;
  /** In is positive, out is negative. */
  quantity: number;
  unitCostCents: number;
  /** The item's on hand, everywhere, once this movement was written. */
  onHandAfter: number;
  note: string | null;
  by: string;
  createdAt: string;
  /** The movement this one reverses; null unless it is a reversal. */
  reversesId: string | null;
  /** Set once it has been reversed: it cannot be reversed twice. */
  reversedById: string | null;
}

export interface StockItemDetail {
  item: StockItemRow;
  levels: StockLevelRow[];
  averageCostCents: number | null;
  /** Newest first, at most STOCK_MOVEMENTS_SHOWN. */
  movements: StockMovementRow[];
  movementsTotal: number;
}

/**
 * A new item needs its name and its category, which gives it its code; a
 * change sends only what changed. The code is never sent, and the category is
 * fixed once the item has one.
 */
export interface SaveStockItemInput {
  name?: string;
  unit?: string;
  categoryId?: string;
  xeroTenantId?: string | null;
  reorderLevel?: number;
  reorderQuantity?: number;
  usualVendorId?: string | null;
  active?: boolean;
}

/** What is on the shelf the day the console takes stock over. */
export interface OpeningBalanceInput {
  placeId: string;
  quantity: number;
  unitCostCents: number;
  /** The Texas day it is as of; today when left out. */
  day?: string;
  note?: string | null;
  /** Made once by the page for this entry, so a second click or a retry writes nothing twice. */
  requestKey: string;
}

export interface ReverseMovementInput {
  /** Why: kept on the reversal and in the audit log. */
  reason: string;
}

export interface StockPlaces {
  places: StockPlaceRow[];
  technicians: { id: string; name: string }[];
}

export interface SaveStockPlaceInput {
  name?: string;
  kind?: StockPlaceKind;
  technicianId?: string | null;
  active?: boolean;
}

export interface VendorRow {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  /** Payment terms as the office writes them: "Net 30". */
  terms: string | null;
  notes: string | null;
  active: boolean;
}

export interface Vendors {
  vendors: VendorRow[];
}

export interface SaveVendorInput {
  name?: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  terms?: string | null;
  notes?: string | null;
  active?: boolean;
}

/** The figures above the Stock tab, from the rows it already has. Inactive items are not counted. */
export function stockSummary(items: readonly Pick<StockItemRow, 'active' | 'status' | 'valueCents'>[]) {
  const active = items.filter((item) => item.active);
  return {
    items: active.length,
    lowOrOut: active.filter((item) => item.status !== 'ENOUGH').length,
    valueCents: active.reduce((sum, item) => sum + item.valueCents, 0),
  };
}
