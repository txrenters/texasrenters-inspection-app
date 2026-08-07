import { hashSync } from 'bcryptjs';

import { verifySupabaseJwt } from '../src/common/auth';
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
    profile: { isActive: true },
    ...overrides,
  };
}

function prismaFor(credential: unknown) {
  return {
    authCredential: {
      findUnique: jest.fn().mockResolvedValue(credential),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ mustChangePassword: false }),
      update: jest.fn().mockResolvedValue({}),
    },
    authRefreshToken: {
      create: jest.fn().mockResolvedValue({ id: 'refresh-1' }),
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

    const claims = verifySupabaseJwt(token);
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

    expect(verifySupabaseJwt(token).app_metadata?.must_change_password).toBe(true);
  });

  it('is rejected by a deployment configured for a different issuer', () => {
    const { token } = new TokenService().issueAccessToken({
      authUserId: AUTH_USER_ID,
      mustChangePassword: false,
    });

    process.env.AUTH_JWT_ISSUER = 'https://someone-else.example/auth';
    expect(() => verifySupabaseJwt(token)).toThrow();
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
    const prisma = prismaFor(credentialRow({ profile: { isActive: false } }));
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

  it('ends every session when an already-retired token is presented', async () => {
    // Nothing legitimate replays a retired token: the real holder moved on to
    // its replacement. So this is a captured token, and the account's other
    // sessions cannot be trusted either.
    const { prisma, tx } = refreshPrisma(liveToken({ revokedAt: new Date() }));
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('stolen-token')).rejects.toMatchObject({ status: 401 });
    expect(prisma.authRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authUserId: AUTH_USER_ID, revokedAt: null } }),
    );
    expect(tx.authRefreshToken.create).not.toHaveBeenCalled();
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
