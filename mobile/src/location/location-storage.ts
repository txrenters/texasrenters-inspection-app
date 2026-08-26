import { Storage as SQLiteStorage } from 'expo-sqlite/kv-store';

import { LOCATION_QUEUE_KEY, trimQueue, type QueuedFix } from './location-queue';

/**
 * Reading and writing the queue from anywhere, including a headless task.
 *
 * `expo-sqlite/kv-store` directly rather than through the app's zustand stores:
 * background location is delivered to a `TaskManager` task the OS may run with
 * no app on screen, where nothing has hydrated and no React state exists. The
 * same store the rest of the app persists into, reached without React.
 */

export async function readLocationQueue(): Promise<QueuedFix[]> {
  try {
    const raw = await SQLiteStorage.getItem(LOCATION_QUEUE_KEY);
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
    await SQLiteStorage.setItem(LOCATION_QUEUE_KEY, JSON.stringify(trimQueue(queue)));
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
