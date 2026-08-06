'use client';

import { ChevronLeft, ChevronRight, Download, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { apiBlob } from '@/lib/api';
import { RecordingSurface } from './RecordingSurface';

/** Controls sit on a near-black backdrop, where the themed surfaces vanish. */
const OVERLAY_CONTROL = 'border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white';

/**
 * One item in the full-screen viewer.
 *
 * Photos and recordings share it deliberately: a reviewer comparing a close-up
 * against the walkthrough should not have to learn two different surfaces, and
 * arrowing between them is the whole point.
 */
export type EvidenceViewerItem = {
  id: string;
  kind: 'photo' | 'recording';
  /** Authenticated API path — fetched as a blob, never set as a bare src. */
  contentPath: string;
  title: string;
  /** Second line: capture type, technician, timestamp. */
  caption?: string;
  /** Seek target in seconds, for opening a recording at a referenced finding. */
  startSeconds?: number | null;
  /** Poster frame, already a usable URL, for recordings only. */
  posterUrl?: string | null;
};

/**
 * Full-screen evidence viewer.
 *
 * Not a shadcn Dialog: this is edge-to-edge media on a near-opaque backdrop,
 * and Dialog's centred padded panel fights that. It keeps the parts that matter
 * — focus trapping via `autoFocus` on the close control, Escape to dismiss,
 * `role="dialog"` with `aria-modal` — without inheriting the card chrome.
 *
 * Media is fetched through `apiBlob` because every content endpoint requires a
 * bearer token; an `<img src>` or `<video src>` pointing at the API would 401.
 */
export function EvidenceViewer({
  items,
  startIndex,
  onClose,
}: {
  items: EvidenceViewerItem[];
  startIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped to re-run the fetch effect. `setIndex(current => current)` does not
  // re-render, so the obvious "retry" would have done nothing at all.
  const [attempt, setAttempt] = useState(0);

  const item = items[index];
  const count = items.length;

  const step = useCallback(
    (delta: number) => {
      // Wraps, so a reviewer at the last photo can keep pressing the same key
      // rather than reversing direction.
      setIndex((current) => (current + delta + count) % count);
    },
    [count],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll while a full-screen overlay is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, step]);

  useEffect(() => {
    if (!item) return;
    // Recordings are handled by RecordingSurface, which asks the API for a
    // signed Cloudflare URL instead of downloading the file. Fetching the blob
    // here as well would pull the whole video down for nothing.
    if (item.kind === 'recording') {
      setLoading(false);
      setError(null);
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    setLoading(true);
    setError(null);
    setObjectUrl(null);
    void apiBlob(item.contentPath)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'This evidence could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      // Revoked on move: a reviewer paging through fifty photos would otherwise
      // hold fifty full-resolution blobs in memory.
      if (created) URL.revokeObjectURL(created);
    };
  }, [item, attempt]);

  if (!item) return null;

  return (
    <div
      aria-label={`${item.title}, ${index + 1} of ${count}`}
      aria-modal
      className="fixed inset-0 z-50 flex flex-col"
      role="dialog"
    >
      {/* The backdrop is its own layer, deliberately not an ancestor of the
          media. `backdrop-filter` establishes a containing block, and Chrome
          renders a fullscreen element inside one as a black rectangle — the
          video kept playing, with audio and a moving timeline, and painted
          nothing. Keeping the blur on a sibling leaves the look intact and the
          media's ancestor chain free of filters. */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-black/95 backdrop-blur-sm" />
      <header className="flex items-start gap-3 px-4 py-3 text-white sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{item.title}</p>
          {item.caption ? (
            <p className="truncate text-xs text-white/60">{item.caption}</p>
          ) : null}
        </div>
        <span aria-hidden className="shrink-0 pt-1 text-xs tabular-nums text-white/60">
          {index + 1} / {count}
        </span>
        {objectUrl ? (
          <a
            className={`${buttonVariants({ variant: 'secondary', size: 'small' })} shrink-0 ${OVERLAY_CONTROL}`}
            download={`${item.title.replace(/[^\w.-]+/g, '-')}${
              item.kind === 'recording' ? '.mp4' : '.jpg'
            }`}
            href={objectUrl}
          >
            <Download aria-hidden className="size-4" />
            <span className="max-sm:sr-only">Download</span>
          </a>
        ) : null}
        <Button
          // Focused on open so Escape and Tab both behave, and a keyboard user
          // lands on the way out rather than inside the media.
          autoFocus
          aria-label="Close viewer"
          className={`shrink-0 ${OVERLAY_CONTROL}`}
          onClick={onClose}
          size="small"
          variant="secondary"
        >
          <X aria-hidden className="size-4" />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4 sm:px-14">
        {count > 1 ? (
          <Button
            aria-label="Previous evidence"
            className={`absolute left-1 top-1/2 z-10 -translate-y-1/2 sm:left-3 ${OVERLAY_CONTROL}`}
            onClick={() => step(-1)}
            size="small"
            variant="secondary"
          >
            <ChevronLeft aria-hidden className="size-5" />
          </Button>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-white/70">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Loading full resolution…
          </p>
        ) : error ? (
          <div className="max-w-sm text-center">
            <p className="text-sm text-white">{error}</p>
            <Button
              className={`mt-3 ${OVERLAY_CONTROL}`}
              onClick={() => setAttempt((value) => value + 1)}
              size="small"
              variant="secondary"
            >
              Retry
            </Button>
          </div>
        ) : item.kind === 'recording' ? (
          <div className="flex w-full max-w-4xl items-center justify-center">
            <RecordingSurface
              mediaId={item.id}
              posterUrl={item.posterUrl}
              startSeconds={item.startSeconds}
              title={item.title}
            />
          </div>
        ) : objectUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={item.title}
            className="max-h-full max-w-full rounded-lg object-contain"
            src={objectUrl}
          />
        ) : null}

        {count > 1 ? (
          <Button
            aria-label="Next evidence"
            className={`absolute right-1 top-1/2 z-10 -translate-y-1/2 sm:right-3 ${OVERLAY_CONTROL}`}
            onClick={() => step(1)}
            size="small"
            variant="secondary"
          >
            <ChevronRight aria-hidden className="size-5" />
          </Button>
        ) : null}
      </div>

      {count > 1 ? (
        <p className="pb-3 text-center text-xs text-white/40">
          Use the arrow keys to move between evidence · Esc to close
        </p>
      ) : null}
    </div>
  );
}
