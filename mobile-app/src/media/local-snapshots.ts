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

export function clearLocalSnapshots() {
  if (Platform.OS === 'web') return;
  const directory = new Directory(Paths.document, SNAPSHOTS_FOLDER);
  if (directory.exists) directory.delete();
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
