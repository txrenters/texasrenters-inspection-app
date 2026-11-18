import { createHash } from 'node:crypto';

/**
 * A vendor bill as Xero is sent it (2026-11-19, phase 7 of the inventory and
 * purchasing plan): a draft bill (accounts payable) under the vendor's
 * contact, each line booked to the company's purchases account.
 *
 * Pure: what to send. The lines are sent with no tax of their own, and
 * whatever the vendor's total holds beyond them -- the sales tax, freight --
 * goes as one more line to the same account, so Xero's total is the bill's
 * total to the cent. The office sees a draft and can change any line there.
 *
 * A new bill, never a change to one: nothing here carries an InvoiceID.
 */

export interface BillForXero {
  billNumber: string;
  billDate: Date;
  totalCents: number;
  lines: { code: string; name: string; quantity: number; unitPriceCents: number }[];
}

export interface XeroBillBody {
  Type: 'ACCPAY';
  Contact: { ContactID: string };
  Date: string;
  /** The vendor's own number for it. */
  InvoiceNumber: string;
  Status: 'DRAFT';
  LineAmountTypes: 'NoTax';
  /** The order's page in the console: the link Xero keeps, which also finds the bill there again. */
  Url: string;
  LineItems: { Description: string; Quantity: number; UnitAmount: number; AccountCode: string }[];
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const dollars = (cents: number) => Number((cents / 100).toFixed(2));

export function xeroBillFrom(bill: BillForXero, context: { contactId: string; accountCode: string; url: string }): XeroBillBody {
  const lines = bill.lines.map((line) => ({
    Description: `${line.code} ${line.name}`.slice(0, 4000),
    Quantity: line.quantity,
    UnitAmount: dollars(line.unitPriceCents),
    AccountCode: context.accountCode,
  }));
  const beyond = bill.totalCents - bill.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  if (beyond !== 0) lines.push({ Description: beyond > 0 ? 'Sales tax and other charges' : 'Discount', Quantity: 1, UnitAmount: dollars(beyond), AccountCode: context.accountCode });
  return {
    Type: 'ACCPAY',
    Contact: { ContactID: context.contactId },
    Date: day(bill.billDate),
    InvoiceNumber: bill.billNumber.slice(0, 255),
    Status: 'DRAFT',
    LineAmountTypes: 'NoTax',
    Url: context.url,
    LineItems: lines,
  };
}

export interface XeroBillPaymentBody {
  Invoice: { InvoiceID: string };
  Account: { AccountID: string };
  Date: string;
  Amount: number;
  Reference: string;
}

export function xeroBillPaymentFrom(payment: { paidOn: Date; amountCents: number; reference: string }, context: { xeroInvoiceId: string; accountId: string }): XeroBillPaymentBody {
  return {
    Invoice: { InvoiceID: context.xeroInvoiceId },
    Account: { AccountID: context.accountId },
    Date: day(payment.paidOn),
    Amount: dollars(payment.amountCents),
    Reference: payment.reference.slice(0, 255),
  };
}

/** The key that makes a resend of the same body return Xero's first answer: this office, this company, this bill, this body. */
export const billIdempotencyKey = (scope: string, path: string, body: unknown) => createHash('sha256').update(`${scope}|${path}|${JSON.stringify(body)}`).digest('hex');

/** A day as Xero's `where` filter writes one: `DateTime(2026,11,5)`. */
export const xeroDateFilter = (value: string) => `DateTime(${value.split('-').map(Number).join(',')})`;

/** The order's page in the console. */
export const consoleOrderUrl = (orderId: string) => `${(process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '')}/purchasing/orders/${orderId}`;
