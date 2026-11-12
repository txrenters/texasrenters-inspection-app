import { Inject, Injectable, Logger } from '@nestjs/common';
import type { XeroBooksView } from '@texasrenters/shared';
import { InvoiceOrigin, InvoicePaymentMethod, InvoiceStatus, JobberLinkStatus, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { buildAddressIndex, matchBuilding, normalizeAddressKey } from '../jobber/jobber.address';
import { XeroAuthService } from './xero-auth.service';
import {
  BOOKS_PAGE_SIZE,
  booksInvoicesPageSchema,
  booksPaymentsPageSchema,
  invoiceFromXero,
  methodFromAccount,
  modifiedSinceHeader,
  newestOf,
  nextCursor,
  xeroBooksInvoiceSchema,
  xeroBooksPaymentSchema,
  xeroDay,
  type BooksCursor,
  type InvoiceFromXero,
  type XeroBooksInvoice,
} from './xero-books';
import { getXeroConfig } from './xero.config';
import { XeroClient } from './xero.client';
import { XeroError } from './xero.errors';

/** Calls one run may make: pages of its invoices -- the history, a thousand a page -- then of its payments. */
export const MAX_BOOKS_CALLS_PER_RUN = 6;
/** "Read invoices from Xero now": a page of each, so the page answers in seconds. */
export const MANUAL_BOOKS_CALLS = 2;
/** The calls a day the read leaves to sending, projects and the month check, under the console's ceiling. */
export const CALLS_KEPT_FOR_SENDING = 100;
/** A run's claim on the organisation -- the sender's own -- so a read and a send never overlap. */
const CLAIM_MS = 15 * 60_000;
/** Between one "Read now" and the next. */
const MANUAL_GAP_MS = 60_000;

const SALES = encodeURIComponent('Type=="ACCREC"');
const RECEIVED = encodeURIComponent('PaymentType=="ACCRECPAYMENT"');
const OLDEST_CHANGE_FIRST = encodeURIComponent('UpdatedDateUTC ASC');

const dateOf = (day: string | null) => (day ? new Date(`${day}T00:00:00.000Z`) : null);
const sameDay = (date: Date | null, day: string | null) => (date ? date.toISOString().slice(0, 10) : null) === day;
const nameKey = (value: string | null | undefined) => value?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
/** The console's own invoice a draft in Xero links back to (2026-11-12), from the link's last part: its id. */
const consoleIdOf = (url: string | null | undefined) =>
  /\/invoices\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(url?.trim() ?? '')?.[1]?.toLowerCase() ?? null;
const updatedOf = (entry: unknown) =>
  entry && typeof entry === 'object' && typeof (entry as { UpdatedDateUTC?: unknown }).UpdatedDateUTC === 'string'
    ? ((entry as { UpdatedDateUTC: string }).UpdatedDateUTC)
    : null;

export interface XeroBooksRunResult {
  invoices: { made: number; updated: number; unchanged: number; unreadable: number; unplaced: number };
  payments: { made: number; updated: number; removed: number; unplaced: number };
  /** Calls to Xero this run made. */
  calls: number;
  /** Its invoices were read to the end of what changed. */
  caughtUp: boolean;
  problem: string | null;
}

/** Where an invoice read from Xero is put: the visit it bills, the property, and Jobber's copy of it (2026-11-12). */
interface Place {
  inspectionId: string | null;
  buildingId: string | null;
  jobberCopyId: string | null;
}

/** What one run keeps between pages. */
interface RunContext {
  /** The office's buildings by address, built once, when an invoice first needs it. */
  addresses: Map<string, string[]> | null;
  /** Properties an invoice was put on this run: their contact is learned at the end. */
  touched: Set<string>;
  /** Whether Jobber ever billed for the company, asked once, when a number alone is tried. */
  jobberBilled?: boolean;
}

const emptyResult = (): XeroBooksRunResult => ({
  invoices: { made: 0, updated: 0, unchanged: 0, unreadable: 0, unplaced: 0 },
  payments: { made: 0, updated: 0, removed: 0, unplaced: 0 },
  calls: 0,
  caughtUp: false,
  problem: null,
});

/**
 * Reads each company's books back from Xero (2026-11-12, PR 2 of the plan to
 * make invoices in the console with Xero as the record).
 *
 * Every hour, and on "Read invoices from Xero now": its sales invoices that
 * changed since the last read -- lines, payments and amounts as Xero has them
 * -- and then its payments, for the account each went to and those deleted
 * there. Oldest change first, a thousand a page; the history is read a few
 * pages a run, under a share of the organisation's daily calls that always
 * leaves room for sending.
 *
 * Xero wins. Its invoice is kept as a row of its own (origin XERO), put on the
 * visit and property it is for when the console can tell: the console's own
 * invoice it is, the Jobber invoice the console sent as it, a Jobber invoice
 * under the same number in that company, its contact, its address. Nothing is
 * written onto Jobber's copies, and nothing is written to Xero. The rows stay
 * out of the invoice pages until they show Xero's books (PR 3).
 */
@Injectable()
export class XeroBooksService {
  private readonly logger = new Logger(XeroBooksService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroClient) private readonly client: XeroClient,
    @Inject(XeroAuthService) private readonly auth: XeroAuthService,
  ) {}

  /** What has been read, from the console's own rows. No call to Xero. */
  async view(organizationId: string, tenantId: string): Promise<XeroBooksView> {
    const fromXero = { organizationId, xeroTenantId: tenantId, origin: InvoiceOrigin.XERO } satisfies Prisma.InvoiceWhereInput;
    const unplacedWhere = { ...fromXero, propertywareBuildingId: null, status: { not: InvoiceStatus.VOIDED } } satisfies Prisma.InvoiceWhereInput;
    const [settings, invoices, placed, unplaced, owed, payments, consoleInvoices, unplacedRows] = await Promise.all([
      this.prisma.xeroSettings.findUnique({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        select: { booksReadAt: true, booksLastRunAt: true, booksLastRunProblem: true },
      }),
      this.prisma.invoice.count({ where: fromXero }),
      this.prisma.invoice.count({ where: { ...fromXero, propertywareBuildingId: { not: null } } }),
      this.prisma.invoice.count({ where: unplacedWhere }),
      this.prisma.invoice.aggregate({ where: { ...fromXero, status: InvoiceStatus.AWAITING_PAYMENT }, _sum: { balanceCents: true } }),
      this.prisma.invoicePayment.count({ where: { organizationId, origin: InvoiceOrigin.XERO, invoice: { is: { xeroTenantId: tenantId } } } }),
      this.prisma.invoice.count({ where: { organizationId, xeroTenantId: tenantId, origin: InvoiceOrigin.CONSOLE, xeroInvoiceId: { not: null } } }),
      this.prisma.invoice.findMany({
        where: unplacedWhere,
        orderBy: [{ issuedOn: { sort: 'desc', nulls: 'last' } }, { number: 'desc' }],
        take: 50,
        select: { number: true, clientName: true, issuedOn: true, totalCents: true, xeroStatus: true },
      }),
    ]);
    return {
      tenantId,
      readAt: settings?.booksReadAt?.toISOString() ?? null,
      lastRunAt: settings?.booksLastRunAt?.toISOString() ?? null,
      lastRunProblem: settings?.booksLastRunProblem ?? null,
      counts: { invoices, placed, unplaced, owedCents: owed._sum.balanceCents ?? 0, payments, consoleInvoices },
      unplaced: unplacedRows.map((row) => ({
        number: row.number,
        clientName: row.clientName,
        issuedOn: row.issuedOn ? row.issuedOn.toISOString().slice(0, 10) : null,
        totalCents: row.totalCents,
        xeroStatus: row.xeroStatus,
      })),
    };
  }

  /** "Read invoices from Xero now": a page of each at once, at most once a minute. */
  async readNow(user: AuthenticatedUser, tenantId: string): Promise<XeroBooksView> {
    const organizationId = user.organizationId;
    const settings = await this.prisma.xeroSettings.findUnique({
      where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
      select: { booksLastRunAt: true },
    });
    if (!settings) throw new XeroError('Choose what goes where in Xero first.', 'XERO_BOOKS_NOT_READY', 409);
    if (settings.booksLastRunAt && Date.now() - settings.booksLastRunAt.getTime() < MANUAL_GAP_MS)
      throw new XeroError('It was read a moment ago. Try again in a minute.', 'XERO_BOOKS_TOO_SOON', 429);
    await this.run(organizationId, tenantId, { manual: true, actorUserId: user.id });
    return this.view(organizationId, tenantId);
  }

  /**
   * "Read invoices from Xero now" on the invoices page (2026-11-12): a page of
   * each kind for every company whose books are shown as Xero has them, those
   * not read in the past minute. Two calls a company.
   */
  async readAllNow(user: AuthenticatedUser): Promise<{ companies: number; problems: string[] }> {
    const organizationId = user.organizationId;
    const rows = await this.prisma.xeroSettings.findMany({
      where: { organizationId, booksReadAt: { not: null } },
      select: { xeroTenantId: true, booksLastRunAt: true },
    });
    const due = rows.filter((row) => !row.booksLastRunAt || Date.now() - row.booksLastRunAt.getTime() >= MANUAL_GAP_MS);
    if (!due.length)
      throw rows.length
        ? new XeroError('It was read a moment ago. Try again in a minute.', 'XERO_BOOKS_TOO_SOON', 429)
        : new XeroError('No company’s invoices are read from Xero yet.', 'XERO_BOOKS_NOT_READY', 409);
    const problems: string[] = [];
    for (const row of due) {
      const result = await this.run(organizationId, row.xeroTenantId, { manual: true, actorUserId: user.id });
      if (result.problem) problems.push(result.problem);
    }
    return { companies: due.length, problems };
  }

  /**
   * One read of one organisation: the scheduler's, or "Read now". Takes the
   * sender's claim first; whatever stops it -- the calls left today, Xero
   * asking to slow down, the sign-in -- keeps where it got to for the next run
   * and says why.
   */
  async run(organizationId: string, tenantId: string, options: { manual?: boolean; actorUserId?: string | null } = {}): Promise<XeroBooksRunResult> {
    const result = emptyResult();
    const where = { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } };
    const [settings, organisation, connection] = await Promise.all([
      this.prisma.xeroSettings.findUnique({
        where,
        select: {
          booksInvoicesSince: true,
          booksInvoicesPage: true,
          booksPaymentsSince: true,
          booksPaymentsPage: true,
          booksReadAt: true,
          paymentAccounts: true,
        },
      }),
      this.prisma.xeroOrganisation.findUnique({ where, select: { status: true, callsDay: true, callsUsed: true } }),
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true } }),
    ]);
    if (!settings) return { ...result, problem: 'Choose what goes where in Xero first.' };
    const stop = async (problem: string) => {
      await this.prisma.xeroSettings.update({ where, data: { booksLastRunAt: new Date(), booksLastRunProblem: problem } });
      return { ...result, problem };
    };
    if (connection?.status !== 'CONNECTED' || organisation?.status !== 'CONNECTED') return stop('Xero is not connected.');

    // A share of the day's calls: sending, projects and the month check always keep theirs.
    const used = organisation.callsDay === businessDate() ? organisation.callsUsed : 0;
    let calls = Math.min(options.manual ? MANUAL_BOOKS_CALLS : MAX_BOOKS_CALLS_PER_RUN, getXeroConfig().dailyCallCeiling - CALLS_KEPT_FOR_SENDING - used);
    if (calls < 1) return stop(`The console keeps its last ${CALLS_KEPT_FOR_SENDING} calls to Xero today for sending. The read carries on tomorrow.`);

    const now = new Date();
    const claimed = await this.prisma.xeroSettings.updateMany({
      where: { organizationId, xeroTenantId: tenantId, OR: [{ sendingClaimedUntil: null }, { sendingClaimedUntil: { lt: now } }] },
      data: { sendingClaimedUntil: new Date(now.getTime() + CLAIM_MS) },
    });
    if (!claimed.count) return { ...result, problem: 'Xero is busy with a sending run. The read carries on next time.' };

    let invoices: BooksCursor = { since: settings.booksInvoicesSince, page: settings.booksInvoicesPage };
    let payments: BooksCursor = { since: settings.booksPaymentsSince, page: settings.booksPaymentsPage };
    let readAt = settings.booksReadAt;
    const context: RunContext = { addresses: null, touched: new Set() };
    try {
      // Its invoices first, so a payment finds its invoice.
      while (calls > 0) {
        const path = `/Invoices?where=${SALES}&order=${OLDEST_CHANGE_FIRST}&page=${invoices.page}&pageSize=${BOOKS_PAGE_SIZE}`;
        const page = await this.client.getChanged(organizationId, tenantId, path, booksInvoicesPageSchema, invoices.since ? modifiedSinceHeader(invoices.since) : null);
        calls--;
        result.calls++;
        const entries = page?.Invoices ?? [];
        await this.applyInvoices(organizationId, tenantId, entries, context, result);
        const next = nextCursor(invoices, { count: entries.length, newest: newestOf(entries.map(updatedOf)) });
        invoices = next.cursor;
        if (next.done) {
          result.caughtUp = true;
          readAt ??= new Date();
          break;
        }
      }
      // Then its payments, once its invoices are read to the end: the account each went to, and those changed or
      // deleted on their own.
      while (result.caughtUp && calls > 0) {
        const path = `/Payments?where=${RECEIVED}&order=${OLDEST_CHANGE_FIRST}&page=${payments.page}&pageSize=${BOOKS_PAGE_SIZE}`;
        const page = await this.client.getChanged(organizationId, tenantId, path, booksPaymentsPageSchema, payments.since ? modifiedSinceHeader(payments.since) : null);
        calls--;
        result.calls++;
        const entries = page?.Payments ?? [];
        await this.applyPayments(organizationId, tenantId, entries, (settings.paymentAccounts as Record<string, string> | null) ?? {}, result);
        const next = nextCursor(payments, { count: entries.length, newest: newestOf(entries.map(updatedOf)) });
        payments = next.cursor;
        if (next.done) break;
      }
      await this.learnContacts(organizationId, tenantId, context.touched);
    } catch (error) {
      result.problem = error instanceof XeroError ? error.message : 'The read stopped on an unexpected error.';
      if (error instanceof XeroError && error.code === 'XERO_REAUTHORIZATION_REQUIRED') await this.auth.requireReconnect(organizationId, error.message);
      if (!(error instanceof XeroError)) this.logger.error({ event: 'xero_books_read_failed', organizationId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.prisma.xeroSettings.update({
        where,
        data: {
          sendingClaimedUntil: null,
          booksInvoicesSince: invoices.since,
          booksInvoicesPage: invoices.page,
          booksPaymentsSince: payments.since,
          booksPaymentsPage: payments.page,
          booksReadAt: readAt,
          booksLastRunAt: new Date(),
          booksLastRunProblem: result.problem,
        },
      });
    }

    const { invoices: read, payments: paid } = result;
    if (options.manual || read.made || read.updated || paid.made || paid.updated || paid.removed || (readAt && !settings.booksReadAt))
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: options.actorUserId ?? null,
          action: 'XERO_BOOKS_READ',
          entityType: 'XeroSettings',
          entityId: organizationId,
          metadata: {
            tenantId,
            invoices: read,
            payments: paid,
            calls: result.calls,
            caughtUp: result.caughtUp,
            firstReadInFull: Boolean(readAt && !settings.booksReadAt),
            problem: result.problem,
          },
        },
      });
    return result;
  }

  /** One page of Xero's invoices, kept as Xero has them. */
  private async applyInvoices(organizationId: string, tenantId: string, entries: unknown[], context: RunContext, result: XeroBooksRunResult) {
    const page: XeroBooksInvoice[] = [];
    for (const entry of entries) {
      const parsed = xeroBooksInvoiceSchema.safeParse(entry);
      if (!parsed.success) result.invoices.unreadable++;
      else if (!parsed.data.Type || parsed.data.Type === 'ACCREC') page.push(parsed.data);
    }
    if (!page.length) return;
    const ids = page.map((theirs) => theirs.InvoiceID);
    const linkedBack = [...new Set(page.map((theirs) => consoleIdOf(theirs.Url)).filter((id): id is string => Boolean(id)))];
    const [rows, sent, writeOffs, waiting] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { organizationId, xeroTenantId: tenantId, xeroInvoiceId: { in: ids } },
        select: { id: true, origin: true, xeroInvoiceId: true, xeroUpdatedAt: true, inspectionId: true, propertywareBuildingId: true, jobberCopyId: true },
      }),
      // The console's own invoices it sent as these, and Jobber's it sent.
      this.prisma.xeroInvoiceSync.findMany({
        where: { organizationId, xeroTenantId: tenantId, xeroInvoiceId: { in: ids } },
        select: { xeroInvoiceId: true, invoice: { select: { id: true, origin: true, xeroInvoiceId: true, inspectionId: true, propertywareBuildingId: true } } },
      }),
      // Written off by the console: a bad debt, not just a credit.
      this.prisma.xeroWriteOffSync.findMany({
        where: { organizationId, xeroTenantId: tenantId, status: 'SENT', invoice: { is: { xeroSync: { is: { xeroInvoiceId: { in: ids } } } } } },
        select: { invoice: { select: { xeroSync: { select: { xeroInvoiceId: true } } } } },
      }),
      // The console's own drafts Xero has, by the link back to them (2026-11-12): one whose send lost its answer.
      linkedBack.length
        ? this.prisma.invoice.findMany({
            where: { organizationId, xeroTenantId: tenantId, origin: InvoiceOrigin.CONSOLE, xeroInvoiceId: null, id: { in: linkedBack } },
            select: { id: true },
          })
        : [],
    ]);
    const waitingIds = new Set(waiting.map((row) => row.id));
    const byId = new Map(rows.map((row) => [row.xeroInvoiceId!, row]));
    const sentAs = new Map(sent.map((row) => [row.xeroInvoiceId!, row.invoice]));
    const writtenOff = new Set(writeOffs.map((row) => row.invoice.xeroSync?.xeroInvoiceId).filter((id): id is string => Boolean(id)));

    // The console's own invoice, once Xero has it, is updated where it is; any other gets a row of its own.
    const consoleRowOf = (theirs: XeroBooksInvoice) => {
      const row = byId.get(theirs.InvoiceID);
      if (row) return row.origin === InvoiceOrigin.CONSOLE ? row.id : null;
      const ours = sentAs.get(theirs.InvoiceID);
      if (ours?.origin === InvoiceOrigin.CONSOLE && !ours.xeroInvoiceId) return ours.id;
      const linked = consoleIdOf(theirs.Url);
      return linked && waitingIds.has(linked) ? linked : null;
    };
    // On no visit yet, or with no Jobber copy found yet: where it goes is asked again.
    const unplaced = page.filter((theirs) => {
      const row = byId.get(theirs.InvoiceID);
      return !consoleRowOf(theirs) && (!row?.inspectionId || !row.jobberCopyId);
    });
    const places = await this.places(organizationId, tenantId, unplaced, sentAs, context);

    for (const theirs of page) {
      const mapped = invoiceFromXero(theirs, writtenOff.has(theirs.InvoiceID));
      if (!mapped) {
        result.invoices.unreadable++;
        continue;
      }
      const row = byId.get(theirs.InvoiceID);
      // Read again in the overlap, unchanged: nothing to write.
      if (row?.xeroUpdatedAt && mapped.xeroUpdatedAt && row.xeroUpdatedAt.getTime() === mapped.xeroUpdatedAt.getTime()) {
        result.invoices.unchanged++;
        continue;
      }
      const consoleRow = consoleRowOf(theirs);
      // A draft deleted in Xero before the console ever read it: nothing to keep.
      if (!row && !consoleRow && mapped.deleted) {
        result.invoices.unchanged++;
        continue;
      }
      const found = places.get(theirs.InvoiceID);
      const jobberCopyId = found?.jobberCopyId ?? row?.jobberCopyId ?? null;
      const place: Place = found?.inspectionId
        ? { ...found, jobberCopyId }
        : { inspectionId: row?.inspectionId ?? null, buildingId: row?.propertywareBuildingId ?? found?.buildingId ?? null, jobberCopyId };
      const counts = await this.prisma.$transaction((tx) =>
        this.write(tx, organizationId, tenantId, mapped, { rowId: row?.id ?? consoleRow, console: Boolean(consoleRow), place }),
      );
      if (row || consoleRow) result.invoices.updated++;
      else result.invoices.made++;
      result.payments.made += counts.made;
      result.payments.updated += counts.updated;
      result.payments.removed += counts.removed;
      if (!consoleRow) {
        if (!place.buildingId) result.invoices.unplaced++;
        else if (mapped.xeroContactId) context.touched.add(place.buildingId);
      }
    }
  }

  /**
   * The visit and property of each invoice read from Xero, in order of how
   * sure: the Jobber invoice the console sent as it; a Jobber invoice under the
   * same number in the same company (Zapier's, in its day) -- or, in none, the
   * only one for the same client, else the only one at all when the number is
   * this invoice's alone in Xero; its contact, as linked to one property; its
   * address, exactly as one property's. Anything else is on no property.
   */
  private async places(
    organizationId: string,
    tenantId: string,
    invoices: XeroBooksInvoice[],
    sentAs: Map<string, { id: string; origin: InvoiceOrigin; inspectionId: string | null; propertywareBuildingId: string | null }>,
    context: RunContext,
  ): Promise<Map<string, Place>> {
    const found = new Map<string, Place>();
    const put = (theirs: XeroBooksInvoice, place: Place) => {
      if (place.inspectionId || place.buildingId || place.jobberCopyId) found.set(theirs.InvoiceID, place);
    };
    // On a property already. A Jobber copy on none still leaves its contact and address to try.
    const placed = (theirs: XeroBooksInvoice) => Boolean(found.get(theirs.InvoiceID)?.inspectionId || found.get(theirs.InvoiceID)?.buildingId);
    const copyOf = (theirs: XeroBooksInvoice) => found.get(theirs.InvoiceID)?.jobberCopyId ?? null;
    for (const theirs of invoices) {
      const jobber = sentAs.get(theirs.InvoiceID);
      if (jobber?.origin === InvoiceOrigin.JOBBER) put(theirs, { inspectionId: jobber.inspectionId, buildingId: jobber.propertywareBuildingId, jobberCopyId: jobber.id });
    }

    const numberOf = (theirs: XeroBooksInvoice) => theirs.InvoiceNumber?.trim() ?? '';
    const byNumber = invoices.filter((theirs) => !found.has(theirs.InvoiceID) && numberOf(theirs));
    if (byNumber.length) {
      const copies = await this.prisma.invoice.findMany({
        where: {
          organizationId,
          origin: InvoiceOrigin.JOBBER,
          number: { in: [...new Set(byNumber.map(numberOf))] },
          OR: [{ xeroTenantId: tenantId }, { xeroTenantId: null }],
        },
        select: { id: true, number: true, xeroTenantId: true, clientName: true, inspectionId: true, propertywareBuildingId: true },
      });
      type Copy = (typeof copies)[number];
      const fromCopy = (copy: Copy): Place => ({ inspectionId: copy.inspectionId, buildingId: copy.propertywareBuildingId, jobberCopyId: copy.id });
      const lone: { theirs: XeroBooksInvoice; copy: Copy }[] = [];
      for (const theirs of byNumber) {
        const same = copies.filter((copy) => copy.number === numberOf(theirs));
        const companys = same.filter((copy) => copy.xeroTenantId === tenantId);
        const ofNone = same.filter((copy) => copy.xeroTenantId === null);
        const named = ofNone.filter((copy) => nameKey(copy.clientName) === nameKey(theirs.Contact?.Name));
        const copy = companys.length === 1 ? companys[0] : !companys.length && named.length === 1 ? named[0] : null;
        if (copy) put(theirs, fromCopy(copy));
        // Jobber named the client otherwise -- the tenant, where Xero has the
        // property or its owner -- so the number alone is tried (2026-11-12).
        else if (!companys.length && ofNone.length === 1) lone.push({ theirs, copy: ofNone[0]! });
      }
      // Never for a company Jobber never billed for (Crystal Creek Pest): its
      // numbers meet Jobber's only by chance.
      if (lone.length)
        context.jobberBilled ??= Boolean(
          await this.prisma.invoice.findFirst({ where: { organizationId, origin: InvoiceOrigin.JOBBER, xeroTenantId: tenantId }, select: { id: true } }),
        );
      if (lone.length && context.jobberBilled) {
        // The number in any company's books but this invoice, or the copy
        // standing for another invoice already, and it is not this one's.
        const others = await this.prisma.invoice.findMany({
          where: {
            organizationId,
            origin: InvoiceOrigin.XERO,
            OR: [{ number: { in: [...new Set(lone.map(({ theirs }) => numberOf(theirs)))] } }, { jobberCopyId: { in: lone.map(({ copy }) => copy.id) } }],
          },
          select: { number: true, xeroTenantId: true, xeroInvoiceId: true, jobberCopyId: true },
        });
        for (const { theirs, copy } of lone) {
          const another = others.filter((row) => row.xeroTenantId !== tenantId || row.xeroInvoiceId !== theirs.InvoiceID);
          const twice =
            invoices.filter((each) => numberOf(each) === numberOf(theirs)).length > 1 || another.some((row) => row.number === numberOf(theirs));
          if (!twice && !another.some((row) => row.jobberCopyId === copy.id)) put(theirs, fromCopy(copy));
        }
      }
    }

    const byContact = invoices.filter((theirs) => !placed(theirs) && theirs.Contact?.ContactID);
    if (byContact.length) {
      const links = await this.prisma.xeroContactLink.findMany({
        where: { organizationId, xeroTenantId: tenantId, xeroContactId: { in: [...new Set(byContact.map((theirs) => theirs.Contact!.ContactID!))] } },
        select: { clientKey: true, xeroContactId: true },
      });
      const clients = links.filter((link) => link.clientKey.startsWith('jobber:')).map((link) => link.clientKey.slice('jobber:'.length));
      const properties = clients.length
        ? await this.prisma.jobberPropertyLink.findMany({
            where: { organizationId, jobberClientId: { in: clients }, status: JobberLinkStatus.LINKED, propertywareBuildingId: { not: null } },
            select: { jobberClientId: true, propertywareBuildingId: true },
          })
        : [];
      const buildings = new Map<string, Set<string>>();
      const add = (contactId: string, buildingId: string) => buildings.set(contactId, (buildings.get(contactId) ?? new Set()).add(buildingId));
      for (const link of links) {
        if (link.clientKey.startsWith('property:')) add(link.xeroContactId, link.clientKey.slice('property:'.length));
        else if (link.clientKey.startsWith('jobber:'))
          for (const property of properties)
            if (property.jobberClientId === link.clientKey.slice('jobber:'.length)) add(link.xeroContactId, property.propertywareBuildingId!);
      }
      for (const theirs of byContact) {
        const theirBuildings = buildings.get(theirs.Contact!.ContactID!);
        // A contact over several properties -- a landlord's -- says none of them.
        if (theirBuildings?.size === 1) put(theirs, { inspectionId: null, buildingId: [...theirBuildings][0]!, jobberCopyId: copyOf(theirs) });
      }
    }

    const byAddress = invoices.filter((theirs) => !placed(theirs) && theirs.Contact?.Addresses?.length);
    for (const theirs of byAddress) {
      const address = theirs.Contact!.Addresses!.find((entry) => entry.AddressLine1?.trim() && entry.PostalCode?.trim());
      const key = address ? normalizeAddressKey(address.AddressLine1, address.PostalCode) : '';
      if (!key) continue;
      context.addresses ??= buildAddressIndex(
        await this.prisma.propertywareBuilding.findMany({ where: { organizationId }, select: { id: true, addressLine1: true, postalCode: true } }),
      );
      const match = matchBuilding(context.addresses, key);
      if (match.outcome === 'MATCHED') put(theirs, { inspectionId: null, buildingId: match.buildingId, jobberCopyId: copyOf(theirs) });
    }
    return found;
  }

  /** Writes one invoice as Xero has it: its columns, its lines replaced, its payments kept to Xero's. */
  private async write(
    tx: Prisma.TransactionClient,
    organizationId: string,
    tenantId: string,
    mapped: InvoiceFromXero,
    target: { rowId: string | null; console: boolean; place: Place },
  ) {
    const columns = {
      xeroInvoiceId: mapped.xeroInvoiceId,
      xeroContactId: mapped.xeroContactId,
      xeroStatus: mapped.xeroStatus,
      xeroUpdatedAt: mapped.xeroUpdatedAt,
      xeroUrl: mapped.xeroUrl,
      number: mapped.number,
      status: mapped.status,
      clientName: mapped.clientName,
      issuedOn: dateOf(mapped.issuedOn),
      dueOn: dateOf(mapped.dueOn),
      paidOn: dateOf(mapped.paidOn),
      subtotalCents: mapped.subtotalCents,
      taxCents: mapped.taxCents,
      totalCents: mapped.totalCents,
      balanceCents: mapped.balanceCents,
      amountPaidCents: mapped.amountPaidCents,
      amountCreditedCents: mapped.amountCreditedCents,
      taxInclusive: mapped.taxInclusive,
    } satisfies Prisma.InvoiceUncheckedUpdateInput;
    // The console's own invoice keeps its wording and where it is; Xero's has them from here.
    const own = target.console
      ? {}
      : { subject: mapped.subject, inspectionId: target.place.inspectionId, propertywareBuildingId: target.place.buildingId, jobberCopyId: target.place.jobberCopyId };
    const invoiceId = target.rowId
      ? (await tx.invoice.update({ where: { id: target.rowId }, data: { ...columns, ...own }, select: { id: true } })).id
      : (
          await tx.invoice.create({
            data: { ...columns, ...own, subject: mapped.subject, organizationId, origin: InvoiceOrigin.XERO, xeroTenantId: tenantId },
            select: { id: true },
          })
        ).id;

    await tx.invoiceLine.deleteMany({ where: { invoiceId } });
    if (mapped.lines.length) await tx.invoiceLine.createMany({ data: mapped.lines.map((line) => ({ organizationId, invoiceId, ...line })) });
    // The console's own, found in Xero (2026-11-12): its send is done, whatever became of the answer.
    if (target.console) {
      const sent = { xeroTenantId: tenantId, xeroInvoiceId: mapped.xeroInvoiceId, status: 'SENT', nextAttemptAt: null, problem: null };
      await tx.xeroInvoiceSync.upsert({
        where: { invoiceId },
        create: { organizationId, invoiceId, ...sent, sentAt: new Date() },
        update: sent,
      });
    }

    const counts = { made: 0, updated: 0, removed: 0 };
    const listed = mapped.payments.map((paid) => paid.xeroPaymentId);
    // Deleted in Xero: only the rows read from it go. A payment the office recorded here is never removed by a read.
    counts.removed = (await tx.invoicePayment.deleteMany({ where: { invoiceId, origin: InvoiceOrigin.XERO, xeroPaymentId: { notIn: listed } } })).count;
    if (!listed.length) return counts;
    const known = await tx.invoicePayment.findMany({
      where: { organizationId, xeroPaymentId: { in: listed } },
      select: { id: true, origin: true, invoiceId: true, xeroPaymentId: true, paidOn: true, amountCents: true, reference: true },
    });
    // The console's own payments it sent to Xero (2026-11-10, phase 4), found by what Xero called them.
    const sentHere = target.console
      ? await tx.xeroPaymentSync.findMany({
          where: { organizationId, invoiceId, xeroPaymentId: { in: listed }, paymentId: { not: null } },
          select: { paymentId: true, xeroPaymentId: true },
        })
      : [];
    for (const paid of mapped.payments) {
      const mine = known.find((payment) => payment.xeroPaymentId === paid.xeroPaymentId);
      if (mine) {
        if (
          mine.origin === InvoiceOrigin.XERO &&
          mine.invoiceId === invoiceId &&
          (!sameDay(mine.paidOn, paid.paidOn) || mine.amountCents !== paid.amountCents || mine.reference !== paid.reference)
        ) {
          await tx.invoicePayment.update({ where: { id: mine.id }, data: { paidOn: dateOf(paid.paidOn)!, amountCents: paid.amountCents, reference: paid.reference } });
          counts.updated++;
        }
        continue;
      }
      const ours = sentHere.find((row) => row.xeroPaymentId === paid.xeroPaymentId);
      if (ours) {
        await tx.invoicePayment.update({ where: { id: ours.paymentId! }, data: { xeroPaymentId: paid.xeroPaymentId } });
        counts.updated++;
        continue;
      }
      await tx.invoicePayment.create({
        data: {
          organizationId,
          invoiceId,
          origin: InvoiceOrigin.XERO,
          xeroPaymentId: paid.xeroPaymentId,
          paidOn: dateOf(paid.paidOn)!,
          amountCents: paid.amountCents,
          // How it came in follows from the account it went to, read with the payments.
          method: InvoicePaymentMethod.OTHER,
          reference: paid.reference,
        },
      });
      counts.made++;
    }
    return counts;
  }

  /** One page of Xero's payments: how each came in, from the account it went to, and those deleted there. */
  private async applyPayments(organizationId: string, tenantId: string, entries: unknown[], paymentAccounts: Record<string, string>, result: XeroBooksRunResult) {
    const page = entries.flatMap((entry) => {
      const parsed = xeroBooksPaymentSchema.safeParse(entry);
      return parsed.success && (parsed.data.PaymentType ?? 'ACCRECPAYMENT') === 'ACCRECPAYMENT' && parsed.data.Invoice?.InvoiceID ? [parsed.data] : [];
    });
    if (!page.length) return;
    const [known, invoices] = await Promise.all([
      this.prisma.invoicePayment.findMany({
        where: { organizationId, xeroPaymentId: { in: page.map((paid) => paid.PaymentID) } },
        select: { id: true, origin: true, xeroPaymentId: true, method: true, paidOn: true, amountCents: true, reference: true },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId, xeroTenantId: tenantId, xeroInvoiceId: { in: [...new Set(page.map((paid) => paid.Invoice!.InvoiceID!))] } },
        select: { id: true, xeroInvoiceId: true },
      }),
    ]);
    const byId = new Map(known.map((payment) => [payment.xeroPaymentId!, payment]));
    const invoiceOf = new Map(invoices.map((invoice) => [invoice.xeroInvoiceId!, invoice.id]));
    for (const paid of page) {
      const mine = byId.get(paid.PaymentID);
      if (paid.Status === 'DELETED') {
        if (mine?.origin === InvoiceOrigin.XERO) {
          await this.prisma.invoicePayment.delete({ where: { id: mine.id } });
          result.payments.removed++;
        }
        continue;
      }
      const paidOn = xeroDay(null, paid.Date);
      if (!paidOn) continue;
      const fields = {
        method: methodFromAccount(paid.Account?.AccountID, paymentAccounts),
        paidOn: dateOf(paidOn)!,
        amountCents: Math.round((paid.Amount ?? 0) * 100),
        reference: paid.Reference?.trim() || null,
      };
      if (mine) {
        // The office's own payment keeps how it said it came in; one read from Xero follows Xero.
        if (
          mine.origin === InvoiceOrigin.XERO &&
          (mine.method !== fields.method || !sameDay(mine.paidOn, paidOn) || mine.amountCents !== fields.amountCents || mine.reference !== fields.reference)
        ) {
          await this.prisma.invoicePayment.update({ where: { id: mine.id }, data: fields });
          result.payments.updated++;
        }
        continue;
      }
      const invoiceId = invoiceOf.get(paid.Invoice!.InvoiceID!);
      if (!invoiceId) {
        // Its invoice is not read yet, or is not a sales invoice the console keeps.
        result.payments.unplaced++;
        continue;
      }
      await this.prisma.invoicePayment.create({
        data: { organizationId, invoiceId, origin: InvoiceOrigin.XERO, xeroPaymentId: paid.PaymentID, ...fields },
      });
      result.payments.made++;
    }
  }

  /**
   * The Xero contact each property's invoices go under, learned from its
   * newest invoice there (`property:<building id>`): for the console's own
   * invoices to go under it (PR 4), and to place the next one.
   */
  private async learnContacts(organizationId: string, tenantId: string, touched: Set<string>) {
    if (!touched.size) return;
    const [, newest] = await this.prisma.$transaction([
      // Raw SQL does not pass through the client's tenant scope: set it here, as it does.
      this.prisma.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`,
      this.prisma.$queryRaw<{ buildingId: string; contactId: string; name: string }[]>`
        SELECT DISTINCT ON (i."propertywareBuildingId")
               i."propertywareBuildingId"::text AS "buildingId", i."xeroContactId" AS "contactId", i."clientName" AS "name"
          FROM "Invoice" i
         WHERE i."organizationId" = ${organizationId}::uuid
           AND i."xeroTenantId" = ${tenantId}
           AND i."xeroInvoiceId" IS NOT NULL
           AND i."xeroContactId" IS NOT NULL
           AND i."status" <> 'VOIDED'
           AND i."propertywareBuildingId" = ANY(${[...touched]}::uuid[])
         ORDER BY i."propertywareBuildingId", i."issuedOn" DESC NULLS LAST, i."xeroUpdatedAt" DESC NULLS LAST`,
    ]);
    const rows = newest as { buildingId: string; contactId: string; name: string }[];
    if (!rows.length) return;
    const keyOf = (buildingId: string) => `property:${buildingId}`;
    const existing = await this.prisma.xeroContactLink.findMany({
      where: { organizationId, xeroTenantId: tenantId, clientKey: { in: rows.map((row) => keyOf(row.buildingId)) } },
      select: { id: true, clientKey: true, xeroContactId: true },
    });
    const fresh = rows.filter((row) => !existing.some((link) => link.clientKey === keyOf(row.buildingId)));
    if (fresh.length)
      await this.prisma.xeroContactLink.createMany({
        data: fresh.map((row) => ({ organizationId, xeroTenantId: tenantId, clientKey: keyOf(row.buildingId), xeroContactId: row.contactId, name: row.name })),
        skipDuplicates: true,
      });
    for (const link of existing) {
      const row = rows.find((candidate) => keyOf(candidate.buildingId) === link.clientKey)!;
      if (link.xeroContactId !== row.contactId)
        await this.prisma.xeroContactLink.update({ where: { id: link.id }, data: { xeroContactId: row.contactId, name: row.name } });
    }
  }
}
