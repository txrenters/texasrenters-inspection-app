import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * `max-lg:overflow-x-auto`, not `overflow-x-auto`.
 *
 * A scroll container anywhere between a sticky `thead` and the viewport makes
 * the header stick to *that box* instead, and since this one only ever scrolls
 * sideways the header then never pins at all — it scrolls away with the rows.
 * Measured, not assumed: with the wrapper present the header ran to -351px past
 * the top of the screen; without it, it holds at 48px.
 *
 * Note `overflow-x: auto` alone is enough to cause this. Declaring one axis
 * non-visible computes the other to `auto` as well, so this box was a vertical
 * scroll container too, which is the part that does the damage.
 *
 * Below `lg` the horizontal scroll is kept, because that is where a table can
 * genuinely outrun the screen. Sticky headers are lost there, which is the right
 * side of the trade: a column you cannot reach is worse than a header you cannot
 * see, and `Column.hideBelow` has already dropped the optional columns by then.
 */
function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full max-lg:overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
}

/**
 * Sticky by default.
 *
 * A list page in this console routinely runs past a screen, and a column header
 * that scrolls away turns the fourth column of row 40 into a guess.
 *
 * The offset is `--app-header-height`, not `0`. The shell has no intermediate
 * scroll container, so `top-0` pins this to the viewport top, which is where the
 * app header already is: the column headers would slide underneath it and vanish
 * rather than staying visible. The background must also stay opaque for the same
 * reason a sticky bar always must, so this is `bg-muted` and not `bg-muted/40`.
 */
function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        'bg-muted [&_tr]:border-b',
        // Sticky ONLY at lg, matching the breakpoint where the container above
        // stops being a scroll box. Applying it unconditionally is what broke
        // every table in the console: `top` on a sticky element means "never
        // closer than this to the scrollport top", and the header is the FIRST
        // thing in that box, so instead of pinning it was shoved permanently
        // 48px down. That left a dead band across the top of every table, and
        // the first row rendered up inside it where the wrapper clipped it away
        // — which is why a list reading "1 inspections" showed no rows at all.
        'lg:sticky lg:top-[var(--app-header-height)] lg:z-10',
        // The charge report is printed and handed over. A sticky offset on
        // paper positions the header against a viewport that does not exist,
        // and `table-header-group` is what repeats it across page breaks.
        'print:static print:table-header-group',
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  );
}

function TableFooter({ className, ...props }: ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('bg-muted/50 border-t font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // The hover is the "which row am I on" affordance in a table this dense,
        // so it is a solid accent rather than a half-opacity muted wash.
        'hover:bg-accent data-[state=selected]:bg-primary/8 border-b transition-colors',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'text-muted-foreground h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        // 8px vertical, 12px horizontal. Stock shadcn is 12px on all four sides,
        // which costs eight pixels of row height for nothing: the row is already
        // separated by a rule, and four extra rows on screen is a scroll saved.
        'px-3 py-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('text-muted-foreground mt-4 text-sm', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
