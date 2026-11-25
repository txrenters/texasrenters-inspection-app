'use client';

import type { PhotoCaptureTimeSource } from '@texasrenters/shared';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOffIcon,
  Loader2,
  Maximize,
  PanelRightIcon,
  PlayIcon,
  RotateCcw,
  RotateCw,
  X,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { toast } from 'sonner';

import { PhotoStamp } from '@/components/photo-stamp';
import { businessDayOf, photoFileName } from '@/lib/photo-file-name';
import { cn } from '@/lib/utils';

import { fitWithin, type Size } from './area-photos';
import { cachedPhoto, cachedThumbnail, loadPhoto, loadThumbnail, preloadPhoto } from './photo-cache';
import { RecordingDownloadButton } from './RecordingDownloadButton';
import { RecordingSurface } from './RecordingSurface';

/** Controls on the viewer's navy, where the page's themed surfaces vanish. */
const CONTROL =
  'inline-flex items-center justify-center rounded-lg text-viewer-foreground transition-colors hover:bg-viewer-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-accent disabled:pointer-events-none disabled:opacity-35';
/** The header's outlined buttons: the review panel. */
const OUTLINED =
  'inline-flex h-10 items-center gap-2 rounded-lg border border-viewer-foreground/25 px-3 text-sm font-semibold text-viewer-foreground hover:bg-viewer-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-accent';

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
/** Where the buttons and + / - stop: Fit, then the steps the canvas drew. */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];
/** Where a double-click takes a photograph that is not zoomed in yet. */
const DOUBLE_CLICK_ZOOM = 2;
/**
 * Past this, a photograph shown from its smaller copy is fetched full size, so
 * a printed filter size stays sharp. Room photographs are shown full size from
 * the start and never need it.
 */
const FULL_SIZE_FROM = 2;
/** How far a finger travels sideways, on a photograph that is not zoomed, to step on. */
const SWIPE_DISTANCE = 60;
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
/** The next step above or below where the zoom is, which after the wheel may be between two. */
const stepUp = (zoom: number) => ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? MAX_ZOOM;
const stepDown = (zoom: number) =>
  [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? MIN_ZOOM;
/** "Fit" for the whole photograph, a percentage past it. */
export const zoomLabel = (zoom: number) => (zoom <= MIN_ZOOM ? 'Fit' : `${Math.round(zoom * 100)}%`);
/** Quarter turns, kept between 0 and 3 however many times the buttons are pressed. */
const normalTurns = (turns: number) => ((turns % 4) + 4) % 4;

/**
 * The downloaded file's name: the property, the area, what the photograph is
 * of, and the Texas day it was taken (or, without a capture time, the day the
 * caller gives). See `lib/photo-file-name.ts`.
 */
function fileNameFor(item: EvidenceViewerItem, heading: string | undefined, place: string | null | undefined) {
  const day = businessDayOf(item.capturedAt) ?? item.day ?? null;
  return photoFileName([place, heading, item.title, day], item.kind === 'recording' ? 'mp4' : 'jpg');
}

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
  /**
   * Authenticated API path -- fetched as a blob, never set as a bare src. For
   * a photograph this is the full-size original: what Download saves.
   */
  contentPath: string;
  /**
   * A smaller copy to show first, for a photograph whose original is heavy and
   * rarely needed whole: a job photograph opens at 1,600 pixels and fetches the
   * original only past 200% or for Download. Room photographs have none.
   */
  previewPath?: string | null;
  title: string;
  /** Read beside the title: "20x25x1 · upstairs hallway". */
  detail?: string | null;
  /** Second line: capture type, technician, timestamp. */
  caption?: string;
  /** Seek target in seconds, for opening a recording at a referenced finding. */
  startSeconds?: number | null;
  /** Poster frame, already a usable URL, for recordings only. */
  posterUrl?: string | null;
  /** A photograph's capture time and what it rests on, drawn on the photo. */
  capturedAt?: string | null;
  captureTimeSource?: PhotoCaptureTimeSource | null;
  /** The Texas day for the file name when there is no capture time, `yyyy-MM-dd`. */
  day?: string | null;
};

/** What the viewer first shows of a photograph. */
const shownPath = (item: EvidenceViewerItem | null | undefined) =>
  item?.kind === 'photo' ? (item.previewPath ?? item.contentPath) : null;

/** One photograph in the strip along the bottom: the page's own thumbnail, fetched once for both. */
function StripTile({
  item,
  label,
  selected,
  onPick,
}: {
  item: EvidenceViewerItem;
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  const [url, setUrl] = useState(() => (item.kind === 'photo' ? cachedThumbnail(item.contentPath) : null));
  useEffect(() => {
    if (item.kind !== 'photo' || url) return;
    let cancelled = false;
    loadThumbnail(item.contentPath).then(
      (loaded) => {
        if (!cancelled) setUrl(loaded);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [item.contentPath, item.kind, url]);
  const picture = item.kind === 'recording' ? (item.posterUrl ?? null) : url;
  return (
    <button
      aria-current={selected ? 'true' : undefined}
      aria-label={label}
      className={cn(
        'bg-viewer-raised relative h-[57px] w-[76px] shrink-0 overflow-hidden rounded-md border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-accent',
        selected ? 'border-viewer-accent' : 'border-transparent hover:border-viewer-foreground/40',
      )}
      onClick={onPick}
      type="button"
    >
      {picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" className="size-full object-cover" draggable={false} src={picture} />
      ) : null}
      {item.kind === 'recording' ? (
        <span aria-hidden className="absolute inset-0 grid place-content-center bg-black/30 text-white">
          <PlayIcon className="size-5" />
        </span>
      ) : null}
    </button>
  );
}

/**
 * Full-screen evidence viewer, and the console's only one.
 *
 * Every photograph the console opens comes here: a room's photographs on an
 * inspection, the comparison page's, and (since 2026-11-26) a visit's job
 * photographs -- the filters, pest control, flea treatment and whatever service
 * joins them. The office asked for one viewer that zooms, turns and downloads
 * (approved on the canvas: Viewer, Rooms, States and Phone boards).
 *
 * Not a shadcn Dialog: this is edge-to-edge media on a near-opaque backdrop,
 * and Dialog's centred padded panel fights that. It keeps the parts that matter
 * — focus trapping via `autoFocus` on the close control, Escape to dismiss,
 * `role="dialog"` with `aria-modal` — without inheriting the card chrome.
 *
 * Media is fetched through `apiBlob` because every content endpoint requires a
 * bearer token; an `<img src>` or `<video src>` pointing at the API would 401.
 *
 * A photograph can be read closely: the wheel zooms towards the cursor, a
 * double-click zooms in on the spot, a zoomed photograph drags like a map,
 * a pinch zooms on a phone, and + / - / 0 step it. It can be turned a quarter
 * at a time (R, Shift+R), for this viewer only: nothing is saved, so the next
 * person, the report and the AI see the photograph as it was taken. Download
 * saves that original, named for the property, the work or room, and the day.
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
  aside,
  place,
  turns,
  onTurn,
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
  /**
   * A panel beside the media -- the area's review, in `AreaPhotoViewer`.
   * Open and closed by the caller, so the choice survives walking into the
   * next area, which mounts a fresh viewer.
   */
  aside?: { content: ReactNode; open: boolean; onToggle: () => void };
  /** The property, leading a downloaded file's name: "2210 Cedar Bend Dr Unit B". */
  place?: string | null;
  /**
   * Each photograph's quarter turns, held by a caller that mounts a fresh
   * viewer per area, so a turn stays while the walk goes on. Without it the
   * viewer keeps its own until it closes.
   */
  turns?: Record<string, number>;
  onTurn?: (id: string, turns: number) => void;
}) {
  const [index, setIndex] = useState(startIndex);
  // Bumped when a photograph arrives. The bytes live in the photo cache, which
  // is what lets a photograph seen a moment ago come back without a request.
  const [, setArrivals] = useState(0);
  const [failure, setFailure] = useState<{ path: string } | null>(null);
  const [originalFailed, setOriginalFailed] = useState<string | null>(null);
  // Bumped to re-run the fetch effect. `setIndex(current => current)` does not
  // re-render, so the obvious "retry" would have done nothing at all.
  const [attempt, setAttempt] = useState(0);
  const [ownTurns, setOwnTurns] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  /** Where the photograph is shown, measured so it can be sized to fit, and scrolled once zoomed. */
  const stage = useRef<HTMLDivElement | null>(null);
  /** The photograph's box on screen: turned, it is the turned shape. */
  const picture = useRef<HTMLSpanElement | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  /** The photograph's own pixels, by item: its small copy and its original share a shape. */
  const [natural, setNatural] = useState<(Size & { id: string }) | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The point of the photograph to keep under the cursor while the zoom changes. */
  const anchor = useRef<{ fractionX: number; fractionY: number; x: number; y: number } | null>(
    null,
  );
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The fingers on the photograph, for a pinch, and where a swipe began. */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const item = items[index];
  const count = items.length;
  const firstPath = shownPath(item);
  const originalPath = item?.kind === 'photo' ? item.contentPath : null;
  const hasSmallerCopy = Boolean(firstPath && originalPath && firstPath !== originalPath);
  const wantOriginal = hasSmallerCopy && zoom > FULL_SIZE_FROM;
  const original = originalPath ? cachedPhoto(originalPath) : null;
  const objectUrl = original ?? (firstPath ? cachedPhoto(firstPath) : null);
  const failed = Boolean(failure && failure.path === firstPath) && !objectUrl;
  const loading = firstPath !== null && !objectUrl && !failed;
  const loadingOriginal = wantOriginal && !original && originalFailed !== originalPath;
  const canPrevious = index > 0 || (onBeyond ? Boolean(beyond?.previous) : count > 1);
  const canNext = index < count - 1 || (onBeyond ? Boolean(beyond?.next) : count > 1);
  const turnMap = turns ?? ownTurns;
  const quarter = item ? normalTurns(turnMap[item.id] ?? 0) : 0;
  const sideways = quarter % 2 === 1;
  // 100% is the whole photograph on screen, the way it is turned; zooming scales up from that.
  const fitted =
    objectUrl && natural?.id === item?.id && frame
      ? fitWithin(sideways ? { width: natural.height, height: natural.width } : natural, frame)
      : null;
  const shown = fitted
    ? { width: Math.round(fitted.width * zoom), height: Math.round(fitted.height * zoom) }
    : null;
  const zoomable = Boolean(firstPath && objectUrl);
  const walksAreas = Boolean(onArea);

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

  const turn = useCallback(
    (delta: 1 | -1) => {
      if (!item) return;
      const next = normalTurns((turnMap[item.id] ?? 0) + delta);
      if (onTurn) onTurn(item.id, next);
      else setOwnTurns((current) => ({ ...current, [item.id]: next }));
    },
    [item, onTurn, turnMap],
  );

  /**
   * Zoom, keeping one point of the photograph where it is on screen.
   *
   * The point under the cursor for the wheel, a double-click and a pinch, the
   * middle of the view for the buttons and keys. Without it every zoom drifts
   * the detail being examined out of view, which is the thing zooming was for.
   */
  const zoomTo = useCallback((next: number, at?: { clientX: number; clientY: number }) => {
    const target = clampZoom(next);
    const node = stage.current;
    const box = picture.current;
    if (node && box && target !== zoomRef.current) {
      const view = node.getBoundingClientRect();
      const rect = box.getBoundingClientRect();
      const x = (at?.clientX ?? view.left + node.clientWidth / 2) - view.left;
      const y = (at?.clientY ?? view.top + node.clientHeight / 2) - view.top;
      anchor.current = {
        fractionX: rect.width ? (view.left + x - rect.left) / rect.width : 0.5,
        fractionY: rect.height ? (view.top + y - rect.top) / rect.height : 0.5,
        x,
        y,
      };
    }
    setZoom(target);
  }, []);

  useLayoutEffect(() => {
    const node = stage.current;
    const point = anchor.current;
    anchor.current = null;
    if (!node || !point || !shown) return;
    // The photograph is centred while it is smaller than the view, so its
    // offset inside the scrolled content is whatever margin that leaves.
    const left = Math.max(0, (node.clientWidth - shown.width) / 2);
    const top = Math.max(0, (node.clientHeight - shown.height) / 2);
    node.scrollLeft = left + point.fractionX * shown.width - point.x;
    node.scrollTop = top + point.fractionY * shown.height - point.y;
  }, [zoom, shown?.width, shown?.height]);

  // Every photograph starts whole. A turn it was given stays with it.
  const itemId = item?.id;
  useEffect(() => {
    setZoom(MIN_ZOOM);
  }, [itemId]);

  // This listener and the wheel's below are layout effects, so each is in
  // place in the same commit as the photograph it acts on. As passive effects
  // they could land a frame later on a busy machine, and a key or wheel turn
  // in that frame did nothing -- or scrolled the page under the viewer.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Typing a rejection reason in the review panel: the arrows move the
      // caret, and Escape must not throw the half-written reason away.
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? ''))
        return;
      // Ctrl+R still reloads, Ctrl+- still zooms the console.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
      else if (onArea && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        onArea(event.key === 'ArrowDown' ? 1 : -1);
      } else if (zoomable && (event.key === '+' || event.key === '='))
        zoomTo(stepUp(zoomRef.current));
      else if (zoomable && event.key === '-') zoomTo(stepDown(zoomRef.current));
      else if (zoomable && event.key === '0') zoomTo(MIN_ZOOM);
      else if (zoomable && event.key.toLowerCase() === 'r') turn(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onArea, onClose, step, turn, zoomTo, zoomable]);

  useEffect(() => {
    // The page behind must not scroll while a full-screen overlay is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  /**
   * The mouse wheel zooms, towards the cursor.
   *
   * Registered by hand because React attaches wheel listeners as passive, and a
   * passive listener cannot stop the page scrolling -- or, with a trackpad
   * pinch, the browser zooming the whole console -- underneath the photograph.
   */
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node || !zoomable) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rate = event.deltaMode === 1 ? WHEEL_RATE_PER_LINE : WHEEL_RATE_PER_PIXEL;
      zoomTo(zoomRef.current * Math.exp(-event.deltaY * rate), event);
    }
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomTo, zoomable]);

  /**
   * The pointer on the photograph: a mouse drags a zoomed photograph the way a
   * map moves; a finger does the same, two fingers pinch, and a sideways swipe
   * on a photograph that is not zoomed steps on (the Phone board).
   */
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const node = stage.current;
    if (!node || event.button !== 0) return;
    const finger = event.pointerType === 'touch' || event.pointerType === 'pen';
    if (finger) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: zoomRef.current };
        drag.current = null;
        swipe.current = null;
        setDragging(false);
        return;
      }
      if (zoomRef.current <= MIN_ZOOM) {
        swipe.current = { x: event.clientX, y: event.clientY };
        return;
      }
    } else if (zoomRef.current <= MIN_ZOOM) return;
    drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const node = stage.current;
    if (!node) return;
    if (touches.current.has(event.pointerId))
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      zoomTo(pinch.current.zoom * (distance / pinch.current.distance), {
        clientX: (a.x + b.x) / 2,
        clientY: (a.y + b.y) / 2,
      });
      return;
    }
    const start = drag.current;
    if (!start) return;
    node.scrollLeft = start.left - (event.clientX - start.x);
    node.scrollTop = start.top - (event.clientY - start.y);
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const began = swipe.current;
    touches.current.delete(event.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    swipe.current = null;
    if (began && zoomRef.current <= MIN_ZOOM) {
      const dx = event.clientX - began.x;
      const dy = event.clientY - began.y;
      if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    }
    drag.current = null;
    setDragging(false);
  }

  // Recordings are handled by RecordingSurface, which asks the API for a signed
  // Cloudflare URL instead of downloading the file. Fetching the blob here as
  // well would pull the whole video down for nothing.
  useEffect(() => {
    if (!firstPath) return;
    let cancelled = false;
    // Asked even when it is already here: that marks it as in use, so the
    // cache never evicts the photograph on screen.
    loadPhoto(firstPath).then(
      () => {
        if (!cancelled) setArrivals((value) => value + 1);
      },
      () => {
        if (!cancelled) setFailure({ path: firstPath });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [firstPath, attempt]);

  // Past 200% on a photograph shown from its smaller copy: the original, once.
  // The copy stays on screen meanwhile; if the original never comes, it stays.
  useEffect(() => {
    if (!wantOriginal || !originalPath) return;
    let cancelled = false;
    loadPhoto(originalPath).then(
      () => {
        if (!cancelled) setArrivals((value) => value + 1);
      },
      () => {
        if (!cancelled) setOriginalFailed(originalPath);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [originalPath, wantOriginal]);

  // Once this one is on screen, the photographs either side of it -- across an
  // area boundary too -- so stepping on is instant rather than another round
  // trip. Not before: they would share the line with the one being waited for.
  const ahead = index + 1 < count ? items[index + 1] : null;
  const behind = index > 0 ? items[index - 1] : null;
  const aheadPath = ahead ? shownPath(ahead) : edges?.next;
  const behindPath = behind ? shownPath(behind) : edges?.previous;
  const settled = !firstPath || Boolean(objectUrl);
  useEffect(() => {
    if (!settled) return;
    if (aheadPath) preloadPhoto(aheadPath);
    if (behindPath) preloadPhoto(behindPath);
  }, [aheadPath, behindPath, settled]);

  /**
   * The space the photograph is shown in.
   *
   * Its border box, not its client box: zooming in adds scrollbars, and
   * re-fitting to the narrower view they leave would nudge the photograph under
   * the cursor on the first turn of the wheel.
   */
  const present = Boolean(item);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => {
      const box = node.getBoundingClientRect();
      setFrame({ width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [present]);

  /** The original, as the technician took it, saved under a name that says what it is. */
  async function download() {
    if (!item || item.kind !== 'photo' || saving) return;
    const name = fileNameFor(item, heading, place);
    setSaving(true);
    try {
      const url = await loadPhoto(item.contentPath);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      toast.success(`Saved ${name}`);
    } catch {
      toast.error('The photo could not be downloaded.');
    } finally {
      setSaving(false);
    }
  }

  if (!item) return null;

  const counter = `${index + 1} of ${count}`;
  const photoItem = item.kind === 'photo';
  const toolbar = photoItem ? (
    <div
      aria-label="Photo tools"
      className="bg-viewer-raised flex items-center gap-0.5 rounded-xl px-2 py-1 max-sm:w-full max-sm:max-w-sm max-sm:justify-between"
      role="toolbar"
    >
      <button
        aria-label="Zoom out"
        className={cn(CONTROL, 'size-11')}
        disabled={!zoomable || zoom <= MIN_ZOOM}
        onClick={() => zoomTo(stepDown(zoom))}
        type="button"
      >
        <ZoomOutIcon aria-hidden className="size-5" />
      </button>
      <span
        aria-live="polite"
        className="text-viewer-foreground min-w-14 text-center text-sm font-semibold tabular-nums"
        data-testid="zoom-level"
      >
        {zoomLabel(zoom)}
      </span>
      <button
        aria-label="Zoom in"
        className={cn(CONTROL, 'size-11')}
        disabled={!zoomable || zoom >= MAX_ZOOM}
        onClick={() => zoomTo(stepUp(zoom))}
        type="button"
      >
        <ZoomInIcon aria-hidden className="size-5" />
      </button>
      <button
        aria-label="Fit the whole photo"
        className={cn(CONTROL, 'size-11 max-sm:hidden')}
        disabled={!zoomable || zoom <= MIN_ZOOM}
        onClick={() => zoomTo(MIN_ZOOM)}
        type="button"
      >
        <Maximize aria-hidden className="size-[18px]" />
      </button>
      <span aria-hidden className="bg-viewer-foreground/20 mx-1.5 h-7 w-px max-sm:hidden" />
      <button
        aria-label="Turn left"
        className={cn(CONTROL, 'size-11')}
        disabled={!zoomable}
        onClick={() => turn(-1)}
        type="button"
      >
        <RotateCcw aria-hidden className="size-[18px]" />
      </button>
      <button
        aria-label="Turn right"
        className={cn(CONTROL, 'size-11')}
        disabled={!zoomable}
        onClick={() => turn(1)}
        type="button"
      >
        <RotateCw aria-hidden className="size-[18px]" />
      </button>
    </div>
  ) : null;

  const strip =
    count > 1 ? (
      <div aria-label={heading ? `Photos in ${heading}` : 'Photos'} className="flex min-w-0 items-center gap-2.5 overflow-x-auto py-0.5 max-sm:hidden" role="group">
        {items.map((entry, at) => (
          <StripTile
            item={entry}
            key={entry.id}
            label={`${at + 1} of ${count}: ${entry.title}`}
            onPick={() => setIndex(at)}
            selected={at === index}
          />
        ))}
      </div>
    ) : null;

  /** Where the viewer is, on a phone: dots for a few, the count for many. */
  const dots = (
    <div aria-hidden className="flex items-center gap-2 sm:hidden">
      {count > 1 && count <= 10
        ? items.map((entry, at) => (
            <span
              className={cn('size-[7px] rounded-full', at === index ? 'bg-viewer-accent' : 'bg-viewer-foreground/35')}
              key={entry.id}
            />
          ))
        : null}
      <span className="text-viewer-muted ml-1 text-xs tabular-nums">{counter}</span>
    </div>
  );

  return (
    <div
      aria-label={`${heading ? `${heading}, ` : ''}${item.title}, ${counter}`}
      aria-modal
      className="text-viewer-foreground fixed inset-0 z-50 flex flex-col"
      role="dialog"
    >
      {/* The backdrop is its own layer, deliberately not an ancestor of the
          media. `backdrop-filter` establishes a containing block, and Chrome
          renders a fullscreen element inside one as a black rectangle — the
          video kept playing, with audio and a moving timeline, and painted
          nothing. Keeping the blur on a sibling leaves the look intact and the
          media's ancestor chain free of filters. */}
      <div aria-hidden className="bg-viewer/95 absolute inset-0 -z-10 backdrop-blur-sm" />
      <header className="border-viewer-foreground/10 flex items-center gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          {/* The area first when the viewer walks several: crossing into the
              kitchen has to be unmissable, and "Area overview" alone says
              nothing about which one. */}
          <p className="flex min-w-0 items-baseline gap-2.5">
            <span className="font-display truncate text-base font-semibold text-white sm:shrink-0 sm:text-lg">
              {heading ? `${heading} · ${item.title}` : item.title}
            </span>
            {item.detail ? (
              <span className="text-viewer-foreground/85 truncate text-sm max-sm:hidden">{item.detail}</span>
            ) : null}
          </p>
          {item.detail ? <p className="text-viewer-muted truncate text-xs sm:hidden">{item.detail}</p> : null}
          {position ? (
            <p className="text-viewer-foreground/85 truncate text-sm">
              Photo {index + 1} of {count} · {position}
            </p>
          ) : null}
          {item.caption ? <p className="text-viewer-muted truncate text-xs sm:text-[13px]">{item.caption}</p> : null}
        </div>
        {position ? null : (
          <span aria-hidden className="text-viewer-foreground/85 shrink-0 px-1 text-sm tabular-nums max-sm:hidden">
            {counter}
          </span>
        )}
        {item.kind === 'recording' ? (
          // Cloudflare's embedded player offers no download of its own.
          <RecordingDownloadButton
            className="border-viewer-foreground/25 text-viewer-foreground hover:bg-viewer-foreground/10 hover:text-viewer-foreground shrink-0 bg-transparent"
            key={item.id}
            mediaId={item.id}
          />
        ) : (
          // The original, not the copy on screen: what a vendor, a deck or a dispute needs.
          <button
            className="bg-viewer-accent text-viewer-accent-foreground hover:bg-viewer-accent/85 focus-visible:outline-viewer-accent inline-flex h-11 shrink-0 items-center gap-2 rounded-lg px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 max-sm:w-11 max-sm:justify-center max-sm:px-0"
            disabled={!objectUrl || saving}
            onClick={() => void download()}
            type="button"
          >
            {saving ? (
              <Loader2 aria-hidden className="size-[18px] animate-spin" />
            ) : (
              <Download aria-hidden className="size-[18px]" />
            )}
            <span className="max-sm:sr-only">Download</span>
          </button>
        )}
        {aside ? (
          <button
            aria-pressed={aside.open}
            className={cn(OUTLINED, 'h-11 shrink-0', aside.open && 'bg-viewer-foreground/15')}
            onClick={aside.onToggle}
            type="button"
          >
            <PanelRightIcon aria-hidden className="size-[18px]" />
            <span className="max-sm:sr-only">Review panel</span>
          </button>
        ) : null}
        <button
          // Focused on open so Escape and Tab both behave, and a keyboard user
          // lands on the way out rather than inside the media.
          autoFocus
          aria-label="Close viewer"
          className={cn(CONTROL, 'size-11 shrink-0 max-sm:order-first')}
          onClick={onClose}
          type="button"
        >
          <X aria-hidden className="size-[22px]" />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center px-2 py-3 sm:px-20">
          {/* Shown for a moment and announced, so arriving in another area is
              noticed by everyone, not only by someone watching the title. */}
          <p aria-live="polite" className="sr-only">
            {notice ?? ''}
          </p>
          {notice ? (
            <p
              aria-hidden
              className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/90 px-3.5 py-1 text-sm font-semibold whitespace-nowrap text-black"
            >
              {notice}
            </p>
          ) : null}
          {loadingOriginal && !notice ? (
            <p
              className="bg-viewer/85 border-viewer-foreground/15 pointer-events-none absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3.5 py-1 text-sm whitespace-nowrap"
              role="status"
            >
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Loading the full-size photo
            </p>
          ) : null}
          {zoom > MIN_ZOOM && !dragging && photoItem ? (
            <p className="bg-viewer/85 border-viewer-foreground/15 pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full border px-3.5 py-1 text-sm whitespace-nowrap">
              Drag to move around
            </p>
          ) : null}

          {canPrevious ? (
            <button
              aria-label="Previous evidence"
              className={cn(
                CONTROL,
                'bg-viewer-foreground/15 hover:bg-viewer-foreground/25 absolute top-1/2 left-3 z-10 size-[52px] -translate-y-1/2 rounded-full max-sm:hidden sm:left-5',
              )}
              onClick={() => step(-1)}
              type="button"
            >
              <ChevronLeft aria-hidden className="size-6" />
            </button>
          ) : null}

          {/* The scroll viewport once a photograph is zoomed. Its children centre
              with `m-auto` rather than by centring the flex line: that centres
              whatever is smaller than the view and, unlike flex centring, never
              clips an edge of a photograph that has grown larger than it.
              `touch-none`: the fingers are this viewer's -- pinch, drag, swipe --
              rather than the browser's, which would zoom the whole console. */}
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-1 touch-none self-stretch overflow-auto select-none',
              zoom > MIN_ZOOM && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
            )}
            data-testid="photo-viewport"
            onDoubleClick={(event) => {
              if (zoomable) zoomTo(zoomRef.current > MIN_ZOOM ? MIN_ZOOM : DOUBLE_CLICK_ZOOM, event);
            }}
            onPointerCancel={(event) => {
              // Taken by the system (a scroll, a call): never a swipe.
              swipe.current = null;
              pointerUp(event);
            }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            ref={stage}
          >
            {loading ? (
              <p className="text-viewer-muted m-auto flex items-center gap-2 text-sm">
                <Loader2 aria-hidden className="size-4 animate-spin" />
                Loading the photo…
              </p>
            ) : failed ? (
              <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
                <ImageOffIcon aria-hidden className="text-viewer-muted size-8" />
                <p className="text-sm">The photo could not be loaded.</p>
                <button
                  className={OUTLINED}
                  onClick={() => {
                    setFailure(null);
                    setAttempt((value) => value + 1);
                  }}
                  type="button"
                >
                  Try again
                </button>
              </div>
            ) : item.kind === 'recording' ? (
              <div className="m-auto flex w-full max-w-4xl items-center justify-center">
                <RecordingSurface
                  mediaId={item.id}
                  posterUrl={item.posterUrl}
                  startSeconds={item.startSeconds}
                  title={item.title}
                />
              </div>
            ) : objectUrl ? (
              // Sized to the photograph once its pixels are known -- to its turned
              // shape when it is turned -- so the capture time drawn over it sits on
              // the picture's corner, the right way up, not beside it.
              <span
                className={cn('relative m-auto inline-flex shrink-0', !shown && 'max-h-full max-w-full')}
                data-testid="photo-frame"
                ref={picture}
                style={shown ?? undefined}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={item.detail ? `${item.title}: ${item.detail}` : item.title}
                  className={cn(
                    'rounded-lg object-contain',
                    shown ? 'absolute top-1/2 left-1/2 max-w-none' : 'max-h-full max-w-full',
                  )}
                  draggable={false}
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } = event.currentTarget;
                    setNatural((current) =>
                      current?.id === item.id && current.width >= naturalWidth
                        ? current
                        : { id: item.id, width: naturalWidth, height: naturalHeight },
                    );
                  }}
                  src={objectUrl}
                  style={
                    shown
                      ? {
                          width: sideways ? shown.height : shown.width,
                          height: sideways ? shown.width : shown.height,
                          transform: `translate(-50%, -50%) rotate(${quarter * 90}deg)`,
                        }
                      : undefined
                  }
                />
                {shown ? (
                  <PhotoStamp capturedAt={item.capturedAt} size="md" source={item.captureTimeSource} />
                ) : null}
              </span>
            ) : null}
          </div>

          {canNext ? (
            <button
              aria-label="Next evidence"
              className={cn(
                CONTROL,
                'bg-viewer-foreground/15 hover:bg-viewer-foreground/25 absolute top-1/2 right-3 z-10 size-[52px] -translate-y-1/2 rounded-full max-sm:hidden sm:right-5',
              )}
              onClick={() => step(1)}
              type="button"
            >
              <ChevronRight aria-hidden className="size-6" />
            </button>
          ) : null}
        </div>
        {/* A themed card on the dark backdrop rather than white-on-navy
            controls: the panel holds ordinary console controls -- Approve,
            Reject, the review mark -- and they should look like themselves.
            On a phone it lies over the photograph instead of squeezing it to a
            sliver beside it; the Review panel button goes back to the photo. */}
        {aside?.open ? (
          <aside
            aria-label="Review panel"
            className="bg-card text-card-foreground mt-3 mr-2 mb-3 w-80 shrink-0 overflow-y-auto rounded-xl border p-4 max-sm:absolute max-sm:inset-x-2 max-sm:top-0 max-sm:bottom-0 max-sm:z-20 max-sm:m-0 max-sm:my-2 max-sm:w-auto sm:mr-4"
          >
            {aside.content}
          </aside>
        ) : null}
      </div>

      {walksAreas ? (
        // The Rooms board: the area's photographs on the left, the tools in the
        // middle, the keys on the right.
        <footer className="border-viewer-foreground/10 flex items-center gap-5 border-t px-4 pt-3 pb-4 max-sm:flex-col max-sm:gap-2.5 sm:px-7">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 max-sm:hidden">
            {heading ? <span className="shrink-0 text-sm font-semibold">{heading}</span> : null}
            {strip}
          </div>
          {dots}
          {toolbar}
          <p className="text-viewer-muted flex-1 text-right text-xs max-sm:hidden">
            ← → photos · ↑ ↓ previous or next area · Esc to close
          </p>
          <p className="text-viewer-muted text-xs sm:hidden">Pinch to zoom · swipe for the next photo</p>
        </footer>
      ) : (
        // The Viewer board: the tools, the strip under them, the gestures to one side.
        <footer className="border-viewer-foreground/10 relative flex flex-col items-center gap-3 border-t px-4 pt-3 pb-4 sm:px-7">
          {dots}
          {toolbar}
          {strip}
          {photoItem ? (
            <p className="text-viewer-muted bottom-4 right-7 text-xs max-sm:hidden lg:absolute">
              Scroll to zoom · Drag to move · Double-click for 200%
            </p>
          ) : null}
          <p className="text-viewer-muted text-xs sm:hidden">Pinch to zoom · swipe for the next photo</p>
        </footer>
      )}
    </div>
  );
}
