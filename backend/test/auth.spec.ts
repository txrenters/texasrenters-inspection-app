import { createHmac } from 'node:crypto';

import { UserRole } from '@texasrenters/shared';

import {
  RequiredPasswordAuthGuard,
  RolesGuard,
  verifyAccessToken,
  verifyAccessTokenSignature,
} from '../src/common/auth';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(payload: Record<string, unknown>, secret = 'test-secret') {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('access-token validation', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth';
    process.env.AUTH_JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.AUTH_JWT_ISSUER;
    delete process.env.AUTH_JWT_AUDIENCE;
    delete process.env.AUTH_JWT_SECRET;
  });

  // Issuer, audience and signing key are all configuration. They used to fall
  // back to the Supabase shapes so tokens minted before the migration kept
  // verifying; that fallback is gone, so the guarantee worth pinning now is the
  // opposite one — unconfigured means refuse, not guess.
  describe('issuer configuration', () => {
    it('refuses to verify anything when no issuer is configured', () => {
      // Fail closed. A missing issuer must not degrade into accepting whatever
      // issuer a token happens to name.
      delete process.env.AUTH_JWT_ISSUER;

      expect(() =>
        verifyAccessTokenSignature(
          token({
            sub: 'auth-user',
            iss: 'https://api.texasrenters.com/auth',
            aud: 'authenticated',
            exp: Math.floor(Date.now() / 1000) + 60,
          }),
        ),
      ).toThrow(expect.objectContaining({ code: expect.stringMatching(/^AUTH_/) }));
    });

    it('accepts a token from our own issuer, audience and signing key', () => {
      process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth';
      process.env.AUTH_JWT_AUDIENCE = 'texasrenters';
      process.env.AUTH_JWT_SECRET = 'self-hosted-secret';

      const claims = verifyAccessTokenSignature(
        token(
          {
            sub: 'auth-user',
            iss: 'https://api.texasrenters.com/auth',
            aud: 'texasrenters',
            exp: Math.floor(Date.now() / 1000) + 60,
          },
          'self-hosted-secret',
        ),
      );
      expect(claims.sub).toBe('auth-user');
    });

    it('rejects a token minted by the old Supabase issuer', () => {
      // The cutover has to be a real boundary: a token minted by the issuer we
      // migrated off must stop working rather than quietly still passing.
      expect(() =>
        verifyAccessTokenSignature(
          token({
            sub: 'auth-user',
            iss: 'https://example.supabase.co/auth/v1',
            aud: 'authenticated',
            exp: Math.floor(Date.now() / 1000) + 60,
          }),
        ),
      ).toThrow(expect.objectContaining({ code: expect.stringMatching(/^AUTH_/) }));
    });

    it('tolerates a trailing slash on the configured issuer', () => {
      process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth/';

      const claims = verifyAccessTokenSignature(
        token({
          sub: 'auth-user',
          iss: 'https://api.texasrenters.com/auth',
          aud: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      );
      expect(claims.sub).toBe('auth-user');
    });
  });

  it('accepts a valid authenticated token', () => {
    const claims = verifyAccessTokenSignature(
      token({
        sub: 'auth-user-id',
        aud: 'authenticated',
        iss: 'https://api.texasrenters.com/auth',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    expect(claims.sub).toBe('auth-user-id');
  });

  it('preserves the required-password-change claim', () => {
    const claims = verifyAccessTokenSignature(
      token({
        sub: 'auth-user-id',
        aud: 'authenticated',
        iss: 'https://api.texasrenters.com/auth',
        exp: Math.floor(Date.now() / 1000) + 60,
        app_metadata: { must_change_password: true },
      }),
    );
    expect(claims.app_metadata?.must_change_password).toBe(true);
  });

  it('verifies HS256 tokens through the shared async verifier', async () => {
    const claims = await verifyAccessToken(
      token({
        sub: 'auth-user-id',
        aud: 'authenticated',
        iss: 'https://api.texasrenters.com/auth',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    expect(claims.sub).toBe('auth-user-id');
  });

  it.each([
    ['wrong signature', 'wrong-secret', Math.floor(Date.now() / 1000) + 60],
    ['expired token', 'test-secret', Math.floor(Date.now() / 1000) - 1],
  ])('rejects a %s', (_label, secret, exp) => {
    expect(() =>
      verifyAccessTokenSignature(
        token(
          {
            sub: 'auth-user-id',
            aud: 'authenticated',
            iss: 'https://api.texasrenters.com/auth',
            exp,
          },
          secret as string,
        ),
      ),
    ).toThrow(expect.objectContaining({ code: expect.stringMatching(/^AUTH_/) }));
  });

  it('rejects a token issued by an unrelated issuer', () => {
    expect(() =>
      verifyAccessTokenSignature(
        token({
          sub: 'auth-user-id',
          aud: 'authenticated',
          iss: 'https://attacker.example/auth/v1',
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: expect.stringMatching(/^AUTH_/) }));
  });
});

describe('temporary-password authorization boundary', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth';
    process.env.AUTH_JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.AUTH_JWT_ISSUER;
    delete process.env.AUTH_JWT_SECRET;
  });

  it('authenticates the temporary identity without requiring an application profile', async () => {
    const request = {
      header: () =>
        `Bearer ${token({
          sub: 'auth-user-id',
          aud: 'authenticated',
          iss: 'https://api.texasrenters.com/auth',
          exp: Math.floor(Date.now() / 1000) + 60,
          app_metadata: { must_change_password: true },
        })}`,
    } as Record<string, unknown>;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;

    await expect(new RequiredPasswordAuthGuard().canActivate(context)).resolves.toBe(true);
    expect(request.auth).toEqual({ authUserId: 'auth-user-id', mustChangePassword: true });
  });

  it('blocks role-protected APIs until the password is replaced', () => {
    const guard = new RolesGuard({
      getAllAndOverride: () => [UserRole.SYSTEM_ADMIN],
    } as never);
    const request = {
      user: {
        id: 'profile-id',
        authUserId: 'auth-user-id',
        organizationId: 'organization-id',
        displayName: 'Temporary Admin',
        roles: [UserRole.SYSTEM_ADMIN],
        mustChangePassword: true,
      },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as never;

    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ code: 'AUTH_PASSWORD_CHANGE_REQUIRED' }),
    );
  });
});
