import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  xeroCanMakeProjects,
  type XeroAccount,
  type XeroConnectionView,
  type XeroItem,
  type XeroOrganisation,
  type XeroOrganisationStatus,
  type XeroProjectUser,
  type XeroTaxRate,
  type XeroTrackingCategory,
} from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { withTenant } from '../../database/tenant-context';
import { XeroAuthService } from './xero-auth.service';
import { XeroClient } from './xero.client';
import { getXeroConfig, xeroConfigured } from './xero.config';
import { XeroError } from './xero.errors';

/** At most one read of an organisation's settings this often: each costs it six calls. */
const READ_GAP_MS = 5 * 60_000;

/** About the connection, not the reminders: these stop the read rather than leave the reminders unknown. */
const READ_STOPPERS = new Set(['XERO_DAILY_CEILING', 'XERO_RATE_LIMITED', 'XERO_REAUTHORIZATION_REQUIRED', 'XERO_UNREACHABLE']);

const remindersSchema = z.object({ InvoiceReminders: z.array(z.object({ Enabled: z.boolean().nullish() })).nullish() });

/** Whether Xero's own invoice reminders are on; null when it did not say. */
export const remindersFrom = (data: z.infer<typeof remindersSchema>) => data.InvoiceReminders?.[0]?.Enabled ?? null;

const organisationsSchema = z.object({
  Organisations: z.array(
    z.object({
      Name: z.string(),
      LegalName: z.string().nullish(),
      BaseCurrency: z.string().nullish(),
      CountryCode: z.string().nullish(),
      OrganisationType: z.string().nullish(),
      SalesTaxBasis: z.string().nullish(),
      ShortCode: z.string().nullish(),
    }),
  ),
});

const accountsSchema = z.object({
  Accounts: z.array(
    z.object({
      AccountID: z.string(),
      Code: z.string().nullish(),
      Name: z.string(),
      Type: z.string(),
      Class: z.string().nullish(),
      Status: z.string(),
      EnablePaymentsToAccount: z.boolean().nullish(),
    }),
  ),
});

const taxRatesSchema = z.object({
  TaxRates: z.array(
    z.object({
      Name: z.string(),
      TaxType: z.string(),
      Status: z.string(),
      EffectiveRate: z.union([z.number(), z.string()]).nullish(),
      CanApplyToRevenue: z.boolean().nullish(),
    }),
  ),
});

const trackingSchema = z.object({
  TrackingCategories: z.array(
    z.object({
      TrackingCategoryID: z.string(),
      Name: z.string(),
      Status: z.string().nullish(),
      Options: z.array(z.object({ TrackingOptionID: z.string(), Name: z.string(), Status: z.string().nullish() })).nullish(),
    }),
  ),
});

const itemsSchema = z.object({
  Items: z.array(z.object({ ItemID: z.string(), Code: z.string().nullish(), Name: z.string().nullish(), IsSold: z.boolean().nullish() })),
});

/** The Projects API's users (2026-11-11): camelCase, a page of items. */
const projectUsersSchema = z.object({
  items: z.array(z.object({ userId: z.string(), name: z.string().nullish(), email: z.string().nullish() })).nullish(),
});

/** Who can log time on projects, by name; an email stands in for a missing name, and is otherwise not kept. */
export function projectUsersFrom(data: z.infer<typeof projectUsersSchema>): XeroProjectUser[] {
  return (data.items ?? [])
    .map((user) => ({ userId: user.userId, name: user.name?.trim() || user.email?.trim() || 'Unnamed user' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The tracking categories and their options, by name (2026-11-11). */
export function trackingCategoriesFrom(data: z.infer<typeof trackingSchema>): XeroTrackingCategory[] {
  return data.TrackingCategories.map((category) => ({
    trackingCategoryId: category.TrackingCategoryID,
    name: category.Name,
    status: category.Status ?? 'ACTIVE',
    options: (category.Options ?? [])
      .map((option) => ({ optionId: option.TrackingOptionID, name: option.Name, status: option.Status ?? 'ACTIVE' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The products and services with a code, by code (2026-11-11). */
export function itemsFrom(data: z.infer<typeof itemsSchema>): XeroItem[] {
  return data.Items.flatMap((item) =>
    item.Code?.trim() ? [{ itemId: item.ItemID, code: item.Code.trim(), name: item.Name?.trim() || null, isSold: item.IsSold !== false }] : [],
  ).sort((a, b) => a.code.localeCompare(b.code));
}

/** Only what the console uses, in its own words. */
export function organisationFrom(data: z.infer<typeof organisationsSchema>): XeroOrganisation | null {
  const org = data.Organisations[0];
  if (!org) return null;
  return {
    name: org.Name,
    legalName: org.LegalName ?? null,
    baseCurrency: org.BaseCurrency ?? null,
    countryCode: org.CountryCode ?? null,
    organisationType: org.OrganisationType ?? null,
    salesTaxBasis: org.SalesTaxBasis ?? null,
    shortCode: org.ShortCode ?? null,
  };
}

export function accountsFrom(data: z.infer<typeof accountsSchema>): XeroAccount[] {
  return data.Accounts.map((account) => ({
    accountId: account.AccountID,
    code: account.Code?.trim() || null,
    name: account.Name,
    type: account.Type,
    class: account.Class ?? null,
    status: account.Status,
    takesPayments: account.Type === 'BANK' || account.EnablePaymentsToAccount === true,
  })).sort((a, b) =>
    // By code, numbers in order; an account with no code (a bank account, often) last.
    a.code === null || b.code === null
      ? Number(a.code === null) - Number(b.code === null) || a.name.localeCompare(b.name)
      : a.code.localeCompare(b.code, 'en', { numeric: true }) || a.name.localeCompare(b.name),
  );
}

export function taxRatesFrom(data: z.infer<typeof taxRatesSchema>): XeroTaxRate[] {
  return data.TaxRates.map((rate) => {
    const effective = rate.EffectiveRate === null || rate.EffectiveRate === undefined ? null : Number(rate.EffectiveRate);
    return {
      name: rate.Name,
      taxType: rate.TaxType,
      status: rate.Status,
      effectiveRate: effective !== null && Number.isFinite(effective) ? effective : null,
      appliesToRevenue: rate.CanApplyToRevenue !== false,
    };
  });
}

/**
 * The office's Xero organisations (2026-11-10). The companies -- THMP, Crystal
 * Creek Pest, Crystal Creek Air and the like -- each keep their own books; one
 * sign-in by somebody who runs the integrations reaches whichever of them they
 * tick at Xero, and the console keeps a row for each: read -- its details,
 * chart of accounts and tax rates -- and kept, so the console shows them
 * without asking Xero again. Nothing is written to Xero here.
 */
@Injectable()
export class XeroService {
  private readonly logger = new Logger(XeroService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroAuthService) private readonly auth: XeroAuthService,
    @Inject(XeroClient) private readonly client: XeroClient,
  ) {}

  async describe(organizationId: string): Promise<XeroConnectionView> {
    const [row, organisations] = await Promise.all([
      this.prisma.xeroConnection.findUnique({
        where: { organizationId },
        select: { status: true, connectedAt: true, disconnectedAt: true, lastRefreshError: true, scopes: true },
      }),
      // CONNECTED sorts before REMOVED.
      this.prisma.xeroOrganisation.findMany({ where: { organizationId }, orderBy: [{ status: 'asc' }, { name: 'asc' }] }),
    ]);
    const today = businessDate();
    return {
      configured: xeroConfigured(getXeroConfig()),
      status: (row?.status as XeroConnectionView['status']) ?? 'DISCONNECTED',
      connectedAt: row?.connectedAt?.toISOString() ?? null,
      disconnectedAt: row?.disconnectedAt?.toISOString() ?? null,
      problem: row?.status === 'REAUTHORIZATION_REQUIRED' ? (row.lastRefreshError ?? 'Xero must be connected again.') : null,
      scopes: row?.scopes ?? [],
      organisations: organisations.map((organisation) => ({
        tenantId: organisation.xeroTenantId,
        name: organisation.name,
        status: organisation.status as XeroOrganisationStatus,
        connectedAt: organisation.connectedAt?.toISOString() ?? null,
        removedAt: organisation.removedAt?.toISOString() ?? null,
        organisation: (organisation.organisation as XeroOrganisation | null) ?? null,
        accounts: (organisation.accounts as XeroAccount[] | null) ?? [],
        taxRates: (organisation.taxRates as XeroTaxRate[] | null) ?? [],
        trackingCategories: (organisation.trackingCategories as XeroTrackingCategory[] | null) ?? [],
        items: (organisation.items as XeroItem[] | null) ?? [],
        projectUsers: (organisation.projectUsers as XeroProjectUser[] | null) ?? [],
        readAt: organisation.catalogReadAt?.toISOString() ?? null,
        readProblem: organisation.catalogReadError ?? null,
        callsToday: organisation.callsDay === today ? organisation.callsUsed : 0,
        invoiceRemindersOn: organisation.invoiceRemindersOn ?? null,
      })),
      dailyCeiling: getXeroConfig().dailyCallCeiling,
    };
  }

  /**
   * Finishes a sign-in: the tokens for the code, then every organisation they
   * reach -- what somebody ticked at Xero, this time or before. Each is kept
   * connected, under the name Xero gives it now; one the sign-in no longer
   * reaches is marked removed, never deleted, so what was chosen for it stays
   * readable. Then each is read once.
   */
  async completeAuthorization(input: { code: string; state?: string }) {
    const state = this.auth.readState(input.state);
    return withTenant(state.organizationId, async () => {
      const organizationId = state.organizationId;
      const tokens = await this.auth.exchange(input.code, state.codeVerifier);
      const reached = (await this.client.connections(tokens.access_token)).filter((tenant) => tenant.tenantType === 'ORGANISATION');
      if (!reached.length) throw new XeroError('No Xero organisation was chosen. Tick at least one when connecting.', 'XERO_ORGANISATION_CHOICE', 409);
      await this.auth.store(organizationId, tokens, { connectedByUserId: state.userId, connectedAt: new Date(), disconnectedAt: null });
      const now = new Date();
      for (const tenant of reached) {
        const name = tenant.tenantName?.trim() || 'Xero organisation';
        await this.prisma.xeroOrganisation.upsert({
          where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenant.tenantId } },
          create: { organizationId, xeroTenantId: tenant.tenantId, xeroConnectionId: tenant.id, name, status: 'CONNECTED', connectedAt: now },
          update: { xeroConnectionId: tenant.id, name, status: 'CONNECTED', removedAt: null },
        });
      }
      const { count: removed } = await this.prisma.xeroOrganisation.updateMany({
        where: { organizationId, status: 'CONNECTED', xeroTenantId: { notIn: reached.map((tenant) => tenant.tenantId) } },
        data: { status: 'REMOVED', removedAt: now, xeroConnectionId: null },
      });
      const names = reached.map((tenant) => tenant.tenantName?.trim() || 'Xero organisation');
      await this.audit(organizationId, state.userId, 'XERO_CONNECTED', { organisations: names, noLongerReached: removed });
      // Read each now, so the page has them; a failure leaves it connected and says why.
      for (const tenant of reached) await this.read(organizationId, tenant.tenantId, true).catch(() => undefined);
      return { names };
    });
  }

  /**
   * Reads one organisation, its accounts, its tax rates, its tracking
   * categories and items, and whether its own invoice reminders are on again:
   * six calls to it, at most every five minutes -- and a seventh for its users
   * who can log time on projects, once the connection may read projects.
   */
  async read(organizationId: string, tenantId: string, force = false): Promise<XeroConnectionView> {
    const where = { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } };
    const [connection, row] = await Promise.all([
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, scopes: true } }),
      this.prisma.xeroOrganisation.findUnique({ where, select: { status: true, catalogReadAt: true } }),
    ]);
    if (connection?.status !== 'CONNECTED') throw new XeroError('Xero is not connected.', 'XERO_NOT_CONNECTED', 409);
    if (!row) throw new XeroError('That is not one of the office’s Xero organisations.', 'XERO_ORGANISATION_UNKNOWN', 404);
    if (row.status !== 'CONNECTED') throw new XeroError('That Xero organisation is not connected.', 'XERO_NOT_CONNECTED', 409);
    if (!force && row.catalogReadAt && Date.now() - row.catalogReadAt.getTime() < READ_GAP_MS)
      throw new XeroError('It was read a moment ago. Try again in a few minutes.', 'XERO_READ_TOO_SOON', 429);
    try {
      const organisation = organisationFrom(await this.client.get(organizationId, tenantId, '/Organisation', organisationsSchema));
      const accounts = accountsFrom(await this.client.get(organizationId, tenantId, '/Accounts', accountsSchema));
      const taxRates = taxRatesFrom(await this.client.get(organizationId, tenantId, '/TaxRates', taxRatesSchema));
      // On, Xero would email the organisation's clients beside the console. Not saying is not a reason to fail the read.
      const unsaid = (error: unknown) => {
        if (error instanceof XeroError && READ_STOPPERS.has(error.code)) throw error;
        return null;
      };
      const invoiceRemindersOn = await this.client.get(organizationId, tenantId, '/InvoiceReminders/Settings', remindersSchema).then(remindersFrom).catch(unsaid);
      // What a line is tagged and itemed with (2026-11-11). Not saying leaves what was read before.
      const trackingCategories = await this.client.get(organizationId, tenantId, '/TrackingCategories', trackingSchema).then(trackingCategoriesFrom).catch(unsaid);
      const items = await this.client.get(organizationId, tenantId, '/Items', itemsSchema).then(itemsFrom).catch(unsaid);
      // Who the labour on a visit's project can be logged under (2026-11-11): asked only of a connection allowed to.
      const projectUsers = xeroCanMakeProjects(connection.scopes)
        ? await this.client.projectsGet(organizationId, tenantId, '/ProjectsUsers?pageSize=500', projectUsersSchema).then(projectUsersFrom).catch(unsaid)
        : null;
      await this.prisma.xeroOrganisation.update({
        where,
        data: {
          // Xero's own name for it, as it is now.
          ...(organisation?.name ? { name: organisation.name } : {}),
          organisation: organisation as unknown as Prisma.InputJsonValue,
          accounts: accounts as unknown as Prisma.InputJsonValue,
          taxRates: taxRates as unknown as Prisma.InputJsonValue,
          ...(trackingCategories ? { trackingCategories: trackingCategories as unknown as Prisma.InputJsonValue } : {}),
          ...(items ? { items: items as unknown as Prisma.InputJsonValue } : {}),
          ...(projectUsers ? { projectUsers: projectUsers as unknown as Prisma.InputJsonValue } : {}),
          invoiceRemindersOn,
          catalogReadAt: new Date(),
          catalogReadError: null,
        },
      });
      // An invoice held back for what Xero lacked -- an option for its technician, an item -- is worth another go now.
      await this.prisma.xeroInvoiceSync.updateMany({
        where: { organizationId, xeroTenantId: tenantId, status: 'FAILED', nextAttemptAt: null },
        data: { nextAttemptAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof XeroError ? error.message : 'Xero could not be read.';
      await this.prisma.xeroOrganisation.updateMany({ where: { organizationId, xeroTenantId: tenantId }, data: { catalogReadError: message } });
      if (error instanceof XeroError && error.code === 'XERO_REAUTHORIZATION_REQUIRED') await this.auth.requireReconnect(organizationId, message);
      throw error;
    }
    return this.describe(organizationId);
  }

  /** Ends the link to one organisation at Xero and marks it removed here; the others stay connected. */
  async disconnectOrganisation(user: AuthenticatedUser, tenantId: string): Promise<XeroConnectionView & { removedAtXero: boolean }> {
    const organizationId = user.organizationId;
    const row = await this.prisma.xeroOrganisation.findUnique({
      where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
      select: { status: true, name: true, xeroConnectionId: true },
    });
    if (!row) throw new XeroError('That is not one of the office’s Xero organisations.', 'XERO_ORGANISATION_UNKNOWN', 404);
    let removedAtXero = row.status !== 'CONNECTED';
    if (row.status === 'CONNECTED' && row.xeroConnectionId) removedAtXero = await this.removeAtXero(organizationId, row.xeroConnectionId);
    await this.prisma.xeroOrganisation.updateMany({
      where: { organizationId, xeroTenantId: tenantId },
      data: { status: 'REMOVED', removedAt: new Date(), xeroConnectionId: null },
    });
    await this.audit(organizationId, user.id, 'XERO_ORGANISATION_DISCONNECTED', { name: row.name, removedAtXero });
    return { ...(await this.describe(organizationId)), removedAtXero };
  }

  /** Ends every link at Xero, gives back the refresh token, and forgets the credentials here. */
  async disconnect(user: AuthenticatedUser): Promise<XeroConnectionView & { removedAtXero: boolean }> {
    const organizationId = user.organizationId;
    const [row, organisations] = await Promise.all([
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true } }),
      this.prisma.xeroOrganisation.findMany({ where: { organizationId, status: 'CONNECTED' }, select: { xeroConnectionId: true } }),
    ]);
    let removedAtXero = true;
    if (row?.status === 'CONNECTED') {
      for (const organisation of organisations)
        if (organisation.xeroConnectionId) removedAtXero = (await this.removeAtXero(organizationId, organisation.xeroConnectionId)) && removedAtXero;
      await this.auth.revoke(organizationId);
    }
    await this.prisma.xeroConnection.updateMany({
      where: { organizationId },
      data: { status: 'DISCONNECTED', accessTokenCiphertext: null, accessTokenExpiresAt: null, refreshTokenCiphertext: null, disconnectedAt: new Date() },
    });
    await this.prisma.xeroOrganisation.updateMany({
      where: { organizationId, status: 'CONNECTED' },
      data: { status: 'REMOVED', removedAt: new Date(), xeroConnectionId: null },
    });
    await this.audit(organizationId, user.id, 'XERO_DISCONNECTED', { removedAtXero, organisations: organisations.length });
    return { ...(await this.describe(organizationId)), removedAtXero };
  }

  /** Best effort: Xero saying no, or not answering, still lets the office end it here. */
  private async removeAtXero(organizationId: string, connectionId: string) {
    try {
      return await this.client.removeConnection(await this.auth.accessToken(organizationId), connectionId);
    } catch (error) {
      this.logger.warn({ event: 'xero_disconnect_remote_failed', organizationId, code: error instanceof XeroError ? error.code : undefined });
      return false;
    }
  }

  private audit(organizationId: string, actorUserId: string | null, action: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: { organizationId, actorUserId, action, entityType: 'XeroConnection', entityId: organizationId, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
