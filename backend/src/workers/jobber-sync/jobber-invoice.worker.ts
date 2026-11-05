import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus, JobberLinkStatus, type Prisma } from '@prisma/client';

import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import {
  applyJobberInvoice,
  pairJobberPayment,
  removeJobberInvoice,
  type InvoiceCopyResult,
  type JobberPaymentDetails,
} from '../../integrations/jobber/jobber-invoice-copy';
import {
  invoiceProperty,
  isCutShort,
  toInvoiceCopy,
  toPaymentDetails,
} from '../../integrations/jobber/jobber-invoice-mapping';
import { JobberClient, type JobberCost } from '../../integrations/jobber/jobber.client';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import { JobberMappingService, type BuildingIndex } from '../../integrations/jobber/jobber.mapping.service';
import {
  INVOICE_BY_ID_QUERY,
  invoicesPageQuery,
  PAYMENT_RECORD_QUERY,
  PAYMENTS_PAGE_QUERY,
} from '../../integrations/jobber/jobber.queries';
import {
  jobberInvoiceByIdSchema,
  jobberInvoicesPageSchema,
  jobberPaymentRecordByIdSchema,
  jobberPaymentsPageSchema,
  type JobberInvoice,
} from '../../integrations/jobber/jobber.schemas';

/**
 * Invoices on a page.
 *
 * Jobber prices a connection as `first` times what each node asks for, and an
 * invoice asks for its lines, payments, notes and files too -- about a hundred
 * and fifty points each. Twenty is about three thousand, a third of the
 * bucket, which leaves the visit sync on the same tick its room; and each page
 * waits on the cost Jobber reports, not on this estimate.
 */
const PAGE_SIZE = 20;

/**
 * Payments on a page of Jobber's payment list, and pages a run reads. A
 * payment is a handful of fields, a few points each; fifty is a few hundred.
 */
const PAYMENTS_PAGE_SIZE = 50;
const MAX_PAYMENT_PAGES_PER_RUN = 15;

/**
 * How recent an unpaired payment must be for its page to be read again.
 *
 * A payment recorded in Jobber in the seconds between the invoice read and the
 * payment list is in the list but not yet on the invoice's copy. Its page is
 * read again next tick, by when the invoice is. One older than this that still
 * pairs with nothing never will -- a payment split over invoices, say -- and
 * is left for the full pass before the cutover rather than holding the list.
 */
const HOLD_UNPAIRED_DAYS = 2;

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
  /** Invoices with more lines, payments, notes or files than a page carries, read again by themselves. */
  readAlone: number;
  /** The first read reached the last invoice, or "what changed" ran out. */
  caughtUp: boolean;
  /** Pages of Jobber's payment list read, and its payments paired with an invoice's or not. */
  paymentPages: number;
  paired: number;
  unpaired: number;
  /** The payment list reached its last payment. */
  paymentsCaughtUp: boolean;
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
    @Inject(JobberMappingService) private readonly mapping: JobberMappingService,
  ) {}

  /**
   * Which of the office's buildings an invoice is for, through its Jobber
   * property (2026-11-05).
   *
   * The same matcher the visit sync uses, so an invoice and a visit at one
   * Jobber property always land on the same building, and a link the office
   * fixed by hand is never re-decided. A property only ever seen on invoices is
   * matched by its address once, which adds nothing to the mapping queue: that
   * lists only links with a visit waiting on them. The buildings are read once a
   * run and each property resolved once a run, however many invoices it has.
   */
  private places(organizationId: string) {
    let index: Promise<BuildingIndex> | null = null;
    const known = new Map<string, Promise<string | null>>();
    return (invoice: JobberInvoice): Promise<string | null> => {
      const property = invoiceProperty(invoice);
      if (!property) return Promise.resolve(null);
      let building = known.get(property.jobberPropertyId);
      if (!building) {
        building = (async () => {
          index ??= this.mapping.buildingIndex(organizationId);
          const link = await this.mapping.resolveProperty(organizationId, property, await index);
          // Ignored by the office: not one of theirs to put a page to.
          return link.status === JobberLinkStatus.IGNORED ? null : (link.propertywareBuildingId ?? null);
        })();
        known.set(property.jobberPropertyId, building);
      }
      return building;
    };
  }

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
      paymentPages: 0,
      paired: 0,
      unpaired: 0,
      paymentsCaughtUp: false,
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
        paymentReadCursor: true,
        paymentReadCompletedAt: true,
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
    const buildingFor = this.places(organizationId);
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
          if (invoice) result[await this.apply(organizationId, invoice, buildingFor)] += 1;
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
      return result;
    }

    // How each payment was paid, from Jobber's payment list: only once the
    // invoices are current, so every payment in the list is already on its
    // invoice's copy to pair with. Not on the run that ends the first read:
    // invoices changed while it paged are read on the next. Its own failure
    // never stops the invoices; the next tick tries again from the cursor.
    if (mode === 'changed' && result.caughtUp) {
      try {
        await this.readPayments(organizationId, connection, started, result);
      } catch (error) {
        if (!(error instanceof JobberError && error.retryable))
          this.logger.error({
            event: 'jobber_payment_read_failed',
            organizationId,
            code: error instanceof JobberError ? error.code : undefined,
            message: error instanceof JobberError ? error.message : 'unexpected',
          });
      }
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
   * is on, read again, which carries the payment or no longer does; then how
   * it was paid, paired with it.
   *
   * The webhook names the payment by its payment-list id, which the invoice's
   * own view does not use, so a payment the copy already paired is found by
   * that; any other is asked of Jobber. One Jobber no longer has (a delete) is
   * found by the pairing, and its invoice read again without it.
   */
  async refreshForPayment(organizationId: string, jobberRecordId: string) {
    const data = await this.client.request(organizationId, PAYMENT_RECORD_QUERY, { id: jobberRecordId });
    const record = jobberPaymentRecordByIdSchema.parse(data).paymentRecord;
    const details = record ? toPaymentDetails(record) : null;
    let jobberInvoiceId = details?.jobberInvoiceId ?? null;
    if (!jobberInvoiceId) {
      const known = await this.prisma.invoicePayment.findFirst({
        where: { organizationId, jobberRecordId },
        select: { invoice: { select: { jobberInvoiceId: true } } },
      });
      jobberInvoiceId = known?.invoice.jobberInvoiceId ?? null;
    }
    if (!jobberInvoiceId) return 'missing';
    const result = await this.refreshInvoice(organizationId, jobberInvoiceId);
    if (details) await this.pair(organizationId, details);
    return result;
  }

  /**
   * One bounded pass over Jobber's payment list, from where the last stopped.
   *
   * Read from the start once, in the order the payments were recorded; after
   * that, each tick reads only what was recorded since, which appears after
   * the kept cursor. A payment edited in Jobber after it was paired is not
   * seen again here -- the invoice keeps its day and amount current, and the
   * full pass before the cutover reads every payment's method once more.
   */
  private async readPayments(
    organizationId: string,
    connection: { paymentReadCursor: string | null; paymentReadCompletedAt: Date | null },
    started: number,
    result: InvoiceReadResult,
  ) {
    let cursor = connection.paymentReadCursor;
    const holdFrom = businessDate(new Date(Date.now() - HOLD_UNPAIRED_DAYS * 86_400_000));
    while (result.paymentPages < MAX_PAYMENT_PAGES_PER_RUN && Date.now() - started < RUN_BUDGET_MS) {
      const { data, cost } = await this.readPage(
        organizationId,
        PAYMENTS_PAGE_QUERY,
        { first: PAYMENTS_PAGE_SIZE, after: cursor },
        started,
      );
      const page = jobberPaymentsPageSchema.parse(data).paymentRecords;
      let hold = false;
      for (const record of page.nodes) {
        const details = toPaymentDetails(record);
        if (details && (await this.pair(organizationId, details)) === 'paired') result.paired += 1;
        else {
          result.unpaired += 1;
          if (details && details.paidOn >= holdFrom) hold = true;
        }
      }
      result.paymentPages += 1;
      const caughtUp = !page.pageInfo.hasNextPage;
      // A fresh payment on the last page that its invoice does not carry yet:
      // this page again next tick, from the cursor it was read from. Only the
      // last page, so one that never pairs cannot hold the list: once fifty
      // more are recorded behind it, the page is no longer the last.
      if (hold && caughtUp) {
        result.paymentsCaughtUp = true;
        break;
      }
      // An empty last page names no cursor; the one kept is where the next
      // payment will appear.
      cursor = page.pageInfo.endCursor ?? cursor;
      await this.record(organizationId, {
        paymentReadCursor: cursor,
        ...(caughtUp && !connection.paymentReadCompletedAt ? { paymentReadCompletedAt: new Date() } : {}),
      });
      if (caughtUp) {
        result.paymentsCaughtUp = true;
        break;
      }
      if (!(await this.pace(cost, started))) break;
    }
  }

  private pair(organizationId: string, details: JobberPaymentDetails) {
    return this.prisma.$transaction((tx) => pairJobberPayment(tx, organizationId, details));
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

  private async apply(organizationId: string, invoice: JobberInvoice, buildingFor = this.places(organizationId)) {
    const copy = { ...toInvoiceCopy(invoice), linkedBuildingId: await buildingFor(invoice) };
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
