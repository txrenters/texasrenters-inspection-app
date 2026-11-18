import { formatMoney } from './invoices.js';
import { formatTaxRate, orderTaxCents } from './purchase-orders.js';

/**
 * Receiving and the vendor's bill (2026-11-19, phase 4 of the inventory and
 * purchasing plan). Goods arrive against a purchase order, all at once or in
 * parts, and each arrival is a receipt: posting it is the only thing in
 * purchasing that puts stock on the shelf. A receipt is never edited; a wrong
 * one is reversed.
 *
 * The vendor's bill is matched three ways -- what was ordered, what was
 * received, what was billed -- and is held, saying why, when they disagree.
 * A bill that matches is approved for payment; one that does not needs
 * somebody who may approve any amount, and their reason. Recording a payment
 * moves no money: it writes down that the office paid.
 */

export const VENDOR_BILL_STATUSES = ['HELD', 'MATCHED', 'APPROVED', 'PAID'] as const;
export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number];

export const VENDOR_BILL_STATUS_LABEL: Record<VendorBillStatus, string> = {
  HELD: 'Held: does not match',
  MATCHED: 'Matches',
  APPROVED: 'Approved for payment',
  PAID: 'Paid',
};

export const VENDOR_PAYMENT_METHODS = ['CHECK', 'ACH', 'CARD', 'CASH', 'OTHER'] as const;
export type VendorPaymentMethod = (typeof VENDOR_PAYMENT_METHODS)[number];

export const VENDOR_PAYMENT_METHOD_LABEL: Record<VendorPaymentMethod, string> = {
  CHECK: 'Check',
  ACH: 'Bank transfer',
  CARD: 'Card',
  CASH: 'Cash',
  OTHER: 'Other',
};

/** "RCV-0007": at least four digits. */
export function receiptNumber(sequence: number): string {
  return `RCV-${String(sequence).padStart(4, '0')}`;
}

export interface ReceiveGoodsInput {
  /** The Texas day it arrived; today when left out. */
  receivedOn?: string;
  /** The vendor's packing slip number. */
  packingSlip?: string | null;
  /** Damage, a short delivery. */
  note?: string | null;
  /** Made once by the page for this receipt, so a second click or a retry posts nothing twice. */
  requestKey: string;
  /** What arrived now, of which order line, and where it was put. */
  lines: { orderLineId: string; placeId: string; quantity: number }[];
}

export interface ReverseReceiptInput {
  reason: string;
}

/** The vendor's invoice as the office reads it off the paper. A save replaces its lines. */
export interface SaveVendorBillInput {
  billNumber: string;
  /** YYYY-MM-DD. */
  billDate: string;
  totalCents: number;
  lines: { orderLineId: string; quantity: number; unitPriceCents: number }[];
}

/** A bill that matches needs no reason; one that is held is approved only with one. */
export interface ApproveVendorBillInput {
  reason?: string | null;
}

export interface PayVendorBillInput {
  /** YYYY-MM-DD. */
  paidOn: string;
  method: VendorPaymentMethod;
  /** The check number, the transfer's reference. */
  reference?: string | null;
}

/** The rest will not arrive: the order is finished with what has. */
export interface CloseShortInput {
  reason: string;
}

export interface BillMatchLine {
  name: string;
  ordered: number;
  received: number;
  unitPriceCents: number;
  /** 0 when the bill has no line for it. */
  billedQuantity: number;
  /** Null when the bill has no line for it. */
  billedUnitPriceCents: number | null;
}

/**
 * The three-way match: why a bill does not agree with its order and its
 * receipts, each in a sentence; empty when it does. The page shows these, and
 * the server holds or passes the bill by the same list.
 */
export function billProblems(lines: readonly BillMatchLine[], billTotalCents: number, taxBasisPoints: number): string[] {
  const problems: string[] = [];
  let subtotalCents = 0;
  for (const line of lines) {
    if (!line.billedQuantity) continue;
    const price = line.billedUnitPriceCents ?? line.unitPriceCents;
    subtotalCents += line.billedQuantity * price;
    if (line.billedQuantity > line.received)
      problems.push(`${line.name}: billed for ${line.billedQuantity}, and ${line.received} ${line.received === 1 ? 'has' : 'have'} arrived.`);
    if (price !== line.unitPriceCents) problems.push(`${line.name}: billed at ${formatMoney(price)} each, ordered at ${formatMoney(line.unitPriceCents)}.`);
  }
  if (!lines.some((line) => line.billedQuantity > 0)) return ['The bill has no lines.'];
  const expected = subtotalCents + orderTaxCents(subtotalCents, taxBasisPoints);
  if (billTotalCents !== expected)
    problems.push(`The bill's total is ${formatMoney(billTotalCents)}; its lines${taxBasisPoints ? ` with ${formatTaxRate(taxBasisPoints)} tax` : ''} come to ${formatMoney(expected)}.`);
  return problems;
}

export interface GoodsReceiptRow {
  id: string;
  number: string;
  receivedOn: string;
  packingSlip: string | null;
  note: string | null;
  by: string;
  at: string;
  /** Set once it has been reversed: its stock was taken back out. */
  reversed: { by: string; at: string; reason: string } | null;
  lines: { itemCode: string; itemName: string; placeName: string; quantity: number }[];
}

export interface VendorBillView {
  billNumber: string;
  billDate: string;
  totalCents: number;
  status: VendorBillStatus;
  lines: { orderLineId: string; quantity: number; unitPriceCents: number }[];
  /** Why it is held; empty when it matches. Worked out again each time it is read. */
  problems: string[];
  enteredBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  /** The approver's reason, when it was approved without matching. */
  overrideReason: string | null;
  paidOn: string | null;
  method: VendorPaymentMethod | null;
  reference: string | null;
  paidBy: string | null;
}
