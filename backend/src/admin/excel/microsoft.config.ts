/**
 * Signing the office's Microsoft account in for the Actual vs Budget workbook
 * (2026-11-17). The app is the one the mailer already uses
 * (MICROSOFT_GRAPH_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET): Entra gives it the
 * delegated Files.ReadWrite and offline_access permissions and this redirect
 * address, and a person who may edit the workbook signs in once.
 *
 * Microsoft's Excel API takes delegated permissions only -- "Application: Not
 * supported" on every workbook call -- which is why the mailer's own
 * app-only sign-in cannot do this.
 */
export interface MicrosoftConfig {
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** Where Microsoft sends the person back: this API's /admin/actual-vs-budget/excel/callback. */
  redirectUri?: string;
  graphBaseUrl: string;
  scopes: string;
  requestTimeoutMs: number;
  /** The most workbook calls one run of the sync may make: a run that needs more waits for the next. */
  callsPerRun: number;
}

const trimmed = (value: string | undefined) => value?.trim() || undefined;
const number = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export function getMicrosoftConfig(environment: NodeJS.ProcessEnv = process.env): MicrosoftConfig {
  return {
    tenantId: trimmed(environment.MICROSOFT_GRAPH_TENANT_ID),
    clientId: trimmed(environment.MICROSOFT_GRAPH_CLIENT_ID),
    clientSecret: environment.MICROSOFT_GRAPH_CLIENT_SECRET || undefined,
    redirectUri: trimmed(environment.MICROSOFT_EXCEL_REDIRECT_URI),
    graphBaseUrl: (trimmed(environment.MICROSOFT_GRAPH_BASE_URL) ?? 'https://graph.microsoft.com').replace(/\/$/, ''),
    // offline_access: a refresh token, so nobody signs in again. User.Read: whose account it is.
    scopes: 'offline_access User.Read Files.ReadWrite',
    requestTimeoutMs: number(environment.MICROSOFT_REQUEST_TIMEOUT_MS, 20_000, 1_000, 60_000),
    callsPerRun: number(environment.MICROSOFT_EXCEL_CALLS_PER_RUN, 80, 10, 500),
  };
}

export const microsoftConfigured = (config: MicrosoftConfig) => Boolean(config.tenantId && config.clientId && config.clientSecret && config.redirectUri);

export const loginBase = (config: MicrosoftConfig) => `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId ?? 'organizations')}/oauth2/v2.0`;
