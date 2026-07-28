'use client';

import type { AreaPhoto } from '@texasrenters/shared';
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
  photo: AreaPhoto;
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
      // Start slightly early so scrolling feels instant without prefetching
      // the whole gallery.
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

  const alt = `${captureLabel(photo.captureType)} of ${areaName}${
    photo.label ? ` — ${photo.label}` : ''
  }`;

  return (
    <button
      ref={holder}
      type="button"
      className="area-photo"
      onClick={onOpen}
      aria-label={`Open ${alt}`}
    >
      {objectUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={objectUrl} alt={alt} loading="lazy" decoding="async" />
      ) : (
        <span className="area-photo-placeholder" aria-hidden>
          {error ? 'Unavailable' : ''}
        </span>
      )}
      <span className="area-photo-caption">
        {photo.label || captureLabel(photo.captureType)}
      </span>
    </button>
  );
}
