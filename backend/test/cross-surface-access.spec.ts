import { UserRole } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { IdentityProvider } from '../src/admin/identity-provider';
import type { PrismaService } from '../src/common/prisma.service';
import type { PresenceService } from '../src/realtime/presence.service';
import { AccessService } from '../src/admin/access.service';
import { TechnicianProvisioningService } from '../src/admin/technician-provisioning.service';

/**
 * One person, one account, both surfaces.
 *
 * `UserProfile.email` and `AuthCredential.email` are both unique and sign-in
 * resolves an account by address alone, so a technician who also needs the
 * console cannot be a second row — the system would not know which one was
 * signing in. Roles are what separate the two applications, and
 * `OrganizationMember` is a list, so the answer is a second membership.
 *
 * Before these two methods there was no path at all: both create endpoints
 * refuse the address, and `setUserRoles` could not reach a pure technician
 * because `requireUser` only matches profiles that already hold console access.
 */
const ORG = '00000000-0000-4000-8000-000000000002';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000f';
const TARGET_ID = '00000000-0000-4000-8000-000000000003';

const actor = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: ORG,
} as AuthenticatedUser;

/** The shape `requireUser`/`userSelect` returns, so `mapUserDetail` can run. */
const userRecord = (overrides: Record<string, unknown> = {}) => ({
  id: TARGET_ID,
  email: 'tech@texasrenters.com',
  displayName: 'Roonil Cajan',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  memberships: [{ role: UserRole.PROPERTY_ADMIN }],
  roleAssignments: [],
  ...overrides,
});

function prismaMock() {
  const tx = {
    organizationMember: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  return {
    userProfile: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
}

describe('granting a technician access to the console', () => {
  function build(prisma: ReturnType<typeof prismaMock>) {
    const identities = { identityExists: jest.fn() };
    return new AccessService(
      prisma as unknown as PrismaService,
      identities as unknown as IdentityProvider,
      { presenceForMany: () => ({}) } as unknown as PresenceService,
    );
  }

  /** The scoping lookup, then the re-read `requireUser` performs afterwards. */
  function findsTechnician(
    prisma: ReturnType<typeof prismaMock>,
    first: Record<string, unknown> | null,
  ) {
    prisma.userProfile.findFirst.mockResolvedValueOnce(first).mockResolvedValueOnce(userRecord());
  }

  it('scopes the lookup to a technician inside the caller organization', async () => {
    // The assertion that matters most here. `users:manage` must not become a
    // way to reach an address belonging to another tenant, and a technician who
    // is not theirs has to be indistinguishable from one who does not exist.
    const prisma = prismaMock();
    findsTechnician(prisma, { id: TARGET_ID, isActive: true, memberships: [] });

    await build(prisma).grantConsoleAccess(actor, TARGET_ID);

    expect(prisma.userProfile.findFirst.mock.calls[0][0].where).toEqual({
      id: TARGET_ID,
      memberships: {
        some: { organizationId: ORG, role: UserRole.INSPECTION_TECHNICIAN },
      },
    });
  });

  it('adds the console membership and no roles at all', async () => {
    const prisma = prismaMock();
    findsTechnician(prisma, { id: TARGET_ID, isActive: true, memberships: [] });

    const result = await build(prisma).grantConsoleAccess(actor, TARGET_ID);

    expect(prisma.tx.organizationMember.create).toHaveBeenCalledWith({
      data: { organizationId: ORG, userProfileId: TARGET_ID, role: UserRole.PROPERTY_ADMIN },
    });
    expect(result.granted).toBe(true);
    // A membership label confers nothing -- `resolveEffectivePermissions` reads
    // permissions only from custom roles. The door opens; nothing is behind it
    // until an administrator assigns roles as a separate, audited decision.
    expect(result.permissions).toEqual([]);
  });

  it('records the grant without implying permissions came with it', async () => {
    const prisma = prismaMock();
    findsTechnician(prisma, { id: TARGET_ID, isActive: true, memberships: [] });

    await build(prisma).grantConsoleAccess(actor, TARGET_ID);

    expect(prisma.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        actorUserId: actor.id,
        action: 'CONSOLE_ACCESS_GRANTED',
        entityType: 'UserProfile',
        entityId: TARGET_ID,
        metadata: { role: UserRole.PROPERTY_ADMIN, rolesAssigned: 0 },
      },
    });
  });

  it('refuses a technician who is not the caller’s', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValueOnce(null);

    await expect(
      build(prisma).grantConsoleAccess({ ...actor, organizationId: OTHER_ORG }, TARGET_ID),
    ).rejects.toMatchObject({ status: 404, code: 'TECHNICIAN_NOT_FOUND' });
    expect(prisma.tx.organizationMember.create).not.toHaveBeenCalled();
  });

  it('refuses a deactivated technician', async () => {
    // Handing console access to somebody whose access was just revoked would
    // undo the revocation -- the same rule the reset link applies.
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValueOnce({
      id: TARGET_ID,
      isActive: false,
      memberships: [],
    });

    await expect(build(prisma).grantConsoleAccess(actor, TARGET_ID)).rejects.toMatchObject({
      status: 409,
      code: 'TECHNICIAN_INACTIVE',
    });
    expect(prisma.tx.organizationMember.create).not.toHaveBeenCalled();
  });

  it('is idempotent when the technician already has console access', async () => {
    // Two administrators clicking the same button is not an error, and a second
    // membership row would be a duplicate the unique index would reject anyway.
    const prisma = prismaMock();
    findsTechnician(prisma, { id: TARGET_ID, isActive: true, memberships: [{ id: 'member-1' }] });

    const result = await build(prisma).grantConsoleAccess(actor, TARGET_ID);

    expect(result.granted).toBe(false);
    expect(prisma.tx.organizationMember.create).not.toHaveBeenCalled();
    expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('granting a console user access to the handset', () => {
  function build(prisma: ReturnType<typeof prismaMock>) {
    const identities = { createTechnicianIdentity: jest.fn(), deleteIdentity: jest.fn() };
    const cacheInvalidation = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new TechnicianProvisioningService(
      prisma as unknown as PrismaService,
      identities as unknown as IdentityProvider,
      cacheInvalidation as never,
    );
    return { service, identities, cacheInvalidation };
  }

  const consoleUser = (overrides: Record<string, unknown> = {}) => ({
    id: TARGET_ID,
    email: 'admin@texasrenters.com',
    displayName: 'Ada Lovelace',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    memberships: [],
    ...overrides,
  });

  it('adds the technician membership without touching the existing credential', async () => {
    // The whole point. `create` mints a temporary password; doing that here
    // would lock this person out of the console they are already using.
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(consoleUser());
    const { service, identities } = build(prisma);

    const result = await service.grantTechnicianAccess(actor, TARGET_ID);

    expect(prisma.tx.organizationMember.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        userProfileId: TARGET_ID,
        role: UserRole.INSPECTION_TECHNICIAN,
      },
    });
    expect(identities.createTechnicianIdentity).not.toHaveBeenCalled();
    expect(result.granted).toBe(true);
  });

  it('says in the audit metadata that no temporary password was issued', async () => {
    // Otherwise somebody reading TECHNICIAN_ACCESS_GRANTED later goes looking
    // for an invitation email that was never sent.
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(consoleUser());

    await build(prisma).service.grantTechnicianAccess(actor, TARGET_ID);

    expect(prisma.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        actorUserId: actor.id,
        action: 'TECHNICIAN_ACCESS_GRANTED',
        entityType: 'UserProfile',
        entityId: TARGET_ID,
        metadata: {
          role: UserRole.INSPECTION_TECHNICIAN,
          temporaryPasswordRequired: false,
        },
      },
    });
  });

  it('refreshes the cached roster the person has just joined', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(consoleUser());
    const { service, cacheInvalidation } = build(prisma);

    await service.grantTechnicianAccess(actor, TARGET_ID);

    expect(cacheInvalidation.publish).toHaveBeenCalledWith({
      type: 'technician.changed',
      organizationId: ORG,
      technicianId: TARGET_ID,
    });
  });

  it('scopes the lookup to the caller organization', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(consoleUser());

    await build(prisma).service.grantTechnicianAccess(actor, TARGET_ID);

    expect(prisma.userProfile.findFirst.mock.calls[0][0].where).toEqual({
      id: TARGET_ID,
      memberships: { some: { organizationId: ORG } },
    });
  });

  it('refuses a deactivated account', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(consoleUser({ isActive: false }));

    await expect(build(prisma).service.grantTechnicianAccess(actor, TARGET_ID)).rejects.toMatchObject(
      { status: 409, code: 'USER_INACTIVE' },
    );
    expect(prisma.tx.organizationMember.create).not.toHaveBeenCalled();
  });

  it('is idempotent when they can already use the handset', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(
      consoleUser({ memberships: [{ id: 'member-1' }] }),
    );
    const { service, cacheInvalidation } = build(prisma);

    const result = await service.grantTechnicianAccess(actor, TARGET_ID);

    expect(result.granted).toBe(false);
    expect(prisma.tx.organizationMember.create).not.toHaveBeenCalled();
    expect(cacheInvalidation.publish).not.toHaveBeenCalled();
  });
});
