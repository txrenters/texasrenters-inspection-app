import type { RoomSnapshot } from '../domain/models';
import { PhotoUploadError, uploadRoomPhoto } from './photo-upload';

/**
 * Getting a captured photo to the server, and keeping trying.
 *
 * This used to live inside the camera screen as four lines ending in a bare
 * `catch {}`: the snapshot was marked FAILED, the JPEG stayed on the device,
 * and nothing anywhere re-sent it or told the technician. A photo that failed
 * because a lift had no signal was indistinguishable from one the server had
 * refused outright, and both were lost in the same silent way.
 *
 * It lives here so the runner can do it too — a screen the technician has
 * already walked away from cannot be the only thing that retries.
 */

/** Backoff. Doubles, then holds, so a long outage does not spin the radio. */
const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;
/**
 * After this many attempts a retryable failure stops being retried on its own.
 *
 * Not a deletion — the snapshot stays, with its reason, and the technician can
 * still send it by hand. Something that has failed eight times is not going to
 * be fixed by a ninth attempt in the next fifteen seconds, and a queue that
 * never gives up is a radio that never sleeps.
 */
export const MAX_AUTOMATIC_ATTEMPTS = 8;

export type RetryPlan = { kind: 'permanent' } | { kind: 'retry'; delayMs: number };

/**
 * Whether another attempt could plausibly succeed.
 *
 * A 4xx is the server refusing: the photo is a duplicate, or the inspection is
 * finalized, and the answer will be the same in an hour. Retrying it forever
 * is the mistake the video queue already makes — `stream-upload-runner` treats
 * every session failure as retryable, so a permanent refusal spins for ever
 * against an answer that will never change.
 *
 * 408 and 429 are the exceptions: both explicitly mean "try again".
 */
export function retryPlanFor(status: number | undefined, attempts: number): RetryPlan {
  const retryableClientError = status === 408 || status === 429;
  if (status !== undefined && status >= 400 && status < 500 && !retryableClientError)
    return { kind: 'permanent' };
  if (attempts >= MAX_AUTOMATIC_ATTEMPTS) return { kind: 'permanent' };
  return { kind: 'retry', delayMs: Math.min(BASE_RETRY_MS * 2 ** attempts, MAX_RETRY_MS) };
}

/** The snapshots this device still owes the server, soonest first. */
export function snapshotsAwaitingUpload(
  snapshots: readonly RoomSnapshot[],
  now = Date.now(),
): RoomSnapshot[] {
  return snapshots
    .filter((snapshot) => {
      if (snapshot.uploadStatus === 'UPLOADED') return false;
      // UPLOADING is a claim by a run that may have died with the app. It is
      // still owed, and the idempotency key makes a duplicate attempt safe.
      if (snapshot.attempts !== undefined && snapshot.attempts >= MAX_AUTOMATIC_ATTEMPTS)
        return false;
      if (!snapshot.nextAttemptAt) return true;
      return new Date(snapshot.nextAttemptAt).getTime() <= now;
    })
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
}

export interface SnapshotUploadPort {
  update: (id: string, patch: Partial<RoomSnapshot>) => void;
}

/**
 * Sends one snapshot, recording what happened either way.
 *
 * The idempotency key is the snapshot id, so a retry after a response that was
 * sent but never arrived resolves to the same photo rather than a second copy.
 */
export async function uploadSnapshotNow(
  snapshot: RoomSnapshot,
  store: SnapshotUploadPort,
): Promise<boolean> {
  const attempts = (snapshot.attempts ?? 0) + 1;
  store.update(snapshot.id, { uploadStatus: 'UPLOADING' });
  try {
    const uploaded = await uploadRoomPhoto({
      roomId: snapshot.roomId,
      uri: snapshot.uri,
      captureType: snapshot.captureType ?? 'AREA_OVERVIEW',
      idempotencyKey: snapshot.id,
      width: snapshot.width,
      height: snapshot.height,
      recordingSessionId: snapshot.recordingSessionId,
      videoTimestampMs: snapshot.videoTimestampMs,
      captureSource: snapshot.captureSource,
      sequenceNumber: snapshot.sequenceNumber,
    });
    store.update(snapshot.id, {
      uploadStatus: 'UPLOADED',
      serverPhotoId: uploaded.id,
      lastError: undefined,
      nextAttemptAt: undefined,
      attempts,
    });
    return true;
  } catch (cause) {
    const status = cause instanceof PhotoUploadError ? cause.status : undefined;
    const message = cause instanceof Error ? cause.message : 'The photo could not be uploaded.';
    const plan = retryPlanFor(status, attempts);
    store.update(snapshot.id, {
      uploadStatus: 'FAILED',
      lastError: message,
      attempts,
      nextAttemptAt:
        plan.kind === 'retry' ? new Date(Date.now() + plan.delayMs).toISOString() : undefined,
    });
    return false;
  }
}
