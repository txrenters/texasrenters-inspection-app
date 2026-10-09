'use client';

import { cn } from '@/lib/utils';

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
  /** A count shown beside the label, in muted mono. */
  count?: number;
  /**
   * The background class of a 6px dot before the label, e.g. `bg-map-technician`
   * when the filter matches a marker colour on the map. A literal class string,
   * so Tailwind sees it where it is written.
   */
  dotClassName?: string;
}

/**
 * One way to choose between a few views or filters (console-development).
 *
 * The console had five: a bordered group of ghost buttons, rounded-full pills
 * that looked exactly like dropdown filters, a muted track with a white thumb,
 * a filled primary button for "on", and Tabs used as a filter. This is the one
 * shape for all of them: a bordered track, the chosen option on the raised
 * surface, the rest muted. Each option is a real button that says whether it
 * is pressed.
 */
export function SegmentedControl<Value extends string>({
  value,
  onChange,
  options,
  className,
  'aria-label': label,
}: {
  value: Value;
  onChange: (value: Value) => void;
  options: readonly SegmentedOption<Value>[];
  className?: string;
  'aria-label': string;
}) {
  return (
    <div
      aria-label={label}
      className={cn('bg-card inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md border p-0.5', className)}
      role="group"
    >
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button
            aria-pressed={pressed}
            className={cn(
              'focus-visible:ring-ring/50 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[5px] px-2.5 text-xs whitespace-nowrap outline-none focus-visible:ring-[3px]',
              pressed ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.dotClassName ? (
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', option.dotClassName)} />
            ) : null}
            {option.label}
            {/* A space for the accessible name ("Unscheduled 1", not
                "Unscheduled1"); a flex row draws no gap for it. */}
            {option.count !== undefined ? ' ' : null}
            {option.count !== undefined ? (
              <span className="text-muted-foreground font-mono tabular-nums">{option.count.toLocaleString()}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
