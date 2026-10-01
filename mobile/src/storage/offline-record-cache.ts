import type { z } from 'zod';

import { signedInUserId } from '../auth/session';
import { demoStorage } from './demo-storage';

const CACHE_PREFIX = 'texasrenters-offline-records-v1';

/**
 * Why a request produced no answer this app can act on.
 *
 * All four are `ApiConnectionError` because the read path treats them the
 * same way on purpose: a screen falls back to its cached record whether the
 * radio is off or the API is throwing, and blaming the technician's input for
 * an outage is the bug `ApiHomeRepository.set` documents. The write path
 * cannot afford that shrug — holding a write says "we could not be reached",
 * and only some of these mean it — so the cause travels with the error rather
 * than being inferred from its message. See `classifyWriteFailure`.
 */
export type ApiConnectionReason =
  /** Nothing came back: fetch rejected. No route, no DNS, no TLS, radio off. */
  | 'transport'
  /** Our own 15-second deadline fired. Nothing says whether it arrived. */
  | 'timeout'
  /** 502/503/504 — the edge answered because it could not reach the app. */
  | 'unavailable'
  /** The app itself answered 5xx. It received the request and failed on it. */
  | 'fault';

export class ApiConnectionError extends Error {
  readonly reason: ApiConnectionReason;

  // Required rather than defaulted, in the spirit of the queue's own senders
  // being written out one per line: a default is a decision nobody has to
  // make, and the whole bug was that this distinction had never been made.
  // Whichever value were chosen, the site that skipped it would be silently
  // classified — and the one to fear is a write held against an answer that
  // is never going to change.
  constructor(message: string, reason: ApiConnectionReason) {
    super(message);
    this.name = 'ApiConnectionError';
    this.reason = reason;
  }
}

/**
 * The API answered, and refused: a 4xx other than 401.
 *
 * Still an `Error` with the server's own sentence as its message, as every 4xx
 * always was, so nothing that shows it changes. It also carries the server's
 * code, because a few refusals are about timing rather than about the request:
 * an area submitted while its video is still uploading is refused
 * `ROOM_VIDEO_REQUIRED`, and is accepted the moment the video lands.
 */
export class ApiRefusalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The technician's session is gone or unrefreshable.
 *
 * Distinct from a generic Error so the app can react once, centrally, by
 * routing back to sign-in. Previously every query surfaced the raw text
 * "Your session has expired. Sign in again." on its own screen, leaving a
 * technician mid-inspection to work out for themselves that they had to find
 * Settings and sign out before they could sign back in.
 */
export class SessionExpiredError extends Error {
  constructor(message = 'Your session has expired. Sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Stores validated, user-scoped REST DTOs in the native SQLite-backed store.
 * Only connection failures may fall back to cached data; authorization and
 * business-rule responses always win over device state.
 */
export async function cachedApiRecord<TSchema extends z.ZodType>(
  key: string,
  schema: TSchema,
  load: () => Promise<unknown>,
): Promise<z.output<TSchema>> {
  const scopedKey = await cacheKey(key);
  try {
    const value = schema.parse(await load());
    await demoStorage.setItem(scopedKey, JSON.stringify(value));
    return value;
  } catch (error) {
    if (!(error instanceof ApiConnectionError)) throw error;
    const stored = await demoStorage.getItem(scopedKey);
    if (!stored) throw error;
    let payload: unknown;
    try {
      payload = JSON.parse(stored);
    } catch {
      await demoStorage.removeItem(scopedKey);
      throw error;
    }
    const cached = schema.safeParse(payload);
    if (!cached.success) {
      await demoStorage.removeItem(scopedKey);
      throw error;
    }
    return cached.data;
  }
}

export async function storeApiRecord<TSchema extends z.ZodType>(
  key: string,
  schema: TSchema,
  value: unknown,
) {
  const validated = schema.parse(value);
  await demoStorage.setItem(await cacheKey(key), JSON.stringify(validated));
  return validated;
}

/** Atomically rewrites one validated offline record after a successful mutation. */
export async function updateApiRecord<TSchema extends z.ZodType>(
  key: string,
  schema: TSchema,
  update: (current: z.output<TSchema> | undefined) => z.input<TSchema>,
) {
  const scopedKey = await cacheKey(key);
  const stored = await demoStorage.getItem(scopedKey);
  let current: z.output<TSchema> | undefined;
  if (stored) {
    try {
      const parsed = schema.safeParse(JSON.parse(stored));
      if (parsed.success) current = parsed.data;
    } catch {
      current = undefined;
    }
  }
  const next = schema.parse(update(current));
  await demoStorage.setItem(scopedKey, JSON.stringify(next));
  return next;
}

export async function updateExistingApiRecord<TSchema extends z.ZodType>(
  key: string,
  schema: TSchema,
  update: (current: z.output<TSchema>) => z.input<TSchema>,
) {
  const scopedKey = await cacheKey(key);
  const stored = await demoStorage.getItem(scopedKey);
  if (!stored) return undefined;
  try {
    const current = schema.parse(JSON.parse(stored));
    const next = schema.parse(update(current));
    await demoStorage.setItem(scopedKey, JSON.stringify(next));
    return next;
  } catch {
    await demoStorage.removeItem(scopedKey);
    return undefined;
  }
}

async function cacheKey(key: string) {
  // Who, not a token: an expired one names the same technician, and renewing
  // here is what could not be done behind the lock screen.
  const userId = await signedInUserId();
  if (!userId) throw new SessionExpiredError();
  return `${CACHE_PREFIX}:${userId}:${key}`;
}
