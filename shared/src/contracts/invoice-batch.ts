/**
 * Making many invoices at once (2026-11-06, phase 4 of taking invoicing over
 * from Jobber), as Jobber's Batch Create: the finished visits nobody has
 * invoiced yet, each priced from what the technician reported done at the
 * office's own prices, made into one invoice each.
 */
import type { InvoiceLineInput, InvoiceProperty } from './invoices.js';

/**
 * The most visits one batch takes. A cap on a mistake, and on what one request
 * holds a lock for. A visit whose services go to several companies makes one
 * invoice for each (2026-11-10).
 */
export const MAX_BATCH_INVOICES = 100;

/** The most a list of visits to invoice reaches back, in days. */
export const MAX_UNINVOICED_RANGE_DAYS = 92;

/** A finished visit with no invoice yet, as it would be invoiced. */
export interface UninvoicedVisit {
  inspectionId: string;
  inspectionType: string;
  /** `YYYY-MM-DD` */
  scheduledOn: string;
  status: string;
  property: InvoiceProperty | null;
  clientName: string;
  /** One per service reported done, at the office's price for it. */
  lineItems: InvoiceLineInput[];
  totalCents: number;
  /** Why it cannot be invoiced as it stands, in words; null when it can. */
  problem: string | null;
  /**
   * The invoices it makes, one per company (2026-11-10): each company's lines,
   * and the lines that go to no company on one of their own.
   */
  invoices: UninvoicedPart[];
}

/** One company's invoice for a visit, as the batch would make it. */
export interface UninvoicedPart {
  xeroTenantId: string | null;
  /** The company's name, as Xero has it; null for none. */
  company: string | null;
  lineItems: InvoiceLineInput[];
  totalCents: number;
}

export interface UninvoicedVisitList {
  items: UninvoicedVisit[];
  /** More visits than are listed; narrow the days. */
  truncated: boolean;
  /** The office's payment terms for a new invoice, from its settings (2026-11-06). */
  paymentTermsDays?: number;
}

export interface BatchInvoiceInput {
  inspectionIds: string[];
  /** `YYYY-MM-DD`, for every invoice the batch makes. */
  issuedOn: string;
  paymentTermsDays: number;
  /** Made as drafts, to look over before they are marked sent. */
  asDraft?: boolean;
  /** The browser's key for the batch: a resend makes no second invoice for any visit. */
  clientRequestId: string;
}

export interface BatchInvoiceResult {
  /** Each invoice made, a visit's one after another; `company` is the name of the organisation it goes to, null for none. */
  created: { inspectionId: string; invoiceId: string; number: string | null; totalCents: number; company?: string | null }[];
  /** Each visit not invoiced, and why, in words. */
  skipped: { inspectionId: string; reason: string }[];
}
