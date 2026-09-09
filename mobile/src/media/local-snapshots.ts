import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { PhotoCaptureType, RoomSnapshot } from '../domain/models';
import type { SnapshotCaptureSource } from '../capture/guided-capture';

const SNAPSHOTS_FOLDER = 'inspection-snapshots';

type RoomSnapshotInput = {
  ownerUserId?: string;
  inspectionId: string;
  roomId: string;
  uri: string;
  width: number;
  height: number;
  sizeBytes?: number;
  captureType?: PhotoCaptureType;
  recordingSessionId?: string;
  videoTimestampMs?: number;
  captureSource?: SnapshotCaptureSource;
  sequenceNumber?: number;
  findingId?: string;
  /**
   * When this photograph becomes due to upload.
   *
   * Set to a moment shortly in the future for a shot taken at the shutter, so
   * the technician can throw away a test frame before anything is sent.
   * `snapshotsAwaitingUpload` already skips whatever is not yet due, so a held
   * photograph needs no new state. Absent means due now, which is what a frame
   * cut out of a finished recording wants.
   */
  nextAttemptAt?: string;
};

export function buildRoomSnapshot({
  ownerUserId,
  inspectionId,
  roomId,
  uri,
  width,
  height,
  sizeBytes,
  captureType = 'AREA_OVERVIEW',
  recordingSessionId,
  videoTimestampMs,
  captureSource = 'SEPARATE_PHOTO_CAPTURE',
  sequenceNumber,
  findingId,
  nextAttemptAt,
}: RoomSnapshotInput): RoomSnapshot {
  return {
    // Doubles as the upload idempotency key (matches ^[A-Za-z0-9_-]{8,128}$).
    id: `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ownerUserId,
    inspectionId,
    roomId,
    uri,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    sizeBytes: sizeBytes && sizeBytes > 0 ? sizeBytes : undefined,
    capturedAt: new Date().toISOString(),
    captureType,
    recordingSessionId,
    videoTimestampMs,
    captureSource,
    sequenceNumber,
    findingId,
    nextAttemptAt,
    uploadStatus: 'PENDING',
  };
}

export function persistRoomSnapshot(
  temporaryUri: string,
  inspectionId: string,
  roomId: string,
): { uri: string; sizeBytes?: number } {
  if (Platform.OS === 'web' || !temporaryUri.startsWith('file://')) {
    return { uri: temporaryUri };
  }

  const source = new File(temporaryUri);
  if (!source.exists) throw new Error('The captured snapshot file could not be found.');

  const directory = new Directory(
    Paths.document,
    SNAPSHOTS_FOLDER,
    safePathSegment(inspectionId),
    safePathSegment(roomId),
  );
  directory.create({ idempotent: true, intermediates: true });

  const extension = source.extension || '.jpg';
  const destination = new File(
    directory,
    `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${extension}`,
  );
  source.move(destination);

  const storedFile = new File(destination.uri);
  return { uri: storedFile.uri, sizeBytes: storedFile.size || undefined };
}

/**
 * Removes one stored snapshot from the device.
 *
 * Guarded the same way deleteDraftRecording is: only files this module wrote
 * are ours to delete. A snapshot that never made it out of the camera's
 * temporary directory has no managed path, and unlinking an arbitrary uri
 * because it arrived in a discard call is not a risk worth taking.
 */
export function deleteRoomSnapshot(uri: string) {
  if (Platform.OS === 'web' || !uri.includes(SNAPSHOTS_FOLDER)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

export function clearLocalSnapshots() {
  if (Platform.OS === 'web') return;
  const directory = new Directory(Paths.document, SNAPSHOTS_FOLDER);
  if (directory.exists) directory.delete();
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
