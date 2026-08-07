import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuthService } from './auth.service';
import { LocalIdentityProvider } from './local-identity.provider';

/**
 * Password reset against our own tokens, replacing Supabase's
 * `generateLink({ type: 'recovery' })`.
 *
 * The token buys a password change and nothing else. Supabase's was redeemed
 * with `verifyOtp` for a full **session**, which meant anyone holding the email
 * was signed in and then merely expected to change the password. A link sent in
 * the clear should not be a login, so there is no session anywhere in this flow.
 *
 * Delivery was never Supabase's: `generateLink` mints without sending, and the
 * mail already goes out through Microsoft Graph. Only the token changes.
 */

/**
 * One hour. Supabase defaulted to considerably longer, and a reset link is a
 * bearer credential sitting in a mailbox — the cost of it being short is one
 * more click on a form that is already in front of the person.
 */
const DEFAULT_TTL_MINUTES = 60;

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LocalIdentityProvider) private readonly identities: LocalIdentityProvider,
    @Inject(AuthService) private readonly supabase: AuthService,
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
  ) {}

  /**
   * Whether resets run against our own tokens or still against Supabase.
   *
   * The same switch that selects the identity provider, read here rather than
   * in the controller: which credential store holds the password and which
   * system mints the reset link have to be the same answer, and a second flag
   * would eventually be set to disagree with the first.
   */
  private usingLocalProvider() {
    return process.env.AUTH_IDENTITY_PROVIDER?.trim().toLowerCase() === 'local';
  }

  private ttlMs() {
    const raw = Number(process.env.AUTH_PASSWORD_RESET_TTL_MINUTES);
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MINUTES;
    return minutes * 60 * 1000;
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Mint a reset link and mail it.
   *
   * Resolves the same way whatever the address turns out to be. Telling an
   * anonymous caller that an account does not exist would make this form an
   * oracle for which administrator addresses are real, so a miss is logged and
   * answered identically to a hit.
   */
  async request(email: string) {
    if (!this.usingLocalProvider()) return this.supabase.requestPasswordReset(email);

    const normalized = email.trim().toLowerCase();
    const credential = await this.prisma.authCredential.findUnique({
      where: { email: normalized },
      select: { authUserId: true, profile: { select: { displayName: true, isActive: true } } },
    });

    // A deactivated account is treated exactly like an absent one. Mailing a
    // working reset link to someone whose access was revoked would undo the
    // revocation.
    if (!credential || !credential.profile.isActive) {
      this.logger.warn({ event: 'password_reset_link_unavailable' });
      return;
    }

    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      // Outstanding links for this account are retired first. Otherwise every
      // request leaves another live credential in another mailbox, and asking
      // twice quietly doubles the exposure.
      await tx.authPasswordResetToken.updateMany({
        where: { authUserId: credential.authUserId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.authPasswordResetToken.create({
        data: {
          authUserId: credential.authUserId,
          tokenHash: this.hash(token),
          expiresAt: new Date(Date.now() + this.ttlMs()),
        },
      });
    });

    const origin = (process.env.WEB_APP_ORIGIN ?? '').replace(/\/$/, '');
    const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    const delivery = await this.mailer?.sendPasswordReset({
      to: normalized,
      displayName: credential.profile.displayName,
      resetUrl,
    });
    if (delivery?.status !== 'SENT')
      this.logger.warn({ event: 'password_reset_email_failed', status: delivery?.status });
  }

  /**
   * Redeem a reset token for a new password.
   *
   * Single use, and every session is revoked on success. Someone resetting a
   * password has usually lost control of something; leaving the sessions opened
   * with the old password alive would defeat the reset entirely — which
   * `setPassword` handles as part of the same transaction.
   */
  async reset(token: string, password: string) {
    // While Supabase still mints the links, no token here can be ours. Refusing
    // outright beats a lookup that always misses and reports "invalid link" for
    // a link that was perfectly good.
    if (!this.usingLocalProvider())
      throw new ApplicationError(
        503,
        'RESET_NOT_AVAILABLE',
        'Password reset is handled by the identity provider for this deployment.',
      );

    const record = await this.prisma.authPasswordResetToken.findUnique({
      where: { tokenHash: this.hash(token) },
      select: {
        id: true,
        authUserId: true,
        expiresAt: true,
        consumedAt: true,
        credential: { select: { profile: { select: { isActive: true } } } },
      },
    });

    // One message for every failure: unknown, already used, expired, or
    // belonging to a deactivated account. Distinguishing them would tell a
    // caller holding a guessed token which guesses were closer.
    const invalid = new ApplicationError(
      400,
      'RESET_TOKEN_INVALID',
      'That password reset link is no longer valid. Request a new one.',
    );

    if (!record || record.consumedAt) throw invalid;
    if (record.expiresAt.getTime() <= Date.now()) throw invalid;
    if (!record.credential.profile.isActive) throw invalid;

    // Consumed first, and only if still unconsumed. Two requests arriving
    // together would otherwise both pass the check above and both set a
    // password — the loser silently overwriting the winner.
    const { count } = await this.prisma.authPasswordResetToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) throw invalid;

    await this.identities.setPassword(record.authUserId, password);
  }
}
