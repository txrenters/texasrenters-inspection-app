import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { xeroCanWrite, xeroSendingBlockers, type XeroAccount, type XeroSendingView } from '@texasrenters/shared';
import { InvoiceStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { XeroAuthService } from './xero-auth.service';
import { xeroValidationMessages, XeroClient } from './xero.client';
import { XeroError } from './xero.errors';
import { clientKeyOf, contactNameOf, invoiceFingerprint, xeroInvoiceFrom, type InvoiceForXero, type XeroInvoiceBody, type XeroVoidBody } from './xero-invoice';
import { paymentFingerprint, xeroPaymentFrom, type PaymentForXero, type XeroPaymentBody } from './xero-payment';
import { xeroWriteOffFrom } from './xero-write-off';
import { XeroSettingsService } from './xero-settings.service';

/** Xero takes up to 50 of a kind in one call. */
const BATCH = 50;
/** Invoices looked at in one run; the rest wait for the next. Four invoice calls and four contact calls at most. */
export const MAX_INVOICES_PER_RUN = 200;
/** Payments looked at in one run (2026-11-10, phase 4): four calls at most to send them. */
export const MAX_PAYMENTS_PER_RUN = 200;
/** Payments deleted in Xero in one run -- removed or changed here, or taken off an invoice to change it. One call each. */
export const MAX_PAYMENT_DELETES_PER_RUN = 20;
/** Bad debts written off, and write-offs taken back, in one run (2026-11-10): two calls each. */
export const MAX_WRITE_OFFS_PER_RUN = 20;
/** Contacts looked up by name in one run, after Xero said the name was taken. */
const MAX_LOOKUPS_PER_RUN = 20;
/** A run's claim on the office; longer than any run, short enough that a crashed one does not stop sending for long. */
const CLAIM_MS = 15 * 60_000;
/** Between one "Send now" and the next. */
const MANUAL_GAP_MS = 60_000;
/** Xero refused it: tried again after an hour, six, then daily -- and at once when the invoice changes. */
const BACKOFF_MS = [60, 360, 1440].map((minutes) => minutes * 60_000);

const validationErrors = z.array(z.object({ Message: z.string() })).nullish();
const contactsSchema = z.object({
  Contacts: z.array(z.object({ ContactID: z.string().nullish(), Name: z.string().nullish(), StatusAttributeString: z.string().nullish(), ValidationErrors: validationErrors })),
});
const invoicesSchema = z.object({
  Invoices: z.array(z.object({ InvoiceID: z.string().nullish(), StatusAttributeString: z.string().nullish(), ValidationErrors: validationErrors })),
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
type XeroAnswer = {
  ContactID?: string | null;
  InvoiceID?: string | null;
  PaymentID?: string | null;
  StatusAttributeString?: string | null;
  ValidationErrors?: { Message: string }[] | null;
};

const refused = (answer: XeroAnswer) => answer.StatusAttributeString === 'ERROR' || Boolean(answer.ValidationErrors?.length);
const said = (answer: XeroAnswer) => xeroValidationMessages({ ValidationErrors: answer.ValidationErrors ?? [] }) ?? 'Xero refused it without saying why.';
const keyOf = (organizationId: string, path: string, body: unknown) => createHash('sha256').update(`${organizationId}|${path}|${JSON.stringify(body)}`).digest('hex');
/** Xero's `where` filter: a name in double quotes, its own quotes and backslashes escaped. */
const nameFilter = (name: string) => `Name=="${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

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
  lines: { select: { position: true, name: true, description: true, quantity: true, unitPriceCents: true, totalCents: true } },
  xeroSync: true,
} satisfies Prisma.InvoiceSelect;
type Candidate = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_FIELDS }>;
type SyncRow = NonNullable<Candidate['xeroSync']>;

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
  /** Payments (2026-11-10, phase 4): sent, refused or held back, and deleted in Xero after they were removed here. */
  payments: { sent: number; failed: number; removed: number };
  /** Bad debts (2026-11-10): written off, refused or held back, and taken back for invoices reopened here. */
  writeOffs: { sent: number; failed: number; reversed: number };
  problem: string | null;
}

/** What one run may still delete in Xero. */
interface DeleteBudget {
  left: number;
}

/**
 * Sends the office's invoices to Xero (2026-11-10, phase 3 of the Xero plan).
 *
 * Only while it is turned on, only invoices issued from the start date, and
 * only the ones that changed: an invoice is looked at again when its row moved
 * since it was last seen, and sent again only when what it says changed (its
 * fingerprint). Nothing calls Xero when nothing changed. Contacts and invoices
 * go up to 50 a call, with an idempotency key, under the console's daily
 * ceiling. Approved, never emailed by Xero. A refusal is kept with Xero's
 * reason and tried again later; an invoice the console will not send as it is
 * (its lines do not come to its total, it carries sales tax) is held with the
 * reason until it changes.
 */
@Injectable()
export class XeroSenderService {
  private readonly logger = new Logger(XeroSenderService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroClient) private readonly client: XeroClient,
    @Inject(XeroAuthService) private readonly auth: XeroAuthService,
    @Inject(XeroSettingsService) private readonly settings: XeroSettingsService,
  ) {}

  async view(organizationId: string, tenantId: string): Promise<XeroSendingView> {
    const state = await this.state(organizationId, tenantId);
    const tenant = state.tenantId;
    const [sent, failed, notYet, noCompany, failures, paymentsSent, paymentsFailed, paymentFailures, writeOffsSent, writeOffsFailed, writeOffFailures] = await Promise.all([
      tenant ? this.prisma.xeroInvoiceSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'SENT' } }) : 0,
      tenant ? this.prisma.xeroInvoiceSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'FAILED' } }) : 0,
      tenant && state.sendFrom
        ? this.prisma.invoice.count({
            where: {
              organizationId,
              // Only this organisation's invoices (2026-11-10): each company's go to its own books.
              xeroTenantId: tenant,
              issuedOn: { gte: new Date(`${state.sendFrom}T00:00:00.000Z`) },
              status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] },
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
    ]);
    return {
      tenantId,
      enabled: state.row?.sendingEnabled ?? false,
      changedAt: state.row?.sendingChangedAt?.toISOString() ?? null,
      canWrite: state.canWrite,
      blockers: state.blockers,
      counts: {
        sent,
        failed,
        notYet,
        noCompany,
        payments: { sent: paymentsSent, failed: paymentsFailed },
        writeOffs: { sent: writeOffsSent, failed: writeOffsFailed },
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
    };
  }

  /** On only when nothing blocks it; off at any time. Audited both ways. */
  async setEnabled(user: AuthenticatedUser, tenantId: string, enabled: boolean): Promise<XeroSendingView> {
    const organizationId = user.organizationId;
    const state = await this.state(organizationId, tenantId);
    if (enabled && state.blockers.length) throw new XeroError(state.blockers[0]!, 'XERO_SENDING_BLOCKED', 409);
    if (!state.row) throw new XeroError('Choose what goes where in Xero first.', 'XERO_SENDING_BLOCKED', 409);
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
    if (count || payments.count || writeOffs.count)
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: user.id,
          action: 'XERO_SENDING_RETRIED',
          entityType: 'XeroSettings',
          entityId: organizationId,
          metadata: { tenantId, invoices: count, payments: payments.count, writeOffs: writeOffs.count },
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
      payments: { sent: 0, failed: 0, removed: 0 },
      writeOffs: { sent: 0, failed: 0, reversed: 0 },
      problem: null,
    };
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
    if (!claimed.count) return { ...result, problem: 'Another run is sending.' };

    const sentNumbers: string[] = [];
    const budget: DeleteBudget = { left: MAX_PAYMENT_DELETES_PER_RUN };
    try {
      // Payments removed here, and write-offs of invoices reopened here, first: Xero changes and voids no invoice
      // with a payment or a credit on it.
      await this.removePayments(organizationId, state.tenantId, result, budget);
      await this.reverseWriteOffs(organizationId, state.tenantId, result);
      await this.send(organizationId, state.tenantId, state.sendFrom, state.accounts, result, sentNumbers, budget);
      // Then the payments, against the invoices as they now are in Xero; then what was written off as bad debt.
      await this.sendPayments(organizationId, state.tenantId, state.accounts, result, budget);
      await this.writeOffs(organizationId, state.tenantId, state.accounts, result);
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
    const { payments, writeOffs } = result;
    if (result.sent || result.failed || payments.sent || payments.failed || payments.removed || writeOffs.sent || writeOffs.failed || writeOffs.reversed)
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
            numbers: sentNumbers.slice(0, 100),
            payments,
            writeOffs,
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
    accounts: XeroAccount[],
    result: XeroRunResult,
    sentNumbers: string[],
    budget: DeleteBudget,
  ) {
    const ids = await this.candidates(organizationId, tenantId, sendFrom);
    if (!ids.length) return;
    const invoices = await this.prisma.invoice.findMany({ where: { organizationId, id: { in: ids } }, select: INVOICE_FIELDS });
    const values = (await this.settings.read(organizationId, tenantId)).values;

    // Unchanged since it was sent: only noted as seen, no call.
    const due: { invoice: Candidate; sync: SyncRow | null; fingerprint: string }[] = [];
    for (const invoice of invoices) {
      const sync = invoice.xeroSync?.xeroTenantId === tenantId ? invoice.xeroSync : null;
      const fingerprint = invoiceFingerprint(invoice as InvoiceForXero);
      if (sync?.status === 'SENT' && sync.sentFingerprint === fingerprint) {
        await this.prisma.xeroInvoiceSync.update({ where: { invoiceId: invoice.id }, data: { seenUpdatedAt: invoice.updatedAt } });
        result.unchanged++;
        continue;
      }
      // Voided before it ever reached Xero: there is nothing there to void, and its old refusal no longer matters.
      if (invoice.status === InvoiceStatus.VOIDED && !sync?.xeroInvoiceId) {
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
      due.filter((item) => item.invoice.status !== InvoiceStatus.VOIDED).map((item) => item.invoice),
    );

    let outgoing: { item: (typeof due)[number]; body: XeroInvoiceBody | XeroVoidBody }[] = [];
    for (const item of due) {
      const contact = contacts.get(clientKeyOf(item.invoice));
      if (item.invoice.status !== InvoiceStatus.VOIDED && (!contact || 'problem' in contact)) {
        await this.failed(organizationId, tenantId, item, contact && 'problem' in contact ? contact.problem : 'Its client could not be made a contact in Xero.', true);
        result.failed++;
        continue;
      }
      const plan = xeroInvoiceFrom(item.invoice as InvoiceForXero, {
        settings: values,
        accounts,
        contactId: contact && 'id' in contact ? contact.id : '',
        xeroInvoiceId: item.sync?.xeroInvoiceId ?? null,
      });
      if (plan.kind === 'problem') {
        // Held back by the console: tried again when the invoice, or the choices, change -- not on a timer.
        await this.failed(organizationId, tenantId, item, plan.problem, false);
        result.failed++;
        continue;
      }
      outgoing.push({ item, body: plan.body });
    }

    // Xero does not change an invoice with payments on it (2026-11-10, phase 4): its payments come off first, and go
    // back on after it, below. One whose payments cannot all come off this run waits, unchanged, for the next.
    const changing = outgoing.filter((entry) => entry.item.sync?.xeroInvoiceId && entry.item.invoice.status !== InvoiceStatus.VOIDED);
    if (changing.length) {
      const waiting = await this.clearPayments(organizationId, tenantId, changing.map((entry) => entry.item), budget, result);
      outgoing = outgoing.filter((entry) => !waiting.has(entry.item.invoice.id));
    }

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
   * The Xero contact for each client: linked already, made now (50 a call), or
   * -- when Xero says the name is taken, as it is for a contact the office made
   * by hand -- found by its name and linked.
   */
  private async contacts(organizationId: string, tenantId: string, invoices: Candidate[]) {
    const found = new Map<string, { id: string } | { problem: string }>();
    const byKey = new Map<string, string>();
    for (const invoice of invoices) byKey.set(clientKeyOf(invoice), contactNameOf(invoice));
    if (!byKey.size) return found;
    const links = await this.prisma.xeroContactLink.findMany({
      where: { organizationId, xeroTenantId: tenantId, clientKey: { in: [...byKey.keys()] } },
      select: { clientKey: true, xeroContactId: true },
    });
    for (const link of links) found.set(link.clientKey, { id: link.xeroContactId });
    const missing = [...byKey.entries()].filter(([key]) => !found.has(key));
    let lookups = 0;
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const body = { Contacts: batch.map(([, name]) => ({ Name: name })) };
      const path = '/Contacts?summarizeErrors=false';
      let answers: XeroAnswer[];
      try {
        answers = (await this.client.post(organizationId, tenantId, path, body, contactsSchema, keyOf(`${organizationId}:${tenantId}`, path, body))).Contacts;
      } catch (error) {
        if (error instanceof XeroError && error.code === 'XERO_VALIDATION') {
          for (const [key] of batch) found.set(key, { problem: error.message });
          continue;
        }
        throw error;
      }
      for (const [index, [key, name]] of batch.entries()) {
        const answer = answers[index];
        if (answer?.ContactID && !refused(answer)) {
          await this.link(organizationId, tenantId, key, answer.ContactID, name);
          found.set(key, { id: answer.ContactID });
          continue;
        }
        const reason = answer ? said(answer) : 'Xero did not answer for it.';
        if (/already (assigned|exists|in use)/i.test(reason) && lookups < MAX_LOOKUPS_PER_RUN) {
          lookups++;
          const same = (await this.client.get(organizationId, tenantId, `/Contacts?where=${encodeURIComponent(nameFilter(name))}`, contactsSchema)).Contacts.filter(
            (contact) => contact.ContactID,
          );
          if (same.length === 1) {
            await this.link(organizationId, tenantId, key, same[0]!.ContactID!, name);
            found.set(key, { id: same[0]!.ContactID! });
            continue;
          }
          found.set(key, { problem: same.length ? `Xero has ${same.length} contacts named “${name}”: merge them in Xero.` : `Xero says “${name}” is taken but did not find it.` });
          continue;
        }
        found.set(key, { problem: `Xero refused the contact “${name}”: ${reason}` });
      }
    }
    return found;
  }

  private link(organizationId: string, tenantId: string, clientKey: string, xeroContactId: string, name: string) {
    return this.prisma.xeroContactLink.createMany({
      data: [{ organizationId, xeroTenantId: tenantId, clientKey, xeroContactId, name }],
      skipDuplicates: true,
    });
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
    };
    return this.prisma.xeroInvoiceSync.upsert({
      where: { invoiceId: item.invoice.id },
      create: { organizationId, invoiceId: item.invoice.id, ...data },
      update: data,
    });
  }

  /**
   * Takes the payments off invoices about to be changed in Xero, which refuses
   * to change one with payments on it. Each comes off with one call, and its
   * row goes, so it is sent again once the invoice is. Returns the invoices
   * that must wait: more payments than this run may still delete, or one
   * Xero would not take off -- that invoice is kept as refused, with why.
   */
  private async clearPayments(
    organizationId: string,
    tenantId: string,
    items: { invoice: Candidate; sync: SyncRow | null; fingerprint: string }[],
    budget: DeleteBudget,
    result: XeroRunResult,
  ) {
    const waiting = new Set<string>();
    const rows = await this.prisma.xeroPaymentSync.findMany({
      where: { organizationId, xeroTenantId: tenantId, invoiceId: { in: items.map((item) => item.invoice.id) }, xeroPaymentId: { not: null } },
      select: { id: true, invoiceId: true, xeroPaymentId: true },
    });
    for (const item of items) {
      const mine = rows.filter((row) => row.invoiceId === item.invoice.id);
      if (!mine.length) continue;
      if (mine.length > budget.left) {
        waiting.add(item.invoice.id);
        continue;
      }
      for (const row of mine) {
        budget.left--;
        const gone = await this.deletePayment(organizationId, tenantId, row.xeroPaymentId!);
        if (gone !== true) {
          await this.failed(organizationId, tenantId, item, `Its payments could not be taken off in Xero to change it: ${gone}`, true);
          result.failed++;
          waiting.add(item.invoice.id);
          break;
        }
        await this.prisma.xeroPaymentSync.delete({ where: { id: row.id } });
      }
    }
    return waiting;
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
      // What Xero has, if anything, stays known: another organisation's never does.
      xeroInvoiceId: item.sync?.xeroInvoiceId ?? null,
      sentFingerprint: item.sync?.sentFingerprint ?? null,
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
  private async candidates(organizationId: string, tenantId: string, sendFrom: string): Promise<string[]> {
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
           AND i."status" <> 'DRAFT'
           AND (
                (s."id" IS NULL AND i."status" <> 'VOIDED')
             OR (s."xeroTenantId" <> ${tenantId} AND i."status" <> 'VOIDED')
             OR (s."xeroTenantId" = ${tenantId} AND (s."seenUpdatedAt" IS NULL OR i."updatedAt" > s."seenUpdatedAt"))
             OR (s."xeroTenantId" = ${tenantId} AND s."status" = 'FAILED' AND s."nextAttemptAt" <= now())
           )
         ORDER BY i."issuedOn", i."id"
         LIMIT ${MAX_INVOICES_PER_RUN}`,
    ]);
    return (rows as { id: string }[]).map((row) => row.id);
  }

  /** Everything a run and the page need: the organisation's switch and choices, and the sign-in. No call to Xero. */
  private async state(organizationId: string, tenantId: string) {
    const [row, connection, organisation, settings] = await Promise.all([
      this.prisma.xeroSettings.findUnique({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        select: { sendingEnabled: true, sendingChangedAt: true, lastRunAt: true, lastRunProblem: true, sendFrom: true },
      }),
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, scopes: true } }),
      this.prisma.xeroOrganisation.findUnique({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        select: { name: true, status: true, invoiceRemindersOn: true, accounts: true },
      }),
      this.settings.read(organizationId, tenantId),
    ]);
    const connected = connection?.status === 'CONNECTED' && organisation?.status === 'CONNECTED';
    const scopes = connected ? (connection?.scopes ?? []) : [];
    return {
      row,
      name: organisation?.name ?? null,
      tenantId: connected ? tenantId : null,
      sendFrom: row?.sendFrom ? row.sendFrom.toISOString().slice(0, 10) : null,
      accounts: connected ? ((organisation?.accounts as XeroAccount[] | null) ?? []) : [],
      canWrite: xeroCanWrite(scopes),
      blockers: xeroSendingBlockers({
        connected,
        scopes,
        settingsReady: settings.ready,
        invoiceRemindersOn: connected ? (organisation?.invoiceRemindersOn ?? null) : null,
      }),
    };
  }
}
