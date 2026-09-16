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

/** The end of the line of changes waiting to be applied. */
let lastChange: Promise<unknown> = Promise.resolve();

/**
 * One change to the queue at a time.
 *
 * Every change is a read, a modification and a write, and two of them
 * interleaved lose one: the sender reads the queue, the location task appends a
 * fix, and the sender writes back what it read minus what it sent -- without
 * the fix that arrived in between. That could already happen while fixes were
 * only sent from a timer; sending as each fix is recorded makes the two
 * overlap on every fix, so changes wait for the one before them here.
 *
 * Within one JavaScript runtime, which is where the task and the sender both
 * run.
 */
export function updateLocationQueue(
  change: (queue: QueuedFix[]) => readonly QueuedFix[],
): Promise<void> {
  const applied = lastChange.then(async () => {
    await writeLocationQueue(change(await readLocationQueue()));
  });
  // A change that throws must not wedge every change behind it.
  lastChange = applied.catch(() => undefined);
  return applied;
}

/** Appends what the OS just delivered. */
export async function appendLocationFixes(fixes: readonly QueuedFix[]) {
  if (!fixes.length) return;
  await updateLocationQueue((existing) => [...existing, ...fixes]);
  await rememberLastFix(fixes);
}

/**
 * When a fix was last recorded, by anything, whether or not it was sent.
 *
 * Kept apart from the queue because sending empties the queue, and this has to
 * survive that. It answers the one question the OS will not: is the recording
 * actually delivering? Both platforms report a stopped location task as still
 * started -- they answer "is it registered" -- so a recorder the OS quietly
 * killed looked healthy for the rest of the day.
 */
const LAST_FIX_KEY = 'texasrenters-location-last-fix-v1';

async function rememberLastFix(fixes: readonly QueuedFix[]) {
  const newest = Math.max(...fixes.map((fix) => Date.parse(fix.recordedAt)));
  if (!Number.isFinite(newest)) return;
  try {
    await locationKeyValueStore.setItem(LAST_FIX_KEY, new Date(newest).toISOString());
  } catch {
    // A lost timestamp costs one unnecessary restart of the recording; failing
    // the location task costs the fix.
  }
}

/** Epoch milliseconds of the last recorded fix, or null if there has never been one. */
export async function readLastFixAt(): Promise<number | null> {
  try {
    const raw = await locationKeyValueStore.getItem(LAST_FIX_KEY);
    const at = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export async function removeLocationFixes(ids: readonly string[]) {
  if (!ids.length) return;
  const dropped = new Set(ids);
  await updateLocationQueue((existing) => existing.filter((fix) => !dropped.has(fix.id)));
}
