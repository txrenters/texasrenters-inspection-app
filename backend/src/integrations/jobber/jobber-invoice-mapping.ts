import type { InvoiceStatus } from '@texasrenters/shared';

import { businessDate } from '../../common/business-day';
import type { JobberInvoiceCopy } from './jobber-invoice-copy';
import type { JobberInvoice } from './jobber.schemas';

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

function addressLine(address: JobberInvoice['billingAddress']) {
  if (!address) return null;
  const region = [text(address.province), text(address.postalCode)].filter(Boolean).join(' ');
  const line = [text(address.street1), text(address.street2), text(address.city), region || null]
    .filter(Boolean)
    .join(', ');
  return line || null;
}

/** Whether a page cut this invoice's lines or payments short, so it must be read again by itself. */
export function isCutShort(invoice: JobberInvoice) {
  return (
    invoice.lineItems.totalCount > invoice.lineItems.nodes.length ||
    invoice.paymentRecords.totalCount > invoice.paymentRecords.nodes.length
  );
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
          // Jobber's invoice view of a payment carries no payment type (see
          // INVOICE_BY_ID_QUERY), so how it was paid is not known yet.
          method: 'OTHER' as const,
          reference: null,
          note: null,
        },
      ];
    }),
  };
}
