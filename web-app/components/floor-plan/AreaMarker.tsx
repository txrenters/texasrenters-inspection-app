import { type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

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
  /** Bumped on (re)selection to retrigger the locate pulse. */
  pulseKey?: number;
  onSelect: () => void;
  /** dirX/dirY ∈ {-1,0,1}; large = Shift held. Normalized step computed by parent. */
  onNudge?: (dirX: number, dirY: number, large: boolean) => void;
  onDragPointerDown?: (event: ReactPointerEvent) => void;
}

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
  pulseKey,
  onSelect,
  onNudge,
  onDragPointerDown,
}: AreaMarkerProps) {
  const showLabel = selected || editing;
  const style = {
    left,
    top,
    // Counter-scale so the glyph keeps a constant on-screen size at any zoom.
    ['--fp-inv-zoom' as string]: String(1 / zoom),
  } as CSSProperties;

  function handleKeyDown(event: React.KeyboardEvent) {
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
      type="button"
      id={`fp-marker-${id}`}
      className={[
        'fp-marker',
        selected ? 'is-selected' : '',
        quiet ? 'is-quiet' : '',
        editing ? 'is-editing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      aria-label={editing ? `${name} marker, editing` : `${name} marker`}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      onPointerDown={editing ? onDragPointerDown : undefined}
    >
      <span className="fp-marker-square" aria-hidden />
      {selected ? <span key={pulseKey} className="fp-marker-pulse" aria-hidden /> : null}
      {showLabel ? (
        <span className="fp-marker-label">{name}</span>
      ) : quiet && orderLabel ? (
        <span className="fp-marker-order" aria-hidden>
          {orderLabel}
        </span>
      ) : null}
    </button>
  );
}
