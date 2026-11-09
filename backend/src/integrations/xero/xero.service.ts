import { Inject, Injectable, Logger } from '@nestjs/common';
import type { XeroAccount, XeroConnectionView, XeroOrganisation, XeroTaxRate } from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { withTenant } from '../../database/tenant-context';
import { XeroAuthService, authEventOf } from './xero-auth.service';
import { XeroClient } from './xero.client';
import { getXeroConfig, xeroConfigured } from './xero.config';
import { XeroError } from './xero.errors';

/** At most one read of the organisation's settings this often: each costs four calls. */
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
 * The office's Xero organisation (2026-11-10, phase 1 of the Xero plan):
 * connected by somebody who runs the integrations, then read -- its details,
 * chart of accounts and tax rates -- and kept, so the console shows them
 * without asking Xero again. Nothing is written to Xero in this phase.
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
    const [row, allowance] = await Promise.all([
      this.prisma.xeroConnection.findUnique({
        where: { organizationId },
        select: {
          status: true,
          xeroTenantName: true,
          connectedAt: true,
          disconnectedAt: true,
          lastRefreshError: true,
          scopes: true,
          organisation: true,
          accounts: true,
          taxRates: true,
          catalogReadAt: true,
          catalogReadError: true,
          invoiceRemindersOn: true,
        },
      }),
      this.client.allowance(organizationId),
    ]);
    const connected = row?.status === 'CONNECTED';
    return {
      configured: xeroConfigured(getXeroConfig()),
      status: (row?.status as XeroConnectionView['status']) ?? 'DISCONNECTED',
      tenantName: row?.xeroTenantName ?? null,
      connectedAt: row?.connectedAt?.toISOString() ?? null,
      disconnectedAt: row?.disconnectedAt?.toISOString() ?? null,
      problem: row?.status === 'REAUTHORIZATION_REQUIRED' ? (row.lastRefreshError ?? 'Xero must be connected again.') : null,
      scopes: row?.scopes ?? [],
      organisation: connected ? ((row?.organisation as XeroOrganisation | null) ?? null) : null,
      accounts: connected ? ((row?.accounts as XeroAccount[] | null) ?? []) : [],
      taxRates: connected ? ((row?.taxRates as XeroTaxRate[] | null) ?? []) : [],
      readAt: connected ? (row?.catalogReadAt?.toISOString() ?? null) : null,
      readProblem: connected ? (row?.catalogReadError ?? null) : null,
      callsToday: allowance.used,
      dailyCeiling: allowance.ceiling,
      invoiceRemindersOn: connected ? (row?.invoiceRemindersOn ?? null) : null,
    };
  }

  /**
   * Finishes a sign-in: the tokens for the code, then which organisation was
   * chosen. Exactly one, and -- while one is connected -- the same one: a
   * sign-in that lands on another organisation would point the office's books
   * somewhere else without anything looking wrong, so it is refused and
   * nothing is stored. Then the organisation is read once.
   */
  async completeAuthorization(input: { code: string; state?: string }) {
    const state = this.auth.readState(input.state);
    return withTenant(state.organizationId, async () => {
      const tokens = await this.auth.exchange(input.code, state.codeVerifier);
      const event = authEventOf(tokens.access_token);
      const reached = (await this.client.connections(tokens.access_token)).filter(
        (tenant) => tenant.tenantType === 'ORGANISATION' && (!event || !tenant.authEventId || tenant.authEventId === event),
      );
      if (reached.length !== 1)
        throw new XeroError(
          reached.length ? 'Choose just one Xero organisation when connecting.' : 'No Xero organisation was chosen.',
          'XERO_ORGANISATION_CHOICE',
          409,
        );
      const tenant = reached[0]!;
      const previous = await this.prisma.xeroConnection.findUnique({
        where: { organizationId: state.organizationId },
        select: { status: true, xeroTenantId: true },
      });
      if (previous?.status === 'CONNECTED' && previous.xeroTenantId && previous.xeroTenantId !== tenant.tenantId)
        throw new XeroError(
          'That is a different Xero organisation from the one connected. Disconnect it first.',
          'XERO_ORGANISATION_MISMATCH',
          409,
        );
      await this.auth.store(state.organizationId, tokens, {
        xeroTenantId: tenant.tenantId,
        xeroTenantName: tenant.tenantName ?? null,
        xeroConnectionId: tenant.id,
        connectedByUserId: state.userId,
        connectedAt: new Date(),
        disconnectedAt: null,
      });
      await this.audit(state.organizationId, state.userId, 'XERO_CONNECTED', { tenantName: tenant.tenantName ?? null });
      // Read now, so the page has it; a failure here leaves it connected and says why.
      await this.read(state.organizationId, true).catch(() => undefined);
      return { name: tenant.tenantName ?? 'your Xero organisation' };
    });
  }

  /**
   * Reads the organisation, its accounts, its tax rates and whether its own
   * invoice reminders are on again: four calls, at most every five minutes.
   */
  async read(organizationId: string, force = false): Promise<XeroConnectionView> {
    const row = await this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, catalogReadAt: true } });
    if (row?.status !== 'CONNECTED') throw new XeroError('Xero is not connected.', 'XERO_NOT_CONNECTED', 409);
    if (!force && row.catalogReadAt && Date.now() - row.catalogReadAt.getTime() < READ_GAP_MS)
      throw new XeroError('Xero was read a moment ago. Try again in a few minutes.', 'XERO_READ_TOO_SOON', 429);
    try {
      const organisation = organisationFrom(await this.client.get(organizationId, '/Organisation', organisationsSchema));
      const accounts = accountsFrom(await this.client.get(organizationId, '/Accounts', accountsSchema));
      const taxRates = taxRatesFrom(await this.client.get(organizationId, '/TaxRates', taxRatesSchema));
      // Phase 3: on, Xero would email the office's clients beside the console. Not saying is not a reason to fail the read.
      const invoiceRemindersOn = await this.client
        .get(organizationId, '/InvoiceReminders/Settings', remindersSchema)
        .then(remindersFrom)
        .catch((error: unknown) => {
          if (error instanceof XeroError && READ_STOPPERS.has(error.code)) throw error;
          return null;
        });
      await this.prisma.xeroConnection.update({
        where: { organizationId },
        data: {
          organisation: organisation as unknown as Prisma.InputJsonValue,
          accounts: accounts as unknown as Prisma.InputJsonValue,
          taxRates: taxRates as unknown as Prisma.InputJsonValue,
          invoiceRemindersOn,
          catalogReadAt: new Date(),
          catalogReadError: null,
        },
      });
    } catch (error) {
      const message = error instanceof XeroError ? error.message : 'Xero could not be read.';
      await this.prisma.xeroConnection.updateMany({ where: { organizationId }, data: { catalogReadError: message } });
      if (error instanceof XeroError && error.code === 'XERO_REAUTHORIZATION_REQUIRED') await this.auth.requireReconnect(organizationId, message);
      throw error;
    }
    return this.describe(organizationId);
  }

  /** Ends the link at Xero, gives back the refresh token, and forgets the credentials here. */
  async disconnect(user: AuthenticatedUser): Promise<XeroConnectionView & { removedAtXero: boolean }> {
    const organizationId = user.organizationId;
    const row = await this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, xeroConnectionId: true } });
    let removedAtXero = false;
    if (row?.status === 'CONNECTED' && row.xeroConnectionId) {
      try {
        removedAtXero = await this.client.removeConnection(await this.auth.accessToken(organizationId), row.xeroConnectionId);
      } catch (error) {
        this.logger.warn({ event: 'xero_disconnect_remote_failed', organizationId, code: error instanceof XeroError ? error.code : undefined });
      }
      await this.auth.revoke(organizationId);
    }
    await this.prisma.xeroConnection.updateMany({
      where: { organizationId },
      data: {
        status: 'DISCONNECTED',
        accessTokenCiphertext: null,
        accessTokenExpiresAt: null,
        refreshTokenCiphertext: null,
        xeroConnectionId: null,
        disconnectedAt: new Date(),
      },
    });
    await this.audit(organizationId, user.id, 'XERO_DISCONNECTED', { removedAtXero });
    return { ...(await this.describe(organizationId)), removedAtXero };
  }

  private audit(organizationId: string, actorUserId: string | null, action: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: { organizationId, actorUserId, action, entityType: 'XeroConnection', entityId: organizationId, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
