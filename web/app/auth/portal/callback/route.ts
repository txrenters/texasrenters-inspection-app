import type { NextRequest } from 'next/server';

import { PORTAL_FLOW_COOKIE, portalRefusalOf } from '@/lib/portal';
import { apiBaseUrl, applySession, redirectTo } from '@/lib/session-cookies';

/**
 * GET /auth/portal/callback — where the TR Staff Portal sends the browser back.
 *
 * Hands what the portal sent, with the id of the sign-in this browser started,
 * to the API, which takes that sign-in (once), checks `state` before anything
 * else, exchanges the code and decides who the person is here. On success the
 * API's tokens become this browser's session cookies — a whole new session,
 * replacing whatever was there — and the person lands where they were going.
 * The portal's tokens never come here at all.
 *
 * The sign-in cookie is cleared whatever happens: it is good for one try.
 */
export const dynamic = 'force-dynamic';

/** The fields the API accepts, at the lengths it accepts. Nothing else is forwarded. */
const FORWARDED = { state: 512, code: 2_048, error: 256 } as const;

const SAFE_PATH = /^\/(?![/\\])[^\s\\]*$/;

export async function GET(request: NextRequest) {
  const flowId = request.cookies.get(PORTAL_FLOW_COOKIE)?.value;
  const finish = (response: ReturnType<typeof redirectTo>) => {
    response.cookies.set(PORTAL_FLOW_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/auth/portal',
      maxAge: 0,
    });
    return response;
  };
  if (!flowId) return finish(redirectTo('/login?portal_error=expired'));

  const body: Record<string, string> = { flowId };
  for (const [name, limit] of Object.entries(FORWARDED)) {
    const value = request.nextUrl.searchParams.get(name);
    if (value) body[name] = value.slice(0, limit);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/portal/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return finish(redirectTo('/login?portal_error=unavailable'));
  }

  if (!upstream.ok) {
    const refusal = (await upstream.json().catch(() => null)) as { details?: { reason?: unknown }[] } | null;
    const reason =
      portalRefusalOf(refusal?.details?.[0]?.reason) ??
      (upstream.status === 404 ? 'disabled' : upstream.status === 400 ? 'expired' : 'unavailable');
    return finish(redirectTo(`/login?portal_error=${reason}`));
  }

  const session = (await upstream.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    returnTo?: string;
  };
  // The API already narrowed this to a path on the console; checked again
  // here because it becomes a Location header.
  const destination = typeof session.returnTo === 'string' && SAFE_PATH.test(session.returnTo) ? session.returnTo : '/dashboard';
  const response = redirectTo(destination);
  // Never "remembered": a portal sign-in lasts at most twelve hours anyway,
  // and the portal itself is where someone stays signed in.
  applySession(response, session, { remember: false, portal: true });
  return finish(response);
}
