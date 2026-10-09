'use client';

import type { JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';

import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * "Today against Jobber": per technician, how many inspections the console
 * has, how many visits Jobber has, how far through the day they are, and the
 * first thing that does not match (console-development, 2026-10-09).
 *
 * Built from what the sync last stored, so the header says when that was. A
 * difference here is a question for a person, not an error: the sync may
 * close it on its next run, which is why a queued change of ours is called out.
 */
export function JobberDayPanel({
  day,
  loading,
  className,
}: {
  day: JobberDayComparison | undefined;
  loading: boolean;
  className?: string;
}) {
  const differing = day?.rows.filter((row) => row.state !== 'MATCHES').length ?? 0;

  return (
    <Panel
      actions={
        <>
          {day?.syncedAt ? (
            <span className="text-muted-foreground mr-2 font-mono text-[11px]" title={day.syncedAt}>
              synced {formatRelative(day.syncedAt)}
            </span>
          ) : null}
          <Button asChild className="h-7 px-2 text-xs" size="sm" variant="ghost">
            <Link href={day ? `/schedule?date=${day.date}` : '/schedule'}>
              The day
              <ArrowRightIcon />
            </Link>
          </Button>
        </>
      }
            className={className}
      count={differing || undefined}
      countTone="warning"
      title="Today against Jobber"
    >
      {loading && !day ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      ) : !day ? (
        <p className="text-muted-foreground px-4 py-6 text-sm">The day could not be compared with Jobber.</p>
      ) : !day.technicians.length ? (
        <p className="text-muted-foreground px-4 py-6 text-sm">
          {day.connected ? 'Nothing is booked today, here or in Jobber.' : 'Jobber is not connected.'}
        </p>
      ) : (
        <Table aria-label="Today against Jobber, by technician" className="min-w-[620px]">
          <TableHeader className="lg:static">
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Technician</TableHead>
              <TableHead className="text-right">Here</TableHead>
              <TableHead className="text-right">Jobber</TableHead>
              <TableHead>Day</TableHead>
              <TableHead className="pr-4">What differs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {day.technicians.map((person) => {
              const rows = day.rows.filter((row) => row.technicianId === person.technicianId);
              const first = rows.find((row) => row.state !== 'MATCHES');
              const share = person.here ? Math.round((person.done / person.here) * 100) : 0;
              const countsDiffer = person.here !== person.inJobber;
              return (
                <TableRow key={person.technicianId ?? 'nobody'}>
                  <TableCell className="pl-4 whitespace-nowrap">
                    <span className="flex items-center gap-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          person.technicianId === null
                            ? 'bg-warning'
                            : person.done > 0 && person.done < person.here
                              ? 'bg-highlight'
                              : 'bg-muted-foreground/50',
                        )}
                      />
                      <span className={cn(person.technicianId === null && 'text-warning')}>{person.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{person.here}</TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono tabular-nums',
                      countsDiffer ? 'text-warning' : 'text-muted-foreground',
                    )}
                  >
                    {person.inJobber}
                  </TableCell>
                  <TableCell className="w-40">
                    {person.here ? (
                      <>
                        <span className="bg-muted block h-1 overflow-hidden rounded-full">
                          <span className="bg-highlight block h-1" style={{ width: `${share}%` }} />
                        </span>
                        <span className="text-muted-foreground font-mono text-[10.5px]">
                          {person.done} of {person.here} done
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4 text-[13px] whitespace-normal">
                    <Difference more={person.differences - (first ? 1 : 0)} row={first} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function Difference({ row, more }: { row: JobberDayRow | undefined; more: number }) {
  if (!row) return <span className="text-muted-foreground">Matches</span>;
  const urgent = row.state === 'CANCELLED_HERE' || row.state === 'UNSEEN';
  return (
    <span className={urgent ? 'text-destructive' : 'text-warning'}>
      {row.differences[0]}
      <span className="text-muted-foreground"> · {row.property}</span>
      {more > 0 ? <span className="text-muted-foreground"> · +{more} more</span> : null}
    </span>
  );
}
