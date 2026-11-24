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

export const STOCK_MOVEMENT_KINDS = ['OPENING_BALANCE', 'REVERSAL', 'RECEIPT', 'WITHDRAWAL', 'RETURN', 'TRANSFER', 'COUNT_ADJUSTMENT', 'REMOVAL'] as const;
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
 * A code the stock keeper types (2026-11-19): capitals, digits and dashes,
 * two to twenty-four of them, starting with a capital or a digit.
 * "FLT-16251", "BAT-9V".
 */
export const STOCK_CODE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;

/** A code as it is kept: capitals, with no spaces. */
export const normalizeStockCode = (value: string) => value.trim().toUpperCase().replace(/\s+/g, '');

/** The most an item's usual price may be: $100,000.00. */
export const MOST_ITEM_PRICE_CENTS = 10_000_000;

/**
 * The code the console suggests for an item (2026-11-19): its category's
 * prefix and the category's next number, at least four digits. "FLT-0012".
 * The stock keeper may type another over it; either way two items never
 * share a code.
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
  /** Its location code (2026-11-20): "STORE", "TRK-01". */
  code: string;
  kind: StockPlaceKind;
  /** A truck's technician; null for a storeroom, or a truck any technician may use. */
  technicianId: string | null;
  technicianName: string | null;
  /** How many different items it has any of now. */
  itemsHeld: number;
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
  /** Suggested by the console from the item's category, or typed by the stock keeper. */
  code: string;
  /** Its description: the name people see beside the code. */
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
  /** What it is on a line (2026-11-20): an Item that keeps stock, a Service that does not. */
  lineType: { id: string; code: string; name: string; keepsStock: boolean } | null;
  /** What one usually costs, when the stock keeper has said; a purchase request line starts from it. */
  priceCents: number | null;
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
  /** What an item can be on a line (2026-11-20): Item keeps stock, Service does not. */
  lineTypes: { id: string; code: string; name: string; keepsStock: boolean; active: boolean }[];
  /** The units an item is counted in, in use (Purchasing Setup, 2026-11-21); none yet, any word. */
  units?: { code: string; name: string }[];
  /** The code lists the caller makes and changes here, by the role Setup gives each (2026-11-21). */
  keeps?: { items: boolean; categories: boolean; places: boolean; vendors: boolean };
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
  /** Why a removal took it out (2026-11-24); null for every other kind. */
  removalReason: StockRemovalReason | null;
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
  /** Typed by the stock keeper; left out, the console gives the category's next number. */
  code?: string;
  name?: string;
  unit?: string;
  categoryId?: string;
  xeroTenantId?: string | null;
  reorderLevel?: number;
  reorderQuantity?: number;
  usualVendorId?: string | null;
  /** One of the office's line types. */
  lineTypeId?: string;
  /** What one usually costs; null for none. */
  priceCents?: number | null;
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

// ── Removing stock and deleting an item code (2026-11-24) ────────────────────

/** Why stock is taken off the books. Other is said in the note. */
export const STOCK_REMOVAL_REASONS = ['TESTING', 'DAMAGED', 'LOST', 'USED_NOT_RECORDED', 'ENTERED_BY_MISTAKE', 'OTHER'] as const;
export type StockRemovalReason = (typeof STOCK_REMOVAL_REASONS)[number];
export const STOCK_REMOVAL_REASON_LABEL: Record<StockRemovalReason, string> = {
  TESTING: 'Testing',
  DAMAGED: 'Damaged',
  LOST: 'Lost or stolen',
  USED_NOT_RECORDED: 'Used, not recorded on a job',
  ENTERED_BY_MISTAKE: 'Entered by mistake',
  OTHER: 'Other',
};

/**
 * Stock taken off the books from one place, or from every place at once
 * (placeId null), when it was tested with, damaged, lost or never there. It is
 * a movement like any other: it shows in the item's history, and Reverse puts
 * it back.
 */
export interface RemoveStockInput {
  /** The place it comes out of; null for every place, all of it. */
  placeId: string | null;
  /** How many, no more than the place holds; from every place, all of it. */
  quantity: number;
  reason: StockRemovalReason;
  /** Required for Other. */
  note?: string | null;
  /** Made once by the page for this removal, so a second click or a retry takes nothing twice. */
  requestKey: string;
}

/** Why an item code is deleted. Other is said in the note. */
export const STOCK_ITEM_DELETE_REASONS = ['TESTING', 'MADE_BY_MISTAKE', 'DUPLICATE', 'OTHER'] as const;
export type StockItemDeleteReason = (typeof STOCK_ITEM_DELETE_REASONS)[number];
export const STOCK_ITEM_DELETE_REASON_LABEL: Record<StockItemDeleteReason, string> = {
  TESTING: 'Testing',
  MADE_BY_MISTAKE: 'Made by mistake',
  DUPLICATE: 'A duplicate of another code',
  OTHER: 'Other',
};
/** The removal an item's own deletion makes of the stock it still has. */
export const REMOVAL_FOR_DELETE: Record<StockItemDeleteReason, StockRemovalReason> = {
  TESTING: 'TESTING',
  MADE_BY_MISTAKE: 'ENTERED_BY_MISTAKE',
  DUPLICATE: 'ENTERED_BY_MISTAKE',
  OTHER: 'OTHER',
};

/** A document that names an item: one still open stops its deletion. */
export interface StockItemDocument {
  kind: 'REQUISITION' | 'ORDER' | 'RECEIPT' | 'COUNT' | 'TRUCK_ASK';
  id: string;
  /** PR-00014, PO-00009, RCV-0003, CNT-0004; a truck ask is named by its truck. */
  number: string;
}

/** The documents named under "still shown, marked deleted": the rest are counted. */
export const DELETION_DOCUMENTS_SHOWN = 10;

/** What deleting an item would do, read before the office confirms it. */
export interface StockItemDeletion {
  item: { id: string; code: string; name: string; unit: string };
  /** Nothing names it: it is removed outright. */
  neverUsed: boolean;
  /** Where it still has stock: removed first, with the reason given. */
  onHand: { placeName: string; quantity: number }[];
  /** Still open, so it cannot be deleted yet: finish or cancel these first. */
  open: StockItemDocument[];
  /** Closed documents that keep showing it, marked deleted (the first DELETION_DOCUMENTS_SHOWN). */
  usedOn: StockItemDocument[];
  /** How many more closed documents name it than are listed. */
  usedOnMore: number;
}

export interface DeleteStockItemInput {
  reason: StockItemDeleteReason;
  /** Required for Other. */
  note?: string | null;
  /** The item's code, typed to confirm. */
  confirmCode: string;
}

/** A deleted item's name where a document still shows it. */
export const deletedItemName = (name: string) => `${name} (deleted)`;

export interface StockPlaces {
  places: StockPlaceRow[];
  technicians: { id: string; name: string }[];
}

/** What the office calls each kind of place (2026-11-19: a van is "the truck" to this office). The stored value stays VAN. */
export const STOCK_PLACE_KIND_LABEL: Record<StockPlaceKind, string> = { STOCKROOM: 'Storeroom', VAN: 'Truck' };

export interface SaveStockPlaceInput {
  name?: string;
  /** Left out on a new place, the console makes one from its name. */
  code?: string;
  kind?: StockPlaceKind;
  technicianId?: string | null;
  active?: boolean;
}

export interface VendorRow {
  id: string;
  /** "V-00003", given by the console (2026-11-20). */
  number: string;
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
