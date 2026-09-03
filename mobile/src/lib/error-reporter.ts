import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { deviceId } from '../auth/device-id';
import { environment } from '../config/environment';
import { demoStorage } from '../storage/demo-storage';
import { readErrorLog, subscribeToErrorLog, type LoggedError } from './error-log';

/**
 * Sends the log the handset has always kept to somebody who can act on it.
 *
 * The device-side log has existed since the app was built, capped at twenty
 * entries and readable on the diagnostics screen. It never left the phone. So a
 * technician's crash lived there until they reinstalled, and the only way to
 * learn of one was for them to describe it out loud — which is how an afternoon
 * went on an `HTTP 530` nobody could see.
 *
 * Deliberately does not need a session. The errors worth having most are the
 * ones raised before sign-in, so the request carries a token only when one
 * happens to exist, and the server attributes it or does not.
 */

/** Ids already accepted by the server, so a flush does not resend the world. */
const SENT_KEY = 'texasrenters-inspection-error-log-sent-v1';

/**
 * Bounded, and larger than the log it tracks.
 *
 * The log holds twenty entries and drops the oldest, so remembering rather more
 * than twenty ids means an entry that is still present is still known to have
 * been sent. Beyond that, forgetting is harmless: the server deduplicates on
 * `(installId, clientEntryId)`, so a resend is a no-op there too.
 */
const MAX_REMEMBERED = 100;

let flushing = false;
let unsubscribe: (() => void) | null = null;

async function readSent(): Promise<string[]> {
  try {
    const raw = await demoStorage.getItem(SENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    // A missing or corrupt marker means resending, which the server absorbs.
    return [];
  }
}

async function rememberSent(ids: string[]) {
  try {
    const merged = [...(await readSent()), ...ids].slice(-MAX_REMEMBERED);
    await demoStorage.setItem(SENT_KEY, JSON.stringify(merged));
  } catch {
    // Storage refused. The next flush resends; the server deduplicates.
  }
}

function apiBase(): string | null {
  return environment.apiBaseUrls[0] ?? environment.apiBaseUrl ?? null;
}

function toEntry(entry: LoggedError) {
  return {
    id: entry.id,
    message: entry.message,
    stack: entry.stack,
    context: entry.source,
    fatal: entry.fatal,
    at: entry.at,
  };
}

/**
 * Send anything not yet acknowledged.
 *
 * Silent throughout. A failure to deliver an error report is not the
 * technician's problem and must never become a second error on screen — and
 * reporting a failed report through the same channel is how a loop starts.
 */
export async function flushErrorLog(getAccessToken?: () => Promise<string | null>): Promise<number> {
  if (flushing) return 0;
  const baseUrl = apiBase();
  if (!baseUrl) return 0;

  flushing = true;
  try {
    const [entries, sent] = await Promise.all([readErrorLog(), readSent()]);
    const already = new Set(sent);
    const pending = entries.filter((entry) => !already.has(entry.id));
    if (pending.length === 0) return 0;

    // Not a person, and stable across sign-outs: the same value the server uses
    // to tell "this phone again" from "a second phone".
    const installId = (await deviceId()) ?? 'unknown-install';

    const token = await getAccessToken?.().catch(() => null);

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/client-errors`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        installId,
        source: 'MOBILE',
        platform: Platform.OS,
        appVersion: Constants.expoConfig?.version ?? undefined,
        buildId: Constants.expoConfig?.runtimeVersion
          ? String(Constants.expoConfig.runtimeVersion)
          : undefined,
        // The single most useful field. Which host this build is talking to is
        // the first question of every report like this, and only the client
        // knows the answer.
        apiBaseUrl: baseUrl,
        entries: pending.map(toEntry),
      }),
    });

    if (!response.ok) return 0;

    await rememberSent(pending.map((entry) => entry.id));
    return pending.length;
  } catch {
    // Offline, unreachable, or refused. The log is still on the device and the
    // next flush tries again.
    return 0;
  } finally {
    flushing = false;
  }
}

/**
 * Flush now, and again whenever a new error is logged.
 *
 * Called once at startup from the root layout, above the auth gate — a crash on
 * the login screen is exactly the report that used to be impossible to see.
 */
export function startErrorReporting(getAccessToken?: () => Promise<string | null>): () => void {
  void flushErrorLog(getAccessToken);

  unsubscribe?.();
  unsubscribe = subscribeToErrorLog(() => {
    void flushErrorLog(getAccessToken);
  });

  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
}
