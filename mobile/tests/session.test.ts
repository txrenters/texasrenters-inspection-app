// `environment` resolves the API URL from EXPO_PUBLIC_* at module load, and the
// test run has none, so the real module leaves it null and every call throws
// "not configured" before reaching the code under test.
jest.mock('../src/config/environment', () => ({
  environment: {
    apiBaseUrl: 'https://api.test.invalid',
    apiBaseUrls: ['https://api.test.invalid'],
  },
}));

/* eslint-disable import/first */
import {
  getSession,
  onSessionChange,
  requestPasswordReset,
  resetSessionCache,
  signIn,
  signOut,
} from '../src/auth/session';
import { sessionStorage } from '../src/auth/session-storage';
/* eslint-enable import/first */

/** An unsigned JWT shape — nothing here verifies signatures, by design. */
function token(claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const inSeconds = (offset: number) => Math.floor(Date.now() / 1000) + offset;
const live = (overrides: Record<string, unknown> = {}) =>
  token({ sub: 'auth-user', exp: inSeconds(3600), ...overrides });
const stale = () => token({ sub: 'auth-user', exp: inSeconds(10) });

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const ok = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(async () => {
  fetchMock.mockReset();
  resetSessionCache();
  await sessionStorage.removeItem('texasrenters.session');
});

describe('mobile session', () => {
  it('signs in and keeps the tokens for later launches', async () => {
    fetchMock.mockResolvedValue(ok({ accessToken: live(), refreshToken: 'refresh-1' }));

    const session = await signIn('tech@example.com', 'password');
    expect(session.authUserId).toBe('auth-user');

    // Read back through storage, not the in-memory copy — a cold start has
    // only what SecureStore kept.
    resetSessionCache();
    expect((await getSession())?.refreshToken).toBe('refresh-1');
  });

  it('surfaces the API message when sign-in is refused', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: 'No match.' }) });

    await expect(signIn('tech@example.com', 'wrong')).rejects.toThrow('No match.');
    expect(await getSession()).toBeNull();
  });

  /**
   * A fault between the handset and the server is not a wrong password.
   *
   * Sign-in used to answer "that email address and password do not match" for
   * every non-OK response, including ones the API never produced. A technician
   * reading that goes and resets a password that was always right — which is
   * exactly what happened: a reset was requested and completed, and sign-in
   * still failed, because the credentials were never the problem.
   *
   * `requestPasswordReset` in the same file was fixed for this and sign-in was
   * left behind. These hold the two apart.
   */
  it('does not blame the password when the answer did not come from the API', async () => {
    // A proxy error page: not JSON, so there is no message to repeat.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });

    const failure = signIn('tech@example.com', 'password');
    await expect(failure).rejects.toThrow(/HTTP 502/);
    // The claim that must not be made: nothing here checked the password.
    await expect(failure).rejects.not.toThrow(/do not match/);
  });

  it('says the server is unreachable rather than reporting a bad password', async () => {
    // What an app pointed at an address that no longer answers actually hits.
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    const failure = signIn('tech@example.com', 'password');
    await expect(failure).rejects.toThrow(/Could not reach the TexasRenters server/);
    // Names the host, so whoever can read it knows where the build is pointed.
    await expect(failure).rejects.toThrow(/api\.test\.invalid/);
    await expect(failure).rejects.not.toThrow(/do not match/);
  });

  it('still offers a way forward when the account is signed in elsewhere', async () => {
    // The 409 keeps its own handling: the screen needs the code to know it can
    // offer to take the other device over.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        code: 'SESSION_ALREADY_ACTIVE',
        message: 'Already signed in on an iPhone.',
      }),
    });

    await expect(signIn('tech@example.com', 'password')).rejects.toThrow(
      'Already signed in on an iPhone.',
    );
  });

  it('refreshes a token that is close to expiry before handing it out', async () => {
    // Ten seconds of life left is inside the renewal margin. Returning it would
    // hand the caller a token that dies mid-request.
    fetchMock.mockResolvedValueOnce(ok({ accessToken: stale(), refreshToken: 'refresh-1' }));
    await signIn('tech@example.com', 'password');

    fetchMock.mockResolvedValueOnce(ok({ accessToken: live(), refreshToken: 'refresh-2' }));
    const session = await getSession();

    expect(session?.refreshToken).toBe('refresh-2');
    expect(fetchMock.mock.calls[1][0]).toContain('/auth/refresh');
  });

  it('shares one refresh between concurrent callers', async () => {
    // Refresh tokens rotate. Six parallel requests refreshing separately would
    // present the same retired token five times, which the backend correctly
    // reads as theft and answers by ending every session.
    fetchMock.mockResolvedValueOnce(ok({ accessToken: stale(), refreshToken: 'refresh-1' }));
    await signIn('tech@example.com', 'password');

    fetchMock.mockResolvedValueOnce(ok({ accessToken: live(), refreshToken: 'refresh-2' }));
    await Promise.all([getSession(), getSession(), getSession()]);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it('keeps the session when the API cannot be reached', async () => {
    // Losing the session takes the offline cache with it: cacheKey throws
    // without one, so a technician inside a unit with no signal would have no
    // cached data at all rather than stale data.
    fetchMock.mockResolvedValueOnce(ok({ accessToken: stale(), refreshToken: 'refresh-1' }));
    await signIn('tech@example.com', 'password');

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect((await getSession())?.refreshToken).toBe('refresh-1');
  });

  it('drops the session when the API refuses the refresh', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accessToken: stale(), refreshToken: 'refresh-1' }));
    await signIn('tech@example.com', 'password');

    // Refused means genuinely dead — expired, revoked, or already replayed.
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await getSession()).toBeNull();
    resetSessionCache();
    expect(await getSession()).toBeNull();
  });

  it('clears the device even when sign-out cannot reach the API', async () => {
    fetchMock.mockResolvedValueOnce(ok({ accessToken: live(), refreshToken: 'refresh-1' }));
    await signIn('tech@example.com', 'password');

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await signOut();

    // A technician signing out on a shared handset with no signal must still
    // be signed out.
    resetSessionCache();
    expect(await getSession()).toBeNull();
  });

  it('notifies listeners so the socket can reconnect or drop', async () => {
    const seen: (string | null)[] = [];
    const unsubscribe = onSessionChange((session) => seen.push(session?.authUserId ?? null));

    fetchMock.mockResolvedValueOnce(ok({ accessToken: live(), refreshToken: 'refresh-1' }));
    await signIn('tech@example.com', 'password');
    fetchMock.mockResolvedValueOnce(ok({}));
    await signOut();
    unsubscribe();

    expect(seen).toEqual(['auth-user', null]);
  });

  it('treats a malformed stored token as signed out', async () => {
    // The chunked SecureStore writer can leave a torn value if the process dies
    // mid-write; that must read as signed out rather than crash the launch.
    await sessionStorage.setItem('texasrenters.session', '{not json');
    resetSessionCache();
    expect(await getSession()).toBeNull();
  });

  describe('reset link request', () => {
    it('resolves for any address the API accepts', async () => {
      // 204 whether or not the address has an account -- the API refuses to say,
      // and a screen that reported "no such account" would give away what the
      // endpoint withholds.
      fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
      await expect(requestPasswordReset('tech@example.com')).resolves.toBeUndefined();
    });

    it('reports a 404 instead of claiming the link was sent', async () => {
      // This endpoint answers 204 for every address, so a 404 means the request
      // never reached it: a stale API address in the build, or a tunnel that is
      // down. It used to be swallowed as success, which put "a reset link is on
      // its way" in front of the one person who could not afford to wait for it.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(requestPasswordReset('tech@example.com')).rejects.toThrow('HTTP 404');
    });

    it('carries the API message when the server explains itself', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ message: 'Password reset is unavailable right now.' }),
      });

      await expect(requestPasswordReset('tech@example.com')).rejects.toThrow(
        'Password reset is unavailable right now.',
      );
    });

    it('names the host it could not reach', async () => {
      // "Try again in a moment" is the wrong advice for an app pointed at a
      // server it will never reach; the host is the one detail that lets the
      // office say why.
      fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));

      await expect(requestPasswordReset('tech@example.com')).rejects.toThrow('api.test.invalid');
    });
  });

  it('carries the password-change flag off the token', async () => {
    fetchMock.mockResolvedValue(
      ok({
        accessToken: live({ app_metadata: { must_change_password: true } }),
        refreshToken: 'refresh-1',
      }),
    );

    expect((await signIn('tech@example.com', 'temp')).mustChangePassword).toBe(true);
  });
});
