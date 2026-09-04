import { PROPERTYWARE_MAX_PAGE_SIZE } from './propertyware.constants';
import type { PropertywareConfig } from './propertyware.types';

const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function getPropertywareConfig(env: NodeJS.ProcessEnv = process.env): PropertywareConfig {
  // The last mock left in the codebase, kept because propertyware.spec.ts is
  // real coverage of the sync and pagination logic and needs a source of pages
  // that does not call Propertyware.
  //
  // What is not kept is its reach. This selection means anything that is not
  // exactly 'live' resolves to mock, so an unset variable or a capitalised
  // 'Live' silently syncs fixture buildings into the real database looking
  // exactly like a successful sync. The fixtures stay available to tests; they
  // are now refused where they could be mistaken for tenant data.
  const provider = env.PROPERTYWARE_PROVIDER === 'live' ? 'live' : 'mock';
  if (provider === 'mock' && env.NODE_ENV === 'production')
    throw new Error(
      'Propertyware mock fixtures cannot be used in production. Set PROPERTYWARE_PROVIDER=live.',
    );
  const config: PropertywareConfig = {
    provider,
    store: env.PROPERTYWARE_STORE === 'prisma' ? 'prisma' : 'memory',
    baseUrl: (env.PROPERTYWARE_BASE_URL ?? 'https://api.propertyware.com/pw/api/rest/v1').replace(
      /\/$/,
      '',
    ),
    clientId: env.PROPERTYWARE_CLIENT_ID?.trim() || undefined,
    clientSecret: env.PROPERTYWARE_CLIENT_SECRET?.trim() || undefined,
    organizationId: env.PROPERTYWARE_ORGANIZATION_ID?.trim() || undefined,
    portfolioReportUrl: env.PROPERTYWARE_PORTFOLIO_REPORT_URL?.trim() || undefined,
    leaseReportUrl: env.PROPERTYWARE_LEASE_REPORT_URL?.trim() || undefined,
    tenantReportUrl: env.PROPERTYWARE_TENANT_REPORT_URL?.trim() || undefined,
    // After the 02:00 reconciliation, so tenancies match the buildings that
    // pass survived rather than the ones it was about to retire.
    tenantSyncCron: env.PROPERTYWARE_TENANT_SYNC_CRON?.trim() || '0 3 * * *',
    requestTimeoutMs: integer(env.PROPERTYWARE_REQUEST_TIMEOUT_MS, 30_000),
    pageSize: Math.min(integer(env.PROPERTYWARE_PAGE_SIZE, 500), PROPERTYWARE_MAX_PAGE_SIZE),
    maxRetries: integer(env.PROPERTYWARE_MAX_RETRIES, 4),
    syncEnabled: env.PROPERTYWARE_SYNC_ENABLED === 'true',
    incrementalSyncCron: env.PROPERTYWARE_INCREMENTAL_SYNC_CRON?.trim() || undefined,
    reconciliationCron: env.PROPERTYWARE_RECONCILIATION_CRON?.trim() || undefined,
    schedulerOrganizationId: env.PROPERTYWARE_LOCAL_ORGANIZATION_ID?.trim() || undefined,
    initialSyncLookbackDays: integer(env.PROPERTYWARE_INITIAL_SYNC_LOOKBACK_DAYS, 30),
    cursorOverlapSeconds: integer(env.PROPERTYWARE_CURSOR_OVERLAP_SECONDS, 120),
    databaseConcurrency: Math.min(integer(env.PROPERTYWARE_DATABASE_CONCURRENCY, 4), 8),
    databaseBatchSize: Math.min(integer(env.PROPERTYWARE_DATABASE_BATCH_SIZE, 50), 250),
  };
  if (!config.baseUrl.startsWith('https://'))
    throw new Error('PROPERTYWARE_BASE_URL must use HTTPS.');
  // Report URLs embed their own access token, so they are only ever fetched
  // without credentials — and must be pinned to Propertyware's own host so a
  // misconfigured value cannot send that token somewhere else.
  const assertReportUrl = (value: string | undefined, name: string) => {
    if (!value) return;
    const reportUrl = new URL(value);
    if (
      reportUrl.protocol !== 'https:' ||
      reportUrl.hostname !== 'app.propertyware.com' ||
      !reportUrl.pathname.startsWith('/pw/') ||
      !reportUrl.pathname.endsWith('/JSON')
    )
      throw new Error(`${name} must be an HTTPS Propertyware JSON report URL.`);
  };
  assertReportUrl(config.portfolioReportUrl, 'PROPERTYWARE_PORTFOLIO_REPORT_URL');
  assertReportUrl(config.leaseReportUrl, 'PROPERTYWARE_LEASE_REPORT_URL');
  assertReportUrl(config.tenantReportUrl, 'PROPERTYWARE_TENANT_REPORT_URL');
  if (provider === 'live' && (!config.clientId || !config.clientSecret || !config.organizationId))
    throw new Error(
      'Propertyware live mode requires client ID, client secret, and organization ID.',
    );
  return config;
}

export const PROPERTYWARE_CONFIG = Symbol('PROPERTYWARE_CONFIG');
