import { ITEM_RESULTS, type ItemResult } from '@/lib/comparison-items';
import { cn } from '@/lib/utils';

/** A result's fill, and the ink a figure printed inside it takes. */
const FILL: Record<ItemResult, string> = {
  NEW: 'bg-destructive text-destructive-foreground',
  CLEANING: 'bg-warning text-background',
  ALREADY: 'bg-muted-foreground text-background',
  REPAIRED: 'bg-info text-background',
  // A tint of the ink, not `bg-muted`: that is the card's own neighbour, and
  // the largest part of most bars read as an empty track in the dark theme.
  SAME: 'bg-foreground/15 text-foreground',
  UNGRADED: 'bg-foreground/35 text-foreground',
};

const words = (counts: Record<ItemResult, number>) =>
  ITEM_RESULTS.filter((result) => counts[result.value])
    .map((result) => `${counts[result.value]} ${result.label.toLowerCase()}`)
    .join(', ');

/**
 * Every item of a comparison as one bar, split by how it came out.
 *
 * One whole cut into parts, so the parts are widths of the same bar and the
 * gaps between them, not borders, tell them apart. `tall` prints each count in
 * its part where it fits and comes with a legend; `mini` is the same split on
 * a room's row, read against the rows above and below it.
 */
export function ComparisonResultBar({
  counts,
  size,
  label,
  className,
}: {
  counts: Record<ItemResult, number>;
  size: 'tall' | 'mini';
  /** What the bar is of, for a reader who cannot see it: "Kitchen", "All 36 items". */
  label: string;
  className?: string;
}) {
  const parts = ITEM_RESULTS.filter((result) => counts[result.value] > 0);
  const total = parts.reduce((sum, result) => sum + counts[result.value], 0);
  if (!total) return null;
  return (
    <div
      aria-label={`${label}: ${words(counts)}`}
      className={cn('flex gap-0.5', size === 'tall' ? 'h-7' : 'bg-muted h-2 overflow-hidden rounded-full', className)}
      role="img"
    >
      {parts.map((result) => (
        <span
          className={cn(
            'flex min-w-[3px] items-center overflow-hidden',
            size === 'tall' && 'rounded-[4px] px-2 text-xs font-semibold tabular-nums',
            FILL[result.value],
          )}
          key={result.value}
          style={{ flex: `${counts[result.value]} 1 0` }}
        >
          {/* A part under about a twelfth of the bar has no room for its figure:
              the legend carries it instead, so nothing is cut off. */}
          {size === 'tall' && counts[result.value] / total >= 0.08 ? counts[result.value] : null}
        </span>
      ))}
    </div>
  );
}

/** The bar's key: every result that occurs, with its count, in the bar's order. */
export function ComparisonResultLegend({ counts }: { counts: Record<ItemResult, number> }) {
  return (
    <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
      {ITEM_RESULTS.filter((result) => counts[result.value] > 0).map((result) => (
        <li className="inline-flex items-center gap-1.5" key={result.value}>
          <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', FILL[result.value])} />
          {result.label}
          <span className="text-foreground font-medium tabular-nums">{counts[result.value]}</span>
        </li>
      ))}
    </ul>
  );
}
