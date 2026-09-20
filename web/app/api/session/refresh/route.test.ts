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
