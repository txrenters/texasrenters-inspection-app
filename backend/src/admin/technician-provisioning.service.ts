import { randomInt } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

import type { AuthenticatedUser } from '../common/auth';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
import type { CreateTechnicianDto } from './admin.dto';

@Injectable()
export class SupabaseAdminGateway {
  private admin() {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey)
      throw new ApplicationError(
        503,
        'ACCOUNT_PROVISIONING_NOT_CONFIGURED',
        'Technician account provisioning is not configured.',
      );
    return createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }).auth.admin;
  }

  async createTechnicianIdentity(email: string, password: string, displayName: string) {
    return this.createIdentity(email, password, displayName, 'technician');
  }

  async createWebUserIdentity(email: string, password: string, displayName: string) {
    return this.createIdentity(email, password, displayName, 'web user');
  }

  private async createIdentity(
    email: string,
    password: string,
    displayName: string,
    accountType: 'technician' | 'web user',
  ) {
    const result = await this.admin().createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
      app_metadata: { must_change_password: true },
    });
    if (result.error || !result.data.user)
      throw new ApplicationError(
        409,
        accountType === 'technician'
          ? 'TECHNICIAN_IDENTITY_NOT_CREATED'
          : 'USER_IDENTITY_NOT_CREATED',
        `A ${accountType} account could not be created for that email address.`,
      );
    return { authUserId: result.data.user.id };
  }

  async deleteIdentity(authUserId: string) {
    await this.admin().deleteUser(authUserId);
  }

  async identityExists(authUserId: string) {
    const result = await this.admin().getUserById(authUserId);
    if (result.data.user) return true;
    if (result.error?.status === 404 || result.error?.code === 'user_not_found') return false;
    throw new ApplicationError(
      502,
      'IDENTITY_LOOKUP_FAILED',
      'The existing account could not be verified safely.',
    );
  }
}

@Injectable()
export class TechnicianProvisioningService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SupabaseAdminGateway) private readonly identities: SupabaseAdminGateway,
    @Optional()
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
  ) {}

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
