import { Prisma, UserRole } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import { AccountProfileService } from '../src/admin/account-profile.service';

/**
 * Editing a person's name, sign-in email and phone (2026-10-14).
 *
 * The rename existed as an endpoint nothing called, with no audit, and could not
 * reach a technician. The email had no path at all. The interesting cases are
 * the email ones: it is the address sign-in resolves an account by, so who may
 * move it, and what moves with it, matter more than the happy path.
 */
describe('AccountProfileService', () => {
  const actor: AuthenticatedUser = {
    id: '10000000-0000-4000-8000-000000000001',
    authUserId: 'auth-actor',
    organizationId: '10000000-0000-4000-8000-000000000002',
    displayName: 'Office Admin',
    roles: [],
    permissions: ['users:manage', 'technicians:manage'],
    mustChangePassword: false,
    principalType: 'USER',
  };
  const PROFILE_ID = '10000000-0000-4000-8000-000000000003';

  const technician = {
    id: PROFILE_ID,
    authUserId: 'auth-tech',
    email: 'sam@texasrenters.com',
    displayName: 'Smauel Upchurch',
    phone: null as string | null,
    memberships: [{ role: UserRole.INSPECTION_TECHNICIAN }],
    _count: { roleAssignments: 0 },
  };

  function build(record: unknown = technician) {
    const tx = {
      userProfile: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      authCredential: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      authPasswordResetToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      userProfile: { findFirst: jest.fn().mockResolvedValue(record) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const cacheInvalidation = { publish: jest.fn() };
    const service = new AccountProfileService(prisma as never, cacheInvalidation as never);
    return { service, prisma, tx, cacheInvalidation };
  }

  describe('finding the account', () => {
    it('reaches only a technician of the caller organization from the technician page', async () => {
      const { service, prisma } = build();

      await service.update(actor, PROFILE_ID, 'TECHNICIAN', { displayName: 'Samuel Upchurch' });

      expect(prisma.userProfile.findFirst.mock.calls[0][0].where).toEqual({
        id: PROFILE_ID,
        memberships: {
          some: { organizationId: actor.organizationId, role: UserRole.INSPECTION_TECHNICIAN },
        },
      });
    });

    it('reaches only a console account of the caller organization from the user page', async () => {
      const { service, prisma } = build({
        ...technician,
        memberships: [{ role: UserRole.PROPERTY_ADMIN }],
      });

      await service.update(actor, PROFILE_ID, 'CONSOLE', { displayName: 'Samuel Upchurch' });

      const where = prisma.userProfile.findFirst.mock.calls[0][0].where;
      expect(where.id).toBe(PROFILE_ID);
      expect(where.OR).toEqual([
        {
          memberships: {
            some: {
              organizationId: actor.organizationId,
              role: { in: expect.not.arrayContaining([UserRole.INSPECTION_TECHNICIAN]) },
            },
          },
        },
        { roleAssignments: { some: { organizationId: actor.organizationId } } },
      ]);
    });

    it.each([
      ['TECHNICIAN', 'TECHNICIAN_NOT_FOUND'],
      ['CONSOLE', 'USER_NOT_FOUND'],
    ] as const)('answers 404 from the %s page when it is not there', async (scope, code) => {
      const { service, prisma } = build(null);

      await expect(
        service.update(actor, PROFILE_ID, scope, { displayName: 'Anyone' }),
      ).rejects.toMatchObject({ status: 404, code });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('name and phone', () => {
    it('renames, trimmed, and audits from and to', async () => {
      const { service, tx, cacheInvalidation } = build();

      await service.update(actor, PROFILE_ID, 'TECHNICIAN', {
        displayName: '  Samuel Upchurch ',
      });

      expect(tx.userProfile.update).toHaveBeenCalledWith({
        where: { id: PROFILE_ID },
        data: { displayName: 'Samuel Upchurch' },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: {
          organizationId: actor.organizationId,
          actorUserId: actor.id,
          action: 'PROFILE_UPDATED',
          entityType: 'UserProfile',
          entityId: PROFILE_ID,
          metadata: {
            scope: 'TECHNICIAN',
            changed: ['displayName'],
            displayName: { from: 'Smauel Upchurch', to: 'Samuel Upchurch' },
          },
        },
      });
      // Nothing about the sign-in moved.
      expect(tx.authCredential.updateMany).not.toHaveBeenCalled();
      expect(tx.authPasswordResetToken.updateMany).not.toHaveBeenCalled();
      // The roster is cached and shows the name.
      expect(cacheInvalidation.publish).toHaveBeenCalledWith({
        type: 'technician.changed',
        organizationId: actor.organizationId,
        technicianId: PROFILE_ID,
      });
    });

    it('refuses a name that is blank once trimmed', async () => {
      const { service, prisma } = build();

      await expect(
        service.update(actor, PROFILE_ID, 'TECHNICIAN', { displayName: '  S  ' }),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_DISPLAY_NAME' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('stores a phone number in E.164 and keeps the number out of the audit', async () => {
      const { service, tx } = build();

      await service.update(actor, PROFILE_ID, 'TECHNICIAN', { phone: '(713) 555-0100' });

      expect(tx.userProfile.update).toHaveBeenCalledWith({
        where: { id: PROFILE_ID },
        data: { phone: '+17135550100' },
      });
      const metadata = tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).toEqual({ scope: 'TECHNICIAN', changed: ['phone'] });
      expect(JSON.stringify(metadata)).not.toContain('5550100');
    });

    it.each([null, '', '   '])('clears the phone number given %p', async (phone) => {
      const { service, tx } = build({ ...technician, phone: '+17135550100' });

      await service.update(actor, PROFILE_ID, 'TECHNICIAN', { phone });

      expect(tx.userProfile.update).toHaveBeenCalledWith({
        where: { id: PROFILE_ID },
        data: { phone: null },
      });
    });

    it('refuses a phone number it cannot read, rather than storing part of it', async () => {
      const { service, prisma } = build();

      await expect(
        service.update(actor, PROFILE_ID, 'TECHNICIAN', { phone: '713 555 0100 ext 4' }),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_PHONE' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('writes and audits nothing when nothing changed', async () => {
      const { service, prisma, cacheInvalidation } = build({
        ...technician,
        phone: '+17135550100',
      });

      await service.update(actor, PROFILE_ID, 'TECHNICIAN', {
        displayName: 'Smauel Upchurch',
        email: 'SAM@texasrenters.com',
        phone: '713-555-0100',
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(cacheInvalidation.publish).not.toHaveBeenCalled();
    });

    it('lets an administrator rename their own account', async () => {
      const { service, tx } = build({ ...technician, id: actor.id });

      await service.update(actor, actor.id, 'TECHNICIAN', { displayName: 'Office Admin Two' });

      expect(tx.userProfile.update).toHaveBeenCalled();
    });
  });

  describe('sign-in email', () => {
    it('moves both copies of the address, retires reset links, and audits from and to', async () => {
      const { service, tx } = build();

      await service.update(actor, PROFILE_ID, 'TECHNICIAN', {
        email: '  Samuel@TexasRenters.com ',
      });

      expect(tx.authCredential.updateMany).toHaveBeenCalledWith({
        where: { authUserId: 'auth-tech' },
        data: { email: 'samuel@texasrenters.com' },
      });
      expect(tx.userProfile.update).toHaveBeenCalledWith({
        where: { id: PROFILE_ID },
        data: { email: 'samuel@texasrenters.com' },
      });
      // A link already in the old mailbox would still set this password.
      expect(tx.authPasswordResetToken.updateMany).toHaveBeenCalledWith({
        where: { authUserId: 'auth-tech', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
      expect(tx.auditLog.create.mock.calls[0][0].data.metadata).toEqual({
        scope: 'TECHNICIAN',
        changed: ['email'],
        email: { from: 'sam@texasrenters.com', to: 'samuel@texasrenters.com' },
      });
    });

    it.each(['profile', 'credential'] as const)(
      'refuses an address another %s already holds',
      async (holder) => {
        const { service, tx } = build();
        if (holder === 'profile') tx.userProfile.findFirst.mockResolvedValue({ id: 'other' });
        else tx.authCredential.findFirst.mockResolvedValue({ id: 'other' });

        await expect(
          service.update(actor, PROFILE_ID, 'TECHNICIAN', { email: 'taken@texasrenters.com' }),
        ).rejects.toMatchObject({ status: 409, code: 'EMAIL_IN_USE' });
        expect(tx.authCredential.updateMany).not.toHaveBeenCalled();
        expect(tx.userProfile.update).not.toHaveBeenCalled();
      },
    );

    it('answers a lost race on the unique index as the same refusal', async () => {
      const { service, tx } = build();
      tx.authCredential.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.update(actor, PROFILE_ID, 'TECHNICIAN', { email: 'race@texasrenters.com' }),
      ).rejects.toMatchObject({ status: 409, code: 'EMAIL_IN_USE' });
    });

    it('refuses to move the caller’s own sign-in address', async () => {
      const { service, prisma } = build({ ...technician, id: actor.id });

      await expect(
        service.update(actor, actor.id, 'TECHNICIAN', { email: 'mine@texasrenters.com' }),
      ).rejects.toMatchObject({ status: 409, code: 'CANNOT_CHANGE_OWN_EMAIL' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses to move the bootstrap administrator’s address', async () => {
      const { service, prisma } = build({
        ...technician,
        memberships: [{ role: UserRole.SYSTEM_ADMIN }],
      });

      await expect(
        service.update(actor, PROFILE_ID, 'CONSOLE', { email: 'root@texasrenters.com' }),
      ).rejects.toMatchObject({ status: 409, code: 'SYSTEM_ADMIN_PROTECTED' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('a technician who also signs in to the console', () => {
      const alsoConsole = {
        ...technician,
        memberships: [{ role: UserRole.INSPECTION_TECHNICIAN }, { role: UserRole.PROPERTY_ADMIN }],
      };
      const techManagerOnly = { ...actor, permissions: ['technicians:manage' as const] };

      it('keeps their address out of reach of somebody who only manages technicians', async () => {
        // A new address plus a reset link is that account, console included.
        const { service, prisma } = build(alsoConsole);

        await expect(
          service.update(techManagerOnly, PROFILE_ID, 'TECHNICIAN', {
            email: 'mine-now@texasrenters.com',
          }),
        ).rejects.toMatchObject({ status: 403, code: 'EMAIL_CHANGE_NEEDS_USERS_MANAGE' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('counts a custom role as console access, as the console does', async () => {
        const { service } = build({ ...technician, _count: { roleAssignments: 1 } });

        await expect(
          service.update(techManagerOnly, PROFILE_ID, 'TECHNICIAN', {
            email: 'mine-now@texasrenters.com',
          }),
        ).rejects.toMatchObject({ code: 'EMAIL_CHANGE_NEEDS_USERS_MANAGE' });
      });

      it('still lets the same caller fix their name and phone', async () => {
        const { service, tx } = build(alsoConsole);

        await service.update(techManagerOnly, PROFILE_ID, 'TECHNICIAN', {
          displayName: 'Samuel Upchurch',
          phone: '7135550100',
        });

        expect(tx.userProfile.update).toHaveBeenCalledWith({
          where: { id: PROFILE_ID },
          data: { displayName: 'Samuel Upchurch', phone: '+17135550100' },
        });
      });

      it('lets somebody who manages users change it', async () => {
        const { service, tx } = build(alsoConsole);

        await service.update(actor, PROFILE_ID, 'TECHNICIAN', {
          email: 'samuel@texasrenters.com',
        });

        expect(tx.authCredential.updateMany).toHaveBeenCalled();
      });
    });
  });
});
