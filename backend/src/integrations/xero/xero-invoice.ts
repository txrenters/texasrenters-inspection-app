import { createHash } from 'node:crypto';

import {
  activeTrackingCategories,
  formatMoney,
  productNameKey,
  soldItems,
  trackingOptionFor,
  type XeroAccount,
  type XeroItem,
  type XeroSettingsValues,
  type XeroTrackingCategory,
} from '@texasrenters/shared';

/**
 * A console invoice as Xero is sent it (2026-11-10, phase 3 of the Xero plan).
 *
 * Pure: what to send, or why not. Every amount is checked before anything
 * goes -- an invoice whose lines do not come to its total, or that carries
 * sales tax the console would not send, is held back with the reason in words,
 * never posted to the office's books wrong.
 *
 * As the office finishes its invoices in Xero by hand (2026-11-11, from
 * Jobber's through Zapier until then): dated on the visit's day, due on the
 * last day of that month, the property -- the contact's name -- as the
 * reference, each line under its Xero item and tagged for the technician who
 * did the visit.
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
  /** The day of the visit it bills (`YYYY-MM-DD`, as scheduled); null for one that bills no visit. */
  visitDay: string | null;
  /** The technician who did that visit; null when none is known. */
  technicianName: string | null;
  /** JOBBER or CONSOLE (2026-11-12): the console's own goes as a draft Xero numbers. */
  origin?: string;
  /** The property it bills: the console's own goes under that property's contact in Xero. */
  propertywareBuildingId?: string | null;
}

export interface XeroLineItem {
  ItemCode?: string;
  Description: string;
  Quantity: number;
  UnitAmount: number;
  LineAmount: number;
  AccountCode: string;
  TaxType: string;
  Tracking?: { TrackingCategoryID: string; Name: string; Option: string }[];
}

/**
 * A new invoice, never a change to one (2026-11-12): once an invoice is in
 * Xero it is the office's there, and nothing the console sends overwrites it.
 */
export interface XeroInvoiceBody {
  Type: 'ACCREC';
  Contact: { ContactID: string };
  /** Left out for the console's own draft (2026-11-12): Xero numbers it. */
  InvoiceNumber?: string;
  Reference: string;
  Date: string;
  DueDate: string;
  LineAmountTypes: 'Exclusive';
  /** Approved; or, for a company whose visits get projects (2026-11-11), a draft for the office to put on its project and approve. */
  Status: 'AUTHORISED' | 'DRAFT';
  LineItems: XeroLineItem[];
  /** The console's own (2026-11-12): its page here, which also finds it in Xero again. */
  Url?: string;
}

export type XeroInvoicePlan = { kind: 'send'; body: XeroInvoiceBody } | { kind: 'problem'; problem: string };

/** The client is the property, as in Jobber: by Jobber's id, or -- for one Jobber did not name -- by its name. */
export const clientKeyOf = (invoice: Pick<InvoiceForXero, 'jobberClientId' | 'clientName' | 'origin' | 'propertywareBuildingId'>) =>
  invoice.jobberClientId
    ? `jobber:${invoice.jobberClientId}`
    : // The console's own (2026-11-12): under its property's contact, as Xero's books have it.
      invoice.origin === 'CONSOLE' && invoice.propertywareBuildingId
      ? `property:${invoice.propertywareBuildingId}`
      : `name:${productNameKey(invoice.clientName)}`;

/** Xero's contact name: the client's, trimmed to what Xero holds. */
export const contactNameOf = (invoice: Pick<InvoiceForXero, 'clientName'>) => invoice.clientName.trim().slice(0, 255) || 'Unnamed client';

const day = (value: Date) => value.toISOString().slice(0, 10);

/** The invoice's date in Xero: the visit's day, as the office dates them; else the day it was issued. */
export const xeroDayOf = (invoice: Pick<InvoiceForXero, 'visitDay' | 'issuedOn'>): string | null =>
  invoice.visitDay ?? (invoice.issuedOn ? day(invoice.issuedOn) : null);

/** The last day of a day's month: when the office's invoices fall due in Xero. */
export function monthEndOf(value: string): string {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
const dollars = (cents: number) => Number((cents / 100).toFixed(2));
const sortedLines = (invoice: InvoiceForXero) => [...invoice.lines].sort((a, b) => a.position - b.position);

/**
 * What the invoice says, as a hash, as it was when it went to Xero: one that
 * says something else now changed here after it went (2026-11-12), and the
 * office makes the change in Xero. The accounts and tax type are not in it.
 * Paid or written off reads as approved.
 */
export function invoiceFingerprint(invoice: InvoiceForXero): string {
  const content = {
    number: invoice.number,
    voided: invoice.status === 'VOIDED',
    client: clientKeyOf(invoice),
    clientName: contactNameOf(invoice),
    day: xeroDayOf(invoice),
    technician: invoice.technicianName?.trim() || null,
    taxCents: invoice.taxCents,
    discountCents: invoice.discountCents,
    totalCents: invoice.totalCents,
    lines: sortedLines(invoice).map((line) => [line.name, line.description, line.quantity, line.unitPriceCents, line.totalCents]),
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * The invoice, new in Xero: approved, under its client's contact, each line to
 * its product's account or the default, with the office's tax type. Only for
 * one not in Xero yet: one voided before it got there is not sent.
 */
export function xeroInvoiceFrom(
  invoice: InvoiceForXero,
  context: {
    settings: XeroSettingsValues;
    accounts: readonly XeroAccount[];
    /** As last read (2026-11-11); left out, no line is tagged or itemed. */
    trackingCategories?: readonly XeroTrackingCategory[];
    items?: readonly XeroItem[];
    contactId: string;
    /** Its company's visits get projects (2026-11-11): it goes as a draft. */
    asDraft?: boolean;
    /**
     * The console's own (2026-11-12): its page here. It goes as a complete
     * draft, numbered by Xero, for the office to approve there -- a draft
     * here is what it is meant to be.
     */
    consoleUrl?: string;
  },
): XeroInvoicePlan {
  const consoleDraft = Boolean(context.consoleUrl);
  if (invoice.status === 'VOIDED') return { kind: 'problem', problem: 'It was voided before it reached Xero, so it is not sent.' };
  if (invoice.status === 'DRAFT' && !consoleDraft) return { kind: 'problem', problem: 'It is a draft.' };
  if (!invoice.number && !consoleDraft) return { kind: 'problem', problem: 'It has no invoice number yet.' };
  if (!invoice.issuedOn) return { kind: 'problem', problem: 'It has no issue date.' };
  if (invoice.taxCents !== 0)
    return { kind: 'problem', problem: `It carries ${formatMoney(invoice.taxCents)} of sales tax, and the console sends Xero none. Enter it in Xero by hand.` };
  if (!invoice.lines.length) return { kind: 'problem', problem: 'It has no lines.' };
  const { settings } = context;
  if (!settings.salesTaxType) return { kind: 'problem', problem: 'No tax type is chosen for lines.' };

  const codes = new Map(context.accounts.filter((account) => account.status === 'ACTIVE' && account.code).map((account) => [account.accountId, account.code!]));
  const defaultCode = settings.salesAccountId ? codes.get(settings.salesAccountId) : undefined;
  if (!defaultCode) return { kind: 'problem', problem: 'The default sales account is not an active account in Xero. Choose again on the Xero page.' };

  // The category lines are tagged in, and the items they name (2026-11-11): as last read, active.
  const category = settings.trackingCategoryId
    ? activeTrackingCategories(context.trackingCategories ?? []).find((each) => each.trackingCategoryId === settings.trackingCategoryId)
    : null;
  if (settings.trackingCategoryId && !category)
    return { kind: 'problem', problem: 'The tracking category is not an active one in Xero. Choose again on the Xero page.' };
  const sold = new Set(soldItems(context.items ?? []).map((item) => item.code));
  const technician = invoice.technicianName?.trim() || null;

  const items: XeroLineItem[] = [];
  for (const line of sortedLines(invoice)) {
    const chosen = settings.salesAccounts[productNameKey(line.name)];
    const code = chosen ? codes.get(chosen) : defaultCode;
    if (!code) return { kind: 'problem', problem: `The account chosen for “${line.name}” is not an active account in Xero. Choose again on the Xero page.` };
    const description = (line.description?.trim() ? `${line.name}\n${line.description.trim()}` : line.name).slice(0, 4000);
    const itemCode = settings.itemCodes?.[productNameKey(line.name)];
    if (itemCode && !sold.has(itemCode))
      return { kind: 'problem', problem: `The item “${itemCode}” chosen for “${line.name}” is not one Xero sells. Choose again on the Xero page.` };
    // The technician's option, when the line's product is tracked and the visit's technician is known.
    const group = category ? settings.trackingGroups?.[productNameKey(line.name)] : undefined;
    const option = category && group && technician ? trackingOptionFor(category, group, technician) : null;
    if (category && group && technician && !option)
      return {
        kind: 'problem',
        problem: `${category.name} has no option “${group}: ${technician.split(/\s+/)[0]}” for ${technician}. Add it in Xero, then read from Xero again.`,
      };
    // Xero works a line out as quantity × unit price. When the stored total is not exactly that, the line goes as one of its total.
    const exact = Number.isFinite(line.quantity) && line.quantity > 0 && Math.round(line.quantity * line.unitPriceCents) === line.totalCents;
    items.push({
      ...(itemCode ? { ItemCode: itemCode } : {}),
      Description: exact ? description : `${description} (${line.quantity} × ${formatMoney(line.unitPriceCents)})`.slice(0, 4000),
      Quantity: exact ? line.quantity : 1,
      UnitAmount: exact ? dollars(line.unitPriceCents) : dollars(line.totalCents),
      LineAmount: dollars(line.totalCents),
      AccountCode: code,
      TaxType: settings.salesTaxType,
      ...(category && option ? { Tracking: [{ TrackingCategoryID: category.trackingCategoryId, Name: category.name, Option: option.name }] } : {}),
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

  // The property, as the office writes it: the contact's name.
  const reference = contactNameOf(invoice);
  const date = xeroDayOf(invoice)!;
  return {
    kind: 'send',
    body: {
      Type: 'ACCREC',
      Contact: { ContactID: context.contactId },
      ...(invoice.number ? { InvoiceNumber: invoice.number } : {}),
      Reference: reference,
      Date: date,
      DueDate: monthEndOf(date),
      LineAmountTypes: 'Exclusive',
      // As a draft (2026-11-11): approving it is the office's, in Xero.
      Status: context.asDraft || consoleDraft ? 'DRAFT' : 'AUTHORISED',
      LineItems: items,
      ...(context.consoleUrl ? { Url: context.consoleUrl } : {}),
    },
  };
}
