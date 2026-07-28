export interface MailConfig {
  provider: 'microsoft_graph';
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  senderAddress?: string;
  graphBaseUrl: string;
  connectionTimeoutMs: number;
  configured: boolean;
  missing: string[];
}

export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export function getMailConfig(environment: NodeJS.ProcessEnv = process.env): MailConfig {
  const values = {
    tenantId: environment.MICROSOFT_GRAPH_TENANT_ID?.trim() || undefined,
    clientId: environment.MICROSOFT_GRAPH_CLIENT_ID?.trim() || undefined,
    clientSecret: environment.MICROSOFT_GRAPH_CLIENT_SECRET || undefined,
    senderAddress: environment.MAIL_FROM_ADDRESS?.trim().toLowerCase() || undefined,
  };
  const labels: Record<keyof typeof values, string> = {
    tenantId: 'MICROSOFT_GRAPH_TENANT_ID',
    clientId: 'MICROSOFT_GRAPH_CLIENT_ID',
    clientSecret: 'MICROSOFT_GRAPH_CLIENT_SECRET',
    senderAddress: 'MAIL_FROM_ADDRESS',
  };
  const missing = (Object.keys(values) as Array<keyof typeof values>)
    .filter((key) => !values[key])
    .map((key) => labels[key]);

  return {
    provider: 'microsoft_graph',
    ...values,
    graphBaseUrl: (
      environment.MICROSOFT_GRAPH_BASE_URL?.trim() || 'https://graph.microsoft.com'
    ).replace(/\/$/, ''),
    connectionTimeoutMs: Number(environment.MAIL_CONNECTION_TIMEOUT_MS || 10_000),
    configured: missing.length === 0,
    missing,
  };
}
