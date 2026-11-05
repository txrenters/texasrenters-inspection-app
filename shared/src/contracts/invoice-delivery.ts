/**
 * Sending an invoice to the client from the console (2026-11-06, phase 5 of
 * taking invoicing over from Jobber). By email: every send is a billed call
 * to the mail provider, so it happens only when somebody presses Send, to a
 * handful of people at a time, under a daily ceiling per office, and once per
 * press however often the browser repeats it. Text messages need a provider
 * the console does not have yet.
 */

import { formatMoney, type InvoiceDetail } from './invoices.js';

/** The most people one send reaches. */
export const MAX_INVOICE_RECIPIENTS = 5;

export interface SendInvoiceInput {
  /** Email addresses, at most `MAX_INVOICE_RECIPIENTS`. */
  to: string[];
  /** A note above the invoice, as Jobber's email has one. */
  message?: string | null;
  /** The browser's key: a resend or a double click sends one email. */
  clientRequestId: string;
}

export type InvoiceDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED';

/** One time the invoice was sent, as the invoice page lists them. */
export interface InvoiceDeliveryView {
  id: string;
  channel: 'EMAIL';
  recipients: string[];
  status: InvoiceDeliveryStatus;
  /** Why it did not go, in words. */
  failure: string | null;
  sentBy: { id: string; displayName: string } | null;
  /** ISO */
  createdAt: string;
  sentAt: string | null;
}

/** An address that looks like one; the mail provider is the judge of the rest. */
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;

export const isEmailAddress = (value: string) => EMAIL.test(value.trim()) && value.trim().length <= 254;

/** What is wrong with who an invoice is sent to, in words; null when it can be sent. */
export function recipientsProblem(to: readonly string[]): string | null {
  const addresses = to.map((address) => address.trim()).filter(Boolean);
  if (!addresses.length) return 'Choose who it goes to.';
  if (addresses.length > MAX_INVOICE_RECIPIENTS) return `Send it to at most ${MAX_INVOICE_RECIPIENTS} people at a time.`;
  const wrong = addresses.find((address) => !isEmailAddress(address));
  if (wrong) return `${wrong} is not an email address.`;
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length) return 'An address is listed twice.';
  return null;
}

/** "Invoice #8439", or "Invoice" for one not numbered yet: how the email and the PDF name it. */
export const invoiceDocumentName = (invoice: Pick<InvoiceDetail, 'number'>) => (invoice.number ? `Invoice #${invoice.number}` : 'Invoice');

export interface InvoiceTotalLine {
  label: string;
  value: string;
  /** The balance due, printed bold. */
  strong?: boolean;
}

/**
 * The totals under an invoice's lines, as its email and its PDF print them:
 * subtotal, any discount and tax, the total, what has been paid, and the
 * balance due last. One list, so the two never disagree.
 */
export function invoiceTotalLines(
  invoice: Pick<InvoiceDetail, 'subtotalCents' | 'taxCents' | 'totalCents' | 'balanceCents' | 'paidCents' | 'details'>,
): InvoiceTotalLine[] {
  const details = invoice.details;
  const lines: InvoiceTotalLine[] = [{ label: 'Subtotal', value: formatMoney(invoice.subtotalCents) }];
  if (details?.discountCents)
    lines.push({
      label: details.discountPercent !== null ? `Discount (${details.discountPercent}%)` : 'Discount',
      value: `-${formatMoney(details.discountCents)}`,
    });
  if (invoice.taxCents || details?.taxRateName)
    lines.push({
      label: [details?.taxRateName || 'Tax', details?.taxRatePercent ? `(${details.taxRatePercent}%)` : null].filter(Boolean).join(' '),
      value: formatMoney(invoice.taxCents),
    });
  lines.push({ label: 'Total', value: formatMoney(invoice.totalCents) });
  if (invoice.paidCents) lines.push({ label: 'Paid', value: `-${formatMoney(invoice.paidCents)}` });
  lines.push({ label: 'Balance due', value: formatMoney(invoice.balanceCents), strong: true });
  return lines;
}
