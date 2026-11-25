'use client';

import type { PhotoCaptureTimeSource } from '@texasrenters/shared';
import { SparklesIcon, ZoomInIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { PhotoStamp } from '@/components/photo-stamp';

import { cachedThumbnail, loadThumbnail } from './photo-cache';

/*
 * Gallery width: `THUMBNAIL_WIDTH` (320) in the photo cache. The endpoint caches
 * this variant beside the original, so the expensive re-encode happens once per
 * photo rather than once per view, and the cache keeps it for the viewer's strip.
 *
 * The previous gallery fetched each photo's **full-resolution original** on
 * mount, for every photo at once, proxied through the API — hundreds of
 * megabytes for a photo-heavy inspection before anything appeared.
 */

const CAPTURE_LABELS: Record<string, string> = {
  AREA_OVERVIEW: 'Area overview',
  WALL_OVERVIEW: 'Wall overview',
  FINDING_CONTEXT: 'Finding context',
  FINDING_CLOSE_UP: 'Finding close-up',
  FINDING_DETAIL: 'Finding close-up',
  SUPPORTING_ANGLE: 'Supporting angle',
  SUPPORTING_EVIDENCE: 'Supporting',
  SCALE_REFERENCE: 'Scale reference',
  SERIAL_OR_LABEL: 'Serial or label',
  VIDEO_FRAME_SNAPSHOT: 'Video snapshot',
  OTHER: 'Photo',
};

export function captureLabel(captureType: string) {
  return CAPTURE_LABELS[captureType] ?? 'Photo';
}

/**
 * A thumbnail that fetches nothing until it is close to the viewport, and only
 * ever fetches the bounded variant. Full resolution is the viewer's job.
 */
export function LazyPhoto({
  photo,
  areaName,
  onOpen,
  compact = false,
}: {
  /*
   * Only what this actually renders, rather than a whole `AreaPhoto`.
   *
   * The comparison report carries report-shaped photographs, which have no
   * `sequenceNumber` or `capturedByName` and no capture type -- their caption is
   * the checklist item they evidence. Widening the payload to satisfy a type
   * this component never reads would put three dead fields on every photo in a
   * document that can carry hundreds.
   */
  photo: {
    contentPath: string;
    captureType?: string | null;
    label?: string | null;
    capturedAt?: string | null;
    captureTimeSource?: PhotoCaptureTimeSource | null;
    /** Filed by the AI from the video check; marked so nobody takes it for a person's pick. */
    filedByAi?: boolean;
  };
  areaName: string;
  onOpen?: () => void;
  /**
   * A small tile, for the photo sheet: no caption under it and no capture time
   * over it. At that size the time is cut to "Received …", and every occupied
   * photograph's caption would read "Area overview" again. Both stay where
   * they can be read: the button's name, and the viewer.
   */
  compact?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(() => cachedThumbnail(photo.contentPath));
  const [error, setError] = useState(false);
  const holder = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const node = holder.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      // Start slightly early so scrolling feels instant without prefetching the
      // whole gallery.
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  // Through the shared thumbnail cache, which owns the object URL: the
  // viewer's strip shows this same thumbnail without asking for it again.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    loadThumbnail(photo.contentPath).then(
      (url) => {
        if (!cancelled) setObjectUrl(url);
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, photo.contentPath]);

  const alt = `${captureLabel(photo.captureType ?? 'OTHER')} of ${areaName}${
    photo.label ? ` - ${photo.label}` : ''
  }${photo.filedByAi ? ', added by AI' : ''}`;

  return (
    <button
      aria-label={`Open ${alt}`}
      className="group focus-visible:ring-ring/50 grid cursor-zoom-in gap-1 text-left focus-visible:ring-[3px] focus-visible:outline-none"
      onClick={onOpen}
      ref={holder}
      type="button"
    >
      <span className="bg-muted relative block aspect-square overflow-hidden rounded-lg border">
        {objectUrl && !compact ? (
          <PhotoStamp capturedAt={photo.capturedAt} source={photo.captureTimeSource} />
        ) : null}
        {photo.filedByAi ? (
          <span
            className="pointer-events-none absolute top-1.5 left-1.5 z-10 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] leading-tight font-medium text-white"
            data-testid="added-by-ai"
          >
            <SparklesIcon aria-hidden className="size-3" />
            {compact ? 'AI' : 'Added by AI'}
          </span>
        ) : null}
        {objectUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={alt}
            className="size-full object-cover transition-transform group-hover:scale-105"
            decoding="async"
            loading="lazy"
            src={objectUrl}
          />
        ) : (
          <span
            aria-hidden
            className="text-muted-foreground grid size-full place-content-center text-xs"
          >
            {error ? 'Unavailable' : ''}
          </span>
        )}
        {/* A magnifier under the pointer: this opens the viewer (the Where board). */}
        {objectUrl && onOpen ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 grid place-content-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <ZoomInIcon className="size-6" />
          </span>
        ) : null}
      </span>
      {!compact ? (
        <span className="text-muted-foreground truncate text-xs">
          {photo.label || captureLabel(photo.captureType ?? 'OTHER')}
        </span>
      ) : null}
    </button>
  );
}
