interface FloorPlanZoomControlsProps {
  zoom: number;
  hasSelection: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFocusSelected: () => void;
}

export function FloorPlanZoomControls({
  zoom,
  hasSelection,
  onZoomIn,
  onZoomOut,
  onReset,
  onFocusSelected,
}: FloorPlanZoomControlsProps) {
  return (
    <div className="fp-zoom-controls" role="group" aria-label="Floor plan zoom controls">
      <button
        type="button"
        className="button button-secondary button-small"
        onClick={onZoomOut}
        aria-label="Zoom out"
      >
        −
      </button>
      <span className="fp-zoom-level" aria-live="off">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        className="button button-secondary button-small"
        onClick={onZoomIn}
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        className="button button-secondary button-small"
        onClick={onReset}
        title="Fit the complete source plan in the viewport"
      >
        Fit plan
      </button>
      <button
        type="button"
        className="button button-secondary button-small"
        onClick={onFocusSelected}
        disabled={!hasSelection}
      >
        Focus selected
      </button>
    </div>
  );
}
