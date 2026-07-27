interface FloorPlanPageSelectorProps {
  pageNumber: number;
  pageCount: number;
  onChange: (page: number) => void;
}

/** Page navigation for multi-page PDF plans. Markers belong to one page. */
export function FloorPlanPageSelector({
  pageNumber,
  pageCount,
  onChange,
}: FloorPlanPageSelectorProps) {
  if (pageCount <= 1) return null;
  return (
    <div className="fp-page-selector" role="group" aria-label="Floor plan page">
      <button
        type="button"
        className="button button-secondary button-small"
        onClick={() => onChange(pageNumber - 1)}
        disabled={pageNumber <= 1}
        aria-label="Previous page"
      >
        ‹
      </button>
      <span className="fp-page-label">
        Page {pageNumber} of {pageCount}
      </span>
      <button
        type="button"
        className="button button-secondary button-small"
        onClick={() => onChange(pageNumber + 1)}
        disabled={pageNumber >= pageCount}
        aria-label="Next page"
      >
        ›
      </button>
    </div>
  );
}
