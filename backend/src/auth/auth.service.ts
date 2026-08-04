import {
  BadGatewayException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  /**
   * Sends a branded password reset, replacing Supabase's stock template.
   *
   * Always resolves the same way whatever the address turns out to be. Telling
   * an anonymous caller that an account does not exist would make this form an
   * oracle for which administrator addresses are real, so a miss is logged and
   * answered identically to a hit.
   *
   * The link is generated with the service role rather than requested from the
   * browser, which is also what makes it usable on a different device from the
   * one that asked — the browser flow ties the link to a verifier held only by
   * the requesting browser.
   */
  async requestPasswordReset(email: string) {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey)
      throw new ServiceUnavailableException('Password management is not configured.');

    const redirectTo = `${(process.env.WEB_APP_ORIGIN ?? '').replace(/\/$/, '')}/reset-password`;
    const admin = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }).auth.admin;

    const link = await admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
    if (link.error || !link.data.properties?.action_link) {
      // Includes "user not found", which is not an error the caller may see.
      this.logger.warn({ event: 'password_reset_link_unavailable' });
      return;
    }

    const profile = await this.prisma?.userProfile.findFirst({
      where: { email },
      select: { displayName: true },
    });
    const delivery = await this.mailer?.sendPasswordReset({
      to: email,
      displayName: profile?.displayName ?? null,
      resetUrl: link.data.properties.action_link,
    });
    if (delivery?.status !== 'SENT')
      this.logger.warn({ event: 'password_reset_email_failed', status: delivery?.status });
  }

  async changeRequiredPassword(authUserId: string, password: string) {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey)
      throw new ServiceUnavailableException('Password management is not configured.');

    const admin = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }).auth.admin;
    const current = await admin.getUserById(authUserId);
    if (current.error || !current.data.user)
      throw new BadGatewayException('The password could not be updated.');
    if (current.data.user.app_metadata.must_change_password !== true)
      throw new ForbiddenException('This account does not require a password replacement.');

    const updated = await admin.updateUserById(authUserId, {
      password,
      app_metadata: {
        ...current.data.user.app_metadata,
        must_change_password: false,
      },
    });
    if (updated.error) throw new BadGatewayException('The password could not be updated.');
  }
}
