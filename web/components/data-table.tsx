'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * One column definition, used by the table, its skeleton and its mobile card
 * layout alike.
 *
 * The old app hand-wrote `<TableRow>` markup in each of the twelve list pages
 * and kept a *separate* `headers` array for the loading skeleton, so a column
 * added to one and not the other produced a skeleton that did not match the
 * table it was standing in for. Here there is one list and three renderers.
 */
export type Column<Row> = {
  /** Stable key, also the React key for the cell. */
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /**
   * The cell that identifies the row. Rendered first on mobile, given the
   * stretched link when `rowHref` is set, and never hidden.
   */
  primary?: boolean;
  /** Right-aligned and tabular. For money, counts and durations. */
  numeric?: boolean;
  /** Hidden below this breakpoint. Keeps a wide table readable on a laptop. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
};

const HIDE_BELOW: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

/**
 * `font-mono` on numeric columns, not just `tabular-nums`.
 *
 * Lining figures hold the digits to one width, which stops a column of totals
 * jittering as it re-renders. They do nothing for the *left* edge of a mixed
 * value — an inspection reference, a duration, a unit number — and scanning a
 * list of forty for the row that is wrong is exactly an exercise in reading
 * down a column's left edge. Geist Mono is metrically related to Geist, so a
 * mono cell and a sans cell in the same row keep the same baseline rhythm.
 */
function cellClass<Row>(column: Column<Row>) {
  return cn(
    column.numeric && 'text-right font-mono tabular-nums',
    column.hideBelow && HIDE_BELOW[column.hideBelow],
    column.className,
  );
}

/**
 * Row selection, supplied by the page rather than held here.
 *
 * The selected set has to outlive the table — a bulk bar above it reads the
 * count, and the confirmation dialog reads the rows themselves — so owning it
 * internally would mean lifting it out again on the first real use.
 */
export interface RowSelection {
  selected: ReadonlySet<string>;
  onToggle: (id: string, selected: boolean) => void;
  onToggleAll: (ids: string[], selected: boolean) => void;
  /** Announced on the header checkbox, e.g. "inspections". */
  noun: string;
  /**
   * Names one row for its checkbox. Without it every box announces the same
   * thing, and a screen reader user selecting from a list of forty has no way
   * to tell which one they just ticked.
   */
  rowLabel: (id: string) => string;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  rowHref,
  label,
  actions,
  selection,
  className,
}: {
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  selection?: RowSelection;
  /**
   * Makes the whole row navigable.
   *
   * Implemented as a stretched link on the primary cell rather than an onClick
   * on the `<tr>`: a click handler on a row is invisible to the keyboard and
   * unannounced by a screen reader, which is why the old app had to add an
   * "Open" icon button to every row as the only real control. Any interactive
   * element inside a row must carry `relative z-10` to sit above the overlay —
   * `RowActions` does this for you.
   */
  rowHref?: (row: Row) => string;
  label?: string;
  /** Trailing per-row controls, rendered in a final unlabelled column. */
  actions?: (row: Row) => ReactNode;
  className?: string;
}) {
  const pageIds = selection ? rows.map(rowKey) : [];
  const selectedOnPage = pageIds.filter((id) => selection?.selected.has(id)).length;
  const allSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;

  return (
    <div className={cn('bg-card overflow-hidden rounded-xl border', className)}>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selection ? (
              <TableHead className="w-0 pr-0">
                <Checkbox
                  aria-label={`Select all ${selection.noun} on this page`}
                  // Radix carries the third state as a value, so a partial
                  // selection stays visible rather than reading as "none".
                  checked={allSelected ? true : selectedOnPage > 0 ? 'indeterminate' : false}
                  onCheckedChange={(checked) => selection.onToggleAll(pageIds, checked === true)}
                />
              </TableHead>
            ) : null}
            {columns.map((column) => (
              <TableHead key={column.key} scope="col" className={cellClass(column)}>
                {column.header}
              </TableHead>
            ))}
            {actions ? (
              <TableHead scope="col" className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const href = rowHref?.(row);
            const id = rowKey(row);
            const checked = Boolean(selection?.selected.has(id));
            return (
              <TableRow
                key={id}
                // The selected tint comes from TableRow's `data-[state=selected]`
                // rather than a second class here, so selection looks identical
                // in every table in the console.
                className={cn('relative', href && 'focus-within:bg-accent')}
                data-state={checked ? 'selected' : undefined}
              >
                {selection ? (
                  // `relative z-10` for the same reason as the actions cell: the
                  // primary cell's stretched link covers the whole row, and a
                  // checkbox underneath it would navigate instead of tick.
                  <TableCell className="relative z-10 w-0 pr-0">
                    <Checkbox
                      aria-label={`Select ${selection.rowLabel(id)}`}
                      checked={checked}
                      onCheckedChange={(next) => selection.onToggle(id, next === true)}
                    />
                  </TableCell>
                ) : null}
                {columns.map((column) => (
                  <TableCell key={column.key} className={cellClass(column)}>
                    {href && column.primary ? (
                      <Link
                        href={href}
                        className="after:absolute after:inset-0 after:content-[''] font-medium outline-none hover:underline"
                      >
                        {column.cell(row)}
                      </Link>
                    ) : (
                      column.cell(row)
                    )}
                  </TableCell>
                ))}
                {actions ? (
                  <TableCell className="w-0">
                    <div className="relative z-10 flex items-center justify-end gap-1">
                      {actions(row)}
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The loading state, built from the same columns as the table it replaces.
 *
 * No brand animation and no 350ms hand-off. The old app showed a spinning
 * star, then swapped to a skeleton if the request was still running — two
 * different loading treatments for one wait, and a visible flip in the middle
 * of it.
 */
export function DataTableSkeleton<Row>({
  columns,
  rows = 6,
  label = 'Loading records',
  hasActions,
}: {
  columns: Array<Column<Row>>;
  rows?: number;
  label?: string;
  hasActions?: boolean;
}) {
  return (
    <div className="bg-card overflow-hidden rounded-xl border" aria-busy="true" aria-live="polite">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead key={column.key} scope="col" className={cellClass(column)}>
                {column.header}
              </TableHead>
            ))}
            {hasActions ? (
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, rowIndex) => (
            <TableRow key={rowIndex} className="hover:bg-transparent">
              {columns.map((column, columnIndex) => (
                <TableCell key={column.key} className={cellClass(column)}>
                  <Skeleton
                    className={cn('h-4', column.numeric && 'ml-auto')}
                    // Varied widths so the block reads as text rather than a
                    // progress bar, and deterministic so it does not reflow.
                    style={{ width: `${[70, 45, 60, 38, 52][(rowIndex + columnIndex) % 5]}%` }}
                  />
                </TableCell>
              ))}
              {hasActions ? (
                <TableCell className="w-0">
                  <Skeleton className="ml-auto h-7 w-7 rounded-md" />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
