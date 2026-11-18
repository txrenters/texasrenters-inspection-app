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

export const PURCHASE_ORDER_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'CANCELLED'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const PURCHASE_ORDER_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'Draft',
  AWAITING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved, not sent',
  SENT: 'Sent to the vendor',
  CANCELLED: 'Cancelled',
};

/** Still being worked on, or out with the vendor: the list's "open". */
export const OPEN_PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT'];

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
  /** One of the requisition's items. */
  itemId: string;
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
  vendor: { id: string; name: string } | null;
  requisition: { id: string; number: string | null };
  company: { tenantId: string; name: string } | null;
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

export interface PurchaseOrderLine {
  id: string;
  item: { id: string; code: string; name: string; unit: string };
  quantity: number;
  unitPriceCents: number;
  /** What the requisition asked for of this item. */
  requestedQuantity: number;
}

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
  submit: boolean;
  approve: boolean;
  sendBack: boolean;
  /** Email it to the vendor: once approved, and again after. */
  send: boolean;
  cancel: boolean;
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
  deliverTo: { id: string; name: string } | null;
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
  deliveries: PurchaseOrderDeliveryRow[];
  history: { at: string; by: string; what: string }[];
  can: PurchaseOrderActions;
  /** The office's approval limit, which orders share with requisitions. */
  approvalLimitCents: number;
}
