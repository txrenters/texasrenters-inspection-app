import { InvoicePaymentMethod, InvoiceStatus } from '@prisma/client';
import { z } from 'zod';

/**
 * A company's books as Xero keeps them (2026-11-12, PR 2 of the plan to make
 * invoices in the console with Xero as the record). Pure: Xero's invoices and
 * payments in the console's terms, and where the next read carries on. Xero
 * wins: what it says an invoice is, is what the console keeps.
 */

/** Xero's invoices and payments a page: the most it gives. */
export const BOOKS_PAGE_SIZE = 1000;
/**
 * The fewest Xero puts on a page that is not the last (its default size): a
 * page shorter than this reached the end, whether or not Xero honoured the
 * size asked for.
 */
export const XERO_LEAST_PAGE = 100;
/** Read again before the newest seen: Xero's "updated" times can land a little after the fact. */
export const BOOKS_OVERLAP_MS = 5 * 60_000;

const money = z.number().nullish();
const text = z.string().nullish();

/** One sales invoice as Xero gives it on a page: lines, payments and amounts included. */
export const xeroBooksInvoiceSchema = z.object({
  InvoiceID: z.string().min(1),
  Type: text,
  InvoiceNumber: text,
  Reference: text,
  Status: text,
  LineAmountTypes: text,
  Contact: z
    .object({
      ContactID: text,
      Name: text,
      Addresses: z.array(z.object({ AddressType: text, AddressLine1: text, PostalCode: text })).nullish(),
    })
    .nullish(),
  Date: text,
  DateString: text,
  DueDate: text,
  DueDateString: text,
  FullyPaidOnDate: text,
  UpdatedDateUTC: text,
  SubTotal: money,
  TotalTax: money,
  Total: money,
  AmountDue: money,
  AmountPaid: money,
  AmountCredited: money,
  Url: text,
  LineItems: z
    .array(
      z.object({
        Description: text,
        Quantity: money,
        UnitAmount: money,
        LineAmount: money,
        TaxAmount: money,
        ItemCode: text,
        Item: z.object({ Name: text, Code: text }).nullish(),
      }),
    )
    .nullish(),
  Payments: z.array(z.object({ PaymentID: z.string().min(1), Date: text, Amount: money, Reference: text })).nullish(),
});
export type XeroBooksInvoice = z.infer<typeof xeroBooksInvoiceSchema>;

/** One payment as Xero lists them: the account it went to, and whether it was deleted. */
export const xeroBooksPaymentSchema = z.object({
  PaymentID: z.string().min(1),
  Date: text,
  Amount: money,
  Reference: text,
  /** AUTHORISED, or DELETED. */
  Status: text,
  PaymentType: text,
  UpdatedDateUTC: text,
  Account: z.object({ AccountID: text }).nullish(),
  Invoice: z.object({ InvoiceID: text, Type: text }).nullish(),
});
export type XeroBooksPayment = z.infer<typeof xeroBooksPaymentSchema>;

/** A page as Xero answers it, each entry read on its own: one Xero sends oddly never stops the rest. */
export const booksInvoicesPageSchema = z.object({ Invoices: z.array(z.unknown()) });
export const booksPaymentsPageSchema = z.object({ Payments: z.array(z.unknown()) });

const MS_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** An instant as Xero writes it: `/Date(1573776000000+0000)/`, or ISO. */
export function xeroInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = MS_DATE.exec(value.trim());
  const date = ms ? new Date(Number(ms[1])) : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A day, `YYYY-MM-DD`: Xero's own day string first; its dates have no time of day, so the instant's UTC day is that day. */
export function xeroDay(dayString: string | null | undefined, date: string | null | undefined): string | null {
  if (dayString && /^\d{4}-\d{2}-\d{2}/.test(dayString)) return dayString.slice(0, 10);
  return xeroInstant(date)?.toISOString().slice(0, 10) ?? null;
}

const cents = (amount: number | null | undefined) => Math.round((amount ?? 0) * 100);

/** How far apart, at most, a Jobber invoice and Xero's under its number were issued when their totals differ. */
export const TWIN_DAYS_APART = 31;

/**
 * Whether a Jobber invoice taken by its number alone can be Xero's invoice:
 * the same total, or issued within a month of each other (2026-11-12). The
 * office changed amounts and days in Xero after Zapier sent them; three of
 * THMP's numbers, more than a year and many dollars apart, are other invoices.
 * With a day missing -- a Jobber draft has none -- the days say nothing against it.
 */
export function agreesWithCopy(theirs: XeroBooksInvoice, copy: { totalCents: number; issuedOn: Date | null }): boolean {
  if (cents(theirs.Total) === copy.totalCents) return true;
  const day = xeroDay(theirs.DateString, theirs.Date);
  if (!day || !copy.issuedOn) return true;
  return Math.abs(Date.parse(`${day}T00:00:00Z`) - copy.issuedOn.getTime()) <= TWIN_DAYS_APART * 86_400_000;
}

/**
 * Xero's status as the console's. A bad debt is the console's own word: only
 * an invoice the console wrote off there is one; any other credit is a credit.
 * Null for a status Xero has never used.
 */
export function statusFromXero(status: string | null | undefined, writtenOff: boolean): InvoiceStatus | null {
  switch (status) {
    case 'DRAFT':
    case 'SUBMITTED':
      return InvoiceStatus.DRAFT;
    case 'AUTHORISED':
      return InvoiceStatus.AWAITING_PAYMENT;
    case 'PAID':
      return writtenOff ? InvoiceStatus.BAD_DEBT : InvoiceStatus.PAID;
    case 'VOIDED':
    case 'DELETED':
      return InvoiceStatus.VOIDED;
    default:
      return null;
  }
}

export interface LineFromXero {
  position: number;
  name: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  productName: string | null;
  taxable: boolean | null;
}

export interface PaymentFromXero {
  xeroPaymentId: string;
  paidOn: string;
  amountCents: number;
  reference: string | null;
}

/** Xero's invoice in the console's columns. */
export interface InvoiceFromXero {
  xeroInvoiceId: string;
  xeroContactId: string | null;
  xeroStatus: string;
  xeroUpdatedAt: Date | null;
  xeroUrl: string | null;
  number: string | null;
  subject: string;
  status: InvoiceStatus;
  clientName: string;
  issuedOn: string | null;
  dueOn: string | null;
  paidOn: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** What Xero says is still owed. */
  balanceCents: number;
  amountPaidCents: number;
  amountCreditedCents: number;
  taxInclusive: boolean | null;
  lines: LineFromXero[];
  payments: PaymentFromXero[];
  /** The contact's street and ZIP, when Xero gave them: the last way to find its property. */
  address: { line1: string; postalCode: string } | null;
  /** Deleted in Xero: a draft that never was. */
  deleted: boolean;
}

const firstLine = (value: string | null | undefined) => value?.split(/\r?\n/)[0]?.trim().slice(0, 200) || null;

/** One of Xero's invoices as the console keeps it; null when its status is one Xero has never used. */
export function invoiceFromXero(theirs: XeroBooksInvoice, writtenOff: boolean): InvoiceFromXero | null {
  const status = statusFromXero(theirs.Status, writtenOff);
  if (!status) return null;
  const number = theirs.InvoiceNumber?.trim() || null;
  const address = theirs.Contact?.Addresses?.find((entry) => entry.AddressLine1?.trim() && entry.PostalCode?.trim());
  return {
    xeroInvoiceId: theirs.InvoiceID,
    xeroContactId: theirs.Contact?.ContactID || null,
    xeroStatus: theirs.Status!,
    xeroUpdatedAt: xeroInstant(theirs.UpdatedDateUTC),
    xeroUrl: theirs.Url?.trim() || null,
    number,
    subject: theirs.Reference?.trim() || (number ? `Invoice ${number}` : 'Invoice'),
    status,
    clientName: theirs.Contact?.Name?.trim() || 'No contact',
    issuedOn: xeroDay(theirs.DateString, theirs.Date),
    dueOn: xeroDay(theirs.DueDateString, theirs.DueDate),
    paidOn: theirs.Status === 'PAID' ? xeroDay(null, theirs.FullyPaidOnDate) : null,
    subtotalCents: cents(theirs.SubTotal),
    taxCents: cents(theirs.TotalTax),
    totalCents: cents(theirs.Total),
    // A voided or deleted invoice owes nothing, whatever it said before.
    balanceCents: status === InvoiceStatus.VOIDED ? 0 : cents(theirs.AmountDue),
    amountPaidCents: cents(theirs.AmountPaid),
    amountCreditedCents: cents(theirs.AmountCredited),
    taxInclusive: theirs.LineAmountTypes === 'Inclusive' ? true : theirs.LineAmountTypes ? false : null,
    lines: (theirs.LineItems ?? []).map((line, position) => {
      const name = line.Item?.Name?.trim() || line.ItemCode?.trim() || firstLine(line.Description) || 'Line';
      const description = line.Description?.trim() || null;
      return {
        position,
        name,
        description: description === name ? null : description,
        quantity: line.Quantity ?? 1,
        unitPriceCents: cents(line.UnitAmount),
        totalCents: cents(line.LineAmount),
        productName: line.Item?.Name?.trim() || null,
        taxable: line.TaxAmount == null ? null : line.TaxAmount !== 0,
      };
    }),
    payments: (theirs.Payments ?? []).flatMap((paid) => {
      const paidOn = xeroDay(null, paid.Date);
      return paidOn ? [{ xeroPaymentId: paid.PaymentID, paidOn, amountCents: cents(paid.Amount), reference: paid.Reference?.trim() || null }] : [];
    }),
    address: address ? { line1: address.AddressLine1!.trim(), postalCode: address.PostalCode!.trim() } : null,
    deleted: theirs.Status === 'DELETED',
  };
}

/**
 * How a payment came in, from the account Xero says it went to: the method the
 * office chose that account for, when exactly one was. Otherwise "Other".
 */
export function methodFromAccount(accountId: string | null | undefined, paymentAccounts: Record<string, string>): InvoicePaymentMethod {
  if (!accountId) return InvoicePaymentMethod.OTHER;
  const methods = Object.entries(paymentAccounts).filter(([, account]) => account === accountId);
  const method = methods.length === 1 ? methods[0]![0] : null;
  return method && method in InvoicePaymentMethod ? (method as InvoicePaymentMethod) : InvoicePaymentMethod.OTHER;
}

/** Where a read of one kind carries on: what changed since, and which page of that. */
export interface BooksCursor {
  since: Date | null;
  page: number;
}

/**
 * Where the read goes after one page, ordered oldest change first. A short page
 * reached the end: next time, what changed since the newest seen, less the
 * overlap. A full page moves `since` on to its newest -- page 1 again -- or,
 * when a full page all changed within the overlap (an import), the next page
 * of the same `since`, so it can never stand still.
 */
export function nextCursor(cursor: BooksCursor, page: { count: number; newest: Date | null }): { cursor: BooksCursor; done: boolean } {
  const moved = page.newest ? new Date(page.newest.getTime() - BOOKS_OVERLAP_MS) : null;
  const later = moved && (!cursor.since || moved > cursor.since) ? moved : null;
  if (page.count < XERO_LEAST_PAGE) return { cursor: { since: later ?? cursor.since, page: 1 }, done: true };
  return later ? { cursor: { since: later, page: 1 }, done: false } : { cursor: { since: cursor.since, page: cursor.page + 1 }, done: false };
}

/** The newest of Xero's "updated" times on a page. */
export function newestOf(values: readonly (string | null | undefined)[]): Date | null {
  let newest: Date | null = null;
  for (const value of values) {
    const at = xeroInstant(value);
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

/** Xero's If-Modified-Since: a UTC time, to the second. */
export const modifiedSinceHeader = (since: Date) => since.toISOString().slice(0, 19);
