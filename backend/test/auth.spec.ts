import { createHmac } from 'node:crypto';

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@texasrenters/shared';

import {
  RequiredPasswordAuthGuard,
  RolesGuard,
  verifySupabaseAccessToken,
  verifySupabaseJwt,
} from '../src/common/auth';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(payload: Record<string, unknown>, secret = 'test-secret') {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('Supabase access-token validation', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.AUTH_JWT_ISSUER;
    delete process.env.AUTH_JWT_AUDIENCE;
    delete process.env.AUTH_JWT_SECRET;
  });

  // The seam for moving off Supabase Auth: issuer, audience and signing key are
  // configurable, and default to the Supabase shapes so nothing changes until
  // they are set. See docs/migration/SUPABASE_TO_SELF_HOSTED.md.
  describe('self-hosted issuer seam', () => {
    it('defaults to the Supabase issuer and audience when unconfigured', () => {
      // Guards the migration: a default that drifted would reject every token
      // in circulation the moment this shipped, with no config change made.
      const claims = verifySupabaseJwt(
        token({
          sub: 'auth-user',
          iss: 'https://example.supabase.co/auth/v1',
          aud: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      );
      expect(claims.sub).toBe('auth-user');
    });

    it('accepts a token from our own issuer, audience and signing key', () => {
      process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth';
      process.env.AUTH_JWT_AUDIENCE = 'texasrenters';
      process.env.AUTH_JWT_SECRET = 'self-hosted-secret';

      const claims = verifySupabaseJwt(
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

    it('rejects a Supabase token once the issuer has moved', () => {
      // The cutover has to be a real boundary: after switching, a token minted
      // by the old issuer must stop working rather than quietly still passing.
      process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth';

      expect(() =>
        verifySupabaseJwt(
          token({
            sub: 'auth-user',
            iss: 'https://example.supabase.co/auth/v1',
            aud: 'authenticated',
            exp: Math.floor(Date.now() / 1000) + 60,
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('tolerates a trailing slash on the configured issuer', () => {
      process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth/';

      const claims = verifySupabaseJwt(
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

  it('accepts a valid authenticated Supabase token', () => {
    const claims = verifySupabaseJwt(
      token({
        sub: 'auth-user-id',
        aud: 'authenticated',
        iss: 'https://example.supabase.co/auth/v1',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    expect(claims.sub).toBe('auth-user-id');
  });

  it('preserves the required-password-change claim', () => {
    const claims = verifySupabaseJwt(
      token({
        sub: 'auth-user-id',
        aud: 'authenticated',
        iss: 'https://example.supabase.co/auth/v1',
        exp: Math.floor(Date.now() / 1000) + 60,
        app_metadata: { must_change_password: true },
      }),
    );
    expect(claims.app_metadata?.must_change_password).toBe(true);
  });

  it('supports legacy symmetric tokens through the shared async verifier', async () => {
    const claims = await verifySupabaseAccessToken(
      token({
        sub: 'auth-user-id',
        aud: 'authenticated',
        iss: 'https://example.supabase.co/auth/v1',
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
      verifySupabaseJwt(
        token(
          {
            sub: 'auth-user-id',
            aud: 'authenticated',
            iss: 'https://example.supabase.co/auth/v1',
            exp,
          },
          secret as string,
        ),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a token issued for another Supabase project', () => {
    expect(() =>
      verifySupabaseJwt(
        token({
          sub: 'auth-user-id',
          aud: 'authenticated',
          iss: 'https://attacker.example/auth/v1',
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      ),
    ).toThrow(UnauthorizedException);
  });
});

describe('temporary-password authorization boundary', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it('authenticates the temporary identity without requiring an application profile', async () => {
    const request = {
      header: () =>
        `Bearer ${token({
          sub: 'auth-user-id',
          aud: 'authenticated',
          iss: 'https://example.supabase.co/auth/v1',
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

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
