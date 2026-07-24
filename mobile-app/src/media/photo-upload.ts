import * as LegacyFileSystem from 'expo-file-system/legacy';
import { resolveApiUrl } from '@texasrenters/shared';

import { getSupabaseClient } from '../auth/supabase';
import { environment } from '../config/environment';
import type { PhotoCaptureType } from '../domain/models';

export interface UploadRoomPhotoInput {
  roomId: string;
  uri: string;
  captureType: PhotoCaptureType;
  idempotencyKey: string;
  width?: number;
  height?: number;
}

/**
 * Uploads a captured photo to the technician photo endpoint using a multipart
 * file upload task (RN FormData is unreliable for file URIs). The photo is
 * already persisted locally, so a failure here is recoverable — the caller marks
 * the snapshot FAILED and can retry with the same idempotency key.
 */
export async function uploadRoomPhoto(input: UploadRoomPhotoInput): Promise<{ id: string }> {
  const { data } = await getSupabaseClient().auth.getSession();
  if (!data.session) throw new Error('Your session has expired. Sign in again.');
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
      },
      headers: { authorization: `Bearer ${data.session.access_token}` },
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
    throw new Error(message ?? `The photo upload failed (${result?.status ?? 'no response'}).`);
  }
  return JSON.parse(result.body ?? '{}') as { id: string };
}
