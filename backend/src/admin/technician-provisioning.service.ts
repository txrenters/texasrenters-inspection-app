import { randomInt } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
import type { CreateTechnicianDto } from './admin.dto';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider';

@Injectable()
export class TechnicianProvisioningService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IDENTITY_PROVIDER) private readonly identities: IdentityProvider,
    @Optional()
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
  ) {}

  /**
   * Give somebody who already has an account access to the mobile app.
   *
   * The mirror of `AccessService.grantConsoleAccess`, and it exists for the
   * same reason: `create` refuses the address with `TECHNICIAN_EMAIL_EXISTS`,
   * because one email is one account. Roles are what separate the console from
   * the handset, so the fix is a second membership rather than a second row.
   *
   * Only the membership is written. The account already has a credential, and
   * minting another temporary password here would lock them out of the console
   * they are currently using — which is why this shares nothing with `create`
   * beyond the membership upsert and the audit row.
   */
  async grantTechnicianAccess(user: AuthenticatedUser, userProfileId: string) {
    const target = await this.prisma.userProfile.findFirst({
      // Any membership in the caller's own organization. Someone with none is
      // another tenant's person or nobody at all, and `technicians:provision`
      // must not reach either.
      where: { id: userProfileId, memberships: { some: { organizationId: user.organizationId } } },
      select: {
        id: true,
        email: true,
        displayName: true,
        isActive: true,
        createdAt: true,
        memberships: {
          where: {
            organizationId: user.organizationId,
            role: UserRole.INSPECTION_TECHNICIAN,
          },
          select: { id: true },
        },
      },
    });
    if (!target) throw new ApplicationError(404, 'USER_NOT_FOUND', 'User was not found.');
    if (!target.isActive)
      throw new ApplicationError(
        409,
        'USER_INACTIVE',
        'This account is deactivated. Reactivate it before granting mobile access.',
      );

    const alreadyHadAccess = target.memberships.length > 0;
    if (!alreadyHadAccess) {
      await this.prisma.$transaction(async (tx) => {
        await tx.organizationMember.create({
          data: {
            organizationId: user.organizationId,
            userProfileId: target.id,
            role: UserRole.INSPECTION_TECHNICIAN,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: 'TECHNICIAN_ACCESS_GRANTED',
            entityType: 'UserProfile',
            entityId: target.id,
            // No temporary password, unlike TECHNICIAN_ACCOUNT_CREATED. Whoever
            // reads this later needs to know the existing credential was left
            // alone, or they will go looking for an invitation that never went.
            metadata: { role: UserRole.INSPECTION_TECHNICIAN, temporaryPasswordRequired: false },
          },
        });
      });
      // The roster is cached, and this person has just joined it.
      await this.cacheInvalidation?.publish({
        type: 'technician.changed',
        organizationId: user.organizationId,
        technicianId: target.id,
      });
    }

    return {
      id: target.id,
      email: target.email,
      displayName: target.displayName,
      isActive: target.isActive,
      createdAt: target.createdAt,
      granted: !alreadyHadAccess,
    };
  }

  async create(user: AuthenticatedUser, input: CreateTechnicianDto) {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const existing = await this.prisma.userProfile.findUnique({
      where: { email },
      select: {
        id: true,
        authUserId: true,
        memberships: { select: { id: true } },
      },
    });
    if (existing) {
      const identityExists = await this.identities.identityExists(existing.authUserId);
      if (identityExists || existing.memberships.length > 0)
        throw new ApplicationError(
          409,
          'TECHNICIAN_EMAIL_EXISTS',
          'An account already exists for that email address.',
        );

      // A failed legacy provisioning attempt could leave the auth-triggered profile
      // after its Supabase identity was compensated. It is safe to remove only when
      // it has no identity and no organization membership.
      try {
        await this.prisma.userProfile.delete({ where: { id: existing.id } });
      } catch {
        throw new ApplicationError(
          409,
          'TECHNICIAN_PROFILE_CONFLICT',
          'An incomplete account record exists for that email address and could not be repaired safely.',
        );
      }
    }

    const temporaryPassword = this.temporaryPassword();
    const identity = await this.identities.createTechnicianIdentity(
      email,
      temporaryPassword,
      displayName,
    );
    try {
      const profile = await this.prisma.$transaction(async (tx) => {
        const triggeredProfile = await tx.userProfile.findFirst({
          where: { OR: [{ authUserId: identity.authUserId }, { email }] },
          select: { id: true, authUserId: true },
        });
        if (triggeredProfile && triggeredProfile.authUserId !== identity.authUserId)
          throw new ApplicationError(
            409,
            'TECHNICIAN_EMAIL_EXISTS',
            'An account already exists for that email address.',
          );
        const created = triggeredProfile
          ? await tx.userProfile.update({
              where: { id: triggeredProfile.id },
              data: { email, displayName, isActive: true },
            })
          : await tx.userProfile.create({
              data: { authUserId: identity.authUserId, email, displayName },
            });
        await tx.organizationMember.upsert({
          where: {
            organizationId_userProfileId_role: {
              organizationId: user.organizationId,
              userProfileId: created.id,
              role: UserRole.INSPECTION_TECHNICIAN,
            },
          },
          update: {},
          create: {
            organizationId: user.organizationId,
            userProfileId: created.id,
            role: UserRole.INSPECTION_TECHNICIAN,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: 'TECHNICIAN_ACCOUNT_CREATED',
            entityType: 'UserProfile',
            entityId: created.id,
            metadata: {
              role: UserRole.INSPECTION_TECHNICIAN,
              temporaryPasswordRequired: true,
            },
          },
        });
        return created;
      });
      await this.cacheInvalidation?.publish({
        type: 'technician.changed',
        organizationId: user.organizationId,
        technicianId: profile.id,
      });
      const delivery = await this.mailer?.sendAccountInvitation({
        to: email,
        displayName,
        temporaryPassword,
        application: 'mobile',
      });
      return {
        id: profile.id,
        email: profile.email,
        displayName: profile.displayName,
        isActive: profile.isActive,
        createdAt: profile.createdAt,
        mustChangePassword: true,
        temporaryPassword,
        emailDeliveryStatus: delivery?.status ?? ('NOT_CONFIGURED' as const),
      };
    } catch (error) {
      await this.identities.deleteIdentity(identity.authUserId).catch(() => undefined);
      await this.prisma.userProfile
        .deleteMany({
          where: {
            authUserId: identity.authUserId,
            memberships: { none: {} },
          },
        })
        .catch(() => undefined);
      if (error instanceof ApplicationError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        this.isAccountIdentityConstraint(error.meta?.target)
      )
        throw new ApplicationError(
          409,
          'TECHNICIAN_EMAIL_EXISTS',
          'An account already exists for that email address.',
        );
      throw error;
    }
  }

  private temporaryPassword() {
    const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%'];
    const alphabet = groups.join('');
    const characters = groups.map((group) => group[randomInt(group.length)]!);
    while (characters.length < 8) characters.push(alphabet[randomInt(alphabet.length)]!);
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1);
      [characters[index], characters[swapIndex]] = [characters[swapIndex]!, characters[index]!];
    }
    return characters.join('');
  }

  private isAccountIdentityConstraint(target: unknown) {
    const fields = Array.isArray(target) ? target : [target];
    return fields.some(
      (field) => typeof field === 'string' && /email|authUserId|UserProfile/i.test(field),
    );
  }
}
