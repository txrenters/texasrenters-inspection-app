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
