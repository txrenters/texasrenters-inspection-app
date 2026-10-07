import { PhotoCaptureType } from '@prisma/client';

/**
 * The moments a technician marked while filming, as the photographs they asked
 * for.
 *
 * Android cannot take a still while it records -- expo-camera binds the photo
 * or the video use case, never both -- so its shutter marks the moment instead.
 * The phone used to cut those frames out of the finished video itself, decoding
 * it once per marker before the review screen could open, on a battery the
 * move-out was already spending (2026-10-06). The phone now sends the moments
 * with the upload, and the server files each one from Cloudflare's frame
 * service once the encode is ready -- the way it already files the AI's frames
 * and the console's "Add photo". A recording uploaded the old way, through this
 * backend, still has its frames cut with ffmpeg.
 */
export interface FrameMarker {
  atMs: number;
  captureType: PhotoCaptureType;
}

/** Hard ceiling on frames cut from one recording, whatever the client asked for. */
export const MAX_EXTRACTED_FRAMES = 60;

/**
 * Reads technician frame markers back out of the stored capture summary.
 *
 * Bounded by the recording length: a marker past the end yields no frame, and
 * trusting a client-supplied offset unchecked would let one recording spawn
 * arbitrarily many frame fetches.
 */
export function readFrameMarkers(captureSummary: unknown, durationSeconds: number): number[] {
  if (!captureSummary || typeof captureSummary !== 'object') return [];
  const raw = (captureSummary as { frameMarkersMs?: unknown }).frameMarkersMs;
  if (!Array.isArray(raw)) return [];
  const limitMs = Math.max(0, durationSeconds) * 1000;
  const valid = raw.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limitMs,
  );
  return [...new Set(valid.map((value) => Math.round(value)))]
    .sort((left, right) => left - right)
    .slice(0, MAX_EXTRACTED_FRAMES);
}

const CAPTURE_TYPES = new Set<string>(Object.values(PhotoCaptureType));

/**
 * The markers in a recording's capture summary, each with the kind of photo
 * the technician was taking.
 *
 * `frameMarkers` carries the kind; `frameMarkersMs` alone (the multipart path,
 * and phones from before the kinds were sent) is read as the first frame for
 * the room overview and the rest as context, which is what that path filed.
 */
export function readMarkers(captureSummary: unknown, durationSeconds: number): FrameMarker[] {
  const moments = readFrameMarkers(captureSummary, durationSeconds);
  const kinds = new Map<number, PhotoCaptureType>();
  const raw = (captureSummary as { frameMarkers?: unknown } | null)?.frameMarkers;
  if (Array.isArray(raw))
    for (const entry of raw as { atMs?: unknown; captureType?: unknown }[]) {
      if (
        typeof entry?.atMs === 'number' &&
        typeof entry.captureType === 'string' &&
        CAPTURE_TYPES.has(entry.captureType)
      )
        kinds.set(Math.round(entry.atMs), entry.captureType as PhotoCaptureType);
    }
  return moments.map((atMs, index) => ({
    atMs,
    captureType:
      kinds.get(atMs) ?? (index === 0 ? PhotoCaptureType.AREA_OVERVIEW : PhotoCaptureType.FINDING_CONTEXT),
  }));
}

/**
 * One key per moment of one recording: the key the console's "Add photo" and
 * the AI's filed frames use, so the same moment is one photograph whoever asked
 * for it first, and filing again -- a re-run, a retried webhook -- finds it.
 */
export function markerPhotoKey(mediaId: string, atMs: number) {
  return `${mediaId}-snapshot-${atMs}`;
}

/** One Cloudflare frame, tried three times: the renderer can lag the encode by a moment. */
export async function fetchStreamFrame(url: string, attempts = 3): Promise<Buffer | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (response?.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  return null;
}
