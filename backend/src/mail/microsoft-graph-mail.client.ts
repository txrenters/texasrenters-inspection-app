import { z } from 'zod';

import type { MailConfig } from './mail.config';

export interface GraphMailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface MailTransport {
  verify(): Promise<void>;
  sendMail(message: GraphMailMessage): Promise<void>;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
  token_type: z.string().optional(),
});

export class MicrosoftGraphMailClient implements MailTransport {
  private accessToken?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  constructor(
    private readonly config: MailConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async verify() {
    await this.getAccessToken();
  }

  async sendMail(message: GraphMailMessage) {
    const response = await this.request(
      `${this.config.graphBaseUrl}/v1.0/users/${encodeURIComponent(this.config.senderAddress!)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: { contentType: 'HTML', content: message.html },
            toRecipients: [{ emailAddress: { address: message.to } }],
          },
          saveToSentItems: true,
        }),
      },
    );
    if (response.status !== 202) throw new Error('Microsoft Graph rejected the mail request.');
  }

  private async getAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = this.requestAccessToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async requestAccessToken() {
    const tenant = encodeURIComponent(this.config.tenantId!);
    const response = await this.request(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId!,
          client_secret: this.config.clientSecret!,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }).toString(),
      },
    );
    if (!response.ok) throw new Error('Microsoft identity authentication failed.');
    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Microsoft identity returned an invalid token response.');
    const refreshBufferMs = Math.min(60_000, Math.floor(parsed.data.expires_in * 100));
    this.accessToken = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1_000 - refreshBufferMs,
    };
    return this.accessToken.value;
  }

  private request(url: string, init: RequestInit) {
    return this.fetchImplementation(url, {
      ...init,
      signal: AbortSignal.timeout(this.config.connectionTimeoutMs),
    });
  }
}
