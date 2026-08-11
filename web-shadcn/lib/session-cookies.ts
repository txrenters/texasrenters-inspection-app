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
 * `Secure`, always.
 *
 * This started as a heuristic that dropped `Secure` for localhost, and the
 * heuristic was wrong: inside the container the request origin is
 * `http://0.0.0.0:5454`, not localhost, so it set `Secure` anyway — and would
 * equally have *cleared* it on some real deployment whose origin happened to
 * look local. That is the wrong direction to fail in.
 *
 * Unconditional is both simpler and safer. Browsers treat `localhost` as a
 * trustworthy origin and accept `Secure` cookies there over plain HTTP, so
 * local development works; every real deployment is HTTPS. The one setup this
 * refuses is plain HTTP on a non-localhost host, which is not a deployment
 * anyone should have.
 */
export function applySession(response: NextResponse, session: IssuedSession) {
  const secure = true;

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

/**
 * The backend base URL **as the server sees it**, which is not the same URL the
 * browser uses.
 *
 * `NEXT_PUBLIC_API_BASE_URL` is inlined into the bundle for the browser, and in
 * the container stack it is `http://localhost:3000`. These route handlers run
 * server-side *inside the web container*, where `localhost` is the web
 * container itself — so using it made every sign-in fail with "The
 * administrator API could not be reached", which is precisely the mistake
 * compose.yaml warns about for REDIS_URL.
 *
 * `API_INTERNAL_BASE_URL` is a runtime variable, never inlined, and names the
 * backend by its compose service name. It falls back to the public URL because
 * outside the stack — `next dev` on a workstation — the two really are the same
 * host.
 */
export function apiBaseUrl() {
  const base = (
    process.env.API_INTERNAL_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL
  )?.replace(/\/$/, '');
  if (!base)
    throw new Error('Neither API_INTERNAL_BASE_URL nor NEXT_PUBLIC_API_BASE_URL is configured.');
  return base;
}
