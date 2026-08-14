import { describe, expect, it } from 'vitest';

import { adminGuardRedirect, sessionRequiresPasswordChange } from './auth-session';
import { decodeSession, sessionIsExpired, type AppSession } from './session';

const session = (overrides: Partial<AppSession> = {}): AppSession => ({
  accessToken: 'token',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  authUserId: 'auth-user',
  mustChangePassword: false,
  ...overrides,
});

/** Mints an unsigned JWT shape — decodeSession never checks the signature. */
const encode = (claims: unknown) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

describe('temporary-password routing', () => {
  it('detects the server-controlled password-change flag', () => {
    expect(sessionRequiresPasswordChange(session({ mustChangePassword: true }))).toBe(true);
    expect(sessionRequiresPasswordChange(null)).toBe(false);
  });

  it('does not redirect an authenticated session when profile loading fails', () => {
    expect(adminGuardRedirect(session(), false)).toBeNull();
    expect(adminGuardRedirect(null, false)).toBe('/login');
  });
});

describe('session decoding', () => {
  it('reads the claims the backend mints', () => {
    const decoded = decodeSession(
      encode({
        sub: 'auth-user',
        exp: 4102444800,
        app_metadata: { must_change_password: true },
      }),
    );
    expect(decoded).toMatchObject({ authUserId: 'auth-user', mustChangePassword: true });
  });

  it('treats a token with no subject or expiry as no session', () => {
    // Middleware and the guard both branch on null, so a malformed cookie must
    // read as signed-out rather than as a session with undefined fields.
    expect(decodeSession(encode({ sub: 'auth-user' }))).toBeNull();
    expect(decodeSession(encode({ exp: 4102444800 }))).toBeNull();
    expect(decodeSession('not-a-jwt')).toBeNull();
  });

  it('reports expiry ahead of the deadline so a token does not die mid-request', () => {
    const almostGone = session({ expiresAt: Math.floor(Date.now() / 1000) + 30 });
    // Still valid to the second, but due for renewal — refreshing after the
    // fact surfaces as a random sign-out on an ordinary click.
    expect(sessionIsExpired(almostGone)).toBe(true);
    expect(sessionIsExpired(almostGone, 0)).toBe(false);
  });
});
