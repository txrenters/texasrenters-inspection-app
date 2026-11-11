// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as callback } from './callback/route';
import { GET as redirect } from './redirect/route';

/**
 * The console's two portal routes. The API is mocked: these only move the
 * browser and its cookies, and decide nothing themselves.
 */

const CONSOLE = 'https://inspection.texasrenters.com';
const AUTHORIZE = 'https://login.texasrenters.com/oauth/authorize?response_type=code&state=s';
const FLOW_ID = 'f'.repeat(43);

const cookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`)) ?? '';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('GET /auth/portal/redirect', () => {
  it('sends the browser to the portal and keeps only the sign-in’s id, httpOnly and scoped', async () => {
    fetchMock.mockResolvedValue(Response.json({ flowId: FLOW_ID, authorizeUrl: AUTHORIZE }));

    const response = await redirect(new NextRequest(`${CONSOLE}/auth/portal/redirect?returnTo=%2Finspections%2F42`));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(AUTHORIZE);
    const flow = cookie(response, 'tr_portal_flow');
    expect(flow).toMatch(new RegExp(`^tr_portal_flow=${FLOW_ID};`));
    expect(flow).toMatch(/HttpOnly/i);
    expect(flow).toMatch(/Secure/i);
    expect(flow).toMatch(/SameSite=lax/i);
    expect(flow).toMatch(/Path=\/auth\/portal/);
    expect(flow).toMatch(/Max-Age=600/);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://backend:3000/api/v1/auth/portal/start');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ returnTo: '/inspections/42' });
  });

  it('lands on the login page with a reason when the portal is off or the API is down', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await redirect(new NextRequest(`${CONSOLE}/auth/portal/redirect`))).headers.get('location')).toBe(
      '/login?portal_error=disabled',
    );
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await redirect(new NextRequest(`${CONSOLE}/auth/portal/redirect`))).headers.get('location')).toBe(
      '/login?portal_error=unavailable',
    );
  });

  it('never redirects anywhere but an https:// address the API named', async () => {
    fetchMock.mockResolvedValue(Response.json({ flowId: FLOW_ID, authorizeUrl: 'javascript:alert(1)' }));
    const response = await redirect(new NextRequest(`${CONSOLE}/auth/portal/redirect`));
    expect(response.headers.get('location')).toBe('/login?portal_error=unavailable');
    expect(cookie(response, 'tr_portal_flow')).toBe('');
  });
});

describe('GET /auth/portal/callback', () => {
  const issued = {
    accessToken: 'header.payload.signature',
    refreshToken: `p.${'a'.repeat(22)}.${'b'.repeat(43)}`,
    expiresIn: 300,
    mustChangePassword: false,
    returnTo: '/inspections/42',
  };

  const back = (query: string, withFlow = true) =>
    callback(
      new NextRequest(`${CONSOLE}/auth/portal/callback?${query}`, {
        headers: withFlow ? { cookie: `tr_portal_flow=${FLOW_ID}` } : {},
      }),
    );

  it('refuses a browser that started no sign-in, without asking the API', async () => {
    const response = await back('code=c&state=s', false);
    expect(response.headers.get('location')).toBe('/login?portal_error=expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only what the API accepts, and never the portal’s own words', async () => {
    fetchMock.mockResolvedValue(Response.json(issued));
    await back('code=c&state=s&error_description=%3Cb%3Ehi%3C%2Fb%3E&iss=https%3A%2F%2Flogin.texasrenters.com');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://backend:3000/api/v1/auth/portal/complete');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ flowId: FLOW_ID, code: 'c', state: 's' });
  });

  it('signs the browser in with the API’s session and lands where the person was going', async () => {
    fetchMock.mockResolvedValue(Response.json(issued));
    const response = await back('code=c&state=s');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/inspections/42');
    expect(cookie(response, 'tr_access')).toMatch(/^tr_access=header\.payload\.signature;/);
    const refresh = cookie(response, 'tr_refresh');
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/api\/session/);
    // Ends with the browser: never remembered.
    expect(refresh).not.toMatch(/Max-Age/i);
    expect(cookie(response, 'tr_portal')).toMatch(/^tr_portal=1;/);
    // Used once.
    expect(cookie(response, 'tr_portal_flow')).toMatch(/Max-Age=0/);
  });

  it('falls back to the dashboard rather than follow anything but a path here', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...issued, returnTo: '//evil.example' }));
    expect((await back('code=c&state=s')).headers.get('location')).toBe('/dashboard');
  });

  it.each([
    ['no_account', 403, { code: 'PORTAL_SIGN_IN_REFUSED', details: [{ reason: 'no_account' }] }, 'no_account'],
    ['no_access', 403, { code: 'PORTAL_SIGN_IN_REFUSED', details: [{ reason: 'no_access' }] }, 'no_access'],
    ['expired', 400, { code: 'PORTAL_SIGN_IN_REFUSED', details: [{ reason: 'expired' }] }, 'expired'],
    ['a crafted reason', 403, { details: [{ reason: '<script>' }] }, 'unavailable'],
    ['a validation failure', 400, { code: 'VALIDATION_ERROR' }, 'expired'],
    ['the portal switched off', 404, { code: 'PORTAL_DISABLED' }, 'disabled'],
  ])('shows a refusal (%s) on the login page, with no session', async (_label, status, body, reason) => {
    fetchMock.mockResolvedValue(Response.json(body, { status }));
    const response = await back('code=c&state=s');
    expect(response.headers.get('location')).toBe(`/login?portal_error=${reason}`);
    expect(cookie(response, 'tr_access')).toBe('');
    expect(cookie(response, 'tr_refresh')).toBe('');
    expect(cookie(response, 'tr_portal_flow')).toMatch(/Max-Age=0/);
  });

  it('treats an API it cannot reach as unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect((await back('code=c&state=s')).headers.get('location')).toBe('/login?portal_error=unavailable');
  });
});
