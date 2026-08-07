import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import type { CreatedIdentity, IdentityProvider } from '../admin/identity-provider';

/**
 * Credentials stored in our own database, replacing `SupabaseAdminGateway`.
 *
 * Cost 10 matches every hash imported from Supabase, so a re-hashed password
 * is indistinguishable from a migrated one and no account is quietly cheaper
 * to attack than its neighbours.
 */
const BCRYPT_COST = 10;

@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  createTechnicianIdentity(email: string, password: string, displayName: string) {
    return this.createIdentity(email, password, displayName, 'technician');
  }

  createWebUserIdentity(email: string, password: string, displayName: string) {
    return this.createIdentity(email, password, displayName, 'web user');
  }

  /**
   * Create a credential, and the profile stub it hangs off.
   *
   * Creating a `UserProfile` here looks like a layering violation, and is
   * instead a faithful port. Supabase ran a `SECURITY DEFINER` trigger,
   * `handle_texasrenters_auth_user`, that inserted a UserProfile on every
   * `auth.users` insert — which is why both provisioning services already
   * contain "claim the triggered profile" logic that looks up by authUserId or
   * email and updates rather than inserts. Doing the same keeps that path live
   * and means no caller changes.
   *
   * It is also what the foreign key requires. `AuthCredential.authUserId`
   * references `UserProfile.authUserId`, so the profile has to exist first, and
   * both are written in one transaction — a credential without a profile
   * authenticates and is then refused a step later, which is the pre-existing
   * seed drift this cannot be allowed to recreate.
   *
   * The profile is deliberately minimal. The caller's own transaction sets the
   * real display name, activates it, and attaches the organization membership;
   * until then this row is a placeholder, exactly as the trigger's was.
   */
  private async createIdentity(
    email: string,
    password: string,
    displayName: string,
    accountType: 'technician' | 'web user',
  ): Promise<CreatedIdentity> {
    const normalized = email.trim().toLowerCase();
    const authUserId = randomUUID();
    const passwordHash = await hash(password, BCRYPT_COST);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.userProfile.create({
          data: {
            authUserId,
            email: normalized,
            displayName: displayName.trim() || normalized.split('@')[0] || 'User',
          },
        });
        await tx.authCredential.create({
          data: {
            authUserId,
            email: normalized,
            passwordHash,
            // Every provisioned account starts with a temporary password, so
            // the holder must replace it before the account is usable. Was
            // app_metadata on the Supabase identity; a column now.
            mustChangePassword: true,
          },
        });
      });
    } catch {
      // The unique constraint on email or authUserId is the expected failure,
      // and it means the address is taken. Reported the same way the Supabase
      // gateway reported its own creation failure, so callers keep working.
      throw new ApplicationError(
        409,
        accountType === 'technician'
          ? 'TECHNICIAN_IDENTITY_NOT_CREATED'
          : 'USER_IDENTITY_NOT_CREATED',
        `A ${accountType} account could not be created for that email address.`,
      );
    }

    return { authUserId };
  }

  /**
   * Remove a credential and every session it holds.
   *
   * Deletes the credential, not the profile. Profile removal is
   * ProfileDeletionService's decision — it refuses accounts with history — and
   * this runs after that transaction commits. The refresh tokens go with the
   * credential by cascade, which matters: leaving them would let a deleted
   * account keep refreshing its way to fresh access tokens for thirty days.
   *
   * Missing is success. The caller swallows failures here on purpose, because
   * an orphaned credential is recoverable and a deleted profile whose
   * credential still signs in is not.
   */
  async deleteIdentity(authUserId: string) {
    await this.prisma.authCredential.deleteMany({ where: { authUserId } });
  }

  /**
   * Whether a credential exists.
   *
   * Fails closed by construction: this either answers from the database or
   * throws. The Supabase implementation had to distinguish a 404 from a
   * transport failure, because treating "cannot tell" as "does not exist"
   * would let provisioning clobber a live account.
   */
  async identityExists(authUserId: string) {
    const count = await this.prisma.authCredential.count({ where: { authUserId } });
    return count > 0;
  }

  /**
   * Replace a password and end every existing session.
   *
   * Not part of `IdentityProvider`: that interface covers provisioning and
   * deletion only. Password change is the account holder's own action and is
   * called directly by AuthService.
   *
   * Revoking sessions is the point. A password changed because it may have been
   * exposed has not been replaced at all if the sessions opened with the old
   * one keep working.
   */
  async setPassword(authUserId: string, password: string) {
    const passwordHash = await hash(password, BCRYPT_COST);
    await this.prisma.$transaction(async (tx) => {
      await tx.authCredential.update({
        where: { authUserId },
        data: { passwordHash, mustChangePassword: false },
      });
      await tx.authRefreshToken.updateMany({
        where: { authUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}
