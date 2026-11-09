import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
  productNameKey,
  xeroAccountLabel,
  xeroChecks,
  xeroSettingsProblem,
  type PaymentMethod,
  type SaveXeroSettingsInput,
  type XeroAccount,
  type XeroSalesItem,
  type XeroSettingsValues,
  type XeroSettingsView,
  type XeroTaxRate,
} from '@texasrenters/shared';
import { InvoiceStatus, Prisma } from '@prisma/client';

import { billedPrices, listedProducts } from '../../admin/invoice-settings';
import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { XeroError } from './xero.errors';

const DAY_MS = 86_400_000;

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

type Row = { sendFrom: Date | null; salesAccountId: string | null; salesTaxType: string | null; salesAccounts: Prisma.JsonValue; paymentAccounts: Prisma.JsonValue };

const stringMap = (value: Prisma.JsonValue | undefined): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''))
    : {};

/** The saved row in the contract's words; no row reads as nothing chosen. */
export function valuesFrom(row: Row | null): XeroSettingsValues {
  const payments = stringMap(row?.paymentAccounts);
  return {
    sendFrom: row?.sendFrom ? row.sendFrom.toISOString().slice(0, 10) : null,
    salesAccountId: row?.salesAccountId ?? null,
    salesTaxType: row?.salesTaxType ?? null,
    salesAccounts: stringMap(row?.salesAccounts),
    paymentAccounts: Object.fromEntries(PAYMENT_METHODS.filter((method) => payments[method]).map((method) => [method, payments[method]!])),
  };
}

/** What was sent, tidied: blanks dropped, so "no account of its own" is an absent key. */
export function valuesFromInput(input: SaveXeroSettingsInput): XeroSettingsValues {
  const blank = (value: string | null | undefined) => value?.trim() || null;
  const kept = (map: Record<string, unknown> | null | undefined) =>
    Object.fromEntries(Object.entries(map ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''));
  return {
    sendFrom: blank(input.sendFrom),
    salesAccountId: blank(input.salesAccountId),
    salesTaxType: blank(input.salesTaxType),
    salesAccounts: kept(input.salesAccounts),
    paymentAccounts: kept(input.paymentAccounts) as XeroSettingsValues['paymentAccounts'],
  };
}

/** The audit trail's lines for what changed, in the office's words. */
export function settingsChanges(before: XeroSettingsValues, after: XeroSettingsValues, accounts: readonly XeroAccount[]): string[] {
  const byId = new Map(accounts.map((account) => [account.accountId, account]));
  const shown = (id: string | null | undefined) => {
    if (!id) return 'none';
    const account = byId.get(id);
    return account ? xeroAccountLabel(account) : 'an account Xero no longer lists';
  };
  const changes: string[] = [];
  if (before.sendFrom !== after.sendFrom) changes.push(`Start date: ${before.sendFrom ?? 'none'} → ${after.sendFrom ?? 'none'}`);
  if (before.salesAccountId !== after.salesAccountId)
    changes.push(`Default sales account: ${shown(before.salesAccountId)} → ${shown(after.salesAccountId)}`);
  if (before.salesTaxType !== after.salesTaxType) changes.push(`Tax type: ${before.salesTaxType ?? 'none'} → ${after.salesTaxType ?? 'none'}`);
  const names = new Set([...Object.keys(before.salesAccounts), ...Object.keys(after.salesAccounts)]);
  for (const name of [...names].sort())
    if (before.salesAccounts[name] !== after.salesAccounts[name])
      changes.push(`${name}: ${before.salesAccounts[name] ? shown(before.salesAccounts[name]) : 'the default'} → ${after.salesAccounts[name] ? shown(after.salesAccounts[name]) : 'the default'}`);
  for (const method of PAYMENT_METHODS)
    if (before.paymentAccounts[method] !== after.paymentAccounts[method])
      changes.push(`${PAYMENT_METHOD_LABEL[method]}: ${shown(before.paymentAccounts[method])} → ${shown(after.paymentAccounts[method])}`);
  return changes;
}

/**
 * The office's choices for sending to Xero (2026-11-10), one set for each of
 * its organisations -- each has its own chart of accounts: from which day, to
 * which accounts, with which tax type. Checked against the console's last read
 * of that organisation, so neither showing nor saving them calls Xero. Nothing
 * is sent to Xero yet.
 */
@Injectable()
export class XeroSettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async read(organizationId: string, tenantId: string): Promise<XeroSettingsView> {
    const today = businessDate();
    const [row, connection, listed, billed] = await Promise.all([
      this.prisma.xeroSettings.findUnique({ where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } } }),
      this.catalog(organizationId, tenantId),
      listedProducts(this.prisma, organizationId),
      billedPrices(this.prisma, organizationId, today),
    ]);
    const values = valuesFrom(row);
    // The invoices that would be sent: from the start date, or -- before one is chosen -- the past year, to show what is in use.
    // Every organisation's for now: which invoices are whose comes with the services (the next phase).
    const since = values.sendFrom ?? new Date(Date.parse(`${today}T00:00:00.000Z`) - 365 * DAY_MS).toISOString().slice(0, 10);
    const invoices: Prisma.InvoiceWhereInput = {
      organizationId,
      status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] },
      issuedOn: { gte: new Date(`${since}T00:00:00.000Z`) },
    };
    const [invoicesToSend, byMethod] = await Promise.all([
      this.prisma.invoice.count({ where: invoices }),
      this.prisma.invoicePayment.groupBy({ by: ['method'], where: { organizationId, invoice: invoices }, _count: { _all: true } }),
    ]);
    const paymentsByMethod = Object.fromEntries(byMethod.map((group) => [group.method, group._count._all])) as Partial<Record<PaymentMethod, number>>;

    // The services the office sends to this organisation, as its products list says (phase 2 of the multi-company plan).
    const products: XeroSalesItem[] = listed
      .filter((product) => product.xeroTenantId === tenantId)
      .map((product) => ({
        nameKey: product.nameKey,
        name: product.name,
        listed: true,
        active: product.active,
        accountId: values.salesAccounts[product.nameKey] ?? null,
      }));
    // Names on the list or billed lately are someone's: a name given an account here that is neither (no longer
    // billed, or deleted) keeps showing, so its choice is never hidden.
    const known = new Set([...listed.map((product) => product.nameKey), ...billed.map((price) => productNameKey(price.name))]);
    for (const [nameKey, accountId] of Object.entries(values.salesAccounts))
      if (!known.has(nameKey)) products.push({ nameKey, name: nameKey, listed: false, active: false, accountId });
    const withoutOrganisation = listed.filter((product) => product.active && !product.xeroTenantId).length;

    const checks = xeroChecks({
      connected: connection.connected,
      readAt: connection.readAt,
      values,
      catalog: connection,
      paymentsByMethod,
    });
    return {
      tenantId,
      values,
      products,
      withoutOrganisation,
      payments: PAYMENT_METHODS.map((method) => ({ method, accountId: values.paymentAccounts[method] ?? null, payments: paymentsByMethod[method] ?? 0 })),
      invoicesToSend,
      checks,
      ready: checks.every((check) => check.ok),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async save(user: AuthenticatedUser, tenantId: string, input: SaveXeroSettingsInput): Promise<XeroSettingsView> {
    const org = user.organizationId;
    const catalog = await this.catalog(org, tenantId);
    if (!catalog.connected || !catalog.readAt)
      throw new XeroError('Connect this organisation and read it before choosing its accounts.', 'XERO_NOT_READ', 409);
    const where = { organizationId_xeroTenantId: { organizationId: org, xeroTenantId: tenantId } };
    const after = valuesFromInput(input);
    const problem = xeroSettingsProblem(after, catalog, businessDate());
    if (problem) throw new XeroError(problem, 'XERO_SETTINGS_INVALID', 422);

    const data = {
      sendFrom: after.sendFrom ? new Date(`${after.sendFrom}T00:00:00.000Z`) : null,
      salesAccountId: after.salesAccountId,
      salesTaxType: after.salesTaxType,
      salesAccounts: after.salesAccounts as Prisma.InputJsonObject,
      paymentAccounts: after.paymentAccounts as Prisma.InputJsonObject,
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.xeroSettings.findUnique({ where });
        const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt).toISOString() : null;
        if ((row?.updatedAt.toISOString() ?? null) !== expected) throw changed();
        const changes = settingsChanges(valuesFrom(row), after, catalog.accounts);
        if (!changes.length) return;
        if (row) {
          // Only over the row as it was read: a save in between makes this one change nothing.
          const { count } = await tx.xeroSettings.updateMany({ where: { organizationId: org, xeroTenantId: tenantId, updatedAt: row.updatedAt }, data });
          if (count !== 1) throw changed();
        } else await tx.xeroSettings.create({ data: { organizationId: org, xeroTenantId: tenantId, ...data } });
        await tx.auditLog.create({
          data: {
            organizationId: org,
            actorUserId: user.id,
            action: 'XERO_SETTINGS_CHANGED',
            entityType: 'XeroSettings',
            entityId: org,
            metadata: { organisation: catalog.name, tenantId, changes },
          },
        });
        // An invoice this organisation held back for its account, or refused for it, is worth another go with the new choices.
        await tx.xeroInvoiceSync.updateMany({ where: { organizationId: org, xeroTenantId: tenantId, status: 'FAILED' }, data: { nextAttemptAt: new Date() } });
      });
    } catch (error) {
      // Two first saves at once: the other one made the row.
      if (isUniqueViolation(error)) throw changed();
      throw error;
    }
    return this.read(org, tenantId);
  }

  /** The console's last read of one organisation: no call to Xero. Connected only while the sign-in and the organisation both are. */
  private async catalog(organizationId: string, tenantId: string) {
    const [connection, row] = await Promise.all([
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true } }),
      this.prisma.xeroOrganisation.findUnique({
        where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
        select: { name: true, status: true, accounts: true, taxRates: true, catalogReadAt: true },
      }),
    ]);
    if (!row) throw new XeroError('That is not one of the office’s Xero organisations.', 'XERO_ORGANISATION_UNKNOWN', 404);
    const connected = connection?.status === 'CONNECTED' && row.status === 'CONNECTED';
    return {
      name: row.name,
      connected,
      readAt: connected ? (row.catalogReadAt?.toISOString() ?? null) : null,
      accounts: connected ? ((row.accounts as XeroAccount[] | null) ?? []) : [],
      taxRates: connected ? ((row.taxRates as XeroTaxRate[] | null) ?? []) : [],
    };
  }
}

const changed = () => new XeroError('Somebody changed these since they were opened. Look again, then save.', 'XERO_SETTINGS_CHANGED', 409);
