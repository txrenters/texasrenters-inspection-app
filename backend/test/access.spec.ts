import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@texasrenters/shared';
import { resolveEffectivePermissions } from '@texasrenters/shared';

import type { AuthenticatedRequest, AuthenticatedUser } from '../src/common/auth';
import { PermissionsGuard } from '../src/common/auth';
import { AccessService } from '../src/admin/access.service';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: ['users:manage', 'roles:manage'],
  mustChangePassword: false,
};

function contextFor(user: AuthenticatedUser) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) as AuthenticatedRequest }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

describe('effective permission resolution', () => {
  it('grants a newly created user with no roles zero permissions', () => {
    expect(resolveEffectivePermissions([], [])).toEqual([]);
  });

  it('maps a legacy system admin to the full catalog', () => {
    const permissions = resolveEffectivePermissions([UserRole.SYSTEM_ADMIN], []);
    expect(permissions).toEqual(
      expect.arrayContaining(['users:manage', 'roles:manage', 'ai:configure']),
    );
  });

  it('unions custom-role permissions and drops unknown keys', () => {
    const permissions = resolveEffectivePermissions(
      [UserRole.INSPECTION_TECHNICIAN],
      ['findings:review', 'not:a:real:permission'],
    );
    expect(permissions).toEqual(['findings:review']);
  });

  it('does not let a technician role imply any admin permission', () => {
    expect(resolveEffectivePermissions([UserRole.INSPECTION_TECHNICIAN], [])).toEqual([]);
  });

  it('does not let legacy web membership labels imply preset permissions', () => {
    expect(
      resolveEffectivePermissions([UserRole.PROPERTY_ADMIN, UserRole.INSPECTION_SUPERVISOR], []),
    ).toEqual([]);
  });
});

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard({ getAllAndOverride: () => ['users:manage'] } as never);

  it('allows a user holding the required permission', () => {
    expect(guard.canActivate(contextFor(admin))).toBe(true);
  });

  it('denies a user missing the required permission', () => {
    const reviewer = { ...admin, roles: [], permissions: ['findings:review' as const] };
    expect(() => guard.canActivate(contextFor(reviewer))).toThrow(ForbiddenException);
  });

  it('blocks a user who must change their password even with the permission', () => {
    const stale = { ...admin, mustChangePassword: true };
    expect(() => guard.canActivate(contextFor(stale))).toThrow(ForbiddenException);
  });

  it('requires every listed permission (AND semantics)', () => {
    const bothRequired = new PermissionsGuard({
      getAllAndOverride: () => ['users:manage', 'roles:manage'],
    } as never);
    const partial = { ...admin, permissions: ['users:manage' as const] };
    expect(() => bothRequired.canActivate(contextFor(partial))).toThrow(ForbiddenException);
  });
});

describe('AccessService role management', () => {
  it('persists only catalog permissions and audits the change', async () => {
    const prisma = {
      role: {
        create: jest.fn().mockResolvedValue({
          id: 'role-1',
          name: 'Reviewer',
          description: null,
          permissions: ['findings:review'],
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { assignments: 0 },
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const service = new AccessService(prisma as never, {} as never);

    await service.createRole(admin, {
      name: 'Reviewer',
      permissions: ['findings:review', 'totally:bogus'],
    });

    expect(prisma.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: admin.organizationId,
          permissions: ['findings:review'],
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'ROLE_CREATED' }) }),
    );
  });

  it('returns 404 for a role owned by another organization', async () => {
    const prisma = { role: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new AccessService(prisma as never, {} as never);

    await expect(service.role(admin, 'foreign-role')).rejects.toMatchObject({
      status: 404,
      code: 'ROLE_NOT_FOUND',
    });
    expect(prisma.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: admin.organizationId }),
      }),
    );
  });
});

describe('AccessService user role assignment', () => {
  it('requires at least one custom role when creating a web user', async () => {
    const identities = { createWebUserIdentity: jest.fn() };
    const service = new AccessService({} as never, identities as never);

    await expect(
      service.createUser(admin, {
        email: 'operator@example.com',
        displayName: 'Operations User',
        roleIds: [],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'USER_ROLE_REQUIRED' });
    expect(identities.createWebUserIdentity).not.toHaveBeenCalled();
  });

  it('refuses to let an admin change their own roles (self-lockout guard)', async () => {
    const service = new AccessService({} as never, {} as never);
    await expect(service.setUserRoles(admin, admin.id, { roleIds: [] })).rejects.toMatchObject({
      status: 409,
      code: 'CANNOT_MODIFY_SELF',
    });
  });

  it('rejects assigning a custom role that belongs to a different organization', async () => {
    const prisma = {
      userProfile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'user-2',
          email: 'u2@example.com',
          displayName: 'User Two',
          isActive: true,
          createdAt: new Date(),
          memberships: [],
          roleAssignments: [],
        }),
      },
      // Only one of the two requested roles exists in this org.
      role: { findMany: jest.fn().mockResolvedValue([{ id: 'role-in-org' }]) },
    };
    const service = new AccessService(prisma as never, {} as never);

    await expect(
      service.setUserRoles(admin, 'user-2', { roleIds: ['role-in-org', 'role-elsewhere'] }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_ROLE_ASSIGNMENT' });
    expect(prisma.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: admin.organizationId }),
      }),
    );
  });

  it('replaces org-scoped assignments and records an audit event', async () => {
    const userRecord = {
      id: 'user-2',
      email: 'u2@example.com',
      displayName: 'User Two',
      isActive: true,
      createdAt: new Date(),
      memberships: [{ role: UserRole.CONDITION_REVIEWER }],
      roleAssignments: [
        { role: { id: 'role-1', name: 'Reviewer', permissions: ['findings:review'] } },
      ],
    };
    const tx = {
      organizationMember: { createMany: jest.fn() },
      userRoleAssignment: { deleteMany: jest.fn(), createMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      userProfile: { findFirst: jest.fn().mockResolvedValue(userRecord) },
      role: { findMany: jest.fn().mockResolvedValue([{ id: 'role-1' }]) },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new AccessService(prisma as never, {} as never);

    const result = await service.setUserRoles(admin, 'user-2', {
      roleIds: ['role-1'],
    });

    expect(tx.userRoleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: admin.organizationId, userProfileId: 'user-2' },
    });
    expect(tx.organizationMember.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'USER_ROLES_CHANGED' }) }),
    );
    // Legacy membership labels grant nothing. Only the assigned custom role
    // contributes effective permissions for an ordinary web user.
    expect(result.permissions).toEqual(['findings:review']);
  });
});
