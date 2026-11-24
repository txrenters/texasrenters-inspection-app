import type { ApprovalStep } from './purchasing-setup.js';
import type { RequisitionStage } from './purchasing.js';
import type { GoodsReceiptRow, VendorBillView } from './receiving.js';

/**
 * Purchase orders (2026-11-19, phase 3 of the inventory and purchasing plan).
 * A purchaser makes an order from an approved requisition: the vendor, the
 * agreed prices, when it is expected. Somebody else approves it -- by amount,
 * as a requisition is -- and it then goes to the vendor as a PDF by email.
 *
 * An order moves no stock: receiving does, in phase 4. It takes its number
 * (PO-0001) when it is submitted for approval. Whoever made it never approves
 * it. Money is cents; quantities are whole units; sales tax is a rate in
 * hundredths of a percent (825 is 8.25%).
 */

export const PURCHASE_ORDER_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const PURCHASE_ORDER_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  // NAV's words (2026-11-21): approved is Released, for the purchaser to send.
  DRAFT: 'Open',
  AWAITING_APPROVAL: 'Pending Approval',
  APPROVED: 'Released',
  SENT: 'Sent to Vendor',
  PARTLY_RECEIVED: 'Partly Received',
  RECEIVED: 'Received',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

/** Still being worked on, or out with the vendor: the list's "open". */
export const OPEN_PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'PARTLY_RECEIVED', 'RECEIVED'];

/** 30%: past any sales tax, and it stops a rate typed as 825 for 8.25%. */
export const MOST_TAX_BASIS_POINTS = 3000;
/** Emails about orders one office sends a Texas day, at most. Each is a billed call to the mail provider. */
export const DEFAULT_PURCHASE_ORDER_EMAIL_CEILING = 50;
/** An order's PDF is text and a table: anything larger is not one. */
export const MOST_ORDER_PDF_BYTES = 200_000;

/** "PO-0009": at least four digits. */
export function purchaseOrderNumber(sequence: number): string {
  return `PO-${String(sequence).padStart(4, '0')}`;
}

export function orderSubtotalCents(lines: readonly { quantity: number; unitPriceCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
}

/** Sales tax on the subtotal, to the cent. */
export function orderTaxCents(subtotalCents: number, taxBasisPoints: number): number {
  return Math.round((subtotalCents * taxBasisPoints) / 10_000);
}

export function orderTotals(lines: readonly { quantity: number; unitPriceCents: number }[], taxBasisPoints: number) {
  const subtotalCents = orderSubtotalCents(lines);
  const taxCents = orderTaxCents(subtotalCents, taxBasisPoints);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** "8.25%" from 825; "0%" from 0. */
export function formatTaxRate(taxBasisPoints: number): string {
  return `${(taxBasisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Why an order cannot be submitted for approval yet; null when it can. */
export function orderSubmitProblem(order: { vendorId: string | null; lines: readonly unknown[] }): string | null {
  if (!order.vendorId) return 'Choose the vendor.';
  if (!order.lines.length) return 'An order needs at least one line.';
  return null;
}

export interface PurchaseOrderLineInput {
  /** One of the items its requisitions asked for. */
  itemId: string;
  /** Where it goes (2026-11-23): with the item, which line of the order it is; as the order was made. */
  placeId?: string | null;
  quantity: number;
  unitPriceCents: number;
}

/** The whole order as the form holds it: a save replaces its lines. */
export interface SavePurchaseOrderInput {
  vendorId: string | null;
  deliverToPlaceId: string | null;
  /** The Texas day it is expected, YYYY-MM-DD. */
  expectedOn: string | null;
  /** Payment terms as agreed: "Net 30". */
  terms: string | null;
  taxBasisPoints: number;
  /** Printed on the order for the vendor. */
  notes: string | null;
  lines: PurchaseOrderLineInput[];
}

/** Sending back needs a note; approving may have one. */
export interface PurchaseOrderDecisionInput {
  note?: string | null;
}

export interface CancelPurchaseOrderInput {
  reason: string;
}

/** The order's PDF as the browser made it, to ride on the email. */
export interface SendPurchaseOrderInput {
  to: string;
  message?: string | null;
  attachment: { fileName: string; contentBase64: string };
  /** Made once by the page for this press, so a second click or a retry sends nothing twice. */
  clientRequestId: string;
}

export interface PurchaseOrderRow {
  id: string;
  /** Null while it is a draft never submitted. */
  number: string | null;
  status: PurchaseOrderStatus;
  /** `number` is the vendor's No. ("V-00003", 2026-11-20). */
  vendor: { id: string; name: string; number?: string | null } | null;
  /** The oldest requisition it was made from. */
  requisition: { id: string; number: string | null };
  /** Every requisition it carries lines of, oldest first (2026-11-23: one order from several). */
  requisitions: { id: string; number: string | null }[];
  /** `purchaserCode` is the company's code ("THMP", 2026-11-20), when it has one. */
  company: { tenantId: string; name: string; purchaserCode?: string | null } | null;
  expectedOn: string | null;
  lineCount: number;
  totalCents: number;
  madeBy: { id: string; name: string };
  createdAt: string;
  sentAt: string | null;
}

export interface PurchaseOrderList {
  orders: PurchaseOrderRow[];
}

/** What "Make purchase orders" made (2026-11-20, part 4): one draft order a vendor still without one. */
export interface PurchaseOrdersMade {
  orders: { id: string; vendor: { id: string; number: string | null; name: string } | null }[];
}

export interface PurchaseOrderLine {
  id: string;
  /** `deleted` once its item code was deleted (2026-11-24): the line stays, and says so. */
  item: { id: string; code: string; name: string; unit: string; deleted?: boolean };
  /** Where it goes (2026-11-23); null for the order's own place. */
  place: { id: string; name: string; code: string | null } | null;
  quantity: number;
  unitPriceCents: number;
  /** What its requisitions asked for of this item, here. */
  requestedQuantity: number;
  /** How much has arrived. */
  receivedQuantity: number;
  /** Each requisition's share, oldest first: what arrives goes to them in that order. */
  shares: PurchaseOrderShare[];
}

/** A requisition's share of an order line (2026-11-23). */
export interface PurchaseOrderShare {
  requisition: { id: string; number: string | null };
  department: string | null;
  quantity: number;
  /** What has arrived of it: the line's arrivals given to its shares, oldest requisition first. */
  receivedQuantity: number;
}

/** A requisition an order carries lines of, for its page (2026-11-23). */
export interface PurchaseOrderRequisition {
  id: string;
  number: string | null;
  requestedBy: string;
  department: string | null;
  /** How many of its lines are on this order, of all its lines. */
  linesHere: number;
  lineCount: number;
  /** Where it is, NAV's way: Pending Processing while some of its lines are still to order. */
  stage: RequisitionStage;
}

/**
 * What has arrived of a line, given to its shares in order -- the oldest
 * requisition first (the office, 2026-11-23). `shares` come oldest first; the
 * answer is each one's received quantity, in the same order.
 */
export function allocateReceived(receivedQuantity: number, shares: readonly { quantity: number }[]): number[] {
  let left = Math.max(0, receivedQuantity);
  return shares.map((share) => {
    const given = Math.min(share.quantity, left);
    left -= given;
    return given;
  });
}

// ── Pending Processing: approved requisition lines not ordered yet (2026-11-23) ─

/** An approved requisition line waiting for an order. */
export interface PendingOrderLine {
  requisitionLineId: string;
  requisition: { id: string; number: string | null; createdAt: string; requestedBy: string };
  company: { tenantId: string; name: string; purchaserCode: string | null } | null;
  item: { id: string; code: string; name: string; unit: string };
  /** Where it goes: the line's own place, else its requisition's. */
  place: { id: string; name: string; code: string | null } | null;
  quantity: number;
  estimatedUnitCostCents: number;
  /** The line's own vendor, else its requisition's chosen quote's; null to choose. */
  vendor: { id: string; number: string | null; name: string } | null;
  expectedOn: string | null;
  department: string | null;
  notes: string | null;
}

export interface PendingOrderLines {
  lines: PendingOrderLine[];
  /** The vendors in use, for a line with none. */
  vendors: { id: string; number: string | null; name: string }[];
}

/** Make Purchase Orders: the lines ticked, each with the vendor it goes to. One order a vendor and company. */
export interface MakePurchaseOrdersInput {
  lines: { requisitionLineId: string; vendorId: string | null }[];
}

/** At most this many lines in one press. */
export const MOST_PENDING_LINES_ORDERED = 300;

export interface PurchaseOrderDeliveryRow {
  id: string;
  recipient: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  failure: string | null;
  at: string;
  by: string;
}

/** What the caller may do with it now, decided by the server. */
export interface PurchaseOrderActions {
  edit: boolean;
  /**
   * Change an approved order nothing has arrived for yet (Purchasing Setup,
   * 2026-11-20). Whether it goes back for approval is `orderChangeNeedsApproval`.
   */
  change: boolean;
  submit: boolean;
  approve: boolean;
  sendBack: boolean;
  /** Email it to the vendor: once approved, and again after. */
  send: boolean;
  cancel: boolean;
  /** Post a receipt of goods that arrived. */
  receive: boolean;
  /** Reverse a receipt: while the bill has not been approved against it. */
  reverseReceipt: boolean;
  /** Enter the vendor's bill, or change it while it is not approved. */
  bill: boolean;
  /** Approve a bill that matches. */
  approveBill: boolean;
  /** Approve a bill that is held, with a reason: only somebody who may approve any amount, and not whoever entered it. */
  overrideBill: boolean;
  /** Record that an approved bill was paid. */
  pay: boolean;
  /** Finish a partly received order with what has arrived. */
  closeShort: boolean;
  /** Why the caller cannot approve it, when they otherwise decide orders; null when they can or it is not waiting. */
  approveBlocked: string | null;
}

/** Who the order is from, as printed on it. */
export interface PurchaseOrderFrom {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  phone: string | null;
  email: string | null;
}

export interface PurchaseOrderDetail extends PurchaseOrderRow {
  vendorContact: { contactName: string | null; email: string | null; phone: string | null } | null;
  /** `code` is the place's Location Code ("STORE", 2026-11-20). */
  deliverTo: { id: string; name: string; code?: string | null } | null;
  terms: string | null;
  taxBasisPoints: number;
  notes: string | null;
  lines: PurchaseOrderLine[];
  subtotalCents: number;
  taxCents: number;
  approvedBy: string | null;
  approvedAt: string | null;
  /** The approver's note when it was sent back. */
  decisionNote: string | null;
  cancelReason: string | null;
  from: PurchaseOrderFrom;
  /**
   * The requisition's files ticked "Send to the vendor with the PO": they go in
   * the email beside the PDF, when together they fit (VENDOR_FILES_MAX_BYTES).
   */
  vendorFiles: { id: string; fileName: string; sizeBytes: number }[];
  deliveries: PurchaseOrderDeliveryRow[];
  /** Each arrival of goods, newest first. */
  receipts: GoodsReceiptRow[];
  /** The vendor's bill, once entered. */
  bill: VendorBillView | null;
  /** Why the rest will not arrive, when the order was finished short. */
  shortCloseReason: string | null;
  history: { at: string; by: string; what: string }[];
  can: PurchaseOrderActions;
  /** The requisitions it carries lines of, oldest first (2026-11-23). */
  requisitionsOn: PurchaseOrderRequisition[];
  /** The office's approval steps, which orders share with requisitions (Purchasing Setup, 2026-11-20). */
  approvalSteps: ApprovalStep[];
  /** Every change to an approved order goes back for approval; off, only one that raises it or adds a line. */
  reapproveChangedOrders: boolean;
}

/**
 * Whether a change to an approved order goes back for approval (2026-11-20):
 * always when the office says so; otherwise when it raises the total, puts on
 * an item the order did not have, or goes to another vendor. Lowering a
 * quantity, a price or the date stays approved.
 */
export function orderChangeNeedsApproval(
  before: { totalCents: number; itemIds: readonly string[]; vendorId: string | null },
  after: { totalCents: number; itemIds: readonly string[]; vendorId: string | null },
  reapproveChangedOrders: boolean,
): boolean {
  if (reapproveChangedOrders) return true;
  return after.totalCents > before.totalCents || after.vendorId !== before.vendorId || after.itemIds.some((itemId) => !before.itemIds.includes(itemId));
}
