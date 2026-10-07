'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export interface ReportPhotoSlide {
  id: string;
  /** The full-size copy. */
  src: string;
  alt: string;
  caption: string | null;
  /** The capture time drawn on the photograph, as in the grid. */
  stamp: string | null;
}

/**
 * A room's photographs, one at a time, over the report (the maintenance team,
 * 2026-10-08: a photograph opened in a new tab, and they asked for it to open
 * on the page "same as InspectCloud"). Arrows and the keyboard's arrow keys
 * step through the room; Escape, the close button or a click outside closes it.
 */
export function ReportPhotoViewer({
  index,
  onClose,
  onIndexChange,
  roomName,
  slides,
}: {
  /** The photograph shown, or null when the viewer is closed. */
  index: number | null;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  roomName: string;
  slides: ReportPhotoSlide[];
}) {
  const count = slides.length;
  const slide = index === null ? null : slides[index];

  useEffect(() => {
    if (index === null || count < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') onIndexChange((index - 1 + count) % count);
      if (event.key === 'ArrowRight') onIndexChange((index + 1) % count);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, index, onIndexChange]);

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open={slide !== null}>
      <DialogContent className="gap-3 p-3 sm:max-w-5xl">
        <DialogTitle className="pr-8 text-base">
          {roomName}
          {slide?.caption ? ` · ${slide.caption}` : ''}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {index === null ? '' : `Photograph ${index + 1} of ${count}`}
        </DialogDescription>
        {slide ? (
          <div className="relative flex min-h-[40dvh] items-center justify-center overflow-hidden rounded-md bg-black">
            {/* Plain <img>: a token-scoped API URL, not an optimizable asset. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={slide.alt}
              className="mx-auto max-h-[75dvh] w-auto max-w-full object-contain"
              key={slide.id}
              src={slide.src}
            />
            {slide.stamp ? (
              <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/65 px-2 py-0.5 text-xs font-medium text-white tabular-nums">
                {slide.stamp}
              </span>
            ) : null}
            {count > 1 ? (
              <>
                <Button
                  aria-label="Previous photograph"
                  className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full"
                  onClick={() => onIndexChange((index! - 1 + count) % count)}
                  size="icon"
                  type="button"
                  variant="secondary"
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  aria-label="Next photograph"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full"
                  onClick={() => onIndexChange((index! + 1) % count)}
                  size="icon"
                  type="button"
                  variant="secondary"
                >
                  <ChevronRightIcon />
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {index !== null && count > 1 ? (
          <p className="text-muted-foreground text-center text-sm tabular-nums">
            {index + 1} of {count}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
