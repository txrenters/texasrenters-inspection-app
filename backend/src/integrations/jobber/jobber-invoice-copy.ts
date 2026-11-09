import type { InvoiceStatus as ShownInvoiceStatus, PaymentMethod } from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, Prisma } from '@prisma/client';

import { invoicingTakenOverAt } from '../../admin/invoice-settings';

/**
 * The console's copy of a Jobber invoice (2026-11-05), written from what Jobber
 * says the invoice is now.
 *
 * Its own shape, not Jobber's GraphQL: the query and the webhooks that fill it
 * wait for the Developer Center's scopes and schema (an unknown field fails the
 * whole query), and turn Jobber's answer into this. Everything below is the
 * part that does not depend on Jobber's spelling: replacing the copy whole,
 * idempotently, and never with an older version than it holds.
 */
export interface JobberInvoiceCopy {
  jobberInvoiceId: string;
  /** Jobber's client: for the office, the property. */
  jobberClientId: string | null;
  number: string | null;
  subject: string;
  /** Jobber's past due is kept as awaiting payment: the console works it out from the due day. */
  status: ShownInvoiceStatus;
  clientName: string;
  billingAddress: string | null;
  jobberJobId: string | null;
  jobNumber: string | null;
  /** The visits it bills, when Jobber names them: how it is matched to an inspection. */
  jobberVisitIds: string[];
  /** The one Jobber property it is for; null for none, or a batch over several. */
  jobberPropertyId: string | null;
  /**
   * The building that Jobber property is linked to (JobberPropertyLink), looked
   * up by the caller: how an invoice that bills no visit the console has -- most
   * of Jobber's older ones -- is still put on its property's page. The visit's
   * own building wins when there is one.
   */
  linkedBuildingId?: string | null;
  /** `YYYY-MM-DD` */
  issuedOn: string | null;
  dueOn: string | null;
  paymentTermsDays: number | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  balanceCents: number;
  clientMessage: string | null;
  jobberWebUrl: string | null;
  /** Jobber's "updated at", ISO. */
  updatedAt: string;
  lines: {
    name: string;
    description: string | null;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    taxable?: boolean | null;
    /** `YYYY-MM-DD` */
    serviceOn?: string | null;
    productName?: string | null;
    category?: string | null;
  }[];
  payments: {
    jobberPaymentId: string;
    paidOn: string;
    amountCents: number;
    method: PaymentMethod;
    reference: string | null;
    note: string | null;
  }[];
  /** Every other detail Jobber keeps (2026-11-05); left as stored when absent. */
  details?: JobberInvoiceDetails;
  /** The invoice's notes, and the job's beside them; replaced whole when present. */
  notes?: { jobberNoteId: string; kind: string; message: string; pinned: boolean; writtenAt: string }[];
  /** Its images and attachments; kept to Jobber's list when present, never losing the console's own copy of one. */
  files?: {
    jobberFileId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    jobberUrl: string | null;
    uploadedAt: string;
  }[];
}

export interface JobberInvoiceDetails {
  contractDisclaimer: string | null;
  billingName: string | null;
  propertyAddress: string | null;
  billingSameAsProperty: boolean | null;
  clientEmails: string[];
  clientPhones: string[];
  /** `YYYY-MM-DD` */
  paidOn: string | null;
  /** ISO */
  viewedAt: string | null;
  salespersonName: string | null;
  jobTitle: string | null;
  discountCents: number;
  discountRate: number | null;
  discountKind: 'PERCENT' | 'AMOUNT' | null;
  depositCents: number;
  tipsCents: number;
  taxRateName: string | null;
  taxRatePercent: number | null;
  taxInclusive: boolean | null;
  customFields: { label: string; value: string }[];
}

export type InvoiceCopyResult = 'created' | 'updated' | 'stale';

const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);
const dateOrNull = (value: string | null) => (value ? dateOf(value) : null);

/**
 * Jobber's page for an invoice, only when it is one: an HTTPS address on
 * getjobber.com. The copy is shown as a link, and a link is not followed to
 * wherever a payload says.
 */
export function jobberPageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'getjobber.com' || host.endsWith('.getjobber.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A file's address, only when it is an HTTPS one. Jobber keeps files on its
 * storage, not on getjobber.com, so the page check above does not fit; but a
 * file is still opened from the console, and a link that is not HTTPS is not
 * one to follow.
 */
export function httpsAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const storedStatus = (status: ShownInvoiceStatus): InvoiceStatus =>
  status === 'PAST_DUE' ? InvoiceStatus.AWAITING_PAYMENT : InvoiceStatus[status];

/**
 * The visit an invoice bills: one of the Jobber visits it names, else the only
 * visit on its Jobber job. A job with more than one visit -- a quarter's zone
 * job -- names no visit by itself, so it is left unmatched rather than guessed.
 */
async function matchVisit(tx: Prisma.TransactionClient, organizationId: string, copy: JobberInvoiceCopy) {
  if (copy.jobberVisitIds.length) {
    const visit = await tx.inspection.findFirst({
      where: { organizationId, jobberVisitId: { in: copy.jobberVisitIds } },
      orderBy: { scheduledAt: 'desc' },
      select: { id: true, propertywareBuildingId: true },
    });
    if (visit) return visit;
  }
  if (!copy.jobberJobId) return null;
  const visits = await tx.inspection.findMany({
    where: { organizationId, jobberJobId: copy.jobberJobId },
    take: 2,
    select: { id: true, propertywareBuildingId: true },
  });
  return visits.length === 1 ? visits[0]! : null;
}

/**
 * Writes Jobber's invoice into the copy: the invoice, its lines replaced, its
 * payments kept to Jobber's list. Run inside the caller's transaction, so the
 * three are replaced together or not at all.
 *
 * A delivery older than the copy changes nothing -- Jobber delivers at least
 * once and in no promised order, and adding a payment there fires the update
 * twice. A payment made in the console and not yet in Jobber is kept, and
 * still counted against the balance.
 */
export async function applyJobberInvoice(
  tx: Prisma.TransactionClient,
  organizationId: string,
  copy: JobberInvoiceCopy,
  now: Date = new Date(),
): Promise<InvoiceCopyResult> {
  // The console owns invoicing (phase 8): Jobber's copy would overwrite what the office changed here.
  if (await invoicingTakenOverAt(tx, organizationId)) return 'stale';
  const updatedAt = new Date(copy.updatedAt);
  const existing = await tx.invoice.findUnique({
    where: { organizationId_jobberInvoiceId: { organizationId, jobberInvoiceId: copy.jobberInvoiceId } },
    select: { id: true, jobberUpdatedAt: true },
  });
  if (existing?.jobberUpdatedAt && existing.jobberUpdatedAt > updatedAt) return 'stale';

  const visit = await matchVisit(tx, organizationId, copy);
  const pending = existing
    ? await tx.invoicePayment.aggregate({
        where: { invoiceId: existing.id, origin: InvoiceOrigin.CONSOLE, jobberPaymentId: null },
        _sum: { amountCents: true },
      })
    : null;
  const pendingCents = pending?._sum.amountCents ?? 0;

  const data = {
    jobberClientId: copy.jobberClientId,
    number: copy.number,
    subject: copy.subject,
    status: storedStatus(copy.status),
    clientName: copy.clientName,
    billingAddress: copy.billingAddress,
    inspectionId: visit?.id ?? null,
    propertywareBuildingId: visit?.propertywareBuildingId ?? copy.linkedBuildingId ?? null,
    jobberPropertyId: copy.jobberPropertyId,
    jobberJobId: copy.jobberJobId,
    jobNumber: copy.jobNumber,
    issuedOn: dateOrNull(copy.issuedOn),
    dueOn: dateOrNull(copy.dueOn),
    paymentTermsDays: copy.paymentTermsDays,
    subtotalCents: copy.subtotalCents,
    taxCents: copy.taxCents,
    totalCents: copy.totalCents,
    balanceCents: copy.balanceCents - pendingCents,
    clientMessage: copy.clientMessage,
    jobberWebUrl: jobberPageUrl(copy.jobberWebUrl),
    jobberUpdatedAt: updatedAt,
    syncedAt: now,
    ...(copy.details ? detailColumns(copy.details) : {}),
  } satisfies Prisma.InvoiceUncheckedUpdateInput;

  const invoiceId = existing
    ? (await tx.invoice.update({ where: { id: existing.id }, data, select: { id: true } })).id
    : (
        await tx.invoice.create({
          data: { ...data, organizationId, origin: InvoiceOrigin.JOBBER, jobberInvoiceId: copy.jobberInvoiceId },
          select: { id: true },
        })
      ).id;

  await tx.invoiceLine.deleteMany({ where: { invoiceId } });
  if (copy.lines.length)
    await tx.invoiceLine.createMany({
      data: copy.lines.map(({ serviceOn, ...line }, position) => ({
        organizationId,
        invoiceId,
        position,
        ...line,
        ...(serviceOn !== undefined ? { serviceOn: dateOrNull(serviceOn) } : {}),
      })),
    });

  const kept = copy.payments.map((paid) => paid.jobberPaymentId);
  await tx.invoicePayment.deleteMany({
    where: { invoiceId, origin: InvoiceOrigin.JOBBER, jobberPaymentId: { notIn: kept } },
  });
  for (const paid of copy.payments) {
    const when = { invoiceId, paidOn: dateOf(paid.paidOn), amountCents: paid.amountCents };
    await tx.invoicePayment.upsert({
      where: { organizationId_jobberPaymentId: { organizationId, jobberPaymentId: paid.jobberPaymentId } },
      create: {
        ...when,
        method: paid.method,
        reference: paid.reference,
        note: paid.note,
        organizationId,
        origin: InvoiceOrigin.JOBBER,
        jobberPaymentId: paid.jobberPaymentId,
      },
      // The day and the amount only: how it was paid, its reference and its
      // details come from Jobber's payment list (`pairJobberPayment`), which
      // the invoice's own view of a payment does not carry -- writing "Other"
      // here would undo them on every read.
      update: when,
    });
  }

  if (copy.notes) {
    // Jobber's notes only: one written in the console (2026-11-10) is never touched by a read.
    await tx.invoiceNote.deleteMany({ where: { invoiceId, origin: 'JOBBER' } });
    if (copy.notes.length)
      await tx.invoiceNote.createMany({
        data: copy.notes.map((note) => ({ organizationId, invoiceId, ...note, writtenAt: new Date(note.writtenAt) })),
        skipDuplicates: true,
      });
  }

  if (copy.files) {
    const listed = copy.files.map((file) => file.jobberFileId);
    await tx.invoiceFile.deleteMany({ where: { invoiceId, origin: 'JOBBER', jobberFileId: { notIn: listed } } });
    for (const file of copy.files) {
      const fields = {
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        jobberUrl: httpsAddress(file.jobberUrl),
        uploadedAt: new Date(file.uploadedAt),
      };
      // `storageKey`, the console's own copy, is never written here: a re-read
      // must not lose it.
      await tx.invoiceFile.upsert({
        where: { invoiceId_jobberFileId: { invoiceId, jobberFileId: file.jobberFileId } },
        create: { ...fields, organizationId, invoiceId, jobberFileId: file.jobberFileId },
        update: fields,
      });
    }
  }
  return existing ? 'updated' : 'created';
}

/** The invoice's other details as columns. */
function detailColumns(details: JobberInvoiceDetails) {
  return {
    contractDisclaimer: details.contractDisclaimer,
    billingName: details.billingName,
    propertyAddress: details.propertyAddress,
    billingSameAsProperty: details.billingSameAsProperty,
    clientEmails: details.clientEmails,
    clientPhones: details.clientPhones,
    paidOn: dateOrNull(details.paidOn),
    viewedAt: details.viewedAt ? new Date(details.viewedAt) : null,
    salespersonName: details.salespersonName,
    jobTitle: details.jobTitle,
    discountCents: details.discountCents,
    discountRate: details.discountRate,
    discountKind: details.discountKind,
    depositCents: details.depositCents,
    tipsCents: details.tipsCents,
    taxRateName: details.taxRateName,
    taxRatePercent: details.taxRatePercent,
    taxInclusive: details.taxInclusive,
    customFields: details.customFields.length ? details.customFields : Prisma.DbNull,
  };
}

/** What Jobber's payment list says about one payment (PAYMENTS_PAGE_QUERY). */
export interface JobberPaymentDetails {
  jobberRecordId: string;
  jobberInvoiceId: string;
  /** `YYYY-MM-DD` */
  paidOn: string;
  amountCents: number;
  method: PaymentMethod;
  jobberPaymentType: string | null;
  reference: string | null;
  note: string | null;
}

/**
 * Pairs a payment in Jobber's payment list with the payment its invoice has
 * (2026-11-05), and writes how it was paid, its reference and its details.
 *
 * The two ids differ -- Jobber's payment list and an invoice's own view of a
 * payment are different objects -- so the pair is made on what both say: the
 * invoice, the day and the amount. One already paired with this record is
 * found first, so reading the list again changes nothing; otherwise the
 * earliest unpaired payment that agrees. 'unmatched' when the invoice is not
 * in the copy yet, or holds no payment that agrees -- the list is read again
 * in full before the cutover.
 */
export async function pairJobberPayment(
  tx: Prisma.TransactionClient,
  organizationId: string,
  record: JobberPaymentDetails,
): Promise<'paired' | 'unmatched'> {
  if (await invoicingTakenOverAt(tx, organizationId)) return 'unmatched';
  const already = await tx.invoicePayment.findFirst({
    where: { organizationId, jobberRecordId: record.jobberRecordId },
    select: { id: true },
  });
  const target =
    already ??
    (await tx.invoicePayment.findFirst({
      where: {
        organizationId,
        origin: InvoiceOrigin.JOBBER,
        jobberRecordId: null,
        paidOn: dateOf(record.paidOn),
        amountCents: record.amountCents,
        invoice: { jobberInvoiceId: record.jobberInvoiceId },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }));
  if (!target) return 'unmatched';
  await tx.invoicePayment.update({
    where: { id: target.id },
    data: {
      jobberRecordId: record.jobberRecordId,
      jobberPaymentType: record.jobberPaymentType,
      method: record.method,
      reference: record.reference,
      note: record.note,
    },
  });
  return 'paired';
}

/** An invoice Jobber deleted: gone from the copy, with its lines and payments. */
export async function removeJobberInvoice(tx: Prisma.TransactionClient, organizationId: string, jobberInvoiceId: string) {
  // Deleted in Jobber after the cutover: the console's invoice is the office's now.
  if (await invoicingTakenOverAt(tx, organizationId)) return false;
  const { count } = await tx.invoice.deleteMany({ where: { organizationId, jobberInvoiceId } });
  return count > 0;
}
