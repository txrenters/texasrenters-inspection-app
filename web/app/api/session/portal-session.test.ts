// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as portalAvailability } from './portal/route';
import { POST as renew } from './refresh/route';
import { DELETE as signOut, POST as signIn } from './route';

/** The session routes, for a session that came from the TR Staff Portal. */

const CONSOLE = 'https://inspection.texasrenters.com';
const cookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`)) ?? '';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const issued = { accessToken: 'h.p.s', refreshToken: 'next-refresh', expiresIn: 300, mustChangePassword: false };

describe('signing out', () => {
  const out = (refresh: string) =>
    signOut(new NextRequest(`${CONSOLE}/api/session`, { method: 'DELETE', headers: { cookie: `tr_refresh=${refresh}` } }));

  it('passes on where a portal session goes next, and clears every cookie', async () => {
    fetchMock.mockResolvedValue(Response.json({ signedOutUrl: 'https://login.texasrenters.com/dashboard' }));
    const response = await out('p.portal-token');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedOutUrl: 'https://login.texasrenters.com/dashboard' });
    for (const name of ['tr_access', 'tr_refresh', 'tr_remember', 'tr_portal'])
      expect(cookie(response, name)).toMatch(/Max-Age=0/);
  });

  it('is the 204 it always was for a password session', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const response = await out('password-token');
    expect(response.status).toBe(204);
  });

  it('never passes on anything but an https:// address', async () => {
    fetchMock.mockResolvedValue(Response.json({ signedOutUrl: 'javascript:alert(1)' }));
    expect((await out('p.portal-token')).status).toBe(204);
  });

  it('still clears the cookies when the API cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const response = await out('p.portal-token');
    expect(response.status).toBe(204);
    expect(cookie(response, 'tr_refresh')).toMatch(/Max-Age=0/);
  });
});

describe('renewing', () => {
  const renewWith = (cookies: string) =>
    renew(new NextRequest(`${CONSOLE}/api/session/refresh`, { method: 'POST', headers: { cookie: cookies } }));

  it('keeps a portal session marked as one across the rotation', async () => {
    fetchMock.mockResolvedValue(Response.json(issued));
    const response = await renewWith('tr_refresh=p.token; tr_portal=1');
    expect(cookie(response, 'tr_portal')).toMatch(/^tr_portal=1;/);
  });

  it('sends nothing about the portal for a password session', async () => {
    fetchMock.mockResolvedValue(Response.json(issued));
    const response = await renewWith('tr_refresh=password-token');
    expect(cookie(response, 'tr_portal')).toBe('');
  });

  it('tells the page to go back through the portal when the portal ended the session', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'PORTAL_SESSION_ENDED' }, { status: 401 }));
    const response = await renewWith('tr_refresh=p.token; tr_portal=1');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Session expired.', reauth: true });
    expect(cookie(response, 'tr_portal')).toMatch(/Max-Age=0/);
  });

  it('is an ordinary refusal for a password session', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'INVALID_CREDENTIALS' }, { status: 401 }));
    const response = await renewWith('tr_refresh=password-token');
    expect(await response.json()).toEqual({ message: 'Session expired.' });
  });
});

describe('a password sign-in after a portal one', () => {
  it('takes the portal marker back, and touches it only when it is there', async () => {
    fetchMock.mockImplementation(async () => Response.json(issued));
    const body = JSON.stringify({ email: 'a@texasrenters.com', password: 'x' });
    const after = await signIn(
      new NextRequest(`${CONSOLE}/api/session`, { method: 'POST', body, headers: { cookie: 'tr_portal=1' } }),
    );
    expect(cookie(after, 'tr_portal')).toMatch(/Max-Age=0/);
    const fresh = await signIn(new NextRequest(`${CONSOLE}/api/session`, { method: 'POST', body }));
    expect(cookie(fresh, 'tr_portal')).toBe('');
  });
});

describe('whether to offer the portal', () => {
  it('says yes only when the API does', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ enabled: true }));
    expect(await (await portalAvailability()).json()).toEqual({ enabled: true });
    fetchMock.mockResolvedValueOnce(Response.json({ enabled: false }));
    expect(await (await portalAvailability()).json()).toEqual({ enabled: false });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await (await portalAvailability()).json()).toEqual({ enabled: false });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await (await portalAvailability()).json()).toEqual({ enabled: false });
  });
});
