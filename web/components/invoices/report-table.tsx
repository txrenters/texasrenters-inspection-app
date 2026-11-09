'use client';

import { formatMoney, type InvoiceBucket } from '@texasrenters/shared';
import { DownloadIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { csvText, downloadCsv, type CsvCell } from '@/lib/csv';
import { cn } from '@/lib/utils';

/**
 * The parts every invoice report is made of (2026-11-09): its cards, as
 * Jobber's Overview shows them, and its table, fifty rows a page, which
 * downloads whole as CSV from the rows the page already holds.
 */

export interface ReportCard {
  label: string;
  bucket: InvoiceBucket;
  /** "invoices", "payments", "clients". */
  noun?: string;
  tone?: 'late' | 'credit';
}

export function ReportCards({ cards, label }: { cards: readonly ReportCard[]; label: string }) {
  return (
    <section aria-label={label} className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <div className="bg-card rounded-lg border p-3" key={card.label}>
          <p className="text-muted-foreground text-xs">{card.label}</p>
          <p
            className={cn(
              'text-heading mt-1 text-xl font-bold tabular-nums',
              card.tone === 'late' && card.bucket.count > 0 && 'text-destructive',
              card.tone === 'credit' && card.bucket.count > 0 && 'text-success',
            )}
          >
            {formatMoney(card.bucket.amountCents)}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {card.bucket.count.toLocaleString('en-US')} {card.noun ?? (card.bucket.count === 1 ? 'invoice' : 'invoices')}
          </p>
        </div>
      ))}
    </section>
  );
}

export interface ReportColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** The cell as the CSV holds it: plain text or a number, money in dollars. */
  csv: (row: T) => CsvCell;
  numeric?: boolean;
  /** Left out of the table on narrow screens; always in the CSV. */
  wide?: boolean;
}

const PAGE = 50;

export function ReportTable<T>({
  label,
  columns,
  rows,
  rowKey,
  fileName,
  truncated,
  empty,
  footer,
}: {
  label: string;
  columns: readonly ReportColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  fileName: string;
  truncated?: boolean;
  empty: string;
  /** A totals row, under the last page. */
  footer?: ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE, current * PAGE + PAGE);

  const download = () =>
    downloadCsv(
      fileName,
      csvText(
        columns.map((column) => column.header),
        rows.map((row) => columns.map((column) => column.csv(row))),
      ),
    );

  return (
    <section aria-label={label} className="bg-card rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <p className="text-muted-foreground text-sm">
          {rows.length.toLocaleString('en-US')} {rows.length === 1 ? 'row' : 'rows'}
          {truncated ? ` — the first ${rows.length.toLocaleString('en-US')} only; narrow the days to see the rest` : ''}
        </p>
        <Button disabled={!rows.length} onClick={download} size="sm" variant="outline">
          <DownloadIcon />
          Download CSV
        </Button>
      </div>
      {rows.length ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead className={cn(column.numeric && 'text-right', column.wide && 'hidden lg:table-cell')} key={column.header}>
                    {column.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <TableRow key={rowKey(row)}>
                  {columns.map((column) => (
                    <TableCell
                      className={cn(column.numeric && 'text-right tabular-nums', column.wide && 'hidden lg:table-cell')}
                      key={column.header}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {current === pages - 1 ? footer : null}
            </TableBody>
          </Table>
          {pages > 1 ? (
            <div className="flex items-center justify-end gap-2 border-t px-4 py-2 text-sm">
              <span className="text-muted-foreground tabular-nums">
                Page {current + 1} of {pages}
              </span>
              <Button disabled={current === 0} onClick={() => setPage(current - 1)} size="sm" variant="outline">
                Previous
              </Button>
              <Button disabled={current >= pages - 1} onClick={() => setPage(current + 1)} size="sm" variant="outline">
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground px-4 py-8 text-center text-sm">{empty}</p>
      )}
    </section>
  );
}
