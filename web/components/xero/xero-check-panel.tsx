'use client';

import { XERO_DIFFERENCE_LABEL, checkMonthLabel, checkMonths, type XeroCheckCounts } from '@texasrenters/shared';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Panel } from '@/components/panel';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { businessToday } from '@/lib/clock';
import { formatDay, formatRelative } from '@/lib/format';
import { useRunXeroCheck, useXeroCheck } from '@/lib/xero-queries';

/**
 * Checking a month of a company's invoices against its books in Xero
 * (2026-11-10, phase 5 of the multi-company plan): what the console has that
 * Xero has not, what Xero has that did not come from the console, and what
 * differs between the two. The latest check of each month is shown from the
 * console's own record; only "Check now" reads Xero -- one call per 100
 * invoices -- and at most once a minute.
 */
export function XeroCheckPanel({ tenantId, name, canManage }: { tenantId: string; name: string; canManage: boolean }) {
  const months = checkMonths(businessToday());
  const [month, setMonth] = useState(months[0]!);
  const check = useXeroCheck(tenantId, month);
  const run = useRunXeroCheck(tenantId);
  const view = check.data;

  const checkNow = () =>
    run.mutate(month, {
      onSuccess: (done) => {
        const different = done.differences.length;
        toast.success(`${checkMonthLabel(done.month)} checked`, {
          description: different ? `${different} ${different === 1 ? 'difference' : 'differences'} with Xero.` : 'The console and Xero agree.',
        });
      },
      onError: (error) => toast.error('The check did not run', { description: error.message }),
    });

  return (
    <Panel bodyClassName="space-y-4 p-4" title="Check against Xero">
      <p className="text-muted-foreground text-sm">
        A month of {name}’s invoices, as the console has them, against its books in Xero. Checking reads that month’s invoices from Xero, one call
        for every 100, only when you press Check now.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Select onValueChange={setMonth} value={month}>
          <SelectTrigger aria-label="Month to check" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((value) => (
              <SelectItem key={value} value={value}>
                {checkMonthLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage ? (
          <Button disabled={run.isPending} onClick={checkNow}>
            {run.isPending ? 'Checking…' : 'Check now'}
          </Button>
        ) : null}
        {view?.ranAt ? (
          <span className="text-muted-foreground text-sm">
            Checked {formatRelative(view.ranAt)}
            {view.ranBy ? ` by ${view.ranBy}` : ''}, {view.calls} {view.calls === 1 ? 'call' : 'calls'} to Xero.
          </span>
        ) : null}
      </div>

      {check.isError ? (
        <ErrorState error={check.error} retry={() => void check.refetch()} />
      ) : !view ? null : !view.ranAt || !view.counts ? (
        <p className="text-muted-foreground text-sm">{checkMonthLabel(month)} has not been checked yet.</p>
      ) : (
        <>
          <Counts counts={view.counts} />
          {!view.sendFrom || view.sendFrom > `${month}-31` ? (
            <p className="text-muted-foreground text-sm">
              {view.sendFrom ? `Before ${formatDay(view.sendFrom, 'long')}, the start date,` : 'With no start date chosen,'} the console sends nothing: only what Xero has is
              listed.
            </p>
          ) : null}
          {view.differences.length ? (
            <Table aria-label="Differences with Xero">
              <TableHeader>
                <TableRow>
                  <TableHead>What</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>The console</TableHead>
                  <TableHead>Xero</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.differences.map((difference, index) => (
                  <TableRow key={`${difference.kind}-${difference.invoiceId ?? difference.number ?? index}-${index}`}>
                    <TableCell className="font-medium whitespace-nowrap">{XERO_DIFFERENCE_LABEL[difference.kind]}</TableCell>
                    <TableCell>
                      {difference.invoiceId ? (
                        <Link className="underline underline-offset-2" href={`/invoices/${difference.invoiceId}`}>
                          {difference.number ? `#${difference.number}` : 'Not numbered'}
                        </Link>
                      ) : (
                        // Xero's own number, as Xero writes it ("INV-0099").
                        <span className="tabular-nums">{difference.number ?? '—'}</span>
                      )}{' '}
                      <span className="text-muted-foreground">{difference.clientName}</span>
                    </TableCell>
                    <TableCell className="whitespace-normal">{difference.here}</TableCell>
                    <TableCell className="whitespace-normal">{difference.xero}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm">The console and Xero agree for {checkMonthLabel(month)}.</p>
          )}
          {view.truncated ? (
            <p className="text-muted-foreground text-sm">
              Not everything is listed: a check keeps the first 200 differences and reads the first 1,000 of Xero’s invoices for a month.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function Counts({ counts }: { counts: XeroCheckCounts }) {
  const items: [string, number, boolean][] = [
    ['In the console', counts.console, false],
    ['In Xero', counts.xero, false],
    ['The same', counts.matching, false],
    ['Different', counts.different, counts.different > 0],
    ['Not sent yet', counts.notSent, counts.notSent > 0],
    ['Not in Xero', counts.missingInXero, counts.missingInXero > 0],
    ['Only in Xero', counts.onlyInXero, counts.onlyInXero > 0],
  ];
  return (
    <dl aria-label="What was compared" className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-7">
      {items.map(([label, value, warn]) => (
        <div key={label}>
          <dt className="text-muted-foreground text-xs">{label}</dt>
          <dd className={`text-lg font-semibold tabular-nums ${warn ? 'text-warning' : ''}`}>{value.toLocaleString('en-US')}</dd>
        </div>
      ))}
    </dl>
  );
}
