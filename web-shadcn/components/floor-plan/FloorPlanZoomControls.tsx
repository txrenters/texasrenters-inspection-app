import { CrosshairIcon, MaximizeIcon, MinusIcon, PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface FloorPlanZoomControlsProps {
  zoom: number;
  hasSelection: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFocusSelected: () => void;
}

/**
 * Icons with tooltips rather than the old row of five text buttons, which took
 * enough width on a laptop to wrap onto a second line above the plan.
 */
export function FloorPlanZoomControls({
  zoom,
  hasSelection,
  onZoomIn,
  onZoomOut,
  onReset,
  onFocusSelected,
}: FloorPlanZoomControlsProps) {
  return (
    <div
      aria-label="Floor plan zoom controls"
      className="bg-background/90 flex items-center gap-0.5 rounded-lg border p-1 shadow-sm backdrop-blur"
      role="group"
    >
      <Button aria-label="Zoom out" onClick={onZoomOut} size="icon-sm" variant="ghost">
        <MinusIcon />
      </Button>
      <span
        aria-live="off"
        className="text-muted-foreground min-w-11 text-center text-xs font-medium tabular-nums"
      >
        {Math.round(zoom * 100)}%
      </span>
      <Button aria-label="Zoom in" onClick={onZoomIn} size="icon-sm" variant="ghost">
        <PlusIcon />
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label="Fit plan" onClick={onReset} size="icon-sm" variant="ghost">
            <MaximizeIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Fit the complete source plan in the viewport</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Focus selected area"
            disabled={!hasSelection}
            onClick={onFocusSelected}
            size="icon-sm"
            variant="ghost"
          >
            <CrosshairIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Focus the selected area</TooltipContent>
      </Tooltip>
    </div>
  );
}
