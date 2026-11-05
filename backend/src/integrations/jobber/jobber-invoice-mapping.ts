import type { InvoiceStatus, PaymentMethod } from '@texasrenters/shared';

import { businessDate } from '../../common/business-day';
import type { JobberInvoiceCopy, JobberInvoiceDetails, JobberPaymentDetails } from './jobber-invoice-copy';
import type { JobberPropertyDescriptor } from './jobber.mapping.service';
import type { JobberInvoice, JobberPaymentRecord } from './jobber.schemas';

/**
 * Jobber's invoice, turned into the console's copy (2026-11-05).
 *
 * The one place that knows how Jobber spells an invoice. `applyJobberInvoice`
 * writes the result and never sees Jobber's shape.
 */

const STATUS: Record<JobberInvoice['invoiceStatus'], InvoiceStatus> = {
  draft: 'DRAFT',
  awaiting_payment: 'AWAITING_PAYMENT',
  // Jobber's "sent, not yet due": awaiting payment, and the console works out
  // whether it is past due from the due day.
  sent_not_due: 'AWAITING_PAYMENT',
  past_due: 'PAST_DUE',
  paid: 'PAID',
  bad_debt: 'BAD_DEBT',
};

/**
 * What a payment record does to the balance, by Jobber's adjustment type.
 *
 * A payment or deposit is money in; a refund or a failed bank payment is money
 * back out, stored below nothing so the list adds up. The rest -- the invoice
 * itself, corrections, opening balances, bad debt, voids -- are entries on
 * Jobber's ledger, not payments, and are left out.
 */
const PAYMENT_SIGN: Record<string, 1 | -1> = {
  PAYMENT: 1,
  DEPOSIT: 1,
  REFUND: -1,
  FAILED_ACH_PAYMENT: -1,
};

const cents = (dollars: number) => Math.round(dollars * 100);
const text = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

/**
 * The day a Jobber date-time names, as `YYYY-MM-DD`.
 *
 * Jobber sends days as date-times. Midnight in the value's own offset is a day
 * written as one, and is taken as written: turning midnight UTC into Texas time
 * would move every invoice to the day before. Any other time of day is an
 * instant, and its day is the day in Texas.
 */
export function jobberDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const midnight = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (midnight) return midnight[1]!;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : businessDate(instant);
}

/** Days from issue to due, as Jobber's "Net 30"; null without both days, or when due comes first. */
function termsDays(issuedOn: string | null, dueOn: string | null) {
  if (!issuedOn || !dueOn) return null;
  const days = Math.round((Date.parse(dueOn) - Date.parse(issuedOn)) / 86_400_000);
  return days >= 0 ? days : null;
}

type AddressParts = {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
};

function addressLine(address: AddressParts | null | undefined) {
  if (!address) return null;
  const region = [text(address.province), text(address.postalCode)].filter(Boolean).join(' ');
  const line = [text(address.street1), text(address.street2), text(address.city), region || null]
    .filter(Boolean)
    .join(', ');
  return line || null;
}

/**
 * The one Jobber property an invoice is for, as the property matcher takes it
 * (`JobberMappingService.resolveProperty`); null for none, or for a batch over
 * several, which belongs on no one property's page.
 */
export function invoiceProperty(invoice: JobberInvoice): JobberPropertyDescriptor | null {
  if (invoice.properties.nodes.length !== 1) return null;
  const property = invoice.properties.nodes[0]!;
  return {
    jobberPropertyId: property.id,
    jobberClientId: invoice.client?.id ?? null,
    jobberClientName: invoice.client?.name ?? null,
    addressLine1: property.address?.street1 ?? null,
    addressLine2: property.address?.street2 ?? null,
    city: property.address?.city ?? null,
    state: property.address?.province ?? null,
    postalCode: property.address?.postalCode ?? null,
  };
}

/** Whether a page cut this invoice's lines, payments, notes or files short, so it must be read again by itself. */
export function isCutShort(invoice: JobberInvoice) {
  const cut = (list: { totalCount: number; nodes: unknown[] } | null | undefined) =>
    !!list && list.totalCount > list.nodes.length;
  return cut(invoice.lineItems) || cut(invoice.paymentRecords) || cut(invoice.notes) || cut(invoice.noteAttachments);
}

/** Jobber's list of a client's emails or phones, primary first, each once. */
function contacts(list: { value: string; primary?: boolean | null }[]) {
  const ordered = [...list].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  return [...new Set(ordered.map((entry) => entry.value.trim()).filter(Boolean))];
}

/**
 * A custom field as Jobber shows it: its label and its value as text. Area and
 * link fields carry no plain value on this schema, and a field with no value is
 * left out rather than shown blank.
 */
function customField(field: NonNullable<JobberInvoice['customFields']>[number]) {
  const label = text(field.label);
  if (!label) return null;
  let value: string | null = null;
  if (field.__typename === 'CustomFieldText') value = text(field.valueText);
  else if (field.__typename === 'CustomFieldDropdown') value = text(field.valueDropdown);
  else if (field.__typename === 'CustomFieldNumeric' && typeof field.valueNumeric === 'number')
    value = [String(field.valueNumeric), text(field.unit)].filter(Boolean).join(' ');
  else if (field.__typename === 'CustomFieldTrueFalse' && typeof field.valueTrueFalse === 'boolean')
    value = field.valueTrueFalse ? 'Yes' : 'No';
  return value ? { label, value } : null;
}

/** Jobber's "exclusive" / "inclusive" (lower case on this schema): whether prices include tax. */
function taxInclusive(method: string | null | undefined) {
  const normal = method?.trim().toLowerCase();
  return normal === 'inclusive' ? true : normal === 'exclusive' ? false : null;
}

function invoiceDetails(invoice: JobberInvoice, job: JobberInvoice['jobs']['nodes'][number] | null): JobberInvoiceDetails {
  const amounts = invoice.amounts;
  const discountType = invoice.discount?.type?.trim().toLowerCase();
  return {
    contractDisclaimer: text(invoice.contractDisclaimer),
    billingName: text(invoice.billingAddress?.name),
    propertyAddress: invoice.properties.nodes.length === 1 ? addressLine(invoice.properties.nodes[0]!.address) : null,
    billingSameAsProperty: invoice.billingIsSameAsPropertyAddress ?? null,
    clientEmails: contacts((invoice.client?.emails ?? []).map((email) => ({ value: email.address, primary: email.primary }))),
    clientPhones: contacts((invoice.client?.phones ?? []).map((phone) => ({ value: phone.number, primary: phone.primary }))),
    paidOn: jobberDay(invoice.receivedDate),
    viewedAt: invoice.dateViewedInClientHub ?? null,
    salespersonName: text(invoice.salesperson?.name?.full),
    jobTitle: text(job?.title),
    discountCents: cents(amounts?.discountAmount ?? 0),
    discountRate: invoice.discount ? invoice.discount.rate : null,
    discountKind: discountType === 'percent' ? 'PERCENT' : discountType === 'unit' ? 'AMOUNT' : null,
    depositCents: cents(amounts?.depositAmount ?? 0),
    tipsCents: cents(amounts?.tipsTotal ?? 0),
    taxRateName: text(invoice.taxRate?.name),
    taxRatePercent: invoice.taxRate?.tax ?? null,
    taxInclusive: taxInclusive(invoice.taxCalculationMethod),
    customFields: (invoice.customFields ?? []).flatMap((field) => {
      const shown = customField(field);
      return shown ? [shown] : [];
    }),
  };
}

/** Jobber's note kinds that carry text, by the GraphQL type it names. */
const NOTE_KIND: Record<string, string> = { InvoiceNote: 'INVOICE', JobNote: 'JOB' };

function invoiceNotes(invoice: JobberInvoice): JobberInvoiceCopy['notes'] {
  if (!invoice.notes) return undefined;
  return invoice.notes.nodes.flatMap((note) => {
    const kind = NOTE_KIND[note.__typename];
    const message = note.message?.trim();
    if (!kind || !note.id || !message) return [];
    // A note's text matters more than its time; one Jobber sends without a
    // time is dated by the invoice's last change rather than dropped.
    return [{ jobberNoteId: note.id, kind, message, pinned: !!note.pinned, writtenAt: note.createdAt ?? invoice.updatedAt }];
  });
}

function invoiceFiles(invoice: JobberInvoice): JobberInvoiceCopy['files'] {
  if (!invoice.noteAttachments) return undefined;
  return invoice.noteAttachments.nodes.map((file) => ({
    jobberFileId: file.id,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.fileSize,
    jobberUrl: file.url ?? null,
    uploadedAt: file.createdAt,
  }));
}

/**
 * How Jobber's payment types are kept (2026-11-05). Jobber's own online and
 * ACH payments are bank or card payments to the console; financing, and any
 * type Jobber adds, are Other, with Jobber's own spelling kept beside it.
 */
const PAYMENT_METHOD: Record<string, PaymentMethod> = {
  CASH: 'CASH',
  CHEQUE: 'CHECK',
  CREDIT_CARD: 'CARD',
  JOBBER_PAYMENTS: 'CARD',
  BANK_TRANSFER: 'BANK_TRANSFER',
  ACH_BANK_PAYMENT: 'BANK_TRANSFER',
  E_TRANSFER: 'BANK_TRANSFER',
  EPAYMENT: 'BANK_TRANSFER',
  MONEY_ORDER: 'MONEY_ORDER',
  ZELLE: 'ZELLE',
  CASH_APP: 'CASH_APP',
  PAYPAL: 'PAYPAL',
  VENMO: 'VENMO',
};

/**
 * One entry in Jobber's payment list, as `pairJobberPayment` takes it; null for
 * one that names no invoice or no day, which no invoice's payment can be.
 */
export function toPaymentDetails(record: JobberPaymentRecord): JobberPaymentDetails | null {
  const paidOn = jobberDay(record.entryDate);
  if (!record.invoice?.id || !paidOn) return null;
  const type = text(record.paymentType);
  return {
    jobberRecordId: record.id,
    jobberInvoiceId: record.invoice.id,
    paidOn,
    // The list is filtered to payments, money in; the invoice keeps them positive.
    amountCents: Math.abs(cents(record.amount)),
    method: (type && PAYMENT_METHOD[type]) || 'OTHER',
    jobberPaymentType: type,
    reference: text(record.checkNumber) ?? text(record.confirmationNumber) ?? text(record.ccTransactionNumber),
    note: text(record.details),
  };
}

export function toInvoiceCopy(invoice: JobberInvoice): JobberInvoiceCopy {
  const issuedOn = jobberDay(invoice.issuedDate);
  const dueOn = jobberDay(invoice.dueDate);
  // An invoice for one job names it; one billing several (a batch) names none,
  // and is matched by its visits or not at all.
  const job = invoice.jobs.nodes.length === 1 ? invoice.jobs.nodes[0]! : null;
  const amounts = invoice.amounts ?? { subtotal: 0, taxAmount: 0, total: 0, invoiceBalance: 0 };
  return {
    jobberInvoiceId: invoice.id,
    jobberClientId: invoice.client?.id ?? null,
    number: invoice.invoiceNumber === null || invoice.invoiceNumber === undefined ? null : text(String(invoice.invoiceNumber)),
    subject: invoice.subject?.trim() ?? '',
    status: STATUS[invoice.invoiceStatus],
    clientName: invoice.client?.name?.trim() ?? '',
    billingAddress: addressLine(invoice.billingAddress),
    jobberJobId: job?.id ?? null,
    jobNumber: job?.jobNumber === null || job?.jobNumber === undefined ? null : String(job.jobNumber),
    jobberVisitIds: invoice.visits.nodes.map((visit) => visit.id),
    jobberPropertyId: invoice.properties.nodes.length === 1 ? invoice.properties.nodes[0]!.id : null,
    issuedOn,
    dueOn,
    paymentTermsDays: termsDays(issuedOn, dueOn),
    subtotalCents: cents(amounts.subtotal),
    taxCents: cents(amounts.taxAmount),
    totalCents: cents(amounts.total),
    balanceCents: cents(amounts.invoiceBalance),
    clientMessage: text(invoice.message),
    jobberWebUrl: invoice.jobberWebUri ?? null,
    updatedAt: invoice.updatedAt,
    lines: invoice.lineItems.nodes.map((line) => ({
      name: line.name,
      description: text(line.description),
      quantity: line.quantity,
      unitPriceCents: cents(line.unitPrice),
      totalCents: cents(line.totalPrice),
      taxable: line.taxable ?? null,
      serviceOn: jobberDay(line.date),
      productName: text(line.linkedProductOrService?.name),
      category: text(line.category),
    })),
    payments: invoice.paymentRecords.nodes.flatMap((record) => {
      const sign = PAYMENT_SIGN[record.adjustmentType];
      const paidOn = jobberDay(record.entryDate);
      if (!sign || !paidOn) return [];
      return [
        {
          jobberPaymentId: record.id,
          paidOn,
          amountCents: sign * Math.abs(cents(record.amount)),
          // Jobber's invoice view of a payment carries no payment type, so a
          // new one is Other until Jobber's payment list says how it was paid
          // (`toPaymentDetails`, `pairJobberPayment`).
          method: 'OTHER' as const,
          reference: null,
          note: null,
        },
      ];
    }),
    details: invoiceDetails(invoice, job),
    notes: invoiceNotes(invoice),
    files: invoiceFiles(invoice),
  };
}
