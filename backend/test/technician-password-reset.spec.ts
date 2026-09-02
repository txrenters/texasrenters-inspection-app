import { UserRole } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import type { LocalIdentityProvider } from '../src/auth/local-identity.provider';
import type { MailService } from '../src/mail/mail.service';
import { PasswordResetService } from '../src/auth/password-reset.service';

/**
 * An administrator sending a technician a reset link.
 *
 * The interesting cases are all refusals: this endpoint mints a live credential
 * into somebody else's mailbox, so who it may be pointed at matters more than
 * the happy path.
 */
describe('admin-initiated technician password reset', () => {
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
  } as AuthenticatedUser;

  const TECHNICIAN_ID = '00000000-0000-4000-8000-000000000003';

  // The link is built from this. It was never set here, and every test in the
  // file still passed while the service mailed `/reset-password?token=...` --
  // a relative path in an email, which no mail client can open.
  beforeEach(() => {
    process.env.WEB_APP_ORIGIN = 'https://admin.example.com';
  });
  afterEach(() => {
    delete process.env.WEB_APP_ORIGIN;
  });

  function prismaMock() {
    const tx = {
      authPasswordResetToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    return {
      userProfile: { findFirst: jest.fn() },
      authCredential: { findUnique: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      tx,
    };
  }

  function build(
    prisma: ReturnType<typeof prismaMock>,
    mailStatus = 'SENT',
    readiness: 'CONFIGURED' | 'NOT_CONFIGURED' = 'CONFIGURED',
  ) {
    const mailer = {
      readiness: () => ({ status: readiness }),
      sendPasswordReset: jest.fn().mockResolvedValue({ status: mailStatus }),
    };
    const service = new PasswordResetService(
      prisma as unknown as PrismaService,
      {} as LocalIdentityProvider,
      mailer as unknown as MailService,
    );
    return { service, mailer };
  }

  const activeTechnician = {
    id: TECHNICIAN_ID,
    authUserId: 'auth-user-3',
    email: 'tech@texasrenters.com',
    displayName: 'Roonil Cajan',
    isActive: true,
  };

  it('scopes the lookup to a technician inside the caller organization', async () => {
    // The single most important assertion here. This where clause is what stops
    // an administrator resetting another tenant's people, and stops a
    // permission named "create technicians" from minting a link for an
    // administrator account.
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service } = build(prisma);

    await service.sendForTechnician(user, TECHNICIAN_ID);

    expect(prisma.userProfile.findFirst.mock.calls[0][0].where).toEqual({
      id: TECHNICIAN_ID,
      memberships: {
        some: {
          organizationId: user.organizationId,
          role: UserRole.INSPECTION_TECHNICIAN,
        },
      },
    });
  });

  it('refuses an unknown technician without minting anything', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(null);
    const { service, mailer } = build(prisma);

    await expect(service.sendForTechnician(user, TECHNICIAN_ID)).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('refuses a deactivated technician', async () => {
    // Mailing a working link to somebody whose access was revoked would undo
    // the revocation.
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue({ ...activeTechnician, isActive: false });
    const { service, mailer } = build(prisma);

    await expect(service.sendForTechnician(user, TECHNICIAN_ID)).rejects.toMatchObject({
      status: 409,
      code: 'TECHNICIAN_INACTIVE',
    });
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('refuses an account that has no sign-in credential', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue(null);
    const { service, mailer } = build(prisma);

    await expect(service.sendForTechnician(user, TECHNICIAN_ID)).rejects.toMatchObject({
      status: 409,
      code: 'TECHNICIAN_HAS_NO_CREDENTIAL',
    });
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('retires outstanding links before issuing a new one', async () => {
    // Otherwise each request leaves another live credential in another mailbox.
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service } = build(prisma);

    await service.sendForTechnician(user, TECHNICIAN_ID);

    expect(prisma.tx.authPasswordResetToken.updateMany).toHaveBeenCalledWith({
      where: { authUserId: activeTechnician.authUserId, consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('stores only a hash of the token', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service, mailer } = build(prisma);

    await service.sendForTechnician(user, TECHNICIAN_ID);

    const stored = prisma.tx.authPasswordResetToken.create.mock.calls[0][0].data;
    const mailedUrl = mailer.sendPasswordReset.mock.calls[0][0].resetUrl as string;
    // The row must not contain the bearer token that went out in the mail.
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mailedUrl).not.toContain(stored.tokenHash);
  });

  it('audits the send, and still audits when delivery fails', async () => {
    // Issuing the token is the sensitive act and it happened either way, so a
    // record that covered only successes would omit exactly the cases somebody
    // later needs to reconstruct.
    for (const [status, delivered] of [
      ['SENT', true],
      ['FAILED', false],
    ] as const) {
      const prisma = prismaMock();
      prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
      prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
      const { service } = build(prisma, status);

      const result = await service.sendForTechnician(user, TECHNICIAN_ID);

      expect(result).toEqual({ email: activeTechnician.email, delivered });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'PASSWORD_RESET_SENT',
          entityType: 'UserProfile',
          entityId: TECHNICIAN_ID,
          metadata: { delivered },
        },
      });
    }
  });

  it('keeps the token out of the audit metadata', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service, mailer } = build(prisma);

    await service.sendForTechnician(user, TECHNICIAN_ID);

    const mailedUrl = mailer.sendPasswordReset.mock.calls[0][0].resetUrl as string;
    const token = decodeURIComponent(mailedUrl.split('token=')[1] ?? '');
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(token);
  });

  it('mails a link the recipient can actually open', async () => {
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service, mailer } = build(prisma);

    await service.sendForTechnician(user, TECHNICIAN_ID);

    const mailedUrl = mailer.sendPasswordReset.mock.calls[0][0].resetUrl as string;
    expect(mailedUrl.startsWith('https://admin.example.com/reset-password?token=')).toBe(true);
  });

  it('refuses before minting when the mailer is not configured at all', async () => {
    // Same shape as the missing-origin refusal, and the same reasoning: a token
    // that cannot be posted is a live credential nobody asked for, and creating
    // it retires the technician's previous, still-working link. This is the
    // global case -- no transport, no credentials -- not a delivery failure for
    // one recipient, which is still reported as `delivered: false`.
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service, mailer } = build(prisma, 'SENT', 'NOT_CONFIGURED');

    await expect(service.sendForTechnician(user, TECHNICIAN_ID)).rejects.toMatchObject({
      code: 'PASSWORD_RESET_UNAVAILABLE',
    });
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
    expect(prisma.tx.authPasswordResetToken.create).not.toHaveBeenCalled();
    expect(prisma.tx.authPasswordResetToken.updateMany).not.toHaveBeenCalled();
  });

  it('still reports a per-recipient delivery failure rather than refusing', async () => {
    // The distinction the guard above must not swallow. Mail is configured and
    // this one send failed, so the token exists and the administrator is told
    // -- exactly the case the console renders as "could not be sent".
    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service } = build(prisma, 'FAILED');

    await expect(service.sendForTechnician(user, TECHNICIAN_ID)).resolves.toEqual({
      email: activeTechnician.email,
      delivered: false,
    });
    expect(prisma.tx.authPasswordResetToken.create).toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['not a URL', 'admin.example.com'],
  ])('refuses rather than mailing a dead link when the origin is %s', async (_label, origin) => {
    // Refusing loses nothing: the administrator is told, instead of being shown
    // a delivery they cannot act on, and the technician's existing link is left
    // alone rather than retired for a replacement that opens nowhere.
    if (origin === undefined) delete process.env.WEB_APP_ORIGIN;
    else process.env.WEB_APP_ORIGIN = origin;

    const prisma = prismaMock();
    prisma.userProfile.findFirst.mockResolvedValue(activeTechnician);
    prisma.authCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    const { service, mailer } = build(prisma);

    await expect(service.sendForTechnician(user, TECHNICIAN_ID)).rejects.toMatchObject({
      code: 'PASSWORD_RESET_UNAVAILABLE',
    });
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
    expect(prisma.tx.authPasswordResetToken.create).not.toHaveBeenCalled();
    // The outstanding link the technician may still be holding survives.
    expect(prisma.tx.authPasswordResetToken.updateMany).not.toHaveBeenCalled();
  });
});
