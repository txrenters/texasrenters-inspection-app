// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { config } from '../middleware';
import { PORTAL_REFUSAL_MESSAGES, isPublicPath, portalRefusalOf, portalSignInPath } from './portal';

/** Sign in with TR Staff Portal, the console's small half of it. */

describe('the portal sign-in address', () => {
  it('comes back to where the person was going', () => {
    expect(portalSignInPath('/inspections/42?tab=photos')).toBe(
      '/auth/portal/redirect?returnTo=%2Finspections%2F42%3Ftab%3Dphotos',
    );
    expect(portalSignInPath(null)).toBe('/auth/portal/redirect');
    expect(portalSignInPath('/')).toBe('/auth/portal/redirect');
  });
});

describe('a refusal in the URL', () => {
  it('picks one of the fixed sentences, and nothing else', () => {
    expect(portalRefusalOf('no_account')).toBe('no_account');
    expect(PORTAL_REFUSAL_MESSAGES.no_account).toContain('Ask an admin to add you');
    expect(PORTAL_REFUSAL_MESSAGES.no_access).toContain('Ask an admin to add you');
    for (const crafted of ['<script>', 'toString', '__proto__', '', null, 42])
      expect(portalRefusalOf(crafted)).toBeNull();
  });
});

describe('which pages are open signed out', () => {
  // middleware.ts cannot import the list, so the two are checked against each other.
  const guarded = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

  it.each([
    '/login',
    '/forgot-password',
    '/reset-password',
    '/report/abc',
    '/comparison-report/abc',
    '/privacy',
    '/support',
    '/auth/portal/redirect',
    '/auth/portal/callback',
    '/dashboard',
    '/inspections/42',
    '/settings',
    '/privacy/anything',
    '/supporting',
  ])('agrees with the middleware about %s', (path) => {
    expect(isPublicPath(path)).toBe(!guarded(path));
  });
});

describe('an ended portal session in the browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function browserAt(pathname: string, search = '') {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname, search, assign } });
    return assign;
  }

  it('goes back through the portal when renewal is refused, coming back to the same page', async () => {
    const assign = browserAt('/inspections/42', '?tab=photos');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Session expired.', reauth: true }, { status: 401 })));
    const { getSession } = await import('./session');

    await expect(getSession()).resolves.toBeNull();
    expect(assign).toHaveBeenCalledWith('/auth/portal/redirect?returnTo=%2Finspections%2F42%3Ftab%3Dphotos');
  });

  it('stays on a page anyone can open, like a homeowner’s report', async () => {
    const assign = browserAt('/report/abc123');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ reauth: true }, { status: 401 })));
    const { getSession } = await import('./session');

    await getSession();
    expect(assign).not.toHaveBeenCalled();
  });

  it('is an ordinary sign-out for a refused password session', async () => {
    const assign = browserAt('/dashboard');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Session expired.' }, { status: 401 })));
    const { getSession } = await import('./session');

    await getSession();
    expect(assign).not.toHaveBeenCalled();
  });

  it('sends someone signing out of a portal session to the portal’s dashboard', async () => {
    const assign = browserAt('/dashboard');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ signedOutUrl: 'https://login.texasrenters.com/dashboard' })),
    );
    const { signOut } = await import('./session');

    void signOut();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.texasrenters.com/dashboard'));
  });

  it('sends someone whose portal session ended back through the portal instead', async () => {
    const assign = browserAt('/map');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ signedOutUrl: 'https://login.texasrenters.com/dashboard' })),
    );
    const { signOut } = await import('./session');

    void signOut({ ended: true });
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/auth/portal/redirect?returnTo=%2Fmap'));
  });

  it('signs a password session out exactly as before', async () => {
    const assign = browserAt('/dashboard');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const { signOut } = await import('./session');

    await expect(signOut()).resolves.toBeUndefined();
    await expect(signOut({ ended: true })).resolves.toBeUndefined();
    expect(assign).not.toHaveBeenCalled();
  });
});
