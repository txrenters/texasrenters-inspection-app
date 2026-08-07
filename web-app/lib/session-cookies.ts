import type { NextResponse } from 'next/server';

import { ACCESS_COOKIE, REFRESH_COOKIE } from './session';

/**
 * Server-side cookie handling for the admin session.
 *
 * Kept apart from `lib/session.ts` so the browser bundle never imports
 * `next/server`, and so the two sets of cookie options live in one place rather
 * than being retyped in each route handler.
 */

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * `Secure` everywhere except plain-HTTP localhost, which cannot set it.
 *
 * Derived from the request rather than NODE_ENV: the remote beta runs a
 * production build over an HTTPS tunnel, and keying this off the build mode
 * would drop `Secure` on exactly the deployment that is actually exposed.
 */
function secureFor(origin: string) {
  return !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1');
}

export function applySession(response: NextResponse, session: IssuedSession, origin: string) {
  const secure = secureFor(origin);

  // Readable by script: lib/api.ts puts it in an Authorization header on every
  // request. Short-lived, so an exfiltrated one buys only its remaining life.
  response.cookies.set(ACCESS_COOKIE, session.accessToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: session.expiresIn,
  });

  // httpOnly, and scoped to the route handlers that exchange it. Script cannot
  // read it, and it is never sent to any other path — including the API, which
  // receives the bearer token instead.
  response.cookies.set(REFRESH_COOKIE, session.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/api/session',
    // Deliberately a session cookie rather than matching the refresh token's
    // 30-day life: closing the browser ends the session on a shared machine,
    // which is what an office workstation needs.
    maxAge: undefined,
  });
}

export function clearSession(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE, '', { path: '/api/session', maxAge: 0 });
}

/** The backend base URL, as the route handlers see it. */
export function apiBaseUrl() {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!base) throw new Error('NEXT_PUBLIC_API_BASE_URL is not configured.');
  return base;
}
