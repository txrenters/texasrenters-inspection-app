import * as LegacyFileSystem from 'expo-file-system/legacy';
import { resolveApiUrl } from '@texasrenters/shared';

import { getSession } from '../auth/session';
import { environment } from '../config/environment';
import type { PhotoCaptureType } from '../domain/models';
import type { SnapshotCaptureSource } from '../capture/guided-capture';
import { SessionExpiredError } from '../storage/offline-record-cache';

/**
 * A photo upload that did not succeed, carrying the status that explains it.
 *
 * The status is the whole point. Without it every failure looked the same, so
 * the only honest thing a caller could do was give up — which is what the
 * camera did, silently. A 409 will never succeed and a 503 almost certainly
 * will on the next try, and nothing could tell them apart.
 */
export class PhotoUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PhotoUploadError';
  }
}

export interface UploadRoomPhotoInput {
  roomId: string;
  uri: string;
  captureType: PhotoCaptureType;
  idempotencyKey: string;
  width?: number;
  height?: number;
  recordingSessionId?: string;
  videoTimestampMs?: number;
  captureSource?: SnapshotCaptureSource;
  sequenceNumber?: number;
  findingId?: string;
  /**
   * The checklist item this photograph evidences.
   *
   * Optional: plenty of shots document the room generally. When set, the
   * report captions the photograph with the item's name and groups it under
   * that row, which is how the office's printed report is laid out.
   */
  checklistItemId?: string;
}

/**
 * Uploads a captured photo to the technician photo endpoint using a multipart
 * file upload task (RN FormData is unreliable for file URIs). The photo is
 * already persisted locally, so a failure here is recoverable — the caller marks
 * the snapshot FAILED and can retry with the same idempotency key.
 */
export async function uploadRoomPhoto(input: UploadRoomPhotoInput): Promise<{ id: string }> {
  const session = await getSession();
  if (!session) throw new SessionExpiredError();
  const baseUrl = environment.apiBaseUrls[0] ?? environment.apiBaseUrl;
  if (!baseUrl) throw new Error('The TexasRenters API URL is not configured for this app build.');

  const task = LegacyFileSystem.createUploadTask(
    resolveApiUrl(baseUrl, `/api/v1/technician/rooms/${encodeURIComponent(input.roomId)}/photos`),
    input.uri,
    {
      httpMethod: 'POST',
      uploadType: LegacyFileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: 'image/jpeg',
      parameters: {
        idempotencyKey: input.idempotencyKey,
        captureType: input.captureType,
        ...(input.width ? { width: String(Math.round(input.width)) } : {}),
        ...(input.height ? { height: String(Math.round(input.height)) } : {}),
        ...(input.recordingSessionId ? { recordingSessionId: input.recordingSessionId } : {}),
        ...(input.videoTimestampMs !== undefined
          ? { videoTimestampMs: String(Math.max(0, Math.round(input.videoTimestampMs))) }
          : {}),
        ...(input.captureSource ? { captureSource: input.captureSource } : {}),
        ...(input.sequenceNumber
          ? { sequenceNumber: String(Math.max(1, Math.round(input.sequenceNumber))) }
          : {}),
        ...(input.findingId ? { findingId: input.findingId } : {}),
        ...(input.checklistItemId ? { checklistItemId: input.checklistItemId } : {}),
      },
      headers: { authorization: `Bearer ${session.accessToken}` },
    },
  );
  const result = await task.uploadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    const message = (() => {
      try {
        return (JSON.parse(result?.body ?? '{}') as { message?: string }).message;
      } catch {
        return undefined;
      }
    })();
    throw new PhotoUploadError(
      message ?? `The photo upload failed (${result?.status ?? 'no response'}).`,
      result?.status,
    );
  }
  return JSON.parse(result.body ?? '{}') as { id: string };
}
