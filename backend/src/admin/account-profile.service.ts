import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import {
  normalizePhoneNumber,
  PHONE_NUMBER_HINT,
  type UpdateAccountProfileInput,
} from '@texasrenters/shared';

import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { CONSOLE_ROLES } from './access.service';
import type { ProfileScope } from './profile-deletion.service';

const emailInUse = () =>
  new ApplicationError(409, 'EMAIL_IN_USE', 'Another account already signs in with that email.');

/**
 * A person's own details: name, sign-in email and phone.
 *
 * One service for the user page and the technician page, because they are one
 * account (`console-and-technician-share-one-account`). Which page is asking
 * decides only who may be found -- `ProfileScope`, as for deletion -- so
 * `technicians:manage` cannot reach a console-only administrator by id, and
 * `users:manage` cannot reach a technician who has no console access.
 *
 * The email is the sensitive field. It is the address sign-in resolves an
 * account by (`AuthCredential.email`), the address reset links go to
 * (`UserProfile.email`) and the address Jobber's assignees are matched on, so
 * the two columns move together in one transaction, any reset link already
 * mailed to the old address is retired, and the change is audited from and to.
 */
@Injectable()
export class AccountProfileService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

  async update(
    actor: AuthenticatedUser,
    profileId: string,
    scope: ProfileScope,
    input: UpdateAccountProfileInput,
  ): Promise<void> {
    const profile = await this.requireProfile(actor, profileId, scope);
    const data: Prisma.UserProfileUpdateInput = {};
    const changed: string[] = [];
    const trail: Record<string, { from: string; to: string }> = {};

    if (input.displayName !== undefined) {
      const displayName = input.displayName.trim();
      if (displayName.length < 2)
        throw new ApplicationError(
          400,
          'INVALID_DISPLAY_NAME',
          'Enter a name of at least two characters.',
        );
      if (displayName !== profile.displayName) {
        data.displayName = displayName;
        changed.push('displayName');
        trail.displayName = { from: profile.displayName, to: displayName };
      }
    }

    if (input.phone !== undefined) {
      const typed = input.phone?.trim() ?? '';
      const phone = typed ? normalizePhoneNumber(typed) : null;
      if (typed && !phone)
        throw new ApplicationError(
          400,
          'INVALID_PHONE',
          `That is not a phone number we can read. ${PHONE_NUMBER_HINT}`,
        );
      // The number itself stays out of the audit trail: that the number
      // changed, and who changed it, is what a later reader needs.
      if (phone !== profile.phone) {
        data.phone = phone;
        changed.push('phone');
      }
    }

    let email: string | undefined;
    if (input.email !== undefined) {
      const normalized = input.email.trim().toLowerCase();
      if (normalized !== profile.email) {
        this.assertMayChangeEmail(actor, profile, scope);
        email = normalized;
        data.email = normalized;
        changed.push('email');
        trail.email = { from: profile.email, to: normalized };
      }
    }

    // Nothing to write, and nothing to audit: saving an unchanged form is not
    // an event.
    if (!changed.length) return;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (email) {
          // Asked first for a message that names the problem; the unique
          // indexes on both columns still decide a race (P2002, below).
          const [profileClash, credentialClash] = await Promise.all([
            tx.userProfile.findFirst({
              where: { email, id: { not: profile.id } },
              select: { id: true },
            }),
            tx.authCredential.findFirst({
              where: { email, authUserId: { not: profile.authUserId } },
              select: { id: true },
            }),
          ]);
          if (profileClash || credentialClash) throw emailInUse();

          // `updateMany`: an account provisioned but never given a credential
          // has no row here, and that must not fail the rename of its profile.
          await tx.authCredential.updateMany({
            where: { authUserId: profile.authUserId },
            data: { email },
          });
          // A link already sitting in the old mailbox would still set this
          // account's password. The address is usually changed because that
          // mailbox is no longer theirs.
          await tx.authPasswordResetToken.updateMany({
            where: { authUserId: profile.authUserId, consumedAt: null },
            data: { consumedAt: new Date() },
          });
        }
        await tx.userProfile.update({ where: { id: profile.id }, data });
        await tx.auditLog.create({
          data: {
            organizationId: actor.organizationId,
            actorUserId: actor.id,
            action: 'PROFILE_UPDATED',
            entityType: 'UserProfile',
            entityId: profile.id,
            metadata: { scope, changed, ...trail },
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw emailInUse();
      throw error;
    }

    // The technician roster is cached and shows the name and email.
    if (profile.isTechnician)
      await this.cacheInvalidation?.publish({
        type: 'technician.changed',
        organizationId: actor.organizationId,
        technicianId: profile.id,
      });
  }

  /**
   * Who may move an account's sign-in address.
   *
   * Not the account itself, from an administrator page: whoever holds a
   * session could otherwise point the account at a mailbox of their own and
   * keep it. Not the protected bootstrap administrator, which nothing in user
   * management may change. And from the Technicians page, not an account that
   * also signs in to the console unless the caller manages users: a new address
   * plus a reset link is that account, so `technicians:manage` would otherwise
   * be a way into an administrator's console.
   */
  private assertMayChangeEmail(
    actor: AuthenticatedUser,
    profile: { id: string; isSystemAdmin: boolean; hasConsoleAccess: boolean },
    scope: ProfileScope,
  ) {
    if (profile.id === actor.id)
      throw new ApplicationError(
        409,
        'CANNOT_CHANGE_OWN_EMAIL',
        'Your own sign-in email can only be changed by another administrator.',
      );
    if (profile.isSystemAdmin)
      throw new ApplicationError(
        409,
        'SYSTEM_ADMIN_PROTECTED',
        'A system administrator’s sign-in email cannot be changed from user management.',
      );
    if (
      scope === 'TECHNICIAN' &&
      profile.hasConsoleAccess &&
      !actor.permissions.includes('users:manage')
    )
      throw new ApplicationError(
        403,
        'EMAIL_CHANGE_NEEDS_USERS_MANAGE',
        'They also sign in to the console, so only somebody who manages users can change their email.',
      );
  }

  /**
   * The account, if the page asking may see it.
   *
   * The scope is part of the lookup, as in `ProfileDeletionService`, so an
   * account on the other surface is simply not found rather than refused with
   * an answer that says it exists.
   */
  private async requireProfile(actor: AuthenticatedUser, id: string, scope: ProfileScope) {
    const organizationId = actor.organizationId;
    const where: Prisma.UserProfileWhereInput =
      scope === 'TECHNICIAN'
        ? { id, memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } } }
        : {
            id,
            OR: [
              { memberships: { some: { organizationId, role: { in: CONSOLE_ROLES } } } },
              { roleAssignments: { some: { organizationId } } },
            ],
          };
    const record = await this.prisma.userProfile.findFirst({
      where,
      select: {
        id: true,
        authUserId: true,
        email: true,
        displayName: true,
        phone: true,
        memberships: { where: { organizationId }, select: { role: true } },
        _count: { select: { roleAssignments: { where: { organizationId } } } },
      },
    });
    if (!record)
      throw scope === 'TECHNICIAN'
        ? new ApplicationError(404, 'TECHNICIAN_NOT_FOUND', 'Technician was not found.')
        : new ApplicationError(404, 'USER_NOT_FOUND', 'User was not found.');

    const roles = record.memberships.map((membership) => membership.role);
    return {
      id: record.id,
      authUserId: record.authUserId,
      email: record.email,
      displayName: record.displayName,
      phone: record.phone,
      isTechnician: roles.includes(UserRole.INSPECTION_TECHNICIAN),
      isSystemAdmin: roles.includes(UserRole.SYSTEM_ADMIN),
      hasConsoleAccess:
        roles.some((role) => role !== UserRole.INSPECTION_TECHNICIAN) ||
        record._count.roleAssignments > 0,
    };
  }
}
