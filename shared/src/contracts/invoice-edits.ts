/**
 * Editing an invoice in the console (2026-11-06, phase 3 of taking invoicing
 * over from Jobber): its details and lines, a discount and a tax, the client
 * message and the contract text; marking it sent, voiding it, closing it as
 * bad debt and reopening it; and the history of all of it.
 *
 * The totals are worked out here and again on the server from the lines,
 * never typed. Money is whole cents, as everywhere.
 */
import type { InvoiceClientView } from './invoice-templates.js';
import {
  INVOICE_STATUS_LABEL,
  MAX_INVOICE_CENTS,
  formatMoney,
  invoiceLinesProblem,
  lineTotalCents,
  type InvoiceLineInput,
  type InvoiceStatus,
} from './invoices.js';

/** A line as it is edited: a new invoice's line, with the day the work was done and whether the tax applies. */
export interface EditInvoiceLineInput extends InvoiceLineInput {
  /** `YYYY-MM-DD`, when the line names one. */
  serviceOn?: string | null;
  /** False for a line the invoice's tax does not apply to. Taxed otherwise. */
  taxable?: boolean;
}

/** A discount off the subtotal: a percent of it, or an amount. */
export type InvoiceDiscountInput = { kind: 'PERCENT'; percent: number } | { kind: 'AMOUNT'; amountCents: number };

/** A tax on the taxed lines, added to the total ("Texas, 8.25%"). */
export interface InvoiceTaxInput {
  name: string;
  percent: number;
}

export interface EditInvoiceInput {
  subject: string;
  /** Jobber's number, "8439": kept unique in the office. Null only for a draft that never had one. */
  number: string | null;
  /** `YYYY-MM-DD` */
  issuedOn: string;
  dueOn: string;
  lineItems: EditInvoiceLineInput[];
  discount: InvoiceDiscountInput | null;
  tax: InvoiceTaxInput | null;
  clientMessage?: string | null;
  contractDisclaimer?: string | null;
  /** What the client sees (2026-11-10); left out, it stays as it is. */
  clientView?: InvoiceClientView;
  /** The invoice as it was read (`InvoiceDetail.updatedAt`): one changed since is refused rather than overwritten. */
  expectedUpdatedAt: string;
}

export interface InvoiceAmounts {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * The invoice's money from its lines, discount and tax, as Jobber works it:
 * the discount comes off the subtotal before tax, and the tax is on the taxed
 * lines with their share of the discount taken off.
 */
export function invoiceAmounts(
  lines: readonly (Pick<EditInvoiceLineInput, 'quantity' | 'unitPriceCents' | 'taxable'>)[],
  discount: InvoiceDiscountInput | null,
  tax: InvoiceTaxInput | null,
): InvoiceAmounts {
  const subtotalCents = lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
  const discountCents = !discount
    ? 0
    : discount.kind === 'PERCENT'
      ? Math.round((subtotalCents * discount.percent) / 100)
      : discount.amountCents;
  const taxedCents = lines.filter((line) => line.taxable !== false).reduce((sum, line) => sum + lineTotalCents(line), 0);
  const taxedAfterDiscount = subtotalCents > 0 ? taxedCents - Math.round((discountCents * taxedCents) / subtotalCents) : 0;
  const taxCents = tax ? Math.round((Math.max(0, taxedAfterDiscount) * tax.percent) / 100) : 0;
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The most a tax rate is taken to be: a cap on a typo, not a rule of Texas. */
export const MAX_TAX_PERCENT = 25;

/**
 * What is wrong with an edit, in words; null when it can be saved. `paidCents`
 * is what the invoice's payments come to: an invoice cannot come to less.
 */
export function invoiceEditProblem(
  input: Pick<EditInvoiceInput, 'subject' | 'number' | 'issuedOn' | 'dueOn' | 'lineItems' | 'discount' | 'tax'>,
  paidCents: number,
): string | null {
  if (!input.subject.trim()) return 'Give the invoice a subject.';
  if (input.number !== null && !input.number.trim()) return 'Give the invoice a number.';
  if (input.number && input.number.trim().length > 30) return 'An invoice number is at most 30 characters.';
  if (!DAY.test(input.issuedOn)) return 'Give the day the invoice is issued.';
  if (!DAY.test(input.dueOn)) return 'Give the day it is due.';
  if (input.dueOn < input.issuedOn) return 'It cannot be due before it is issued.';
  const lines = invoiceLinesProblem(input.lineItems);
  if (lines) return lines;
  if (input.lineItems.some((line) => line.serviceOn && !DAY.test(line.serviceOn))) return 'Give each service day as a date.';

  const { subtotalCents, discountCents, totalCents } = invoiceAmounts(input.lineItems, input.discount, input.tax);
  if (input.discount?.kind === 'PERCENT' && !(input.discount.percent > 0 && input.discount.percent <= 100))
    return 'A discount is between 0 and 100 percent.';
  if (input.discount?.kind === 'AMOUNT' && !(Number.isInteger(input.discount.amountCents) && input.discount.amountCents > 0))
    return 'Give the discount in dollars and cents.';
  if (discountCents > subtotalCents) return `The discount is more than the ${formatMoney(subtotalCents)} subtotal.`;
  if (input.tax) {
    if (!input.tax.name.trim()) return 'Name the tax, as it prints on the invoice.';
    if (!(input.tax.percent > 0 && input.tax.percent <= MAX_TAX_PERCENT)) return `A tax is between 0 and ${MAX_TAX_PERCENT} percent.`;
  }
  if (totalCents <= 0) return 'The invoice comes to nothing.';
  if (totalCents > MAX_INVOICE_CENTS) return `The invoice comes to more than ${formatMoney(MAX_INVOICE_CENTS)}. Check the prices.`;
  if (totalCents < paidCents)
    return `It would come to ${formatMoney(totalCents)}, less than the ${formatMoney(paidCents)} already paid. Change or remove a payment first.`;
  return null;
}

/** States whose invoice can be edited. A voided invoice, or one closed as bad debt, is reopened first. */
export const isEditableInvoiceStatus = (status: InvoiceStatus) =>
  status === 'DRAFT' || status === 'AWAITING_PAYMENT' || status === 'PAST_DUE' || status === 'PAID';

/** What can be done to an invoice's state, as Jobber's More menu offers it. */
export const INVOICE_STATUS_ACTIONS = ['MARK_SENT', 'VOID', 'BAD_DEBT', 'REOPEN'] as const;
export type InvoiceStatusAction = (typeof INVOICE_STATUS_ACTIONS)[number];

export const INVOICE_STATUS_ACTION_LABEL: Record<InvoiceStatusAction, string> = {
  MARK_SENT: 'Mark as sent',
  VOID: 'Void invoice',
  BAD_DEBT: 'Close as bad debt',
  REOPEN: 'Reopen invoice',
};

/**
 * Why an action cannot be taken on an invoice now, in words; null when it can.
 *
 * A draft is marked sent, which makes it owed. An invoice still owing is
 * closed as bad debt -- what it owes is written off -- or voided, which only
 * an invoice nobody has paid anything on can be. A voided or bad-debt invoice
 * is reopened, and owes again what its payments leave.
 */
export function invoiceStatusActionProblem(
  action: InvoiceStatusAction,
  invoice: { status: InvoiceStatus; balanceCents: number; paidCents: number },
): string | null {
  const { status } = invoice;
  const owing = status === 'AWAITING_PAYMENT' || status === 'PAST_DUE';
  switch (action) {
    case 'MARK_SENT':
      return status === 'DRAFT' ? null : 'Only a draft is marked as sent.';
    case 'VOID':
      if (!owing && status !== 'DRAFT') return `A ${INVOICE_STATUS_LABEL[status].toLowerCase()} invoice is not voided.`;
      return invoice.paidCents > 0 ? 'It has payments. Remove them first, or close it as bad debt.' : null;
    case 'BAD_DEBT':
      if (!owing) return 'Only an invoice still owing is closed as bad debt.';
      return invoice.balanceCents > 0 ? null : 'Nothing is owed on it.';
    case 'REOPEN':
      return status === 'VOIDED' || status === 'BAD_DEBT' ? null : 'Only a voided or bad-debt invoice is reopened.';
  }
}

/** The actions an invoice offers now, in menu order. */
export const invoiceStatusActions = (invoice: { status: InvoiceStatus; balanceCents: number; paidCents: number }) =>
  INVOICE_STATUS_ACTIONS.filter((action) => invoiceStatusActionProblem(action, invoice) === null);

/** A draft nobody has paid anything on can be deleted; anything else sent is voided instead, and stays on the record. */
export const canDeleteInvoice = (invoice: { status: InvoiceStatus; paidCents: number }) =>
  invoice.status === 'DRAFT' && invoice.paidCents === 0;

export interface InvoiceStatusChangeInput {
  action: InvoiceStatusAction;
  expectedUpdatedAt: string;
}

/** One thing that happened to an invoice in the console, as its History shows it. */
export interface InvoiceHistoryEvent {
  id: string;
  /** ISO */
  at: string;
  actor: { id: string; displayName: string } | null;
  /** "Invoice edited", "Payment recorded". */
  title: string;
  /** What changed, in words: "Subject: For Services Rendered → Quarterly service". */
  lines: string[];
}

export interface InvoiceHistory {
  items: InvoiceHistoryEvent[];
  /** More happened than is listed; the oldest are left off. */
  truncated: boolean;
}
