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

async function cacheKey(key: string) {
  const { data } = await getSupabaseClient().auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error('Your session has expired. Sign in again.');
  return `${CACHE_PREFIX}:${userId}:${key}`;
}
