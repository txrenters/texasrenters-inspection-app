import { NextResponse, type NextRequest } from 'next/server';

import { ACCESS_COOKIE, decodeSession, sessionIsExpired } from '@/lib/session';

/**
 * Server-side guard for the admin shell.
 *
 * Defense in depth only. Every API call is bearer-verified by the backend,
 * which remains the sole authority; this exists so an unauthenticated visitor
 * never receives an admin page in the first place.
 *
 * It checks the session cookie's expiry, not its signature. The signing key is
 * the backend's and deliberately does not live in this app — putting it here to
 * let middleware verify a token would spread the one secret that matters across
 * two deployments to re-check something the backend checks anyway. A forged
 * cookie gets someone an admin shell whose every request 401s.
 *
 * The previous version called Supabase's `getUser()` on every matched request —
 * a network round trip on each navigation. This is local.
 *
 * It also **fails closed**. The old one returned `next()` when its environment
 * variables were absent, so a web image built without them served admin routes
 * with no server-side guard at all, silently. There is nothing to misconfigure
 * here now: no cookie means no entry.
 */
export function middleware(request: NextRequest) {
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  const session = token ? decodeSession(token) : null;

  // Zero margin: an expiring token is the client's problem to refresh, and
  // bouncing someone to /login a minute early would be worse than letting a
  // page load whose first request refreshes.
  if (session && !sessionIsExpired(session, 0)) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except auth pages, the session route handlers, public
    // homeowner reports, Next.js internals, and static assets.
    '/((?!login|forgot-password|reset-password|report/|api/session|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
