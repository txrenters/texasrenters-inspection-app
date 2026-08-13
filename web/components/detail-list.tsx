import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Key/value facts on a detail screen.
 *
 * A real `<dl>`, so the pairing is in the accessibility tree rather than implied
 * by two columns of divs — which is what the old `.detail-grid` / `.detail-item`
 * block was, and why a screen reader read a detail page as an undifferentiated
 * run of text.
 */
export function DetailList({
  items,
  columns = 2,
  className,
}: {
  items: Array<{ label: string; value: ReactNode }>;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-4',
        columns === 1 && 'sm:grid-cols-1',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0 space-y-1">
          <dt className="text-muted-foreground text-xs font-medium">{item.label}</dt>
          <dd className="text-sm break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
