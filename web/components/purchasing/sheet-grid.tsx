'use client';

import type { ComponentProps, KeyboardEvent, ReactNode } from 'react';

import { RequiredMark } from '@/components/purchasing/nav-kit';
import { Table, TableBody, TableHeader } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The Lines grid as a spreadsheet (2026-11-20, the office's ask: "the lines
 * should look like the Excel rows"): ruled cells edge to edge, the row number
 * down the left, and each cell edited in place with no box of its own. ↑ and ↓
 * move to the same column in the row above or below, Enter moves down, and
 * moving down from the last row starts a new one, as NAV's Lines do.
 */

export interface SheetColumn {
  key: string;
  label: string;
  numeric?: boolean;
  /** A Tailwind width, e.g. `w-40`. */
  width?: string;
  /** Filled in on every line before it is sent (Purchasing Setup, 2026-11-21). */
  required?: boolean;
  /** Said to a screen reader only: a column of buttons. */
  labelHidden?: boolean;
}

/** A cell that holds an editor: the editor fills it. */
export const CELL = 'h-8 border border-border p-0 align-middle';
/** A cell of words: what the line says, not changed here. */
export const CELL_TEXT = 'h-8 border border-border px-2 align-middle whitespace-nowrap';
/** An editor inside a cell: no box, a ring inside the cell while it is being typed in. */
export const CELL_INPUT = 'focus:ring-primary h-8 w-full min-w-0 rounded-none border-0 bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-inset';

export function Sheet({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto border">
      <Table aria-label={label} className={cn('w-max min-w-full border-collapse', className)}>
        {children}
      </Table>
    </div>
  );
}

export function SheetHead({ columns }: { columns: readonly SheetColumn[] }) {
  return (
    // Static: this box scrolls sideways, and a sticky header inside a scroll box is shoved down over the first row (see components/ui/table.tsx).
    <TableHeader className="bg-transparent lg:static [&_tr]:border-b-0">
      <tr>
        <th className="bg-muted/60 w-9 border" scope="col">
          <span className="sr-only">Line</span>
        </th>
        {columns.map((column) => (
          <th
            className={cn('bg-muted/60 text-heading border px-2 py-1.5 text-xs font-medium whitespace-nowrap', column.numeric ? 'text-right' : 'text-left', column.width)}
            key={column.key}
            scope="col"
          >
            {column.labelHidden ? <span className="sr-only">{column.label}</span> : column.label}
            {column.required ? <RequiredMark /> : null}
          </th>
        ))}
      </tr>
    </TableHeader>
  );
}

/** The grid's rows; give it `onKeyDown={sheetKeys(...)}` to move about it as a spreadsheet. */
export function SheetBody(props: ComponentProps<'tbody'>) {
  return <TableBody {...props} />;
}

/** The row's number down the left, as a spreadsheet numbers its rows; ▸ marks the line the cursor is on. */
export function RowNumber({ n, current }: { n: number; current?: boolean }) {
  return (
    <th aria-current={current ? 'true' : undefined} className={cn('w-9 border px-1 text-center text-xs font-normal tabular-nums', current ? 'bg-accent text-heading' : 'bg-muted/40 text-muted-foreground')} scope="row">
      {current ? '▸' : n}
    </th>
  );
}

const FOCUSABLE = 'input, button, [role="combobox"], textarea, select';

function focusCell(row: Element | null | undefined, column: number) {
  const cell = row?.children[column];
  (cell?.querySelector(FOCUSABLE) as HTMLElement | null)?.focus();
}

/**
 * The keys that move about the grid, for the grid's body. A key an editor uses
 * itself (an open list, a date being stepped) is left to it.
 */
export function sheetKeys(onLastRowDown?: () => void) {
  return (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const down = event.key === 'ArrowDown' || event.key === 'Enter';
    if (!down && event.key !== 'ArrowUp') return;
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.type === 'date' && event.key !== 'Enter') return;
    if (target instanceof HTMLTextAreaElement) return;
    const cell = target.closest('td');
    const row = cell?.parentElement;
    if (!cell || !row) return;
    const column = Array.prototype.indexOf.call(row.children, cell) as number;
    const next = down ? row.nextElementSibling : row.previousElementSibling;
    event.preventDefault();
    if (next) return focusCell(next, column);
    if (down && onLastRowDown) {
      onLastRowDown();
      // Once the new row is drawn.
      window.setTimeout(() => focusCell(row.parentElement?.lastElementChild, column), 0);
    }
  };
}
