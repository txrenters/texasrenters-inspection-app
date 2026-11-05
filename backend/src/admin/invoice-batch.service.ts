import { Inject, Injectable } from '@nestjs/common';
import {
  FINISHED_INSPECTION_STATUSES,
  MAX_BATCH_INVOICES,
  MAX_UNINVOICED_RANGE_DAYS,
  PAYMENT_TERMS,
  invoiceLinesProblem,
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
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { insertConsoleInvoice } from './invoice-insert';
import { lockInvoiceNumbers } from './invoice-numbers';
import { InvoicesService, draftLines, servicesDone } from './invoices.service';

/**
 * Making many invoices at once (2026-11-06, phase 4 of taking invoicing over
 * from Jobber), as Jobber's Batch Create: the finished visits in a span of
 * days nobody has invoiced yet, each priced from what the technician reported
 * done at the office's own prices, and one invoice made for each visit chosen.
 *
 * A visit that cannot be billed as it stands -- nothing reported done, a
 * service the office has never priced -- is listed with the reason and left
 * out rather than invoiced for nothing; it is invoiced by itself, where the
 * price can be typed. Off until the cutover, as every invoice write is.
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

/** A visit's invoice as the batch would make it, and why it cannot be made, in words. */
export function batchLines(row: Pick<VisitRow, 'servicesReport'>, prices: readonly { name: string; unitPriceCents: number }[]) {
  const lineItems = draftLines(servicesDone(row.servicesReport as unknown as VisitServicesReport | null), prices);
  if (!lineItems.length) return { lineItems, totalCents: 0, problem: 'Nothing was reported done to bill.' };
  const unpriced = lineItems.filter((line) => line.unitPriceCents <= 0).map((line) => line.name);
  if (unpriced.length)
    return {
      lineItems,
      totalCents: invoiceTotals(lineItems).totalCents,
      problem: `No price yet for ${unpriced.join(' and ')}. Invoice this visit by itself and type the price.`,
    };
  return { lineItems, totalCents: invoiceTotals(lineItems).totalCents, problem: invoiceLinesProblem(lineItems) };
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
    const [{ products }, rows] = await Promise.all([
      this.invoices.officeDefaults(user),
      this.prisma.inspection.findMany({
        where: {
          organizationId: user.organizationId,
          status: { in: [...FINISHED_INSPECTION_STATUSES] as InspectionStatus[] },
          scheduledAt: { gte: dateOf(query.from), lt: new Date(dateOf(query.to).getTime() + DAY_MS) },
          propertywareBuildingId: { not: null },
          ...(query.inspectionType ? { inspectionType: query.inspectionType } : {}),
          invoices: { none: { status: { not: InvoiceStatus.VOIDED } } },
        },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
        take: LIST_LIMIT + 1,
        select: visitSelect,
      }),
    ]);
    return {
      items: rows.slice(0, LIST_LIMIT).map((row): UninvoicedVisit => {
        const building = row.propertywareBuilding!;
        return {
          inspectionId: row.id,
          inspectionType: row.inspectionType,
          scheduledOn: day(row.scheduledAt),
          status: row.status,
          property: { id: building.id, address: building.addressLine1 ?? building.name, city: building.city },
          clientName: building.addressLine1 ?? building.name,
          ...batchLines(row, products),
        };
      }),
      truncated: rows.length > LIST_LIMIT,
    };
  }

  /**
   * One invoice for each visit chosen that can still be invoiced, each numbered
   * next in the office's sequence (or kept as a draft), each its own write.
   * Visits invoiced meanwhile, or that cannot be billed, are skipped with the
   * reason. A resend of the same batch makes nothing twice: each invoice is
   * keyed by the batch and its visit.
   */
  async batch(user: AuthenticatedUser, input: BatchInvoiceInput): Promise<BatchInvoiceResult> {
    if (!getJobberConfig().invoiceWritesEnabled)
      throw new ApplicationError(
        409,
        'INVOICE_WRITES_OFF',
        'Invoices and payments are made and changed in Jobber until the console takes over invoicing.',
      );
    const today = businessDate();
    const ids = [...new Set(input.inspectionIds)];
    if (!ids.length) throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', 'Choose at least one visit.');
    if (ids.length > MAX_BATCH_INVOICES)
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', `A batch makes at most ${MAX_BATCH_INVOICES} invoices.`);
    if (!DAY.test(input.issuedOn) || input.issuedOn > today)
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', 'Give the day they are issued: today or before.');
    if (!PAYMENT_TERMS.some((terms) => terms.days === input.paymentTermsDays))
      throw new ApplicationError(422, 'INVOICE_BATCH_INVALID', 'Pick the payment terms from the list.');

    const defaults = await this.invoices.officeDefaults(user);
    const result: BatchInvoiceResult = { created: [], skipped: [] };
    for (const inspectionId of ids) {
      const clientRequestId = `${input.clientRequestId}:${inspectionId}`;
      const made = await this.byKey(user, clientRequestId);
      if (made) {
        result.created.push({ inspectionId, invoiceId: made.id, number: made.number, totalCents: made.totalCents });
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
      const lines = batchLines(visit, defaults.products);
      if (lines.problem) {
        result.skipped.push({ inspectionId, reason: lines.problem });
        continue;
      }
      const building = visit.propertywareBuilding;
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          // Under the office's invoice lock, so a visit invoiced by somebody
          // else a moment ago is seen here rather than invoiced twice.
          await lockInvoiceNumbers(tx, user.organizationId);
          const already = await tx.invoice.findFirst({
            where: { organizationId: user.organizationId, inspectionId, status: { not: InvoiceStatus.VOIDED } },
            select: { id: true },
          });
          if (already) return null;
          return insertConsoleInvoice(tx, user, {
            subject: defaults.subject,
            clientName: building.addressLine1 ?? building.name,
            inspectionId,
            propertywareBuildingId: building.id,
            jobberJobId: visit.jobberJobId,
            issuedOn: input.issuedOn,
            paymentTermsDays: input.paymentTermsDays,
            lines: lines.lineItems,
            clientMessage: defaults.clientMessage,
            clientRequestId,
            asDraft: input.asDraft === true,
            batchKey: input.clientRequestId,
          });
        });
        if (created) result.created.push({ inspectionId, invoiceId: created.id, number: created.number, totalCents: created.totalCents });
        else result.skipped.push({ inspectionId, reason: 'The visit has an invoice already.' });
      } catch (error) {
        // The same batch, sent twice at once: the other request made this one.
        const other =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' ? await this.byKey(user, clientRequestId) : null;
        if (!other) throw error;
        result.created.push({ inspectionId, invoiceId: other.id, number: other.number, totalCents: other.totalCents });
      }
    }
    return result;
  }

  private byKey(user: AuthenticatedUser, clientRequestId: string) {
    return this.prisma.invoice.findFirst({
      where: { organizationId: user.organizationId, clientRequestId },
      select: { id: true, number: true, totalCents: true },
    });
  }
}
