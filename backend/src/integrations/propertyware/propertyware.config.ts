import { PROPERTYWARE_MAX_PAGE_SIZE } from './propertyware.constants';
import type { PropertywareConfig } from './propertyware.types';

const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function getPropertywareConfig(env: NodeJS.ProcessEnv = process.env): PropertywareConfig {
  const provider = env.PROPERTYWARE_PROVIDER === 'live' ? 'live' : 'mock';
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
    requestTimeoutMs: integer(env.PROPERTYWARE_REQUEST_TIMEOUT_MS, 30_000),
    pageSize: Math.min(integer(env.PROPERTYWARE_PAGE_SIZE, 500), PROPERTYWARE_MAX_PAGE_SIZE),
    maxRetries: integer(env.PROPERTYWARE_MAX_RETRIES, 4),
    syncEnabled: env.PROPERTYWARE_SYNC_ENABLED === 'true',
    incrementalSyncCron: env.PROPERTYWARE_INCREMENTAL_SYNC_CRON?.trim() || undefined,
    reconciliationCron: env.PROPERTYWARE_RECONCILIATION_CRON?.trim() || undefined,
    initialSyncLookbackDays: integer(env.PROPERTYWARE_INITIAL_SYNC_LOOKBACK_DAYS, 30),
    cursorOverlapSeconds: integer(env.PROPERTYWARE_CURSOR_OVERLAP_SECONDS, 120),
    databaseConcurrency: Math.min(integer(env.PROPERTYWARE_DATABASE_CONCURRENCY, 4), 8),
    databaseBatchSize: Math.min(integer(env.PROPERTYWARE_DATABASE_BATCH_SIZE, 50), 250),
  };
  if (!config.baseUrl.startsWith('https://'))
    throw new Error('PROPERTYWARE_BASE_URL must use HTTPS.');
  if (config.portfolioReportUrl) {
    const reportUrl = new URL(config.portfolioReportUrl);
    if (
      reportUrl.protocol !== 'https:' ||
      reportUrl.hostname !== 'app.propertyware.com' ||
      !reportUrl.pathname.startsWith('/pw/') ||
      !reportUrl.pathname.endsWith('/JSON')
    )
      throw new Error(
        'PROPERTYWARE_PORTFOLIO_REPORT_URL must be an HTTPS Propertyware JSON report URL.',
      );
  }
  if (provider === 'live' && (!config.clientId || !config.clientSecret || !config.organizationId))
    throw new Error(
      'Propertyware live mode requires client ID, client secret, and organization ID.',
    );
  return config;
}

export const PROPERTYWARE_CONFIG = Symbol('PROPERTYWARE_CONFIG');
