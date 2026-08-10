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

  /**
   * Password reset, sent by us rather than by Supabase's stock template.
   *
   * The link is minted server-side with the service role, so it carries no PKCE
   * verifier and works in whatever browser the mail is opened in — the stock
   * flow could only be completed in the browser that asked for it.
   */
  sendPasswordReset(input: { to: string; displayName?: string | null; resetUrl: string }) {
    const greeting = input.displayName ? `Hello ${escapeHtml(input.displayName)},` : 'Hello,';
    const safeUrl = escapeHtml(input.resetUrl);
    return this.deliver({
      to: input.to,
      subject: 'Reset your TexasRenters password',
      html: this.layout(
        'Reset your password',
        `<p>${greeting}</p>
         <p>Someone asked to reset the password for this TexasRenters administrator account.
            Choose a new one using the link below.</p>
         <p><a href="${safeUrl}">Choose a new password</a></p>
         <p>The link can be used once and expires shortly. If you did not ask for this, no
            action is needed — your current password still works and nothing has changed.</p>`,
      ),
      template: 'password-reset',
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

  /**
   * Tells a technician an inspection is theirs.
   *
   * The socket event and the push notification both reach a running app on a
   * device that is online. This is the one that survives a flat battery, a
   * reinstall, or a technician who has not opened the app since Friday — so it
   * carries the address and the date rather than "you have a new assignment",
   * which would only be useful next to the app it is standing in for.
   */
  sendInspectionAssignment(input: {
    to: string;
    displayName: string;
    propertyLabel: string;
    unitLabel: string | null;
    inspectionType: string;
    scheduledAt: Date;
  }) {
    // Date only. `scheduledAt` is a DATE column serialised as midnight UTC, so
    // rendering a time would invent one, and reading it in local time would
    // move it to the previous evening in Texas.
    const scheduled = input.scheduledAt.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const readableType = input.inspectionType.replaceAll('_', ' ').toLowerCase();
    const where = input.unitLabel
      ? `${escapeHtml(input.propertyLabel)} — ${escapeHtml(input.unitLabel)}`
      : escapeHtml(input.propertyLabel);
    return this.deliver({
      to: input.to,
      subject: `New inspection assigned — ${input.propertyLabel}`,
      html: this.layout(
        'You have a new inspection',
        `<p>Hello ${escapeHtml(input.displayName)},</p>
         <p>An inspection has been assigned to you.</p>
         <p><strong>Property:</strong> ${where}<br>
         <strong>Type:</strong> ${escapeHtml(readableType)}<br>
         <strong>Scheduled:</strong> ${escapeHtml(scheduled)}</p>
         <p>Open the TexasRenters mobile application to begin.</p>`,
      ),
      template: 'inspection-assignment',
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
