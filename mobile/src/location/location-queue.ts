import type { TechnicianLocationFix } from '@texasrenters/shared';
import { MAX_LOCATION_BATCH, usableLocationFixes } from '@texasrenters/shared';

/**
 * Fixes waiting to reach the API.
 *
 * Its own storage rather than the zustand store every other queue uses,
 * because the thing writing to it is not React. Background location arrives in
 * a `TaskManager` task that the OS may run with no app on screen and no store
 * hydrated, so the writer has to be something that works from a cold headless
 * context — which the SQLite key-value store is and a rehydrating store is not.
 */

/** Storage key. Versioned, so a shape change discards rather than misreads. */
export const LOCATION_QUEUE_KEY = 'texasrenters-location-queue-v1';

/**
 * The most fixes ever kept on the device.
 *
 * A point a minute for twelve hours is about 700, so this holds several days of
 * a technician being unable to reach the API at all. Past that the oldest go
 * first: the question this feature answers is "where are they now", and a
 * queue that grows without limit eventually costs a handset its storage.
 */
export const MAX_QUEUE_LENGTH = 5_000;

const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;

export interface QueuedFix extends TechnicianLocationFix {
  /** Stable across retries, so a duplicate send is recognisable. */
  id: string;
  attempts?: number;
  /** ISO timestamp; absent means due now. */
  nextAttemptAt?: string;
}

/** Oldest first, capped. Called on every write, so the cap cannot be outrun. */
export function trimQueue(queue: readonly QueuedFix[], max = MAX_QUEUE_LENGTH): QueuedFix[] {
  const ordered = [...queue].sort(
    (left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt),
  );
  return ordered.length <= max ? ordered : ordered.slice(ordered.length - max);
}

/**
 * The next batch to send, oldest first.
 *
 * Filtered through the shared rule before it leaves the device: a fix the
 * server would refuse is not worth the radio, and on a handset in the field
 * signal is the scarce thing. Bounded by the same limit the API enforces, so a
 * queue drained after a long outage goes in whole batches rather than being
 * rejected wholesale.
 */
export function fixesToSend(queue: readonly QueuedFix[], now = Date.now()): QueuedFix[] {
  const due = queue.filter((fix) => {
    if (!fix.nextAttemptAt) return true;
    return new Date(fix.nextAttemptAt).getTime() <= now;
  });
  return usableLocationFixes(due, now).slice(0, MAX_LOCATION_BATCH);
}

/**
 * Fixes the API refused for a reason that will not change, so they are dropped
 * rather than retried: a bad clock or an impossible coordinate is not going to
 * become valid, and a queue that keeps them never drains past them.
 */
export function unsendableFixes(queue: readonly QueuedFix[], now = Date.now()): QueuedFix[] {
  const sendable = new Set(usableLocationFixes(queue, now).map((fix) => fix.id));
  return queue.filter((fix) => !sendable.has(fix.id));
}

/** When to try again after a failed send. Doubles, then holds. */
export function retryDelayMs(attempts: number) {
  return Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

/** Marks a batch as tried, so a failing send backs off instead of spinning. */
export function deferFixes(
  queue: readonly QueuedFix[],
  ids: readonly string[],
  now = Date.now(),
): QueuedFix[] {
  const deferred = new Set(ids);
  return queue.map((fix) => {
    if (!deferred.has(fix.id)) return fix;
    const attempts = (fix.attempts ?? 0) + 1;
    return {
      ...fix,
      attempts,
      nextAttemptAt: new Date(now + retryDelayMs(attempts)).toISOString(),
    };
  });
}
