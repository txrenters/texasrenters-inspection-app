import { createHash } from 'node:crypto';

import { formatMoney, productNameKey, type XeroAccount, type XeroSettingsValues } from '@texasrenters/shared';

/**
 * A console invoice as Xero is sent it (2026-11-10, phase 3 of the Xero plan).
 *
 * Pure: what to send, or why not. Every amount is checked before anything
 * goes -- an invoice whose lines do not come to its total, or that carries
 * sales tax the console would not send, is held back with the reason in words,
 * never posted to the office's books wrong.
 */

export interface InvoiceForXero {
  id: string;
  number: string | null;
  subject: string;
  /** InvoiceStatus: DRAFT, AWAITING_PAYMENT, PAID, BAD_DEBT, VOIDED. */
  status: string;
  clientName: string;
  jobberClientId: string | null;
  jobNumber: string | null;
  issuedOn: Date | null;
  dueOn: Date | null;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  lines: { position: number; name: string; description: string | null; quantity: number; unitPriceCents: number; totalCents: number }[];
}

export interface XeroLineItem {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  LineAmount: number;
  AccountCode: string;
  TaxType: string;
}

export interface XeroInvoiceBody {
  InvoiceID?: string;
  Type: 'ACCREC';
  Contact: { ContactID: string };
  InvoiceNumber: string;
  Reference: string;
  Date: string;
  DueDate: string;
  LineAmountTypes: 'Exclusive';
  Status: 'AUTHORISED';
  LineItems: XeroLineItem[];
}

export type XeroVoidBody = { InvoiceID: string; Status: 'VOIDED' };

export type XeroInvoicePlan = { kind: 'send'; body: XeroInvoiceBody } | { kind: 'void'; body: XeroVoidBody } | { kind: 'problem'; problem: string };

/** The client is the property, as in Jobber: by Jobber's id, or -- for one Jobber did not name -- by its name. */
export const clientKeyOf = (invoice: Pick<InvoiceForXero, 'jobberClientId' | 'clientName'>) =>
  invoice.jobberClientId ? `jobber:${invoice.jobberClientId}` : `name:${productNameKey(invoice.clientName)}`;

/** Xero's contact name: the client's, trimmed to what Xero holds. */
export const contactNameOf = (invoice: Pick<InvoiceForXero, 'clientName'>) => invoice.clientName.trim().slice(0, 255) || 'Unnamed client';

const day = (value: Date) => value.toISOString().slice(0, 10);
const dollars = (cents: number) => Number((cents / 100).toFixed(2));
const sortedLines = (invoice: InvoiceForXero) => [...invoice.lines].sort((a, b) => a.position - b.position);

/**
 * What the invoice says, as a hash: sent again only when this changes. The
 * accounts and tax type are not in it -- choosing another account applies to
 * invoices from then on, and never rewrites one already in Xero's books. Paid
 * or written off reads as approved: payments are phase 4.
 */
export function invoiceFingerprint(invoice: InvoiceForXero): string {
  const content = {
    number: invoice.number,
    subject: invoice.subject,
    voided: invoice.status === 'VOIDED',
    client: clientKeyOf(invoice),
    clientName: contactNameOf(invoice),
    jobNumber: invoice.jobNumber,
    issuedOn: invoice.issuedOn ? day(invoice.issuedOn) : null,
    dueOn: invoice.dueOn ? day(invoice.dueOn) : null,
    taxCents: invoice.taxCents,
    discountCents: invoice.discountCents,
    totalCents: invoice.totalCents,
    lines: sortedLines(invoice).map((line) => [line.name, line.description, line.quantity, line.unitPriceCents, line.totalCents]),
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * The invoice for Xero: approved, under its client's contact, each line to its
 * product's account or the default, with the office's tax type. A voided one
 * already in Xero is voided there; one never sent is not sent.
 */
export function xeroInvoiceFrom(
  invoice: InvoiceForXero,
  context: { settings: XeroSettingsValues; accounts: readonly XeroAccount[]; contactId: string; xeroInvoiceId: string | null },
): XeroInvoicePlan {
  if (invoice.status === 'VOIDED')
    return context.xeroInvoiceId
      ? { kind: 'void', body: { InvoiceID: context.xeroInvoiceId, Status: 'VOIDED' } }
      : { kind: 'problem', problem: 'It was voided before it reached Xero, so it is not sent.' };
  if (invoice.status === 'DRAFT') return { kind: 'problem', problem: 'It is a draft.' };
  if (!invoice.number) return { kind: 'problem', problem: 'It has no invoice number yet.' };
  if (!invoice.issuedOn) return { kind: 'problem', problem: 'It has no issue date.' };
  if (invoice.taxCents !== 0)
    return { kind: 'problem', problem: `It carries ${formatMoney(invoice.taxCents)} of sales tax, and the console sends Xero none. Enter it in Xero by hand.` };
  if (!invoice.lines.length) return { kind: 'problem', problem: 'It has no lines.' };
  const { settings } = context;
  if (!settings.salesTaxType) return { kind: 'problem', problem: 'No tax type is chosen for lines.' };

  const codes = new Map(context.accounts.filter((account) => account.status === 'ACTIVE' && account.code).map((account) => [account.accountId, account.code!]));
  const defaultCode = settings.salesAccountId ? codes.get(settings.salesAccountId) : undefined;
  if (!defaultCode) return { kind: 'problem', problem: 'The default sales account is not an active account in Xero. Choose again on the Xero page.' };

  const items: XeroLineItem[] = [];
  for (const line of sortedLines(invoice)) {
    const chosen = settings.salesAccounts[productNameKey(line.name)];
    const code = chosen ? codes.get(chosen) : defaultCode;
    if (!code) return { kind: 'problem', problem: `The account chosen for “${line.name}” is not an active account in Xero. Choose again on the Xero page.` };
    const description = (line.description?.trim() ? `${line.name}\n${line.description.trim()}` : line.name).slice(0, 4000);
    // Xero works a line out as quantity × unit price. When the stored total is not exactly that, the line goes as one of its total.
    const exact = Number.isFinite(line.quantity) && line.quantity > 0 && Math.round(line.quantity * line.unitPriceCents) === line.totalCents;
    items.push({
      Description: exact ? description : `${description} (${line.quantity} × ${formatMoney(line.unitPriceCents)})`.slice(0, 4000),
      Quantity: exact ? line.quantity : 1,
      UnitAmount: exact ? dollars(line.unitPriceCents) : dollars(line.totalCents),
      LineAmount: dollars(line.totalCents),
      AccountCode: code,
      TaxType: settings.salesTaxType,
    });
  }
  if (invoice.discountCents > 0)
    items.push({
      Description: 'Discount',
      Quantity: 1,
      UnitAmount: -dollars(invoice.discountCents),
      LineAmount: -dollars(invoice.discountCents),
      AccountCode: defaultCode,
      TaxType: settings.salesTaxType,
    });

  const linesCents = invoice.lines.reduce((sum, line) => sum + line.totalCents, 0) - Math.max(invoice.discountCents, 0);
  if (linesCents !== invoice.totalCents)
    return {
      kind: 'problem',
      problem: `Its lines come to ${formatMoney(linesCents)} and its total is ${formatMoney(invoice.totalCents)}, so it is not sent. Correct it here, or enter it in Xero by hand.`,
    };
  if (invoice.totalCents < 0) return { kind: 'problem', problem: 'Its total is below zero; Xero takes that as a credit note, which phase 3 does not send.' };

  const reference = [invoice.subject.trim(), invoice.jobNumber ? `Job #${invoice.jobNumber}` : null].filter(Boolean).join(' · ').slice(0, 255);
  return {
    kind: 'send',
    body: {
      ...(context.xeroInvoiceId ? { InvoiceID: context.xeroInvoiceId } : {}),
      Type: 'ACCREC',
      Contact: { ContactID: context.contactId },
      InvoiceNumber: invoice.number,
      Reference: reference,
      Date: day(invoice.issuedOn),
      DueDate: day(invoice.dueOn ?? invoice.issuedOn),
      LineAmountTypes: 'Exclusive',
      Status: 'AUTHORISED',
      LineItems: items,
    },
  };
}
