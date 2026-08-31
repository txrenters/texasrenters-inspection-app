import type { JobberConfig } from './jobber.types';

const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Every Jobber host we will talk to. Pinned so a bad env cannot redirect the
 * authorization code — or the client secret — to somebody else's server. */
const JOBBER_HOSTS = new Set(['api.getjobber.com']);

const assertJobberUrl = (value: string, name: string) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !JOBBER_HOSTS.has(url.hostname))
    throw new Error(`${name} must be an HTTPS api.getjobber.com URL.`);
  return value.replace(/\/$/, '');
};

export function getJobberConfig(env: NodeJS.ProcessEnv = process.env): JobberConfig {
  const config: JobberConfig = {
    clientId: env.JOBBER_CLIENT_ID?.trim() || undefined,
    clientSecret: env.JOBBER_CLIENT_SECRET?.trim() || undefined,
    // No fallback, deliberately. Jobber resolves a missing version header to
    // "current", so a default here would silently follow their breaking
    // changes. It is left empty rather than thrown on at boot so a deployment
    // that does not use Jobber still starts; JobberClient refuses to send a
    // request without it, which is the point where it actually matters.
    apiVersion: env.JOBBER_API_VERSION?.trim() || '',
    graphqlUrl: assertJobberUrl(
      env.JOBBER_GRAPHQL_URL?.trim() || 'https://api.getjobber.com/api/graphql',
      'JOBBER_GRAPHQL_URL',
    ),
    authorizeUrl: assertJobberUrl(
      env.JOBBER_OAUTH_AUTHORIZE_URL?.trim() || 'https://api.getjobber.com/api/oauth/authorize',
      'JOBBER_OAUTH_AUTHORIZE_URL',
    ),
    tokenUrl: assertJobberUrl(
      env.JOBBER_OAUTH_TOKEN_URL?.trim() || 'https://api.getjobber.com/api/oauth/token',
      'JOBBER_OAUTH_TOKEN_URL',
    ),
    redirectUri: env.JOBBER_OAUTH_REDIRECT_URI?.trim() || undefined,
    requestTimeoutMs: integer(env.JOBBER_REQUEST_TIMEOUT_MS, 30_000),
    maxRetries: integer(env.JOBBER_MAX_RETRIES, 4),
    // Fail closed. Anything that is not exactly "true" leaves the sync off, so
    // a typo cannot start writing Jobber visits into inspections.
    syncEnabled: env.JOBBER_SYNC_ENABLED === 'true',
    schedulerOrganizationId: env.JOBBER_LOCAL_ORGANIZATION_ID?.trim() || undefined,
    incrementalSyncCron: env.JOBBER_INCREMENTAL_SYNC_CRON?.trim() || undefined,
    // Seven days back covers a visit that was completed late or moved
    // backwards; sixty forward is roughly the horizon the office schedules on.
    syncLookbackDays: integer(env.JOBBER_SYNC_LOOKBACK_DAYS, 7),
    syncHorizonDays: integer(env.JOBBER_SYNC_HORIZON_DAYS, 60),
    // Off unless explicitly turned on. A share token is a bearer link to
    // photographs of somebody's home, and whether a Jobber job note is visible
    // in the client hub is account configuration this backend cannot read.
    // Completion is pushed regardless; only the link waits on a human check.
    pushReportLink: env.JOBBER_PUSH_REPORT_LINK === 'true',
  };
  if (config.redirectUri) {
    const redirect = new URL(config.redirectUri);
    // Jobber matches the redirect URI byte for byte at code exchange, and an
    // http:// callback would put the authorization code on the wire in clear.
    if (redirect.protocol !== 'https:')
      throw new Error('JOBBER_OAUTH_REDIRECT_URI must use HTTPS.');
  }
  if (
    config.syncEnabled &&
    (!config.clientId || !config.clientSecret || !config.redirectUri || !config.apiVersion)
  )
    throw new Error(
      'Jobber sync requires JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_OAUTH_REDIRECT_URI, and JOBBER_API_VERSION.',
    );
  return config;
}

export const JOBBER_CONFIG = Symbol('JOBBER_CONFIG');
