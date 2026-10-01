import { ApiConnectionError } from '../../storage/offline-record-cache';
import { flushRoomSnapshotsNow } from '../../media/room-snapshot-flush';
import {
  drainQueue,
  enqueueMutation,
  readQueue,
  removeMutation,
  type QueuedMutation,
} from '../../storage/mutation-queue';
import { useNetworkStore } from '../../stores/network.store';

/** Why a write is being held, in the only terms a technician can act on. */
export type HeldReason =
  /** The device could not reach us. Working offline; it goes when signal does. */
  | 'offline'
  /** Signal is fine — we did not take it. Nothing to go looking for. */
  | 'server';

/**
 * A write that was held rather than lost.
 *
 * Distinct from the connection error it replaces so a screen can say the work
 * is kept rather than that it failed — those are different things to be told
 * while standing in somebody's basement.
 *
 * `reason` is the difference between "go and find signal" and "signal is fine,
 * this one is ours": the app told a technician on full bars that their work
 * would send "when you are back", which sends them hunting for a network that
 * was never the problem. `OfflineBanner` keys off the same connectivity flag,
 * so an `offline` hold agrees with what is already on screen and a `server`
 * hold no longer contradicts a banner that is not showing.
 */
export class QueuedOfflineError extends Error {
  readonly reason: HeldReason;

  // Defaulted, unlike `ApiConnectionError`'s: that one decides whether a write
  // is held at all, so leaving it out has to be impossible. This one only
  // picks the wording, `queueOnConnectionFailure` always passes it, and the
  // basement is the case a test constructing one by hand means.
  constructor(reason: HeldReason = 'offline') {
    super(
      reason === 'offline'
        ? 'Saved on this device. It will send when you are back on a network.'
        : 'Saved on this device. The TexasRenters server has not taken it yet — it will keep trying.',
    );
    this.name = 'QueuedOfflineError';
    this.reason = reason;
  }
}

/** Hold the write and say why, or let the failure through to the technician. */
export type HoldDecision = { hold: false } | { hold: true; reason: HeldReason };

/**
 * What actually counts as "we could not be reached".
 *
 * This used to be `error instanceof ApiConnectionError`, which is every 5xx as
 * well — so an online phone talking to an API that was up and throwing 500s
 * was told its work would send "when you are back on a network", and the entry
 * was replayed against an answer that was never going to change. That is the
 * case this function's predecessor argued against in its own comment about
 * 4xx, and a repeatable 500 has the same property: it is worse, because a
 * refusal at least fails in front of the technician, while a held write fails
 * eight drains later with nobody watching.
 *
 * The line is whether the request could still land unchanged:
 *
 * - `transport` — nothing left the handset. Held, and it really is offline.
 * - `unavailable` — 502/503/504. The edge answered because it could not reach
 *   the app, so the request was never processed; a deploy is thirty seconds of
 *   this and holding is what makes it invisible. Held, but not as "offline".
 * - `timeout` — held either way. We cannot tell a crawling connection from a
 *   hung endpoint, and the two possible mistakes are not equal: hold a hung
 *   endpoint's write and it is retried a bounded number of times, surface a
 *   weak signal's and a technician loses work in exactly the basement the
 *   queue exists for. Connectivity picks the wording only, never whether the
 *   work is kept, so the store being up to a probe-interval stale is harmless.
 * - `fault` — a 500 the app produced itself. It received the request and chose
 *   that answer, and may choose it again for this payload forever. Surfaced,
 *   so the technician sees it now, the office's error log gets it, and nothing
 *   quietly throws the work away later.
 *
 * Anything that is not an `ApiConnectionError` is a 4xx or a schema failure —
 * the server refusing the request — and has always been surfaced here.
 */
export function classifyWriteFailure(error: unknown, isOnline: boolean): HoldDecision {
  if (!(error instanceof ApiConnectionError)) return { hold: false };
  switch (error.reason) {
    case 'transport':
      return { hold: true, reason: 'offline' };
    case 'unavailable':
      return { hold: true, reason: 'server' };
    case 'timeout':
      return { hold: true, reason: isOnline ? 'server' : 'offline' };
    case 'fault':
      return { hold: false };
  }
}

/**
 * Sends a write, holding it for later if it could still land unchanged.
 *
 * See `classifyWriteFailure` for which failures those are. A held write throws
 * `QueuedOfflineError`, which every caller treats as a success it must mirror
 * into the offline cache; a surfaced one throws the server's own error, which
 * they let through so the screen rolls back to what was really stored.
 */
export async function queueOnConnectionFailure<T>(
  entry: { id: string; kind: string; payload: Record<string, unknown> },
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    // The app's own definition of online: NetInfo probes `/api/v1/health`, so
    // this already means "can we reach the backend" rather than "is there a
    // radio". Read here rather than through a hook — this runs in a repository.
    const held = classifyWriteFailure(error, useNetworkStore.getState().isOnline);
    if (!held.hold) throw error;
    await enqueueMutation(entry);
    throw new QueuedOfflineError(held.reason);
  }
}

/**
 * Sends a write that must survive the app being closed while it is in flight.
 *
 * `queueOnConnectionFailure` keeps a write only once its send has *failed*. A
 * send still waiting for its reply when the app is swiped away has not failed
 * -- it is simply gone, and nothing on the next launch knows it was ever made.
 * That is how a started job came back asking to be started again (the office,
 * 2026-09-29): Start job answers on the tap, so a technician can close the app
 * a second later, before the request has landed.
 *
 * So the entry is written to the queue *before* the send and removed after the
 * reply. Closed mid-flight, it is still there, and the launch drain sends it.
 * A held failure keeps it, like `queueOnConnectionFailure`; a refusal removes
 * it and is thrown, so the screen can say so. Only for writes whose replay is
 * harmless -- the drain may send it again while this send is still out.
 */
export async function sendSavedFirst<T>(
  entry: { id: string; kind: string; payload: Record<string, unknown> },
  send: () => Promise<T>,
): Promise<T> {
  // The copy saved here, so the reply removes this one and never a newer one.
  const queuedAt = (await enqueueMutation(entry)).find((saved) => saved.id === entry.id)?.queuedAt;
  try {
    const result = await send();
    await removeMutation(entry.id, queuedAt);
    return result;
  } catch (error) {
    const held = classifyWriteFailure(error, useNetworkStore.getState().isOnline);
    if (!held.hold) {
      await removeMutation(entry.id, queuedAt);
      throw error;
    }
    throw new QueuedOfflineError(held.reason);
  }
}

/** The key a job's saved start is queued under. */
export const jobStartEntryId = (inspectionId: string) => `start:${inspectionId}`;

/**
 * The starts saved on this phone that the server has not confirmed, by job.
 *
 * Read so a job started here reads as started everywhere on the phone -- the
 * job screen, the list -- until the server says so itself, whether the app was
 * closed in between or the signal went.
 */
export async function savedServicesReports(): Promise<Map<string, unknown>> {
  const reports = new Map<string, unknown>();
  for (const entry of await readQueue())
    if (entry.kind === 'job-services' && entry.payload.inspectionId && entry.payload.servicesReport)
      reports.set(String(entry.payload.inspectionId), entry.payload.servicesReport);
  return reports;
}

export async function savedJobStarts(): Promise<Map<string, string>> {
  const starts = new Map<string, string>();
  for (const entry of await readQueue()) {
    if (entry.kind !== 'job-start') continue;
    const inspectionId = String(entry.payload.inspectionId ?? '');
    const startedAt = String(entry.payload.startedAt ?? '');
    if (inspectionId && startedAt) starts.set(inspectionId, startedAt);
  }
  return starts;
}

/**
 * The areas submitted on this phone that the server has not confirmed yet.
 *
 * Submit Evidence goes back the moment it is pressed (the office, 2026-09-30:
 * "when I click the submit, it should not wait on the server"), and the area's
 * photographs and its completion are sent behind it -- saved first, so a closed
 * app or a lost signal sends them later. Until the server has it, every read of
 * the area says submitted, as the technician saw it.
 */
export async function savedRoomCompletions(): Promise<Set<string>> {
  const rooms = new Set<string>();
  for (const [roomId, state] of await savedRoomStates()) if (state === 'COMPLETED') rooms.add(roomId);
  return rooms;
}

/**
 * The checklist answers saved on this phone for one area and not yet
 * confirmed, by item: the assessment each will send. One per item, because an
 * answer saved again replaces the one before it in the queue.
 */
export async function savedChecklistAnswers(roomId: string): Promise<Map<string, Record<string, unknown>>> {
  const answers = new Map<string, Record<string, unknown>>();
  for (const entry of await readQueue()) {
    if (entry.kind !== 'checklist-assessment' || String(entry.payload.roomId) !== roomId) continue;
    const { itemId, ...rest } = entry.payload;
    if (!itemId) continue;
    const assessment = { ...rest };
    delete assessment.roomId;
    answers.set(String(itemId), assessment);
  }
  return answers;
}

/** What the technician last did to an area here that the server has not confirmed. */
export type SavedRoomState = 'COMPLETED' | 'REOPENED';

/**
 * Each area's last saved submission or Change Evidence, in the order they were
 * made: the queue is replayed in that order, so the last one is what the
 * server will end up with.
 */
export async function savedRoomStates(): Promise<Map<string, SavedRoomState>> {
  const states = new Map<string, SavedRoomState>();
  for (const entry of await readQueue()) {
    const roomId = entry.payload.roomId ? String(entry.payload.roomId) : null;
    if (!roomId) continue;
    if (entry.kind === 'room-complete') states.set(roomId, 'COMPLETED');
    else if (entry.kind === 'room-reopen') states.set(roomId, 'REOPENED');
  }
  return states;
}

/**
 * Areas as the technician left them. One whose submission is saved here reads
 * as completed, and one reopened by Change Evidence reads as not submitted.
 * Only a state the server has not reached yet is changed -- a skipped area, or
 * one the server already agrees about, keeps the server's answer.
 */
export function withRoomStatesSaved<Room extends { id: string; completionStatus: string }>(
  rooms: readonly Room[],
  states: ReadonlyMap<string, SavedRoomState>,
): Room[] {
  if (!states.size) return [...rooms];
  return rooms.map((room) => {
    const state = states.get(room.id);
    if (state === 'COMPLETED' && room.completionStatus !== 'COMPLETED' && room.completionStatus !== 'SKIPPED')
      return { ...room, completionStatus: 'COMPLETED' } as Room;
    if (state === 'REOPENED' && room.completionStatus === 'COMPLETED')
      return { ...room, completionStatus: 'NOT_STARTED' } as Room;
    return room;
  });
}

/** Areas with their saved submissions only: see `withRoomStatesSaved`. */
export function withCompletionsSaved<Room extends { id: string; completionStatus: string }>(
  rooms: readonly Room[],
  saved: ReadonlySet<string>,
): Room[] {
  return withRoomStatesSaved(rooms, new Map([...saved].map((id) => [id, 'COMPLETED' as const])));
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
          // A queued HVAC reading is the same shape as any other assessment.
          // Omitted here it would replay as an empty answer, quietly erasing a
          // measurement the technician took while offline.
          numericValue: payload.numericValue ?? null,
          textValue: payload.textValue ?? null,
        },
      ),
    /**
     * Sends the area's photographs first, then completes it.
     *
     * The order is the whole entry. `completeRoom` is refused by the server
     * unless it can count evidence, and on an occupied area that evidence is a
     * photograph sitting in a different queue — this one is drained by
     * `ConnectivitySync` when the signal returns, the photographs by
     * `UploadQueueRunner` on its own four-second timer, and nothing sequences
     * the two. Flushing here rather than hoping they interleave is what makes a
     * completion held in a basement actually land.
     *
     * Safe to replay: completing sets COMPLETED and a timestamp, so a duplicate
     * writes the same row. `flushRoomSnapshotsNow` is safe to repeat too — an
     * uploaded snapshot is no longer owed, and the idempotency key resolves a
     * re-sent one to the same photograph.
     */
    'room-complete': async (payload, send) => {
      const roomId = String(payload.roomId);
      await flushRoomSnapshotsNow(roomId);
      return send(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/complete`, 'POST', {});
    },
    /**
     * Start job, saved when it was pressed (`sendSavedFirst`).
     *
     * Safe to replay: the server answers a job already started with the job,
     * and keeps the first start. Sent with the time it was pressed, so a start
     * that lands on the next launch still counts the job from the tap. Queued
     * ahead of the job's checklist, which the server takes only once the job is
     * started, and the drain keeps that order.
     */
    'job-start': (payload, send) =>
      send(
        `/api/v1/technician/inspections/${encodeURIComponent(String(payload.inspectionId))}/start`,
        'POST',
        { startedAt: payload.startedAt },
      ),
    /**
     * Change Evidence: a submitted area back to work.
     *
     * Safe to replay: the server answers an area that is not completed as it
     * is. Queued after the area's own submission when that has not gone yet, so
     * the server completes it and then reopens it, as the technician did.
     */
    'room-reopen': (payload, send) =>
      send(`/api/v1/technician/rooms/${encodeURIComponent(String(payload.roomId))}/reopen`, 'POST', {}),
    /**
     * The photographs new evidence replaced.
     *
     * Safe to replay: a photograph already removed is simply not found again.
     * Queued behind the new photograph's capture but not behind its upload --
     * the old ones are named, so the order the two arrive in does not matter.
     */
    'room-replace-evidence': (payload, send) =>
      send(
        `/api/v1/technician/rooms/${encodeURIComponent(String(payload.roomId))}/evidence/replace`,
        'POST',
        { photoKeys: payload.photoKeys ?? [], photoIds: payload.photoIds ?? [] },
      ),
    /**
     * The job's checklist as it stood when the signal went.
     *
     * Safe to replay: the route stores the checklist as sent, so a duplicate
     * writes the same answers. Queued under one id per job
     * (`services:<jobId>`), so a morning of ticks in a basement collapses to
     * the last state rather than replaying twenty of them in order.
     */
    'job-services': (payload, send) =>
      send(
        `/api/v1/technician/inspections/${encodeURIComponent(String(payload.inspectionId))}/services`,
        'PATCH',
        { servicesReport: payload.servicesReport },
      ),
    /**
     * Nobody let the technician in.
     *
     * Safe to replay: it writes the same submission and the same reason. The
     * server refuses it for a job already submitted, which is a 4xx and so is
     * dropped from the queue rather than retried forever.
     */
    'job-no-access': (payload, send) =>
      send(
        `/api/v1/technician/inspections/${encodeURIComponent(String(payload.inspectionId))}/no-access`,
        'POST',
        { reason: payload.reason },
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

/**
 * Whether a failed replay is worth another go.
 *
 * The old enqueue rule, moved to the side it was always right for. Held here,
 * there is no technician to correct anything and no screen to fail in front
 * of, so the only question left is whether the entry could ever be accepted —
 * and every `ApiConnectionError`, a 500 included, could be. Anything else is a
 * refusal: a job already submitted, an area that no longer exists, a body the
 * route will not take. `job-no-access` documents exactly this, and until now
 * the drain retried those eight times instead of dropping them.
 *
 * A 500 that keeps coming is still bounded — `QUEUE_ENTRY_MAX_ATTEMPTS` ends
 * it — and outlasting a bad deploy is worth more than the attempts it spends.
 */
const isWorthReplaying = (error: unknown) => error instanceof ApiConnectionError;

/** Replays what is waiting. Returns how many went out and how many remain. */
export function drainOfflineWrites(send: Sender) {
  return drainQueue(async (entry: QueuedMutation) => {
    const sender = SENDERS[entry.kind];
    // An unknown kind is from a build that no longer exists. Treating it as
    // sent drops it, which is better than retrying something nothing can
    // handle until it burns through its attempts.
    if (!sender) return;
    await sender(entry.payload, send);
  }, isWorthReplaying);
}

export { readQueue as readOfflineWrites };

/**
 * Drops a held write that a later successful one has overtaken.
 *
 * The checklist is one document keyed `services:<job>`, so a queued copy is the
 * whole report as it stood when the signal went. Reconnect, answer two more
 * registers online, and the drain would then replay that old document over the
 * top -- putting the job back to the state it was in underground and losing
 * everything answered since. A write that has been superseded is not owed.
 */
export const dropQueuedWrite = (id: string) => removeMutation(id).then(() => undefined);
