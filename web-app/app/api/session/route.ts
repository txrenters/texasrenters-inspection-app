import { NextResponse, type NextRequest } from 'next/server';

import { REFRESH_COOKIE } from '@/lib/session';
import { apiBaseUrl, applySession, clearSession } from '@/lib/session-cookies';

/**
 * Sign in and sign out.
 *
 * These run on this app's origin so they can set the httpOnly refresh cookie —
 * the browser could not do it itself, which is the whole point. The API is
 * called from here rather than from the page, so the refresh token never
 * reaches script.
 *
 * `force-dynamic` because everything here is cookies and side effects; a cached
 * sign-in would be a security bug rather than a stale page.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let credentials: { email?: string; password?: string };
  try {
    credentials = (await request.json()) as typeof credentials;
  } catch {
    return NextResponse.json({ message: 'A valid request body is required.' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    });
  } catch {
    return NextResponse.json(
      { message: 'The administrator API could not be reached.' },
      { status: 503 },
    );
  }

  if (!upstream.ok) {
    const body = (await upstream.json().catch(() => null)) as { message?: string } | null;
    // The API answers every sign-in failure identically; passing its message
    // through keeps it that way rather than inventing a more specific one here.
    return NextResponse.json(
      { message: body?.message ?? 'That email address and password do not match an active account.' },
      { status: upstream.status === 401 ? 401 : 502 },
    );
  }

  const session = (await upstream.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    mustChangePassword: boolean;
  };

  // The tokens themselves are not returned to the page. It reads what it needs
  // from the access cookie; the refresh token stays out of script entirely.
  const response = NextResponse.json({ mustChangePassword: session.mustChangePassword });
  applySession(response, session, request.nextUrl.origin);
  return response;
}

export async function DELETE(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  const response = new NextResponse(null, { status: 204 });
  // Cookies are cleared whatever the API says. A backend that is unreachable
  // must not leave someone stuck signed in on a shared machine.
  clearSession(response);

  if (refreshToken) {
    await fetch(`${apiBaseUrl()}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }

  return response;
}
