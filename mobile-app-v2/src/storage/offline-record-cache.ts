import type { z } from 'zod';

import { getSupabaseClient } from '../auth/supabase';
import { demoStorage } from './demo-storage';

const CACHE_PREFIX = 'texasrenters-offline-records-v1';

export class ApiConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConnectionError';
  }
}

/**
 * The technician's Supabase session is gone or unrefreshable.
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
  const { data } = await getSupabaseClient().auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new SessionExpiredError();
  return `${CACHE_PREFIX}:${userId}:${key}`;
}
