import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { FrameMarker, LocalMedia, VideoRecordingType } from '../domain/models';
import type { GuidedCaptureSummary } from '../capture/guided-capture';

const RECORDINGS_FOLDER = 'inspection-recordings';
const FALLBACK_MEGABYTES_PER_SECOND = 0.66;

type RecordingDraftInput = {
  ownerUserId?: string;
  inspectionId: string;
  roomId: string;
  uri: string;
  durationSeconds: number;
  sizeBytes?: number;
  recordingType?: VideoRecordingType;
  captureSummary?: GuidedCaptureSummary;
  frameMarkers?: FrameMarker[];
  recordingSessionId?: string;
};

export function buildRecordingDraft({
  ownerUserId,
  inspectionId,
  roomId,
  uri,
  durationSeconds,
  sizeBytes,
  recordingType = 'PRIMARY_AREA',
  captureSummary,
  frameMarkers,
  recordingSessionId,
}: RecordingDraftInput): LocalMedia {
  const normalizedDuration = Math.max(1, Math.round(durationSeconds));
  const markers = orderedMarkers(frameMarkers ?? []);

  return {
    id: `draft-${Date.now()}`,
    ownerUserId,
    inspectionId,
    roomId,
    recordingType,
    uri,
    durationSeconds: normalizedDuration,
    estimatedSizeMb:
      sizeBytes && sizeBytes > 0
        ? sizeBytes / (1024 * 1024)
        : normalizedDuration * FALLBACK_MEGABYTES_PER_SECOND,
    recordedAt: new Date().toISOString(),
    note: '',
    // Carried so the review screen can find this take's photographs. They are
    // uploaded as they are shot, so discarding has to reach the server too.
    recordingSessionId,
    // Additional clips are focused evidence, not full-room walkthroughs. Keep
    // their upload contract free of 360-completion pressure even if a stale
    // caller accidentally supplies a primary capture summary.
    captureSummary: recordingType === 'PRIMARY_AREA' ? captureSummary : undefined,
    // Sorted and de-duplicated here rather than at the call site: markers are
    // appended as the technician taps, and the server extracts frames in the
    // order it is given. Two taps inside the same second are one frame.
    frameMarkersMs: markers.length ? markers.map((marker) => marker.atMs) : undefined,
    frameMarkers: markers.length ? markers : undefined,
  };
}

/** One marker per moment, in order; the first tap at a moment names its kind. */
function orderedMarkers(markers: readonly FrameMarker[]): FrameMarker[] {
  const byMoment = new Map<number, FrameMarker>();
  for (const marker of markers) {
    const atMs = Math.max(0, Math.round(marker.atMs));
    if (!byMoment.has(atMs)) byMoment.set(atMs, { atMs, captureType: marker.captureType });
  }
  return [...byMoment.values()].sort((left, right) => left.atMs - right.atMs);
}

export function persistRecording(
  temporaryUri: string,
  inspectionId: string,
  roomId: string,
): { uri: string; sizeBytes?: number } {
  if (Platform.OS === 'web' || !temporaryUri.startsWith('file://')) {
    return { uri: temporaryUri };
  }

  const source = new File(temporaryUri);
  if (!source.exists) throw new Error('The recorded video file could not be found.');

  const directory = new Directory(
    Paths.document,
    RECORDINGS_FOLDER,
    safePathSegment(inspectionId),
    safePathSegment(roomId),
  );
  directory.create({ idempotent: true, intermediates: true });

  const extension = source.extension || '.mp4';
  const destination = new File(
    directory,
    `recording-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${extension}`,
  );
  source.move(destination);

  const storedFile = new File(destination.uri);
  return { uri: storedFile.uri, sizeBytes: storedFile.size || undefined };
}

export function deleteDraftRecording(uri: string) {
  if (Platform.OS === 'web' || !isManagedRecording(uri)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

export function clearLocalRecordings() {
  if (Platform.OS === 'web') return;
  const directory = recordingsDirectory();
  if (directory.exists) directory.delete();
}

function recordingsDirectory() {
  return new Directory(Paths.document, RECORDINGS_FOLDER);
}

function isManagedRecording(uri: string) {
  return uri.startsWith(recordingsDirectory().uri);
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
