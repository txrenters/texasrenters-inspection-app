/**
 * Purchasing (2026-11-19, phase 2 of the inventory and purchasing plan): the
 * purchase requisition. Somebody asks for stock and says why; somebody else
 * approves it, sends it back with a note, or rejects it. An approved
 * requisition becomes a purchase order in phase 3.
 *
 * A requisition moves no stock and spends no money. It gets its number
 * (PR-0001) when it is first submitted, and its lines are fixed from then
 * unless the approver sends it back. Whoever asked can never approve their
 * own. Money is cents; quantities are whole units. Nothing here calls
 * anything billed.
 */

export const REQUISITION_STATUSES = ['DRAFT', 'SUBMITTED', 'SENT_BACK', 'APPROVED', 'ORDERED', 'REJECTED', 'CANCELLED'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

/** As the office reads them. */
export const REQUISITION_STATUS_LABEL: Record<RequisitionStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for approval',
  SENT_BACK: 'Sent back',
  APPROVED: 'Approved',
  ORDERED: 'Ordered',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

/** Still being worked on by somebody: the list's "open". */
export const OPEN_REQUISITION_STATUSES: readonly RequisitionStatus[] = ['DRAFT', 'SUBMITTED', 'SENT_BACK', 'APPROVED'];
/** The requester may change it: before it is submitted, and when it is sent back. */
export const EDITABLE_REQUISITION_STATUSES: readonly RequisitionStatus[] = ['DRAFT', 'SENT_BACK'];

export const MOST_REQUISITION_LINES = 100;
export const MOST_REQUISITION_QUOTES = 10;
/** What the office starts with: a manager approves up to $500.00, and above it two quotes are needed. */
export const DEFAULT_APPROVAL_LIMIT_CENTS = 50_000;
export const DEFAULT_QUOTES_ABOVE_LIMIT = 2;

/** "PR-0012": at least four digits, more when the office gets there. */
export function requisitionNumber(sequence: number): string {
  return `PR-${String(sequence).padStart(4, '0')}`;
}

export function requisitionTotalCents(lines: readonly { quantity: number; estimatedUnitCostCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.estimatedUnitCostCents, 0);
}

export interface PurchasingSettings {
  /** At or under this a holder of "Approve requisitions" approves; above it, only "Approve any amount". */
  approvalLimitCents: number;
  /** How many quotes a requisition above the limit needs before it can be submitted. */
  quotesAboveLimit: number;
}

export type SavePurchasingSettingsInput = PurchasingSettings;

/**
 * Why a requisition cannot be submitted yet, in the office's words; null when
 * it can. The page says it before the button is pressed and the server
 * refuses with the same sentence.
 */
export function requisitionSubmitProblem(
  requisition: { reason: string; lines: readonly { quantity: number; estimatedUnitCostCents: number }[]; quotes: readonly { chosen: boolean }[] },
  settings: PurchasingSettings,
): string | null {
  if (!requisition.reason.trim()) return 'Say why it is needed.';
  if (!requisition.lines.length) return 'Add at least one item.';
  const chosen = requisition.quotes.filter((quote) => quote.chosen).length;
  if (requisition.quotes.length && chosen !== 1) return 'Mark one quote as the chosen one.';
  const over = requisitionTotalCents(requisition.lines) > settings.approvalLimitCents;
  if (over && requisition.quotes.length < settings.quotesAboveLimit)
    return `Above the approval limit, ${settings.quotesAboveLimit} quote${settings.quotesAboveLimit === 1 ? ' is' : 's are'} needed.`;
  return null;
}

/**
 * Every line asks for an item by its code (2026-11-19). Something with no code
 * yet is added to the inventory first, by whoever keeps the stock.
 */
export interface RequisitionLineInput {
  itemId: string;
  quantity: number;
  estimatedUnitCostCents: number;
}

export interface RequisitionQuoteInput {
  vendorId: string;
  totalCents: number;
  /** "3 days". */
  delivery: string | null;
  chosen: boolean;
}

/** The whole requisition as the form holds it: a save replaces its lines and quotes. */
export interface SaveRequisitionInput {
  xeroTenantId: string | null;
  /** The Texas day it is needed by, YYYY-MM-DD. */
  neededBy: string | null;
  deliverToPlaceId: string | null;
  reason: string;
  lines: RequisitionLineInput[];
  quotes: RequisitionQuoteInput[];
}

/** Sending back and rejecting need a note; approving may have one. */
export interface RequisitionDecisionInput {
  note?: string | null;
}

export interface RequisitionRow {
  id: string;
  /** Null until it is first submitted. */
  number: string | null;
  status: RequisitionStatus;
  requestedBy: { id: string; name: string };
  /** When it was first submitted; a draft has only when it was started. */
  submittedAt: string | null;
  createdAt: string;
  company: { tenantId: string; name: string } | null;
  neededBy: string | null;
  /** "Filter 20x25x1 × 36, Battery, 9 V × 24". */
  summary: string;
  lineCount: number;
  quoteCount: number;
  estimatedTotalCents: number;
  /** The approver's note when it was sent back or rejected. */
  decisionNote: string | null;
}

export interface RequisitionList {
  requisitions: RequisitionRow[];
  settings: PurchasingSettings;
  /** Everyone's requisitions, or only the caller's own. */
  seesAll: boolean;
}

export interface RequisitionLine {
  id: string;
  /** Null only on a line written in words before every line needed a code; `description` then says what. */
  item: { id: string; code: string; name: string; unit: string } | null;
  description: string | null;
  quantity: number;
  estimatedUnitCostCents: number;
  /** On hand of the item now, and its reorder level; null for something not on the list. */
  onHand: number | null;
  reorderLevel: number | null;
}

export interface RequisitionQuote {
  id: string;
  vendor: { id: string; name: string };
  totalCents: number;
  delivery: string | null;
  chosen: boolean;
}

export interface RequisitionHistoryEntry {
  at: string;
  by: string;
  /** "submitted it", "sent it back: Which model?". */
  what: string;
}

/** What the caller may do with it now, decided by the server. */
export interface RequisitionActions {
  edit: boolean;
  submit: boolean;
  cancel: boolean;
  approve: boolean;
  sendBack: boolean;
  reject: boolean;
  /** Turn it into a purchase order: approved, and the caller makes orders. */
  order: boolean;
  /** Why the caller cannot approve it, when they otherwise could decide requisitions; null when they can or it is not waiting. */
  approveBlocked: string | null;
}

export interface RequisitionDetail extends RequisitionRow {
  reason: string;
  deliverTo: { id: string; name: string } | null;
  lines: RequisitionLine[];
  quotes: RequisitionQuote[];
  decidedBy: string | null;
  decidedAt: string | null;
  history: RequisitionHistoryEntry[];
  /** The order made from it, once there is one. */
  order: { id: string; number: string | null } | null;
  can: RequisitionActions;
  settings: PurchasingSettings;
}

/** What the requisition form chooses from. Its own read, so making a requisition does not need the Inventory page's permission. */
export interface RequisitionChoices {
  items: {
    id: string;
    code: string;
    name: string;
    unit: string;
    companyTenantId: string | null;
    onHand: number;
    reorderLevel: number;
    reorderQuantity: number;
    /** What one cost on average, to start the estimate from; null with nothing on hand. */
    averageCostCents: number | null;
  }[];
  places: { id: string; name: string }[];
  companies: { tenantId: string; name: string }[];
  vendors: { id: string; name: string }[];
  settings: PurchasingSettings;
}
