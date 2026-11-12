import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  paymentsGoToXero,
  projectsAreOn,
  xeroCanWrite,
  xeroSendingBlockers,
  type XeroAccount,
  type XeroItem,
  type XeroOrganisation,
  type XeroSendingView,
  type XeroTaxRate,
  type XeroTrackingCategory,
} from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { XeroAuthService } from './xero-auth.service';
import { XeroClient } from './xero.client';
import { refused, said, xeroContacts, type XeroAnswer } from './xero-contacts';
import { XeroError } from './xero.errors';
import { clientKeyOf, contactNameOf, invoiceFingerprint, xeroInvoiceFrom, type InvoiceForXero, type XeroInvoiceBody } from './xero-invoice';
import { paymentFingerprint, xeroPaymentFrom, type PaymentForXero, type XeroPaymentBody } from './xero-payment';
import { xeroWriteOffFrom } from './xero-write-off';
import { invoicingTakenOverAt } from '../../admin/invoice-settings';
import { XeroProjectsService, type XeroProjectsResult } from './xero-projects.service';
import { XeroSettingsService } from './xero-settings.service';

/** Xero takes up to 50 of a kind in one call. */
const BATCH = 50;
/** Invoices looked at in one run; the rest wait for the next. Four invoice calls and four contact calls at most. */
export const MAX_INVOICES_PER_RUN = 200;
/** Payments looked at in one run (2026-11-10, phase 4): four calls at most to send them. */
export const MAX_PAYMENTS_PER_RUN = 200;
/** Payments deleted in Xero in one run -- removed or changed here. One call each. */
export const MAX_PAYMENT_DELETES_PER_RUN = 20;
/** Bad debts written off, and write-offs taken back, in one run (2026-11-10): two calls each. */
export const MAX_WRITE_OFFS_PER_RUN = 20;
/**
 * The console's own drafts tried before and looked for in Xero in one run (2026-11-12): one call each. The rest wait
 * for the next run -- one is never sent again until it has been looked for.
 */
export const MAX_DRAFT_LOOKUPS_PER_RUN = 20;
/** A run's claim on the office; longer than any run, short enough that a crashed one does not stop sending for long. */
const CLAIM_MS = 15 * 60_000;
/** Between one "Send now" and the next. */
const MANUAL_GAP_MS = 60_000;
/** Xero refused it: tried again after an hour, six, then daily -- and at once when the invoice changes. */
const BACKOFF_MS = [60, 360, 1440].map((minutes) => minutes * 60_000);

const validationErrors = z.array(z.object({ Message: z.string() })).nullish();
const invoicesSchema = z.object({
  Invoices: z.array(
    z.object({
      InvoiceID: z.string().nullish(),
      // The number Xero gave a draft of the console's (2026-11-12).
      InvoiceNumber: z.string().nullish(),
      StatusAttributeString: z.string().nullish(),
      ValidationErrors: validationErrors,
    }),
  ),
});
/** A contact's invoices on one day (2026-11-12): the console's draft among them is the one linked back to its page. */
const draftsSchema = z.object({
  Invoices: z.array(z.object({ InvoiceID: z.string(), InvoiceNumber: z.string().nullish(), Url: z.string().nullish(), Status: z.string().nullish() })),
});
/** Xero's invoices under some numbers (2026-11-11): what it has already, made by Zapier or by hand. */
const numberedSchema = z.object({
  Invoices: z.array(
    z.object({
      InvoiceID: z.string(),
      InvoiceNumber: z.string().nullish(),
      Type: z.string().nullish(),
      Status: z.string().nullish(),
      Contact: z.object({ Name: z.string().nullish() }).nullish(),
    }),
  ),
});
const paymentsSchema = z.object({
  Payments: z.array(z.object({ PaymentID: z.string().nullish(), StatusAttributeString: z.string().nullish(), ValidationErrors: validationErrors })),
});
const creditNotesSchema = z.object({
  CreditNotes: z.array(
    z.object({
      CreditNoteID: z.string().nullish(),
      StatusAttributeString: z.string().nullish(),
      ValidationErrors: validationErrors,
      Allocations: z.array(z.object({ AllocationID: z.string().nullish() })).nullish(),
    }),
  ),
});
const allocationsSchema = z.object({
  Allocations: z.array(z.object({ AllocationID: z.string().nullish(), StatusAttributeString: z.string().nullish(), ValidationErrors: validationErrors })).nullish(),
});
const keyOf = (organizationId: string, path: string, body: unknown) => createHash('sha256').update(`${organizationId}|${path}|${JSON.stringify(body)}`).digest('hex');
/** A day, `YYYY-MM-DD`, as Xero's `where` filter writes one: `DateTime(2026,11,5)`. */
const xeroDateTime = (day: string) => `DateTime(${day.split('-').map(Number).join(',')})`;

const INVOICE_FIELDS = {
  id: true,
  number: true,
  subject: true,
  status: true,
  clientName: true,
  jobberClientId: true,
  jobNumber: true,
  issuedOn: true,
  dueOn: true,
  taxCents: true,
  discountCents: true,
  totalCents: true,
  updatedAt: true,
  // The console's own goes as a draft Xero numbers, under its property's contact (2026-11-12).
  origin: true,
  propertywareBuildingId: true,
  lines: { select: { position: true, name: true, description: true, quantity: true, unitPriceCents: true, totalCents: true } },
  xeroSync: true,
  // The visit it bills (2026-11-11): its day dates the invoice in Xero, and its technician tags the lines.
  inspection: {
    select: {
      scheduledAt: true,
      assignments: { where: { isCurrent: true }, orderBy: { assignedAt: 'asc' }, take: 1, select: { technician: { select: { displayName: true } } } },
    },
  },
} satisfies Prisma.InvoiceSelect;
type Candidate = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_FIELDS }>;
type SyncRow = NonNullable<Candidate['xeroSync']>;

/** The invoice as Xero is sent it: with its visit's day -- `scheduledAt` is that day's UTC midnight -- and technician. */
export function invoiceForXero(invoice: Candidate): InvoiceForXero {
  return {
    ...invoice,
    visitDay: invoice.inspection ? invoice.inspection.scheduledAt.toISOString().slice(0, 10) : null,
    technicianName: invoice.inspection?.assignments[0]?.technician.displayName ?? null,
  };
}

/** What an organisation's lines are posted to, tagged and itemed with, as last read. */
interface Catalog {
  accounts: XeroAccount[];
  trackingCategories: XeroTrackingCategory[];
  items: XeroItem[];
  /** As last read (2026-11-13): a tax type's rate, so none is put on top of prices that leave it out. */
  taxRates: XeroTaxRate[];
}

const PAYMENT_FIELDS = {
  id: true,
  paidOn: true,
  amountCents: true,
  method: true,
  reference: true,
  updatedAt: true,
  xeroSync: true,
  invoice: { select: { id: true, number: true, xeroSync: { select: { xeroInvoiceId: true } } } },
} satisfies Prisma.InvoicePaymentSelect;
type PaymentCandidate = Prisma.InvoicePaymentGetPayload<{ select: typeof PAYMENT_FIELDS }>;
type PaymentSyncRow = NonNullable<PaymentCandidate['xeroSync']>;

export interface XeroRunResult {
  sent: number;
  failed: number;
  unchanged: number;
  /** Already in Xero under the same number (2026-11-11), made by Zapier or by hand: linked, not made twice. */
  linked: number;
  /** Payments (2026-11-10, phase 4): sent, refused or held back, and deleted in Xero after they were removed here. */
  payments: { sent: number; failed: number; removed: number };
  /** Bad debts (2026-11-10): written off, refused or held back, and taken back for invoices reopened here. */
  writeOffs: { sent: number; failed: number; reversed: number };
  /** Visits' projects (2026-11-11): made, found made by the office, and refused. */
  projects: Omit<XeroProjectsResult, 'names'>;
  problem: string | null;
}

/** What one run may still delete in Xero. */
interface DeleteBudget {
  left: number;
}

/**
 * Sends the office's invoices to Xero (2026-11-10, phase 3 of the Xero plan).
 *
 * Only while it is turned on, and only invoices issued from the start date.
 * Each goes once (2026-11-12): an invoice in Xero is the office's there, and
 * is never sent again -- one changed here after it went is marked, for the
 * office to make the change in Xero too. Nothing calls Xero for it. Contacts
 * and invoices go up to 50 a call, with an idempotency key, under the
 * console's daily ceiling. Approved, or drafts, never emailed by Xero. A
 * refusal is kept with Xero's reason and tried again later; an invoice the
 * console will not send as it is (its lines do not come to its total, it
 * carries sales tax) is held with the reason until it changes.
 */
@Injectable()
export class XeroSenderService {
  private readonly logger = new Logger(XeroSenderService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroClient) private readonly client: XeroClient,
    @Inject(XeroAuthService) private readonly auth: XeroAuthService,
    @Inject(XeroSettingsService) private readonly settings: XeroSettingsService,
    @Inject(XeroProjectsService) private readonly projects: XeroProjectsService,
  ) {}

  async view(organizationId: string, tenantId: string): Promise<XeroSendingView> {
    const state = await this.state(organizationId, tenantId);
    const tenant = state.tenantId;
    // Changed here after it went (2026-11-12): never sent again, the office's to change in Xero.
    const changedHereWhere = { organizationId, xeroTenantId: tenant ?? '', status: 'SENT', changedHereAt: { not: null } } satisfies Prisma.XeroInvoiceSyncWhereInput;
    const [
      sent,
      failed,
      notYet,
      noCompany,
      failures,
      paymentsSent,
      paymentsFailed,
      paymentFailures,
      writeOffsSent,
      writeOffsFailed,
      writeOffFailures,
      projects,
      changedHere,
      changedHereRows,
    ] = await Promise.all([
      tenant ? this.prisma.xeroInvoiceSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'SENT' } }) : 0,
      tenant ? this.prisma.xeroInvoiceSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'FAILED' } }) : 0,
      tenant && state.sendFrom
        ? this.prisma.invoice.count({
            where: {
              organizationId,
              // Only this organisation's invoices (2026-11-10): each company's go to its own books.
              xeroTenantId: tenant,
              // Never one read from its books (2026-11-12), nor one of the console's that Xero already has.
              origin: { not: InvoiceOrigin.XERO },
              xeroInvoiceId: null,
              issuedOn: { gte: new Date(`${state.sendFrom}T00:00:00.000Z`) },
              // The console's drafts go too (2026-11-12): Xero numbers them.
              AND: [
                {
                  OR: [
                    { origin: InvoiceOrigin.CONSOLE, status: { not: InvoiceStatus.VOIDED } },
                    { status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] } },
                  ],
                },
              ],
              OR: [{ xeroSync: { is: null } }, { xeroSync: { xeroTenantId: { not: tenant } } }],
            },
          })
        : 0,
      // What belongs to no company is sent nowhere: said, so it is not taken for sent.
      tenant && state.sendFrom
        ? this.prisma.invoice.count({
            where: {
              organizationId,
              xeroTenantId: null,
              origin: { not: InvoiceOrigin.XERO },
              issuedOn: { gte: new Date(`${state.sendFrom}T00:00:00.000Z`) },
              status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] },
            },
          })
        : 0,
      tenant
        ? this.prisma.xeroInvoiceSync.findMany({
            where: { organizationId, xeroTenantId: tenant, status: 'FAILED' },
            orderBy: [{ lastAttemptAt: 'desc' }],
            take: 50,
            select: {
              invoiceId: true,
              problem: true,
              attempts: true,
              lastAttemptAt: true,
              nextAttemptAt: true,
              invoice: { select: { number: true, clientName: true } },
            },
          })
        : [],
      // Its payments (2026-11-10, phase 4).
      tenant ? this.prisma.xeroPaymentSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'SENT' } }) : 0,
      tenant ? this.prisma.xeroPaymentSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'FAILED' } }) : 0,
      tenant
        ? this.prisma.xeroPaymentSync.findMany({
            where: { organizationId, xeroTenantId: tenant, status: 'FAILED' },
            orderBy: [{ lastAttemptAt: 'desc' }],
            take: 50,
            select: {
              paymentId: true,
              invoiceId: true,
              problem: true,
              attempts: true,
              lastAttemptAt: true,
              nextAttemptAt: true,
              payment: { select: { amountCents: true, paidOn: true } },
              invoice: { select: { number: true, clientName: true } },
            },
          })
        : [],
      // Its bad debts (2026-11-10).
      tenant ? this.prisma.xeroWriteOffSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'SENT' } }) : 0,
      tenant ? this.prisma.xeroWriteOffSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'FAILED' } }) : 0,
      tenant
        ? this.prisma.xeroWriteOffSync.findMany({
            where: { organizationId, xeroTenantId: tenant, status: 'FAILED' },
            orderBy: [{ lastAttemptAt: 'desc' }],
            take: 50,
            select: {
              invoiceId: true,
              amountCents: true,
              problem: true,
              attempts: true,
              lastAttemptAt: true,
              nextAttemptAt: true,
              invoice: { select: { number: true, clientName: true, status: true } },
            },
          })
        : [],
      // Its visits' projects (2026-11-11).
      tenant ? this.projects.summary(organizationId, tenant) : { done: 0, failed: 0, failures: [] },
      tenant ? this.prisma.xeroInvoiceSync.count({ where: changedHereWhere }) : 0,
      tenant
        ? this.prisma.xeroInvoiceSync.findMany({
            where: changedHereWhere,
            orderBy: [{ changedHereAt: 'desc' }],
            take: 50,
            select: { invoiceId: true, changedHereAt: true, invoice: { select: { number: true, clientName: true, status: true } } },
          })
        : [],
    ]);
    return {
      tenantId,
      enabled: state.row?.sendingEnabled ?? false,
      changedAt: state.row?.sendingChangedAt?.toISOString() ?? null,
      canWrite: state.canWrite,
      projectsEnabled: state.projectsEnabled,
      madeInConsole: !state.jobberSends,
      blockers: state.blockers,
      counts: {
        sent,
        failed,
        notYet,
        noCompany,
        payments: { sent: paymentsSent, failed: paymentsFailed },
        writeOffs: { sent: writeOffsSent, failed: writeOffsFailed },
        projects: { done: projects.done, failed: projects.failed },
        changedHere,
      },
      lastRunAt: state.row?.lastRunAt?.toISOString() ?? null,
      lastRunProblem: state.row?.lastRunProblem ?? null,
      failures: failures.map((row) => ({
        invoiceId: row.invoiceId,
        number: row.invoice.number,
        clientName: row.invoice.clientName,
        problem: row.problem ?? 'Not sent.',
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      })),
      paymentFailures: paymentFailures.map((row) => ({
        paymentId: row.paymentId,
        invoiceId: row.invoiceId,
        number: row.invoice.number,
        clientName: row.invoice.clientName,
        // A payment removed here, still to delete in Xero, has none.
        amountCents: row.payment?.amountCents ?? null,
        paidOn: row.payment ? row.payment.paidOn.toISOString().slice(0, 10) : null,
        problem: row.problem ?? 'Not sent.',
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      })),
      writeOffFailures: writeOffFailures.map((row) => ({
        invoiceId: row.invoiceId,
        number: row.invoice.number,
        clientName: row.invoice.clientName,
        amountCents: row.amountCents,
        // Reopened here: what is left to do is taking it back.
        reversing: row.invoice.status !== InvoiceStatus.BAD_DEBT,
        problem: row.problem ?? 'Not written off.',
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      })),
      projectFailures: projects.failures,
      changedHere: changedHereRows.map((row) => ({
        invoiceId: row.invoiceId,
        number: row.invoice.number,
        clientName: row.invoice.clientName,
        voided: row.invoice.status === InvoiceStatus.VOIDED,
        changedAt: row.changedHereAt!.toISOString(),
      })),
    };
  }

  /**
   * On only when nothing blocks it; off at any time -- once the console makes
   * the invoices (2026-11-13), only when the office says it means it: from then
   * the company's new invoices get the console's own numbers and reach no books.
   * Audited both ways.
   */
  async setEnabled(user: AuthenticatedUser, tenantId: string, enabled: boolean, confirmed = false): Promise<XeroSendingView> {
    const organizationId = user.organizationId;
    const state = await this.state(organizationId, tenantId);
    if (enabled && state.blockers.length) throw new XeroError(state.blockers[0]!, 'XERO_SENDING_BLOCKED', 409);
    if (!state.row) throw new XeroError('Choose what goes where in Xero first.', 'XERO_SENDING_BLOCKED', 409);
    if (!enabled && state.row.sendingEnabled && !state.jobberSends && !confirmed)
      throw new XeroError(
        "Invoices are made in the console now: with sending off, this company's new invoices get the console's own numbers and reach no books, and nobody emails them. Say you mean it to turn it off.",
        'XERO_SENDING_OFF_UNCONFIRMED',
        409,
      );
    if (state.row.sendingEnabled !== enabled) {
      await this.prisma.xeroSettings.update({ where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } }, data: { sendingEnabled: enabled, sendingChangedAt: new Date() } });
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: user.id,
          action: enabled ? 'XERO_SENDING_TURNED_ON' : 'XERO_SENDING_TURNED_OFF',
          entityType: 'XeroSettings',
          entityId: organizationId,
          metadata: { organisation: state.name, tenantId, sendFrom: state.sendFrom },
        },
      });
    }
    return this.view(organizationId, tenantId);
  }

  /** "Send now": a run at once, at most once a minute. */
  async runNow(user: AuthenticatedUser, tenantId: string): Promise<XeroSendingView> {
    const organizationId = user.organizationId;
    const row = await this.prisma.xeroSettings.findUnique({ where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } }, select: { sendingEnabled: true, lastRunAt: true } });
    if (!row?.sendingEnabled) throw new XeroError('Turn sending on first.', 'XERO_SENDING_OFF', 409);
    if (row.lastRunAt && Date.now() - row.lastRunAt.getTime() < MANUAL_GAP_MS)
      throw new XeroError('It ran a moment ago. Try again in a minute.', 'XERO_RUN_TOO_SOON', 429);
    await this.run(organizationId, tenantId);
    return this.view(organizationId, tenantId);
  }

  /** "Try again": every invoice and payment this organisation refused is due now, whether or not it changed. */
  async retryFailed(user: AuthenticatedUser, tenantId: string): Promise<XeroSendingView> {
    const organizationId = user.organizationId;
    const due = { nextAttemptAt: new Date(), seenUpdatedAt: null };
    const { count } = await this.prisma.xeroInvoiceSync.updateMany({ where: { organizationId, xeroTenantId: tenantId, status: 'FAILED' }, data: due });
    const payments = await this.prisma.xeroPaymentSync.updateMany({ where: { organizationId, xeroTenantId: tenantId, status: 'FAILED' }, data: due });
    const writeOffs = await this.prisma.xeroWriteOffSync.updateMany({
      where: { organizationId, xeroTenantId: tenantId, status: 'FAILED' },
      data: { nextAttemptAt: due.nextAttemptAt },
    });
    const projects = await this.projects.retry(organizationId, tenantId);
    if (count || payments.count || writeOffs.count || projects)
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: user.id,
          action: 'XERO_SENDING_RETRIED',
          entityType: 'XeroSettings',
          entityId: organizationId,
          metadata: { tenantId, invoices: count, payments: payments.count, writeOffs: writeOffs.count, projects },
        },
      });
    return this.view(organizationId, tenantId);
  }

  /**
   * One run for one of the office's organisations: the scheduler's, or "Send
   * now". Claims it first, so two runs never send to it at once; whatever
   * stops it (the daily ceiling, Xero asking to slow down, the sign-in) leaves
   * the rest for the next run and says why.
   */
  async run(organizationId: string, tenantId: string): Promise<XeroRunResult> {
    const result: XeroRunResult = {
      sent: 0,
      failed: 0,
      unchanged: 0,
      linked: 0,
      payments: { sent: 0, failed: 0, removed: 0 },
      writeOffs: { sent: 0, failed: 0, reversed: 0 },
      projects: { made: 0, linked: 0, failed: 0 },
      problem: null,
    };
    const projectNames: string[] = [];
    const state = await this.state(organizationId, tenantId);
    if (!state.row?.sendingEnabled) return { ...result, problem: 'Sending is off.' };
    if (state.blockers.length || !state.tenantId || !state.sendFrom) {
      const problem = state.blockers[0] ?? 'Xero is not ready.';
      await this.prisma.xeroSettings.update({ where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } }, data: { lastRunAt: new Date(), lastRunProblem: problem } });
      return { ...result, problem };
    }
    const now = new Date();
    const claimed = await this.prisma.xeroSettings.updateMany({
      where: { organizationId, xeroTenantId: tenantId, sendingEnabled: true, OR: [{ sendingClaimedUntil: null }, { sendingClaimedUntil: { lt: now } }] },
      data: { sendingClaimedUntil: new Date(now.getTime() + CLAIM_MS) },
    });
    // A read of the company's books holds the same claim (2026-11-12).
    if (!claimed.count) return { ...result, problem: 'Another run is sending to Xero, or reading from it.' };

    const sentNumbers: string[] = [];
    const budget: DeleteBudget = { left: MAX_PAYMENT_DELETES_PER_RUN };
    try {
      // Payments removed here, and write-offs of invoices reopened here, first.
      await this.removePayments(organizationId, state.tenantId, result, budget);
      await this.reverseWriteOffs(organizationId, state.tenantId, result);
      await this.send(organizationId, state.tenantId, state.sendFrom, state.catalog, result, sentNumbers, state.projectsEnabled, state.jobberSends);
      // A project for each visit whose invoice is now in Xero (2026-11-11), the office's to put the line on.
      if (state.projectsEnabled) {
        // Filled as it goes: what was made before a stop still reaches the audit entry.
        const made: XeroProjectsResult = { made: 0, linked: 0, failed: 0, names: [] };
        try {
          await this.projects.run(organizationId, state.tenantId, state.sendFrom, state.values, state.currency, made);
        } finally {
          result.projects = { made: made.made, linked: made.linked, failed: made.failed };
          projectNames.push(...made.names);
        }
      }
      // Then the payments, against the invoices as they now are in Xero -- unless the office records them there itself
      // (2026-11-11); then what was written off as bad debt.
      if (state.paymentsToXero) await this.sendPayments(organizationId, state.tenantId, state.accounts, result, budget);
      // Bad debts are written off in Xero by the office once its books are read there (2026-11-12).
      if (!state.booksRead) await this.writeOffs(organizationId, state.tenantId, state.accounts, result);
    } catch (error) {
      result.problem = error instanceof XeroError ? error.message : 'The run stopped on an unexpected error.';
      if (error instanceof XeroError && error.code === 'XERO_REAUTHORIZATION_REQUIRED') await this.auth.requireReconnect(organizationId, error.message);
      if (!(error instanceof XeroError)) this.logger.error({ event: 'xero_sending_failed', organizationId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.prisma.xeroSettings.update({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        data: { sendingClaimedUntil: null, lastRunAt: new Date(), lastRunProblem: result.problem },
      });
    }
    const { payments, writeOffs, projects } = result;
    if (
      result.sent ||
      result.failed ||
      result.linked ||
      payments.sent ||
      payments.failed ||
      payments.removed ||
      writeOffs.sent ||
      writeOffs.failed ||
      writeOffs.reversed ||
      projects.made ||
      projects.linked ||
      projects.failed
    )
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'XERO_INVOICES_SENT',
          entityType: 'XeroSettings',
          entityId: organizationId,
          metadata: {
            organisation: state.name,
            tenantId,
            sent: result.sent,
            failed: result.failed,
            linked: result.linked,
            numbers: sentNumbers.slice(0, 100),
            payments,
            writeOffs,
            projects: { ...projects, names: projectNames.slice(0, 50) },
            problem: result.problem,
          },
        },
      });
    return result;
  }

  private async send(
    organizationId: string,
    tenantId: string,
    sendFrom: string,
    catalog: Catalog,
    result: XeroRunResult,
    sentNumbers: string[],
    /** Its visits get projects (2026-11-11): new invoices go as drafts. */
    asDraft = false,
    /** Jobber's invoices still go (2026-11-12): until the console makes the invoices. */
    jobberSends = true,
  ) {
    const ids = await this.candidates(organizationId, tenantId, sendFrom, jobberSends);
    if (!ids.length) return;
    const invoices = await this.prisma.invoice.findMany({ where: { organizationId, id: { in: ids } }, select: INVOICE_FIELDS });
    const values = (await this.settings.read(organizationId, tenantId)).values;

    const due: { invoice: Candidate; sync: SyncRow | null; fingerprint: string }[] = [];
    for (const invoice of invoices) {
      const sync = invoice.xeroSync?.xeroTenantId === tenantId ? invoice.xeroSync : null;
      const fingerprint = invoiceFingerprint(invoiceForXero(invoice));
      // In Xero already (2026-11-12): never sent again, only noted as seen -- and marked when it changed here since.
      if (sync?.xeroInvoiceId) {
        await this.seen(invoice, sync, fingerprint);
        result.unchanged++;
        continue;
      }
      // Voided before it ever reached Xero: there is nothing there to void, and its old refusal no longer matters.
      if (invoice.status === InvoiceStatus.VOIDED) {
        if (invoice.xeroSync) await this.prisma.xeroInvoiceSync.delete({ where: { invoiceId: invoice.id } });
        result.unchanged++;
        continue;
      }
      due.push({ invoice, sync, fingerprint });
    }
    if (!due.length) return;

    // The contacts they go under: made in Xero for clients it has not got yet.
    const contacts = await this.contacts(
      organizationId,
      tenantId,
      due.map((item) => item.invoice),
    );

    let outgoing: { item: (typeof due)[number]; body: XeroInvoiceBody }[] = [];
    for (const item of due) {
      const contact = contacts.get(clientKeyOf(item.invoice));
      if (!contact || 'problem' in contact) {
        await this.failed(organizationId, tenantId, item, contact ? contact.problem : 'Its client could not be made a contact in Xero.', true);
        result.failed++;
        continue;
      }
      const plan = xeroInvoiceFrom(invoiceForXero(item.invoice), {
        settings: values,
        accounts: catalog.accounts,
        trackingCategories: catalog.trackingCategories,
        items: catalog.items,
        taxRates: catalog.taxRates,
        contactId: contact.id,
        asDraft,
        // The console's own (2026-11-12): a complete draft, numbered by Xero, linked back to its page here.
        ...(item.invoice.origin === InvoiceOrigin.CONSOLE ? { consoleUrl: consoleInvoiceUrl(item.invoice.id) } : {}),
      });
      if (plan.kind === 'problem') {
        // Held back by the console: tried again when the invoice, or the choices, change -- not on a timer.
        await this.failed(organizationId, tenantId, item, plan.problem, false);
        result.failed++;
        continue;
      }
      outgoing.push({ item, body: plan.body });
    }

    // The console's own (2026-11-12): made in Xero once, by PUT, as drafts Xero numbers.
    await this.sendDrafts(
      organizationId,
      tenantId,
      outgoing.filter((entry) => entry.item.invoice.origin === InvoiceOrigin.CONSOLE),
      result,
      sentNumbers,
    );
    outgoing = outgoing.filter((entry) => entry.item.invoice.origin !== InvoiceOrigin.CONSOLE);

    // One never sent may be in Xero already (2026-11-11): made there by Zapier, or by hand, before the console sent
    // Jobber's invoices. Found by its number, it is linked as it is there -- draft or not -- never made twice.
    outgoing = await this.alreadyInXero(organizationId, tenantId, outgoing, result);

    for (let start = 0; start < outgoing.length; start += BATCH) {
      const batch = outgoing.slice(start, start + BATCH);
      const body = { Invoices: batch.map((entry) => entry.body) };
      const path = '/Invoices?summarizeErrors=false';
      let answers: XeroAnswer[];
      try {
        answers = (await this.client.post(organizationId, tenantId, path, body, invoicesSchema, keyOf(`${organizationId}:${tenantId}`, path, body))).Invoices;
      } catch (error) {
        if (error instanceof XeroError && error.code === 'XERO_VALIDATION') {
          // The whole call refused: each of its invoices keeps the reason and is tried again later.
          for (const entry of batch) await this.failed(organizationId, tenantId, entry.item, error.message, true);
          result.failed += batch.length;
          continue;
        }
        throw error;
      }
      for (const [index, entry] of batch.entries()) {
        const answer = answers[index];
        if (!answer || refused(answer) || !answer.InvoiceID) {
          await this.failed(organizationId, tenantId, entry.item, answer ? said(answer) : 'Xero did not answer for it.', true);
          result.failed++;
          continue;
        }
        await this.sent(organizationId, tenantId, entry.item, answer.InvoiceID);
        if (entry.item.invoice.number) sentNumbers.push(entry.item.invoice.number);
        result.sent++;
      }
    }
  }

  /**
   * The console's own invoices (2026-11-12, PR 4 of the plan to make invoices
   * in the console with Xero as the record): each made in Xero once, as a
   * complete draft Xero numbers, by PUT -- which only ever creates. Each is
   * written down as PENDING before the call. One tried before -- its answer
   * lost, or refused -- is first looked for in Xero among its contact's
   * invoices that day, by the link back to its page, and linked when found:
   * never made twice. Past the run's lookups, it waits for the next run.
   */
  private async sendDrafts(
    organizationId: string,
    tenantId: string,
    outgoing: { item: { invoice: Candidate; sync: SyncRow | null; fingerprint: string }; body: XeroInvoiceBody }[],
    result: XeroRunResult,
    sentNumbers: string[],
  ) {
    if (!outgoing.length) return;
    const fresh: typeof outgoing = [];
    let lookups = 0;
    for (const entry of outgoing) {
      if (!entry.item.sync) {
        fresh.push(entry);
        continue;
      }
      if (lookups >= MAX_DRAFT_LOOKUPS_PER_RUN) continue;
      lookups++;
      const where = encodeURIComponent(`Date==${xeroDateTime(entry.body.Date)}`);
      const path = `/Invoices?ContactIDs=${encodeURIComponent(entry.body.Contact.ContactID)}&where=${where}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED`;
      const theirs = (await this.client.get(organizationId, tenantId, path, draftsSchema)).Invoices.find((invoice) => invoice.Url === entry.body.Url);
      if (theirs) {
        // Made already, its answer lost: linked as it is there.
        await this.draftSent(organizationId, tenantId, entry.item, theirs.InvoiceID, theirs.InvoiceNumber ?? null);
        result.linked++;
        continue;
      }
      fresh.push(entry);
    }

    const scope = `${organizationId}:${tenantId}`;
    for (let start = 0; start < fresh.length; start += BATCH) {
      const batch = fresh.slice(start, start + BATCH);
      // Written down first: a run that stops before Xero answers leaves them PENDING, looked for next time.
      for (const entry of batch) await this.pending(organizationId, tenantId, entry.item);
      const body = { Invoices: batch.map((entry) => entry.body) };
      const path = '/Invoices?summarizeErrors=false';
      let answers: XeroAnswer[];
      try {
        answers = (await this.client.put(organizationId, tenantId, path, body, invoicesSchema, keyOf(scope, `PUT ${path}`, body))).Invoices;
      } catch (error) {
        if (error instanceof XeroError && error.code === 'XERO_VALIDATION') {
          for (const entry of batch) await this.failed(organizationId, tenantId, entry.item, error.message, true);
          result.failed += batch.length;
          continue;
        }
        throw error;
      }
      for (const [index, entry] of batch.entries()) {
        const answer = answers[index] as (XeroAnswer & { InvoiceNumber?: string | null }) | undefined;
        if (!answer || refused(answer) || !answer.InvoiceID) {
          await this.failed(organizationId, tenantId, entry.item, answer ? said(answer) : 'Xero did not answer for it.', true);
          result.failed++;
          continue;
        }
        await this.draftSent(organizationId, tenantId, entry.item, answer.InvoiceID, answer.InvoiceNumber ?? null);
        if (answer.InvoiceNumber) sentNumbers.push(answer.InvoiceNumber);
        result.sent++;
      }
    }
  }

  /** About to be sent (2026-11-12): written down before the call, so a lost answer is looked for, not sent again. */
  private pending(organizationId: string, tenantId: string, item: { invoice: Candidate; sync: SyncRow | null }) {
    const data = {
      xeroTenantId: tenantId,
      xeroInvoiceId: null,
      status: 'PENDING',
      seenUpdatedAt: item.invoice.updatedAt,
      attempts: (item.sync?.attempts ?? 0) + 1,
      lastAttemptAt: new Date(),
      nextAttemptAt: null,
      problem: null,
    };
    return this.prisma.xeroInvoiceSync.upsert({
      where: { invoiceId: item.invoice.id },
      create: { organizationId, invoiceId: item.invoice.id, ...data },
      update: data,
    });
  }

  /**
   * In Xero (2026-11-12): the console's own takes Xero's number and id with the
   * record of its send, in one write. From then on it is Xero's, read back
   * from there.
   */
  private draftSent(
    organizationId: string,
    tenantId: string,
    item: { invoice: Candidate; fingerprint: string },
    xeroInvoiceId: string,
    number: string | null,
  ) {
    const now = new Date();
    const data = {
      xeroTenantId: tenantId,
      xeroInvoiceId,
      status: 'SENT',
      sentFingerprint: item.fingerprint,
      seenUpdatedAt: item.invoice.updatedAt,
      attempts: 0,
      lastAttemptAt: now,
      nextAttemptAt: null,
      problem: null,
      sentAt: now,
      changedHereAt: null,
    };
    return this.prisma.$transaction([
      this.prisma.invoice.update({ where: { id: item.invoice.id }, data: { xeroInvoiceId, xeroStatus: 'DRAFT', ...(number ? { number } : {}) } }),
      this.prisma.xeroInvoiceSync.upsert({
        where: { invoiceId: item.invoice.id },
        create: { organizationId, invoiceId: item.invoice.id, ...data },
        update: data,
      }),
    ]);
  }

  /**
   * The invoices about to be made in Xero that it has already, by number, 50
   * numbers a call (2026-11-11). One there, draft, approved or paid, is linked
   * as it is and never sent over (2026-11-12): the office may have put it on
   * its project already. Another contact's invoice under the number, or two
   * under it, holds this one back with the reason.
   */
  private async alreadyInXero<T extends { item: { invoice: Candidate; sync: SyncRow | null; fingerprint: string }; body: XeroInvoiceBody }>(
    organizationId: string,
    tenantId: string,
    outgoing: T[],
    result: XeroRunResult,
  ): Promise<T[]> {
    // Xero takes the numbers comma-separated: one with a comma in it cannot be asked about, and is made as before.
    const fresh = outgoing.filter((entry) => entry.item.invoice.number && !entry.item.invoice.number.includes(','));
    if (!fresh.length) return outgoing;
    const held = new Set<string>();
    for (let start = 0; start < fresh.length; start += BATCH) {
      const batch = fresh.slice(start, start + BATCH);
      const numbers = batch.map((entry) => entry.item.invoice.number!);
      const path = `/Invoices?InvoiceNumbers=${encodeURIComponent(numbers.join(','))}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID&summaryOnly=true`;
      const found = (await this.client.get(organizationId, tenantId, path, numberedSchema)).Invoices.filter((theirs) => theirs.Type !== 'ACCPAY');
      for (const entry of batch) {
        const same = found.filter((theirs) => theirs.InvoiceNumber?.trim().toLowerCase() === entry.item.invoice.number!.trim().toLowerCase());
        if (!same.length) continue;
        const ours = contactNameOf(entry.item.invoice).toLowerCase();
        const theirs = same[0]!;
        if (same.length > 1 || (theirs.Contact?.Name?.trim().toLowerCase() ?? ours) !== ours) {
          const problem =
            same.length > 1
              ? `Xero has ${same.length} invoices numbered ${entry.item.invoice.number}: void the extra one there.`
              : `Xero has invoice ${entry.item.invoice.number} for “${theirs.Contact?.Name?.trim()}”, not this client: renumber one of them.`;
          await this.failed(organizationId, tenantId, entry.item, problem, false);
          result.failed++;
          held.add(entry.item.invoice.id);
          continue;
        }
        await this.sent(organizationId, tenantId, entry.item, theirs.InvoiceID);
        result.linked++;
        held.add(entry.item.invoice.id);
      }
    }
    return outgoing.filter((entry) => !held.has(entry.item.invoice.id));
  }

  /** The Xero contact for each invoice's client: linked already, made now, or found by its name (`xeroContacts`). */
  private contacts(organizationId: string, tenantId: string, invoices: Candidate[]) {
    const byKey = new Map<string, string>();
    for (const invoice of invoices) byKey.set(clientKeyOf(invoice), contactNameOf(invoice));
    return xeroContacts(this.prisma, this.client, organizationId, tenantId, byKey);
  }

  private sent(organizationId: string, tenantId: string, item: { invoice: Candidate; fingerprint: string }, xeroInvoiceId: string) {
    const now = new Date();
    const data = {
      xeroTenantId: tenantId,
      xeroInvoiceId,
      status: 'SENT',
      sentFingerprint: item.fingerprint,
      seenUpdatedAt: item.invoice.updatedAt,
      attempts: 0,
      lastAttemptAt: now,
      nextAttemptAt: null,
      problem: null,
      sentAt: now,
      changedHereAt: null,
    };
    return this.prisma.xeroInvoiceSync.upsert({
      where: { invoiceId: item.invoice.id },
      create: { organizationId, invoiceId: item.invoice.id, ...data },
      update: data,
    });
  }

  /**
   * One in Xero already, looked at again (2026-11-12): nothing is sent. It is
   * the office's there -- a refusal from before, when changes went, no longer
   * stands -- and it is marked when what it says here is not what went, or
   * unmarked once it says that again.
   */
  private seen(invoice: Candidate, sync: SyncRow, fingerprint: string) {
    const changed = sync.sentFingerprint !== fingerprint;
    return this.prisma.xeroInvoiceSync.update({
      where: { invoiceId: invoice.id },
      data: {
        status: 'SENT',
        seenUpdatedAt: invoice.updatedAt,
        attempts: 0,
        nextAttemptAt: null,
        problem: null,
        changedHereAt: changed ? (sync.changedHereAt ?? new Date()) : null,
      },
    });
  }

  /** Deletes a payment in Xero: true once it is gone (or was already), else Xero's reason. */
  private async deletePayment(organizationId: string, tenantId: string, xeroPaymentId: string): Promise<true | string> {
    const path = `/Payments/${encodeURIComponent(xeroPaymentId)}`;
    const body = { Status: 'DELETED' };
    try {
      const [answer] = (await this.client.post(organizationId, tenantId, path, body, paymentsSchema, keyOf(`${organizationId}:${tenantId}`, path, body))).Payments;
      return answer && refused(answer) ? said(answer) : true;
    } catch (error) {
      if (error instanceof XeroError && error.providerStatus === 404) return true;
      if (error instanceof XeroError && error.code === 'XERO_VALIDATION') return /already been deleted|has been deleted/i.test(error.message) ? true : error.message;
      throw error;
    }
  }

  /** The payments removed here (2026-11-10, phase 4): deleted in Xero too, one call each, and their rows with them. */
  private async removePayments(organizationId: string, tenantId: string, result: XeroRunResult, budget: DeleteBudget) {
    const now = new Date();
    const removed = await this.prisma.xeroPaymentSync.findMany({
      where: { organizationId, xeroTenantId: tenantId, paymentId: null, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: [{ updatedAt: 'asc' }],
      take: MAX_PAYMENT_DELETES_PER_RUN,
      select: { id: true, xeroPaymentId: true, attempts: true },
    });
    for (const row of removed) {
      if (row.xeroPaymentId) {
        if (budget.left <= 0) break;
        budget.left--;
        const gone = await this.deletePayment(organizationId, tenantId, row.xeroPaymentId);
        if (gone !== true) {
          const attempts = row.attempts + 1;
          await this.prisma.xeroPaymentSync.update({
            where: { id: row.id },
            data: {
              status: 'FAILED',
              attempts,
              lastAttemptAt: now,
              nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!),
              problem: `Removed here, but Xero would not delete it: ${gone}`.slice(0, 1000),
            },
          });
          result.payments.failed++;
          continue;
        }
        result.payments.removed++;
      }
      await this.prisma.xeroPaymentSync.delete({ where: { id: row.id } });
    }
  }

  /**
   * The payments against this organisation's invoices (2026-11-10, phase 4 of
   * the multi-company plan) that are new, changed or due a retry: sent, 50 a
   * call, each against its invoice as Xero has it, into the account chosen for
   * how it was paid. A changed one is deleted in Xero first, since Xero never
   * edits a payment. Nothing calls Xero when nothing changed.
   */
  private async sendPayments(organizationId: string, tenantId: string, accounts: XeroAccount[], result: XeroRunResult, budget: DeleteBudget) {
    const now = new Date();
    const ids = await this.paymentCandidates(organizationId, tenantId);
    if (!ids.length) return;
    const payments = await this.prisma.invoicePayment.findMany({ where: { organizationId, id: { in: ids } }, select: PAYMENT_FIELDS });
    const values = (await this.settings.read(organizationId, tenantId)).values;

    const outgoing: { payment: PaymentCandidate; sync: PaymentSyncRow | null; fingerprint: string; body: XeroPaymentBody }[] = [];
    for (const payment of payments) {
      const sync = payment.xeroSync;
      const fingerprint = paymentFingerprint(payment as PaymentForXero);
      if (sync?.status === 'SENT' && sync.sentFingerprint === fingerprint) {
        await this.prisma.xeroPaymentSync.update({ where: { id: sync.id }, data: { seenUpdatedAt: payment.updatedAt } });
        continue;
      }
      const xeroInvoiceId = payment.invoice.xeroSync?.xeroInvoiceId;
      if (!xeroInvoiceId) continue;
      const plan = xeroPaymentFrom(payment as PaymentForXero, { settings: values, accounts, xeroInvoiceId });
      if (plan.kind === 'problem') {
        // Held back by the console: tried again when the payment, or the choices, change -- not on a timer.
        await this.paymentFailed(organizationId, tenantId, { payment, sync }, plan.problem, false);
        result.payments.failed++;
        continue;
      }
      // Changed since it was sent: Xero never edits a payment, so the old one is deleted first.
      if (sync?.xeroPaymentId) {
        if (budget.left <= 0) continue;
        budget.left--;
        const gone = await this.deletePayment(organizationId, tenantId, sync.xeroPaymentId);
        if (gone !== true) {
          await this.paymentFailed(organizationId, tenantId, { payment, sync }, `It changed here, but Xero would not delete the old one: ${gone}`, true);
          result.payments.failed++;
          continue;
        }
        // Until it is sent again, nothing of it is in Xero.
        await this.prisma.xeroPaymentSync.update({
          where: { id: sync.id },
          data: { status: 'FAILED', xeroPaymentId: null, sentFingerprint: null, nextAttemptAt: now, problem: 'Deleted in Xero to be sent again as it is now.' },
        });
      }
      outgoing.push({ payment, sync: sync ? { ...sync, xeroPaymentId: null } : null, fingerprint, body: plan.body });
    }

    for (let start = 0; start < outgoing.length; start += BATCH) {
      const batch = outgoing.slice(start, start + BATCH);
      const body = { Payments: batch.map((entry) => entry.body) };
      const path = '/Payments?summarizeErrors=false';
      let answers: XeroAnswer[];
      try {
        answers = (await this.client.post(organizationId, tenantId, path, body, paymentsSchema, keyOf(`${organizationId}:${tenantId}`, path, body))).Payments;
      } catch (error) {
        if (error instanceof XeroError && error.code === 'XERO_VALIDATION') {
          for (const entry of batch) await this.paymentFailed(organizationId, tenantId, entry, error.message, true);
          result.payments.failed += batch.length;
          continue;
        }
        throw error;
      }
      for (const [index, entry] of batch.entries()) {
        const answer = answers[index];
        if (!answer || refused(answer) || !answer.PaymentID) {
          await this.paymentFailed(organizationId, tenantId, entry, answer ? said(answer) : 'Xero did not answer for it.', true);
          result.payments.failed++;
          continue;
        }
        await this.paymentSent(organizationId, tenantId, entry, answer.PaymentID);
        result.payments.sent++;
      }
    }
  }

  /**
   * Bad debts (2026-11-10): each invoice of this organisation's closed as bad
   * debt here, once it is in Xero, is written off there -- a credit note for
   * what it still owed, to the bad-debt account, allocated to the invoice. The
   * credit note is kept as soon as Xero makes it, so an allocation Xero refused
   * is tried again without a second one. At most 20 a run.
   */
  private async writeOffs(organizationId: string, tenantId: string, accounts: XeroAccount[], result: XeroRunResult) {
    const now = new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        xeroTenantId: tenantId,
        // The console's own write-offs only: one read from Xero is Xero's already (2026-11-12).
        origin: { not: InvoiceOrigin.XERO },
        status: InvoiceStatus.BAD_DEBT,
        balanceCents: { gt: 0 },
        xeroSync: { is: { xeroTenantId: tenantId, status: 'SENT', xeroInvoiceId: { not: null } } },
        OR: [{ xeroWriteOff: { is: null } }, { xeroWriteOff: { is: { status: 'FAILED', nextAttemptAt: { lte: now } } } }],
      },
      orderBy: [{ updatedAt: 'asc' }],
      take: MAX_WRITE_OFFS_PER_RUN,
      select: {
        id: true,
        number: true,
        clientName: true,
        jobberClientId: true,
        balanceCents: true,
        updatedAt: true,
        xeroSync: { select: { xeroInvoiceId: true } },
        xeroWriteOff: { select: { xeroCreditNoteId: true, attempts: true } },
      },
    });
    if (!invoices.length) return;
    const values = (await this.settings.read(organizationId, tenantId)).values;
    const links = await this.prisma.xeroContactLink.findMany({
      where: { organizationId, xeroTenantId: tenantId, clientKey: { in: invoices.map((invoice) => clientKeyOf(invoice)) } },
      select: { clientKey: true, xeroContactId: true },
    });
    const scope = `${organizationId}:${tenantId}`;
    for (const invoice of invoices) {
      const attempts = invoice.xeroWriteOff?.attempts ?? 0;
      let creditNoteId = invoice.xeroWriteOff?.xeroCreditNoteId ?? null;
      const failed = (problem: string, retry: boolean) => {
        result.writeOffs.failed++;
        return this.writeOffFailed(organizationId, tenantId, invoice, { creditNoteId, attempts }, problem, retry);
      };
      const contactId = links.find((link) => link.clientKey === clientKeyOf(invoice))?.xeroContactId;
      if (!contactId) {
        await failed('Its client is not a contact in Xero yet.', true);
        continue;
      }
      const plan = xeroWriteOffFrom(invoice, {
        settings: values,
        accounts,
        contactId,
        xeroInvoiceId: invoice.xeroSync!.xeroInvoiceId!,
        // Locked once closed as bad debt: its last change is the day it was closed.
        day: businessDate(invoice.updatedAt),
      });
      if (plan.kind === 'problem') {
        // Held back by the console: looked at again once the choices are saved, not on a timer.
        await failed(plan.problem, false);
        continue;
      }
      try {
        if (!creditNoteId) {
          const path = '/CreditNotes?summarizeErrors=false';
          const body = { CreditNotes: [plan.creditNote] };
          const [answer] = (await this.client.post(organizationId, tenantId, path, body, creditNotesSchema, keyOf(scope, path, body))).CreditNotes;
          if (!answer?.CreditNoteID || refused(answer)) {
            await failed(answer ? said(answer) : 'Xero did not answer for it.', true);
            continue;
          }
          creditNoteId = answer.CreditNoteID;
          // Kept at once: an allocation refused below is tried again on this credit note, never a second one.
          await this.prisma.xeroWriteOffSync.upsert({
            where: { invoiceId: invoice.id },
            create: { organizationId, invoiceId: invoice.id, xeroTenantId: tenantId, xeroCreditNoteId: creditNoteId, amountCents: invoice.balanceCents, status: 'FAILED', nextAttemptAt: now, problem: 'Not allocated to the invoice yet.' },
            update: { xeroCreditNoteId: creditNoteId, amountCents: invoice.balanceCents, status: 'FAILED', nextAttemptAt: now, problem: 'Not allocated to the invoice yet.' },
          });
        }
        const path = `/CreditNotes/${encodeURIComponent(creditNoteId)}/Allocations`;
        const body = { Allocations: [plan.allocation] };
        const [allocation] = (await this.client.put(organizationId, tenantId, path, body, allocationsSchema, keyOf(scope, path, body))).Allocations ?? [];
        if (allocation && refused(allocation)) {
          await failed(said(allocation), true);
          continue;
        }
        const sentAt = new Date();
        const data = {
          xeroTenantId: tenantId,
          xeroCreditNoteId: creditNoteId,
          xeroAllocationId: allocation?.AllocationID ?? null,
          amountCents: invoice.balanceCents,
          status: 'SENT',
          attempts: 0,
          lastAttemptAt: sentAt,
          nextAttemptAt: null,
          problem: null,
          sentAt,
        };
        await this.prisma.xeroWriteOffSync.upsert({ where: { invoiceId: invoice.id }, create: { organizationId, invoiceId: invoice.id, ...data }, update: data });
        result.writeOffs.sent++;
      } catch (error) {
        if (!(error instanceof XeroError) || error.code !== 'XERO_VALIDATION') throw error;
        await failed(error.message, true);
      }
    }
  }

  /**
   * Write-offs of invoices reopened here (2026-11-10): the credit note's
   * allocation comes off the invoice, the credit note is voided, and the row
   * goes -- so the invoice is owed again in Xero, as it is here. A write-off
   * that never reached Xero is only forgotten. At most 20 a run.
   */
  private async reverseWriteOffs(organizationId: string, tenantId: string, result: XeroRunResult) {
    const now = new Date();
    const rows = await this.prisma.xeroWriteOffSync.findMany({
      where: {
        organizationId,
        xeroTenantId: tenantId,
        invoice: { status: { not: InvoiceStatus.BAD_DEBT } },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: [{ updatedAt: 'asc' }],
      take: MAX_WRITE_OFFS_PER_RUN,
      select: { id: true, xeroCreditNoteId: true, xeroAllocationId: true, attempts: true },
    });
    const scope = `${organizationId}:${tenantId}`;
    for (const row of rows) {
      const creditNoteId = row.xeroCreditNoteId;
      if (creditNoteId) {
        try {
          // Its allocation, as kept; or, when Xero did not say it, as Xero has it.
          const allocations = row.xeroAllocationId ? [row.xeroAllocationId] : await this.allocationsOf(organizationId, tenantId, creditNoteId);
          for (const allocationId of allocations) {
            try {
              await this.client.delete(organizationId, tenantId, `/CreditNotes/${encodeURIComponent(creditNoteId)}/Allocations/${encodeURIComponent(allocationId)}`, allocationsSchema);
            } catch (error) {
              // Already off.
              if (!(error instanceof XeroError) || error.providerStatus !== 404) throw error;
            }
          }
          if (row.xeroAllocationId) await this.prisma.xeroWriteOffSync.update({ where: { id: row.id }, data: { xeroAllocationId: null } });
          const path = '/CreditNotes?summarizeErrors=false';
          const body = { CreditNotes: [{ CreditNoteID: creditNoteId, Status: 'VOIDED' }] };
          const [answer] = (await this.client.post(organizationId, tenantId, path, body, creditNotesSchema, keyOf(scope, path, body))).CreditNotes;
          if (answer && refused(answer)) throw new XeroError(`Xero refused it: ${said(answer)}`, 'XERO_VALIDATION', 422, 400);
          result.writeOffs.reversed++;
        } catch (error) {
          if (!(error instanceof XeroError) || (error.code !== 'XERO_VALIDATION' && error.providerStatus !== 404)) throw error;
          const attempts = row.attempts + 1;
          await this.prisma.xeroWriteOffSync.update({
            where: { id: row.id },
            data: {
              status: 'FAILED',
              attempts,
              lastAttemptAt: now,
              nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!),
              problem: `Reopened here, but Xero would not take the write-off back: ${error.message}`.slice(0, 1000),
            },
          });
          result.writeOffs.failed++;
          continue;
        }
      }
      await this.prisma.xeroWriteOffSync.delete({ where: { id: row.id } });
    }
  }

  /** A credit note's allocations, as Xero has them: one call. */
  private async allocationsOf(organizationId: string, tenantId: string, creditNoteId: string): Promise<string[]> {
    const { CreditNotes } = await this.client.get(organizationId, tenantId, `/CreditNotes/${encodeURIComponent(creditNoteId)}`, creditNotesSchema);
    return (CreditNotes[0]?.Allocations ?? []).map((allocation) => allocation.AllocationID).filter((id): id is string => Boolean(id));
  }

  /** Kept with the reason, and the credit note if Xero made one. `retry`: Xero's refusal, tried again later; otherwise the console's. */
  private writeOffFailed(
    organizationId: string,
    tenantId: string,
    invoice: { id: string; balanceCents: number },
    known: { creditNoteId: string | null; attempts: number },
    problem: string,
    retry: boolean,
  ) {
    const now = new Date();
    const attempts = known.attempts + 1;
    const data = {
      xeroTenantId: tenantId,
      xeroCreditNoteId: known.creditNoteId,
      amountCents: invoice.balanceCents,
      status: 'FAILED',
      attempts,
      lastAttemptAt: now,
      nextAttemptAt: retry ? new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!) : null,
      problem: problem.slice(0, 1000),
    };
    return this.prisma.xeroWriteOffSync.upsert({ where: { invoiceId: invoice.id }, create: { organizationId, invoiceId: invoice.id, ...data }, update: data });
  }

  /**
   * The payments worth looking at: against this organisation's invoices that
   * are in its books as they are now (sent, not voided), and either never
   * sent, changed since last seen, or due a retry. Oldest first, at most 200.
   */
  private async paymentCandidates(organizationId: string, tenantId: string): Promise<string[]> {
    const [, rows] = await this.prisma.$transaction([
      // Raw SQL does not pass through the client's tenant scope: set it here, as it does.
      this.prisma.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p."id"
          FROM "InvoicePayment" p
          JOIN "Invoice" i ON i."id" = p."invoiceId"
          JOIN "XeroInvoiceSync" s ON s."invoiceId" = i."id"
          LEFT JOIN "XeroPaymentSync" ps ON ps."paymentId" = p."id"
         WHERE p."organizationId" = ${organizationId}::uuid
           AND i."xeroTenantId" = ${tenantId}
           AND i."status" <> 'VOIDED'
           -- Never a payment read from Xero, nor one Xero has been found to have (2026-11-12): it is there already.
           AND i."origin" <> 'XERO'
           AND p."origin" <> 'XERO'
           AND p."xeroPaymentId" IS NULL
           AND s."xeroTenantId" = ${tenantId}
           AND s."status" = 'SENT'
           AND s."xeroInvoiceId" IS NOT NULL
           AND (
                ps."id" IS NULL
             OR ps."seenUpdatedAt" IS NULL
             OR p."updatedAt" > ps."seenUpdatedAt"
             OR (ps."status" = 'FAILED' AND ps."nextAttemptAt" <= now())
           )
         ORDER BY p."paidOn", p."id"
         LIMIT ${MAX_PAYMENTS_PER_RUN}`,
    ]);
    return (rows as { id: string }[]).map((row) => row.id);
  }

  private paymentSent(organizationId: string, tenantId: string, entry: { payment: PaymentCandidate; fingerprint: string }, xeroPaymentId: string) {
    const now = new Date();
    const data = {
      invoiceId: entry.payment.invoice.id,
      xeroTenantId: tenantId,
      xeroPaymentId,
      status: 'SENT',
      sentFingerprint: entry.fingerprint,
      seenUpdatedAt: entry.payment.updatedAt,
      attempts: 0,
      lastAttemptAt: now,
      nextAttemptAt: null,
      problem: null,
      sentAt: now,
    };
    return this.prisma.xeroPaymentSync.upsert({
      where: { paymentId: entry.payment.id },
      create: { organizationId, paymentId: entry.payment.id, ...data },
      update: data,
    });
  }

  /** Kept with the reason. `retry`: Xero's refusal, tried again later; otherwise the console's, tried when it changes. */
  private paymentFailed(
    organizationId: string,
    tenantId: string,
    entry: { payment: PaymentCandidate; sync: PaymentSyncRow | null },
    problem: string,
    retry: boolean,
  ) {
    const now = new Date();
    const attempts = (entry.sync?.attempts ?? 0) + 1;
    const data = {
      invoiceId: entry.payment.invoice.id,
      xeroTenantId: tenantId,
      // What Xero has, if anything, stays known, so it can be deleted.
      xeroPaymentId: entry.sync?.xeroPaymentId ?? null,
      sentFingerprint: entry.sync?.sentFingerprint ?? null,
      status: 'FAILED',
      seenUpdatedAt: entry.payment.updatedAt,
      attempts,
      lastAttemptAt: now,
      nextAttemptAt: retry ? new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!) : null,
      problem: problem.slice(0, 1000),
    };
    return this.prisma.xeroPaymentSync.upsert({
      where: { paymentId: entry.payment.id },
      create: { organizationId, paymentId: entry.payment.id, ...data },
      update: data,
    });
  }

  /** Kept with the reason. `retry`: Xero's refusal, tried again later; otherwise the console's, tried when it changes. */
  private failed(organizationId: string, tenantId: string, item: { invoice: Candidate; sync: SyncRow | null }, problem: string, retry: boolean) {
    const now = new Date();
    const attempts = (item.sync?.attempts ?? 0) + 1;
    const data = {
      xeroTenantId: tenantId,
      // Only one not in this organisation's Xero is ever refused (2026-11-12): one there is never sent again.
      xeroInvoiceId: null,
      sentFingerprint: null,
      status: 'FAILED',
      seenUpdatedAt: item.invoice.updatedAt,
      attempts,
      lastAttemptAt: now,
      nextAttemptAt: retry ? new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!) : null,
      problem: problem.slice(0, 1000),
    };
    return this.prisma.xeroInvoiceSync.upsert({
      where: { invoiceId: item.invoice.id },
      create: { organizationId, invoiceId: item.invoice.id, ...data },
      update: data,
    });
  }

  /**
   * The invoices worth looking at: this organisation's (2026-11-10), issued
   * from the start date, not drafts, and either never sent to it, changed since
   * last seen, or due a retry. A voided one is looked at only once it has a
   * row -- one that never reached Xero is not sent to be voided. Oldest first,
   * at most 200.
   */
  private async candidates(organizationId: string, tenantId: string, sendFrom: string, jobberSends = true): Promise<string[]> {
    const [, rows] = await this.prisma.$transaction([
      // Raw SQL does not pass through the client's tenant scope: set it here, as it does.
      this.prisma.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT i."id"
          FROM "Invoice" i
          LEFT JOIN "XeroInvoiceSync" s ON s."invoiceId" = i."id"
         WHERE i."organizationId" = ${organizationId}::uuid
           AND i."xeroTenantId" = ${tenantId}
           AND i."issuedOn" >= ${sendFrom}::date
           -- Never one read from its books, nor one of the console's read back from there (2026-11-12): Xero has it.
           AND i."origin" <> 'XERO'
           AND i."xeroInvoiceId" IS NULL
           AND (
                -- The console's own (2026-11-12): drafts too -- Xero numbers them -- and one whose send is pending.
                (i."origin" = 'CONSOLE' AND i."status" <> 'VOIDED' AND (
                     s."id" IS NULL
                  OR s."xeroTenantId" <> ${tenantId}
                  OR s."status" = 'PENDING'
                  OR s."seenUpdatedAt" IS NULL
                  OR i."updatedAt" > s."seenUpdatedAt"
                  OR (s."status" = 'FAILED' AND s."nextAttemptAt" <= now())
                ))
                -- Jobber's, as before, until the console makes the invoices.
             OR (i."origin" = 'JOBBER' AND ${jobberSends} AND i."status" <> 'DRAFT' AND (
                     (s."id" IS NULL AND i."status" <> 'VOIDED')
                  OR (s."xeroTenantId" <> ${tenantId} AND i."status" <> 'VOIDED')
                  OR (s."xeroTenantId" = ${tenantId} AND (s."seenUpdatedAt" IS NULL OR i."updatedAt" > s."seenUpdatedAt"))
                  OR (s."xeroTenantId" = ${tenantId} AND s."status" = 'FAILED' AND s."nextAttemptAt" <= now())
                ))
           )
         ORDER BY i."issuedOn", i."id"
         LIMIT ${MAX_INVOICES_PER_RUN}`,
    ]);
    return (rows as { id: string }[]).map((row) => row.id);
  }

  /** Everything a run and the page need: the organisation's switch and choices, and the sign-in. No call to Xero. */
  private async state(organizationId: string, tenantId: string) {
    const [row, connection, organisation, settings, switchedAt] = await Promise.all([
      this.prisma.xeroSettings.findUnique({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        select: { sendingEnabled: true, sendingChangedAt: true, lastRunAt: true, lastRunProblem: true, sendFrom: true, booksReadAt: true },
      }),
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, scopes: true } }),
      this.prisma.xeroOrganisation.findUnique({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        select: { name: true, status: true, invoiceRemindersOn: true, accounts: true, trackingCategories: true, items: true, taxRates: true, organisation: true },
      }),
      this.settings.read(organizationId, tenantId),
      // The console makes the invoices (2026-11-12): Jobber's are sent no more.
      invoicingTakenOverAt(this.prisma, organizationId),
    ]);
    const connected = connection?.status === 'CONNECTED' && organisation?.status === 'CONNECTED';
    const scopes = connected ? (connection?.scopes ?? []) : [];
    // A project for each visit (2026-11-11): invoices then go as drafts, and payments stay out -- Xero takes none on a draft.
    const projectsEnabled = projectsAreOn(settings.values);
    // Its books read back from Xero (2026-11-12): payments and bad debts are recorded there, its reminders are Xero's.
    const booksRead = Boolean(row?.booksReadAt);
    return {
      row,
      name: organisation?.name ?? null,
      tenantId: connected ? tenantId : null,
      sendFrom: row?.sendFrom ? row.sendFrom.toISOString().slice(0, 10) : null,
      accounts: connected ? ((organisation?.accounts as XeroAccount[] | null) ?? []) : [],
      catalog: {
        accounts: connected ? ((organisation?.accounts as XeroAccount[] | null) ?? []) : [],
        trackingCategories: connected ? ((organisation?.trackingCategories as XeroTrackingCategory[] | null) ?? []) : [],
        items: connected ? ((organisation?.items as XeroItem[] | null) ?? []) : [],
        taxRates: connected ? ((organisation?.taxRates as XeroTaxRate[] | null) ?? []) : [],
      } satisfies Catalog,
      paymentsToXero: paymentsGoToXero(settings.values) && !projectsEnabled && !booksRead,
      booksRead,
      jobberSends: !switchedAt,
      projectsEnabled,
      values: settings.values,
      /** The labour's currency: the company's own, as Xero said it. */
      currency: (organisation?.organisation as XeroOrganisation | null)?.baseCurrency || 'USD',
      canWrite: xeroCanWrite(scopes),
      blockers: xeroSendingBlockers({
        connected,
        scopes,
        settingsReady: settings.ready,
        // The console sends no follow-ups for a company whose books it reads: Xero's reminders may be on.
        invoiceRemindersOn: connected && !booksRead ? (organisation?.invoiceRemindersOn ?? null) : null,
        projectsEnabled,
      }),
    };
  }
}

/** The console's own invoice's page (2026-11-12): the link Xero keeps on its draft, which also finds it there again. */
export const consoleInvoiceUrl = (invoiceId: string) => `${(process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '')}/invoices/${invoiceId}`;
