import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_INVOICES_PER_VISIT,
  PAYMENT_TERMS,
  REPORTABLE_VISIT_SERVICES,
  acceptsPayment,
  invoiceCompany,
  splitByCompany,
  invoiceLinesProblem,
  invoiceStatusOn,
  isFinishedStatus,
  paymentLockedReason,
  paymentProblem,
  paymentTermsLabel,
  type CreateInvoiceInput,
  type CreateInvoicesInput,
  type CreatedInvoices,
  type InvoiceBucket,
  type InvoiceCustomField,
  type InvoiceDeliveryKind,
  type InvoiceDeliveryStatus,
  type InvoiceDeliveryView,
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
  type RecordPaymentInput,
  type ReportableVisitService,
  type VisitServicesReport,
} from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, JobberConnectionStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { defaultRecipients } from './invoice-email-settings';
import { insertConsoleInvoice } from './invoice-insert';
import {
  invoiceWritesOff,
  invoiceWritesOn,
  newInvoiceDefaults,
  officeBrand,
  officeOrganisations,
  officePrices,
  organisationName,
  productCompanies,
} from './invoice-settings';

// Kept exported from here for the callers that already import them (phase 6 moved them).
export { priceList, receiptBrand } from './invoice-settings';

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
  // The company's books it goes to (2026-11-10).
  xeroOrganisation: { select: { xeroTenantId: true, name: true } },
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
    select: { id: true, kind: true, message: true, pinned: true, writtenAt: true, origin: true, createdBy: { select: { displayName: true } } },
  },
  files: {
    orderBy: { uploadedAt: 'asc' },
    select: {
      id: true,
      fileName: true,
      contentType: true,
      sizeBytes: true,
      jobberUrl: true,
      uploadedAt: true,
      storageKey: true,
      copyProblem: true,
      origin: true,
    },
  },
  showQuantities: true,
  showUnitPrices: true,
  showLineTotals: true,
  showAccountBalance: true,
  showLateStamp: true,
  // Each time it was sent to the client from the console (2026-11-06), newest first.
  deliveries: {
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      channel: true,
      kind: true,
      followUpDay: true,
      recipients: true,
      status: true,
      failure: true,
      createdAt: true,
      sentAt: true,
      sentBy: { select: { id: true, displayName: true } },
    },
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
/** An email about an invoice, as its page lists it. */
const DELIVERY_SELECT = {
  id: true,
  channel: true,
  kind: true,
  followUpDay: true,
  recipients: true,
  status: true,
  failure: true,
  createdAt: true,
  sentAt: true,
  sentBy: { select: { id: true, displayName: true } },
} satisfies Prisma.InvoiceDeliverySelect;

export function deliveryView(delivery: Prisma.InvoiceDeliveryGetPayload<{ select: typeof DELIVERY_SELECT }>): InvoiceDeliveryView {
  return {
    id: delivery.id,
    channel: 'EMAIL',
    kind: delivery.kind as InvoiceDeliveryKind,
    followUpDay: delivery.followUpDay,
    recipients: delivery.recipients,
    status: delivery.status as InvoiceDeliveryStatus,
    failure: delivery.failure,
    sentBy: delivery.sentBy,
    createdAt: delivery.createdAt.toISOString(),
    sentAt: delivery.sentAt?.toISOString() ?? null,
  };
}

/** Who a receipt goes to: whoever the invoice was last sent to, else the client's addresses. */
const RECEIPT_TO_SELECT = {
  clientEmails: true,
  deliveries: {
    where: { kind: 'INVOICE', status: 'SENT' },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { recipients: true },
  },
} satisfies Prisma.InvoiceSelect;

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
    company: row.xeroOrganisation ? { tenantId: row.xeroOrganisation.xeroTenantId, name: row.xeroOrganisation.name } : null,
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
      origin: note.origin === 'CONSOLE' ? ('CONSOLE' as const) : ('JOBBER' as const),
      author: note.createdBy?.displayName ?? null,
    })),
    // Jobber's own address for each, and whether the console keeps its own copy (phase 7).
    files: row.files.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      url: file.jobberUrl,
      uploadedAt: file.uploadedAt.toISOString(),
      kept: file.storageKey !== null,
      copyProblem: file.copyProblem,
      origin: file.origin === 'CONSOLE' ? ('CONSOLE' as const) : ('JOBBER' as const),
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
  /** Issued on or after, and on or before (2026-11-09): Jobber's date filter. */
  issuedFrom?: string;
  issuedTo?: string;
  /** One company's invoices (2026-11-10): an organisation's tenant id, or `none` for those that belong to no company. */
  company?: string;
}

export interface PaymentListQuery {
  search?: string;
  method?: PaymentMethod;
  page?: number;
  pageSize?: number;
  /** Paid on or after, and on or before (2026-11-09). */
  paidFrom?: string;
  paidTo?: string;
}

/** A span of days as a where clause on a date column; empty when neither end is given. */
function daysWhere(from: string | undefined, to: string | undefined) {
  if (!from && !to) return null;
  return { ...(from ? { gte: dateOf(from) } : {}), ...(to ? { lte: dateOf(to) } : {}) };
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
      // One company's books, or those of none (2026-11-10).
      ...(query.company ? { xeroTenantId: query.company === 'none' ? null : query.company } : {}),
    };
    const issuedWithin = daysWhere(query.issuedFrom, query.issuedTo);
    const where: Prisma.InvoiceWhereInput = {
      AND: [scope, filterWhere(filter, today), searchWhere(query.search), ...(issuedWithin ? [{ issuedOn: issuedWithin }] : [])],
    };
    const issued = (from: number, to: number): Prisma.InvoiceWhereInput => ({
      AND: [
        scope,
        { status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] } },
        { issuedOn: { gte: daysBefore(today, to), lte: daysBefore(today, from) } },
      ],
    });

    const [rows, total, byStatus, pastDue, last30, previous30, synced, connection, organisations] = await Promise.all([
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
      officeOrganisations(this.prisma, user.organizationId),
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
      writesEnabled: await invoiceWritesOn(this.prisma, user.organizationId),
      organisations,
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

  /** What a new invoice starts from: the office's prices and settings, else the latest invoice it issued (2026-11-06). */
  async officeDefaults(user: AuthenticatedUser) {
    const [products, defaults] = await Promise.all([
      officePrices(this.prisma, user.organizationId, businessDate()),
      newInvoiceDefaults(this.prisma, user.organizationId),
    ]);
    return { products, ...defaults };
  }

  /**
   * What a finished visit would be invoiced for, before anybody edits it; or,
   * for a property no visit covers (2026-11-06), an invoice made out to it with
   * no lines yet. Split one invoice per company (2026-11-10): each company's
   * services on its own, and those that go to no company on one of their own.
   */
  async draft(user: AuthenticatedUser, target: { inspectionId?: string; propertyId?: string }): Promise<InvoiceDraft> {
    const inspection = target.inspectionId ? await this.invoiceableVisit(user, target.inspectionId) : null;
    const place = inspection ?? (await this.invoiceableProperty(user, target.propertyId ?? ''));
    const today = businessDate();
    const [products, defaults, existing, companies, organisations] = await Promise.all([
      officePrices(this.prisma, user.organizationId, today),
      // The office's settings, else its own wording and terms from the latest invoice it issued.
      newInvoiceDefaults(this.prisma, user.organizationId),
      inspection
        ? this.prisma.invoice.findMany({
            where: { organizationId: user.organizationId, inspectionId: inspection.id, status: { not: InvoiceStatus.VOIDED } },
            orderBy: { createdAt: 'desc' },
            take: MAX_INVOICES_PER_VISIT,
            select: { id: true, number: true, status: true, dueOn: true, xeroTenantId: true },
          })
        : [],
      productCompanies(this.prisma, user.organizationId),
      officeOrganisations(this.prisma, user.organizationId),
    ]);
    const parts = splitByCompany(inspection ? draftLines(servicesDone(inspection.servicesReport), products) : [], companies);
    return {
      inspection: inspection
        ? {
            id: inspection.id,
            inspectionType: inspection.inspectionType,
            scheduledOn: day(inspection.scheduledAt)!,
            status: inspection.status,
          }
        : null,
      property: property(place.building),
      clientName: place.clientName,
      subject: defaults.subject,
      issuedOn: today,
      paymentTermsDays: defaults.termsDays,
      invoices: parts.length ? parts : [{ xeroTenantId: null, lineItems: [] }],
      clientMessage: defaults.clientMessage ?? '',
      existing: existing.map((row) => ({
        id: row.id,
        number: row.number,
        status: invoiceStatusOn(row.status, day(row.dueOn), today),
        xeroTenantId: row.xeroTenantId,
      })),
      products,
      organisations,
    };
  }

  async payments(user: AuthenticatedUser, query: PaymentListQuery = {}): Promise<PaymentList> {
    const today = businessDate();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    const term = query.search?.trim().replace(/^#/, '') ?? '';
    const paidWithin = daysWhere(query.paidFrom, query.paidTo);
    const where: Prisma.InvoicePaymentWhereInput = {
      organizationId: user.organizationId,
      ...(query.method ? { method: query.method } : {}),
      ...(paidWithin ? { paidOn: paidWithin } : {}),
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
        // Each receipt emailed for it (2026-11-09), and who one would go to.
        receipts: { orderBy: { createdAt: 'desc' }, take: 10, select: DELIVERY_SELECT },
        invoice: { select: { ...paidInvoiceSelect, ...RECEIPT_TO_SELECT, totalCents: true, balanceCents: true, status: true, dueOn: true } },
      },
    });
    if (!row) throw this.paymentNotFound();
    const { invoice, jobberPaymentType, updatedAt, receipts, ...rest } = row;
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
      writesEnabled: await invoiceWritesOn(this.prisma, user.organizationId),
      brand: await officeBrand(this.prisma, user.organizationId),
      receipts: receipts.map(deliveryView),
      receiptTo: defaultRecipients(invoice.deliveries[0]?.recipients, invoice.clientEmails),
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
    await this.requireWrites(user);
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
    await this.requireWrites(user);
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
   * An invoice for a finished visit, made out to its property -- or for a
   * property no visit covers (2026-11-06) -- its lines priced as entered and
   * its totals worked out here, never taken from the browser. Numbered next in
   * the office's sequence, unless it is kept as a draft. One per key: a resend
   * answers with the invoice already made. It goes to its lines' one company,
   * else the one chosen for it, else none (2026-11-10); two companies' lines
   * are refused.
   */
  async create(user: AuthenticatedUser, input: CreateInvoiceInput): Promise<InvoiceDetail> {
    const { lineItems, xeroTenantId, ...form } = input;
    const [made] = await this.make(user, form, [{ xeroTenantId, lineItems, clientRequestId: input.clientRequestId }]);
    return this.one(user, made!.id);
  }

  /**
   * The invoices a visit or a property gets from one form (2026-11-10, phase 3
   * of the multi-company plan): one per company, each with its own lines and
   * number, made together in one write or not at all. The form's key keys each
   * of them (`key:1`, `key:2`, ...), so a resend makes none of them twice.
   */
  async createPerCompany(user: AuthenticatedUser, input: CreateInvoicesInput): Promise<CreatedInvoices> {
    const { invoices, ...form } = input;
    if (!invoices.length) throw new ApplicationError(422, 'INVOICE_INVALID', 'Add at least one line.');
    if (invoices.length > MAX_INVOICES_PER_VISIT)
      throw new ApplicationError(422, 'INVOICE_INVALID', `One form makes at most ${MAX_INVOICES_PER_VISIT} invoices.`);
    const made = await this.make(
      user,
      form,
      invoices.map((part, index) => ({ ...part, clientRequestId: `${input.clientRequestId}:${index + 1}` })),
    );
    const today = businessDate();
    const rows = await this.prisma.invoice.findMany({
      where: { organizationId: user.organizationId, id: { in: made.map((row) => row.id) } },
      select: summarySelect,
    });
    return { invoices: made.map((row) => summary(rows.find((candidate) => candidate.id === row.id)!, today)) };
  }

  /**
   * Makes each invoice asked for, in one transaction, after checking all of
   * them: the form's subject, day and terms; each invoice's lines and its one
   * company; no company twice. Nothing is made unless all of it can be. A
   * resend answers with what the first request made.
   */
  private async make(
    user: AuthenticatedUser,
    form: Omit<CreateInvoiceInput, 'lineItems' | 'xeroTenantId'>,
    parts: { xeroTenantId?: string | null; lineItems: InvoiceLineInput[]; clientRequestId: string }[],
  ): Promise<{ id: string }[]> {
    await this.requireWrites(user);
    if (Boolean(form.inspectionId) === Boolean(form.propertyId))
      throw new ApplicationError(422, 'INVOICE_INVALID', 'Invoice either a finished visit or a property.');
    const target = { inspectionId: form.inspectionId ?? null, propertyId: form.propertyId ?? null };
    const keys = parts.map((part) => part.clientRequestId);
    const prior = await this.byInvoiceKeys(user, keys);
    if (prior.length) return this.answerResend(prior, keys, target);

    const today = businessDate();
    const subject = form.subject.trim();
    if (!subject) throw new ApplicationError(422, 'INVOICE_INVALID', 'Give the invoice a subject.');
    if (!DAY.test(form.issuedOn) || Number.isNaN(dateOf(form.issuedOn).getTime()))
      throw new ApplicationError(422, 'INVOICE_INVALID', 'Give the day the invoice is issued.');
    if (form.issuedOn > today)
      throw new ApplicationError(422, 'INVOICE_INVALID', 'An invoice cannot be issued on a day still to come.');
    if (!PAYMENT_TERMS.some((option) => option.days === form.paymentTermsDays))
      throw new ApplicationError(422, 'INVOICE_INVALID', 'Pick the payment terms from the list.');

    // Which company's books each goes to: its lines' products, else the company chosen for it.
    const [products, organisations] = await Promise.all([
      productCompanies(this.prisma, user.organizationId),
      officeOrganisations(this.prisma, user.organizationId),
    ]);
    const nameOf = organisationName(organisations);
    const companyWords = (tenantId: string | null) => (tenantId ? nameOf(tenantId) : 'no company');
    const companies = new Set<string | null>();
    const invoices = parts.map((part) => {
      const lines = part.lineItems.map((line) => ({
        name: line.name.trim(),
        description: line.description?.trim() || null,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
      }));
      const company = invoiceCompany(lines, products, part.xeroTenantId, nameOf);
      if (company.problem) throw new ApplicationError(422, 'INVOICE_INVALID', company.problem);
      // A company chosen, rather than said by a line, is one connected now.
      const chosen = !invoiceCompany(lines, products, undefined, nameOf).xeroTenantId;
      if (chosen && company.xeroTenantId && !organisations.some((row) => row.tenantId === company.xeroTenantId && row.connected))
        throw new ApplicationError(422, 'INVOICE_INVALID', 'That Xero organisation is not connected.');
      const problem = invoiceLinesProblem(lines);
      if (problem)
        throw new ApplicationError(422, 'INVOICE_INVALID', parts.length > 1 ? `The invoice for ${companyWords(company.xeroTenantId)}: ${problem}` : problem);
      if (companies.has(company.xeroTenantId))
        throw new ApplicationError(422, 'INVOICE_INVALID', `Two invoices go to ${companyWords(company.xeroTenantId)}: put their lines on one.`);
      companies.add(company.xeroTenantId);
      return { lines, xeroTenantId: company.xeroTenantId, clientRequestId: part.clientRequestId };
    });

    const visit = target.inspectionId ? await this.invoiceableVisit(user, target.inspectionId) : null;
    const place = visit ?? (await this.invoiceableProperty(user, target.propertyId ?? ''));
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const { contractDisclaimer } = await newInvoiceDefaults(tx, user.organizationId);
          const made: { id: string }[] = [];
          for (const invoice of invoices)
            made.push(
              await insertConsoleInvoice(tx, user, {
                subject,
                clientName: place.clientName,
                inspectionId: visit?.id ?? null,
                propertywareBuildingId: place.building.id,
                jobberJobId: visit?.jobberJobId ?? null,
                issuedOn: form.issuedOn,
                paymentTermsDays: form.paymentTermsDays,
                lines: invoice.lines,
                clientMessage: form.clientMessage?.trim() || null,
                contractDisclaimer,
                clientRequestId: invoice.clientRequestId,
                asDraft: form.asDraft === true,
                xeroTenantId: invoice.xeroTenantId,
              }),
            );
          return made;
        },
        // Each invoice is a few writes: room for several on a slow connection.
        { maxWait: 5_000, timeout: 20_000 },
      );
    } catch (error) {
      // The same key, sent twice at once: the other request made them.
      if (isUniqueViolation(error)) {
        const made = await this.byInvoiceKeys(user, keys);
        if (made.length) return this.answerResend(made, keys, target);
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
    await this.requireWrites(user);
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
      writesEnabled: await invoiceWritesOn(this.prisma, user.organizationId),
      // For its PDF and its sending (2026-11-06, phase 5), from the office's settings (phase 6).
      brand: await officeBrand(this.prisma, user.organizationId),
      deliveries: row.deliveries.map(deliveryView),
    };
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

  /** An active property of the office, to invoice when no visit covers the work (2026-11-06). */
  private async invoiceableProperty(user: AuthenticatedUser, propertyId: string) {
    const building = await this.prisma.propertywareBuilding.findFirst({
      where: { id: propertyId, organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true, addressLine1: true, city: true },
    });
    if (!building) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'That property was not found.');
    return { building, clientName: building.addressLine1 ?? building.name };
  }

  private byInvoiceKeys(user: AuthenticatedUser, clientRequestIds: string[]) {
    return this.prisma.invoice.findMany({
      where: { organizationId: user.organizationId, clientRequestId: { in: clientRequestIds } },
      select: { id: true, inspectionId: true, propertywareBuildingId: true, clientRequestId: true },
    });
  }

  private byPaymentKey(user: AuthenticatedUser, clientRequestId: string) {
    return this.prisma.invoicePayment.findFirst({
      where: { organizationId: user.organizationId, clientRequestId },
      select: { invoiceId: true },
    });
  }

  /**
   * A resend answers with the invoices the first request made, in the order
   * asked for. The same key for another visit or property, or for another
   * number of invoices, is a mistake.
   */
  private answerResend(
    prior: { id: string; inspectionId: string | null; propertywareBuildingId: string | null; clientRequestId: string | null }[],
    keys: string[],
    target: { inspectionId: string | null; propertyId: string | null },
  ): { id: string }[] {
    const made = keys.map((key) => prior.find((row) => row.clientRequestId === key));
    const same = (row: (typeof prior)[number] | undefined) =>
      row !== undefined &&
      (target.inspectionId
        ? row.inspectionId === target.inspectionId
        : row.inspectionId === null && row.propertywareBuildingId === target.propertyId);
    if (prior.length !== keys.length || !made.every(same)) throw this.keyReused();
    return made.map((row) => ({ id: row!.id }));
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

  /** Refused while Jobber holds the invoices: until the console takes invoicing over (phase 8), or the server says so. */
  private async requireWrites(user: AuthenticatedUser) {
    if (!(await invoiceWritesOn(this.prisma, user.organizationId))) throw invoiceWritesOff();
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
