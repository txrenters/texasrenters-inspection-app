import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_REPORT_ROWS,
  invoiceStatusOn,
  reportRangeProblem,
  taxShareCents,
  type AgedReceivablesReport,
  type ClientBalanceRow,
  type ClientBalancesReport,
  type InvoiceBucket,
  type InvoicesReport,
  type InvoicesReportQuery,
  type PaymentInsights,
  type PaymentMethod,
  type ProjectedIncomeReport,
  type ReportInvoiceRow,
  type ReportRange,
  type TaxBasis,
  type TaxReport,
  type TaxReportRow,
  type TransactionRow,
  type TransactionsReport,
} from '@texasrenters/shared';
import { InvoiceStatus, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate, businessInstant } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * Where the money stands (2026-11-09, phase 2 of the invoice gap review), as
 * Jobber's financial reports show it. Every figure is a read of the console's
 * own copy of the invoices and payments: nothing billed is called, and the
 * pages read each report once when it is opened or its days change, never on
 * a poll.
 *
 * The cards are counted by the database over everything that matches; the
 * rows stop at `MAX_REPORT_ROWS`, and the report says so when they do.
 */

const DAY_MS = 86_400_000;
const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);
const plusDays = (value: string, days: number) => new Date(dateOf(value).getTime() + days * DAY_MS);
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

const bucket = (count: number | null | undefined, cents: number | null | undefined): InvoiceBucket => ({
  count: count ?? 0,
  amountCents: cents ?? 0,
});

/** Neither a draft nor a voided invoice is owed, invoiced or taxed. */
const SENT = { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] };

const ROW_SELECT = {
  id: true,
  number: true,
  clientName: true,
  subject: true,
  status: true,
  createdAt: true,
  issuedOn: true,
  dueOn: true,
  totalCents: true,
  balanceCents: true,
  jobNumber: true,
  clientEmails: true,
  clientPhones: true,
} satisfies Prisma.InvoiceSelect;

type Row = Prisma.InvoiceGetPayload<{ select: typeof ROW_SELECT }>;

function reportRow(row: Row, today: string): ReportInvoiceRow {
  const dueOn = day(row.dueOn);
  return {
    id: row.id,
    number: row.number,
    clientName: row.clientName,
    subject: row.subject,
    status: invoiceStatusOn(row.status, dueOn, today),
    createdOn: row.createdAt.toISOString().slice(0, 10),
    issuedOn: day(row.issuedOn),
    dueOn,
    totalCents: row.totalCents,
    balanceCents: row.balanceCents,
    jobNumber: row.jobNumber,
    email: row.clientEmails[0] ?? null,
    phone: row.clientPhones[0] ?? null,
    emails: row.clientEmails,
  };
}

/** Rows read one past the limit, to know whether there were more. */
const limited = <T>(rows: T[]) => ({ rows: rows.slice(0, MAX_REPORT_ROWS), truncated: rows.length > MAX_REPORT_ROWS });

@Injectable()
export class InvoiceReportsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** What is owed, by when it falls due. */
  async projectedIncome(user: AuthenticatedUser): Promise<ProjectedIncomeReport> {
    const today = businessDate();
    const owed: Prisma.InvoiceWhereInput = { organizationId: user.organizationId, status: InvoiceStatus.AWAITING_PAYMENT, balanceCents: { gt: 0 } };
    const sum = (dueOn: Prisma.InvoiceWhereInput) =>
      this.prisma.invoice.aggregate({ where: { AND: [owed, dueOn] }, _count: { _all: true }, _sum: { balanceCents: true } });
    const [late, dueToday, dueWithin7, dueWithin30, dueLater, outstanding, rows] = await Promise.all([
      sum({ dueOn: { lt: dateOf(today) } }),
      sum({ dueOn: dateOf(today) }),
      sum({ dueOn: { gt: dateOf(today), lt: plusDays(today, 7) } }),
      sum({ dueOn: { gte: plusDays(today, 7), lte: plusDays(today, 30) } }),
      sum({ OR: [{ dueOn: null }, { dueOn: { gt: plusDays(today, 30) } }] }),
      sum({}),
      this.prisma.invoice.findMany({
        where: owed,
        orderBy: [{ dueOn: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }],
        take: MAX_REPORT_ROWS + 1,
        select: ROW_SELECT,
      }),
    ]);
    const card = (value: typeof late) => bucket(value._count._all, value._sum.balanceCents);
    return {
      overview: {
        late: card(late),
        dueToday: card(dueToday),
        dueWithin7: card(dueWithin7),
        dueWithin30: card(dueWithin30),
        dueLater: card(dueLater),
        outstanding: card(outstanding),
      },
      ...limited(rows.map((row) => reportRow(row, today))),
    };
  }

  /** The late invoices, by how late: under 30 days, 30 to 60, 60 to 90, over 90. */
  async agedReceivables(user: AuthenticatedUser): Promise<AgedReceivablesReport> {
    const today = businessDate();
    const late: Prisma.InvoiceWhereInput = {
      organizationId: user.organizationId,
      status: InvoiceStatus.AWAITING_PAYMENT,
      balanceCents: { gt: 0 },
      dueOn: { lt: dateOf(today) },
    };
    // Days late, d: due on today - d.
    const lateBy = (min: number, max: number | null) =>
      this.prisma.invoice.aggregate({
        where: { AND: [late, { dueOn: { lte: plusDays(today, -min), ...(max === null ? {} : { gte: plusDays(today, -max) }) } }] },
        _count: { _all: true },
        _sum: { balanceCents: true },
      });
    const [under30, from30to60, from60to90, over90, all, rows] = await Promise.all([
      lateBy(1, 29),
      lateBy(30, 59),
      lateBy(60, 89),
      lateBy(90, null),
      lateBy(1, null),
      this.prisma.invoice.findMany({
        where: late,
        orderBy: [{ dueOn: 'asc' }, { number: 'asc' }],
        take: MAX_REPORT_ROWS + 1,
        select: ROW_SELECT,
      }),
    ]);
    const card = (value: typeof all) => bucket(value._count._all, value._sum.balanceCents);
    return {
      overview: { under30: card(under30), from30to60: card(from30to60), from60to90: card(from60to90), over90: card(over90), late: card(all) },
      ...limited(
        rows.map((row) => ({ ...reportRow(row, today), daysLate: daysBetween(row.dueOn!, dateOf(today)) })),
      ),
    };
  }

  /** What was invoiced and what came in, in the days chosen. */
  async transactions(user: AuthenticatedUser, range: ReportRange): Promise<TransactionsReport> {
    this.checkRange(range);
    const organizationId = user.organizationId;
    const issued: Prisma.InvoiceWhereInput = {
      organizationId,
      status: SENT,
      issuedOn: { gte: dateOf(range.from), lte: dateOf(range.to) },
    };
    const paid = (sign: 'in' | 'out'): Prisma.InvoicePaymentWhereInput => ({
      organizationId,
      paidOn: { gte: dateOf(range.from), lte: dateOf(range.to) },
      amountCents: sign === 'in' ? { gt: 0 } : { lte: 0 },
    });
    const [invoiced, received, refunded, invoices, payments] = await Promise.all([
      this.prisma.invoice.aggregate({ where: issued, _count: { _all: true }, _sum: { totalCents: true } }),
      this.prisma.invoicePayment.aggregate({ where: paid('in'), _count: { _all: true }, _sum: { amountCents: true } }),
      this.prisma.invoicePayment.aggregate({ where: paid('out'), _count: { _all: true }, _sum: { amountCents: true } }),
      this.prisma.invoice.findMany({
        where: issued,
        orderBy: [{ issuedOn: 'desc' }, { number: 'desc' }],
        take: MAX_REPORT_ROWS + 1,
        select: { id: true, number: true, clientName: true, issuedOn: true, totalCents: true, jobNumber: true },
      }),
      this.prisma.invoicePayment.findMany({
        where: { organizationId, paidOn: { gte: dateOf(range.from), lte: dateOf(range.to) } },
        orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
        take: MAX_REPORT_ROWS + 1,
        select: {
          id: true,
          paidOn: true,
          amountCents: true,
          method: true,
          reference: true,
          invoice: { select: { id: true, number: true, clientName: true, jobNumber: true } },
        },
      }),
    ]);
    const rows: TransactionRow[] = [
      ...invoices.map((row) => ({
        kind: 'INVOICE' as const,
        on: day(row.issuedOn)!,
        invoiceId: row.id,
        invoiceNumber: row.number,
        paymentId: null,
        clientName: row.clientName,
        totalCents: row.totalCents,
        method: null,
        reference: null,
        jobNumber: row.jobNumber,
      })),
      ...payments.map((row) => ({
        kind: row.amountCents > 0 ? ('PAYMENT' as const) : ('REFUND' as const),
        on: day(row.paidOn)!,
        invoiceId: row.invoice.id,
        invoiceNumber: row.invoice.number,
        paymentId: row.id,
        clientName: row.invoice.clientName,
        totalCents: row.amountCents,
        method: row.method as PaymentMethod,
        reference: row.reference,
        jobNumber: row.invoice.jobNumber,
      })),
    ].sort((a, b) => b.on.localeCompare(a.on));
    const paidCents = received._sum.amountCents ?? 0;
    const refundedCents = -(refunded._sum.amountCents ?? 0);
    const invoicedCents = invoiced._sum.totalCents ?? 0;
    return {
      range,
      overview: {
        paid: bucket(received._count._all, paidCents),
        refunded: bucket(refunded._count._all, refundedCents),
        invoiced: bucket(invoiced._count._all, invoicedCents),
        balance: bucket(invoiced._count._all, invoicedCents - paidCents + refundedCents),
      },
      rows: rows.slice(0, MAX_REPORT_ROWS),
      truncated: invoices.length > MAX_REPORT_ROWS || payments.length > MAX_REPORT_ROWS || rows.length > MAX_REPORT_ROWS,
    };
  }

  /** Every invoice made or issued in the days chosen; with a status, only those (Bad debt). */
  async invoices(user: AuthenticatedUser, query: InvoicesReportQuery): Promise<InvoicesReport> {
    this.checkRange(query);
    const today = businessDate();
    const when: Prisma.InvoiceWhereInput =
      query.dateField === 'created'
        ? { createdAt: { gte: businessInstant(query.from, '00:00:00'), lt: businessInstant(day(plusDays(query.to, 1))!, '00:00:00') } }
        : { issuedOn: { gte: dateOf(query.from), lte: dateOf(query.to) } };
    const scope: Prisma.InvoiceWhereInput = {
      AND: [{ organizationId: user.organizationId }, when, ...(query.status ? [{ status: query.status as InvoiceStatus }] : [])],
    };
    const [byStatus, rows] = await Promise.all([
      this.prisma.invoice.groupBy({ by: ['status'], where: scope, _count: { _all: true }, _sum: { totalCents: true } }),
      this.prisma.invoice.findMany({
        where: scope,
        orderBy: [{ issuedOn: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
        take: MAX_REPORT_ROWS + 1,
        select: ROW_SELECT,
      }),
    ]);
    const card = (...statuses: InvoiceStatus[]) => {
      const matching = byStatus.filter((row) => statuses.includes(row.status));
      return bucket(
        matching.reduce((sum, row) => sum + row._count._all, 0),
        matching.reduce((sum, row) => sum + (row._sum.totalCents ?? 0), 0),
      );
    };
    return {
      range: { from: query.from, to: query.to },
      overview: {
        draft: card(InvoiceStatus.DRAFT),
        awaiting: card(InvoiceStatus.AWAITING_PAYMENT),
        paid: card(InvoiceStatus.PAID),
        badDebt: card(InvoiceStatus.BAD_DEBT),
        // Voided ones are listed, as Jobber lists them, but add to nothing.
        total: card(InvoiceStatus.DRAFT, InvoiceStatus.AWAITING_PAYMENT, InvoiceStatus.PAID, InvoiceStatus.BAD_DEBT),
      },
      ...limited(rows.map((row) => reportRow(row, today))),
    };
  }

  /** Tax by rate: invoiced in the days chosen (accrual), or collected in them (cash). */
  async taxes(user: AuthenticatedUser, range: ReportRange & { basis: TaxBasis }): Promise<TaxReport> {
    this.checkRange(range);
    const organizationId = user.organizationId;
    const within = { gte: dateOf(range.from), lte: dateOf(range.to) };
    const groups = new Map<string, TaxReportRow & { ids: Set<string> }>();
    const add = (invoice: { id: string; taxRateName: string | null; taxRatePercent: number | null }, total: number, tax: number) => {
      const rateName = invoice.taxRateName?.trim() || (tax ? 'Tax' : 'No tax');
      const key = `${rateName}|${invoice.taxRatePercent ?? ''}`;
      const group = groups.get(key) ?? {
        rateName,
        ratePercent: invoice.taxRatePercent,
        invoices: 0,
        taxableCents: 0,
        taxCents: 0,
        totalCents: 0,
        ids: new Set<string>(),
      };
      group.ids.add(invoice.id);
      group.invoices = group.ids.size;
      group.totalCents += total;
      group.taxCents += tax;
      group.taxableCents += total - tax;
      groups.set(key, group);
    };
    const taxSelect = { id: true, taxRateName: true, taxRatePercent: true, taxCents: true, totalCents: true } as const;

    if (range.basis === 'ACCRUAL') {
      const invoices = await this.prisma.invoice.findMany({
        where: { organizationId, status: SENT, issuedOn: within },
        select: taxSelect,
      });
      for (const invoice of invoices) add(invoice, invoice.totalCents, invoice.taxCents);
    } else {
      const payments = await this.prisma.invoicePayment.findMany({
        where: { organizationId, paidOn: within },
        select: { amountCents: true, invoice: { select: taxSelect } },
      });
      for (const payment of payments) add(payment.invoice, payment.amountCents, taxShareCents(payment.amountCents, payment.invoice));
    }
    const owed = await this.prisma.invoice.findMany({
      where: { organizationId, status: InvoiceStatus.AWAITING_PAYMENT, balanceCents: { gt: 0 }, taxCents: { gt: 0 }, issuedOn: within },
      select: { balanceCents: true, taxCents: true, totalCents: true },
    });

    const rows = [...groups.values()]
      .map((group): TaxReportRow => ({
        rateName: group.rateName,
        ratePercent: group.ratePercent,
        invoices: group.invoices,
        taxableCents: group.taxableCents,
        taxCents: group.taxCents,
        totalCents: group.totalCents,
      }))
      .sort((a, b) => b.totalCents - a.totalCents);
    return {
      range: { from: range.from, to: range.to },
      basis: range.basis,
      rows,
      totals: {
        invoices: rows.reduce((sum, row) => sum + row.invoices, 0),
        taxableCents: rows.reduce((sum, row) => sum + row.taxableCents, 0),
        taxCents: rows.reduce((sum, row) => sum + row.taxCents, 0),
        totalCents: rows.reduce((sum, row) => sum + row.totalCents, 0),
      },
      awaitingCollectionCents: owed.reduce((sum, invoice) => sum + taxShareCents(invoice.balanceCents, invoice), 0),
    };
  }

  /**
   * Each client's account, as Jobber's Client Balance Summary: what it was
   * invoiced, paid and still owes, over every invoice sent. A client is
   * Jobber's, which for the office is the property. Bad debt was invoiced and
   * is not owed.
   */
  async clientBalances(user: AuthenticatedUser): Promise<ClientBalancesReport> {
    const today = dateOf(businessDate());
    const [invoices, emailed] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { organizationId: user.organizationId, status: SENT },
        select: {
          id: true,
          jobberClientId: true,
          propertywareBuildingId: true,
          clientName: true,
          clientEmails: true,
          clientPhones: true,
          status: true,
          totalCents: true,
          balanceCents: true,
          issuedOn: true,
          dueOn: true,
          paidOn: true,
        },
      }),
      this.prisma.invoiceDelivery.groupBy({
        by: ['invoiceId'],
        where: { organizationId: user.organizationId, status: 'SENT' },
        _max: { sentAt: true },
      }),
    ]);
    const lastSent = new Map(emailed.map((row) => [row.invoiceId, row._max.sentAt]));
    const clients = new Map<string, ClientBalanceRow & { paidDays: number[] }>();
    for (const invoice of invoices) {
      const key = invoice.jobberClientId ?? invoice.propertywareBuildingId ?? `name:${invoice.clientName.trim().toLowerCase()}`;
      const client = clients.get(key) ?? {
        key,
        clientName: invoice.clientName,
        propertyId: invoice.propertywareBuildingId,
        email: null,
        phone: null,
        invoicedCents: 0,
        paidCents: 0,
        balanceCents: 0,
        lateBalanceCents: 0,
        paymentDays: null,
        lastEmailedAt: null,
        paidDays: [],
      };
      client.email ??= invoice.clientEmails[0] ?? null;
      client.phone ??= invoice.clientPhones[0] ?? null;
      client.propertyId ??= invoice.propertywareBuildingId;
      client.invoicedCents += invoice.totalCents;
      client.paidCents += invoice.totalCents - invoice.balanceCents;
      if (invoice.status === InvoiceStatus.AWAITING_PAYMENT || invoice.status === InvoiceStatus.PAID) {
        client.balanceCents += invoice.balanceCents;
        if (invoice.status === InvoiceStatus.AWAITING_PAYMENT && invoice.dueOn && invoice.dueOn < today)
          client.lateBalanceCents += invoice.balanceCents;
      }
      if (invoice.status === InvoiceStatus.PAID && invoice.paidOn && invoice.issuedOn)
        client.paidDays.push(Math.max(0, daysBetween(invoice.issuedOn, invoice.paidOn)));
      const sent = lastSent.get(invoice.id);
      if (sent && (!client.lastEmailedAt || sent.toISOString() > client.lastEmailedAt)) client.lastEmailedAt = sent.toISOString();
      clients.set(key, client);
    }
    const rows = [...clients.values()]
      .map(({ paidDays, ...client }) => ({
        ...client,
        paymentDays: paidDays.length ? Math.round(paidDays.reduce((sum, days) => sum + days, 0) / paidDays.length) : null,
      }))
      .sort((a, b) => b.balanceCents - a.balanceCents || a.clientName.localeCompare(b.clientName));
    const owing = rows.filter((row) => row.balanceCents > 0);
    const credit = rows.filter((row) => row.balanceCents < 0);
    const total = (list: typeof rows) => list.reduce((sum, row) => sum + row.balanceCents, 0);
    return {
      overview: {
        outstanding: bucket(owing.length, total(owing)),
        credit: bucket(credit.length, total(credit)),
        total: bucket(rows.length, total(rows)),
      },
      ...limited(rows),
    };
  }

  /** Jobber's two cards on its payments page: how long invoices take to be paid, and how many are paid on time. */
  async paymentInsights(user: AuthenticatedUser): Promise<PaymentInsights> {
    const today = businessDate();
    const paidSince = (days: number) =>
      this.prisma.invoice.findMany({
        where: {
          organizationId: user.organizationId,
          status: InvoiceStatus.PAID,
          paidOn: { gte: plusDays(today, -(days - 1)), lte: dateOf(today) },
        },
        select: { issuedOn: true, dueOn: true, paidOn: true },
      });
    const [last30, last60] = await Promise.all([paidSince(30), paidSince(60)]);
    const timed = last30.filter((row) => row.issuedOn && row.paidOn);
    const days = timed.map((row) => Math.max(0, daysBetween(row.issuedOn!, row.paidOn!)));
    return {
      paymentDays: { days: days.length ? Math.round(days.reduce((sum, value) => sum + value, 0) / days.length) : null, invoices: days.length },
      paidOnTime: { onTime: last60.filter((row) => !row.dueOn || (row.paidOn && row.paidOn <= row.dueOn)).length, invoices: last60.length },
    };
  }

  private checkRange(range: ReportRange) {
    const problem = reportRangeProblem(range);
    if (problem) throw new ApplicationError(422, 'REPORT_RANGE_INVALID', problem);
  }
}
