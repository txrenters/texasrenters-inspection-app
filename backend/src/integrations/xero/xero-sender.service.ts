import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { xeroCanWrite, xeroSendingBlockers, type XeroAccount, type XeroSendingView } from '@texasrenters/shared';
import { InvoiceStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { XeroAuthService } from './xero-auth.service';
import { xeroValidationMessages, XeroClient } from './xero.client';
import { XeroError } from './xero.errors';
import { clientKeyOf, contactNameOf, invoiceFingerprint, xeroInvoiceFrom, type InvoiceForXero, type XeroInvoiceBody, type XeroVoidBody } from './xero-invoice';
import { XeroSettingsService } from './xero-settings.service';

/** Xero takes up to 50 of a kind in one call. */
const BATCH = 50;
/** Invoices looked at in one run; the rest wait for the next. Four invoice calls and four contact calls at most. */
export const MAX_INVOICES_PER_RUN = 200;
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
type XeroAnswer = { ContactID?: string | null; InvoiceID?: string | null; StatusAttributeString?: string | null; ValidationErrors?: { Message: string }[] | null };

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

export interface XeroRunResult {
  sent: number;
  failed: number;
  unchanged: number;
  problem: string | null;
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

  async view(organizationId: string): Promise<XeroSendingView> {
    const state = await this.state(organizationId);
    const tenant = state.tenantId;
    const [sent, failed, notYet, failures] = await Promise.all([
      tenant ? this.prisma.xeroInvoiceSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'SENT' } }) : 0,
      tenant ? this.prisma.xeroInvoiceSync.count({ where: { organizationId, xeroTenantId: tenant, status: 'FAILED' } }) : 0,
      tenant && state.sendFrom
        ? this.prisma.invoice.count({
            where: {
              organizationId,
              issuedOn: { gte: new Date(`${state.sendFrom}T00:00:00.000Z`) },
              status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] },
              OR: [{ xeroSync: { is: null } }, { xeroSync: { xeroTenantId: { not: tenant } } }],
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
    ]);
    return {
      enabled: state.row?.sendingEnabled ?? false,
      changedAt: state.row?.sendingChangedAt?.toISOString() ?? null,
      canWrite: state.canWrite,
      blockers: state.blockers,
      counts: { sent, failed, notYet },
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
    };
  }

  /** On only when nothing blocks it; off at any time. Audited both ways. */
  async setEnabled(user: AuthenticatedUser, enabled: boolean): Promise<XeroSendingView> {
    const organizationId = user.organizationId;
    const state = await this.state(organizationId);
    if (enabled && state.blockers.length) throw new XeroError(state.blockers[0]!, 'XERO_SENDING_BLOCKED', 409);
    if (!state.row) throw new XeroError('Choose what goes where in Xero first.', 'XERO_SENDING_BLOCKED', 409);
    if (state.row.sendingEnabled !== enabled) {
      await this.prisma.xeroSettings.update({ where: { organizationId }, data: { sendingEnabled: enabled, sendingChangedAt: new Date() } });
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: user.id,
          action: enabled ? 'XERO_SENDING_TURNED_ON' : 'XERO_SENDING_TURNED_OFF',
          entityType: 'XeroSettings',
          entityId: organizationId,
          metadata: { sendFrom: state.sendFrom },
        },
      });
    }
    return this.view(organizationId);
  }

  /** "Send now": a run at once, at most once a minute. */
  async runNow(user: AuthenticatedUser): Promise<XeroSendingView> {
    const organizationId = user.organizationId;
    const row = await this.prisma.xeroSettings.findUnique({ where: { organizationId }, select: { sendingEnabled: true, lastRunAt: true } });
    if (!row?.sendingEnabled) throw new XeroError('Turn sending on first.', 'XERO_SENDING_OFF', 409);
    if (row.lastRunAt && Date.now() - row.lastRunAt.getTime() < MANUAL_GAP_MS)
      throw new XeroError('It ran a moment ago. Try again in a minute.', 'XERO_RUN_TOO_SOON', 429);
    await this.run(organizationId);
    return this.view(organizationId);
  }

  /** "Try again": every refused invoice is due now, whether or not it changed. */
  async retryFailed(user: AuthenticatedUser): Promise<XeroSendingView> {
    const organizationId = user.organizationId;
    const { count } = await this.prisma.xeroInvoiceSync.updateMany({
      where: { organizationId, status: 'FAILED' },
      data: { nextAttemptAt: new Date(), seenUpdatedAt: null },
    });
    if (count)
      await this.prisma.auditLog.create({
        data: { organizationId, actorUserId: user.id, action: 'XERO_SENDING_RETRIED', entityType: 'XeroSettings', entityId: organizationId, metadata: { invoices: count } },
      });
    return this.view(organizationId);
  }

  /**
   * One run for one office: the scheduler's, or "Send now". Claims the office
   * first, so two runs never send at once; whatever stops it (the daily
   * ceiling, Xero asking to slow down, the sign-in) leaves the rest for the
   * next run and says why.
   */
  async run(organizationId: string): Promise<XeroRunResult> {
    const result: XeroRunResult = { sent: 0, failed: 0, unchanged: 0, problem: null };
    const state = await this.state(organizationId);
    if (!state.row?.sendingEnabled) return { ...result, problem: 'Sending is off.' };
    if (state.blockers.length || !state.tenantId || !state.sendFrom) {
      const problem = state.blockers[0] ?? 'Xero is not ready.';
      await this.prisma.xeroSettings.update({ where: { organizationId }, data: { lastRunAt: new Date(), lastRunProblem: problem } });
      return { ...result, problem };
    }
    const now = new Date();
    const claimed = await this.prisma.xeroSettings.updateMany({
      where: { organizationId, sendingEnabled: true, OR: [{ sendingClaimedUntil: null }, { sendingClaimedUntil: { lt: now } }] },
      data: { sendingClaimedUntil: new Date(now.getTime() + CLAIM_MS) },
    });
    if (!claimed.count) return { ...result, problem: 'Another run is sending.' };

    const sentNumbers: string[] = [];
    try {
      await this.send(organizationId, state.tenantId, state.sendFrom, state.accounts, result, sentNumbers);
    } catch (error) {
      result.problem = error instanceof XeroError ? error.message : 'The run stopped on an unexpected error.';
      if (error instanceof XeroError && error.code === 'XERO_REAUTHORIZATION_REQUIRED') await this.auth.requireReconnect(organizationId, error.message);
      if (!(error instanceof XeroError)) this.logger.error({ event: 'xero_sending_failed', organizationId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.prisma.xeroSettings.update({
        where: { organizationId },
        data: { sendingClaimedUntil: null, lastRunAt: new Date(), lastRunProblem: result.problem },
      });
    }
    if (result.sent || result.failed)
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'XERO_INVOICES_SENT',
          entityType: 'XeroSettings',
          entityId: organizationId,
          metadata: { sent: result.sent, failed: result.failed, numbers: sentNumbers.slice(0, 100), problem: result.problem },
        },
      });
    return result;
  }

  private async send(organizationId: string, tenantId: string, sendFrom: string, accounts: XeroAccount[], result: XeroRunResult, sentNumbers: string[]) {
    const ids = await this.candidates(organizationId, tenantId, sendFrom);
    if (!ids.length) return;
    const invoices = await this.prisma.invoice.findMany({ where: { organizationId, id: { in: ids } }, select: INVOICE_FIELDS });
    const values = (await this.settings.read(organizationId)).values;

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

    const outgoing: { item: (typeof due)[number]; body: XeroInvoiceBody | XeroVoidBody }[] = [];
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

    for (let start = 0; start < outgoing.length; start += BATCH) {
      const batch = outgoing.slice(start, start + BATCH);
      const body = { Invoices: batch.map((entry) => entry.body) };
      const path = '/Invoices?summarizeErrors=false';
      let answers: XeroAnswer[];
      try {
        answers = (await this.client.post(organizationId, path, body, invoicesSchema, keyOf(organizationId, path, body))).Invoices;
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
        answers = (await this.client.post(organizationId, path, body, contactsSchema, keyOf(organizationId, path, body))).Contacts;
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
          const same = (await this.client.get(organizationId, `/Contacts?where=${encodeURIComponent(nameFilter(name))}`, contactsSchema)).Contacts.filter(
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
   * The invoices worth looking at: issued from the start date, not drafts,
   * and either never sent to this organisation, changed since last seen, or
   * due a retry. A voided one is looked at only once it has a row -- one that
   * never reached Xero is not sent to be voided. Oldest first, at most 200.
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

  /** Everything a run and the page need: the switch, the connection, the choices. No call to Xero. */
  private async state(organizationId: string) {
    const [row, connection, settings] = await Promise.all([
      this.prisma.xeroSettings.findUnique({
        where: { organizationId },
        select: { sendingEnabled: true, sendingChangedAt: true, lastRunAt: true, lastRunProblem: true, sendFrom: true },
      }),
      this.prisma.xeroConnection.findUnique({
        where: { organizationId },
        select: { status: true, xeroTenantId: true, scopes: true, invoiceRemindersOn: true, accounts: true },
      }),
      this.settings.read(organizationId),
    ]);
    const connected = connection?.status === 'CONNECTED';
    const scopes = connected ? (connection?.scopes ?? []) : [];
    return {
      row,
      tenantId: connected ? (connection?.xeroTenantId ?? null) : null,
      sendFrom: row?.sendFrom ? row.sendFrom.toISOString().slice(0, 10) : null,
      accounts: connected ? ((connection?.accounts as XeroAccount[] | null) ?? []) : [],
      canWrite: xeroCanWrite(scopes),
      blockers: xeroSendingBlockers({
        connected,
        scopes,
        settingsReady: settings.ready,
        invoiceRemindersOn: connected ? (connection?.invoiceRemindersOn ?? null) : null,
      }),
    };
  }
}
