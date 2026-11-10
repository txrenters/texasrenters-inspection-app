import {
  INVOICE_STATUS_LABEL,
  MAX_XERO_CHECK_DIFFERENCES,
  formatMoney,
  type InvoiceStatus,
  type XeroCheckCounts,
  type XeroDifference,
} from '@texasrenters/shared';

/**
 * One month of a company's invoices, the console's against Xero's (2026-11-10,
 * phase 5 of the multi-company plan). Pure: what differs, in words, invoice by
 * invoice. Amounts compared in whole cents.
 */

export interface ConsoleInvoiceForCheck {
  id: string;
  number: string | null;
  clientName: string;
  /** InvoiceStatus, not a draft. */
  status: string;
  totalCents: number;
  /** What its payments come to. */
  paidCents: number;
  /** Xero's id for it, once sent; null before. */
  xeroInvoiceId: string | null;
  /** Why it is not in Xero yet, when the console held it back or Xero refused it. */
  problem: string | null;
}

/** A sales invoice as Xero lists it. */
export interface XeroInvoiceForCheck {
  InvoiceID: string;
  InvoiceNumber?: string | null;
  /** AUTHORISED, PAID, VOIDED, DELETED, DRAFT, SUBMITTED. */
  Status?: string | null;
  Contact?: { Name?: string | null } | null;
  Total?: number | null;
  AmountPaid?: number | null;
}

const XERO_STATUS_WORDS: Record<string, string> = {
  AUTHORISED: 'approved, owing',
  PAID: 'paid',
  VOIDED: 'voided',
  DELETED: 'deleted',
  DRAFT: 'a draft',
  SUBMITTED: 'awaiting approval',
};

const cents = (amount: number | null | undefined) => Math.round((amount ?? 0) * 100);
const consoleStatus = (status: string) => INVOICE_STATUS_LABEL[status as InvoiceStatus]?.toLowerCase() ?? status.toLowerCase();
const xeroStatus = (status: string | null | undefined) => (status ? (XERO_STATUS_WORDS[status] ?? status.toLowerCase()) : 'no status');
const voidedInXero = (status: string | null | undefined) => status === 'VOIDED' || status === 'DELETED';

export function compareMonth(
  consoleInvoices: readonly ConsoleInvoiceForCheck[],
  xeroInvoices: readonly XeroInvoiceForCheck[],
  /** Payments stay out of Xero (2026-11-11): what is paid there is the office's own doing, not a difference. */
  options: { comparePaid?: boolean } = {},
): { counts: XeroCheckCounts; differences: XeroDifference[]; truncated: boolean } {
  const comparePaid = options.comparePaid !== false;
  const byId = new Map(xeroInvoices.map((invoice) => [invoice.InvoiceID, invoice]));
  const matched = new Set<string>();
  const differences: XeroDifference[] = [];
  const counts: XeroCheckCounts = { console: 0, xero: xeroInvoices.length, matching: 0, different: 0, notSent: 0, missingInXero: 0, onlyInXero: 0 };

  for (const invoice of consoleInvoices) {
    const voided = invoice.status === 'VOIDED';
    // Voided before it ever reached Xero: nothing there should have it.
    if (voided && !invoice.xeroInvoiceId) continue;
    counts.console++;
    const here = (detail: string) => `${formatMoney(invoice.totalCents)}, ${detail}`;
    const row = (kind: XeroDifference['kind'], hereWords: string, xeroWords: string): XeroDifference => ({
      kind,
      invoiceId: invoice.id,
      number: invoice.number,
      clientName: invoice.clientName,
      here: hereWords,
      xero: xeroWords,
    });
    if (!invoice.xeroInvoiceId) {
      counts.notSent++;
      differences.push(row('NOT_SENT', here(consoleStatus(invoice.status)), invoice.problem ? `Not sent: ${invoice.problem}` : 'Not sent yet'));
      continue;
    }
    const theirs = byId.get(invoice.xeroInvoiceId);
    if (!theirs) {
      counts.missingInXero++;
      differences.push(row('MISSING_IN_XERO', here(`sent, ${consoleStatus(invoice.status)}`), 'Not in Xero this month: deleted there, or dated another month'));
      continue;
    }
    matched.add(theirs.InvoiceID);
    const found: XeroDifference[] = [];
    if (voided !== voidedInXero(theirs.Status)) found.push(row('STATUS', consoleStatus(invoice.status), xeroStatus(theirs.Status)));
    else if (!voided) {
      if (cents(theirs.Total) !== invoice.totalCents) found.push(row('TOTAL', formatMoney(invoice.totalCents), formatMoney(cents(theirs.Total))));
      if (comparePaid && cents(theirs.AmountPaid) !== invoice.paidCents)
        found.push(row('PAID', `${formatMoney(invoice.paidCents)} paid`, `${formatMoney(cents(theirs.AmountPaid))} paid`));
    }
    if (found.length) {
      counts.different++;
      differences.push(...found);
    } else counts.matching++;
  }

  // Xero's that came from nowhere in the console: made there by hand, or by another app. A voided one matters to nobody.
  for (const theirs of xeroInvoices) {
    if (matched.has(theirs.InvoiceID) || voidedInXero(theirs.Status)) continue;
    counts.onlyInXero++;
    differences.push({
      kind: 'ONLY_IN_XERO',
      invoiceId: null,
      number: theirs.InvoiceNumber ?? null,
      clientName: theirs.Contact?.Name?.trim() || 'No contact',
      here: 'Not in the console',
      xero: `${formatMoney(cents(theirs.Total))}, ${xeroStatus(theirs.Status)}`,
    });
  }

  return { counts, differences: differences.slice(0, MAX_XERO_CHECK_DIFFERENCES), truncated: differences.length > MAX_XERO_CHECK_DIFFERENCES };
}

/** Xero's `where` for one month of sales invoices, by their date. `month` is `YYYY-MM`. */
export function monthWhere(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const next = index === 12 ? { year: year + 1, month: 1 } : { year, month: index + 1 };
  return `Type=="ACCREC"&&Date>=DateTime(${year},${index},1)&&Date<DateTime(${next.year},${next.month},1)`;
}
