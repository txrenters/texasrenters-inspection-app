import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

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
    <div
      aria-label="Floor plan page"
      className="bg-background/90 flex items-center gap-0.5 rounded-lg border p-1 shadow-sm backdrop-blur"
      role="group"
    >
      <Button
        aria-label="Previous page"
        disabled={pageNumber <= 1}
        onClick={() => onChange(pageNumber - 1)}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronLeftIcon />
      </Button>
      <span className="text-muted-foreground px-1 text-xs font-medium tabular-nums">
        Page {pageNumber} of {pageCount}
      </span>
      <Button
        aria-label="Next page"
        disabled={pageNumber >= pageCount}
        onClick={() => onChange(pageNumber + 1)}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
