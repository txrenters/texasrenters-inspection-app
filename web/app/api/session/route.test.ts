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

describe('POST /api/session', () => {
  /**
   * The office (2026-09-17): only the technician app is held to one signed-in
   * device. Without `client`, an account that is a technician too was refused
   * here with "already signed in on another device", which the console cannot
   * even offer to take over.
   */
  it('signs in as the console, which is never held to one device', async () => {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await POST(
      new NextRequest('https://inspection.texasrenters.com/api/session', {
        method: 'POST',
        body: JSON.stringify({ email: 'coordinator@example.com', password: 'example-password' }),
      }),
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/auth/login');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      email: 'coordinator@example.com',
      password: 'example-password',
      client: 'console',
    });
  });
});

/**
 * "Remember me" (the office, 2026-10-02): a sign-in that outlives the browser,
 * for as long as the refresh token lives, only when asked for.
 */
describe('remembering a sign-in', () => {
  const issued = {
    accessToken: 'header.payload.signature',
    refreshToken: 'refresh-token',
    expiresIn: 3600,
    mustChangePassword: false,
  };

  async function signInWith(body: object) {
    process.env.API_INTERNAL_BASE_URL = 'http://backend:3000';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(issued)));
    return POST(
      new NextRequest('https://inspection.texasrenters.com/api/session', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  const cookie = (response: Response, name: string) =>
    response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`)) ?? '';

  it('keeps the refresh cookie past the browser for thirty days when asked, still httpOnly and scoped', async () => {
    const response = await signInWith({
      email: 'coordinator@example.com',
      password: 'example-password',
      remember: true,
    });

    const refresh = cookie(response, 'tr_refresh');
    expect(refresh).toMatch(/Max-Age=2592000/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Secure/i);
    expect(refresh).toMatch(/Path=\/api\/session/i);
    expect(cookie(response, 'tr_remember')).toMatch(/^tr_remember=1;/);
    expect(cookie(response, 'tr_remember')).toMatch(/Max-Age=2592000/i);
  });

  it('ends with the browser by default, and takes back an earlier remember', async () => {
    const response = await signInWith({ email: 'coordinator@example.com', password: 'example-password' });

    expect(cookie(response, 'tr_refresh')).not.toMatch(/Max-Age/i);
    expect(cookie(response, 'tr_remember')).toMatch(/Max-Age=0/i);
  });

  it('remembers only on a literal true', async () => {
    const response = await signInWith({
      email: 'coordinator@example.com',
      password: 'example-password',
      remember: 'yes',
    });

    expect(cookie(response, 'tr_refresh')).not.toMatch(/Max-Age/i);
  });

  it('never sends the choice to the API, which only issues the tokens', async () => {
    const response = await signInWith({
      email: 'coordinator@example.com',
      password: 'example-password',
      remember: true,
    });
    const fetchMock = vi.mocked(fetch);

    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('remember');
  });
});
