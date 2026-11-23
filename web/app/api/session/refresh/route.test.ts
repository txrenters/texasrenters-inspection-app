// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from './route';

const originalInternalApiUrl = process.env.API_INTERNAL_BASE_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalInternalApiUrl === undefined) delete process.env.API_INTERNAL_BASE_URL;
  else process.env.API_INTERNAL_BASE_URL = originalInternalApiUrl;
});

describe('POST /api/session/refresh', () => {
  it('treats a missing refresh cookie as an anonymous session', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('https://inspection.texasrenters.com/api/session/refresh'));

    expect(response.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 and clears cookies when the backend rejects a refresh token', async () => {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const request = new NextRequest('https://inspection.texasrenters.com/api/session/refresh', {
      headers: { cookie: 'tr_refresh=retired-token' },
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie().join(';')).toContain('tr_refresh=');
    expect(response.headers.getSetCookie().join(';')).toContain('tr_access=');
  });

  /** A session signed in before the API marked console sessions is marked here, so a phone stops counting it. */
  it('refreshes as the console', async () => {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new NextRequest('https://inspection.texasrenters.com/api/session/refresh', {
      headers: { cookie: 'tr_refresh=live-token' },
    });

    await POST(request);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      refreshToken: 'live-token',
      client: 'console',
    });
  });
});

describe('a remembered sign-in across a rotation', () => {
  const rotated = {
    accessToken: 'header.payload.signature',
    refreshToken: 'rotated-token',
    expiresIn: 3600,
    mustChangePassword: false,
  };
  const cookie = (response: Response, name: string) =>
    response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`)) ?? '';

  async function refreshWith(cookies: string) {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(rotated)));
    return POST(
      new NextRequest('https://inspection.texasrenters.com/api/session/refresh', {
        method: 'POST',
        headers: { cookie: cookies },
      }),
    );
  }

  it('stays remembered: the rotated refresh cookie still outlives the browser', async () => {
    const response = await refreshWith('tr_refresh=live-token; tr_remember=1');

    expect(cookie(response, 'tr_refresh')).toMatch(/^tr_refresh=rotated-token;/);
    expect(cookie(response, 'tr_refresh')).toMatch(/Max-Age=2592000/i);
    expect(cookie(response, 'tr_remember')).toMatch(/Max-Age=2592000/i);
  });

  it('is not remembered by a rotation when it never was', async () => {
    const response = await refreshWith('tr_refresh=live-token');

    expect(cookie(response, 'tr_refresh')).not.toMatch(/Max-Age/i);
  });

  it('is forgotten when the API refuses the token', async () => {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const response = await POST(
      new NextRequest('https://inspection.texasrenters.com/api/session/refresh', {
        method: 'POST',
        headers: { cookie: 'tr_refresh=revoked-token; tr_remember=1' },
      }),
    );

    expect(cookie(response, 'tr_remember')).toMatch(/Max-Age=0/i);
  });
});

/**
 * Only the API's refusal ends the session here (2026-11-24). A 500 while its
 * database pool was exhausted, or a 502 while it restarted for a release,
 * cleared every cookie -- signing a remembered sign-in out with a token that
 * was still good.
 */
describe('a refresh the API failed to answer', () => {
  async function refreshAnswered(status: number) {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
    return POST(
      new NextRequest('https://inspection.texasrenters.com/api/session/refresh', {
        method: 'POST',
        headers: { cookie: 'tr_refresh=live-token; tr_remember=1; tr_access=expired' },
      }),
    );
  }

  it.each([500, 502, 503, 504, 429, 404])('keeps every cookie when the API answers %i', async (status) => {
    const response = await refreshAnswered(status);

    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('keeps every cookie when the API cannot be reached at all', async () => {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const response = await POST(
      new NextRequest('https://inspection.texasrenters.com/api/session/refresh', {
        method: 'POST',
        headers: { cookie: 'tr_refresh=live-token; tr_remember=1' },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each([400, 401, 403])('still ends the session when the API refuses with %i', async (status) => {
    const response = await refreshAnswered(status);

    expect(response.status).toBe(401);
    const cleared = response.headers.getSetCookie().join(';');
    expect(cleared).toMatch(/tr_refresh=;/);
    expect(cleared).toMatch(/tr_remember=;/);
  });
});
