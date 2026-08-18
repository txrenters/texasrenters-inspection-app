/**
 * The admin session, held in cookies on this origin.
 *
 * Replaces `@supabase/ssr`'s cookie-backed session. Cookies rather than
 * localStorage because `middleware.ts` reads the session server-side to keep
 * unauthenticated visitors off admin pages — a localStorage-only session would
 * silently disable that guard while looking like it still worked.
 *
 * Two cookies, deliberately:
 *
 * - `tr_access` is readable by JavaScript, because `lib/api.ts` puts it in an
 *   `Authorization` header on every request. Same exposure the Supabase session
 *   already had, since `createBrowserClient` reads its cookies from
 *   `document.cookie` too.
 * - `tr_refresh` is **httpOnly**, so script cannot reach it. That is an
 *   improvement on what it replaces: the long-lived credential is no longer
 *   readable by anything that manages to run in the page. It is only ever sent
 *   to this app's own route handlers, which exchange it against the API.
 *
 * The access token is the short-lived half, so the worst an exfiltrated one
 * buys is its remaining minutes.
 */

export const ACCESS_COOKIE = 'tr_access';
export const REFRESH_COOKIE = 'tr_refresh';

export interface AppSession {
  accessToken: string;
  /** Epoch seconds, read from the token so nothing has to be trusted to say. */
  expiresAt: number;
  authUserId: string;
  mustChangePassword: boolean;
}

/**
 * Refresh this far before expiry rather than after it.
 *
 * A token that expires mid-flight produces a 401 the user sees as a random
 * sign-out. Sixty seconds covers a slow request and a modest clock skew.
 */
const RENEW_MARGIN_SECONDS = 60;

/**
 * Read the claims without verifying the signature.
 *
 * Safe here, and worth being explicit about why: nothing is authorized on this
 * basis. The backend verifies every token on every request. This only decides
 * when to refresh and what to show, so a forged token buys a client that
 * believes it is signed in and is refused by the API a moment later.
 */
export function decodeSession(accessToken: string): AppSession | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      typeof atob === 'function'
        ? atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        : Buffer.from(payload, 'base64url').toString(),
    ) as {
      sub?: string;
      exp?: number;
      app_metadata?: { must_change_password?: boolean };
    };
    if (!claims.sub || typeof claims.exp !== 'number') return null;
    return {
      accessToken,
      expiresAt: claims.exp,
      authUserId: claims.sub,
      mustChangePassword: claims.app_metadata?.must_change_password === true,
    };
  } catch {
    return null;
  }
}

export const sessionIsExpired = (session: AppSession, marginSeconds = RENEW_MARGIN_SECONDS) =>
  session.expiresAt - marginSeconds <= Math.floor(Date.now() / 1000);

function readCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

let inFlightRefresh: Promise<AppSession | null> | null = null;
const SESSION_REFRESH_LOCK = 'texasrenters-session-refresh';

/**
 * The current session, refreshing it first if it is about to expire.
 *
 * Called on every API request, which is what makes refresh automatic — the
 * Supabase client refreshed inside its own `getSession()` and the app relied on
 * that without ever calling `refreshSession()`. Something has to keep doing it,
 * or tokens start expiring in the middle of an ordinary click.
 *
 * Concurrent callers in this tab share one refresh. `refreshSession()` also
 * takes a browser-wide lock so two tabs cannot rotate the same refresh token at
 * once. A replay is correctly treated by the backend as a stolen token and
 * ends every session, so cross-tab coordination is a security requirement,
 * not merely an optimization.
 */
export async function getSession(): Promise<AppSession | null> {
  const raw = readCookie(ACCESS_COOKIE);
  const current = raw ? decodeSession(raw) : null;
  if (current && !sessionIsExpired(current)) return current;

  inFlightRefresh ??= refreshSession().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/**
 * Exchange the httpOnly refresh cookie for a new pair.
 *
 * Goes through this app's own route handler because the refresh cookie is
 * httpOnly and unreachable from here by design.
 */
async function refreshSession(): Promise<AppSession | null> {
  const exchange = async () => {
    // Another tab may have refreshed while this one waited for the lock. The
    // access cookie is shared by tabs, so use it rather than rotating again.
    const raw = readCookie(ACCESS_COOKIE);
    const current = raw ? decodeSession(raw) : null;
    if (current && !sessionIsExpired(current)) return current;

    return exchangeRefreshToken();
  };

  if (typeof navigator !== 'undefined' && navigator.locks) {
    try {
      return await navigator.locks.request(SESSION_REFRESH_LOCK, exchange);
    } catch {
      // Some embedded browsers expose the API but refuse lock requests. The
      // per-tab in-flight guard still prevents duplicate requests in this tab.
    }
  }

  return exchange();
}

async function exchangeRefreshToken(): Promise<AppSession | null> {
  try {
    const response = await fetch('/api/session/refresh', { method: 'POST' });
    if (!response.ok) return null;
    const raw = readCookie(ACCESS_COOKIE);
    return raw ? decodeSession(raw) : null;
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string) {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      body?.message ?? 'That email address and password do not match an active account.',
    );
  }
  const raw = readCookie(ACCESS_COOKIE);
  const session = raw ? decodeSession(raw) : null;
  if (!session) throw new Error('The session could not be established. Check that cookies are enabled.');
  return session;
}

export async function signOut() {
  // Best effort: the cookies are cleared by the handler, and a network failure
  // here must not strand someone on a page they are trying to leave.
  await fetch('/api/session', { method: 'DELETE' }).catch(() => undefined);
}

/**
 * Notice when the session appears or disappears underneath us.
 *
 * Replaces Supabase's `onAuthStateChange`, which is what previously cleared a
 * second tab after signing out in the first. Cookies fire no event, so this
 * watches for the value changing.
 *
 * Checks on focus and on becoming visible — the moment a returning tab is about
 * to be used, which is when a stale one is actually misleading — and otherwise
 * on a slow interval, since a background tab noticing thirty seconds late costs
 * nothing.
 */
export function onSessionChange(listener: (session: AppSession | null) => void) {
  if (typeof document === 'undefined') return () => undefined;

  let last = readCookie(ACCESS_COOKIE);
  const check = () => {
    const current = readCookie(ACCESS_COOKIE);
    if (current === last) return;
    last = current;
    listener(current ? decodeSession(current) : null);
  };

  const interval = window.setInterval(check, 30_000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener('focus', check);
    document.removeEventListener('visibilitychange', check);
  };
}
