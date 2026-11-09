/**
 * Sending an invoice to the client from the console (2026-11-06, phase 5 of
 * taking invoicing over from Jobber). By email: every send is a billed call
 * to the mail provider, so it happens only when somebody presses Send, to a
 * handful of people at a time, under a daily ceiling per office, and once per
 * press however often the browser repeats it. Text messages need a provider
 * the console does not have yet.
 */

import { DEFAULT_CLIENT_VIEW, type InvoiceClientView, type InvoiceEmailAttachment } from './invoice-templates.js';
import type { InvoiceDeliveryKind } from './invoice-reminders.js';
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
  /** The invoice's PDF, made in the browser, attached to the email (2026-11-10). */
  attachment?: InvoiceEmailAttachment | null;
}

export type InvoiceDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED';

/** One time the invoice was sent, as the invoice page lists them. */
export interface InvoiceDeliveryView {
  id: string;
  channel: 'EMAIL';
  /** The invoice sent by somebody, a follow-up the console sent on its own, or a receipt. */
  kind: InvoiceDeliveryKind;
  /** A follow-up's day after the due date: 0 is the due date. */
  followUpDay: number | null;
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
const TEMPLATE_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** "Dec 1, 2026", or "—" for none: a day as a template says it. */
export const templateDay = (value: string | null | undefined) => (value ? TEMPLATE_DAY.format(new Date(`${value}T12:00:00.000Z`)) : '—');

/** An invoice email's placeholders, filled (2026-11-10). */
export function invoiceTemplateValues(
  invoice: Pick<InvoiceDetail, 'clientName' | 'number' | 'subject' | 'totalCents' | 'balanceCents' | 'issuedOn' | 'dueOn'>,
  companyName: string,
): Record<string, string> {
  return {
    client_name: invoice.clientName,
    company_name: companyName,
    invoice_number: invoice.number ?? '',
    invoice_subject: invoice.subject,
    invoice_total: formatMoney(invoice.totalCents),
    balance_due: formatMoney(invoice.balanceCents),
    issued_date: templateDay(invoice.issuedOn),
    due_date: templateDay(invoice.dueOn),
  };
}

/** What the client sees, the console's own until the office says otherwise (2026-11-10). */
export const clientViewOf = (invoice: { clientView?: InvoiceClientView }): InvoiceClientView => invoice.clientView ?? DEFAULT_CLIENT_VIEW;

/** The client's whole account under the invoice's balance, as Jobber prints it when "Account balance" is on. */
export function accountBalanceLine(invoice: Pick<InvoiceDetail, 'accountBalanceCents' | 'clientView'>): InvoiceTotalLine | null {
  if (!clientViewOf(invoice).showAccountBalance || invoice.accountBalanceCents === null) return null;
  return { label: 'Account balance', value: formatMoney(invoice.accountBalanceCents) };
}

/** Jobber's late stamp: past its due date, still owed, and the office has not turned it off. */
export const showsLateStamp = (invoice: Pick<InvoiceDetail, 'status' | 'clientView'>) =>
  invoice.status === 'PAST_DUE' && clientViewOf(invoice).showLateStamp;

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
