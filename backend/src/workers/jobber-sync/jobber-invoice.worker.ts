import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus, type Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import {
  applyJobberInvoice,
  removeJobberInvoice,
  type InvoiceCopyResult,
} from '../../integrations/jobber/jobber-invoice-copy';
import { isCutShort, toInvoiceCopy } from '../../integrations/jobber/jobber-invoice-mapping';
import { JobberClient, type JobberCost } from '../../integrations/jobber/jobber.client';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import {
  INVOICE_BY_ID_QUERY,
  invoicesPageQuery,
  PAYMENT_RECORD_INVOICE_QUERY,
} from '../../integrations/jobber/jobber.queries';
import {
  jobberInvoiceByIdSchema,
  jobberInvoicesPageSchema,
  jobberPaymentRecordInvoiceSchema,
  type JobberInvoice,
} from '../../integrations/jobber/jobber.schemas';

/**
 * Invoices on a page.
 *
 * Jobber prices a connection as `first` times what each node asks for, and an
 * invoice asks for its lines and payments too -- about a hundred and thirty
 * points each. Twenty is under three thousand, a third of the bucket, which
 * leaves the visit sync on the same tick its room.
 */
const PAGE_SIZE = 20;

/**
 * Pages one run reads, and how long it may take.
 *
 * The first read is all 8,674 invoices, about 430 pages. Read in one go, it
 * would hold the scheduler's tick for most of an hour and skip every visit
 * sync behind it. So a run stops at fifteen pages or ninety seconds, keeps its
 * place, and the next tick carries on: the first read takes a few hours, and
 * every tick after it reads only what changed.
 */
const MAX_PAGES_PER_RUN = 15;
const RUN_BUDGET_MS = 90_000;

/** After Jobber hid invoices or a read failed, how long before asking again. */
const RETRY_AFTER_PROBLEM_MS = 60 * 60_000;

/**
 * How far back each "what changed" read reaches past the last change applied.
 *
 * Jobber's `after` is strict, so two invoices changed in the same second as
 * the last one applied would otherwise be skipped. Reading one second again
 * costs a re-apply, which changes nothing.
 */
const OVERLAP_MS = 1_000;

/**
 * Where the first read hands over to "what changed".
 *
 * Five minutes before the read began, so an invoice edited while the first
 * read was paging past it is read again.
 */
const FIRST_READ_MARGIN_MS = 5 * 60_000;

/** A throttled page: how long to wait, and how many times, before the next tick takes over. */
const THROTTLE_WAIT_MS = 15_000;
const THROTTLE_RETRIES = 2;

/** Points left in Jobber's bucket after a page, for whatever else runs on the tick. */
const BUCKET_RESERVE = 1_000;
const MAX_PACE_WAIT_SECONDS = 30;

export type InvoiceReadProblem = 'NOT_PERMITTED' | 'FAILED';

export interface InvoiceReadResult {
  mode: 'all' | 'changed' | null;
  pages: number;
  created: number;
  updated: number;
  stale: number;
  /** Invoices with more lines or payments than a page carries, read again by themselves. */
  readAlone: number;
  /** The first read reached the last invoice, or "what changed" ran out. */
  caughtUp: boolean;
  problem: InvoiceReadProblem | null;
  skipped: 'NOT_CONNECTED' | 'WAITING' | null;
}

/**
 * Reads Jobber's invoices into the console's copy (2026-11-05).
 *
 * Read-only towards Jobber. Every write is the console's own tables, through
 * `applyJobberInvoice`, which replaces an invoice whole and ignores a delivery
 * older than the copy -- so a page read twice, a webhook racing a page, or a
 * run cut short anywhere leaves the same result.
 *
 * Jobber's API is not billed. What it limits is points per second, shared with
 * the visit sync, which is why each run is bounded and paces itself on the
 * bucket Jobber reports back.
 */
@Injectable()
export class JobberInvoiceWorker {
  private readonly logger = new Logger(JobberInvoiceWorker.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
  ) {}

  /** One bounded run: the next part of the first read, or what changed since the last. */
  async run(organizationId: string): Promise<InvoiceReadResult> {
    const result: InvoiceReadResult = {
      mode: null,
      pages: 0,
      created: 0,
      updated: 0,
      stale: 0,
      readAlone: 0,
      caughtUp: false,
      problem: null,
      skipped: null,
    };
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: {
        status: true,
        invoiceReadCursor: true,
        invoiceReadStartedAt: true,
        invoiceReadCompletedAt: true,
        invoiceReadThrough: true,
        invoiceReadCheckedAt: true,
        invoiceReadProblem: true,
      },
    });
    if (!connection || connection.status !== JobberConnectionStatus.CONNECTED)
      return { ...result, skipped: 'NOT_CONNECTED' };
    if (
      connection.invoiceReadProblem &&
      connection.invoiceReadCheckedAt &&
      Date.now() - connection.invoiceReadCheckedAt.getTime() < RETRY_AFTER_PROBLEM_MS
    )
      return { ...result, skipped: 'WAITING', problem: connection.invoiceReadProblem as InvoiceReadProblem };

    const started = Date.now();
    const mode = connection.invoiceReadCompletedAt ? 'changed' : 'all';
    result.mode = mode;
    // When the first read began: kept with its first page, so the weeks an
    // app spends without the scope do not count as reading.
    const readStartedAt = connection.invoiceReadStartedAt ?? new Date(started);
    const firstPage = mode === 'all' && !connection.invoiceReadStartedAt ? { invoiceReadStartedAt: readStartedAt } : {};

    let cursor = mode === 'all' ? connection.invoiceReadCursor : null;
    let through = connection.invoiceReadThrough;
    const variables =
      mode === 'changed'
        ? { updatedAfter: through ? new Date(through.getTime() - OVERLAP_MS).toISOString() : null }
        : {};

    try {
      while (result.pages < MAX_PAGES_PER_RUN && Date.now() - started < RUN_BUDGET_MS) {
        const { data, cost } = await this.readPage(
          organizationId,
          invoicesPageQuery(mode),
          { first: PAGE_SIZE, after: cursor, ...variables },
          started,
        );
        const page = jobberInvoicesPageSchema.parse(data).invoices;
        for (const listed of page.nodes) {
          const invoice = isCutShort(listed) ? await this.readAlone(organizationId, listed.id, result) : listed;
          if (invoice) result[await this.apply(organizationId, invoice)] += 1;
          const changedAt = new Date(listed.updatedAt);
          if (!through || changedAt > through) through = changedAt;
        }
        result.pages += 1;
        cursor = page.pageInfo.endCursor ?? null;
        const caughtUp = !page.pageInfo.hasNextPage;
        const checked = { ...(result.pages === 1 ? firstPage : {}), invoiceReadCheckedAt: new Date(), invoiceReadProblem: null };
        if (mode === 'changed') await this.record(organizationId, { ...checked, invoiceReadThrough: through });
        else if (caughtUp)
          await this.record(organizationId, {
            ...checked,
            invoiceReadCursor: null,
            invoiceReadCompletedAt: new Date(),
            invoiceReadThrough: new Date(readStartedAt.getTime() - FIRST_READ_MARGIN_MS),
          });
        else await this.record(organizationId, { ...checked, invoiceReadCursor: cursor });
        if (caughtUp) {
          result.caughtUp = true;
          break;
        }
        if (!(await this.pace(cost, started))) break;
      }
    } catch (error) {
      if (error instanceof JobberError && error.code === 'JOBBER_SCOPE_MISSING') {
        result.problem = 'NOT_PERMITTED';
      } else if (error instanceof JobberError && error.retryable) {
        // Throttled or Jobber briefly away: the next tick carries on from the
        // same place, so this is not a problem worth an hour's wait.
        await this.record(organizationId, { invoiceReadCheckedAt: new Date() });
        return result;
      } else {
        result.problem = 'FAILED';
        this.logger.error({
          event: 'jobber_invoice_read_failed',
          organizationId,
          code: error instanceof JobberError ? error.code : undefined,
          message: error instanceof JobberError ? error.message : 'unexpected',
        });
      }
      await this.record(organizationId, { invoiceReadCheckedAt: new Date(), invoiceReadProblem: result.problem });
    }
    return result;
  }

  /** INVOICE_CREATE and INVOICE_UPDATE: the invoice as Jobber has it now; gone from the copy if Jobber has not. */
  async refreshInvoice(organizationId: string, jobberInvoiceId: string): Promise<InvoiceCopyResult | 'removed'> {
    const invoice = await this.fetchOne(organizationId, jobberInvoiceId);
    if (!invoice) {
      await this.removeInvoice(organizationId, jobberInvoiceId);
      return 'removed';
    }
    return this.apply(organizationId, invoice);
  }

  /** INVOICE_DESTROY. */
  removeInvoice(organizationId: string, jobberInvoiceId: string) {
    return this.prisma.$transaction((tx) => removeJobberInvoice(tx, organizationId, jobberInvoiceId));
  }

  /**
   * PAYMENT_CREATE, PAYMENT_UPDATE and PAYMENT_DESTROY: the invoice the payment
   * is on, read again, which carries the payment or no longer does. A payment
   * the copy already holds names its invoice; a new one is asked of Jobber.
   */
  async refreshForPayment(organizationId: string, jobberPaymentId: string) {
    const known = await this.prisma.invoicePayment.findFirst({
      where: { organizationId, jobberPaymentId },
      select: { invoice: { select: { jobberInvoiceId: true } } },
    });
    let jobberInvoiceId = known?.invoice.jobberInvoiceId ?? null;
    if (!jobberInvoiceId) {
      const data = await this.client.request(organizationId, PAYMENT_RECORD_INVOICE_QUERY, { id: jobberPaymentId });
      jobberInvoiceId = jobberPaymentRecordInvoiceSchema.parse(data).paymentRecord?.invoice?.id ?? null;
    }
    return jobberInvoiceId ? this.refreshInvoice(organizationId, jobberInvoiceId) : 'missing';
  }

  /**
   * A page, waiting out a throttle twice before leaving it to the next tick.
   *
   * The visit sync runs just before on the same tick and may leave the bucket
   * low, so the first page is the one most likely to be refused; fifteen
   * seconds refills 7,500 points. The same cursor is asked again: a refused
   * page returned nothing, so moving on would skip it.
   */
  private async readPage(
    organizationId: string,
    query: string,
    variables: Record<string, unknown>,
    started: number,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.requestDetailed(organizationId, query, variables);
      } catch (error) {
        const throttled = error instanceof JobberError && error.retryable;
        if (!throttled || attempt >= THROTTLE_RETRIES || Date.now() - started + THROTTLE_WAIT_MS > RUN_BUDGET_MS)
          throw error;
        await this.sleep(THROTTLE_WAIT_MS);
      }
    }
  }

  private async fetchOne(organizationId: string, jobberInvoiceId: string): Promise<JobberInvoice | null> {
    const data = await this.client.request(organizationId, INVOICE_BY_ID_QUERY, { id: jobberInvoiceId });
    return jobberInvoiceByIdSchema.parse(data).invoice;
  }

  private async readAlone(organizationId: string, jobberInvoiceId: string, result: InvoiceReadResult) {
    result.readAlone += 1;
    return this.fetchOne(organizationId, jobberInvoiceId);
  }

  private apply(organizationId: string, invoice: JobberInvoice) {
    const copy = toInvoiceCopy(invoice);
    return this.prisma.$transaction((tx) => applyJobberInvoice(tx, organizationId, copy));
  }

  private record(organizationId: string, data: Prisma.JobberConnectionUpdateInput) {
    return this.prisma.jobberConnection.update({ where: { organizationId }, data });
  }

  /**
   * Waits for Jobber's bucket to hold the next page and the reserve; false when
   * that wait would run past this run's budget, so the next tick carries on.
   */
  private async pace(cost: JobberCost | undefined, started: number) {
    const status = cost?.throttleStatus;
    if (!status || status.restoreRate <= 0) return true;
    const needed = (cost.requestedQueryCost ?? 0) + BUCKET_RESERVE;
    if (status.currentlyAvailable >= needed) return true;
    const seconds = Math.min((needed - status.currentlyAvailable) / status.restoreRate, MAX_PACE_WAIT_SECONDS);
    if (Date.now() - started + seconds * 1_000 > RUN_BUDGET_MS) return false;
    await this.sleep(seconds * 1_000);
    return true;
  }

  protected sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
