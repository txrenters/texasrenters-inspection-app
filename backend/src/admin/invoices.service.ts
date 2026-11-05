import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_TERMS,
  REPORTABLE_VISIT_SERVICES,
  acceptsPayment,
  dueOnFor,
  invoiceLinesProblem,
  invoiceStatusOn,
  invoiceTotals,
  isFinishedStatus,
  lineTotalCents,
  paymentLockedReason,
  paymentProblem,
  paymentTermsLabel,
  type CreateInvoiceInput,
  type InvoiceBucket,
  type InvoiceCustomField,
  type InvoiceDetail,
  type InvoiceDraft,
  type InvoiceExtraDetails,
  type InvoiceFilter,
  type InvoiceJobberRead,
  type InvoiceLineInput,
  type InvoiceLineItem,
  type InvoiceList,
  type InvoiceNoteView,
  type InvoicePayment as InvoicePaymentView,
  type ChangePaymentInput,
  type InvoiceSummary,
  type PaymentDetail,
  type PaymentList,
  type PaymentMethod,
  type ReceiptBrand,
  type RecordPaymentInput,
  type ReportableVisitService,
  type VisitServicesReport,
} from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, JobberConnectionStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { getJobberConfig } from '../integrations/jobber/jobber.config';

/**
 * Invoices and the payments recorded against them (the office, 2026-11-05).
 *
 * Reading is the console's copy of Jobber's, so no page asks Jobber anything.
 * Making an invoice and recording a payment are the office's alone: separate
 * permissions from reading, both of which an API key may never hold, each
 * written with an audit entry and keyed by the browser so a double click makes
 * one. Nothing here charges anybody; the money comes in through the tenant's
 * ledger in Propertyware.
 *
 * Both writes are off until the console sends them to Jobber
 * (`JOBBER_INVOICE_WRITES_ENABLED`): Jobber is the record of what was billed
 * and paid, and an invoice made only here is one the office never sees there.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Jobber's own subject for an invoice, until the office's copy says otherwise. */
const DEFAULT_SUBJECT = 'For Services Rendered';
const DEFAULT_TERMS_DAYS = 30;

/** How far back the office's prices are read from its own invoices. */
const PRICE_WINDOW_DAYS = 180;
const MAX_PRODUCTS = 50;

/** The word that finds a service's product in the office's price list. */
const SERVICE_PRODUCT_WORD: Record<ReportableVisitService, string> = {
  filterChange: 'filter',
  pestControl: 'pest',
  fleaTreatment: 'flea',
};

/** A service's line when the office has never billed it: named as Jobber's are. */
const SERVICE_LINE_NAME: Record<ReportableVisitService, string> = {
  filterChange: 'Filter Change',
  pestControl: 'Pest Control',
  fleaTreatment: 'Flea Treatment',
};

const summarySelect = {
  id: true,
  number: true,
  subject: true,
  status: true,
  clientName: true,
  inspectionId: true,
  jobNumber: true,
  issuedOn: true,
  dueOn: true,
  totalCents: true,
  balanceCents: true,
  jobberWebUrl: true,
  propertywareBuilding: { select: { id: true, name: true, addressLine1: true, city: true } },
} satisfies Prisma.InvoiceSelect;

const detailSelect = {
  ...summarySelect,
  jobberClientId: true,
  propertywareBuildingId: true,
  paymentTermsDays: true,
  billingAddress: true,
  subtotalCents: true,
  taxCents: true,
  clientMessage: true,
  createdAt: true,
  updatedAt: true,
  // Every other detail Jobber keeps (2026-11-05).
  contractDisclaimer: true,
  billingName: true,
  propertyAddress: true,
  billingSameAsProperty: true,
  clientEmails: true,
  clientPhones: true,
  paidOn: true,
  viewedAt: true,
  salespersonName: true,
  jobTitle: true,
  discountCents: true,
  discountRate: true,
  discountKind: true,
  depositCents: true,
  tipsCents: true,
  taxRateName: true,
  taxRatePercent: true,
  taxInclusive: true,
  customFields: true,
  lines: {
    orderBy: { position: 'asc' },
    select: {
      name: true,
      description: true,
      quantity: true,
      unitPriceCents: true,
      totalCents: true,
      taxable: true,
      serviceOn: true,
      productName: true,
      category: true,
    },
  },
  payments: { orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }], select: paymentSelect() },
  // Pinned first, as Jobber shows them, then newest first.
  notes: {
    orderBy: [{ pinned: 'desc' }, { writtenAt: 'desc' }],
    select: { id: true, kind: true, message: true, pinned: true, writtenAt: true },
  },
  files: {
    orderBy: { uploadedAt: 'asc' },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, jobberUrl: true, uploadedAt: true },
  },
} satisfies Prisma.InvoiceSelect;

function paymentSelect() {
  return {
    id: true,
    paidOn: true,
    amountCents: true,
    method: true,
    reference: true,
    note: true,
    origin: true,
    createdAt: true,
    recordedBy: { select: { id: true, displayName: true } },
  } satisfies Prisma.InvoicePaymentSelect;
}

/** The invoice a payment paid, as the Payments list and a payment's page show it. */
const paidInvoiceSelect = {
  id: true,
  number: true,
  subject: true,
  clientName: true,
  propertywareBuilding: { select: { id: true, name: true, addressLine1: true, city: true } },
} satisfies Prisma.InvoiceSelect;

type SummaryRow = Prisma.InvoiceGetPayload<{ select: typeof summarySelect }>;
type DetailRow = Prisma.InvoiceGetPayload<{ select: typeof detailSelect }>;
type PaymentRow = Prisma.InvoicePaymentGetPayload<{ select: ReturnType<typeof paymentSelect> }>;

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);
const daysBefore = (value: string, days: number) => new Date(dateOf(value).getTime() - days * DAY_MS);

function property(row: SummaryRow['propertywareBuilding']) {
  return row ? { id: row.id, address: row.addressLine1 ?? row.name, city: row.city } : null;
}

function summary(row: SummaryRow, today: string): InvoiceSummary {
  const dueOn = day(row.dueOn);
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: invoiceStatusOn(row.status, dueOn, today),
    clientName: row.clientName,
    property: property(row.propertywareBuilding),
    inspectionId: row.inspectionId,
    jobNumber: row.jobNumber,
    issuedOn: day(row.issuedOn),
    dueOn,
    totalCents: row.totalCents,
    balanceCents: row.balanceCents,
    jobberUrl: row.jobberWebUrl,
  };
}

function payment(row: PaymentRow): InvoicePaymentView {
  return {
    id: row.id,
    paidOn: day(row.paidOn)!,
    amountCents: row.amountCents,
    method: row.method,
    reference: row.reference,
    note: row.note,
    recordedBy: row.recordedBy,
    recordedAt: row.createdAt.toISOString(),
    origin: row.origin,
  };
}

/** A payment as the record keeps it, before a change or once removed. */
function paymentRecord(row: {
  amountCents: number;
  paidOn: Date;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
  origin: InvoiceOrigin;
  recordedById: string | null;
}) {
  return {
    amountCents: row.amountCents,
    paidOn: day(row.paidOn),
    method: row.method,
    reference: row.reference,
    note: row.note,
    origin: row.origin,
    recordedById: row.recordedById,
  };
}

/** Who a receipt is from: the same settings that name the company on an inspection report. */
export function receiptBrand(env: NodeJS.ProcessEnv = process.env): ReceiptBrand {
  return {
    name: env.REPORT_BRAND_NAME ?? 'TexasRenters.com',
    addressLine1: env.REPORT_BRAND_ADDRESS_LINE1 ?? null,
    addressLine2: env.REPORT_BRAND_ADDRESS_LINE2 ?? null,
    phone: env.REPORT_BRAND_PHONE ?? null,
    email: env.REPORT_BRAND_EMAIL ?? null,
  };
}

function lineItem(row: DetailRow['lines'][number]): InvoiceLineItem {
  return { ...row, serviceOn: day(row.serviceOn) };
}

const NOTE_KINDS: readonly InvoiceNoteView['kind'][] = ['INVOICE', 'JOB', 'CLIENT', 'QUOTE', 'REQUEST'];

/** The custom fields as stored (`[{ label, value }]`); anything else in the column is not shown. */
function customFields(value: Prisma.JsonValue | null): InvoiceCustomField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.label === 'string' && typeof entry.value === 'string'
      ? [{ label: entry.label, value: entry.value }]
      : [],
  );
}

/** Everything else Jobber keeps on the invoice, as its page shows it. */
export function extraDetails(row: DetailRow): InvoiceExtraDetails {
  return {
    contractDisclaimer: row.contractDisclaimer,
    billingName: row.billingName,
    propertyAddress: row.propertyAddress,
    billingSameAsProperty: row.billingSameAsProperty,
    clientEmails: row.clientEmails,
    clientPhones: row.clientPhones,
    paidOn: day(row.paidOn),
    viewedAt: row.viewedAt?.toISOString() ?? null,
    salespersonName: row.salespersonName,
    jobTitle: row.jobTitle,
    discountCents: row.discountCents,
    discountPercent: row.discountKind === 'PERCENT' ? row.discountRate : null,
    depositCents: row.depositCents,
    tipsCents: row.tipsCents,
    taxRateName: row.taxRateName,
    taxRatePercent: row.taxRatePercent,
    taxInclusive: row.taxInclusive,
    customFields: customFields(row.customFields),
    notes: row.notes.map((note) => ({
      id: note.id,
      kind: NOTE_KINDS.includes(note.kind as InvoiceNoteView['kind']) ? (note.kind as InvoiceNoteView['kind']) : 'INVOICE',
      message: note.message,
      pinned: note.pinned,
      writtenAt: note.writtenAt.toISOString(),
    })),
    // Jobber's own address for each, until the console keeps its own copy.
    files: row.files.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      url: file.jobberUrl,
      uploadedAt: file.uploadedAt.toISOString(),
    })),
  };
}

const bucket = (count: number | null | undefined, cents: number | null | undefined): InvoiceBucket => ({
  count: count ?? 0,
  amountCents: cents ?? 0,
});

/** Where reading Jobber's invoices stands (JobberInvoiceWorker), for the list to say why it is empty. */
export function jobberRead(
  connection: {
    status: JobberConnectionStatus;
    invoiceReadProblem: string | null;
    invoiceReadCheckedAt: Date | null;
    invoiceReadCompletedAt: Date | null;
  } | null,
): InvoiceJobberRead {
  if (!connection || connection.status !== JobberConnectionStatus.CONNECTED)
    return { problem: 'NOT_CONNECTED', checkedAt: null, firstReadDone: Boolean(connection?.invoiceReadCompletedAt) };
  const problem =
    connection.invoiceReadProblem === 'NOT_PERMITTED' || connection.invoiceReadProblem === 'FAILED'
      ? connection.invoiceReadProblem
      : null;
  return {
    problem,
    checkedAt: connection.invoiceReadCheckedAt?.toISOString() ?? null,
    firstReadDone: connection.invoiceReadCompletedAt !== null,
  };
}

/** An invoice with its status filter, as Jobber's list filters it. */
function filterWhere(filter: InvoiceFilter, today: string): Prisma.InvoiceWhereInput {
  const todayDate = dateOf(today);
  switch (filter) {
    case 'past_due':
      return { status: InvoiceStatus.AWAITING_PAYMENT, dueOn: { lt: todayDate } };
    case 'not_yet_due':
      return { status: InvoiceStatus.AWAITING_PAYMENT, OR: [{ dueOn: null }, { dueOn: { gte: todayDate } }] };
    case 'awaiting_payment':
      return { status: InvoiceStatus.AWAITING_PAYMENT };
    case 'draft':
      return { status: InvoiceStatus.DRAFT };
    case 'paid':
      return { status: InvoiceStatus.PAID };
    case 'bad_debt':
      return { status: InvoiceStatus.BAD_DEBT };
    case 'voided':
      return { status: InvoiceStatus.VOIDED };
    default:
      return {};
  }
}

/** By the address it is made out to, or its number ("8439", "#8439"). */
function searchWhere(search: string | undefined): Prisma.InvoiceWhereInput {
  const term = search?.trim().replace(/^#/, '') ?? '';
  if (!term) return {};
  return {
    OR: [
      { clientName: { contains: term, mode: 'insensitive' } },
      { propertywareBuilding: { addressLine1: { contains: term, mode: 'insensitive' } } },
      { number: { startsWith: term } },
      { jobNumber: { startsWith: term } },
    ],
  };
}

export interface InvoiceListQuery {
  filter?: InvoiceFilter;
  search?: string;
  page?: number;
  pageSize?: number;
  propertyId?: string;
  inspectionId?: string;
}

export interface PaymentListQuery {
  search?: string;
  method?: PaymentMethod;
  page?: number;
  pageSize?: number;
}

/** The services the technician reported done, in the order the report lists them. */
export function servicesDone(report: VisitServicesReport | null | undefined): ReportableVisitService[] {
  return REPORTABLE_VISIT_SERVICES.filter((service) => report?.services?.[service]?.done === true);
}

/**
 * A finished visit's lines: one per service done, at the office's price for
 * it, or at nothing with the usual name when the office has never billed it --
 * the editor then asks for a price rather than guessing one.
 */
export function draftLines(
  services: readonly ReportableVisitService[],
  products: readonly { name: string; unitPriceCents: number }[],
): InvoiceLineInput[] {
  return services.map((service) => {
    const word = SERVICE_PRODUCT_WORD[service];
    const product = products.find((candidate) => candidate.name.toLowerCase().includes(word));
    return {
      name: product?.name ?? SERVICE_LINE_NAME[service],
      description: null,
      quantity: 1,
      unitPriceCents: product?.unitPriceCents ?? 0,
    };
  });
}

/**
 * The office's price list, read from its own invoices: each product or service
 * billed in the past six months, at the price it was billed at most often, the
 * most billed first. Jobber's products list needs a scope of its own; what the
 * office actually charges is already in the copy.
 */
export function priceList(
  rows: readonly { name: string; unitPriceCents: number; _count: { _all: number } }[],
): { name: string; unitPriceCents: number }[] {
  const byName = new Map<string, { name: string; unitPriceCents: number; best: number; uses: number }>();
  for (const row of rows) {
    if (row.unitPriceCents <= 0 || !row.name.trim()) continue;
    const key = row.name.trim().toLowerCase();
    const count = row._count._all;
    const known = byName.get(key);
    if (!known) byName.set(key, { name: row.name.trim(), unitPriceCents: row.unitPriceCents, best: count, uses: count });
    else {
      known.uses += count;
      if (count > known.best) Object.assign(known, { unitPriceCents: row.unitPriceCents, best: count });
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
    .slice(0, MAX_PRODUCTS)
    .map(({ name, unitPriceCents }) => ({ name, unitPriceCents }));
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class InvoicesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, query: InvoiceListQuery = {}): Promise<InvoiceList> {
    const today = businessDate();
    const filter = query.filter ?? 'all';
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    // The Overview and the Status pill count what the page is about -- the
    // whole office, a property, or a visit -- whatever is searched.
    const scope: Prisma.InvoiceWhereInput = {
      organizationId: user.organizationId,
      ...(query.propertyId ? { propertywareBuildingId: query.propertyId } : {}),
      ...(query.inspectionId ? { inspectionId: query.inspectionId } : {}),
    };
    const where: Prisma.InvoiceWhereInput = { AND: [scope, filterWhere(filter, today), searchWhere(query.search)] };
    const issued = (from: number, to: number): Prisma.InvoiceWhereInput => ({
      AND: [
        scope,
        { status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] } },
        { issuedOn: { gte: daysBefore(today, to), lte: daysBefore(today, from) } },
      ],
    });

    const [rows, total, byStatus, pastDue, last30, previous30, synced, connection] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ issuedOn: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: summarySelect,
      }),
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.groupBy({
        by: ['status'],
        where: scope,
        _count: { _all: true },
        _sum: { totalCents: true, balanceCents: true },
      }),
      this.prisma.invoice.aggregate({
        where: { AND: [scope, filterWhere('past_due', today)] },
        _count: { _all: true },
        _sum: { balanceCents: true },
      }),
      this.prisma.invoice.aggregate({ where: issued(0, 29), _count: { _all: true }, _sum: { totalCents: true } }),
      this.prisma.invoice.aggregate({ where: issued(30, 59), _count: { _all: true }, _sum: { totalCents: true } }),
      this.prisma.invoice.aggregate({ where: { organizationId: user.organizationId }, _max: { syncedAt: true } }),
      this.prisma.jobberConnection.findUnique({
        where: { organizationId: user.organizationId },
        select: { status: true, invoiceReadProblem: true, invoiceReadCheckedAt: true, invoiceReadCompletedAt: true },
      }),
    ]);

    const status = (key: InvoiceStatus) => byStatus.find((row) => row.status === key);
    const count = (key: InvoiceStatus) => status(key)?._count._all ?? 0;
    const awaiting = status(InvoiceStatus.AWAITING_PAYMENT);
    const pastDueCount = pastDue._count._all;
    const pastDueCents = pastDue._sum.balanceCents ?? 0;
    return {
      items: rows.map((row) => summary(row, today)),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      overview: {
        pastDue: bucket(pastDueCount, pastDueCents),
        notYetDue: bucket(
          (awaiting?._count._all ?? 0) - pastDueCount,
          (awaiting?._sum.balanceCents ?? 0) - pastDueCents,
        ),
        draft: bucket(count(InvoiceStatus.DRAFT), status(InvoiceStatus.DRAFT)?._sum.totalCents),
      },
      issued: {
        last30: bucket(last30._count._all, last30._sum.totalCents),
        previous30: bucket(previous30._count._all, previous30._sum.totalCents),
      },
      filterCounts: {
        all: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        past_due: pastDueCount,
        not_yet_due: count(InvoiceStatus.AWAITING_PAYMENT) - pastDueCount,
        awaiting_payment: count(InvoiceStatus.AWAITING_PAYMENT),
        draft: count(InvoiceStatus.DRAFT),
        paid: count(InvoiceStatus.PAID),
        bad_debt: count(InvoiceStatus.BAD_DEBT),
        voided: count(InvoiceStatus.VOIDED),
      },
      syncedAt: synced._max.syncedAt?.toISOString() ?? null,
      jobberRead: jobberRead(connection),
    };
  }

  async one(user: AuthenticatedUser, id: string): Promise<InvoiceDetail> {
    const row = await this.prisma.invoice.findFirst({
      where: { id, organizationId: user.organizationId },
      select: detailSelect,
    });
    if (!row) throw this.notFound();
    return this.detail(user, row);
  }

  /** What a finished visit would be invoiced for, before anybody edits it. */
  async draft(user: AuthenticatedUser, inspectionId: string): Promise<InvoiceDraft> {
    const inspection = await this.invoiceableVisit(user, inspectionId);
    const today = businessDate();
    const [products, latest, existing] = await Promise.all([
      this.products(user, today),
      // The office's own wording and terms, from the latest invoice it issued.
      this.prisma.invoice.findFirst({
        where: { organizationId: user.organizationId, issuedOn: { not: null } },
        orderBy: [{ issuedOn: 'desc' }, { createdAt: 'desc' }],
        select: { subject: true, clientMessage: true, paymentTermsDays: true },
      }),
      this.prisma.invoice.findFirst({
        where: { organizationId: user.organizationId, inspectionId, status: { not: InvoiceStatus.VOIDED } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, status: true, dueOn: true },
      }),
    ]);
    const terms = latest?.paymentTermsDays;
    return {
      inspection: {
        id: inspection.id,
        inspectionType: inspection.inspectionType,
        scheduledOn: day(inspection.scheduledAt)!,
        status: inspection.status,
      },
      property: property(inspection.building),
      clientName: inspection.clientName,
      subject: latest?.subject?.trim() || DEFAULT_SUBJECT,
      issuedOn: today,
      paymentTermsDays: PAYMENT_TERMS.some((option) => option.days === terms) ? terms! : DEFAULT_TERMS_DAYS,
      lineItems: draftLines(servicesDone(inspection.servicesReport), products),
      clientMessage: latest?.clientMessage ?? '',
      existing: existing
        ? { id: existing.id, number: existing.number, status: invoiceStatusOn(existing.status, day(existing.dueOn), today) }
        : null,
      products,
    };
  }

  async payments(user: AuthenticatedUser, query: PaymentListQuery = {}): Promise<PaymentList> {
    const today = businessDate();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    const term = query.search?.trim().replace(/^#/, '') ?? '';
    const where: Prisma.InvoicePaymentWhereInput = {
      organizationId: user.organizationId,
      ...(query.method ? { method: query.method } : {}),
      ...(term
        ? {
            OR: [
              { reference: { contains: term, mode: 'insensitive' } },
              { invoice: { clientName: { contains: term, mode: 'insensitive' } } },
              { invoice: { number: { startsWith: term } } },
            ],
          }
        : {}),
    };
    const received = (from: number, to: number) =>
      this.prisma.invoicePayment.aggregate({
        where: { organizationId: user.organizationId, paidOn: { gte: daysBefore(today, to), lte: daysBefore(today, from) } },
        _count: { _all: true },
        _sum: { amountCents: true },
      });
    const [rows, total, last30, previous30] = await Promise.all([
      this.prisma.invoicePayment.findMany({
        where,
        orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { ...paymentSelect(), invoice: { select: paidInvoiceSelect } },
      }),
      this.prisma.invoicePayment.count({ where }),
      received(0, 29),
      received(30, 59),
    ]);
    return {
      items: rows.map(({ invoice, ...row }) => ({
        ...payment(row),
        invoice: { id: invoice.id, number: invoice.number, subject: invoice.subject, clientName: invoice.clientName },
        property: property(invoice.propertywareBuilding),
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      received: {
        last30: bucket(last30._count._all, last30._sum.amountCents),
        previous30: bucket(previous30._count._all, previous30._sum.amountCents),
      },
    };
  }

  /** One payment on its own page, with the invoice it paid and what that invoice still owes. */
  async onePayment(user: AuthenticatedUser, id: string): Promise<PaymentDetail> {
    const row = await this.prisma.invoicePayment.findFirst({
      where: { id, organizationId: user.organizationId },
      select: {
        ...paymentSelect(),
        jobberPaymentType: true,
        updatedAt: true,
        invoice: { select: { ...paidInvoiceSelect, totalCents: true, balanceCents: true, status: true, dueOn: true } },
      },
    });
    if (!row) throw this.paymentNotFound();
    const { invoice, jobberPaymentType, updatedAt, ...rest } = row;
    return {
      ...payment(rest),
      origin: rest.origin,
      jobberPaymentType,
      invoice: { id: invoice.id, number: invoice.number, subject: invoice.subject, clientName: invoice.clientName },
      property: property(invoice.propertywareBuilding),
      invoiceTotalCents: invoice.totalCents,
      invoiceBalanceCents: invoice.balanceCents,
      invoiceStatus: invoiceStatusOn(invoice.status, day(invoice.dueOn), businessDate()),
      updatedAt: updatedAt.toISOString(),
      writesEnabled: getJobberConfig().invoiceWritesEnabled,
      brand: receiptBrand(),
    };
  }

  /**
   * A payment corrected (2026-11-06): its amount, day, method, reference and
   * note. The invoice's balance is worked out again in the same transaction --
   * never more than it owed with this payment taken back, never a day to come
   * -- and only if neither the payment nor the invoice changed since they were
   * read, so two people correcting at once cannot both win. Paid in full, it is
   * paid; owing again, it is awaiting payment. Written to the record with the
   * payment as it was and as it is.
   */
  async changePayment(user: AuthenticatedUser, id: string, input: ChangePaymentInput): Promise<PaymentDetail> {
    this.requireWrites();
    const today = businessDate();
    const reference = input.reference?.trim() || null;
    const note = input.note?.trim() || null;
    await this.prisma.$transaction(async (tx) => {
      const found = await this.paymentToChange(tx, user, id, input.expectedUpdatedAt);
      const owed = found.invoice.balanceCents + found.amountCents;
      const problem = paymentProblem(input, owed, today);
      if (problem) throw new ApplicationError(422, 'PAYMENT_INVALID', problem);

      const balanceCents = owed - input.amountCents;
      await this.settleInvoice(tx, user, found, balanceCents);
      const { count } = await tx.invoicePayment.updateMany({
        where: { id, organizationId: user.organizationId, updatedAt: found.updatedAt },
        data: { amountCents: input.amountCents, paidOn: dateOf(input.paidOn), method: input.method, reference, note },
      });
      if (!count) throw this.paymentChanged();
      if (balanceCents === 0) await this.stampPaidInFull(tx, found.invoiceId);
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'INVOICE_PAYMENT_CHANGED',
          entityType: 'Invoice',
          entityId: found.invoiceId,
          metadata: {
            paymentId: id,
            before: paymentRecord(found),
            after: { amountCents: input.amountCents, paidOn: input.paidOn, method: input.method, reference, note },
            balanceCents,
          },
        },
      });
    });
    return this.onePayment(user, id);
  }

  /**
   * A payment taken off its invoice (2026-11-06): the invoice owes its amount
   * again, in the same transaction and only if neither changed since they were
   * read. The payment is gone from the invoice; what it was -- amount, day,
   * method, reference, note, who recorded it -- stays on the record.
   */
  async removePayment(user: AuthenticatedUser, id: string, expectedUpdatedAt: string): Promise<{ invoiceId: string }> {
    this.requireWrites();
    const found = await this.prisma.$transaction(async (tx) => {
      const payment = await this.paymentToChange(tx, user, id, expectedUpdatedAt);
      const balanceCents = payment.invoice.balanceCents + payment.amountCents;
      await this.settleInvoice(tx, user, payment, balanceCents);
      const { count } = await tx.invoicePayment.deleteMany({
        where: { id, organizationId: user.organizationId, updatedAt: payment.updatedAt },
      });
      if (!count) throw this.paymentChanged();
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'INVOICE_PAYMENT_REMOVED',
          entityType: 'Invoice',
          entityId: payment.invoiceId,
          metadata: { paymentId: id, removed: paymentRecord(payment), balanceCents },
        },
      });
      return payment;
    });
    return { invoiceId: found.invoiceId };
  }

  /**
   * An invoice for a finished visit, made out to its property, its lines
   * priced as entered and its totals worked out here -- never taken from the
   * browser. One per key: a resend answers with the invoice already made.
   */
  async create(user: AuthenticatedUser, input: CreateInvoiceInput): Promise<InvoiceDetail> {
    this.requireWrites();
    const prior = await this.byInvoiceKey(user, input.clientRequestId);
    if (prior) return this.answerResend(user, prior, input.inspectionId);

    const today = businessDate();
    const subject = input.subject.trim();
    if (!subject) throw new ApplicationError(422, 'INVOICE_INVALID', 'Give the invoice a subject.');
    if (!DAY.test(input.issuedOn) || Number.isNaN(dateOf(input.issuedOn).getTime()))
      throw new ApplicationError(422, 'INVOICE_INVALID', 'Give the day the invoice is issued.');
    if (input.issuedOn > today)
      throw new ApplicationError(422, 'INVOICE_INVALID', 'An invoice cannot be issued on a day still to come.');
    if (!PAYMENT_TERMS.some((option) => option.days === input.paymentTermsDays))
      throw new ApplicationError(422, 'INVOICE_INVALID', 'Pick the payment terms from the list.');
    const lines = input.lineItems.map((line) => ({
      name: line.name.trim(),
      description: line.description?.trim() || null,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    }));
    const problem = invoiceLinesProblem(lines);
    if (problem) throw new ApplicationError(422, 'INVOICE_INVALID', problem);

    const visit = await this.invoiceableVisit(user, input.inspectionId);
    const { subtotalCents, totalCents } = invoiceTotals(lines);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.create({
          data: {
            organizationId: user.organizationId,
            origin: InvoiceOrigin.CONSOLE,
            subject,
            status: InvoiceStatus.AWAITING_PAYMENT,
            clientName: visit.clientName,
            inspectionId: visit.id,
            propertywareBuildingId: visit.building.id,
            jobberJobId: visit.jobberJobId,
            issuedOn: dateOf(input.issuedOn),
            dueOn: dateOf(dueOnFor(input.issuedOn, input.paymentTermsDays)),
            paymentTermsDays: input.paymentTermsDays,
            subtotalCents,
            taxCents: 0,
            totalCents,
            balanceCents: totalCents,
            clientMessage: input.clientMessage?.trim() || null,
            createdById: user.id,
            clientRequestId: input.clientRequestId,
            lines: {
              create: lines.map((line, position) => ({
                organizationId: user.organizationId,
                position,
                ...line,
                totalCents: lineTotalCents(line),
              })),
            },
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: 'INVOICE_CREATED',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: {
              inspectionId: visit.id,
              totalCents,
              lineCount: lines.length,
              issuedOn: input.issuedOn,
              paymentTermsDays: input.paymentTermsDays,
              clientRequestId: input.clientRequestId,
            },
          },
        });
        return invoice;
      });
      return this.one(user, created.id);
    } catch (error) {
      // The same key, sent twice at once: the other request made it.
      if (isUniqueViolation(error)) {
        const made = await this.byInvoiceKey(user, input.clientRequestId);
        if (made) return this.answerResend(user, made, input.inspectionId);
      }
      throw error;
    }
  }

  /**
   * A payment that came in, against an invoice still owing. Never more than it
   * owes and never a day to come; the balance is lowered in the same
   * transaction, only if it is still what was read, so two people recording at
   * once cannot both take it below nothing. Paid in full, it is paid.
   */
  async recordPayment(user: AuthenticatedUser, invoiceId: string, input: RecordPaymentInput): Promise<InvoiceDetail> {
    this.requireWrites();
    const prior = await this.byPaymentKey(user, input.clientRequestId);
    if (prior) return this.answerPaymentResend(user, prior, invoiceId);

    const today = businessDate();
    const reference = input.reference?.trim() || null;
    const note = input.note?.trim() || null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.findFirst({
          where: { id: invoiceId, organizationId: user.organizationId },
          select: { status: true, dueOn: true, balanceCents: true },
        });
        if (!invoice) throw this.notFound();
        const status = invoiceStatusOn(invoice.status, day(invoice.dueOn), today);
        if (!acceptsPayment({ status, balanceCents: invoice.balanceCents }))
          throw new ApplicationError(409, 'INVOICE_NOT_PAYABLE', 'This invoice is not waiting for a payment.');
        const problem = paymentProblem(input, invoice.balanceCents, today);
        if (problem) throw new ApplicationError(422, 'PAYMENT_INVALID', problem);

        const balanceCents = invoice.balanceCents - input.amountCents;
        const { count } = await tx.invoice.updateMany({
          where: {
            id: invoiceId,
            organizationId: user.organizationId,
            status: InvoiceStatus.AWAITING_PAYMENT,
            balanceCents: invoice.balanceCents,
          },
          // Paid in full on the day of the payment that paid it, as Jobber keeps it.
          data: { balanceCents, ...(balanceCents === 0 ? { status: InvoiceStatus.PAID, paidOn: dateOf(input.paidOn) } : {}) },
        });
        if (!count)
          throw new ApplicationError(
            409,
            'INVOICE_CHANGED',
            'This invoice changed while the payment was being recorded. Look at it again, then record the payment.',
          );
        const recorded = await tx.invoicePayment.create({
          data: {
            organizationId: user.organizationId,
            invoiceId,
            origin: InvoiceOrigin.CONSOLE,
            paidOn: dateOf(input.paidOn),
            amountCents: input.amountCents,
            method: input.method,
            reference,
            note,
            recordedById: user.id,
            clientRequestId: input.clientRequestId,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: 'INVOICE_PAYMENT_RECORDED',
            entityType: 'Invoice',
            entityId: invoiceId,
            metadata: {
              paymentId: recorded.id,
              amountCents: input.amountCents,
              method: input.method,
              paidOn: input.paidOn,
              balanceCents,
              clientRequestId: input.clientRequestId,
            },
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const made = await this.byPaymentKey(user, input.clientRequestId);
        if (made) return this.answerPaymentResend(user, made, invoiceId);
      }
      throw error;
    }
    return this.one(user, invoiceId);
  }

  private async detail(user: AuthenticatedUser, row: DetailRow): Promise<InvoiceDetail> {
    const today = businessDate();
    // "Account balance", as Jobber shows it: everything the same client still owes.
    const client: Prisma.InvoiceWhereInput | null = row.jobberClientId
      ? { jobberClientId: row.jobberClientId }
      : row.propertywareBuildingId
        ? { propertywareBuildingId: row.propertywareBuildingId }
        : null;
    const account = client
      ? await this.prisma.invoice.aggregate({
          where: { organizationId: user.organizationId, status: InvoiceStatus.AWAITING_PAYMENT, ...client },
          _sum: { balanceCents: true },
        })
      : null;
    return {
      ...summary(row, today),
      paymentTerms: paymentTermsLabel(row.paymentTermsDays),
      billingAddress: row.billingAddress,
      lineItems: row.lines.map(lineItem),
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
      payments: row.payments.map(payment),
      clientMessage: row.clientMessage,
      accountBalanceCents: account ? (account._sum.balanceCents ?? 0) : null,
      createdAt: row.createdAt.toISOString(),
      details: extraDetails(row),
      // For editing it (2026-11-06): as it was read, what it has been paid, and whether edits are on.
      updatedAt: row.updatedAt.toISOString(),
      paidCents: row.payments.reduce((sum, paid) => sum + paid.amountCents, 0),
      writesEnabled: getJobberConfig().invoiceWritesEnabled,
    };
  }

  /** The office's prices, from what it billed in the past six months. */
  private async products(user: AuthenticatedUser, today: string) {
    const rows = await this.prisma.invoiceLine.groupBy({
      by: ['name', 'unitPriceCents'],
      where: {
        organizationId: user.organizationId,
        invoice: {
          status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] },
          issuedOn: { gte: daysBefore(today, PRICE_WINDOW_DAYS) },
        },
      },
      _count: { _all: true },
    });
    return priceList(rows);
  }

  /** A finished visit with a property: the only kind an invoice is made for. */
  private async invoiceableVisit(user: AuthenticatedUser, inspectionId: string) {
    const row = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId },
      select: {
        id: true,
        inspectionType: true,
        scheduledAt: true,
        status: true,
        jobberJobId: true,
        servicesReport: true,
        propertywareBuilding: { select: { id: true, name: true, addressLine1: true, city: true } },
      },
    });
    if (!row) throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'That visit was not found.');
    if (!isFinishedStatus(row.status))
      throw new ApplicationError(409, 'INVOICE_VISIT_NOT_FINISHED', 'A visit is invoiced once it is finished.');
    const building = row.propertywareBuilding;
    if (!building) throw new ApplicationError(422, 'INVOICE_NO_PROPERTY', 'This visit has no property to invoice.');
    return {
      ...row,
      building,
      clientName: building.addressLine1 ?? building.name,
      servicesReport: row.servicesReport as unknown as VisitServicesReport | null,
    };
  }

  private byInvoiceKey(user: AuthenticatedUser, clientRequestId: string) {
    return this.prisma.invoice.findFirst({
      where: { organizationId: user.organizationId, clientRequestId },
      select: { id: true, inspectionId: true },
    });
  }

  private byPaymentKey(user: AuthenticatedUser, clientRequestId: string) {
    return this.prisma.invoicePayment.findFirst({
      where: { organizationId: user.organizationId, clientRequestId },
      select: { invoiceId: true },
    });
  }

  /** A resend of the same invoice answers with it; the same key for another visit is a mistake. */
  private answerResend(user: AuthenticatedUser, prior: { id: string; inspectionId: string | null }, inspectionId: string) {
    if (prior.inspectionId !== inspectionId) throw this.keyReused();
    return this.one(user, prior.id);
  }

  private answerPaymentResend(user: AuthenticatedUser, prior: { invoiceId: string }, invoiceId: string) {
    if (prior.invoiceId !== invoiceId) throw this.keyReused();
    return this.one(user, invoiceId);
  }

  /**
   * A payment to correct or remove, as it was read: refused when it changed
   * since (`expectedUpdatedAt`), when it is a refund, or when its invoice is
   * closed to payments.
   */
  private async paymentToChange(tx: Prisma.TransactionClient, user: AuthenticatedUser, id: string, expectedUpdatedAt: string) {
    const found = await tx.invoicePayment.findFirst({
      where: { id, organizationId: user.organizationId },
      select: {
        invoiceId: true,
        amountCents: true,
        paidOn: true,
        method: true,
        reference: true,
        note: true,
        origin: true,
        recordedById: true,
        updatedAt: true,
        invoice: { select: { status: true, balanceCents: true } },
      },
    });
    if (!found) throw this.paymentNotFound();
    if (found.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) throw this.paymentChanged();
    const locked = paymentLockedReason({ amountCents: found.amountCents, invoiceStatus: found.invoice.status });
    if (locked) throw new ApplicationError(409, 'PAYMENT_LOCKED', locked);
    return found;
  }

  /**
   * The invoice's new balance, written only if it is still what was read: paid
   * when nothing is owed, awaiting payment (and no longer paid in full) when
   * something is.
   */
  private async settleInvoice(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    found: { invoiceId: string; invoice: { status: InvoiceStatus; balanceCents: number } },
    balanceCents: number,
  ) {
    const { count } = await tx.invoice.updateMany({
      where: {
        id: found.invoiceId,
        organizationId: user.organizationId,
        status: found.invoice.status,
        balanceCents: found.invoice.balanceCents,
      },
      data:
        balanceCents === 0
          ? { balanceCents, status: InvoiceStatus.PAID }
          : { balanceCents, status: InvoiceStatus.AWAITING_PAYMENT, paidOn: null },
    });
    if (!count)
      throw new ApplicationError(
        409,
        'INVOICE_CHANGED',
        'This invoice changed while the payment was being changed. Look at it again, then make the change.',
      );
  }

  /** Paid in full on the day of its latest payment, once a correction leaves nothing owed. */
  private async stampPaidInFull(tx: Prisma.TransactionClient, invoiceId: string) {
    const latest = await tx.invoicePayment.aggregate({ where: { invoiceId }, _max: { paidOn: true } });
    await tx.invoice.update({ where: { id: invoiceId }, data: { paidOn: latest._max.paidOn ?? null } });
  }

  private requireWrites() {
    if (!getJobberConfig().invoiceWritesEnabled)
      throw new ApplicationError(
        409,
        'INVOICE_WRITES_OFF',
        'Invoices and payments are made and changed in Jobber until the console takes over invoicing.',
      );
  }

  private paymentNotFound() {
    return new ApplicationError(404, 'PAYMENT_NOT_FOUND', 'That payment was not found.');
  }

  private paymentChanged() {
    return new ApplicationError(
      409,
      'PAYMENT_CHANGED',
      'This payment changed since it was opened. Look at it again, then make the change.',
    );
  }

  private keyReused() {
    return new ApplicationError(409, 'IDEMPOTENCY_KEY_REUSED', 'That request key was already used for something else.');
  }

  private notFound() {
    return new ApplicationError(404, 'INVOICE_NOT_FOUND', 'That invoice was not found.');
  }
}
