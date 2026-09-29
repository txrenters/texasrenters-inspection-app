import { demoStorage } from './demo-storage';

/**
 * Writes held until the device is back on a network.
 *
 * Reads already survive losing signal — they fall back to the record cache —
 * so the failure a technician meets is a write: a note, a skip reason. Those
 * used to fail with an error and be gone, which is how someone types a skip
 * reason in a basement and finds out on submit that it went nowhere.
 *
 * Only writes that are safe to send twice belong here. Every technician
 * endpoint except pet observations sets a value rather than appending one, so
 * replaying lands on the same state; pet observations carry an idempotency key
 * for the same reason. Nothing that appends without a key may be queued, or a
 * replay records the same thing twice.
 *
 * Deliberately not a general job runner: no backoff schedule, no partial
 * retries within an entry. An entry is sent or it stays, and the technician can
 * see how many are waiting.
 */
const QUEUE_KEY = 'texasrenters-mutation-queue-v1';

/** Beyond this, an entry is more likely to be stale than useful. */
export const QUEUE_ENTRY_MAX_ATTEMPTS = 8;

export interface QueuedMutation {
  id: string;
  /** Identifies the handler that knows how to send it — see `MUTATION_SENDERS`. */
  kind: string;
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
}

function isEntry(value: unknown): value is QueuedMutation {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<QueuedMutation>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.kind === 'string' &&
    typeof entry.queuedAt === 'string' &&
    typeof entry.attempts === 'number' &&
    Boolean(entry.payload) &&
    typeof entry.payload === 'object'
  );
}

export async function readQueue(): Promise<QueuedMutation[]> {
  const stored = await demoStorage.getItem(QUEUE_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    // A malformed queue is dropped rather than thrown: a technician cannot fix
    // corrupt storage, and refusing to start is worse than losing entries that
    // could not have been sent anyway.
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    await demoStorage.removeItem(QUEUE_KEY);
    return [];
  }
}

async function writeQueue(entries: QueuedMutation[]) {
  if (!entries.length) {
    await demoStorage.removeItem(QUEUE_KEY);
    return;
  }
  await demoStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
}

/**
 * Adds a write, replacing an earlier one for the same target.
 *
 * `id` is the target, not the attempt: two edits to the same note should send
 * the last value once, not both in order. That is only correct because every
 * queued write sets a value — an appending write would need one entry each.
 */
export async function enqueueMutation(entry: {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}): Promise<QueuedMutation[]> {
  const queue = await readQueue();
  const next = queue.filter((existing) => existing.id !== entry.id);
  next.push({ ...entry, queuedAt: new Date().toISOString(), attempts: 0 });
  await writeQueue(next);
  return next;
}

/**
 * Removes an entry, or -- given the `queuedAt` it was saved with -- only that
 * copy of it.
 *
 * A write saved again under the same id while its first copy was being sent
 * (submit, change evidence, submit again, with no signal) replaces that copy in
 * the queue. Removing by id alone once the first send answered would then drop
 * the newer copy too, and with it the write the technician made last.
 */
export async function removeMutation(id: string, queuedAt?: string): Promise<QueuedMutation[]> {
  const next = (await readQueue()).filter(
    (entry) => entry.id !== id || (queuedAt !== undefined && entry.queuedAt !== queuedAt),
  );
  await writeQueue(next);
  return next;
}

/** Records a failed send. An entry past the attempt ceiling is dropped. */
export async function recordAttempt(id: string): Promise<QueuedMutation[]> {
  const next = (await readQueue())
    .map((entry) => (entry.id === id ? { ...entry, attempts: entry.attempts + 1 } : entry))
    .filter((entry) => entry.attempts < QUEUE_ENTRY_MAX_ATTEMPTS);
  await writeQueue(next);
  return next;
}

/**
 * Sends what is waiting, oldest first.
 *
 * Stops at the first failure rather than working through the rest: the usual
 * reason a send fails is that the network went away again, and hammering the
 * remaining entries only burns attempts against a connection that is gone.
 *
 * `isRetryable` separates that from a send the server *answered*. Waiting
 * cannot change a refusal, and an entry that will never be accepted must not
 * sit at the head of the queue stalling everything behind it for the eight
 * reconnects it takes to burn the ceiling — a technician's held skips and
 * notes would go nowhere because one submission was already in. Refused
 * entries are dropped and the drain carries on, because a refusal says
 * nothing about the connection. Defaults to retrying everything, which is
 * what a caller with no view of its own errors should get.
 */
export async function drainQueue(
  send: (entry: QueuedMutation) => Promise<void>,
  isRetryable: (error: unknown) => boolean = () => true,
): Promise<{ sent: number; remaining: number }> {
  let sent = 0;
  for (const entry of await readQueue()) {
    try {
      await send(entry);
      await removeMutation(entry.id, entry.queuedAt);
      sent += 1;
    } catch (error) {
      if (!isRetryable(error)) {
        await removeMutation(entry.id, entry.queuedAt);
        continue;
      }
      await recordAttempt(entry.id);
      break;
    }
  }
  return { sent, remaining: (await readQueue()).length };
}
