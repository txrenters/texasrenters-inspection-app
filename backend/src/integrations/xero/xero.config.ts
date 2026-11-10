/**
 * The Xero app this server uses (2026-11-10), from its environment.
 *
 * Every Xero host is pinned, as Jobber's are: a mistyped or tampered URL must
 * never receive the authorization code, the client secret or a token.
 */

export interface XeroConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Space-separated: `XERO_SEND_SCOPES` unless `XERO_SCOPES` says otherwise. */
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string;
  connectionsUrl: string;
  apiUrl: string;
  /** Xero's Projects API (2026-11-11): projects, their tasks and time. */
  projectsApiUrl: string;
  requestTimeoutMs: number;
  /** The console's own ceiling on calls to Xero a Texas day, under Xero's 1,000 on its free tier. */
  dailyCallCeiling: number;
}

const XERO_HOSTS = new Set(['login.xero.com', 'identity.xero.com', 'api.xero.com']);

const pinned = (value: string, name: string) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !XERO_HOSTS.has(url.hostname))
    throw new Error(`${name} must be an HTTPS URL on login.xero.com, identity.xero.com or api.xero.com.`);
  return value.replace(/\/$/, '');
};

const integer = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

/** Phase 1 read only: refresh tokens, and the organisation's settings. */
export const XERO_READ_SCOPES = 'offline_access accounting.settings.read';

/**
 * Phase 3 sends invoices, so it writes contacts and invoices; payments are
 * asked for now too, so phase 4 needs no second "Connect again". A connection
 * made with only the read scopes keeps reading and is asked to connect again.
 * And projects (2026-11-11): a project for each visit, with its labour as
 * time. A connection made before keeps sending; a company that turns projects
 * on is asked to connect again. If Xero ever refused the scope for this app,
 * `XERO_SCOPES` (without it) keeps "Connect" working.
 */
export const XERO_SEND_SCOPES = `${XERO_READ_SCOPES} accounting.contacts accounting.invoices accounting.payments projects`;

export function getXeroConfig(env: NodeJS.ProcessEnv = process.env): XeroConfig {
  return {
    clientId: env.XERO_CLIENT_ID?.trim() || undefined,
    clientSecret: env.XERO_CLIENT_SECRET?.trim() || undefined,
    redirectUri: env.XERO_OAUTH_REDIRECT_URI?.trim() || undefined,
    scopes: env.XERO_SCOPES?.trim() || XERO_SEND_SCOPES,
    authorizeUrl: pinned(env.XERO_OAUTH_AUTHORIZE_URL?.trim() || 'https://login.xero.com/identity/connect/authorize', 'XERO_OAUTH_AUTHORIZE_URL'),
    tokenUrl: pinned(env.XERO_OAUTH_TOKEN_URL?.trim() || 'https://identity.xero.com/connect/token', 'XERO_OAUTH_TOKEN_URL'),
    revocationUrl: pinned(env.XERO_OAUTH_REVOCATION_URL?.trim() || 'https://identity.xero.com/connect/revocation', 'XERO_OAUTH_REVOCATION_URL'),
    connectionsUrl: pinned(env.XERO_CONNECTIONS_URL?.trim() || 'https://api.xero.com/connections', 'XERO_CONNECTIONS_URL'),
    apiUrl: pinned(env.XERO_API_URL?.trim() || 'https://api.xero.com/api.xro/2.0', 'XERO_API_URL'),
    projectsApiUrl: pinned(env.XERO_PROJECTS_API_URL?.trim() || 'https://api.xero.com/projects.xro/2.0', 'XERO_PROJECTS_API_URL'),
    requestTimeoutMs: integer(env.XERO_REQUEST_TIMEOUT_MS, 20_000, 60_000),
    // Never above Xero's own 1,000: the ceiling is ours to stay under theirs.
    dailyCallCeiling: integer(env.XERO_DAILY_CALL_CEILING, 300, 1_000),
  };
}

/** Whether this server can start a connection at all. */
export const xeroConfigured = (config: XeroConfig) => Boolean(config.clientId && config.clientSecret && config.redirectUri);
