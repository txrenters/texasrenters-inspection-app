import type { InvoiceStatus as ShownInvoiceStatus, PaymentMethod } from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, type Prisma } from '@prisma/client';

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
  lines: { name: string; description: string | null; quantity: number; unitPriceCents: number; totalCents: number }[];
  payments: {
    jobberPaymentId: string;
    paidOn: string;
    amountCents: number;
    method: PaymentMethod;
    reference: string | null;
    note: string | null;
  }[];
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
    propertywareBuildingId: visit?.propertywareBuildingId ?? null,
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
      data: copy.lines.map((line, position) => ({ organizationId, invoiceId, position, ...line })),
    });

  const kept = copy.payments.map((paid) => paid.jobberPaymentId);
  await tx.invoicePayment.deleteMany({
    where: { invoiceId, origin: InvoiceOrigin.JOBBER, jobberPaymentId: { notIn: kept } },
  });
  for (const paid of copy.payments) {
    const fields = {
      invoiceId,
      paidOn: dateOf(paid.paidOn),
      amountCents: paid.amountCents,
      method: paid.method,
      reference: paid.reference,
      note: paid.note,
    };
    await tx.invoicePayment.upsert({
      where: { organizationId_jobberPaymentId: { organizationId, jobberPaymentId: paid.jobberPaymentId } },
      create: { ...fields, organizationId, origin: InvoiceOrigin.JOBBER, jobberPaymentId: paid.jobberPaymentId },
      update: fields,
    });
  }
  return existing ? 'updated' : 'created';
}

/** An invoice Jobber deleted: gone from the copy, with its lines and payments. */
export async function removeJobberInvoice(tx: Prisma.TransactionClient, organizationId: string, jobberInvoiceId: string) {
  const { count } = await tx.invoice.deleteMany({ where: { organizationId, jobberInvoiceId } });
  return count > 0;
}
