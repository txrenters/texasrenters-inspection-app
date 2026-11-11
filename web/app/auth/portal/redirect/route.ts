import type { NextRequest } from 'next/server';

import { PORTAL_FLOW_COOKIE, PORTAL_FLOW_MAX_AGE_SECONDS } from '@/lib/portal';
import { apiBaseUrl, redirectTo } from '@/lib/session-cookies';

/**
 * GET /auth/portal/redirect — start "Sign in with TR Staff Portal".
 *
 * Asks the API for a new sign-in (a fresh `state` and PKCE verifier, kept on
 * the API with where the person was going) and sends the browser to the
 * portal with its challenge. This app keeps only the sign-in's id, in an
 * httpOnly cookie that only `/auth/portal` ever receives.
 *
 * Anything that goes wrong lands on the login page with a reason the page
 * turns into a sentence, never on an error page.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get('returnTo');

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/portal/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify(returnTo ? { returnTo: returnTo.slice(0, 2_048) } : {}),
      cache: 'no-store',
    });
  } catch {
    return redirectTo('/login?portal_error=unavailable');
  }
  if (!upstream.ok)
    return redirectTo(`/login?portal_error=${upstream.status === 404 ? 'disabled' : 'unavailable'}`);

  const started = (await upstream.json().catch(() => null)) as { flowId?: unknown; authorizeUrl?: unknown } | null;
  const flowId = typeof started?.flowId === 'string' ? started.flowId : '';
  const authorizeUrl = typeof started?.authorizeUrl === 'string' ? started.authorizeUrl : '';
  // Only ever to an https:// address the API named: this is not a redirect
  // anyone else can aim.
  if (!flowId || !authorizeUrl.startsWith('https://')) return redirectTo('/login?portal_error=unavailable');

  const response = redirectTo(authorizeUrl);
  response.cookies.set(PORTAL_FLOW_COOKIE, flowId, {
    httpOnly: true,
    secure: true,
    // Lax, not Strict: the portal's redirect back is a top-level navigation
    // from another site, and Strict would leave this cookie behind.
    sameSite: 'lax',
    path: '/auth/portal',
    maxAge: PORTAL_FLOW_MAX_AGE_SECONDS,
  });
  return response;
}
