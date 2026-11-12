import { Inject, Injectable } from '@nestjs/common';
import {
  FINISHED_INSPECTION_STATUSES,
  MAX_BATCH_INVOICES,
  MAX_INVOICES_PER_VISIT,
  MAX_UNINVOICED_RANGE_DAYS,
  PAYMENT_TERMS,
  billedLines,
  invoiceTotals,
  type BatchInvoiceInput,
  type BatchInvoiceResult,
  type InspectionType,
  type UninvoicedVisit,
  type UninvoicedVisitList,
  type VisitServicesReport,
} from '@texasrenters/shared';
import { InvoiceStatus, Prisma, type InspectionStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { billingBasis, type BillingBasis } from './invoice-billing-rules';
import { makeInvoices, visitParts } from './invoice-maker';
import { invoiceWritesOff, productCompanies } from './invoice-settings';
import { InvoicesService, servicesDone } from './invoices.service';
import { invoicingState } from './invoicing-state';

/**
 * Making many invoices at once (2026-11-06, phase 4 of taking invoicing over
 * from Jobber), as Jobber's Batch Create: the finished visits in a span of
 * days nobody has invoiced yet, each billed as the office's rules say -- its
 * type, and what the technician reported done (2026-11-12) -- at the prices on
 * its list, and one invoice made for each visit chosen.
 *
 * A visit that cannot be billed as it stands -- no rule covers it, a product
 * has no price -- is listed with the reason and left out rather than invoiced
 * for nothing; it is invoiced by itself, where the lines can be typed. Off
 * until the cutover, as every invoice write is.
 *
 * One invoice per company (2026-11-10, phase 3 of the multi-company plan): a
 * visit whose services go to two companies' books gets one invoice for each,
 * made together, so a visit is invoiced in full or not at all.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** The most visits one list shows; narrow the days for more. */
const LIST_LIMIT = 200;

const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);
const day = (date: Date) => date.toISOString().slice(0, 10);

const visitSelect = {
  id: true,
  inspectionType: true,
  scheduledAt: true,
  status: true,
  jobberJobId: true,
  servicesReport: true,
  propertywareBuilding: { select: { id: true, name: true, addressLine1: true, city: true } },
} satisfies Prisma.InspectionSelect;

type VisitRow = Prisma.InspectionGetPayload<{ select: typeof visitSelect }>;

/** A visit's invoice as the batch would make it, by the office's rules, and why it cannot be made, in words. */
export function batchLines(row: Pick<VisitRow, 'servicesReport'> & { inspectionType: string }, basis: BillingBasis) {
  const services = servicesDone(row.servicesReport as unknown as VisitServicesReport | null);
  const { lineItems, problem } = billedLines({ inspectionType: row.inspectionType, services }, basis.rules, basis.products);
  return { lineItems, totalCents: invoiceTotals(lineItems).totalCents, problem };
}

@Injectable()
export class InvoiceBatchService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
  ) {}

  /** The finished visits from `from` to `to` (Texas days, both included) that have no invoice yet. */
  async uninvoiced(
    user: AuthenticatedUser,
    query: { from: string; to: string; inspectionType?: InspectionType },
  ): Promise<UninvoicedVisitList> {
    if (!DAY.test(query.from) || !DAY.test(query.to) || query.to < query.from)
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', 'Give the first and the last day, the first one first.');
    if ((dateOf(query.to).getTime() - dateOf(query.from).getTime()) / DAY_MS > MAX_UNINVOICED_RANGE_DAYS)
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', `Look at ${MAX_UNINVOICED_RANGE_DAYS} days at most at a time.`);
    // Where invoicing stands, worked out once (2026-11-13). From the day the console began making the invoices
    // (2026-11-12): a visit before it was billed in Jobber, or by hand in Xero -- pest control never went through
    // Jobber -- and is not billed again here.
    const state = await invoicingState(this.prisma, user.organizationId);
    const startsOn = state.takenOverAt ? businessDate(state.takenOverAt) : null;
    const from = startsOn && startsOn > query.from ? startsOn : query.from;
    const [{ termsDays }, basis, rows, companies] = await Promise.all([
      this.invoices.officeDefaults(user),
      billingBasis(this.prisma, user.organizationId),
      this.prisma.inspection.findMany({
        where: {
          organizationId: user.organizationId,
          status: { in: [...FINISHED_INSPECTION_STATUSES] as InspectionStatus[] },
          scheduledAt: { gte: dateOf(from), lt: new Date(dateOf(query.to).getTime() + DAY_MS) },
          propertywareBuildingId: { not: null },
          ...(query.inspectionType ? { inspectionType: query.inspectionType } : {}),
          // Every invoice counts here, whatever its origin -- one read back from Xero too (2026-11-12) -- so nothing is billed twice.
          invoices: { none: { status: { not: InvoiceStatus.VOIDED } } },
        },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
        take: LIST_LIMIT + 1,
        select: visitSelect,
      }),
      productCompanies(this.prisma, user.organizationId),
    ]);
    const today = businessDate();
    return {
      items: rows.slice(0, LIST_LIMIT).map((row): UninvoicedVisit => {
        const building = row.propertywareBuilding!;
        const lines = batchLines(row, basis);
        // As the one maker would make them, issued today (2026-11-13): what would hold the visit back is said here.
        const { parts, problem } = visitParts(lines.lineItems, companies, state, today);
        return {
          inspectionId: row.id,
          inspectionType: row.inspectionType,
          scheduledOn: day(row.scheduledAt),
          status: row.status,
          property: { id: building.id, address: building.addressLine1 ?? building.name, city: building.city },
          clientName: building.addressLine1 ?? building.name,
          ...lines,
          problem: lines.problem ?? problem,
          invoices: parts,
        };
      }),
      truncated: rows.length > LIST_LIMIT,
      paymentTermsDays: termsDays,
      startsOn,
    };
  }

  /**
   * One invoice for each company of each visit chosen that can still be
   * invoiced, each numbered next in the office's sequence (or kept as a
   * draft); a visit's invoices are one write. Visits invoiced meanwhile, or
   * that cannot be billed, are skipped with the reason. A resend of the same
   * batch makes nothing twice: each invoice is keyed by the batch, its visit
   * and its place among the visit's invoices.
   */
  async batch(user: AuthenticatedUser, input: BatchInvoiceInput): Promise<BatchInvoiceResult> {
    // Where invoicing stands, worked out once (2026-11-13), as the visit's form works it out.
    const state = await invoicingState(this.prisma, user.organizationId);
    if (!state.writesOn) throw invoiceWritesOff();
    const today = businessDate();
    const ids = [...new Set(input.inspectionIds)];
    if (!ids.length) throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', 'Choose at least one visit.');
    if (ids.length > MAX_BATCH_INVOICES)
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', `A batch makes at most ${MAX_BATCH_INVOICES} invoices.`);
    if (!DAY.test(input.issuedOn) || input.issuedOn > today)
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', 'Give the day they are issued: today or before.');
    if (!PAYMENT_TERMS.some((terms) => terms.days === input.paymentTermsDays))
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', 'Pick the payment terms from the list.');

    const [defaults, basis, companies] = await Promise.all([
      this.invoices.officeDefaults(user),
      billingBasis(this.prisma, user.organizationId),
      productCompanies(this.prisma, user.organizationId),
    ]);
    const { nameOf } = state;
    const result: BatchInvoiceResult = { created: [], skipped: [] };
    const madeFor = (inspectionId: string, rows: { id: string; number: string | null; totalCents: number; xeroTenantId: string | null }[]) => {
      for (const row of rows)
        result.created.push({
          inspectionId,
          invoiceId: row.id,
          number: row.number,
          totalCents: row.totalCents,
          company: row.xeroTenantId ? nameOf(row.xeroTenantId) : null,
        });
    };
    for (const inspectionId of ids) {
      const keys = Array.from({ length: MAX_INVOICES_PER_VISIT }, (_, index) => `${input.clientRequestId}:${inspectionId}:${index + 1}`);
      const made = await this.byKeys(user, keys);
      if (made.length) {
        madeFor(inspectionId, made);
        continue;
      }
      const visit = await this.prisma.inspection.findFirst({
        where: { id: inspectionId, organizationId: user.organizationId },
        select: visitSelect,
      });
      const reason = !visit
        ? 'That visit was not found.'
        : !(FINISHED_INSPECTION_STATUSES as readonly string[]).includes(visit.status)
          ? 'The visit is not finished yet.'
          : !visit.propertywareBuilding
            ? 'The visit has no property to invoice.'
            : null;
      if (reason || !visit?.propertywareBuilding) {
        result.skipped.push({ inspectionId, reason: reason ?? 'The visit has no property to invoice.' });
        continue;
      }
      const lines = batchLines(visit, basis);
      if (lines.problem) {
        result.skipped.push({ inspectionId, reason: lines.problem });
        continue;
      }
      const building = visit.propertywareBuilding;
      // One invoice per company: each company's services, and those of none on one of their own.
      const { parts } = visitParts(lines.lineItems, companies, state, input.issuedOn);
      try {
        // The one maker (2026-11-13), as the visit's form makes them: what reaches no books, or comes before its
        // company's start date, is not made; a visit invoiced by somebody else a moment ago is seen under the lock.
        const outcome = await this.prisma.$transaction(
          (tx) =>
            makeInvoices(tx, user, state, {
              inspectionId,
              propertywareBuildingId: building.id,
              clientName: building.addressLine1 ?? building.name,
              jobberJobId: visit.jobberJobId,
              subject: defaults.subject,
              issuedOn: input.issuedOn,
              paymentTermsDays: input.paymentTermsDays,
              clientMessage: defaults.clientMessage,
              contractDisclaimer: defaults.contractDisclaimer,
              asDraft: input.asDraft === true,
              additional: false,
              batchKey: input.clientRequestId,
              invoices: parts.map((part, index) => ({ xeroTenantId: part.xeroTenantId, lines: part.lineItems, clientRequestId: keys[index]! })),
            }),
          // A visit's invoices are a few writes each: room for several on a slow connection.
          { maxWait: 5_000, timeout: 20_000 },
        );
        if ('made' in outcome) madeFor(inspectionId, outcome.made);
        else
          result.skipped.push({
            inspectionId,
            reason: outcome.refused === 'VISIT_INVOICED' ? 'The visit has an invoice already.' : outcome.problem,
          });
      } catch (error) {
        // The same batch, sent twice at once: the other request made this visit's.
        const other =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' ? await this.byKeys(user, keys) : [];
        if (!other.length) throw error;
        madeFor(inspectionId, other);
      }
    }
    return result;
  }

  /** The invoices made under these keys, in the keys' order. */
  private async byKeys(user: AuthenticatedUser, keys: string[]) {
    const rows = await this.prisma.invoice.findMany({
      where: { organizationId: user.organizationId, clientRequestId: { in: keys } },
      select: { id: true, number: true, totalCents: true, xeroTenantId: true, clientRequestId: true },
    });
    return keys.flatMap((key) => rows.filter((row) => row.clientRequestId === key));
  }
}
