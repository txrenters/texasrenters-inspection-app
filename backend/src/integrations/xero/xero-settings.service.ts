import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_LABOUR_MINUTES,
  DEFAULT_LABOUR_RATE_CENTS,
  formatMoney,
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
  type XeroItem,
  type XeroProjectUser,
  type XeroTaxRate,
  type XeroTrackingCategory,
} from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, Prisma } from '@prisma/client';

import { billedPrices, invoicingTakenOverAt, listedProducts } from '../../admin/invoice-settings';
import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { XeroError } from './xero.errors';

const DAY_MS = 86_400_000;

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

type Row = {
  sendFrom: Date | null;
  salesAccountId: string | null;
  salesTaxType: string | null;
  salesAccounts: Prisma.JsonValue;
  paymentAccounts: Prisma.JsonValue;
  badDebtAccountId?: string | null;
  paymentsToXero?: boolean;
  trackingCategoryId?: string | null;
  trackingGroups?: Prisma.JsonValue;
  itemCodes?: Prisma.JsonValue;
  projectsEnabled?: boolean;
  projectUserId?: string | null;
  labourRateCents?: number;
  labourMinutes?: number;
  pricesIncludeTax?: boolean;
};

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
    badDebtAccountId: row?.badDebtAccountId ?? null,
    paymentsToXero: row?.paymentsToXero ?? true,
    trackingCategoryId: row?.trackingCategoryId ?? null,
    trackingGroups: stringMap(row?.trackingGroups),
    itemCodes: stringMap(row?.itemCodes),
    projectsEnabled: row?.projectsEnabled ?? false,
    projectUserId: row?.projectUserId ?? null,
    labourRateCents: row?.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS,
    labourMinutes: row?.labourMinutes ?? DEFAULT_LABOUR_MINUTES,
    pricesIncludeTax: row?.pricesIncludeTax ?? false,
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
    badDebtAccountId: blank(input.badDebtAccountId),
    paymentsToXero: input.paymentsToXero ?? true,
    trackingCategoryId: blank(input.trackingCategoryId),
    // With no category, nothing is tagged: what each product was tagged as goes with it.
    trackingGroups: blank(input.trackingCategoryId) ? kept(input.trackingGroups) : {},
    itemCodes: kept(input.itemCodes),
    projectsEnabled: input.projectsEnabled ?? false,
    projectUserId: blank(input.projectUserId),
    labourRateCents: input.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS,
    labourMinutes: input.labourMinutes ?? DEFAULT_LABOUR_MINUTES,
    pricesIncludeTax: input.pricesIncludeTax ?? false,
  };
}

/** The audit trail's lines for what changed, in the office's words. */
export function settingsChanges(
  before: XeroSettingsValues,
  after: XeroSettingsValues,
  accounts: readonly XeroAccount[],
  trackingCategories: readonly XeroTrackingCategory[] = [],
  projectUsers: readonly XeroProjectUser[] = [],
): string[] {
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
  if ((before.badDebtAccountId ?? null) !== (after.badDebtAccountId ?? null))
    changes.push(`Bad debts: ${shown(before.badDebtAccountId)} → ${shown(after.badDebtAccountId)}`);
  if ((before.paymentsToXero ?? true) !== (after.paymentsToXero ?? true))
    changes.push(after.paymentsToXero === false ? 'Payments: sent to Xero → stay out of Xero' : 'Payments: stay out of Xero → sent to Xero');
  const category = (id: string | null | undefined) =>
    id ? (trackingCategories.find((each) => each.trackingCategoryId === id)?.name ?? 'a category Xero no longer lists') : 'none';
  if ((before.trackingCategoryId ?? null) !== (after.trackingCategoryId ?? null))
    changes.push(`Tracking category: ${category(before.trackingCategoryId)} → ${category(after.trackingCategoryId)}`);
  const maps: [string, Record<string, string>, Record<string, string>][] = [
    ['tracked as', before.trackingGroups ?? {}, after.trackingGroups ?? {}],
    ['item', before.itemCodes ?? {}, after.itemCodes ?? {}],
  ];
  for (const [label, was, now] of maps)
    for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort())
      if (was[name] !== now[name]) changes.push(`${name} ${label}: ${was[name] ?? 'none'} → ${now[name] ?? 'none'}`);
  // Projects (2026-11-11).
  if ((before.projectsEnabled ?? false) !== (after.projectsEnabled ?? false))
    changes.push(after.projectsEnabled ? 'Projects: none → one for each visit, invoices as drafts' : 'Projects: one for each visit → none, invoices approved');
  if ((before.pricesIncludeTax ?? false) !== (after.pricesIncludeTax ?? false))
    changes.push(after.pricesIncludeTax ? 'Prices: tax added on top → include the tax' : 'Prices: include the tax → tax added on top');
  const person = (id: string | null | undefined) => (id ? (projectUsers.find((user) => user.userId === id)?.name ?? 'a user Xero no longer lists') : 'none');
  if ((before.projectUserId ?? null) !== (after.projectUserId ?? null)) changes.push(`Labour logged as: ${person(before.projectUserId)} → ${person(after.projectUserId)}`);
  const rate = (cents: number | undefined) => formatMoney(cents ?? DEFAULT_LABOUR_RATE_CENTS);
  if ((before.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS) !== (after.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS))
    changes.push(`Labour rate: ${rate(before.labourRateCents)} → ${rate(after.labourRateCents)} an hour`);
  if ((before.labourMinutes ?? DEFAULT_LABOUR_MINUTES) !== (after.labourMinutes ?? DEFAULT_LABOUR_MINUTES))
    changes.push(`Labour: ${before.labourMinutes ?? DEFAULT_LABOUR_MINUTES} → ${after.labourMinutes ?? DEFAULT_LABOUR_MINUTES} minutes a visit`);
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
    const [row, connection, listed, billed, switchedAt] = await Promise.all([
      this.prisma.xeroSettings.findUnique({ where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } } }),
      this.catalog(organizationId, tenantId),
      listedProducts(this.prisma, organizationId),
      billedPrices(this.prisma, organizationId, today),
      invoicingTakenOverAt(this.prisma, organizationId),
    ]);
    const values = valuesFrom(row);
    // The invoices that would be sent: from the start date, or -- before one is chosen -- the past year, to show what is in use.
    // This organisation's only (2026-11-10): each company's invoices, and the payments against them, go to its own books.
    const since = values.sendFrom ?? new Date(Date.parse(`${today}T00:00:00.000Z`) - 365 * DAY_MS).toISOString().slice(0, 10);
    const invoices: Prisma.InvoiceWhereInput = {
      organizationId,
      xeroTenantId: tenantId,
      // The console's own and Jobber's: one read from Xero (2026-11-12) is never sent there.
      origin: { not: InvoiceOrigin.XERO },
      // The console's drafts go too (2026-11-13), as the sender sends them: Xero numbers them. Jobber's drafts never go.
      OR: [
        { origin: InvoiceOrigin.CONSOLE, status: { not: InvoiceStatus.VOIDED } },
        { status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] } },
      ],
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
        trackingGroup: values.trackingGroups?.[product.nameKey] ?? null,
        itemCode: values.itemCodes?.[product.nameKey] ?? null,
      }));
    // Names on the list or billed lately are someone's: a name given an account here that is neither (no longer
    // billed, or deleted) keeps showing, so its choice is never hidden.
    const known = new Set([...listed.map((product) => product.nameKey), ...billed.map((price) => productNameKey(price.name))]);
    const chosen = new Set([...Object.keys(values.salesAccounts), ...Object.keys(values.trackingGroups ?? {}), ...Object.keys(values.itemCodes ?? {})]);
    for (const nameKey of chosen)
      if (!known.has(nameKey))
        products.push({
          nameKey,
          name: nameKey,
          listed: false,
          active: false,
          accountId: values.salesAccounts[nameKey] ?? null,
          trackingGroup: values.trackingGroups?.[nameKey] ?? null,
          itemCode: values.itemCodes?.[nameKey] ?? null,
        });
    const withoutOrganisation = listed.filter((product) => product.active && !product.xeroTenantId).length;

    const checks = xeroChecks({
      connected: connection.connected,
      readAt: connection.readAt,
      values,
      catalog: connection,
      paymentsByMethod,
      // Its books read back (2026-11-13): payments are recorded in Xero, and no account is asked for them.
      booksRead: Boolean(row?.booksReadAt),
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
      // When the choices were last saved (2026-11-11): not the row's updatedAt, which every sending run moves.
      updatedAt: row?.choicesUpdatedAt.toISOString() ?? null,
      // Its books read back from Xero (2026-11-13): payments and bad debts are recorded there; and whether the console makes the invoices.
      booksRead: Boolean(row?.booksReadAt),
      madeInConsole: Boolean(switchedAt),
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
      badDebtAccountId: after.badDebtAccountId ?? null,
      paymentsToXero: after.paymentsToXero !== false,
      trackingCategoryId: after.trackingCategoryId ?? null,
      trackingGroups: (after.trackingGroups ?? {}) as Prisma.InputJsonObject,
      itemCodes: (after.itemCodes ?? {}) as Prisma.InputJsonObject,
      projectsEnabled: after.projectsEnabled === true,
      projectUserId: after.projectUserId ?? null,
      labourRateCents: after.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS,
      labourMinutes: after.labourMinutes ?? DEFAULT_LABOUR_MINUTES,
      pricesIncludeTax: after.pricesIncludeTax === true,
      choicesUpdatedAt: new Date(),
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.xeroSettings.findUnique({ where });
        // Against the choices as they were last saved (2026-11-11): a sending run in between changes none of them.
        const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt).toISOString() : null;
        if ((row?.choicesUpdatedAt.toISOString() ?? null) !== expected) throw changed();
        const changes = settingsChanges(valuesFrom(row), after, catalog.accounts, catalog.trackingCategories, catalog.projectUsers);
        if (!changes.length) return;
        if (row) {
          // Only over the choices as they were read: a save in between makes this one change nothing.
          const { count } = await tx.xeroSettings.updateMany({
            where: { organizationId: org, xeroTenantId: tenantId, choicesUpdatedAt: row.choicesUpdatedAt },
            data,
          });
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
        // And a bad debt held back for its account (2026-11-10).
        await tx.xeroWriteOffSync.updateMany({ where: { organizationId: org, xeroTenantId: tenantId, status: 'FAILED' }, data: { nextAttemptAt: new Date() } });
        // And a payment held back for its method's account (2026-11-10, phase 4): looked at again, though it did not change.
        await tx.xeroPaymentSync.updateMany({
          where: { organizationId: org, xeroTenantId: tenantId, status: 'FAILED' },
          data: { nextAttemptAt: new Date(), seenUpdatedAt: null },
        });
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
        select: { name: true, status: true, accounts: true, taxRates: true, trackingCategories: true, items: true, projectUsers: true, catalogReadAt: true },
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
      trackingCategories: connected ? ((row.trackingCategories as XeroTrackingCategory[] | null) ?? []) : [],
      items: connected ? ((row.items as XeroItem[] | null) ?? []) : [],
      projectUsers: connected ? ((row.projectUsers as XeroProjectUser[] | null) ?? []) : [],
    };
  }
}

const changed = () => new XeroError('Somebody changed these since they were opened. Look again, then save.', 'XERO_SETTINGS_CHANGED', 409);
