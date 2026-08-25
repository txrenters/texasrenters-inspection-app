import type { RoomSnapshot } from '../domain/models';
import { requestJson } from '../repositories/api/repositories';
import { deleteRoomSnapshot } from './local-snapshots';

/**
 * Throwing away a take means throwing away everything it produced.
 *
 * A walkthrough is a recording *and* the photographs shot during it. Discard
 * only ever deleted the video, so the photographs stayed — and because
 * snapshots upload as they are taken rather than at save time, most of them
 * were already on the server by the time the technician reached the review
 * screen. The result was evidence from a discarded walkthrough appearing in the
 * report for one that was never filmed.
 */

/** The photographs shot during one capture session. */
export function snapshotsForSession(
  snapshots: readonly RoomSnapshot[],
  recordingSessionId: string | undefined,
) {
  // No session id means nothing can be matched, and matching on room instead
  // would take the photographs belonging to a take that was already saved.
  if (!recordingSessionId) return [];
  return snapshots.filter((snapshot) => snapshot.recordingSessionId === recordingSessionId);
}

/** Photographs the server already holds, and so has to be told about. */
export function uploadedServerPhotoIds(snapshots: readonly RoomSnapshot[]) {
  return snapshots
    .map((snapshot) => snapshot.serverPhotoId)
    .filter((id): id is string => Boolean(id));
}

export interface DiscardResult {
  /** Snapshot ids the caller should drop from the store. */
  removedIds: string[];
  /** Server photographs that could not be deleted, so nothing is claimed falsely. */
  failed: string[];
}

/**
 * Deletes a session's photographs from the server first, then from the device.
 *
 * Server first, and nothing local is touched unless every server delete
 * succeeded. Deleting the local copy first would discard the `serverPhotoId`
 * along with it, leaving a photograph on the server that nothing in the app
 * knows how to find, still attached to the area and still bound for the report.
 * Failing loudly and changing nothing leaves the take intact and the discard
 * retryable — which is the honest outcome when the evidence is still out there.
 */
export async function discardCaptureSession(
  snapshots: readonly RoomSnapshot[],
  recordingSessionId: string | undefined,
): Promise<DiscardResult> {
  const doomed = snapshotsForSession(snapshots, recordingSessionId);
  if (doomed.length === 0) return { removedIds: [], failed: [] };

  const failed: string[] = [];
  for (const photoId of uploadedServerPhotoIds(doomed)) {
    try {
      await requestJson(`/api/v1/technician/photos/${encodeURIComponent(photoId)}`, {
        method: 'DELETE',
      });
    } catch {
      failed.push(photoId);
    }
  }
  if (failed.length) return { removedIds: [], failed };

  // Only now, with nothing left on the server, is the local copy safe to lose.
  for (const snapshot of doomed) deleteRoomSnapshot(snapshot.uri);
  return { removedIds: doomed.map((snapshot) => snapshot.id), failed: [] };
}
