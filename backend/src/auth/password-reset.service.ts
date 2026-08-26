import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
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
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
  ) {}

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

    await this.issueAndDeliver({
      authUserId: credential.authUserId,
      email: normalized,
      displayName: credential.profile.displayName,
    });
  }

  /**
   * Mint a link and mail it. Shared by the anonymous form and the admin
   * button, so both retire outstanding tokens the same way and neither can
   * drift into a weaker version of the other.
   *
   * Returns whether the mail actually left, which the anonymous caller
   * discards and the administrator is shown — see `sendForTechnician`.
   */
  private async issueAndDeliver(account: {
    authUserId: string;
    email: string;
    displayName: string;
  }) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      // Outstanding links for this account are retired first. Otherwise every
      // request leaves another live credential in another mailbox, and asking
      // twice quietly doubles the exposure.
      await tx.authPasswordResetToken.updateMany({
        where: { authUserId: account.authUserId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.authPasswordResetToken.create({
        data: {
          authUserId: account.authUserId,
          tokenHash: this.hash(token),
          expiresAt: new Date(Date.now() + this.ttlMs()),
        },
      });
    });

    const origin = (process.env.WEB_APP_ORIGIN ?? '').replace(/\/$/, '');
    const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    const delivery = await this.mailer?.sendPasswordReset({
      to: account.email,
      displayName: account.displayName,
      resetUrl,
    });
    if (delivery?.status !== 'SENT')
      this.logger.warn({ event: 'password_reset_email_failed', status: delivery?.status });
    return delivery?.status === 'SENT';
  }

  /**
   * An administrator sends a technician a reset link.
   *
   * **This deliberately does not hide whether the account exists.** The
   * anonymous form answers every address identically so it cannot be used to
   * discover which ones are real; that protection is for a stranger. An
   * administrator has already read this technician out of their own roster, so
   * repeating the silence here would only mean clicking "send" and being told
   * nothing while nothing happened — the failure they are least equipped to
   * diagnose and most likely to blame on the technician's mailbox.
   *
   * Scoped through an `INSPECTION_TECHNICIAN` membership in the caller's own
   * organization, which does two jobs at once: an administrator cannot reach
   * another tenant's people, and cannot turn a permission called "create
   * technicians" into a way to mint a reset link for an administrator.
   */
  async sendForTechnician(user: AuthenticatedUser, technicianId: string) {
    const technician = await this.prisma.userProfile.findFirst({
      where: {
        id: technicianId,
        memberships: {
          some: {
            organizationId: user.organizationId,
            role: UserRole.INSPECTION_TECHNICIAN,
          },
        },
      },
      select: { id: true, authUserId: true, email: true, displayName: true, isActive: true },
    });

    // Indistinguishable from "not a technician" and from "another tenant's
    // technician", on purpose: all three are equally none of this caller's
    // business, and a more specific message would describe the roster of an
    // organization they cannot see.
    if (!technician)
      throw new ApplicationError(404, 'TECHNICIAN_NOT_FOUND', 'Technician not found.');

    // Same rule the anonymous path applies, but said out loud. Mailing a
    // working reset link to somebody whose access was revoked would undo the
    // revocation, and an administrator who just deactivated this account needs
    // to be told that rather than left assuming the mail is in flight.
    if (!technician.isActive)
      throw new ApplicationError(
        409,
        'TECHNICIAN_INACTIVE',
        'This technician is deactivated. Reactivate the account before sending a reset link.',
      );

    const credential = await this.prisma.authCredential.findUnique({
      where: { authUserId: technician.authUserId },
      select: { id: true },
    });
    if (!credential)
      throw new ApplicationError(
        409,
        'TECHNICIAN_HAS_NO_CREDENTIAL',
        'This technician has no sign-in credential yet, so there is no password to reset.',
      );

    const sent = await this.issueAndDeliver({
      authUserId: technician.authUserId,
      email: technician.email,
      displayName: technician.displayName,
    });

    // Audited whether or not the mail left. Issuing the token is the sensitive
    // act -- a live credential now exists in a mailbox -- and it happened even
    // when delivery failed, so a record that only covered successes would omit
    // exactly the cases somebody later needs to reconstruct.
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'PASSWORD_RESET_SENT',
        entityType: 'UserProfile',
        entityId: technician.id,
        metadata: { delivered: sent },
      },
    });

    return { email: technician.email, delivered: sent };
  }

  /**
   * Replace a temporary password.
   *
   * Every provisioned account starts with one and cannot do anything until it
   * is replaced — the permission guards refuse while `mustChangePassword` is
   * set. So this is the single step between "account created" and "account
   * usable", and it was the last thing still reaching for Supabase: after the
   * cutover it answered 502 and locked out every new technician.
   *
   * The requirement is re-checked against the database rather than trusted from
   * the token. The guard that admits the caller reads the claim, which is fixed
   * at sign-in; the column is what `setPassword` clears, and the two would
   * disagree for the life of a token otherwise.
   */
  async changeRequiredPassword(authUserId: string, password: string) {
    const credential = await this.prisma.authCredential.findUnique({
      where: { authUserId },
      select: { mustChangePassword: true },
    });
    if (!credential)
      throw new ApplicationError(404, 'ACCOUNT_NOT_FOUND', 'That account no longer exists.');
    if (!credential.mustChangePassword)
      throw new ApplicationError(
        403,
        'PASSWORD_CHANGE_NOT_REQUIRED',
        'This account does not require a password replacement.',
      );
    // Clears the flag and revokes every session in one transaction.
    await this.identities.setPassword(authUserId, password);
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
