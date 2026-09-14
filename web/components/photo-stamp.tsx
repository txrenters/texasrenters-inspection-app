import { formatPhotoStamp, type PhotoCaptureTimeSource } from '@texasrenters/shared';

import { cn } from '@/lib/utils';

/**
 * The capture time, drawn on the photograph.
 *
 * Laid over the photo rather than printed beside it, the way the office's
 * timestamp-camera reports show it, so the time travels with the picture into
 * a screenshot or a slide. It is drawn from the stored time, not burned into
 * the file: the original stays exactly as it was received.
 *
 * Renders nothing when the time's origin is not known -- a stamp on evidence
 * has to be right or absent. The parent must be positioned (`relative`).
 */
export function PhotoStamp({
  capturedAt,
  source,
  size = 'sm',
  className,
}: {
  capturedAt: string | null | undefined;
  source: PhotoCaptureTimeSource | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const stamp = formatPhotoStamp(capturedAt, source);
  if (!stamp) return null;
  return (
    <span
      className={cn(
        'pointer-events-none absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/65 px-1.5 py-0.5 font-medium text-white tabular-nums',
        size === 'sm' ? 'text-[10px] leading-tight' : 'text-xs',
        className,
      )}
      data-testid="photo-stamp"
    >
      {stamp}
    </span>
  );
}
