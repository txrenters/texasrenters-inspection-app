'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Paging for a server-paged list.
 *
 * Always rendered when there is more than one page, and always reports the
 * total — "Page 2 of 9" tells someone whether it is worth filtering instead,
 * which a bare pair of arrows does not.
 */
export function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total?: number;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 pt-4"
      aria-label="Pagination"
    >
      <p className="text-muted-foreground text-sm" aria-live="polite">
        Page {page.toLocaleString()} of {totalPages.toLocaleString()}
        {typeof total === 'number' ? ` · ${total.toLocaleString()} total` : null}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeftIcon />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next
          <ChevronRightIcon />
        </Button>
      </div>
    </nav>
  );
}
