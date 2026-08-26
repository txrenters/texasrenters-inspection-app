import { locationKeyValueStore } from './location-kv';
import { LOCATION_QUEUE_KEY, trimQueue, type QueuedFix } from './location-queue';

/**
 * Reading and writing the queue from anywhere, including a headless task.
 *
 * The backing store is reached through `location-kv`, which Metro resolves per
 * platform. Importing `expo-sqlite/kv-store` here directly is what broke the web
 * export: a file with no platform suffix drags SQLite's web build — and the
 * `wa-sqlite.wasm` worker Metro cannot resolve — into the web bundle.
 */

export async function readLocationQueue(): Promise<QueuedFix[]> {
  try {
    const raw = await locationKeyValueStore.getItem(LOCATION_QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedFix[]) : [];
  } catch {
    // A queue that cannot be read is not worth taking the app down for, and
    // the alternative to returning empty is a background task that throws on
    // every tick for the rest of the shift.
    return [];
  }
}

export async function writeLocationQueue(queue: readonly QueuedFix[]) {
  try {
    await locationKeyValueStore.setItem(LOCATION_QUEUE_KEY, JSON.stringify(trimQueue(queue)));
  } catch {
    // Dropping a fix is survivable; crashing the location service is not.
  }
}

/**
 * Appends what the OS just delivered.
 *
 * Read-modify-write, which is safe here because the only writers are this
 * device's own location task and its sender, and neither runs concurrently
 * with itself.
 */
export async function appendLocationFixes(fixes: readonly QueuedFix[]) {
  if (!fixes.length) return;
  const existing = await readLocationQueue();
  await writeLocationQueue([...existing, ...fixes]);
}

export async function removeLocationFixes(ids: readonly string[]) {
  if (!ids.length) return;
  const dropped = new Set(ids);
  const existing = await readLocationQueue();
  await writeLocationQueue(existing.filter((fix) => !dropped.has(fix.id)));
}
