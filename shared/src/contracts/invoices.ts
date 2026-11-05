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
}

/** An image or attachment on the invoice. */
export interface InvoiceFileView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Where it can be opened: the console's own copy once kept, else Jobber's address. */
  url: string | null;
  uploadedAt: string;
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
  /** Where it was recorded: in Jobber, or in the console. */
  origin?: 'JOBBER' | 'CONSOLE';
}

/** Where an invoice's property is, as the console knows it. */
export interface InvoiceProperty {
  id: string;
  address: string;
  city: string | null;
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
  origin: 'JOBBER' | 'CONSOLE';
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
}

/**
 * What a finished visit would be invoiced for, before anybody edits it: one
 * line per service done, at the price in Jobber's products list.
 */
export interface InvoiceDraft {
  inspection: { id: string; inspectionType: string; scheduledOn: string; status: string };
  property: InvoiceProperty | null;
  clientName: string;
  subject: string;
  issuedOn: string;
  paymentTermsDays: number;
  lineItems: InvoiceLineInput[];
  clientMessage: string;
  /** Already invoiced: the invoice, so a second is not made by mistake. */
  existing: { id: string; number: string | null; status: InvoiceStatus } | null;
  /** The products the office sells, for a line added by hand. */
  products: { name: string; unitPriceCents: number }[];
}

export interface CreateInvoiceInput {
  inspectionId: string;
  subject: string;
  issuedOn: string;
  paymentTermsDays: number;
  lineItems: InvoiceLineInput[];
  clientMessage?: string;
  /** The browser's key, so a double click or a resend makes one invoice. */
  clientRequestId: string;
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

/** A line's total: quantity times price, in whole cents. */
export const lineTotalCents = (line: Pick<InvoiceLineInput, 'quantity' | 'unitPriceCents'>) =>
  Math.round(line.quantity * line.unitPriceCents);

/** The invoice's subtotal and total from its lines. No tax: the office's services carry none. */
export function invoiceTotals(lines: readonly Pick<InvoiceLineInput, 'quantity' | 'unitPriceCents'>[]) {
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

