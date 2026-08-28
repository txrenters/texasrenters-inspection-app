import { randomInt } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import {
  PERMISSION_CATALOG,
  isPermissionKey,
  resolveEffectivePermissions,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { PresenceService } from '../realtime/presence.service';
import { MailService } from '../mail/mail.service';
import type {
  AccessListQueryDto,
  CreateRoleDto,
  CreateUserDto,
  SetUserRolesDto,
  UpdateRoleDto,
} from './access.dto';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider';

// Web-console access levels. INSPECTION_TECHNICIAN is deliberately excluded:
// technician (mobile) accounts are created and managed on the Technicians page,
// so this user-management surface never creates, lists, or edits them.
const CONSOLE_ROLES = Object.values(UserRole).filter(
  (role) => role !== UserRole.INSPECTION_TECHNICIAN,
);
// OrganizationMember remains the coarse organization/application membership.
// It grants no permissions; all normal web-user permissions come from custom
// roles. PROPERTY_ADMIN is retained internally to avoid a destructive enum/data
// migration while the legacy membership table is still shared with mobile auth.
const CONSOLE_MEMBERSHIP_ROLE = UserRole.PROPERTY_ADMIN;

@Injectable()
export class AccessService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IDENTITY_PROVIDER) private readonly identities: IdentityProvider,
    // Appended rather than inserted: these are positional at every call site,
    // and slotting a parameter in the middle silently rebinds the ones after it.
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
  ) {}

  // The permission catalog is code-defined and identical for every org; there
  // are no preconfigured roles, only this menu the admin composes roles from.
  permissionCatalog() {
    return {
      groups: PERMISSION_CATALOG,
      keys: PERMISSION_CATALOG.flatMap((g) => g.permissions.map((p) => p.key)),
    };
  }

  async listRoles(user: AuthenticatedUser, query: AccessListQueryDto) {
    const where = {
      organizationId: user.organizationId,
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    } satisfies Prisma.RoleWhereInput;
    const [records, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          name: true,
          description: true,
          permissions: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { assignments: true } },
        },
      }),
      this.prisma.role.count({ where }),
    ]);
    return this.page(
      records.map((record) => this.mapRoleSummary(record)),
      total,
      query,
    );
  }

  async role(user: AuthenticatedUser, id: string) {
    const record = await this.prisma.role.findFirst({
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        permissions: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { assignments: true } },
        assignments: {
          select: {
            userProfile: { select: { id: true, displayName: true, email: true } },
          },
          orderBy: { userProfile: { displayName: 'asc' } },
          take: 200,
        },
      },
    });
    if (!record) throw new ApplicationError(404, 'ROLE_NOT_FOUND', 'Role was not found.');
    return {
      ...this.mapRoleSummary(record),
      assignedUsers: record.assignments.map((assignment) => assignment.userProfile),
    };
  }

  async createRole(user: AuthenticatedUser, input: CreateRoleDto) {
    const name = input.name.trim();
    const permissions = this.sanitizePermissions(input.permissions);
    try {
      const role = await this.prisma.role.create({
        data: {
          organizationId: user.organizationId,
          name,
          description: input.description?.trim() || null,
          permissions,
        },
        select: {
          id: true,
          name: true,
          description: true,
          permissions: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { assignments: true } },
        },
      });
      await this.audit(user, 'ROLE_CREATED', 'Role', role.id, { name, permissions });
      return this.mapRoleSummary(role);
    } catch (error) {
      throw this.mapUniqueRoleName(error);
    }
  }

  async updateRole(user: AuthenticatedUser, id: string, input: UpdateRoleDto) {
    await this.requireRole(user, id);
    await this.assertRoleNotAssignedToActor(user, id);
    const data: Prisma.RoleUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description.trim() || null;
    if (input.permissions !== undefined)
      data.permissions = this.sanitizePermissions(input.permissions);
    try {
      const role = await this.prisma.role.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          description: true,
          permissions: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { assignments: true } },
        },
      });
      await this.audit(user, 'ROLE_UPDATED', 'Role', role.id, {
        name: role.name,
        permissions: role.permissions,
      });
      return this.mapRoleSummary(role);
    } catch (error) {
      throw this.mapUniqueRoleName(error);
    }
  }

  async deleteRole(user: AuthenticatedUser, id: string) {
    const role = await this.requireRole(user, id);
    await this.assertRoleNotAssignedToActor(user, id);
    // Cascade removes assignments; effective permissions for affected users
    // shrink on their next request.
    await this.prisma.role.delete({ where: { id } });
    await this.audit(user, 'ROLE_DELETED', 'Role', id, { name: role.name });
    return { id, deleted: true as const, deletedAt: new Date().toISOString() };
  }

  async listUsers(user: AuthenticatedUser, query: AccessListQueryDto) {
    const organizationId = user.organizationId;
    const activeFilter =
      query.active === 'true' ? true : query.active === 'false' ? false : undefined;
    const where = {
      // A web-console user holds a console membership or a custom role in this
      // org. Pure technicians (only INSPECTION_TECHNICIAN) never appear here.
      OR: [
        { memberships: { some: { organizationId, role: { in: CONSOLE_ROLES } } } },
        { roleAssignments: { some: { organizationId } } },
      ],
      ...(activeFilter === undefined ? {} : { isActive: activeFilter }),
      ...(query.search
        ? {
            AND: [
              {
                OR: [
                  { displayName: { contains: query.search, mode: 'insensitive' as const } },
                  { email: { contains: query.search, mode: 'insensitive' as const } },
                ],
              },
            ],
          }
        : {}),
    } satisfies Prisma.UserProfileWhereInput;
    const [records, total] = await Promise.all([
      this.prisma.userProfile.findMany({
        where,
        orderBy: { displayName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: this.userSelect(organizationId),
      }),
      this.prisma.userProfile.count({ where }),
    ]);
    // Presence is live, so it is read here rather than baked into `mapUser`,
    // which also serves cached and single-record paths.
    const presence = this.presence.presenceForMany(records.map((record) => record.id));
    return this.page(
      records.map((record) => ({
        ...this.mapUser(record),
        ...(presence[record.id] ?? { isOnline: false, lastSeenAt: null }),
      })),
      total,
      query,
    );
  }

  async user(user: AuthenticatedUser, id: string) {
    const record = await this.requireUser(user, id);
    return this.mapUserDetail(record);
  }

  async createUser(user: AuthenticatedUser, input: CreateUserDto) {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const roleIds = await this.validateRoleIds(user, input.roleIds);
    if (!roleIds.length)
      throw new ApplicationError(
        400,
        'USER_ROLE_REQUIRED',
        'Assign at least one custom role when creating a web user.',
      );

    const existing = await this.prisma.userProfile.findUnique({
      where: { email },
      select: { id: true, authUserId: true, memberships: { select: { id: true } } },
    });
    if (existing) {
      const identityExists = await this.identities.identityExists(existing.authUserId);
      if (identityExists || existing.memberships.length > 0)
        throw new ApplicationError(
          409,
          'USER_EMAIL_EXISTS',
          'An account already exists for that email address.',
        );
      try {
        await this.prisma.userProfile.delete({ where: { id: existing.id } });
      } catch {
        throw new ApplicationError(
          409,
          'USER_PROFILE_CONFLICT',
          'An incomplete account record exists for that email address and could not be repaired safely.',
        );
      }
    }

    const temporaryPassword = this.temporaryPassword();
    const identity = await this.identities.createWebUserIdentity(
      email,
      temporaryPassword,
      displayName,
    );
    try {
      const profileId = await this.prisma.$transaction(async (tx) => {
        const triggered = await tx.userProfile.findFirst({
          where: { OR: [{ authUserId: identity.authUserId }, { email }] },
          select: { id: true, authUserId: true },
        });
        if (triggered && triggered.authUserId !== identity.authUserId)
          throw new ApplicationError(
            409,
            'USER_EMAIL_EXISTS',
            'An account already exists for that email address.',
          );
        const created = triggered
          ? await tx.userProfile.update({
              where: { id: triggered.id },
              data: { email, displayName, isActive: true },
              select: { id: true },
            })
          : await tx.userProfile.create({
              data: { authUserId: identity.authUserId, email, displayName },
              select: { id: true },
            });
        await this.writeAssignments(tx, user.organizationId, created.id, roleIds, true);
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: 'USER_ACCOUNT_CREATED',
            entityType: 'UserProfile',
            entityId: created.id,
            metadata: { roleIds, temporaryPasswordRequired: true },
          },
        });
        return created.id;
      });
      const detail = this.mapUserDetail(await this.requireUser(user, profileId));
      const delivery = await this.mailer?.sendAccountInvitation({
        to: email,
        displayName,
        temporaryPassword,
        application: 'web',
        loginUrl: process.env.WEB_APP_ORIGIN
          ? `${process.env.WEB_APP_ORIGIN.replace(/\/$/, '')}/login`
          : undefined,
      });
      return {
        ...detail,
        mustChangePassword: true as const,
        temporaryPassword,
        emailDeliveryStatus: delivery?.status ?? ('NOT_CONFIGURED' as const),
      };
    } catch (error) {
      await this.identities.deleteIdentity(identity.authUserId).catch(() => undefined);
      await this.prisma.userProfile
        .deleteMany({ where: { authUserId: identity.authUserId, memberships: { none: {} } } })
        .catch(() => undefined);
      if (error instanceof ApplicationError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ApplicationError(
          409,
          'USER_EMAIL_EXISTS',
          'An account already exists for that email address.',
        );
      throw error;
    }
  }

  async updateUser(user: AuthenticatedUser, id: string, displayName: string) {
    await this.requireUser(user, id);
    await this.prisma.userProfile.update({
      where: { id },
      data: { displayName: displayName.trim() },
    });
    return this.mapUserDetail(await this.requireUser(user, id));
  }

  async updateUserStatus(user: AuthenticatedUser, id: string, isActive: boolean) {
    if (id === user.id)
      throw new ApplicationError(
        409,
        'CANNOT_MODIFY_SELF',
        'You cannot change the status of your own account.',
      );
    const target = await this.requireUser(user, id);
    this.assertNotSystemAdmin(target);
    if (!isActive) {
      const activeAssignments = await this.prisma.inspectionAssignment.count({
        where: { technicianId: id, isCurrent: true },
      });
      if (activeAssignments > 0)
        throw new ApplicationError(
          409,
          'USER_HAS_ACTIVE_ASSIGNMENTS',
          'Reassign this user’s active inspections before deactivating the account.',
        );
    }
    await this.prisma.userProfile.update({ where: { id }, data: { isActive } });
    await this.audit(user, isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'UserProfile', id, {
      email: target.email,
    });
    return this.mapUserDetail(await this.requireUser(user, id));
  }

  async setUserRoles(user: AuthenticatedUser, id: string, input: SetUserRolesDto) {
    if (id === user.id)
      throw new ApplicationError(
        409,
        'CANNOT_MODIFY_SELF',
        'You cannot change the roles of your own account.',
      );
    const target = await this.requireUser(user, id);
    this.assertNotSystemAdmin(target);
    const roleIds = await this.validateRoleIds(user, input.roleIds);
    await this.prisma.$transaction(async (tx) => {
      await tx.userRoleAssignment.deleteMany({
        where: { organizationId: user.organizationId, userProfileId: id },
      });
      await this.writeAssignments(tx, user.organizationId, id, roleIds, false);
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'USER_ROLES_CHANGED',
          entityType: 'UserProfile',
          entityId: id,
          metadata: { roleIds },
        },
      });
    });
    return this.mapUserDetail(await this.requireUser(user, id));
  }

  // --- helpers -------------------------------------------------------------

  private async writeAssignments(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userProfileId: string,
    roleIds: string[],
    createMembership: boolean,
  ) {
    if (createMembership)
      await tx.organizationMember.createMany({
        data: [{ organizationId, userProfileId, role: CONSOLE_MEMBERSHIP_ROLE }],
        skipDuplicates: true,
      });
    if (roleIds.length)
      await tx.userRoleAssignment.createMany({
        data: roleIds.map((roleId) => ({ organizationId, userProfileId, roleId })),
        skipDuplicates: true,
      });
  }

  /** Ensures every requested custom role exists and belongs to the acting org. */
  private async validateRoleIds(user: AuthenticatedUser, roleIds: string[]) {
    const unique = [...new Set(roleIds)];
    if (!unique.length) return [];
    const found = await this.prisma.role.findMany({
      where: { id: { in: unique }, organizationId: user.organizationId },
      select: { id: true },
    });
    if (found.length !== unique.length)
      throw new ApplicationError(
        400,
        'INVALID_ROLE_ASSIGNMENT',
        'One or more selected roles do not exist in this organization.',
      );
    return unique;
  }

  private sanitizePermissions(permissions: string[]) {
    return [...new Set(permissions.filter(isPermissionKey))];
  }

  private async requireRole(user: AuthenticatedUser, id: string) {
    const role = await this.prisma.role.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, name: true },
    });
    if (!role) throw new ApplicationError(404, 'ROLE_NOT_FOUND', 'Role was not found.');
    return role;
  }

  private async assertRoleNotAssignedToActor(user: AuthenticatedUser, roleId: string) {
    if (user.roles.some((role) => String(role) === UserRole.SYSTEM_ADMIN)) return;
    const assignment = await this.prisma.userRoleAssignment.findFirst({
      where: {
        organizationId: user.organizationId,
        userProfileId: user.id,
        roleId,
      },
      select: { id: true },
    });
    if (assignment)
      throw new ApplicationError(
        409,
        'CANNOT_MODIFY_OWN_ROLE',
        'You cannot modify or delete a role assigned to your own account.',
      );
  }

  private assertNotSystemAdmin(record: UserRecord) {
    if (record.memberships.some((membership) => membership.role === UserRole.SYSTEM_ADMIN))
      throw new ApplicationError(
        409,
        'SYSTEM_ADMIN_PROTECTED',
        'System administrator access cannot be changed from custom user management.',
      );
  }

  private async requireUser(user: AuthenticatedUser, id: string) {
    const record = await this.prisma.userProfile.findFirst({
      where: {
        id,
        OR: [
          {
            memberships: {
              some: { organizationId: user.organizationId, role: { in: CONSOLE_ROLES } },
            },
          },
          { roleAssignments: { some: { organizationId: user.organizationId } } },
        ],
      },
      select: this.userSelect(user.organizationId),
    });
    if (!record) throw new ApplicationError(404, 'USER_NOT_FOUND', 'User was not found.');
    return record;
  }

  private userSelect(organizationId: string) {
    return {
      id: true,
      email: true,
      displayName: true,
      isActive: true,
      createdAt: true,
      memberships: {
        // Only console access levels surface here; technician membership is
        // owned by the Technicians page.
        where: { organizationId, role: { in: CONSOLE_ROLES } },
        select: { role: true },
      },
      roleAssignments: {
        where: { organizationId },
        select: { role: { select: { id: true, name: true, permissions: true } } },
      },
    } satisfies Prisma.UserProfileSelect;
  }

  private mapRoleSummary(record: {
    id: string;
    name: string;
    description: string | null;
    permissions: string[];
    createdAt: Date;
    updatedAt: Date;
    _count: { assignments: number };
  }) {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      permissions: record.permissions,
      assignedUserCount: record._count.assignments,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private mapUser(record: UserRecord) {
    return {
      id: record.id,
      email: record.email,
      displayName: record.displayName,
      isActive: record.isActive,
      isSystemAdmin: record.memberships.some(
        (membership) => membership.role === UserRole.SYSTEM_ADMIN,
      ),
      createdAt: record.createdAt.toISOString(),
      customRoles: record.roleAssignments.map((assignment) => ({
        id: assignment.role.id,
        name: assignment.role.name,
      })),
    };
  }

  private mapUserDetail(record: UserRecord) {
    const membershipRoles = record.memberships.map((membership) => membership.role);
    const customPermissions = record.roleAssignments.flatMap(
      (assignment) => assignment.role.permissions,
    );
    return {
      ...this.mapUser(record),
      permissions: resolveEffectivePermissions(membershipRoles, customPermissions),
    };
  }

  private async audit(
    user: AuthenticatedUser,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType,
        entityId,
        metadata,
      },
    });
  }

  private mapUniqueRoleName(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      return new ApplicationError(
        409,
        'ROLE_NAME_EXISTS',
        'A role with that name already exists in this organization.',
      );
    return error;
  }

  private temporaryPassword() {
    const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%'];
    const alphabet = groups.join('');
    const characters = groups.map((group) => group[randomInt(group.length)]!);
    while (characters.length < 10) characters.push(alphabet[randomInt(alphabet.length)]!);
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1);
      [characters[index], characters[swapIndex]] = [characters[swapIndex]!, characters[index]!];
    }
    return characters.join('');
  }

  private page<T>(items: T[], total: number, query: AccessListQueryDto) {
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}

type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAt: Date;
  memberships: Array<{ role: UserRole }>;
  roleAssignments: Array<{ role: { id: string; name: string; permissions: string[] } }>;
};
