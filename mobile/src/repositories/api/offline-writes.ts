import { ApiConnectionError } from '../../storage/offline-record-cache';
import {
  drainQueue,
  enqueueMutation,
  readQueue,
  type QueuedMutation,
} from '../../storage/mutation-queue';

/**
 * A write that was held because the device is offline.
 *
 * Distinct from the connection error it replaces so a screen can say the work
 * is kept rather than that it failed — those are different things to be told
 * while standing in somebody's basement.
 */
export class QueuedOfflineError extends Error {
  constructor() {
    super('Saved on this device. It will send when you are back on a network.');
    this.name = 'QueuedOfflineError';
  }
}

/**
 * Sends a write, holding it for later if the network is gone.
 *
 * Only `ApiConnectionError` is queued. A 4xx is the server refusing the
 * request, and queueing that would retry forever against an answer that will
 * never change — the entry has to fail here so the technician can correct it.
 */
export async function queueOnConnectionFailure<T>(
  entry: { id: string; kind: string; payload: Record<string, unknown> },
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof ApiConnectionError)) throw error;
    await enqueueMutation(entry);
    throw new QueuedOfflineError();
  }
}

/**
 * How each queued kind is replayed.
 *
 * Written out rather than closing over the repository, so adding a queued
 * write means adding a line here and being forced to think about whether
 * replaying it twice is safe.
 */
const SENDERS: Record<string, (payload: Record<string, unknown>, send: Sender) => Promise<unknown>> =
  {
    'room-note': (payload, send) =>
      send(
        `/api/v1/technician/rooms/${encodeURIComponent(String(payload.roomId))}/note`,
        'PATCH',
        { note: payload.note },
      ),
    'room-skip': (payload, send) =>
      send(`/api/v1/technician/rooms/${encodeURIComponent(String(payload.roomId))}/skip`, 'POST', {
        reason: payload.reason,
      }),
    // Safe to replay: the route upserts on (area, item), so a duplicate writes
    // the same assessment rather than stacking a second opinion.
    'checklist-assessment': (payload, send) =>
      send(
        `/api/v1/technician/rooms/${encodeURIComponent(String(payload.roomId))}/checklist/${encodeURIComponent(String(payload.itemId))}`,
        'PUT',
        {
          isClean: payload.isClean ?? null,
          isUndamaged: payload.isUndamaged ?? null,
          isWorking: payload.isWorking ?? null,
          comment: payload.comment ?? null,
        },
      ),
    // Safe to replay: the server keeps the first confirmation's timestamp, so a
    // duplicate cannot rewrite when the technician actually read the summary.
    'room-confirm-summary': (payload, send) =>
      send(
        `/api/v1/technician/rooms/${encodeURIComponent(String(payload.roomId))}/confirm-summary`,
        'POST',
        {},
      ),
  };

type Sender = (path: string, method: string, body: unknown) => Promise<unknown>;

/** Replays what is waiting. Returns how many went out and how many remain. */
export function drainOfflineWrites(send: Sender) {
  return drainQueue(async (entry: QueuedMutation) => {
    const sender = SENDERS[entry.kind];
    // An unknown kind is from a build that no longer exists. Treating it as
    // sent drops it, which is better than retrying something nothing can
    // handle until it burns through its attempts.
    if (!sender) return;
    await sender(entry.payload, send);
  });
}

export { readQueue as readOfflineWrites };
