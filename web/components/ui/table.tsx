import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
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
        'bg-muted sticky top-[var(--app-header-height)] z-10 [&_tr]:border-b',
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
