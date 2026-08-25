import { hashSync } from 'bcryptjs';

import { verifyAccessTokenSignature } from '../src/common/auth';
import { LocalIdentityProvider } from '../src/auth/local-identity.provider';
import { PasswordResetService } from '../src/auth/password-reset.service';
import { SessionService } from '../src/auth/session.service';
import { TokenService } from '../src/auth/token.service';

const PASSWORD = 'Correct-Horse-9!';
const AUTH_USER_ID = 'auth-user-1';

/** Cost 4: these tests hash on every run and are not measuring bcrypt. */
const hashOf = (value: string) => hashSync(value, 4);

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    authUserId: AUTH_USER_ID,
    passwordHash: hashOf(PASSWORD),
    mustChangePassword: false,
    // No memberships by default: an account with no technician role is the
    // case that must never be held to one device.
    profile: { isActive: true, memberships: [] },
    ...overrides,
  };
}

const TECHNICIAN = { isActive: true, memberships: [{ role: 'INSPECTION_TECHNICIAN' }] };

/** A refresh token row that is live right now. */
const liveSession = {
  createdAt: new Date('2026-08-26T09:00:00.000Z'),
  userAgent: 'okhttp/4.12.0 (Android 13)',
};

function prismaFor(credential: unknown) {
  return {
    authCredential: {
      findUnique: jest.fn().mockResolvedValue(credential),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ mustChangePassword: false }),
      update: jest.fn().mockResolvedValue({}),
    },
    authRefreshToken: {
      create: jest.fn().mockResolvedValue({ id: 'refresh-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => run),
  };
}

describe('self-hosted token issuing', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'self-hosted-secret';
    process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth';
    process.env.AUTH_JWT_AUDIENCE = 'texasrenters';
  });

  afterEach(() => {
    delete process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_ISSUER;
    delete process.env.AUTH_JWT_AUDIENCE;
    delete process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS;
  });

  // The single most important test in this file. If minting and verification
  // ever disagree, every sign-in succeeds and then every subsequent request
  // 401s — a failure that looks like a client bug and is not.
  it('mints a token the existing verifier accepts', () => {
    const { token } = new TokenService().issueAccessToken({
      authUserId: AUTH_USER_ID,
      mustChangePassword: false,
    });

    const claims = verifyAccessTokenSignature(token);
    expect(claims.sub).toBe(AUTH_USER_ID);
    expect(claims.iss).toBe('https://api.texasrenters.com/auth');
  });

  it('carries mustChangePassword into the claim the guards read', () => {
    // RequiredPasswordAuthGuard and both permission guards read
    // app_metadata.must_change_password. The column is the source of truth now,
    // but the claim is still the transport.
    const { token } = new TokenService().issueAccessToken({
      authUserId: AUTH_USER_ID,
      mustChangePassword: true,
    });

    expect(verifyAccessTokenSignature(token).app_metadata?.must_change_password).toBe(true);
  });

  it('is rejected by a deployment configured for a different issuer', () => {
    const { token } = new TokenService().issueAccessToken({
      authUserId: AUTH_USER_ID,
      mustChangePassword: false,
    });

    process.env.AUTH_JWT_ISSUER = 'https://someone-else.example/auth';
    expect(() => verifyAccessTokenSignature(token)).toThrow();
  });

  it('honours a configured access-token lifetime', () => {
    process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS = '900';

    const issued = new TokenService().issueAccessToken({
      authUserId: AUTH_USER_ID,
      mustChangePassword: false,
    });
    expect(issued.expiresIn).toBe(900);
  });

  it('issues a distinct high-entropy refresh token each time, stored only as a hash', () => {
    const tokens = new TokenService();
    const a = tokens.createRefreshToken();
    const b = tokens.createRefreshToken();

    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    // The stored value must not be the token, or the table is a list of live
    // sessions in plaintext.
    expect(a.tokenHash).not.toBe(a.token);
    expect(a.tokenHash).toBe(tokens.hashRefreshToken(a.token));
  });
});

/**
 * One signed-in device per technician.
 *
 * Two handsets signed in as the same technician can both film the same rooms,
 * and the second copy is not extra evidence — it is a conflict somebody has to
 * reconcile. Nothing below the session layer can tell two handsets apart, so
 * this is the only place it can be enforced.
 */
describe('one device per technician', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'self-hosted-secret';
  });
  afterEach(() => delete process.env.AUTH_JWT_SECRET);

  it('refuses a technician already signed in elsewhere, and names the device', async () => {
    const prisma = prismaFor(credentialRow({ profile: TECHNICIAN }));
    prisma.authRefreshToken.findFirst.mockResolvedValue(liveSession);
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.signIn('user@example.com', PASSWORD)).rejects.toMatchObject({
      status: 409,
      code: 'SESSION_ALREADY_ACTIVE',
    });
    // Refused, not evicted: the other handset may be mid-walkthrough.
    expect(prisma.authRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.authRefreshToken.create).not.toHaveBeenCalled();
  });

  it('signs in and ends the other session when the takeover is asked for', async () => {
    const prisma = prismaFor(credentialRow({ profile: TECHNICIAN }));
    prisma.authRefreshToken.findFirst.mockResolvedValue(liveSession);
    const service = new SessionService(prisma as never, new TokenService());

    const session = await service.signIn('user@example.com', PASSWORD, {
      takeOverExistingSession: true,
    });

    expect(session.accessToken).toBeTruthy();
    expect(prisma.authRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revokedAt: null }) }),
    );
  });

  it('lets a technician sign in when no session is live', async () => {
    const prisma = prismaFor(credentialRow({ profile: TECHNICIAN }));
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.signIn('user@example.com', PASSWORD)).resolves.toMatchObject({
      tokenType: 'Bearer',
    });
  });

  /**
   * An administrator on a laptop and carrying the app is doing something
   * normal. Refusing it would teach people to share logins, which is the thing
   * this rule exists to prevent.
   */
  it('never holds a non-technician to one device', async () => {
    const prisma = prismaFor(credentialRow());
    prisma.authRefreshToken.findFirst.mockResolvedValue(liveSession);
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.signIn('user@example.com', PASSWORD)).resolves.toMatchObject({
      tokenType: 'Bearer',
    });
    // Not even looked for: the query is skipped before it is asked.
    expect(prisma.authRefreshToken.findFirst).not.toHaveBeenCalled();
  });

  it('still reads a wrong password as a wrong password', async () => {
    // The refusal must not become the answer to everything: a technician with
    // a live session and a typo needs to be told about the typo.
    const prisma = prismaFor(credentialRow({ profile: TECHNICIAN }));
    prisma.authRefreshToken.findFirst.mockResolvedValue(liveSession);
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.signIn('user@example.com', 'wrong')).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('sign-in', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'self-hosted-secret';
  });
  afterEach(() => delete process.env.AUTH_JWT_SECRET);

  it('accepts a Supabase-era $2a$ bcrypt hash unchanged', async () => {
    // The premise of the whole migration: hashes move across verbatim and
    // nobody is forced to reset.
    //
    // Every hash in the imported set is $2a$, which is what Supabase wrote;
    // bcryptjs emits $2b$. The two differ only in a wraparound fix for
    // passwords at or beyond 256 bytes, so relabelling a known hash is a
    // faithful stand-in for a real Supabase row — and unlike a memorised
    // constant, this one has a password we know.
    const supabaseEraHash = `$2a$${hashOf(PASSWORD).slice(4)}`;
    expect(supabaseEraHash.startsWith('$2a$')).toBe(true);

    const prisma = prismaFor(credentialRow({ passwordHash: supabaseEraHash }));
    const service = new SessionService(prisma as never, new TokenService());

    const session = await service.signIn('user@example.com', PASSWORD);

    expect(session.accessToken).toBeTruthy();
    expect(session.tokenType).toBe('Bearer');
  });

  it('rejects a wrong password', async () => {
    const prisma = prismaFor(credentialRow());
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.signIn('user@example.com', 'wrong')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
    expect(prisma.authRefreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown address with the same error as a wrong password', async () => {
    const prisma = prismaFor(null);
    const service = new SessionService(prisma as never, new TokenService());

    // Identical code and message, or the response tells an anonymous caller
    // which addresses have accounts.
    await expect(service.signIn('nobody@example.com', PASSWORD)).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('rejects a deactivated profile even with the right password', async () => {
    const prisma = prismaFor(credentialRow({ profile: { isActive: false, memberships: [] } }));
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.signIn('user@example.com', PASSWORD)).rejects.toMatchObject({
      status: 401,
    });
    expect(prisma.authRefreshToken.create).not.toHaveBeenCalled();
  });

  it('lower-cases the address before lookup', async () => {
    const prisma = prismaFor(credentialRow());
    const service = new SessionService(prisma as never, new TokenService());

    await service.signIn('  User@Example.COM ', PASSWORD);

    expect(prisma.authCredential.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'user@example.com' } }),
    );
  });

  it('never selects the hash into anything but the comparison', async () => {
    const prisma = prismaFor(credentialRow());
    const service = new SessionService(prisma as never, new TokenService());

    const session = await service.signIn('user@example.com', PASSWORD);

    // The response is what reaches the client; a hash must not be in it.
    expect(JSON.stringify(session)).not.toContain('$2');
  });
});

describe('refresh rotation', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'self-hosted-secret';
  });
  afterEach(() => delete process.env.AUTH_JWT_SECRET);

  function refreshPrisma(row: Record<string, unknown> | null) {
    const tx = {
      authRefreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'refresh-2' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      authRefreshToken: {
        findUnique: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return { prisma, tx };
  }

  const liveToken = (overrides: Record<string, unknown> = {}) => ({
    id: 'refresh-1',
    authUserId: AUTH_USER_ID,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    credential: { mustChangePassword: false, profile: { isActive: true } },
    ...overrides,
  });

  it('issues a new token and retires the presented one in one transaction', async () => {
    const { prisma, tx } = refreshPrisma(liveToken());
    const service = new SessionService(prisma as never, new TokenService());

    const session = await service.refresh('presented-token');

    expect(tx.authRefreshToken.create).toHaveBeenCalled();
    // Retired, and pointed at its replacement — that lineage is what makes a
    // replay detectable later.
    expect(tx.authRefreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'refresh-1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date), replacedById: 'refresh-2' }),
      }),
    );
    expect(session.refreshToken).toBeTruthy();
  });

  it('ends every session when a rotated-away token is replayed', async () => {
    // `replacedById` set means this token was retired by a rotation, so its
    // holder already received the replacement. Presenting the old one means
    // someone else kept a copy, and the account's other sessions cannot be
    // trusted either.
    const { prisma, tx } = refreshPrisma(
      liveToken({ revokedAt: new Date(), replacedById: 'refresh-2' }),
    );
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('stolen-token')).rejects.toMatchObject({ status: 401 });
    expect(prisma.authRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authUserId: AUTH_USER_ID, revokedAt: null } }),
    );
    expect(tx.authRefreshToken.create).not.toHaveBeenCalled();
  });

  it('treats a deliberately revoked token as expired, not as an attack', async () => {
    // Revoked with no replacement means a sign-out, a password change, or an
    // administrator. The legitimate client discovering its token is dead is the
    // expected outcome — raising an intrusion warning here fired once per
    // device after every password reset and would bury the real signal.
    const { prisma } = refreshPrisma(liveToken({ revokedAt: new Date(), replacedById: null }));
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('signed-out-token')).rejects.toMatchObject({ status: 401 });
    expect(prisma.authRefreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired token without revoking the account', async () => {
    const { prisma } = refreshPrisma(liveToken({ expiresAt: new Date(Date.now() - 1000) }));
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('old-token')).rejects.toMatchObject({ status: 401 });
    // Expiry is normal, not an attack — signing every other device out would be
    // punishing a technician for leaving the app closed over a weekend.
    expect(prisma.authRefreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    const { prisma } = refreshPrisma(null);
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('never-issued')).rejects.toMatchObject({ status: 401 });
  });

  it('stops refreshing once the profile is deactivated', async () => {
    const { prisma } = refreshPrisma(
      liveToken({ credential: { mustChangePassword: false, profile: { isActive: false } } }),
    );
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('token')).rejects.toMatchObject({ status: 401 });
  });
});

describe('local identity provider', () => {
  function providerPrisma() {
    const tx = {
      userProfile: { create: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
      authCredential: { create: jest.fn().mockResolvedValue({}), update: jest.fn() },
      authRefreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      authCredential: {
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return { prisma, tx };
  }

  it('writes the profile and the credential in one transaction', async () => {
    // The credential's foreign key points at the profile, so a two-step create
    // could leave a credential that authenticates and is then refused — the
    // exact seed drift already sitting in this database.
    const { prisma, tx } = providerPrisma();
    const provider = new LocalIdentityProvider(prisma as never);

    const { authUserId } = await provider.createTechnicianIdentity(
      ' Tech@Example.COM ',
      PASSWORD,
      'Tech Person',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.userProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authUserId, email: 'tech@example.com' }),
      }),
    );
    expect(tx.authCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authUserId, email: 'tech@example.com' }),
      }),
    );
  });

  it('stores a bcrypt hash, never the password', async () => {
    const { prisma, tx } = providerPrisma();
    const provider = new LocalIdentityProvider(prisma as never);

    await provider.createWebUserIdentity('user@example.com', PASSWORD, 'User');

    const { passwordHash } = tx.authCredential.create.mock.calls[0][0].data;
    expect(passwordHash).not.toBe(PASSWORD);
    expect(passwordHash).toMatch(/^\$2[aby]\$10\$/);
  });

  it('starts every provisioned account needing a password change', async () => {
    const { prisma, tx } = providerPrisma();
    const provider = new LocalIdentityProvider(prisma as never);

    await provider.createTechnicianIdentity('tech@example.com', PASSWORD, 'Tech');

    // The account is created with a temporary password an administrator can
    // read, so it is not usable until the holder replaces it.
    expect(tx.authCredential.create.mock.calls[0][0].data.mustChangePassword).toBe(true);
  });

  it('reports a taken address as the caller already expects', async () => {
    const { prisma } = providerPrisma();
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('unique constraint'));
    const provider = new LocalIdentityProvider(prisma as never);

    // Same code the Supabase gateway raised, so the provisioning services and
    // their tests do not change.
    await expect(
      provider.createTechnicianIdentity('taken@example.com', PASSWORD, 'Tech'),
    ).rejects.toMatchObject({ status: 409, code: 'TECHNICIAN_IDENTITY_NOT_CREATED' });
  });

  it('answers identityExists from the database rather than failing open', async () => {
    const { prisma } = providerPrisma();
    const provider = new LocalIdentityProvider(prisma as never);

    expect(await provider.identityExists('nobody')).toBe(false);
    prisma.authCredential.count.mockResolvedValue(1);
    expect(await provider.identityExists('somebody')).toBe(true);
  });

  it('ends every session when the password is replaced', async () => {
    // A password changed because it may have been exposed has not been replaced
    // at all if sessions opened with the old one keep working.
    const { prisma, tx } = providerPrisma();
    const provider = new LocalIdentityProvider(prisma as never);

    await provider.setPassword(AUTH_USER_ID, PASSWORD);

    expect(tx.authCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: false }) }),
    );
    expect(tx.authRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authUserId: AUTH_USER_ID, revokedAt: null } }),
    );
  });

  it('deletes the credential, leaving the profile to its own service', async () => {
    const { prisma } = providerPrisma();
    const provider = new LocalIdentityProvider(prisma as never);

    await provider.deleteIdentity(AUTH_USER_ID);

    // ProfileDeletionService owns whether the profile may go — it refuses
    // accounts with history. Refresh tokens follow the credential by cascade.
    expect(prisma.authCredential.deleteMany).toHaveBeenCalledWith({
      where: { authUserId: AUTH_USER_ID },
    });
  });
});

describe('password reset', () => {
  const RESET_TOKEN = 'a'.repeat(43);

  beforeEach(() => {
    process.env.AUTH_IDENTITY_PROVIDER = 'local';
    process.env.WEB_APP_ORIGIN = 'https://admin.example.com';
  });
  afterEach(() => {
    delete process.env.AUTH_IDENTITY_PROVIDER;
    delete process.env.WEB_APP_ORIGIN;
  });

  function resetPrisma(tokenRow: Record<string, unknown> | null, credential: unknown = {}) {
    const tx = {
      authPasswordResetToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    return {
      authCredential: { findUnique: jest.fn().mockResolvedValue(credential) },
      authPasswordResetToken: {
        findUnique: jest.fn().mockResolvedValue(tokenRow),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
      __tx: tx,
    };
  }

  const identities = () => ({ setPassword: jest.fn().mockResolvedValue(undefined) });
  const mailer = () => ({ sendPasswordReset: jest.fn().mockResolvedValue({ status: 'SENT' }) });

  const liveToken = (overrides: Record<string, unknown> = {}) => ({
    id: 'reset-1',
    authUserId: AUTH_USER_ID,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    credential: { profile: { isActive: true } },
    ...overrides,
  });

  it('mails a link carrying a token that is only stored hashed', async () => {
    const prisma = resetPrisma(null, {
      authUserId: AUTH_USER_ID,
      profile: { displayName: 'Ada', isActive: true },
    });
    const mail = mailer();
    const service = new PasswordResetService(prisma as never, identities() as never, mail as never);

    await service.request('ada@example.com');

    const { resetUrl } = mail.sendPasswordReset.mock.calls[0][0];
    const sentToken = new URL(resetUrl).searchParams.get('token');
    expect(sentToken).toBeTruthy();
    const { tokenHash } = prisma.__tx.authPasswordResetToken.create.mock.calls[0][0].data;
    expect(tokenHash).not.toBe(sentToken);
  });

  it('retires outstanding links before issuing another', async () => {
    // Otherwise asking twice leaves two live credentials in two mailboxes.
    const prisma = resetPrisma(null, {
      authUserId: AUTH_USER_ID,
      profile: { displayName: 'Ada', isActive: true },
    });
    const service = new PasswordResetService(
      prisma as never,
      identities() as never,
      mailer() as never,
    );

    await service.request('ada@example.com');

    expect(prisma.__tx.authPasswordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authUserId: AUTH_USER_ID, consumedAt: null } }),
    );
  });

  it('sends nothing for an unknown address, and says nothing either', async () => {
    const prisma = resetPrisma(null, null);
    const mail = mailer();
    const service = new PasswordResetService(prisma as never, identities() as never, mail as never);

    await expect(service.request('nobody@example.com')).resolves.toBeUndefined();
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('sends nothing to a deactivated account', async () => {
    // Mailing a working reset link to someone whose access was revoked would
    // undo the revocation.
    const prisma = resetPrisma(null, {
      authUserId: AUTH_USER_ID,
      profile: { displayName: 'Ada', isActive: false },
    });
    const mail = mailer();
    const service = new PasswordResetService(prisma as never, identities() as never, mail as never);

    await service.request('ada@example.com');
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('redeems a live token for a password change', async () => {
    const prisma = resetPrisma(liveToken());
    const identity = identities();
    const service = new PasswordResetService(prisma as never, identity as never, mailer() as never);

    await service.reset(RESET_TOKEN, PASSWORD);

    expect(identity.setPassword).toHaveBeenCalledWith(AUTH_USER_ID, PASSWORD);
  });

  it('consumes the token conditionally, so two simultaneous redemptions cannot both win', async () => {
    const prisma = resetPrisma(liveToken());
    prisma.authPasswordResetToken.updateMany.mockResolvedValue({ count: 0 });
    const identity = identities();
    const service = new PasswordResetService(prisma as never, identity as never, mailer() as never);

    // Losing the race must not set a password: the winner's would be silently
    // overwritten by the loser's.
    await expect(service.reset(RESET_TOKEN, PASSWORD)).rejects.toMatchObject({ status: 400 });
    expect(identity.setPassword).not.toHaveBeenCalled();
  });

  it.each([
    ['already used', { consumedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['for a deactivated account', { credential: { profile: { isActive: false } } }],
  ])('refuses a token that is %s', async (_label, overrides) => {
    const prisma = resetPrisma(liveToken(overrides));
    const identity = identities();
    const service = new PasswordResetService(prisma as never, identity as never, mailer() as never);

    await expect(service.reset(RESET_TOKEN, PASSWORD)).rejects.toMatchObject({
      status: 400,
      code: 'RESET_TOKEN_INVALID',
    });
    expect(identity.setPassword).not.toHaveBeenCalled();
  });

  it('refuses an unknown token with the identical error', async () => {
    // Distinguishing "never existed" from "expired" tells someone guessing
    // tokens which guesses were closer.
    const prisma = resetPrisma(null);
    const service = new PasswordResetService(
      prisma as never,
      identities() as never,
      mailer() as never,
    );

    await expect(service.reset(RESET_TOKEN, PASSWORD)).rejects.toMatchObject({
      status: 400,
      code: 'RESET_TOKEN_INVALID',
    });
  });
});

describe('replacing a temporary password', () => {
  // The step between "account created" and "account usable": every provisioned
  // account starts with mustChangePassword and the guards refuse until it is
  // cleared. It went through Supabase until the cutover, after which it
  // answered 502 and locked out every new technician — found by provisioning
  // one and trying to use it, which no unit test was doing.
  function prisma(credential: unknown) {
    return { authCredential: { findUnique: jest.fn().mockResolvedValue(credential) } };
  }
  const identities = () => ({ setPassword: jest.fn().mockResolvedValue(undefined) });

  it('sets the password when the account requires it', async () => {
    const identity = identities();
    const service = new PasswordResetService(
      prisma({ mustChangePassword: true }) as never,
      identity as never,
      undefined as never,
    );

    await service.changeRequiredPassword(AUTH_USER_ID, PASSWORD);

    // setPassword clears the flag and revokes every session in one transaction.
    expect(identity.setPassword).toHaveBeenCalledWith(AUTH_USER_ID, PASSWORD);
  });

  it('refuses when the account does not require one', async () => {
    // Re-checked against the column, not the token. The guard admits on a claim
    // fixed at sign-in, so a token minted before the change would otherwise
    // keep working as a password-reset endpoint for the life of that token.
    const identity = identities();
    const service = new PasswordResetService(
      prisma({ mustChangePassword: false }) as never,
      identity as never,
      undefined as never,
    );

    await expect(service.changeRequiredPassword(AUTH_USER_ID, PASSWORD)).rejects.toMatchObject({
      status: 403,
      code: 'PASSWORD_CHANGE_NOT_REQUIRED',
    });
    expect(identity.setPassword).not.toHaveBeenCalled();
  });

  it('refuses for an account that no longer exists', async () => {
    const identity = identities();
    const service = new PasswordResetService(
      prisma(null) as never,
      identity as never,
      undefined as never,
    );

    await expect(service.changeRequiredPassword(AUTH_USER_ID, PASSWORD)).rejects.toMatchObject({
      status: 404,
    });
    expect(identity.setPassword).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  it('revokes the presented token and says nothing about whether it existed', async () => {
    const prisma = {
      authRefreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.signOut('some-token')).resolves.toBeUndefined();
    expect(prisma.authRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
    );
  });
});
