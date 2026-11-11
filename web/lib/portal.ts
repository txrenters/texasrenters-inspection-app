/**
 * Sign in with TR Staff Portal, the company's sign-in at login.texasrenters.com.
 *
 * The console's half is small on purpose: two route handlers
 * (`app/auth/portal/*`) that move the browser to the portal and back, and a
 * marker cookie. Everything that needs the client secret or the database —
 * the `state` check, the code exchange, who the person is here — is the API's.
 *
 * Safe to import from the browser: no `next/server` here.
 */

/** Where the browser goes to start a portal sign-in. */
export const PORTAL_REDIRECT_PATH = '/auth/portal/redirect';

/**
 * The id of a sign-in in progress, between the redirect out and the callback.
 *
 * Only an id: the `state` and the PKCE verifier stay on the API. httpOnly, and
 * sent only to `/auth/portal`. SameSite=Lax is what lets it come back on the
 * portal's top-level redirect to the callback.
 */
export const PORTAL_FLOW_COOKIE = 'tr_portal_flow';
export const PORTAL_FLOW_MAX_AGE_SECONDS = 10 * 60;

/** `/auth/portal/redirect`, coming back to `returnTo` afterwards. */
export function portalSignInPath(returnTo?: string | null) {
  if (!returnTo || returnTo === '/') return PORTAL_REDIRECT_PATH;
  return `${PORTAL_REDIRECT_PATH}?${new URLSearchParams({ returnTo }).toString()}`;
}

/** Why a portal sign-in was refused: the API's reasons, plus the portal being switched off. */
export type PortalRefusal = 'expired' | 'denied' | 'no_access' | 'no_account' | 'unavailable' | 'disabled';

/**
 * What the login page says for each refusal.
 *
 * Fixed sentences, chosen by a code in the URL, so a crafted link can only
 * pick one of these and never put its own words on the page.
 */
export const PORTAL_REFUSAL_MESSAGES: Record<PortalRefusal, string> = {
  expired: 'That sign-in took too long or was already used. Try again.',
  denied: 'The TR Staff Portal did not finish signing you in. Try again.',
  no_access: 'Your TR Staff Portal account is not allowed to open this app. Ask an admin to add you.',
  no_account: 'There is no staff account here for you yet. Ask an admin to add you.',
  unavailable:
    'The TR Staff Portal could not be reached. Try again in a minute, or sign in with your password.',
  disabled: 'Sign in with TR Staff Portal is not switched on.',
};

export function portalRefusalOf(value: unknown): PortalRefusal | null {
  return typeof value === 'string' && Object.hasOwn(PORTAL_REFUSAL_MESSAGES, value)
    ? (value as PortalRefusal)
    : null;
}

/**
 * Whether a page can be opened signed out.
 *
 * The same paths `middleware.ts` leaves unguarded — it cannot import this,
 * because its matcher must be a literal — and `portal.test.ts` checks the two
 * agree. Used to decide whether an ended portal session should send the person
 * back through the portal: never from a homeowner's report link.
 */
export function isPublicPath(pathname: string) {
  return /^\/(login|forgot-password|reset-password|report\/|comparison-report\/|privacy$|support$|api\/session|auth\/portal)/.test(
    pathname,
  );
}
