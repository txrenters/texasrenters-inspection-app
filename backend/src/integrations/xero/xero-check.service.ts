import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_XERO_CHECK_INVOICES,
  checkMonthProblem,
  type XeroCheckCounts,
  type XeroCheckView,
  type XeroDifference,
} from '@texasrenters/shared';
import { InvoiceStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { XeroClient } from './xero.client';
import { XeroError } from './xero.errors';
import { compareMonth, monthWhere, type ConsoleInvoiceForCheck, type XeroInvoiceForCheck } from './xero-check';

/** Xero lists 100 invoices a page. */
const PAGE_SIZE = 100;
/** Between one check of an organisation and the next. */
const CHECK_GAP_MS = 60_000;

const invoicesSchema = z.object({
  Invoices: z.array(
    z.object({
      InvoiceID: z.string(),
      InvoiceNumber: z.string().nullish(),
      Type: z.string().nullish(),
      Status: z.string().nullish(),
      Contact: z.object({ Name: z.string().nullish() }).nullish(),
      Total: z.number().nullish(),
      AmountPaid: z.number().nullish(),
    }),
  ),
});

/**
 * Checks a month of a company's invoices against its books in Xero
 * (2026-11-10, phase 5 of the multi-company plan).
 *
 * Asked for by a person, never on a timer or a page load: a check reads
 * Xero's sales invoices for the month, 100 a call and ten calls at most, under
 * the organisation's daily ceiling, and at most once a minute. What it found
 * is kept -- the latest check of each month -- and shown from the console's
 * own record after that. Nothing is written to Xero.
 */
@Injectable()
export class XeroCheckService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroClient) private readonly client: XeroClient,
  ) {}

  /** The latest check of the month, from the console's record. No call to Xero. */
  async view(organizationId: string, tenantId: string, month: string): Promise<XeroCheckView> {
    const problem = checkMonthProblem(month, businessDate());
    if (problem) throw new XeroError(problem, 'XERO_CHECK_INVALID', 422);
    const [row, settings] = await Promise.all([
      this.prisma.xeroCheck.findUnique({
        where: { organizationId_xeroTenantId_month: { organizationId, xeroTenantId: tenantId, month } },
        select: { ranAt: true, counts: true, differences: true, truncated: true, calls: true, ranBy: { select: { displayName: true } } },
      }),
      this.prisma.xeroSettings.findUnique({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        select: { sendFrom: true },
      }),
    ]);
    return {
      tenantId,
      month,
      ranAt: row?.ranAt.toISOString() ?? null,
      ranBy: row?.ranBy?.displayName ?? null,
      counts: (row?.counts as XeroCheckCounts | undefined) ?? null,
      differences: (row?.differences as XeroDifference[] | undefined) ?? [],
      truncated: row?.truncated ?? false,
      calls: row?.calls ?? 0,
      sendFrom: settings?.sendFrom ? settings.sendFrom.toISOString().slice(0, 10) : null,
    };
  }

  /** "Check now": reads the month from Xero, compares, keeps what it found, and says so on the record. */
  async run(user: AuthenticatedUser, tenantId: string, month: string): Promise<XeroCheckView> {
    const organizationId = user.organizationId;
    const problem = checkMonthProblem(month, businessDate());
    if (problem) throw new XeroError(problem, 'XERO_CHECK_INVALID', 422);
    const latest = await this.prisma.xeroCheck.findFirst({
      where: { organizationId, xeroTenantId: tenantId },
      orderBy: { ranAt: 'desc' },
      select: { ranAt: true },
    });
    if (latest && Date.now() - latest.ranAt.getTime() < CHECK_GAP_MS)
      throw new XeroError('It was checked a moment ago. Try again in a minute.', 'XERO_CHECK_TOO_SOON', 429);

    const [consoleInvoices, xero] = await Promise.all([this.consoleInvoices(organizationId, tenantId, month), this.xeroInvoices(organizationId, tenantId, month)]);
    const compared = compareMonth(consoleInvoices, xero.invoices);
    const truncated = compared.truncated || xero.truncated;
    const data = {
      ranAt: new Date(),
      ranById: user.id,
      counts: compared.counts as unknown as Prisma.InputJsonObject,
      differences: compared.differences as unknown as Prisma.InputJsonArray,
      truncated,
      calls: xero.calls,
    };
    await this.prisma.xeroCheck.upsert({
      where: { organizationId_xeroTenantId_month: { organizationId, xeroTenantId: tenantId, month } },
      create: { organizationId, xeroTenantId: tenantId, month, ...data },
      update: data,
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: user.id,
        action: 'XERO_CHECK_RAN',
        entityType: 'XeroOrganisation',
        entityId: organizationId,
        metadata: { tenantId, month, counts: data.counts, calls: xero.calls, truncated },
      },
    });
    return this.view(organizationId, tenantId, month);
  }

  /**
   * The console's invoices of the month that are meant for this organisation's
   * books: its company's, from the start date, not drafts. Each with what its
   * payments come to, and where it stands in Xero.
   */
  private async consoleInvoices(organizationId: string, tenantId: string, month: string): Promise<ConsoleInvoiceForCheck[]> {
    const settings = await this.prisma.xeroSettings.findUnique({
      where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
      select: { sendFrom: true },
    });
    // Before the start date the console sends nothing: none are meant for Xero.
    if (!settings?.sendFrom) return [];
    const first = new Date(`${month}-01T00:00:00.000Z`);
    const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
    const from = settings.sendFrom > first ? settings.sendFrom : first;
    if (from >= next) return [];
    const rows = await this.prisma.invoice.findMany({
      where: { organizationId, xeroTenantId: tenantId, status: { not: InvoiceStatus.DRAFT }, issuedOn: { gte: from, lt: next } },
      orderBy: [{ issuedOn: 'asc' }, { number: 'asc' }],
      select: {
        id: true,
        number: true,
        clientName: true,
        status: true,
        totalCents: true,
        payments: { select: { amountCents: true } },
        xeroSync: { select: { xeroTenantId: true, xeroInvoiceId: true, status: true, problem: true } },
      },
    });
    return rows.map((row) => {
      const sync = row.xeroSync?.xeroTenantId === tenantId ? row.xeroSync : null;
      return {
        id: row.id,
        number: row.number,
        clientName: row.clientName,
        status: row.status,
        totalCents: row.totalCents,
        paidCents: row.payments.reduce((sum, payment) => sum + payment.amountCents, 0),
        xeroInvoiceId: sync?.xeroInvoiceId ?? null,
        problem: sync?.status === 'FAILED' ? sync.problem : null,
      };
    });
  }

  /** Xero's sales invoices dated in the month -- approved, paid or voided -- 100 a call, ten calls at most. */
  private async xeroInvoices(organizationId: string, tenantId: string, month: string) {
    const invoices: XeroInvoiceForCheck[] = [];
    const where = encodeURIComponent(monthWhere(month));
    let calls = 0;
    for (let page = 1; page <= MAX_XERO_CHECK_INVOICES / PAGE_SIZE; page++) {
      const answer = await this.client.get(
        organizationId,
        tenantId,
        `/Invoices?where=${where}&Statuses=AUTHORISED,PAID,VOIDED&summaryOnly=true&page=${page}&pageSize=${PAGE_SIZE}`,
        invoicesSchema,
      );
      calls++;
      invoices.push(...answer.Invoices.filter((invoice) => !invoice.Type || invoice.Type === 'ACCREC'));
      if (answer.Invoices.length < PAGE_SIZE) return { invoices, calls, truncated: false };
    }
    // Ten full pages: Xero has more this month than one check reads.
    return { invoices, calls, truncated: true };
  }
}
