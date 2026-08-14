import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { cn } from '@/lib/utils';

interface AreaMarkerProps {
  id: string;
  name: string;
  /** Anchor position in base (untransformed) wrapper pixels. */
  left: number;
  top: number;
  zoom: number;
  selected: boolean;
  quiet?: boolean;
  editing?: boolean;
  orderLabel?: number;
  source?: string | null;
  normalizedX?: number;
  normalizedY?: number;
  /** Bumped on (re)selection to retrigger the locate pulse. */
  pulseKey?: number;
  onSelect: () => void;
  /** dirX/dirY ∈ {-1,0,1}; large = Shift held. Normalized step computed by parent. */
  onNudge?: (dirX: number, dirY: number, large: boolean) => void;
  onDragPointerDown?: (event: ReactPointerEvent) => void;
}

/**
 * Where a marker came from, which is the whole point of the colour.
 *
 * An administrator-placed marker is trusted; an extracted one is a suggestion
 * awaiting confirmation; anything else has not been looked at. Losing that
 * distinction would make an unreviewed AI guess look like a decision someone made.
 */
type Provenance = 'admin' | 'suggested' | 'unverified';

function provenanceOf(source?: string | null): Provenance {
  if (source === 'ADMIN_ADJUSTED' || source === 'ADMIN_PLACED') return 'admin';
  if (source === 'AI_EXTRACTED' || source === 'DETERMINISTIC_EXTRACTED') return 'suggested';
  return 'unverified';
}

const PROVENANCE_LABEL: Record<Provenance, string> = {
  admin: 'administrator placed',
  suggested: 'suggested',
  unverified: 'needs review',
};

const PROVENANCE_GLYPH: Record<Provenance, string> = {
  admin: 'bg-primary border-primary',
  suggested: 'bg-warning/70 border-warning',
  unverified: 'bg-muted-foreground/50 border-muted-foreground',
};

export function AreaMarker({
  id,
  name,
  left,
  top,
  zoom,
  selected,
  quiet,
  editing,
  orderLabel,
  source,
  normalizedX,
  normalizedY,
  pulseKey,
  onSelect,
  onNudge,
  onDragPointerDown,
}: AreaMarkerProps) {
  const showLabel = selected || editing;
  const provenance = provenanceOf(source);

  // A marker near an edge would push its label outside the plan, so the label
  // flips to the opposite side rather than being clipped.
  const nearRight = normalizedX != null && normalizedX > 0.78;
  const nearLeft = normalizedX != null && normalizedX < 0.22;
  const nearBottom = normalizedY != null && normalizedY > 0.78;

  const style = {
    left,
    top,
    // Counter-scale so the glyph keeps a constant on-screen size at any zoom.
    transform: `translate(-50%, -50%) scale(${1 / zoom})`,
  } as CSSProperties;

  function handleKeyDown(event: KeyboardEvent) {
    if (!editing || !onNudge) return;
    const large = event.shiftKey;
    if (event.key === 'ArrowUp') onNudge(0, -1, large);
    else if (event.key === 'ArrowDown') onNudge(0, 1, large);
    else if (event.key === 'ArrowLeft') onNudge(-1, 0, large);
    else if (event.key === 'ArrowRight') onNudge(1, 0, large);
    else return;
    event.preventDefault();
  }

  return (
    <button
      aria-label={
        editing ? `${name} marker, editing` : `${name} marker, ${PROVENANCE_LABEL[provenance]}`
      }
      aria-pressed={selected}
      className={cn(
        'absolute grid size-5 place-items-center rounded-full outline-none',
        'focus-visible:ring-ring focus-visible:ring-2',
        editing ? 'cursor-move' : 'cursor-pointer',
        quiet && !selected && 'opacity-60',
      )}
      // The canvas asks `closest('[data-fp-marker]')` whether a pointerdown
      // landed on a marker before starting a background pan. A class name would
      // work too, but every class here is a Tailwind utility that could be
      // changed for purely visual reasons — this attribute exists only as that
      // hook, so it cannot be restyled away by accident.
      data-fp-marker=""
      id={`fp-marker-${id}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      onPointerDown={editing ? onDragPointerDown : undefined}
      style={style}
      type="button"
    >
      <span
        aria-hidden
        className={cn(
          'block size-3 rotate-45 rounded-[2px] border-2 shadow-sm transition-transform',
          PROVENANCE_GLYPH[provenance],
          selected && 'scale-125',
        )}
      />

      {/* Remounted by `pulseKey` so re-selecting the same marker replays it. */}
      {selected ? (
        <span
          aria-hidden
          className="border-primary pointer-events-none absolute top-1/2 left-1/2 size-5 rounded-full border-2 motion-safe:[animation:fp-marker-pulse_0.9s_ease-out]"
          key={pulseKey}
        />
      ) : null}

      {showLabel ? (
        <span
          className={cn(
            'bg-popover text-popover-foreground pointer-events-none absolute max-w-[160px] truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium shadow-sm',
            nearBottom ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
            nearRight ? 'right-0' : nearLeft ? 'left-0' : 'left-1/2 -translate-x-1/2',
          )}
        >
          {name}
        </span>
      ) : quiet && orderLabel ? (
        <span
          aria-hidden
          className="bg-popover text-muted-foreground pointer-events-none absolute top-full mt-1 rounded px-1 text-[10px] font-semibold tabular-nums"
        >
          {orderLabel}
        </span>
      ) : null}
    </button>
  );
}
