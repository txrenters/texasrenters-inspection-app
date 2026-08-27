import { resolveApiUrl } from '@texasrenters/shared';

import { environment } from '../config/environment';
import { deviceId } from './device-id';
import { sessionStorage } from './session-storage';

/**
 * The technician's session, held on the device.
 *
 * Tokens live in the chunked SecureStore adapter — keychain/keystore rather
 * than plaintext SQLite, split across numbered chunks because SecureStore caps
 * values near 2 KB.
 */

const STORAGE_KEY = 'texasrenters.session';

/** Matches the web client. Refresh before expiry, not after. */
const RENEW_MARGIN_SECONDS = 60;

export interface MobileSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds, read from the token rather than stored separately. */
  expiresAt: number;
  authUserId: string;
  mustChangePassword: boolean;
}

// SessionExpiredError deliberately stays in storage/offline-record-cache, which
// already owns it. A second class with the same name would satisfy no
// `instanceof` check written against the first — and the whole 401 path in
// TexasRentersProviders branches on exactly that.

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') return atob(normalized);
  return Buffer.from(normalized, 'base64').toString('binary');
}

/**
 * Read the claims without verifying the signature.
 *
 * Nothing is authorized on this basis — the backend verifies every token on
 * every request. This only decides when to refresh and what the gate shows, so
 * a forged token buys an app that believes it is signed in and is refused by
 * the API a moment later.
 */
function claimsOf(accessToken: string) {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as {
      sub?: string;
      exp?: number;
      app_metadata?: { must_change_password?: boolean };
    };
    if (!claims.sub || typeof claims.exp !== 'number') return null;
    return claims;
  } catch {
    return null;
  }
}

function toSession(accessToken: string, refreshToken: string): MobileSession | null {
  const claims = claimsOf(accessToken);
  if (!claims) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: claims.exp!,
    authUserId: claims.sub!,
    mustChangePassword: claims.app_metadata?.must_change_password === true,
  };
}

const isExpired = (session: MobileSession, margin = RENEW_MARGIN_SECONDS) =>
  session.expiresAt - margin <= Math.floor(Date.now() / 1000);

/**
 * Cached in memory as well as on disk.
 *
 * `getSession()` is called on **every** API request, on every cache key
 * derivation, and on every upload chunk. Going to SecureStore each time would
 * put a keychain read — and on Android a decrypt — in front of all of them.
 */
let cached: MobileSession | null | undefined;
let inFlightRefresh: Promise<MobileSession | null> | null = null;

type Listener = (session: MobileSession | null) => void;
const listeners = new Set<Listener>();

function publish(session: MobileSession | null) {
  cached = session;
  for (const listener of listeners) listener(session);
}

async function persist(session: MobileSession | null) {
  if (session)
    await sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ accessToken: session.accessToken, refreshToken: session.refreshToken }),
    );
  else await sessionStorage.removeItem(STORAGE_KEY);
  publish(session);
}

async function load(): Promise<MobileSession | null> {
  if (cached !== undefined) return cached;
  try {
    const raw = await sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return (cached = null);
    const stored = JSON.parse(raw) as { accessToken?: string; refreshToken?: string };
    if (!stored.accessToken || !stored.refreshToken) return (cached = null);
    return (cached = toSession(stored.accessToken, stored.refreshToken));
  } catch {
    // A corrupt or partially written record reads as signed out rather than
    // taking the launch down. The chunked writer can leave a torn value if the
    // process dies mid-write.
    return (cached = null);
  }
}

function endpoint(path: string) {
  const baseUrl = environment.apiBaseUrls[0] ?? environment.apiBaseUrl;
  if (!baseUrl) throw new Error('The TexasRenters API URL is not configured for this app build.');
  return resolveApiUrl(baseUrl, path);
}

/**
 * The current session, refreshed first if it is close to expiry.
 *
 * Concurrent callers share one refresh. Refresh tokens rotate, so a screen
 * firing several requests at once would otherwise present the same retired
 * token repeatedly — which the backend correctly treats as a stolen token and
 * answers by ending every session for the account.
 */
export async function getSession(): Promise<MobileSession | null> {
  const current = await load();
  if (!current) return null;
  if (!isExpired(current)) return current;

  inFlightRefresh ??= refresh(current.refreshToken).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function refresh(refreshToken: string): Promise<MobileSession | null> {
  let response: Response;
  try {
    response = await fetch(endpoint('/api/v1/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Unreachable API. The token is probably still good, so the session is kept
    // and the caller gets the expired one — which the offline paths need, since
    // losing the session takes the on-device cache with it.
    return cached ?? null;
  }

  if (!response.ok) {
    // Refused means genuinely dead: expired, revoked, or already replayed.
    await persist(null);
    return null;
  }

  const body = (await response.json()) as { accessToken: string; refreshToken: string };
  const next = toSession(body.accessToken, body.refreshToken);
  await persist(next);
  return next;
}

/**
 * The account is signed in on another handset.
 *
 * A distinct type because the login screen has to treat it differently from a
 * wrong password: this one is answerable, by taking the other device over, and
 * offering that on a genuine credential failure would be nonsense.
 */
export class SessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConflictError';
  }
}

export async function signIn(
  email: string,
  password: string,
  options: { takeOver?: boolean } = {},
): Promise<MobileSession> {
  // Named before the request so the server can tell "this phone again" from
  // "a second phone". Without it a reinstall is indistinguishable from a
  // colleague signing in, because uninstalling never reaches the server.
  const device = await deviceId();

  const response = await fetch(endpoint('/api/v1/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      // Omitted rather than sent false: a first attempt should never carry a
      // flag that ends somebody else's session.
      ...(options.takeOver ? { takeOverExistingSession: true } : {}),
      // Omitted when secure storage refused, which the server reads as an
      // unknown device and handles exactly as it did before this existed.
      ...(device ? { deviceId: device } : {}),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      code?: string;
    } | null;
    const message =
      body?.message ?? 'That email address and password do not match an active account.';
    // The code, not the status: 409 alone would not tell the screen whether it
    // can offer a way forward.
    if (body?.code === 'SESSION_ALREADY_ACTIVE') throw new SessionConflictError(message);
    throw new Error(message);
  }
  const issued = (await response.json()) as { accessToken: string; refreshToken: string };
  const session = toSession(issued.accessToken, issued.refreshToken);
  if (!session) throw new Error('The session could not be established.');
  await persist(session);
  return session;
}

/**
 * End the session on this device.
 *
 * The stored tokens go whatever the API says. A technician signing out on a
 * shared handset in a unit with no signal must still be signed out.
 */
export async function signOut() {
  const current = await load();
  await persist(null);
  if (!current) return;
  await fetch(endpoint('/api/v1/auth/logout'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  }).catch(() => undefined);
}

/** Notifies on sign-in, sign-out and refresh, so the socket can reconnect. */
export function onSessionChange(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: drops the in-memory copy so the next read comes from storage. */
export function resetSessionCache() {
  cached = undefined;
  inFlightRefresh = null;
}
