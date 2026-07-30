import { demoStorage } from '../storage/demo-storage';

/**
 * A small, persistent record of recent crashes and unhandled errors.
 *
 * The remote beta runs in Expo Go with testers on their own phones, so there is
 * no console to read and no crash reporter wired up. Without this, a render
 * throw is a white screen and the only report anyone gets is "it broke". The
 * log is surfaced on the Diagnostics screen and included in Copy diagnostics.
 *
 * `reportError` is deliberately vendor-neutral: when a crash reporter is added
 * (task: Sentry needs a development build, it cannot report natively in Expo
 * Go), forward from here rather than sprinkling SDK calls through the app.
 */
export type LoggedError = {
  id: string;
  at: string;
  /** Where it came from — 'render', 'uncaught', 'promise', or a screen name. */
  source: string;
  message: string;
  /** First few frames only; a full native stack is noise in a chat message. */
  stack?: string;
  fatal: boolean;
};

const STORAGE_KEY = 'texasrenters-inspection-error-log-v1';
/** Bounded so a crash loop cannot fill the device. Oldest entries drop first. */
const MAX_ENTRIES = 20;
const MAX_STACK_LINES = 6;

let cache: LoggedError[] | null = null;
const listeners = new Set<(entries: LoggedError[]) => void>();

/**
 * Strip anything credential-shaped before it is persisted.
 *
 * Testers are instructed to paste diagnostics into a chat message, so this text
 * leaves the device by design. A Supabase access token in an error message
 * would be a real leak, and tokens do appear in thrown API errors.
 */
export function redact(text: string): string {
  return (
    text
      .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[redacted-jwt]')
      // Scheme-prefixed values first. Without this pass, "Authorization: Bearer
      // <token>" redacts only the word "Bearer" and leaves the token in place —
      // the single most likely secret to appear in an API error.
      .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]')
      .replace(
        /\b(authorization|token|apikey|api_key|password|secret)\b\s*[:=]?\s*(?:bearer\s+|basic\s+)?\S+/gi,
        '$1 [redacted]',
      )
      .replace(/([?&](?:access_token|refresh_token|apikey|key)=)[^&\s]+/gi, '$1[redacted]')
  );
}

function truncateStack(stack?: string) {
  if (!stack) return undefined;
  return redact(stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'));
}

async function load(): Promise<LoggedError[]> {
  if (cache) return cache;
  try {
    const raw = await demoStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as LoggedError[]) : [];
  } catch {
    // A corrupt log must never be the reason the app cannot start.
    cache = [];
  }
  return cache;
}

async function persist(entries: LoggedError[]) {
  cache = entries;
  listeners.forEach((listener) => listener(entries));
  try {
    await demoStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Persistence is best-effort; the in-memory copy still serves this session.
  }
}

export function buildEntry(input: {
  error: unknown;
  source: string;
  fatal?: boolean;
  at: string;
  id: string;
}): LoggedError {
  const { error, source, fatal = false, at, id } = input;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
  return {
    id,
    at,
    source,
    message: redact(message || 'Unknown error').slice(0, 500),
    stack: error instanceof Error ? truncateStack(error.stack) : undefined,
    fatal,
  };
}

let sequence = 0;

export async function reportError(
  error: unknown,
  options: { source: string; fatal?: boolean } = { source: 'unknown' },
): Promise<void> {
  const entry = buildEntry({
    error,
    source: options.source,
    fatal: options.fatal,
    at: new Date().toISOString(),
    id: `${Date.now().toString(36)}-${(sequence += 1)}`,
  });
  if (__DEV__) console.error(`[${entry.source}]`, entry.message);
  const entries = await load();
  await persist([entry, ...entries].slice(0, MAX_ENTRIES));
}

export async function readErrorLog(): Promise<LoggedError[]> {
  return [...(await load())];
}

export async function clearErrorLog(): Promise<void> {
  await persist([]);
}

/** Subscribe to log changes so Diagnostics updates without a manual refresh. */
export function subscribeToErrorLog(listener: (entries: LoggedError[]) => void): () => void {
  listeners.add(listener);
  void load().then(listener);
  return () => listeners.delete(listener);
}

/**
 * Installs handlers for errors React never sees: uncaught exceptions outside
 * the render tree and rejected promises with no catch. Safe to call twice.
 */
let handlersInstalled = false;

export function installGlobalErrorHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const errorUtils = (
    globalThis as unknown as {
      ErrorUtils?: {
        getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
        setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      };
    }
  ).ErrorUtils;

  if (errorUtils?.setGlobalHandler) {
    const previous = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error, isFatal) => {
      void reportError(error, { source: 'uncaught', fatal: Boolean(isFatal) });
      // Chain to the default handler so the red box still appears in dev and
      // the platform still records the crash.
      previous?.(error, isFatal);
    });
  }

  const rejectionTracking = globalThis as unknown as {
    process?: { on?: (event: string, handler: (reason: unknown) => void) => void };
  };
  rejectionTracking.process?.on?.('unhandledRejection', (reason) => {
    void reportError(reason, { source: 'promise' });
  });
}
