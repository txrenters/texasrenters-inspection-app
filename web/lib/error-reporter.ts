/**
 * Sends console errors somewhere a person can read them.
 *
 * The handset has kept an error log since it was built. The console kept none:
 * a React error in production was a minified `#310` in somebody's devtools, and
 * unless they screenshotted it, it was gone. Two of those took an afternoon
 * each this month.
 *
 * Same endpoint as the handset, same caps, same redaction. Attributed when the
 * reader is signed in and anonymous otherwise, because an error on the login
 * page is worth as much as one behind it.
 */

import { APP_VERSION_LABEL } from './app-version';

const INSTALL_KEY = 'texasrenters.error-install-id';
const SENT_KEY = 'texasrenters.error-sent-ids';

/** Bounded; the server deduplicates anyway, so forgetting only costs a resend. */
const MAX_REMEMBERED = 100;

/** Matches the handset's own cap, and the server's. */
const MAX_BATCH = 20;

/**
 * Strip anything credential-shaped before it leaves the browser.
 *
 * Kept in step with `backend/src/client-errors/client-errors.service.ts` and
 * `mobile/src/lib/error-log.ts`. The server repeats this, but a secret that
 * never leaves is better than one redacted on arrival.
 */
export function redact(text: string): string {
  return text
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[redacted-jwt]')
    .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]')
    .replace(
      /\b(authorization|token|apikey|api_key|password|secret)\b\s*[:=]?\s*(?:bearer\s+|basic\s+)?\S+/gi,
      '$1 [redacted]',
    )
    .replace(/([?&](?:access_token|refresh_token|apikey|key)=)[^&\s]+/gi, '$1[redacted]');
}

/** First six frames; the rest of a minified stack is noise. */
function truncateStack(stack: string | undefined) {
  if (!stack) return undefined;
  return redact(stack.split('\n').slice(0, 6).join('\n'));
}

function browserId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(INSTALL_KEY);
    if (existing) return existing;
    const created = `web-${crypto.randomUUID()}`;
    globalThis.localStorage?.setItem(INSTALL_KEY, created);
    return created;
  } catch {
    // Private mode, or storage disabled. A per-load id still groups one
    // session's errors together, which is most of the value.
    return `web-ephemeral-${Math.random().toString(36).slice(2)}`;
  }
}

function readSent(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(SENT_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function rememberSent(ids: string[]) {
  try {
    const merged = [...readSent(), ...ids].slice(-MAX_REMEMBERED);
    globalThis.localStorage?.setItem(SENT_KEY, JSON.stringify(merged));
  } catch {
    // Nothing to do; the server deduplicates.
  }
}

export type ConsoleError = {
  id: string;
  message: string;
  stack?: string;
  context: string;
  fatal: boolean;
  at: string;
};

export function buildEntry(input: {
  error: unknown;
  context: string;
  fatal?: boolean;
}): ConsoleError {
  const { error, context, fatal = false } = input;
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  return {
    id: crypto.randomUUID(),
    message: redact(message).slice(0, 2_000),
    stack: truncateStack(error instanceof Error ? error.stack : undefined),
    context,
    fatal,
    at: new Date().toISOString(),
  };
}

/**
 * Where the console's own API calls go.
 *
 * Same value the rest of the app uses. Reported alongside the error because
 * "which host was this build talking to" is the first question of every report
 * of this kind — the one that took an afternoon to answer for a handset.
 */
function apiBaseUrl(): string | null {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') || null;
}

const queue: ConsoleError[] = [];
let sending = false;

/**
 * Send what has queued up.
 *
 * Silent throughout: a failed error report must never become a second error,
 * and reporting one through this same path is how a loop starts.
 */
export async function flush(): Promise<number> {
  if (sending || queue.length === 0) return 0;
  const baseUrl = apiBaseUrl();
  if (!baseUrl) return 0;

  sending = true;
  try {
    const already = readSent();
    const pending = queue.splice(0, MAX_BATCH).filter((entry) => !already.has(entry.id));
    if (pending.length === 0) return 0;

    const response = await fetch(`${baseUrl}/api/v1/client-errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The console authenticates with an httpOnly cookie the browser attaches
      // itself; there is no token to read here. An unattributed report is still
      // worth keeping, which is why the endpoint accepts one.
      credentials: 'include',
      body: JSON.stringify({
        installId: browserId(),
        source: 'CONSOLE',
        platform: 'web',
        /**
         * The release, from the one variable CI actually sets.
         *
         * This read `NEXT_PUBLIC_BUILD_ID`, which is set nowhere — not in
         * `docker/web/Dockerfile`, not in the publish workflow, not in any env
         * file. So every console report ever filed carried `Build: —`.
         *
         * That is the field that answers "is this crash from a build we have
         * already fixed", and without it a report cannot be aged: a React #185
         * burst from 9 September looked exactly like one from today, across six
         * releases in between. `NEXT_PUBLIC_APP_VERSION` is inlined from the
         * image tag and is already what the console footer shows, so the report
         * and the footer now name the same build.
         */
        buildId: APP_VERSION_LABEL === 'dev' ? undefined : APP_VERSION_LABEL,
        apiBaseUrl: baseUrl,
        entries: pending,
      }),
    });

    if (!response.ok) return 0;
    rememberSent(pending.map((entry) => entry.id));
    return pending.length;
  } catch {
    return 0;
  } finally {
    sending = false;
  }
}

/** Queue an error and send it. */
export function reportError(error: unknown, context: string, fatal = false) {
  queue.push(buildEntry({ error, context, fatal }));
  void flush();
}

let installed = false;

/**
 * Catch what React never sees: uncaught exceptions and unhandled rejections.
 *
 * Safe to call twice — Next.js remounts providers on navigation, and a second
 * set of listeners would report everything twice.
 */
export function installGlobalErrorHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, 'uncaught', true);
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, 'promise', false);
  });
}
