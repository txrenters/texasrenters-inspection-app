import { Inject, Injectable, Logger } from '@nestjs/common';

import { MAIL_CONFIG, type MailConfig } from './mail.config';
import type { MailTransport } from './microsoft-graph-mail.client';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type MailDeliveryStatus = 'SENT' | 'NOT_CONFIGURED' | 'FAILED';

export interface MailDeliveryResult {
  status: MailDeliveryStatus;
  message: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_CONFIG) private readonly config: MailConfig,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport | null,
  ) {}

  readiness() {
    if (!this.config.configured)
      return {
        provider: 'Mailer',
        status: 'NOT_CONFIGURED' as const,
        detail: `Missing ${this.config.missing.join(', ')}.`,
      };
    return {
      provider: 'Mailer',
      status: 'CONFIGURED' as const,
      detail: `Microsoft Graph | ${this.config.senderAddress}`,
    };
  }

  async verify(): Promise<MailDeliveryResult> {
    if (!this.transport) return this.notConfigured();
    try {
      await this.transport.verify();
      return { status: 'SENT', message: 'Microsoft Graph authentication verified.' };
    } catch {
      this.logger.warn({ event: 'microsoft_graph_verification_failed' });
      return {
        status: 'FAILED',
        message:
          'Microsoft Graph authentication could not be verified. Check the app registration and permissions.',
      };
    }
  }

  sendTest(to: string) {
    return this.deliver({
      to,
      subject: 'TexasRenters mail integration test',
      html: this.layout(
        'Mail integration verified',
        '<p>Your TexasRenters Microsoft Graph integration is configured and able to send mail.</p>',
      ),
      template: 'test',
    });
  }

  sendAccountInvitation(input: {
    to: string;
    displayName: string;
    temporaryPassword: string;
    application: 'web' | 'mobile';
    loginUrl?: string;
  }) {
    const destination =
      input.application === 'web'
        ? input.loginUrl
          ? `Sign in at ${input.loginUrl}`
          : 'Open the TexasRenters administrator application.'
        : 'Open the TexasRenters mobile application.';
    const safeName = escapeHtml(input.displayName);
    const safePassword = escapeHtml(input.temporaryPassword);
    const safeDestination = escapeHtml(destination);
    return this.deliver({
      to: input.to,
      subject: 'Your TexasRenters account is ready',
      html: this.layout(
        'Your account is ready',
        `<p>Hello ${safeName},</p>
         <p>Your TexasRenters account is ready. ${safeDestination}</p>
         <p><strong>Email:</strong> ${escapeHtml(input.to)}<br>
         <strong>Temporary password:</strong> <code>${safePassword}</code></p>
         <p>You must replace this password immediately after your first sign-in.</p>`,
      ),
      template: 'account-invitation',
    });
  }

  sendReportShare(input: { to: string; reportUrl: string; expiresAt: Date }) {
    const expiry = input.expiresAt.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return this.deliver({
      to: input.to,
      subject: 'Your TexasRenters inspection report',
      html: this.layout(
        'Your inspection report is ready',
        `<p>Your inspection report is ready to view.</p>
         <p><a href="${escapeHtml(input.reportUrl)}">Open inspection report</a></p>
         <p>This private link expires on ${escapeHtml(expiry)}.</p>`,
      ),
      template: 'report-share',
    });
  }

  private async deliver(input: {
    to: string;
    subject: string;
    html: string;
    template: string;
  }): Promise<MailDeliveryResult> {
    if (!this.transport || !this.config.senderAddress) return this.notConfigured();
    try {
      await this.transport.sendMail({
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
      return { status: 'SENT', message: 'Email sent successfully.' };
    } catch {
      // Do not log addresses, credentials, message bodies, or upstream errors.
      this.logger.warn({ event: 'mail_delivery_failed', template: input.template });
      return {
        status: 'FAILED',
        message: 'The email could not be delivered. The generated content remains available.',
      };
    }
  }

  private notConfigured(): MailDeliveryResult {
    return {
      status: 'NOT_CONFIGURED',
      message: 'Microsoft Graph mail is not fully configured.',
    };
  }

  private layout(title: string, content: string) {
    return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#10213f">
    <div style="max-width:600px;margin:0 auto;padding:32px 20px">
      <div style="background:#fff;border:1px solid #d9e2ef;border-radius:16px;padding:28px">
        <div style="font-size:20px;font-weight:700;margin-bottom:20px">TexasRenters</div>
        <h1 style="font-size:24px;margin:0 0 16px">${escapeHtml(title)}</h1>
        <div style="font-size:16px;line-height:1.6">${content}</div>
      </div>
    </div>
  </body>
</html>`;
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
