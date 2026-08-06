import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The wrapper owns horizontal overflow so wide inspection tables scroll inside
 * their own container rather than making the whole page scroll sideways.
 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead data-slot="table-header" className={cn('bg-surface-subtle [&_tr]:border-b', className)} {...props} />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

export function TableFooter({ className, ...props }: ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-border transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Column rules pair with the row rule on TableRow to make a full grid, in the
 * same border colour so neither reads as the stronger axis.
 *
 * The last column drops its rule: the container around the table already draws
 * one, and the two would sit a pixel apart and read as a double line. Nothing
 * is needed on the first column for the same reason — the rules go on the right
 * of each cell, not the left, so the outer edges stay with the container.
 *
 * `border-collapse` on the table means a cell's right rule and its neighbour's
 * left edge resolve to a single line rather than stacking.
 */
const COLUMN_RULE = 'border-r border-border last:border-r-0';

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-3 text-left align-middle text-xs font-semibold text-muted-foreground whitespace-nowrap',
        COLUMN_RULE,
        '[&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('p-3 align-middle', COLUMN_RULE, '[&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}
