import type { BoundingBox, ContainRect, Marker, ViewTransform } from './types';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * The rendered image rectangle for an `object-fit: contain` image inside a
 * container. Returns null before the image/container have measurable size.
 */
export function computeContainRect(
  naturalW: number,
  naturalH: number,
  containerW: number,
  containerH: number,
): ContainRect | null {
  if (naturalW <= 0 || naturalH <= 0 || containerW <= 0 || containerH <= 0) return null;
  const scale = Math.min(containerW / naturalW, containerH / naturalH);
  const renderedW = naturalW * scale;
  const renderedH = naturalH * scale;
  return {
    scale,
    renderedW,
    renderedH,
    offsetX: (containerW - renderedW) / 2,
    offsetY: (containerH - renderedH) / 2,
  };
}

/** Normalized (0..1) image coordinate → base (untransformed wrapper) pixels. */
export function markerToBase(rect: ContainRect, x: number, y: number): { left: number; top: number } {
  return { left: rect.offsetX + x * rect.renderedW, top: rect.offsetY + y * rect.renderedH };
}

/**
 * Client pixel → normalized image coordinate. Undoes the wrapper transform
 * (translate(pan) scale(zoom) with transform-origin 0 0) then the letterbox
 * offset. Returns null when the image has no rendered size. The result is NOT
 * clamped — callers apply their own policy (Place ignores out-of-range clicks;
 * drag/nudge clamps).
 */
export function clientToNormalized(
  clientX: number,
  clientY: number,
  stageRect: { left: number; top: number },
  transform: ViewTransform,
  rect: ContainRect,
): Marker | null {
  if (rect.renderedW <= 0 || rect.renderedH <= 0 || transform.zoom <= 0) return null;
  const px = clientX - stageRect.left;
  const py = clientY - stageRect.top;
  const baseX = (px - transform.pan.x) / transform.zoom;
  const baseY = (py - transform.pan.y) / transform.zoom;
  return {
    x: (baseX - rect.offsetX) / rect.renderedW,
    y: (baseY - rect.offsetY) / rect.renderedH,
  };
}

/** Pan that places a normalized point at the container centre, keeping zoom. */
export function centerOnMarker(
  rect: ContainRect,
  marker: Marker,
  containerW: number,
  containerH: number,
  zoom: number,
): { x: number; y: number } {
  const base = markerToBase(rect, marker.x, marker.y);
  return { x: containerW / 2 - zoom * base.left, y: containerH / 2 - zoom * base.top };
}

/** Zoom + pan that fits a normalized bounding box with padding, centred. */
export function fitBoundingBox(
  rect: ContainRect,
  box: BoundingBox,
  containerW: number,
  containerH: number,
  padding = 24,
): ViewTransform {
  const boxW = Math.max(box.width * rect.renderedW, 1);
  const boxH = Math.max(box.height * rect.renderedH, 1);
  const zoom = clampZoom(
    Math.min((containerW - 2 * padding) / boxW, (containerH - 2 * padding) / boxH),
  );
  const centre = markerToBase(rect, box.x + box.width / 2, box.y + box.height / 2);
  return { zoom, pan: { x: containerW / 2 - zoom * centre.left, y: containerH / 2 - zoom * centre.top } };
}

/** Normalized step for a 1px on-screen keyboard nudge at the current zoom. */
export function nudgeStep(rect: ContainRect, zoom: number, screenPx: number): number {
  const denom = rect.renderedW * zoom;
  return denom > 0 ? screenPx / denom : 0;
}
