'use client';

import type { InvoiceXeroBooks } from '@texasrenters/shared';
import { RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import { useReadAllXeroBooks } from '@/lib/xero-queries';

const names = (books: readonly InvoiceXeroBooks[]) =>
  books.length > 1 ? `${books.slice(0, -1).map((book) => book.name).join(', ')} and ${books.at(-1)!.name}` : books[0]!.name;

/**
 * Under the invoice list (2026-11-12): whose invoices are shown as their books
 * in Xero have them, when they were last read from there, and -- for whoever
 * manages invoices -- "Read invoices from Xero now": two calls a company, at
 * most once a minute.
 */
export function XeroBooksLine({ books }: { books: readonly InvoiceXeroBooks[] }) {
  const { has } = usePermissions();
  const read = useReadAllXeroBooks();
  if (!books.length) return null;
  const latest = books
    .map((book) => book.readAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  const readNow = () =>
    read.mutate(undefined, {
      onSuccess: (done) =>
        done.problems.length
          ? toast.warning('Read from Xero, with a problem', { description: done.problems[0] })
          : toast.success('Read from Xero', { description: 'The list shows what Xero has now.' }),
      onError: (error) => toast.error('Nothing was read', { description: error.message }),
    });
  return (
    <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span>
        {names(books)}’s invoices are as Xero has them{latest ? `, read ${formatRelative(latest)}` : ''}. Change them in Xero.
      </span>
      {has('invoices:manage') ? (
        <Button className="h-7 px-2 text-xs" disabled={read.isPending} onClick={readNow} size="sm" variant="ghost">
          <RefreshCwIcon className={read.isPending ? 'animate-spin' : undefined} />
          {read.isPending ? 'Reading…' : 'Read invoices from Xero now'}
        </Button>
      ) : null}
    </div>
  );
}
