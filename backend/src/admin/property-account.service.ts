import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MAX_ACCOUNT_ENTRIES,
  MAX_STATEMENT_DISCLAIMER,
  invoiceStatusOn,
  recipientsProblem,
  runningBalance,
  statementQueryProblem,
  statementSlice,
  type AccountEntry,
  type AccountEntryKind,
  type InvoiceDeliveryKind,
  type PaymentMethod,
  type PropertyAccount,
  type SaveStatementSettingsInput,
  type SendStatementInput,
  type StatementQuery,
  type StatementSettingsView,
  type StatementView,
} from '@texasrenters/shared';
import { InvoiceStatus, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
import { claimInvoiceEmail, sendClaimedEmail } from './invoice-email-claim';
import { defaultRecipients, readEmailTemplates } from './invoice-email-settings';
import { invoiceWritesOff, invoiceWritesOn, officeBrand } from './invoice-settings';
import { deliveryView } from './invoices.service';
import { statementEmail } from './statement-email';
import { keptInXero, readCompanies, shownInvoices } from './shown-invoices';

/**
 * A property's account (2026-11-10, phase 3 of the invoice gap review), as
 * Jobber's client page keeps it: every invoice sent and every payment on
 * them, with the balance after each, and the statement made from it.
 *
 * Read from the console's own copy, so opening it calls nothing billed. A
 * statement emailed is one billed call per address, claimed under a key and
 * counted against the office's daily invoice email ceiling with every other
 * invoice email; it goes only once the console owns invoicing.
 */

type Db = PrismaService | Prisma.TransactionClient;

const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/** Where each kind sits among the entries of one day: the invoice before what pays it. */
const ORDER: Record<AccountEntryKind, number> = { INVOICE: 0, ADJUSTMENT: 1, PAYMENT: 2, REFUND: 2, CREDIT: 2, WRITE_OFF: 3 };

interface LedgerEntry extends Omit<AccountEntry, 'balanceCents'> {
  order: number;
}

/** An entry as the page and the statement show it, without its place in the day. */
const accountEntry = (entry: LedgerEntry & { balanceCents: number }): AccountEntry => ({
  key: entry.key,
  kind: entry.kind,
  on: entry.on,
  invoiceId: entry.invoiceId,
  invoiceNumber: entry.invoiceNumber,
  paymentId: entry.paymentId,
  amountCents: entry.amountCents,
  balanceCents: entry.balanceCents,
  status: entry.status,
  method: entry.method,
  reference: entry.reference,
});

/** The statement settings an office that saved none gets: Jobber's, newest first and no text. */
export async function readStatementSettings(db: Db, organizationId: string) {
  const row = await db.invoiceSettings.findUnique({
    where: { organizationId },
    select: { statementNewestFirst: true, statementDisclaimer: true, statementSettingsUpdatedAt: true },
  });
  return {
    newestFirst: row?.statementNewestFirst ?? true,
    disclaimer: row?.statementDisclaimer?.trim() || null,
    updatedAt: row?.statementSettingsUpdatedAt ?? null,
  };
}

@Injectable()
export class PropertyAccountService {
  private readonly logger = new Logger(PropertyAccountService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /** The property's billing history, newest first, with its balance now. */
  async account(user: AuthenticatedUser, propertyId: string): Promise<PropertyAccount> {
    const ledger = await this.ledger(user, propertyId);
    const [writesEnabled, statements] = await Promise.all([
      invoiceWritesOn(this.prisma, user.organizationId),
      this.prisma.invoiceDelivery.findMany({
        where: { organizationId: user.organizationId, propertywareBuildingId: propertyId, kind: 'STATEMENT' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          channel: true,
          kind: true,
          followUpDay: true,
          recipients: true,
          status: true,
          failure: true,
          createdAt: true,
          sentAt: true,
          sentBy: { select: { id: true, displayName: true } },
        },
      }),
    ]);
    return {
      propertyId,
      clientName: ledger.clientName,
      address: ledger.address,
      entries: [...ledger.entries].reverse(),
      balanceCents: ledger.entries.at(-1)?.balanceCents ?? 0,
      invoicedCents: ledger.invoicedCents,
      paidCents: ledger.paidCents,
      truncated: ledger.truncated,
      writesEnabled,
      keptInXero: ledger.keptInXero,
      statementTo: ledger.statementTo,
      statements: statements.map(deliveryView),
    };
  }

  /** A statement over the period chosen, in the office's order, with its foot text. */
  async statement(user: AuthenticatedUser, propertyId: string, query: StatementQuery): Promise<StatementView> {
    const today = businessDate();
    const problem = statementQueryProblem(query, today);
    if (problem) throw new ApplicationError(422, 'STATEMENT_PERIOD_INVALID', problem);
    const [ledger, settings, brand] = await Promise.all([
      this.ledger(user, propertyId),
      readStatementSettings(this.prisma, user.organizationId),
      officeBrand(this.prisma, user.organizationId),
    ]);
    const slice = statementSlice(ledger.entries, query);
    return {
      propertyId,
      clientName: ledger.clientName,
      address: ledger.address,
      period: query.period,
      from: slice.from,
      on: today,
      openingBalanceCents: slice.openingBalanceCents,
      closingBalanceCents: ledger.entries.at(-1)?.balanceCents ?? 0,
      // Oldest first; the page and the email turn it round when the office reads newest first.
      entries: slice.entries,
      newestFirst: settings.newestFirst,
      disclaimer: settings.disclaimer,
      brand,
    };
  }

  /** Emails the statement, one to each address, on the press. */
  async sendStatement(user: AuthenticatedUser, propertyId: string, input: SendStatementInput): Promise<PropertyAccount> {
    if (!(await invoiceWritesOn(this.prisma, user.organizationId))) throw invoiceWritesOff();
    // Its invoices kept in a company's books in Xero (2026-11-12): Xero sends its statements.
    if ((await this.ledger(user, propertyId)).keptInXero)
      throw new ApplicationError(409, 'STATEMENT_KEPT_IN_XERO', 'This property’s invoices are kept in Xero. Send its statement from there.');
    const to = input.to.map((address) => address.trim()).filter(Boolean);
    const problem = recipientsProblem(to);
    if (problem) throw new ApplicationError(422, 'STATEMENT_SEND_INVALID', problem);
    const view = await this.statement(user, propertyId, input);
    const deliveryId = await claimInvoiceEmail(this.prisma, {
      organizationId: user.organizationId,
      invoiceId: null,
      propertywareBuildingId: propertyId,
      recipients: to,
      message: null,
      kind: 'STATEMENT' satisfies InvoiceDeliveryKind,
      sentById: user.id,
      clientRequestId: input.clientRequestId,
    });
    // The same press again: it was sent, or tried, already.
    if (!deliveryId) return this.account(user, propertyId);
    const words = await readEmailTemplates(this.prisma, user.organizationId);
    const result = await sendClaimedEmail(this.prisma, this.mail, deliveryId, to, {
      ...statementEmail(view, words.templates.statement),
      replyTo: words.replyTo ?? view.brand.email ?? null,
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'STATEMENT_SENT',
        entityType: 'PropertywareBuilding',
        entityId: propertyId,
        metadata: {
          deliveryId,
          to,
          period: input.period,
          from: view.from,
          balanceCents: view.closingBalanceCents,
          status: result.status,
          ...(result.failure ? { failure: result.failure } : {}),
        },
      },
    });
    if (result.status === 'FAILED') throw new ApplicationError(502, 'STATEMENT_EMAIL_FAILED', result.failure ?? 'The statement was not sent.');
    if (result.failed) this.logger.warn({ event: 'statement_email_not_sent', propertyId, failed: result.failed, of: to.length });
    return this.account(user, propertyId);
  }

  async settings(user: AuthenticatedUser): Promise<StatementSettingsView> {
    const settings = await readStatementSettings(this.prisma, user.organizationId);
    return { newestFirst: settings.newestFirst, disclaimer: settings.disclaimer, updatedAt: settings.updatedAt?.toISOString() ?? null };
  }

  async saveSettings(user: AuthenticatedUser, input: SaveStatementSettingsInput): Promise<StatementSettingsView> {
    const disclaimer = input.disclaimer?.trim() || null;
    if (disclaimer && disclaimer.length > MAX_STATEMENT_DISCLAIMER)
      throw new ApplicationError(422, 'STATEMENT_SETTINGS_INVALID', `Keep the text under ${MAX_STATEMENT_DISCLAIMER} characters.`);
    const org = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const before = await readStatementSettings(tx, org);
      const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt).toISOString() : null;
      if ((before.updatedAt?.toISOString() ?? null) !== expected)
        throw new ApplicationError(409, 'INVOICE_SETTINGS_CHANGED', 'Somebody else changed these first. Look again before saving.');
      const changes = [
        before.newestFirst !== input.newestFirst ? `Order: ${input.newestFirst ? 'oldest first → newest first' : 'newest first → oldest first'}` : null,
        before.disclaimer !== disclaimer ? 'Statement text changed' : null,
      ].filter((change): change is string => change !== null);
      if (!changes.length) return;
      const now = new Date();
      const values = { statementNewestFirst: input.newestFirst, statementDisclaimer: disclaimer, statementSettingsUpdatedAt: now };
      await tx.invoiceSettings.upsert({ where: { organizationId: org }, create: { organizationId: org, ...values }, update: values });
      await tx.auditLog.create({
        data: {
          organizationId: org,
          actorUserId: user.id,
          action: 'STATEMENT_SETTINGS_CHANGED',
          entityType: 'InvoiceSettings',
          entityId: org,
          metadata: { changes },
        },
      });
    });
    return this.settings(user);
  }

  /**
   * The account oldest first, with the balance after each entry. Each
   * invoice's own balance is the record: when its total less its payments
   * does not come to it -- a deposit Jobber took, a credit -- an adjustment
   * says so, and a bad debt's unpaid part is written off, so the running
   * balance always ends where the invoices say it does.
   */
  private async ledger(user: AuthenticatedUser, propertyId: string) {
    const organizationId = user.organizationId;
    const building = await this.prisma.propertywareBuilding.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true, name: true, addressLine1: true, city: true },
    });
    if (!building) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'That property is not one of the office’s.');
    const today = businessDate();
    const read = await readCompanies(this.prisma, organizationId);
    const invoices = await this.prisma.invoice.findMany({
      where: { organizationId, ...shownInvoices(read), propertywareBuildingId: propertyId, status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] } },
      orderBy: [{ issuedOn: 'asc' }, { createdAt: 'asc' }],
      take: MAX_ACCOUNT_ENTRIES + 1,
      select: {
        id: true,
        number: true,
        status: true,
        clientName: true,
        clientEmails: true,
        issuedOn: true,
        dueOn: true,
        createdAt: true,
        updatedAt: true,
        totalCents: true,
        balanceCents: true,
        payments: { select: { id: true, paidOn: true, amountCents: true, method: true, reference: true } },
        // As its company's books in Xero have it (2026-11-12).
        origin: true,
        xeroTenantId: true,
        xeroInvoiceId: true,
        amountCreditedCents: true,
        paidOn: true,
      },
    });
    const kept = invoices.slice(0, MAX_ACCOUNT_ENTRIES);
    const entries: LedgerEntry[] = [];
    let invoicedCents = 0;
    let paidCents = 0;
    for (const invoice of kept) {
      const issued = isoDay(invoice.issuedOn) ?? businessDate(invoice.createdAt);
      const status = invoiceStatusOn(invoice.status, isoDay(invoice.dueOn), today);
      const base = { invoiceId: invoice.id, invoiceNumber: invoice.number, method: null, reference: null, status: null };
      entries.push({ ...base, key: `invoice:${invoice.id}`, kind: 'INVOICE', on: issued, paymentId: null, amountCents: invoice.totalCents, status, order: ORDER.INVOICE });
      invoicedCents += invoice.totalCents;
      let paid = 0;
      for (const payment of invoice.payments) {
        paid += payment.amountCents;
        paidCents += payment.amountCents;
        const kind: AccountEntryKind = payment.amountCents > 0 ? 'PAYMENT' : 'REFUND';
        entries.push({
          ...base,
          key: `payment:${payment.id}`,
          kind,
          on: isoDay(payment.paidOn)!,
          paymentId: payment.id,
          amountCents: -payment.amountCents,
          method: payment.method as PaymentMethod,
          reference: payment.reference,
          order: ORDER[kind],
        });
      }
      const writtenOff = invoice.status === InvoiceStatus.BAD_DEBT ? invoice.balanceCents : 0;
      // What credit notes took off it in Xero (2026-11-12): written off, when the console wrote it off; else a credit.
      // On the day it was settled, else the day it last changed.
      const credited = invoice.amountCreditedCents ?? 0;
      if (credited > 0) {
        const kind: AccountEntryKind = invoice.status === InvoiceStatus.BAD_DEBT ? 'WRITE_OFF' : 'CREDIT';
        entries.push({
          ...base,
          key: `credit:${invoice.id}`,
          kind,
          on: isoDay(invoice.paidOn) ?? businessDate(invoice.updatedAt),
          paymentId: null,
          amountCents: -credited,
          order: ORDER[kind],
        });
      }
      const unexplained = invoice.totalCents - paid - credited - invoice.balanceCents;
      if (unexplained !== 0)
        entries.push({ ...base, key: `adjustment:${invoice.id}`, kind: 'ADJUSTMENT', on: issued, paymentId: null, amountCents: -unexplained, order: ORDER.ADJUSTMENT });
      // The day it was last changed: for an invoice marked bad debt, that day unless it was edited since.
      if (writtenOff > 0)
        entries.push({ ...base, key: `write-off:${invoice.id}`, kind: 'WRITE_OFF', on: businessDate(invoice.updatedAt), paymentId: null, amountCents: -writtenOff, order: ORDER.WRITE_OFF });
    }
    const latest = kept.at(-1);
    return {
      clientName: latest?.clientName ?? building.addressLine1 ?? building.name,
      address: [building.addressLine1 ?? building.name, building.city].filter(Boolean).join(', ') || null,
      entries: runningBalance(entries).map(accountEntry),
      invoicedCents,
      paidCents,
      truncated: invoices.length > MAX_ACCOUNT_ENTRIES,
      keptInXero: kept.some((invoice) => keptInXero(invoice, read)),
      statementTo: defaultRecipients(null, latest?.clientEmails ?? []),
    };
  }
}
