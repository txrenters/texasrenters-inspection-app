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

/**
 * A renewal that got no answer is not a sign-out (2026-11-24: "when remember
 * me is ticked, it should not expire for 12 hrs"). Reporting it as one sent a
 * remembered sign-in to the login page whenever a release restarted the server
 * or a laptop woke before its Wi-Fi.
 */
describe('a renewal nobody answered', () => {
  afterEach(() => {
    document.cookie = 'tr_remember=; max-age=0; path=/';
  });

  function passthroughLocks() {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: (_name: string, callback: () => Promise<unknown>) => callback() },
    });
  }

  /** Lets a rejected renewal finish settling before the test goes on. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it.each([
    ['the network is down', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the API could not be reached', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['the console is restarting behind the proxy', () => Promise.resolve(new Response(null, { status: 502 }))],
  ])('is not "no session" when %s', async (_case, answer) => {
    setAccessCookie(token(Math.floor(Date.now() / 1000) - 1));
    vi.stubGlobal('fetch', vi.fn(answer));
    passthroughLocks();

    const { getSession, SessionUnavailableError } = await import('./session');

    await expect(getSession()).rejects.toBeInstanceOf(SessionUnavailableError);
    // Not tried again outside the cross-tab lock.
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('is still no session when the API refuses the refresh token', async () => {
    setAccessCookie(token(Math.floor(Date.now() / 1000) - 1));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    passthroughLocks();

    const { getSession } = await import('./session');

    await expect(getSession()).resolves.toBeNull();
  });

  it('reports nothing on a remembered sign-in, and renews when the connection comes back', async () => {
    const now = Math.floor(Date.now() / 1000);
    setAccessCookie(token(now + 3600));
    document.cookie = 'tr_remember=1; path=/';
    const renewed = token(now + 7200, 'renewed-user');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(async () => {
        setAccessCookie(renewed);
        return new Response(null, { status: 200 });
      });
    vi.stubGlobal('fetch', fetchMock);
    passthroughLocks();

    const { onSessionChange } = await import('./session');
    const listener = vi.fn();
    const stop = onSessionChange(listener);

    // The hour is up as the laptop wakes, before its Wi-Fi does.
    document.cookie = 'tr_access=; max-age=0; path=/';
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await settle();
    expect(listener).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    stop();

    expect(listener).not.toHaveBeenCalledWith(null);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ authUserId: 'renewed-user' });
  });

  it('keeps a remembered sign-in through a twelve-hour day: hourly renewals, a release restart and a dropped connection', async () => {
    const start = Math.floor(Date.now() / 1000);
    setAccessCookie(token(start + 3600, 'hour-0'));
    document.cookie = 'tr_remember=1; path=/';
    let hour = 0;
    let outage: (() => Promise<Response>) | undefined;
    const fetchMock = vi.fn(async () => {
      const failure = outage;
      outage = undefined;
      if (failure) return failure();
      setAccessCookie(token(start + (hour + 1) * 3600, `hour-${hour}`));
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    passthroughLocks();

    const { onSessionChange } = await import('./session');
    const listener = vi.fn();
    const stop = onSessionChange(listener);

    for (hour = 1; hour <= 12; hour += 1) {
      // A release restarts the server at the fourth hour's renewal; the Wi-Fi
      // drops at the ninth.
      if (hour === 4) outage = async () => new Response(null, { status: 502 });
      if (hour === 9) outage = () => Promise.reject(new TypeError('Failed to fetch'));
      const failing = outage !== undefined;

      // The hour is up: the browser drops the access cookie, and the tab is used.
      document.cookie = 'tr_access=; max-age=0; path=/';
      window.dispatchEvent(new Event('focus'));
      if (failing) {
        await vi.waitFor(() => expect(outage).toBeUndefined());
        await settle();
        // The next check: the thirty-second interval, focus, or the connection back.
        window.dispatchEvent(new Event(hour === 9 ? 'online' : 'focus'));
      }
      await vi.waitFor(() =>
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ authUserId: `hour-${hour}` })),
      );
    }
    stop();

    expect(listener).not.toHaveBeenCalledWith(null);
    // Twelve renewals, and one more for each of the two that got no answer.
    expect(fetchMock).toHaveBeenCalledTimes(14);
  });
});
