'use client';

import type { PublicReportPhoto } from '@texasrenters/shared';
import { DownloadIcon, XIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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

  const photo = photos[current];

  // Each photograph is fetched once, at a size worth zooming into.
  useEffect(() => {
    if (!photo) return;
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null);
    setFailed(false);
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
      if (event.key === '+' || event.key === '=') setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
      if (event.key === '-') setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
      if (event.key === '0') setZoom(MIN_ZOOM);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, step]);

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
            {photo.label ?? 'Photograph'} · {current + 1} of {photos.length}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
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
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
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

      <div className="flex-1 overflow-auto p-4">
        {failed ? (
          <p className="text-muted-foreground text-sm">This photograph could not be loaded.</p>
        ) : objectUrl ? (
          /* A blob URL from the authenticated API; next/image cannot optimize it. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={`${photo.label ?? 'Photograph'} of ${areaName}`}
            className="mx-auto origin-top"
            src={objectUrl}
            style={{ width: `${zoom * 100}%`, maxWidth: zoom === MIN_ZOOM ? '100%' : 'none' }}
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
