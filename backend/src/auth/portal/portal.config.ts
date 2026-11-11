import { hkdfSync } from 'node:crypto';

/**
 * Settings for "Sign in with TR Staff Portal", the company's OpenID Connect
 * provider at login.texasrenters.com.
 *
 * Read from the environment on every call rather than once at boot, like
 * `expectedTokenIssuer` in common/auth.ts: the tests change these between
 * cases, and a value frozen at import time would silently keep the first one.
 *
 * `PORTAL_ENABLED=false` (the default) means the app behaves exactly as it did
 * before the portal existed: no portal routes answer, no button is shown, and
 * password sign-in is never refused. A portal that is switched on but missing a
 * setting is treated as off as well, and reported once at boot — refusing
 * password sign-in for a portal nobody can use would lock the office out.
 */

/**
 * The portal's own endpoints, fixed by IT rather than discovered.
 *
 * Discovery would add a network call at boot and a way for sign-in to fail
 * while the portal is briefly down, to learn four paths that do not change.
 */
const ENDPOINT_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  userinfo: '/oauth/userinfo',
  jwks: '/oauth/jwks',
} as const;

export const PORTAL_SCOPE = 'openid profile email apps';

/** Where the console receives the portal's answer. The console's own route handler. */
export const PORTAL_CALLBACK_PATH = '/auth/portal/callback';

/** A portal sign-in lasts at most twelve hours: the portal's rule, not ours. */
export const PORTAL_SESSION_MAX_SECONDS = 12 * 60 * 60;

/**
 * How long before its access token runs out the console renews it.
 *
 * Mirrors `RENEW_MARGIN_SECONDS` in web/lib/session.ts. The re-check is timed
 * against it, so that the renewal the console makes at that moment is the one
 * that asks the portal — see `PortalSessionService.renew`.
 */
export const CONSOLE_RENEWAL_MARGIN_SECONDS = 60;

const DEFAULT_RECHECK_MINUTES = 5;
/**
 * Bounds on PORTAL_RECHECK_MINUTES. Below two, a portal session's access token
 * would be inside the console's renewal margin from the moment it is issued,
 * and the console would renew it on every request.
 */
const MIN_RECHECK_MINUTES = 2;
const MAX_RECHECK_MINUTES = 60;

export interface PortalSettings {
  /** Exact, no trailing slash: it must equal the `iss` claim character for character. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** This app's Short ID in the portal, which must appear in the person's `apps` claim. */
  appSlug: string;
  /** Lower-cased. An address links to an account only if its domain is one of these. */
  allowedDomains: string[];
  recheckSeconds: number;
  redirectUri: string;
  endpoints: { authorize: string; token: string; userinfo: string; jwks: string };
  /** Where someone who signed in through the portal lands after signing out here. */
  signedOutUrl: string;
}

export interface PortalConfig {
  /** Switched on and fully configured. Nothing portal-related happens otherwise. */
  enabled: boolean;
  /** `PORTAL_ENABLED=true` as written, configured or not. */
  requested: boolean;
  /** Which settings are missing or invalid. Names only, never values. */
  problems: string[];
  /**
   * Whether staff may still sign in to the console with a password.
   *
   * Always true unless the portal is enabled and PORTAL_ALLOW_PASSWORD_LOGIN
   * is exactly `false`: a portal that is off, or broken, never takes the
   * password away.
   */
  allowPasswordLogin: boolean;
  settings?: PortalSettings;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function httpsOrLoopback(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

export function readPortalConfig(environment: NodeJS.ProcessEnv = process.env): PortalConfig {
  const requested = environment.PORTAL_ENABLED?.trim().toLowerCase() === 'true';
  if (!requested) return { enabled: false, requested, problems: [], allowPasswordLogin: true };

  const problems: string[] = [];
  const issuer = environment.PORTAL_ISSUER?.trim() ?? '';
  if (!issuer.startsWith('https://') || issuer.endsWith('/') || !httpsOrLoopback(issuer))
    problems.push('PORTAL_ISSUER');
  const clientId = environment.PORTAL_CLIENT_ID?.trim() ?? '';
  if (!clientId) problems.push('PORTAL_CLIENT_ID');
  const clientSecret = environment.PORTAL_CLIENT_SECRET?.trim() ?? '';
  if (!clientSecret) problems.push('PORTAL_CLIENT_SECRET');
  const appSlug = environment.PORTAL_APP_SLUG?.trim() ?? '';
  if (!appSlug) problems.push('PORTAL_APP_SLUG');
  const allowedDomains = (environment.PORTAL_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  if (allowedDomains.length === 0) problems.push('PORTAL_ALLOWED_DOMAINS');

  const rawRecheck = environment.PORTAL_RECHECK_MINUTES?.trim();
  const recheckMinutes = rawRecheck ? Number(rawRecheck) : DEFAULT_RECHECK_MINUTES;
  if (
    !Number.isInteger(recheckMinutes) ||
    recheckMinutes < MIN_RECHECK_MINUTES ||
    recheckMinutes > MAX_RECHECK_MINUTES
  )
    problems.push('PORTAL_RECHECK_MINUTES');

  // The console's public origin, which the portal sends the browser back to.
  // The same variable already builds every shared-report link, so the two can
  // never point at different hosts. HTTPS, except a workstation's localhost.
  const origin = environment.WEB_APP_ORIGIN?.trim().replace(/\/+$/, '') ?? '';
  if (!origin || !httpsOrLoopback(origin)) problems.push('WEB_APP_ORIGIN');

  const configured = problems.length === 0;
  const allowPasswordLogin =
    !configured || environment.PORTAL_ALLOW_PASSWORD_LOGIN?.trim().toLowerCase() !== 'false';
  if (!configured) return { enabled: false, requested, problems, allowPasswordLogin };

  return {
    enabled: true,
    requested,
    problems,
    allowPasswordLogin,
    settings: {
      issuer,
      clientId,
      clientSecret,
      appSlug,
      allowedDomains,
      recheckSeconds: recheckMinutes * 60,
      redirectUri: `${origin}${PORTAL_CALLBACK_PATH}`,
      endpoints: {
        authorize: `${issuer}${ENDPOINT_PATHS.authorize}`,
        token: `${issuer}${ENDPOINT_PATHS.token}`,
        userinfo: `${issuer}${ENDPOINT_PATHS.userinfo}`,
        jwks: `${issuer}${ENDPOINT_PATHS.jwks}`,
      },
      signedOutUrl: `${issuer}/dashboard`,
    },
  };
}

/**
 * The key that seals each person's portal refresh token while it is stored.
 *
 * Derived from the client secret rather than read from a variable of its own:
 * the secret is already the one value only this backend holds, and IT issues
 * it. Reissuing the secret therefore makes every stored token unreadable,
 * which ends every portal session — they sign in through the portal again —
 * and that is the right result for a secret someone thought worth replacing.
 */
export function portalTokenKey(settings: Pick<PortalSettings, 'clientSecret'>): Buffer {
  return Buffer.from(
    hkdfSync('sha256', settings.clientSecret, 'texasrenters-inspection', 'portal-refresh-token', 32),
  );
}
