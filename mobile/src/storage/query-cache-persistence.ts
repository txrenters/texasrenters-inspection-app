import Constants from 'expo-constants';
import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';

import { getSession } from '../auth/session';
import { demoStorage } from './demo-storage';

const CACHE_PREFIX = 'texasrenters-query-cache-v1';

/**
 * Restored data older than this is dropped rather than shown.
 *
 * Long enough that a technician who opens the app the next morning still gets an
 * instant screen, short enough that nobody is handed a week-old assignment list
 * as though it were current.
 */
const MAX_AGE_MS = 24 * 60 * 60_000;

/** Coalesces the burst of cache events a screen fires while it settles. */
const WRITE_DEBOUNCE_MS = 2_000;

type StoredCache = {
  buster: string;
  savedAt: number;
  state: unknown;
};

/**
 * Bump whenever a cached response shape changes.
 *
 * The app version alone was doing this job and could not: `version` in
 * app.config.ts sat at 0.1.0 for the whole of development, so every DTO change
 * shipped against caches written by the previous shape. That is exactly the
 * failure the version was meant to prevent — the review screen crashed on
 * `room.findings.map` after `findings` was added, because the restored rooms
 * predated the field.
 *
 * Kept separate from the app version because the two answer different
 * questions: `version` is what users are running, this is what the stored
 * payloads look like. A release with no shape change should not discard a
 * technician's warm-start cache, and a shape change between two builds of the
 * same version must.
 */
const CACHE_SCHEMA_VERSION = 2;

/**
 * Invalidates the whole stored cache when either the shipped version or the
 * cached shape changes.
 *
 * Restored payloads are not re-validated against their zod schemas — they are
 * written back into react-query as-is, which is what makes a stale shape able to
 * reach a screen at all. Screens that read restored data therefore treat it as
 * untrusted; see the review screen's handling of `findings`.
 */
export function buster() {
  return `${Constants.expoConfig?.version ?? 'dev'}:${CACHE_SCHEMA_VERSION}`;
}

/**
 * Scopes stored data to the signed-in technician.
 *
 * Two technicians sharing a device must never see each other's assignments, so
 * the user id is part of the key rather than a field inside the payload. No
 * session means there is nothing to read or write — that is an ordinary state
 * at launch and on the sign-in screen, not an error.
 */
async function storageKey() {
  const session = await getSession();
  return session ? `${CACHE_PREFIX}:${session.authUserId}` : null;
}

/**
 * Repaints the last known screen state from disk before the network answers.
 *
 * The app already stored validated DTOs on the device, but `cachedApiRecord`
 * only ever read them back inside its `catch` for `ApiConnectionError` — a
 * crash mat, never a fast path. So every launch with working internet started
 * from an empty react-query cache: spinner, wait for the round trip, then
 * paint, even though the answer was sitting in SQLite.
 *
 * Restored entries keep their original `dataUpdatedAt`, so they are already
 * stale against the 30s `staleTime` and react-query revalidates each one the
 * moment its screen mounts. The technician sees yesterday's list instantly and
 * it corrects itself a beat later, instead of seeing nothing at all.
 */
export async function restoreQueryCache(client: QueryClient): Promise<boolean> {
  const key = await storageKey();
  if (!key) return false;
  const stored = await demoStorage.getItem(key);
  if (!stored) return false;

  try {
    const payload = JSON.parse(stored) as Partial<StoredCache>;
    const expired =
      typeof payload.savedAt !== 'number' || Date.now() - payload.savedAt > MAX_AGE_MS;
    if (payload.buster !== buster() || expired || !payload.state) {
      await demoStorage.removeItem(key);
      return false;
    }
    hydrate(client, payload.state);
    return true;
  } catch {
    // A truncated or hand-edited payload must not wedge every future launch.
    await demoStorage.removeItem(key);
    return false;
  }
}

/**
 * Mirrors the live query cache to disk so the next launch has something to show.
 *
 * Returns an unsubscribe function.
 */
export function persistQueryCache(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const write = async () => {
    const key = await storageKey();
    if (!key || stopped) return;
    const state = dehydrate(client, {
      // Errors and in-flight queries are worthless on the next launch, and a
      // persisted failure would be restored as a screen that looks broken
      // before a single request has been made.
      shouldDehydrateQuery: (query) =>
        query.state.status === 'success' && query.state.data !== undefined,
      // Never: a restored pending mutation would re-fire a write the technician
      // already made — a duplicate finding, or a second submitted room.
      shouldDehydrateMutation: () => false,
    });
    const payload: StoredCache = { buster: buster(), savedAt: Date.now(), state };
    await demoStorage.setItem(key, JSON.stringify(payload));
  };

  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void write(), WRITE_DEBOUNCE_MS);
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Drops the stored cache for the current technician, used on explicit sign-out. */
export async function clearQueryCache() {
  const key = await storageKey();
  if (key) await demoStorage.removeItem(key);
}
