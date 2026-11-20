import { normalizeStockCode } from './inventory.js';

/**
 * The codes a NAV-style purchase requisition picks from (2026-11-20, part 1
 * of the requisition the office approved). Short lists the office makes:
 * line types, request codes, department codes and cost center codes; plus a
 * purchaser code for each company, a location code for each place and a
 * number for each vendor.
 *
 * Department and cost center codes are made in the console. Each can be
 * matched, company by company, to a tracking option in that company's Xero,
 * read from the catalog the console already keeps: nothing calls Xero here.
 */

export const PURCHASING_CODE_KINDS = ['LINE_TYPE', 'UNIT', 'REQUEST', 'DEPARTMENT', 'COST_CENTER'] as const;
export type PurchasingCodeKind = (typeof PURCHASING_CODE_KINDS)[number];

export const PURCHASING_CODE_KIND_LABEL: Record<PurchasingCodeKind, string> = {
  LINE_TYPE: 'Line types',
  UNIT: 'Units of measure',
  REQUEST: 'Request codes',
  DEPARTMENT: 'Department codes',
  COST_CENTER: 'Cost center codes',
};

/** What each list is for, as its tab says it. */
export const PURCHASING_CODE_KIND_ABOUT: Record<PurchasingCodeKind, string> = {
  LINE_TYPE: 'What a line is. An item code belongs to one type; a type that keeps no stock is never received into a place, counted or withdrawn.',
  UNIT: 'What an item is counted in: EA "each", PK "pack", JOB "job". An item code picks one, by its name (Purchasing Setup, 2026-11-21).',
  REQUEST: 'The kind of request, picked on each requisition: RESTOCK, JOB, URGENT.',
  DEPARTMENT: 'The department each requisition line is for. Match it to a Xero tracking option so the bill reaches Xero coded.',
  COST_CENTER: 'The cost center a requisition is for. Match it to a Xero tracking option so the bill reaches Xero coded.',
};

/** The kinds a Xero tracking option can be matched to. */
export const TRACKED_CODE_KINDS: readonly PurchasingCodeKind[] = ['DEPARTMENT', 'COST_CENTER'];

/** A code, a location code or a purchaser code: 1 to 20 capitals, digits and dashes, starting with a letter or digit. */
export const PURCHASING_CODE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
export const MOST_PURCHASING_CODE_NAME = 120;

/** A code as it is kept: capitals, with no spaces. */
export const normalizePurchasingCode = normalizeStockCode;

/** Why a typed code cannot be kept, or null. */
export function purchasingCodeProblem(typed: string): string | null {
  const code = normalizePurchasingCode(typed);
  if (!code) return 'Give it a code.';
  if (!PURCHASING_CODE.test(code)) return 'A code is 1 to 20 capitals, digits and dashes, like RESTOCK or TRK-01.';
  return null;
}

/** The location code the console suggests for a place's name: "Office Storeroom" -> OFFICE-STOREROOM. */
export function suggestedPlaceCode(name: string): string {
  const stem = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
  return stem || 'PLACE';
}

/** "V-00003": the vendor number the console gives. */
export const vendorNumber = (sequence: number) => `V-${String(sequence).padStart(5, '0')}`;

export interface XeroOptionMatch {
  xeroTenantId: string;
  trackingCategoryId: string;
  trackingOptionId: string;
}

export interface PurchasingCodeRow {
  id: string;
  kind: PurchasingCodeKind;
  code: string;
  name: string;
  /** Line types only. */
  keepsStock: boolean;
  active: boolean;
  /** Department and cost center codes: the tracking option each company knows it by. */
  xero: (XeroOptionMatch & { label: string })[];
  /** How many item codes are of this type (line types), so a type in use is not switched off by surprise. */
  used: number;
}

export interface PurchasingCompanyRow {
  xeroTenantId: string;
  name: string;
  purchaserCode: string | null;
  /** The company's tracking categories, as the console last read them from Xero. */
  trackingCategories: { id: string; name: string; options: { id: string; name: string }[] }[];
}

export interface PurchasingCodes {
  codes: PurchasingCodeRow[];
  companies: PurchasingCompanyRow[];
  /** The lists the caller makes and changes here, by the role Purchasing Setup gives each (2026-11-21). */
  keeps?: Record<PurchasingCodeKind | 'PURCHASER_CODES', boolean>;
}

/** The Setup code list each kind of purchasing code is. */
export const CODE_LIST_OF_KIND = { LINE_TYPE: 'LINE_TYPES', UNIT: 'UNITS', REQUEST: 'REQUEST', DEPARTMENT: 'DEPARTMENT', COST_CENTER: 'COST_CENTER' } as const satisfies Record<PurchasingCodeKind, string>;

export interface SavePurchasingCodeInput {
  kind?: PurchasingCodeKind;
  code?: string;
  name?: string;
  keepsStock?: boolean;
  active?: boolean;
  /** Sent whole: what each company knows it by. Department and cost center codes only. */
  xero?: XeroOptionMatch[];
}

export interface SavePurchaserCodeInput {
  /** Null takes it away. */
  purchaserCode: string | null;
}
