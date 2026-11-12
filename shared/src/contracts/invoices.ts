import type { InvoiceClientView } from './invoice-templates.js';
import type { InvoiceDeliveryView } from './invoice-delivery.js';
import type { InvoiceProductOrganisation } from './invoice-settings.js';

/**
 * Invoices and the payments recorded against them, in the console (the office,
 * 2026-11-05: "we will need the invoices and payments to be integrated to our
 * inspection console too ... we will use that feature").
 *
 * Jobber stays the record. The office bills each visit there -- an invoice
 * made out to the property, its lines the services done ("Filter Change,
 * 1 × $39.99") -- and records the payment by hand once the charge has posted
 * to the tenant's ledger in Propertyware; Jobber Payments is not set up, and
 * no card is ever charged. The console shows the same invoices, makes an
 * invoice from a finished visit, and records a payment; each goes to Jobber.
 *
 * Money is whole cents everywhere. A dollar amount in floating point cannot
 * say $0.10 exactly, and an invoice that is a cent out is wrong.
 */

/** Jobber's states, in the order its list sorts them. */
export const INVOICE_STATUSES = ['DRAFT', 'AWAITING_PAYMENT', 'PAST_DUE', 'PAID', 'BAD_DEBT', 'VOIDED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: 'Draft',
  AWAITING_PAYMENT: 'Awaiting payment',
  PAST_DUE: 'Past due',
  PAID: 'Paid',
  BAD_DEBT: 'Bad debt',
  VOIDED: 'Voided',
};

/** The list's status filter, as Jobber's: "Awaiting payment: past due", ": not yet due", ": all". */
export const INVOICE_FILTERS = ['all', 'past_due', 'not_yet_due', 'awaiting_payment', 'draft', 'paid', 'bad_debt', 'voided'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export const INVOICE_FILTER_LABEL: Record<InvoiceFilter, string> = {
  all: 'All',
  past_due: 'Awaiting payment: past due',
  not_yet_due: 'Awaiting payment: not yet due',
  awaiting_payment: 'Awaiting payment: all',
  draft: 'Draft',
  paid: 'Paid',
  bad_debt: 'Bad debt',
  voided: 'Voided',
};

/**
 * How a payment came in. The office's own way first: the charge posted to the
 * tenant's ledger in Propertyware, then recorded here.
 */
export const PAYMENT_METHODS = [
  'PROPERTYWARE_LEDGER',
  'CHECK',
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  // Jobber's own list (2026-11-05), so a payment read from it, or recorded
  // here after the cutover, says how it was really paid.
  'ZELLE',
  'CASH_APP',
  'PAYPAL',
  'VENMO',
  'MONEY_ORDER',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  PROPERTYWARE_LEDGER: 'Propertyware ledger',
  CHECK: 'Check',
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank payment',
  CARD: 'Credit/debit card',
  ZELLE: 'Zelle',
  CASH_APP: 'Cash App',
  PAYPAL: 'PayPal',
  VENMO: 'Venmo',
  MONEY_ORDER: 'Money order',
  OTHER: 'Other',
};

/** Jobber's payment terms, in days after the invoice is issued. */
export const PAYMENT_TERMS = [
  { days: 0, label: 'Due upon receipt' },
  { days: 7, label: 'Net 7' },
  { days: 15, label: 'Net 15' },
  { days: 30, label: 'Net 30' },
  { days: 45, label: 'Net 45' },
  { days: 60, label: 'Net 60' },
] as const;

export interface InvoicePerson {
  id: string;
  displayName: string;
}

/** One line of an invoice: a product or service, how many, at what. */
export interface InvoiceLineItem {
  name: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  /** Whether tax applies; null when Jobber did not say. */
  taxable?: boolean | null;
  /** `YYYY-MM-DD`, the day the service was done, when the line names one. */
  serviceOn?: string | null;
  /** The product or service it was picked from in Jobber's list, and what kind ("SERVICE"). */
  productName?: string | null;
  category?: string | null;
}

/** A custom field on an invoice, as Jobber shows it: its label and its value as text. */
export interface InvoiceCustomField {
  label: string;
  value: string;
}

/** A note on the invoice, or on the job (client, quote, request) Jobber shows it beside. */
export interface InvoiceNoteView {
  id: string;
  kind: 'INVOICE' | 'JOB' | 'CLIENT' | 'QUOTE' | 'REQUEST';
  message: string;
  pinned: boolean;
  writtenAt: string;
  /** Read from Jobber, or written in the console (2026-11-10), and by whom. */
  origin?: 'JOBBER' | 'CONSOLE';
  author?: string | null;
}

/** An image or attachment on the invoice. */
export interface InvoiceFileView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Jobber's address for it. The console opens a file through `InvoiceFileLink`, which prefers its own copy. */
  url: string | null;
  uploadedAt: string;
  /** The console keeps its own copy (2026-11-06, phase 7), so it opens after the office leaves Jobber. */
  kept?: boolean;
  /** Why the copy has not been made yet, in words; null when nothing went wrong. */
  copyProblem?: string | null;
  /** Read from Jobber, or added in the console (2026-11-10). */
  origin?: 'JOBBER' | 'CONSOLE';
}

/** A short-lived address to open one file at (2026-11-06): the console's copy, else Jobber's. */
export interface InvoiceFileLink {
  url: string;
  kept: boolean;
}

/** A payment recorded against an invoice. */
export interface InvoicePayment {
  id: string;
  /** The day the money came in, `YYYY-MM-DD` in Texas. */
  paidOn: string;
  amountCents: number;
  method: PaymentMethod;
  /** A check number, a Propertyware receipt -- whatever finds it again. */
  reference: string | null;
  note: string | null;
  /** Who recorded it; null for one recorded in Jobber. */
  recordedBy: InvoicePerson | null;
  recordedAt: string;
  /** Where it was recorded: in Jobber, in the console, or -- read back from the company's books (2026-11-12) -- in Xero. */
  origin?: 'JOBBER' | 'CONSOLE' | 'XERO';
}

/** Where an invoice's property is, as the console knows it. */
export interface InvoiceProperty {
  id: string;
  address: string;
  city: string | null;
}

/** The company's books an invoice goes to (2026-11-10): one of the office's Xero organisations. */
export interface InvoiceCompanyView {
  tenantId: string;
  name: string;
}

/** An invoice as the list shows it. */
export interface InvoiceSummary {
  id: string;
  /** Jobber's number, "8439". Null for a draft Jobber has not numbered. */
  number: string | null;
  subject: string;
  status: InvoiceStatus;
  /** Who it is made out to, as Jobber names the client: the property's address. */
  clientName: string;
  property: InvoiceProperty | null;
  /** The visit it bills, when the console can match it. */
  inspectionId: string | null;
  /** Jobber's job number, "20625". */
  jobNumber: string | null;
  /** `YYYY-MM-DD`; null on a draft. */
  issuedOn: string | null;
  dueOn: string | null;
  totalCents: number;
  balanceCents: number;
  /** Jobber's own page for it, for anything only Jobber can do. */
  jobberUrl: string | null;
  /**
   * The company's books it goes to (2026-11-10, phase 3 of the multi-company
   * plan); null when it belongs to no company, and then it is never sent to Xero.
   */
  company?: InvoiceCompanyView | null;
  /**
   * As it is in its company's books in Xero (2026-11-12), read back from there;
   * null for one the console has not read from Xero.
   */
  xero?: InvoiceInXero | null;
}

/** An invoice as its company's books in Xero have it (2026-11-12). */
export interface InvoiceInXero {
  /** Xero's own: DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED or DELETED. */
  status: string;
  /** Opens it in Xero. */
  url: string;
  /**
   * Changed only in Xero: its edits, payments, voids and emails are Xero's,
   * and the console reads them back.
   */
  kept: boolean;
}

/** Xero's status in the office's words. */
export const XERO_INVOICE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft in Xero',
  SUBMITTED: 'Awaiting approval in Xero',
  AUTHORISED: 'Awaiting payment',
  PAID: 'Paid',
  VOIDED: 'Voided in Xero',
  DELETED: 'Deleted in Xero',
};

/**
 * Xero's own page for an invoice: through the organisation's short code when
 * the console has it, so Xero opens the right company's books; a draft opens
 * to be edited, any other to be read.
 */
export function xeroInvoiceUrl(xeroInvoiceId: string, status: string | null, shortCode: string | null): string {
  const page = `/AccountsReceivable/${status === 'DRAFT' || status === 'SUBMITTED' ? 'Edit' : 'View'}.aspx?InvoiceID=${encodeURIComponent(xeroInvoiceId)}`;
  return shortCode
    ? `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(shortCode)}&redirecturl=${encodeURIComponent(page)}`
    : `https://go.xero.com${page}`;
}

/** An invoice in full, as its record page shows it. */
export interface InvoiceDetail extends InvoiceSummary {
  /** "Net 30"; null when Jobber has none. */
  paymentTerms: string | null;
  billingAddress: string | null;
  lineItems: InvoiceLineItem[];
  subtotalCents: number;
  taxCents: number;
  payments: InvoicePayment[];
  /** What the client reads at the foot of the invoice. */
  clientMessage: string | null;
  /** Everything else this client owes, as Jobber shows "Account balance". */
  accountBalanceCents: number | null;
  createdAt: string;
  /** Every other detail Jobber keeps (2026-11-05), ahead of the cutover. */
  details?: InvoiceExtraDetails;
  /** When it was last changed: sent back with an edit, so two people cannot both win (2026-11-06). */
  updatedAt?: string;
  /** What its payments come to: an edit cannot bring the invoice below it. */
  paidCents?: number;
  /**
   * Whether the console edits invoices yet (`JOBBER_INVOICE_WRITES_ENABLED`).
   * Off until the cutover: until then Jobber holds them, and an edit here would
   * be undone by the next read of Jobber's copy.
   */
  writesEnabled?: boolean;
  /** Who the invoice is from, for its PDF, as the inspection reports name the company (2026-11-06). */
  brand?: ReceiptBrand;
  /** Each time it was sent to the client from the console, newest first. */
  deliveries?: InvoiceDeliveryView[];
  /** Jobber's "Client view" (2026-11-10): what the client sees on the PDF and the email. */
  clientView?: InvoiceClientView;
}

/** The rest of what Jobber keeps on an invoice. */
export interface InvoiceExtraDetails {
  /** Jobber's contract / disclaimer: the "Thank you for your business" text at the foot. */
  contractDisclaimer: string | null;
  billingName: string | null;
  /** Where the work was, as Jobber has the invoice's property. */
  propertyAddress: string | null;
  billingSameAsProperty: boolean | null;
  /** Primary first. */
  clientEmails: string[];
  clientPhones: string[];
  /** `YYYY-MM-DD`, the day it was paid in full. */
  paidOn: string | null;
  /** When the client first opened it. */
  viewedAt: string | null;
  salespersonName: string | null;
  jobTitle: string | null;
  discountCents: number;
  /** The percent, when the discount was set as one. */
  discountPercent: number | null;
  depositCents: number;
  tipsCents: number;
  taxRateName: string | null;
  taxRatePercent: number | null;
  /** Prices include the tax, rather than adding it. */
  taxInclusive: boolean | null;
  customFields: InvoiceCustomField[];
  notes: InvoiceNoteView[];
  files: InvoiceFileView[];
}

/** One payment on its own page (2026-11-05: "payment items are not clickable"). */
export interface PaymentDetail extends PaymentListItem {
  origin: 'JOBBER' | 'CONSOLE' | 'XERO';
  /** Jobber's own word for how it was paid ("ACH_BANK_PAYMENT"), when it came from Jobber. */
  jobberPaymentType: string | null;
  invoiceTotalCents: number;
  invoiceBalanceCents: number;
  /** The invoice's state, so a page knows whether it can still take a change. */
  invoiceStatus: InvoiceStatus;
  /** When the payment was last changed: sent back with a change, so two people cannot both win. */
  updatedAt: string;
  /**
   * Whether the console changes payments yet (`JOBBER_INVOICE_WRITES_ENABLED`).
   * Off until the cutover: until then Jobber holds the payments, and a change
   * made here would be undone by the next read of Jobber's copy.
   */
  writesEnabled: boolean;
  /** Who the receipt is from, as the inspection reports name the company. */
  brand: ReceiptBrand;
  /** Each receipt emailed for it, newest first. */
  receipts?: InvoiceDeliveryView[];
  /** Who a receipt would go to: whoever the invoice was last sent to, else the client's addresses. */
  receiptTo?: string[];
  /**
   * Read from Xero, or against an invoice kept there (2026-11-12): changed,
   * removed and receipted in Xero, never here.
   */
  keptInXero?: boolean;
}

/** The company a receipt is from. */
export interface ReceiptBrand {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * A payment corrected (2026-11-06, phase 2 of taking invoicing over from
 * Jobber): the amount, the day, how it was paid, its reference and note. The
 * balance is worked out again from it, never taken from the browser.
 */
export interface ChangePaymentInput {
  amountCents: number;
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
  note?: string | null;
  /** `PaymentDetail.updatedAt` as it was read. A payment changed since is refused rather than overwritten. */
  expectedUpdatedAt: string;
}

/** What a payment can come to when it is corrected: everything still owed, and what this payment already covers. */
export const owedBeforePayment = (payment: Pick<PaymentDetail, 'invoiceBalanceCents' | 'amountCents'>) =>
  payment.invoiceBalanceCents + payment.amountCents;

/**
 * Why a payment cannot be changed or removed, in words; null when it can.
 * A refund (money back out) is not a payment to correct, and a voided, bad
 * debt or draft invoice is closed to payments.
 */
export function paymentLockedReason(payment: Pick<PaymentDetail, 'amountCents' | 'invoiceStatus'>): string | null {
  if (payment.amountCents <= 0) return 'A refund is not changed here.';
  if (payment.invoiceStatus === 'VOIDED' || payment.invoiceStatus === 'BAD_DEBT' || payment.invoiceStatus === 'DRAFT')
    return `The invoice is ${INVOICE_STATUS_LABEL[payment.invoiceStatus].toLowerCase()}, so its payments are not changed.`;
  return null;
}

/** A count and the money in it, for the list's Overview. */
export interface InvoiceBucket {
  count: number;
  amountCents: number;
}

export interface InvoiceList {
  items: InvoiceSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Jobber's Overview card: what is owed, and what is not sent yet. */
  overview: { pastDue: InvoiceBucket; notYetDue: InvoiceBucket; draft: InvoiceBucket };
  /** Issued in the past 30 days, and the 30 before, for the trend. */
  issued: { last30: InvoiceBucket; previous30: InvoiceBucket };
  /** How many invoices each filter holds, for the Status pill. */
  filterCounts: Record<InvoiceFilter, number>;
  /** When the copy was last brought up to date from Jobber; null before the first. */
  syncedAt: string | null;
  /** Where reading Jobber's invoices stands, so an empty list can say why. */
  jobberRead: InvoiceJobberRead;
  /** Whether the console makes invoices yet: off until the cutover (2026-11-06). */
  writesEnabled?: boolean;
  /** The office's Xero organisations, connected ones first, to filter by company (2026-11-10). Empty until Xero is connected. */
  organisations?: InvoiceProductOrganisation[];
  /**
   * The companies whose invoices are shown as their books in Xero have them
   * (2026-11-12), and when each was last read from there. Empty while every
   * company's are Jobber's copies.
   */
  xeroBooks?: InvoiceXeroBooks[];
}

/** A company whose invoices the pages show as Xero has them. */
export interface InvoiceXeroBooks {
  tenantId: string;
  name: string;
  /** The last read from Xero; null before the next. */
  readAt: string | null;
}

/**
 * Why the copy may be empty or behind (2026-11-05):
 * - NOT_CONNECTED: Jobber is not connected.
 * - NOT_PERMITTED: Jobber hides invoices from the app, because its Invoices
 *   scope is off in Jobber's Developer Center.
 * - FAILED: the last read failed. It is tried again within the hour.
 */
export type InvoiceJobberProblem = 'NOT_CONNECTED' | 'NOT_PERMITTED' | 'FAILED';

export interface InvoiceJobberRead {
  problem: InvoiceJobberProblem | null;
  /** When the console last asked Jobber; null before it ever has. */
  checkedAt: string | null;
  /** The first read of every invoice has finished. Until then, more appear every few minutes. */
  firstReadDone: boolean;
}

/** A recorded payment, with the invoice it paid, as the Payments list shows it. */
export interface PaymentListItem extends InvoicePayment {
  invoice: { id: string; number: string | null; subject: string; clientName: string };
  property: InvoiceProperty | null;
}

export interface PaymentList {
  items: PaymentListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  received: { last30: InvoiceBucket; previous30: InvoiceBucket };
}

/** A line as it is entered: the total is worked out, never typed. */
export interface InvoiceLineInput {
  name: string;
  description?: string | null;
  quantity: number;
  unitPriceCents: number;
  /**
   * The line's discount, a percent off (2026-11-13), as Xero's "Disc." column
   * has it; null or left out for none.
   */
  discountRate?: number | null;
  /**
   * What the line is sent to Xero with, as the Xero-style form shows it
   * (2026-11-13): its account, item, tax rate and tracking. Each left out goes
   * as its product's choice, or the company's -- as every line went before.
   */
  xeroAccountId?: string | null;
  xeroItemCode?: string | null;
  xeroTaxType?: string | null;
  /** One option in each of up to two tracking categories; left out, the technician's option in the company's category. */
  xeroTracking?: XeroLineTracking[] | null;
  /**
   * The project the line is for (2026-11-13), one of the company's in Xero.
   * Kept here only: Xero's API cannot put a line on a project, so the office
   * picks the same one on the draft in Xero.
   */
  xeroProjectId?: string | null;
}

/** A line's option in one of its company's tracking categories: "HVAC Inspection Income: Moses" in "Income by Employee". */
export interface XeroLineTracking {
  trackingCategoryId: string;
  option: string;
}

/** How a Xero invoice's amounts carry tax, as Xero's "Tax" field has it (2026-11-13). */
export type XeroTaxMode = 'EXCLUSIVE' | 'INCLUSIVE' | 'NO_TAX';
export const XERO_TAX_MODES: readonly XeroTaxMode[] = ['EXCLUSIVE', 'INCLUSIVE', 'NO_TAX'];
export const XERO_TAX_MODE_LABEL: Record<XeroTaxMode, string> = { EXCLUSIVE: 'Tax exclusive', INCLUSIVE: 'Tax inclusive', NO_TAX: 'No tax' };
/** Xero's own words for each, as an invoice's `LineAmountTypes`. */
export const XERO_LINE_AMOUNT_TYPES: Record<XeroTaxMode, 'Exclusive' | 'Inclusive' | 'NoTax'> = { EXCLUSIVE: 'Exclusive', INCLUSIVE: 'Inclusive', NO_TAX: 'NoTax' };
/** A line's tracking: at most one option in each of Xero's two categories. */
export const MAX_LINE_TRACKING = 2;

/**
 * What a finished visit would be invoiced for, before anybody edits it: one
 * line per service done, at the price in Jobber's products list. For a
 * property with no visit (2026-11-06), no lines: the office adds them.
 */
/** One company's invoice in a draft (2026-11-10): the company and its lines. */
export interface InvoiceDraftPart {
  /** The organisation; null for lines that go to no company. */
  xeroTenantId: string | null;
  lineItems: InvoiceLineInput[];
}

/** An invoice the visit already has, so a second is not made by mistake. */
export interface InvoiceDraftExisting {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  /** The organisation it goes to; null for none. */
  xeroTenantId: string | null;
}

/** A product or service the office sells, for a line added by hand. */
export interface InvoiceDraftProduct {
  name: string;
  unitPriceCents: number;
  description?: string | null;
  /** The organisation it goes to (2026-11-10); null or left out for none. */
  xeroTenantId?: string | null;
}

export interface InvoiceDraft {
  /**
   * The visit it bills; null for an invoice made out to a property directly.
   * Its technician (2026-11-13) tags each line for Xero: "HVAC Inspection
   * Income: Moses"; null when none is known.
   */
  inspection: { id: string; inspectionType: string; scheduledOn: string; status: string; technicianName?: string | null } | null;
  property: InvoiceProperty | null;
  clientName: string;
  subject: string;
  issuedOn: string;
  paymentTermsDays: number;
  /**
   * The invoices it makes, one per company (2026-11-10, phase 3 of the
   * multi-company plan): each company's lines, and the lines that go to none on
   * one of their own. One, with no company, when nothing goes to a company; one
   * with no lines for an invoice made out to a property.
   */
  invoices: InvoiceDraftPart[];
  clientMessage: string;
  /** What the visit is invoiced on already, newest first, so a second is not made by mistake. */
  existing: InvoiceDraftExisting[];
  /**
   * The visit has an invoice already, of any origin (2026-11-13) -- Jobber's
   * copies kept out of sight behind Xero's too: another is made only when the
   * form says so (`additional`).
   */
  alreadyInvoiced: boolean;
  /** The products the office sells, for a line added by hand: its own list first (2026-11-06), then what it billed. */
  products: InvoiceDraftProduct[];
  /** The office's Xero organisations, connected ones first (2026-11-10): what an invoice can go to. Empty until Xero is connected. */
  organisations: InvoiceProductOrganisation[];
  /**
   * The console makes the invoices (2026-11-13): each goes to its company's
   * books in Xero as a draft Xero numbers and dates, so the form asks no
   * payment terms and offers no draft of its own.
   */
  madeInConsole: boolean;
}

export interface CreateInvoiceInput {
  /** The finished visit it bills; or `propertyId` for an invoice no visit covers. One of the two. */
  inspectionId?: string;
  /** The property (a Propertyware building) it is made out to, when it bills no visit (2026-11-06). */
  propertyId?: string;
  /** Kept as a draft, unnumbered and owed by nobody until it is marked sent. */
  asDraft?: boolean;
  /**
   * Another invoice for a visit that has one already (2026-11-13), said on
   * purpose: without it, a visit invoiced before -- here, in Jobber or in
   * Xero -- is refused, so nothing is billed twice.
   */
  additional?: boolean;
  subject: string;
  issuedOn: string;
  paymentTermsDays: number;
  /**
   * The day it is due, chosen on the Xero-style form (2026-11-13), `YYYY-MM-DD`,
   * in place of the terms. Xero is then sent this day and the issue day as
   * they are, rather than the visit's day and the end of its month.
   */
  dueOn?: string;
  /** Xero's "Reference" (2026-11-13); left out or null, the property, as the office writes it. */
  reference?: string | null;
  /** How the invoice's amounts carry tax in Xero (2026-11-13); left out, its company's way. */
  taxMode?: XeroTaxMode;
  lineItems: InvoiceLineInput[];
  clientMessage?: string;
  /**
   * The company's books it goes to (2026-11-10): a connected organisation of
   * the office, or null for none. Left out, it is its lines' company. Lines
   * that go to another company are refused.
   */
  xeroTenantId?: string | null;
  /** The browser's key, so a double click or a resend makes one invoice. */
  clientRequestId: string;
}

/**
 * The invoices a visit or a property gets from one form (2026-11-10, phase 3
 * of the multi-company plan): one per company, each with its own lines, made
 * together or not at all. One request key for all of them.
 */
export interface CreateInvoicesInput extends Omit<CreateInvoiceInput, 'lineItems' | 'xeroTenantId' | 'taxMode'> {
  /** Each invoice: its company (null for none; left out, its lines' company), its lines, and how they carry tax in Xero. */
  invoices: { xeroTenantId?: string | null; lineItems: InvoiceLineInput[]; taxMode?: XeroTaxMode }[];
}

export interface CreatedInvoices {
  /** In the order they were asked for. */
  invoices: InvoiceSummary[];
}

export interface RecordPaymentInput {
  amountCents: number;
  paidOn: string;
  method: PaymentMethod;
  reference?: string;
  note?: string;
  /** The browser's key, so a double click or a resend records one payment. */
  clientRequestId: string;
}

/** The most a line or an invoice may come to: a cap on a typo, $100,000. */
export const MAX_INVOICE_CENTS = 10_000_000;
export const MAX_INVOICE_LINES = 50;

/** "$1,234.56", "-$39.99": dollars and cents, as the office reads money. */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const whole = Math.abs(Math.round(cents));
  const dollars = Math.floor(whole / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(whole % 100).padStart(2, '0')}`;
}

/** "$13.6k" past ten thousand, as Jobber's Overview rounds; exact below. */
export function formatMoneyShort(cents: number): string {
  if (Math.abs(cents) < 1_000_000) return formatMoney(cents).replace(/\.00$/, '');
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100_000).toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * Dollars as typed -- "39.99", "$1,250", "40" -- in cents, or null when it is
 * not an amount. Never more than two decimal places: "39.999" is a typo.
 */
export function parseMoney(text: string): number | null {
  const cleaned = text.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [dollars, fraction = ''] = cleaned.split('.');
  return Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
}

/** A line's total: quantity times price, less its discount (2026-11-13), in whole cents -- as Xero works out a line. */
export const lineTotalCents = (line: Pick<InvoiceLineInput, 'quantity' | 'unitPriceCents' | 'discountRate'>) =>
  Math.round(line.quantity * line.unitPriceCents * (1 - (line.discountRate ?? 0) / 100));

/** The invoice's subtotal and total from its lines. No tax on top: the office's prices include any they carry. */
export function invoiceTotals(lines: readonly Pick<InvoiceLineInput, 'quantity' | 'unitPriceCents' | 'discountRate'>[]) {
  const subtotalCents = lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
  return { subtotalCents, totalCents: subtotalCents };
}

/** The due day: the issue day plus the terms, `YYYY-MM-DD`. */
export function dueOnFor(issuedOn: string, termsDays: number): string {
  const day = new Date(`${issuedOn}T12:00:00.000Z`);
  return new Date(day.getTime() + termsDays * 86_400_000).toISOString().slice(0, 10);
}

/** Why these lines cannot be invoiced, in words, or null when they can. */
export function invoiceLinesProblem(lines: readonly InvoiceLineInput[]): string | null {
  if (!lines.length) return 'Add at least one line.';
  if (lines.length > MAX_INVOICE_LINES) return `An invoice takes at most ${MAX_INVOICE_LINES} lines.`;
  for (const line of lines) {
    if (!line.name.trim()) return 'Every line needs a name.';
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) return `${line.name}: the quantity has to be more than 0.`;
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) return `${line.name}: give the price in dollars and cents.`;
    const discount = line.discountRate ?? 0;
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) return `${line.name}: the discount is a percent from 0 to 100.`;
    if ((line.xeroTracking?.length ?? 0) > MAX_LINE_TRACKING) return `${line.name}: a line is tracked in at most ${MAX_LINE_TRACKING} categories.`;
  }
  const { totalCents } = invoiceTotals(lines);
  if (totalCents <= 0) return 'The invoice comes to nothing.';
  if (totalCents > MAX_INVOICE_CENTS) return `The invoice comes to more than ${formatMoney(MAX_INVOICE_CENTS)}. Check the prices.`;
  return null;
}

/**
 * Why this payment cannot be recorded, in words, or null when it can. Never
 * more than the invoice still owes, never in the future, never nothing.
 */
export function paymentProblem(
  input: Pick<RecordPaymentInput, 'amountCents' | 'paidOn'>,
  balanceCents: number,
  today: string,
): string | null {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return 'Give the amount paid.';
  if (input.amountCents > balanceCents)
    return `That is more than the ${formatMoney(balanceCents)} this invoice still owes.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) return 'Give the day it was paid.';
  if (input.paidOn > today) return 'A payment cannot be recorded for a day still to come.';
  return null;
}

/** Whether an invoice can still take a payment: sent, and something still owed. */
export const acceptsPayment = (invoice: Pick<InvoiceSummary, 'status' | 'balanceCents'>) =>
  (invoice.status === 'AWAITING_PAYMENT' || invoice.status === 'PAST_DUE') && invoice.balanceCents > 0;

/**
 * The status as the office reads it on a day: an invoice awaiting payment
 * whose due day has gone is past due. Worked out when read, never stored, so
 * it cannot be a day stale.
 */
export function invoiceStatusOn(stored: InvoiceStatus, dueOn: string | null, today: string): InvoiceStatus {
  if (stored !== 'AWAITING_PAYMENT' && stored !== 'PAST_DUE') return stored;
  return dueOn !== null && dueOn < today ? 'PAST_DUE' : 'AWAITING_PAYMENT';
}

/** "Net 30", "Due upon receipt"; null when there are no terms. */
export function paymentTermsLabel(days: number | null | undefined): string | null {
  if (days === null || days === undefined) return null;
  return PAYMENT_TERMS.find((terms) => terms.days === days)?.label ?? `Net ${days}`;
}

