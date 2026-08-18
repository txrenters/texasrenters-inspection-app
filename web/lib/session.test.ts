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
