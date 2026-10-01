import {
  describePhotoCaptureTime,
  formatPhotoStamp,
  type AreaEvidenceBundle,
  type AreaEvidenceSummaryItem,
  type AreaPhoto,
} from '@texasrenters/shared';

import type { EvidenceViewerItem } from './EvidenceViewer';
import { captureLabel } from './LazyPhoto';

/**
 * Where a photograph's time and bytes come from, for the reviewer.
 *
 * The stamp on the photo says when; this says how that is known, when the
 * server received the file, and the start of its SHA-256 -- enough to match
 * against the original if the photograph is ever challenged.
 */
export function photoProvenance(photo: AreaPhoto) {
  const received = photo.receivedAt ? formatPhotoStamp(photo.receivedAt, 'DEVICE_CLOCK') : null;
  return [
    describePhotoCaptureTime(photo.captureTimeSource),
    received && photo.captureTimeSource !== 'SERVER_RECEIPT' ? `received ${received}` : null,
    photo.sha256 ? `SHA-256 ${photo.sha256.slice(0, 12)}…` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * An area's photographs in the order its Photos tab shows them: the overview,
 * each finding's evidence, then the supporting shots.
 *
 * One definition for both viewers -- the area's own and the one that walks
 * every area -- so they can never disagree about which photograph comes next.
 */
export function areaPhotoItems(bundle: AreaEvidenceBundle): EvidenceViewerItem[] {
  return bundle.photoGroups.flatMap((group) =>
    group.photos.map((photo) => ({
      id: photo.id,
      kind: 'photo' as const,
      contentPath: photo.contentPath,
      title: photo.label || captureLabel(photo.captureType),
      caption: `${group.label} · ${photoProvenance(photo)}`,
      capturedAt: photo.capturedAt,
      captureTimeSource: photo.captureTimeSource,
    })),
  );
}

/**
 * The nearest area in `direction` that has photographs, or null past either end.
 *
 * Areas with none are passed over: a skipped hallway is not a stop on the way
 * from the living room to the kitchen. Read from the summary's counts, so
 * finding the next stop costs no request.
 */
export function nextAreaWithPhotos<Area extends Pick<AreaEvidenceSummaryItem, 'id' | 'counts'>>(
  areas: readonly Area[],
  fromId: string,
  direction: 1 | -1,
): Area | null {
  const from = areas.findIndex((area) => area.id === fromId);
  if (from === -1) return null;
  for (let at = from + direction; at >= 0 && at < areas.length; at += direction)
    if (areas[at].counts.photos > 0) return areas[at];
  return null;
}

export type Size = { width: number; height: number };

/**
 * The size that shows the whole photograph inside `frame`, never larger than
 * the photograph itself.
 *
 * The viewer sets the image box to exactly this. Left to `object-contain`, the
 * box of a portrait photograph is as wide as the screen and the picture sits
 * in the middle of it, so the capture time -- drawn at the box's corner -- landed
 * on the letterboxing, 200 px to the left of the photograph.
 */
export function fitWithin(natural: Size, frame: Size): Size | null {
  if (!natural.width || !natural.height || !frame.width || !frame.height) return null;
  const scale = Math.min(frame.width / natural.width, frame.height / natural.height, 1);
  return {
    width: Math.round(natural.width * scale),
    height: Math.round(natural.height * scale),
  };
}
