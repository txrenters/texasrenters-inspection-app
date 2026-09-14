'use client';

import { formatPhotoStamp, type PublicReportPhoto } from '@texasrenters/shared';
import { DownloadIcon, XIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { apiBlob } from '@/lib/api';

/**
 * A photograph at full size, for reading detail off it.
 *
 * These photographs end up in a deck put in front of a court or an owner, so
 * three things matter beyond looking at them: getting close enough to see the
 * damage, saving the original rather than a thumbnail, and stepping through an
 * area without closing and reopening.
 */

/** What the grid shows. The viewer always fetches better than this. */
const VIEW_WIDTH = 1600;
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.5;
/** Where a double-click takes a photograph that is not zoomed in yet. */
const DOUBLE_CLICK_ZOOM = 2.5;
/**
 * How far one wheel movement zooms.
 *
 * Exponential in the wheel's travel, so a mouse notch (about 100 pixels of
 * delta) is a step of a fifth or so while a trackpad's stream of small deltas
 * glides rather than jumping. Firefox reports lines, not pixels, hence the
 * second rate.
 */
const WHEEL_RATE_PER_PIXEL = 0.002;
const WHEEL_RATE_PER_LINE = 0.05;

const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/**
 * Bytes must be fetched rather than linked.
 *
 * The photo route is authenticated, so an `<a download href>` would arrive
 * without a session and save an error page under a .jpg name — which looks like
 * a corrupt download rather than a permission problem.
 */
async function download(photo: PublicReportPhoto, fileName: string) {
  // No width parameter: the original, which is the point of downloading it.
  const blob = await apiBlob(photo.contentPath);
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function fileNameFor(photo: PublicReportPhoto, areaName: string, sideLabel: string) {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const parts = [slug(areaName), slug(sideLabel), photo.label ? slug(photo.label) : '']
    .filter(Boolean)
    .join('-');
  return `${parts || 'photo'}-${photo.id.slice(0, 8)}.jpg`;
}

export function PhotoLightbox({
  photos,
  index,
  areaName,
  sideLabel,
  onClose,
}: {
  photos: PublicReportPhoto[];
  index: number;
  areaName: string;
  sideLabel: string;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(index);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** The photograph's own pixels, known once it has loaded. */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  /** The space it is shown in, kept current as the window changes. */
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);

  const viewport = useRef<HTMLDivElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The point of the photograph to keep under the cursor while the zoom changes. */
  const anchor = useRef<{ fractionX: number; fractionY: number; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const photo = photos[current];

  // Measured when the window changes, not when the view does: zooming in adds
  // scrollbars, and re-fitting to the narrower view they leave would nudge the
  // photograph under the cursor on the first turn of the wheel.
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setFrame({ width: node.clientWidth, height: node.clientHeight });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  /**
   * 100% is the whole photograph on screen.
   *
   * It used to mean "as wide as the window", which put the bottom of every
   * portrait photograph below the fold at the one zoom that is supposed to show
   * all of it. Zooming scales up from the fitted size.
   */
  const fit =
    natural && frame && frame.width > 0 && frame.height > 0
      ? Math.min(frame.width / natural.width, frame.height / natural.height)
      : null;
  const shownWidth = natural && fit ? natural.width * fit * zoom : null;
  const shownHeight = natural && fit ? natural.height * fit * zoom : null;

  /**
   * Zoom, keeping one point of the photograph where it is on screen.
   *
   * The point under the cursor for the wheel and a double-click, the middle of
   * the view for the buttons and keys. Without it every zoom drifts the detail
   * being examined out of view, which is the thing zooming was for.
   */
  const zoomTo = useCallback((next: number, at?: { clientX: number; clientY: number }) => {
    const target = clampZoom(next);
    const node = viewport.current;
    const shown = image.current;
    if (node && shown && target !== zoomRef.current) {
      const view = node.getBoundingClientRect();
      const box = shown.getBoundingClientRect();
      const x = (at?.clientX ?? view.left + node.clientWidth / 2) - view.left;
      const y = (at?.clientY ?? view.top + node.clientHeight / 2) - view.top;
      anchor.current = {
        fractionX: box.width ? (view.left + x - box.left) / box.width : 0.5,
        fractionY: box.height ? (view.top + y - box.top) / box.height : 0.5,
        x,
        y,
      };
    }
    setZoom(target);
  }, []);

  useLayoutEffect(() => {
    const node = viewport.current;
    const point = anchor.current;
    anchor.current = null;
    if (!node || !point || shownWidth === null || shownHeight === null) return;
    // The image is centred while it is smaller than the view, so its offset
    // inside the scrolled content is whatever margin that centring leaves.
    const left = Math.max(0, (node.clientWidth - shownWidth) / 2);
    const top = Math.max(0, (node.clientHeight - shownHeight) / 2);
    node.scrollLeft = left + point.fractionX * shownWidth - point.x;
    node.scrollTop = top + point.fractionY * shownHeight - point.y;
  }, [zoom, shownWidth, shownHeight]);

  /**
   * The mouse wheel zooms, towards the cursor.
   *
   * Registered by hand because React attaches wheel listeners as passive, and a
   * passive listener cannot stop the page scrolling -- or, with a trackpad
   * pinch, the browser zooming the whole console -- underneath the photograph.
   */
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rate = event.deltaMode === 1 ? WHEEL_RATE_PER_LINE : WHEEL_RATE_PER_PIXEL;
      zoomTo(zoomRef.current * Math.exp(-event.deltaY * rate), event);
    }
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  /** Drag to move around a zoomed photograph, the way a map moves. */
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const node = viewport.current;
    if (!node || event.button !== 0 || zoomRef.current <= MIN_ZOOM) return;
    drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }
  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const node = viewport.current;
    const start = drag.current;
    if (!node || !start) return;
    node.scrollLeft = start.left - (event.clientX - start.x);
    node.scrollTop = start.top - (event.clientY - start.y);
  }
  function endDrag() {
    drag.current = null;
    setDragging(false);
  }

  // Each photograph is fetched once, at a size worth zooming into.
  useEffect(() => {
    if (!photo) return;
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null);
    setFailed(false);
    setNatural(null);
    setZoom(MIN_ZOOM);
    void apiBlob(`${photo.contentPath}?w=${VIEW_WIDTH}`)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [photo]);

  const step = useCallback(
    (delta: number) => setCurrent((at) => Math.min(photos.length - 1, Math.max(0, at + delta))),
    [photos.length],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') step(1);
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === '+' || event.key === '=') zoomTo(zoomRef.current + ZOOM_STEP);
      if (event.key === '-') zoomTo(zoomRef.current - ZOOM_STEP);
      if (event.key === '0') zoomTo(MIN_ZOOM);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, step, zoomTo]);

  if (!photo) return null;

  async function save() {
    setSaving(true);
    try {
      await download(photo, fileNameFor(photo, areaName, sideLabel));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      aria-label={`${areaName} ${sideLabel} photographs`}
      aria-modal
      className="bg-background/95 fixed inset-0 z-50 flex flex-col"
      role="dialog"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {areaName} · {sideLabel}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {[photo.label ?? 'Photograph', formatPhotoStamp(photo.capturedAt, photo.captureTimeSource)]
              .filter(Boolean)
              .join(' · ')}{' '}
            · {current + 1} of {photos.length}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground mr-2 hidden text-xs lg:inline">
            Scroll to zoom · drag to move · double-click to zoom in
          </span>
          <Button
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomTo(zoom - ZOOM_STEP)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ZoomOutIcon className="size-4" />
          </Button>
          <span className="text-muted-foreground w-12 text-center text-xs tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomTo(zoom + ZOOM_STEP)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ZoomInIcon className="size-4" />
          </Button>
          <Button disabled={saving} onClick={() => void save()} size="sm" type="button" variant="outline">
            {saving ? <Spinner /> : <DownloadIcon className="size-4" />}
            Download original
          </Button>
          <Button aria-label="Close" onClick={onClose} size="icon" type="button" variant="ghost">
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div
        className={`flex min-h-0 flex-1 overflow-auto select-none ${
          zoom > MIN_ZOOM ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''
        }`}
        data-testid="photo-viewport"
        onDoubleClick={(event) =>
          zoomTo(zoomRef.current > MIN_ZOOM ? MIN_ZOOM : DOUBLE_CLICK_ZOOM, event)
        }
        onPointerCancel={endDrag}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        ref={viewport}
      >
        {failed ? (
          <p className="text-muted-foreground m-4 text-sm">This photograph could not be loaded.</p>
        ) : objectUrl ? (
          /* A blob URL from the authenticated API; next/image cannot optimize it.
             `m-auto` centres it while it is smaller than the view and, unlike
             centring the flex line, never clips an edge once it is larger. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={`${photo.label ?? 'Photograph'} of ${areaName}`}
            className="m-auto max-w-none shrink-0"
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            ref={image}
            src={objectUrl}
            style={
              shownWidth !== null && shownHeight !== null
                ? { width: shownWidth, height: shownHeight }
                : { width: `${zoom * 100}%` }
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
      </div>

      {photos.length > 1 ? (
        <div className="flex items-center justify-between border-t px-4 py-2">
          <Button disabled={current === 0} onClick={() => step(-1)} size="sm" type="button" variant="outline">
            Previous
          </Button>
          <Button
            disabled={current === photos.length - 1}
            onClick={() => step(1)}
            size="sm"
            type="button"
            variant="outline"
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
