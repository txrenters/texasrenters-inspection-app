/**
 * The console's search for everything (Ctrl K): one question, answered with a
 * few records of every kind the account may read.
 *
 * The office (2026-11-24): the search found inspections, properties and
 * technicians and nothing added since -- not an invoice by its number, a
 * requisition, a purchase order or a stock item.
 */

/** The kinds of record the search finds, in the order the answer lists them. */
export const SEARCH_KINDS = [
  'inspection',
  'job',
  'property',
  'tenant',
  'invoice',
  'payment',
  'requisition',
  'purchaseOrder',
  'stockItem',
  'vendor',
  'technician',
  'user',
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** How many of each kind are returned: enough to pick from. */
export const SEARCH_HITS_PER_KIND = 5;
/** Fewer letters than this match too much to be worth asking for. */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 120;

export interface SearchHit {
  /** The record found. */
  id: string;
  /**
   * The record its page is of, when the hit has no page of its own: a tenant
   * opens their property. Null where there is nothing to open but the list.
   */
  targetId: string | null;
  title: string;
  /** The second line: what tells this one from the others like it. */
  detail: string;
}

export interface SearchGroup {
  kind: SearchKind;
  hits: SearchHit[];
}

/** Only the kinds with something found, and only those the account may read. */
export interface SearchResults {
  groups: SearchGroup[];
}
