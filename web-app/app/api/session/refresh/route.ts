import { NextResponse, type NextRequest } from 'next/server';

import { REFRESH_COOKIE } from '@/lib/session';
import { apiBaseUrl, applySession, clearSession } from '@/lib/session-cookies';

/**
 * Exchange the httpOnly refresh cookie for a fresh pair.
 *
 * The page cannot do this itself — that is the point of the cookie being
 * httpOnly — so this handler is the only thing that ever sees the refresh
 * token, and it rewrites both cookies with what comes back.
 *
 * The refresh token rotates on every use, so the new one must be stored or the
 * next attempt replays a retired token and the API ends every session for the
 * account. Failing to write the cookie is therefore a sign-out, not a retry.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return NextResponse.json({ message: 'No session.' }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Unreachable API: leave the cookies alone. The token is probably still
    // good, and clearing it would turn a momentary outage into a sign-out with
    // no way back.
    return NextResponse.json({ message: 'The administrator API could not be reached.' }, { status: 503 });
  }

  if (!upstream.ok) {
    // Refused, so the token is genuinely dead — expired, revoked, or already
    // replayed. Clearing is correct here, and stops a loop of retries against
    // a token that will never work again.
    const response = NextResponse.json({ message: 'Session expired.' }, { status: 401 });
    clearSession(response);
    return response;
  }

  const session = (await upstream.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    mustChangePassword: boolean;
  };
  const response = NextResponse.json({ mustChangePassword: session.mustChangePassword });
  applySession(response, session, request.nextUrl.origin);
  return response;
}
