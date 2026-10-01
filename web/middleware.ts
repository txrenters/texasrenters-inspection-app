import { NextResponse, type NextRequest } from 'next/server';

import { ACCESS_COOKIE, REMEMBER_COOKIE, decodeSession, sessionIsExpired } from '@/lib/session';

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

  /**
   * A remembered sign-in whose hour-long access token has run out. The page
   * loads and renews it before its first request, under the browser's
   * cross-tab lock -- not here, where a renewal racing another tab's would
   * replay a rotated token and the API would end every session for the
   * account. What gets through is what a forged access cookie already gets: a
   * shell whose every request the API refuses, and which the page then sends
   * to sign in.
   */
  if (request.cookies.has(REMEMBER_COOKIE)) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except auth pages, the session route handlers, public
    // homeowner reports, Next.js internals, and static assets.
    //
    // Audio extensions are in that list for the notification chime. Without
    // them the middleware treated /notification.mp3 as a protected route: a
    // browser holding a valid cookie still got the file, so it appeared to
    // work, but a lapsed session made the Audio element fetch the login page
    // instead and the sound simply stopped, with nothing to indicate why.
    '/((?!login|forgot-password|reset-password|report/|api/session|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp3|wav|ogg)$).*)',
  ],
};
