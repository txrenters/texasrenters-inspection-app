'use client';

import { formatMoney, type XeroBooksView } from '@texasrenters/shared';
import { toast } from 'sonner';

import { Panel } from '@/components/panel';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatDay, formatRelative } from '@/lib/format';
import { useReadXeroBooks, useXeroBooks } from '@/lib/xero-queries';

const XERO_STATUS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Awaiting approval',
  AUTHORISED: 'Awaiting payment',
  PAID: 'Paid',
};

/**
 * A company's books read back from Xero (2026-11-12): its invoices and
 * payments as Xero has them, read every hour. Shown here as counts, to set
 * beside Xero's own; the invoice pages show them once they show Xero's books
 * in place of Jobber's copies. "Read invoices from Xero now" reads a page of
 * each -- two calls -- at most once a minute.
 */
export function XeroBooksPanel({ tenantId, name, canManage }: { tenantId: string; name: string; canManage: boolean }) {
  const books = useXeroBooks(tenantId);
  const read = useReadXeroBooks(tenantId);
  const view = books.data;

  const readNow = () =>
    read.mutate(undefined, {
      onSuccess: (done) =>
        done.lastRunProblem
          ? toast.warning('Read from Xero, with a problem', { description: done.lastRunProblem })
          : toast.success('Read from Xero', { description: `${done.counts.invoices.toLocaleString('en-US')} invoices so far.` }),
      onError: (error) => toast.error('Nothing was read', { description: error.message }),
    });

  return (
    <Panel bodyClassName="space-y-4 p-4" title="Books read from Xero">
      <p className="text-muted-foreground text-sm">
        {name}’s invoices and payments as Xero has them, read every hour. Xero is the record: the invoice pages will show these in place of
        Jobber’s copies. Until then they are counted here only.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {canManage ? (
          <Button disabled={read.isPending} onClick={readNow} variant="outline">
            {read.isPending ? 'Reading…' : 'Read invoices from Xero now'}
          </Button>
        ) : null}
        {view?.lastRunAt ? <span className="text-muted-foreground text-sm">Read {formatRelative(view.lastRunAt)}.</span> : null}
      </div>

      {books.isError ? (
        <ErrorState error={books.error} retry={() => void books.refetch()} />
      ) : !view ? null : (
        <>
          {view.lastRunProblem ? <p className="text-warning text-sm">{view.lastRunProblem}</p> : null}
          {!view.lastRunAt ? (
            <p className="text-muted-foreground text-sm">Nothing has been read yet. The first read starts within the hour.</p>
          ) : !view.readAt ? (
            <p className="text-muted-foreground text-sm">The first read is still going: up to 6,000 invoices an hour, until all are read.</p>
          ) : (
            <p className="text-muted-foreground text-sm">Every invoice was read by {formatDate(view.readAt)}; since then, what changes.</p>
          )}
          <Counts view={view} />
          {view.unplaced.length ? (
            <Table aria-label="Read from Xero, on no property">
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>In Xero</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.unplaced.map((row, index) => (
                  <TableRow key={`${row.number ?? 'none'}-${index}`}>
                    <TableCell className="tabular-nums">{row.number ?? '—'}</TableCell>
                    <TableCell className="whitespace-normal">{row.clientName}</TableCell>
                    <TableCell className="whitespace-nowrap">{row.issuedOn ? formatDay(row.issuedOn) : '—'}</TableCell>
                    <TableCell>{(row.xeroStatus && XERO_STATUS[row.xeroStatus]) ?? row.xeroStatus ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(row.totalCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function Counts({ view }: { view: XeroBooksView }) {
  const { counts } = view;
  const items: [string, string, boolean][] = [
    ['Invoices', counts.invoices.toLocaleString('en-US'), false],
    ['On a property', counts.placed.toLocaleString('en-US'), false],
    ['On no property', counts.unplaced.toLocaleString('en-US'), counts.unplaced > 0],
    ['Still owed', formatMoney(counts.owedCents), false],
    ['Payments', counts.payments.toLocaleString('en-US'), false],
    ['Made here', counts.consoleInvoices.toLocaleString('en-US'), false],
  ];
  return (
    <dl aria-label="What was read from Xero" className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, value, warn]) => (
        <div key={label}>
          <dt className="text-muted-foreground text-xs">{label}</dt>
          <dd className={`text-lg font-semibold tabular-nums ${warn ? 'text-warning' : ''}`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
