import { afterEach, describe, expect, it, vi } from 'vitest';

function token(expiresAt: number, subject = 'user-1') {
  const payload = btoa(
    JSON.stringify({ sub: subject, exp: expiresAt, app_metadata: { must_change_password: false } }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function setAccessCookie(value: string) {
  document.cookie = `tr_access=${encodeURIComponent(value)}; path=/`;
}

afterEach(() => {
  document.cookie = 'tr_access=; max-age=0; path=/';
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('getSession', () => {
  it('rechecks the shared cookie after acquiring the cross-tab refresh lock', async () => {
    const now = Math.floor(Date.now() / 1000);
    setAccessCookie(token(now - 1));
    const refreshed = token(now + 3600, 'refreshed-user');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => {
      // Simulate another tab completing its refresh while this tab waits.
      setAccessCookie(refreshed);
      return callback();
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    const { getSession } = await import('./session');
    const session = await getSession();

    expect(request).toHaveBeenCalledWith('texasrenters-session-refresh', expect.any(Function));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session).toMatchObject({ accessToken: refreshed, authUserId: 'refreshed-user' });
  });

  it('exchanges the refresh token while holding the cross-tab lock', async () => {
    const now = Math.floor(Date.now() / 1000);
    setAccessCookie(token(now - 1));
    const refreshed = token(now + 3600);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        setAccessCookie(refreshed);
        return new Response(null, { status: 204 });
      }),
    );
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback());
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    const { getSession } = await import('./session');
    const session = await getSession();

    expect(request).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/session/refresh', { method: 'POST' });
    expect(session?.accessToken).toBe(refreshed);
  });
});

/**
 * "Remember me" (2026-10-02). The access cookie lives exactly as long as its
 * token, so on a remembered sign-in its disappearing is the token running out,
 * not a sign-out -- and an idle tab used to be sent to the login page for it.
 */
describe('onSessionChange on a remembered sign-in', () => {
  afterEach(() => {
    document.cookie = 'tr_remember=; max-age=0; path=/';
  });

  function passthroughLocks() {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: (_name: string, callback: () => Promise<unknown>) => callback() },
    });
  }

  it('renews the session instead of reporting a sign-out', async () => {
    const now = Math.floor(Date.now() / 1000);
    setAccessCookie(token(now + 3600));
    document.cookie = 'tr_remember=1; path=/';
    const renewed = token(now + 7200, 'renewed-user');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        setAccessCookie(renewed);
        return new Response(null, { status: 200 });
      }),
    );
    passthroughLocks();

    const { onSessionChange } = await import('./session');
    const listener = vi.fn();
    const stop = onSessionChange(listener);

    // The hour is up: the browser drops the access cookie.
    document.cookie = 'tr_access=; max-age=0; path=/';
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    stop();

    expect(fetch).toHaveBeenCalledWith('/api/session/refresh', { method: 'POST' });
    expect(listener).not.toHaveBeenCalledWith(null);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ authUserId: 'renewed-user' });
  });

  it('still reports a sign-out when the sign-in was not remembered', async () => {
    const now = Math.floor(Date.now() / 1000);
    setAccessCookie(token(now + 3600));
    vi.stubGlobal('fetch', vi.fn());

    const { onSessionChange } = await import('./session');
    const listener = vi.fn();
    const stop = onSessionChange(listener);

    document.cookie = 'tr_access=; max-age=0; path=/';
    window.dispatchEvent(new Event('focus'));
    stop();

    expect(listener).toHaveBeenCalledWith(null);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a sign-out when the API refuses the renewal', async () => {
    const now = Math.floor(Date.now() / 1000);
    setAccessCookie(token(now + 3600));
    document.cookie = 'tr_remember=1; path=/';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    passthroughLocks();

    const { onSessionChange } = await import('./session');
    const listener = vi.fn();
    const stop = onSessionChange(listener);

    document.cookie = 'tr_access=; max-age=0; path=/';
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    stop();

    expect(listener).toHaveBeenCalledWith(null);
  });
});
