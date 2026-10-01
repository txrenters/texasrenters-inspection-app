'use client';

import type { PhotoCaptureTimeSource } from '@texasrenters/shared';
import { ChevronLeft, ChevronRight, Download, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PhotoStamp } from '@/components/photo-stamp';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { fitWithin, type Size } from './area-photos';
import { cachedPhoto, loadPhoto, preloadPhoto } from './photo-cache';
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
  /** A photograph's capture time and what it rests on, drawn on the photo. */
  capturedAt?: string | null;
  captureTimeSource?: PhotoCaptureTimeSource | null;
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
 *
 * It shows one area's items. Walking on into the next area is the caller's
 * job (`AreaPhotoViewer`), through `onBeyond` and `onArea`; without them it
 * wraps round within the area, as it always has.
 */
export function EvidenceViewer({
  items,
  startIndex,
  onClose,
  heading,
  position,
  notice,
  beyond,
  edges,
  onBeyond,
  onArea,
}: {
  items: EvidenceViewerItem[];
  startIndex: number;
  onClose: () => void;
  /** Leads each title: the area, when the viewer walks more than one. */
  heading?: string;
  /** Where the area sits among the others, such as "Area 3 of 18". */
  position?: string;
  /** A passing message, such as the area just arrived in. Announced as well as shown. */
  notice?: string | null;
  /**
   * Which ways `onBeyond` has somewhere to go, so an area with a single
   * photograph still shows the arrows that lead out of it.
   */
  beyond?: { previous: boolean; next: boolean };
  /**
   * The photographs just past either end -- the previous area's last and the
   * next area's first -- fetched ahead like any other neighbour.
   */
  edges?: { previous?: string | null; next?: string | null };
  /** Past either end: on into the neighbouring area, instead of wrapping round. */
  onBeyond?: (direction: 1 | -1) => void;
  /** ↑ and ↓: straight to the previous or next area. */
  onArea?: (direction: 1 | -1) => void;
}) {
  const [index, setIndex] = useState(startIndex);
  // Bumped when a photograph arrives. The bytes live in the photo cache, which
  // is what lets a photograph seen a moment ago come back without a request.
  const [, setArrivals] = useState(0);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  // Bumped to re-run the fetch effect. `setIndex(current => current)` does not
  // re-render, so the obvious "retry" would have done nothing at all.
  const [attempt, setAttempt] = useState(0);
  /** Where the photograph is shown, measured so it can be sized to fit. */
  const stage = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  const [natural, setNatural] = useState<(Size & { url: string }) | null>(null);

  const item = items[index];
  const count = items.length;
  const photoPath = item?.kind === 'photo' ? item.contentPath : null;
  const objectUrl = photoPath ? cachedPhoto(photoPath) : null;
  const error = failure && failure.path === photoPath ? failure.message : null;
  const loading = photoPath !== null && !objectUrl && !error;
  const canPrevious = index > 0 || (onBeyond ? Boolean(beyond?.previous) : count > 1);
  const canNext = index < count - 1 || (onBeyond ? Boolean(beyond?.next) : count > 1);
  const fitted =
    objectUrl && natural?.url === objectUrl && frame ? fitWithin(natural, frame) : null;

  const step = useCallback(
    (delta: 1 | -1) => {
      const next = index + delta;
      if (next >= 0 && next < count) setIndex(next);
      // Past an end: on into the neighbouring area when the caller walks more
      // than one. Wrapping instead is what took a reviewer at the last
      // living-room photograph back to the living-room video, not on to the
      // kitchen. Within a single area it still wraps, so the same key keeps
      // going rather than reversing.
      else if (onBeyond) onBeyond(delta);
      else if (count > 1) setIndex((next + count) % count);
    },
    [count, index, onBeyond],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
      else if (onArea && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        onArea(event.key === 'ArrowDown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onArea, onClose, step]);

  useEffect(() => {
    // The page behind must not scroll while a full-screen overlay is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Recordings are handled by RecordingSurface, which asks the API for a signed
  // Cloudflare URL instead of downloading the file. Fetching the blob here as
  // well would pull the whole video down for nothing.
  useEffect(() => {
    if (!photoPath) return;
    let cancelled = false;
    // Asked even when it is already here: that marks it as in use, so the
    // cache never evicts the photograph on screen.
    loadPhoto(photoPath).then(
      () => {
        if (!cancelled) setArrivals((value) => value + 1);
      },
      (cause: unknown) => {
        if (!cancelled)
          setFailure({
            path: photoPath,
            message: cause instanceof Error ? cause.message : 'This evidence could not be loaded.',
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [photoPath, attempt]);

  // Once this one is on screen, the photographs either side of it -- across an
  // area boundary too -- so stepping on is instant rather than another round
  // trip. Not before: they would share the line with the one being waited for.
  const ahead = index + 1 < count ? items[index + 1] : null;
  const behind = index > 0 ? items[index - 1] : null;
  const aheadPath = ahead ? (ahead.kind === 'photo' ? ahead.contentPath : null) : edges?.next;
  const behindPath = behind ? (behind.kind === 'photo' ? behind.contentPath : null) : edges?.previous;
  const settled = !photoPath || Boolean(objectUrl);
  useEffect(() => {
    if (!settled) return;
    if (aheadPath) preloadPhoto(aheadPath);
    if (behindPath) preloadPhoto(behindPath);
  }, [aheadPath, behindPath, settled]);

  const present = Boolean(item);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => setFrame({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [present]);

  if (!item) return null;

  return (
    <div
      aria-label={`${heading ? `${heading}, ` : ''}${item.title}, ${index + 1} of ${count}`}
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
          {/* The area first when the viewer walks several: crossing into the
              kitchen has to be unmissable, and "Area overview" alone says
              nothing about which one. */}
          <p className="truncate text-sm font-semibold">
            {heading ? `${heading} · ${item.title}` : item.title}
          </p>
          {position ? (
            <p className="truncate text-xs text-white/80">
              Photo {index + 1} of {count} · {position}
            </p>
          ) : null}
          {item.caption ? (
            <p className="truncate text-xs text-white/60">{item.caption}</p>
          ) : null}
        </div>
        {position ? null : (
          <span aria-hidden className="shrink-0 pt-1 text-xs tabular-nums text-white/60">
            {index + 1} / {count}
          </span>
        )}
        {objectUrl ? (
          <a
            className={`${buttonVariants({ variant: 'outline', size: 'sm' })} shrink-0 ${OVERLAY_CONTROL}`}
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
          size="sm"
          variant="outline"
        >
          <X aria-hidden className="size-4" />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4 sm:px-14">
        {/* Shown for a moment and announced, so arriving in another area is
            noticed by everyone, not only by someone watching the title. */}
        <p aria-live="polite" className="sr-only">
          {notice ?? ''}
        </p>
        {notice ? (
          <p
            aria-hidden
            className="pointer-events-none absolute top-1 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1 text-xs font-medium whitespace-nowrap text-black"
          >
            {notice}
          </p>
        ) : null}

        {canPrevious ? (
          <Button
            aria-label="Previous evidence"
            className={`absolute left-1 top-1/2 z-10 -translate-y-1/2 sm:left-3 ${OVERLAY_CONTROL}`}
            onClick={() => step(-1)}
            size="sm"
            variant="outline"
          >
            <ChevronLeft aria-hidden className="size-5" />
          </Button>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch" ref={stage}>
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
                onClick={() => {
                  setFailure(null);
                  setAttempt((value) => value + 1);
                }}
                size="sm"
                variant="outline"
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
            // Sized to the photograph itself once its pixels are known, so the
            // capture time drawn over it sits on the picture, not beside it.
            <span
              className={cn('relative inline-flex shrink-0', !fitted && 'max-h-full max-w-full')}
              style={fitted ?? undefined}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={item.title}
                className={cn(
                  'rounded-lg object-contain',
                  fitted ? 'size-full' : 'max-h-full max-w-full',
                )}
                onLoad={(event) =>
                  setNatural({
                    url: objectUrl,
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                src={objectUrl}
              />
              {fitted ? (
                <PhotoStamp capturedAt={item.capturedAt} size="md" source={item.captureTimeSource} />
              ) : null}
            </span>
          ) : null}
        </div>

        {canNext ? (
          <Button
            aria-label="Next evidence"
            className={`absolute right-1 top-1/2 z-10 -translate-y-1/2 sm:right-3 ${OVERLAY_CONTROL}`}
            onClick={() => step(1)}
            size="sm"
            variant="outline"
          >
            <ChevronRight aria-hidden className="size-5" />
          </Button>
        ) : null}
      </div>

      {onArea ? (
        <p className="pb-3 text-center text-xs text-white/40">
          ← → photos · ↑ ↓ previous or next area · Esc to close
        </p>
      ) : count > 1 ? (
        <p className="pb-3 text-center text-xs text-white/40">
          Use the arrow keys to move between evidence · Esc to close
        </p>
      ) : null}
    </div>
  );
}
