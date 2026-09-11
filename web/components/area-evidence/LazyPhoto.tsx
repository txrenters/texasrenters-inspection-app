'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBlob } from '@/lib/api';

/**
 * Gallery width. The endpoint caches this variant beside the original, so the
 * expensive re-encode happens once per photo rather than once per view.
 *
 * The previous gallery fetched each photo's **full-resolution original** on
 * mount, for every photo at once, proxied through the API — hundreds of
 * megabytes for a photo-heavy inspection before anything appeared.
 */
const GALLERY_WIDTH = 320;

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
  photo: { contentPath: string; captureType?: string | null; label?: string | null };
  areaName: string;
  onOpen?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
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

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let created: string | null = null;
    void apiBlob(`${photo.contentPath}?w=${GALLERY_WIDTH}`)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [visible, photo.contentPath]);

  const alt = `${captureLabel(photo.captureType ?? 'OTHER')} of ${areaName}${
    photo.label ? ` - ${photo.label}` : ''
  }`;

  return (
    <button
      aria-label={`Open ${alt}`}
      className="group focus-visible:ring-ring/50 grid gap-1 text-left focus-visible:ring-[3px] focus-visible:outline-none"
      onClick={onOpen}
      ref={holder}
      type="button"
    >
      <span className="bg-muted block aspect-square overflow-hidden rounded-lg border">
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
      </span>
      <span className="text-muted-foreground truncate text-xs">
        {photo.label || captureLabel(photo.captureType ?? 'OTHER')}
      </span>
    </button>
  );
}
