'use client';

import type {
  LeaseInspectionKind,
  LeaseScheduleAction,
  LeaseScheduleChange,
  LeaseScheduleItem,
  LeaseScheduleOutcome,
  LeaseScheduleRun,
} from '@texasrenters/shared';
import { CalendarClockIcon, EyeIcon, SendIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Stat, StatGroup, StatStrip, StatStripItem } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatDateTime, formatRelative, formatScheduledDate } from '@/lib/format';
import { useLeaseSchedule, useLeaseScheduleRun } from '@/lib/lease-schedule-queries';

/**
 * Move-outs and move-ins, booked from Propertyware's leases (the office, 2026-09-18).
 *
 * The office used to book these in Jobber by hand. Now a daily run books a
 * move-out for the day after every lease ends, sixty days ahead -- at once when
 * the tenant has given notice -- for whoever handles move-outs, and a move-in
 * twenty-two days after a leaving tenant goes, up to ninety days ahead, for
 * whoever handles move-ins. What the office books
 * in Jobber comes first. This page is what it booked, what it could not, and a
 * way to preview or run it now.
 */

const KIND: Record<LeaseInspectionKind, string> = { MOVE_OUT: 'Move-out', MOVE_IN: 'Move-in' };

/**
 * One tone per meaning (console-development): both booked states are booked,
 * so both read as done -- "Booked" and "Booked by the office" in two colours
 * looked like two different outcomes. Called off and cancelled are quiet words,
 * not outlined boxes louder than the work still coming up.
 */
const OUTCOME: Record<LeaseScheduleOutcome, { label: string; variant: 'secondary' | 'success' | 'warning' | 'destructive' }> = {
  SCHEDULED: { label: 'Booked', variant: 'success' },
  ALREADY_BOOKED: { label: 'Booked by the office', variant: 'success' },
  NEEDS_UNIT: { label: 'Needs a unit', variant: 'warning' },
  NOT_BOOKABLE: { label: 'Could not book', variant: 'destructive' },
  CALLED_OFF: { label: 'Called off', variant: 'secondary' },
  CANCELLED: { label: 'Cancelled by the office', variant: 'secondary' },
};

const ACTION: Record<LeaseScheduleAction, string> = {
  BOOK: 'Book',
  ALREADY_BOOKED: 'Already booked',
  NEEDS_UNIT: 'Needs a unit',
  NOT_BOOKABLE: 'Cannot book',
  MOVE: 'Move',
  CALL_OFF: 'Call off',
};

const COMING_UP: readonly LeaseScheduleOutcome[] = ['SCHEDULED', 'ALREADY_BOOKED'];
const ATTENTION: readonly LeaseScheduleOutcome[] = ['NEEDS_UNIT', 'NOT_BOOKABLE'];

/** "12 to book, 3 already booked", the parts a run did or would do. */
function countsSentence(counts: Record<LeaseScheduleAction, number>, dryRun: boolean) {
  const parts = (Object.keys(ACTION) as LeaseScheduleAction[])
    .filter((action) => counts[action] > 0)
    .map((action) => `${counts[action]} ${ACTION[action].toLowerCase()}${dryRun ? '' : action === 'BOOK' ? 'ed' : ''}`);
  return parts.length ? parts.join(' · ') : 'nothing to change';
}

const itemColumns: Array<Column<LeaseScheduleItem>> = [
  {
    key: 'day',
    header: 'Day',
    primary: true,
    cell: (item) => (
      <div className="grid">
        <span className="font-medium">{formatScheduledDate(item.inspection?.scheduledOn ?? item.scheduledOn)}</span>
        {item.dueOn !== item.scheduledOn ? (
          <span className="text-muted-foreground text-xs">Due {formatScheduledDate(item.dueOn)}</span>
        ) : null}
      </div>
    ),
  },
  // "Type", the word the rest of the console uses for move-in / move-out.
  { key: 'kind', header: 'Type', cell: (item) => KIND[item.kind] },
  {
    key: 'property',
    header: 'Property',
    cell: (item) => (
      <div className="grid min-w-0">
        {/* Above the row's own link (to the inspection), so it still opens the property. */}
        <Link className="relative z-10 truncate hover:underline" href={`/properties/${item.property.id}`}>
          {item.property.address ?? item.property.name}
        </Link>
        {item.property.city ? <span className="text-muted-foreground text-xs">{item.property.city}</span> : null}
      </div>
    ),
  },
  {
    key: 'lease',
    header: 'Tenancy ends',
    hideBelow: 'md',
    cell: (item) => (
      <div className="grid">
        <span>{formatScheduledDate(item.lease.endsOn)}</span>
        {item.lease.status ? <span className="text-muted-foreground text-xs">{item.lease.status}</span> : null}
      </div>
    ),
  },
  {
    key: 'technician',
    header: 'Technician',
    hideBelow: 'lg',
    cell: (item) => item.inspection?.technician?.displayName ?? (item.inspection ? 'Unassigned' : EMPTY),
  },
  {
    key: 'status',
    header: 'Status',
    className: 'max-w-sm',
    cell: (item) => (
      <div className="grid gap-1">
        <Badge variant={OUTCOME[item.outcome].variant}>{OUTCOME[item.outcome].label}</Badge>
        {item.detail ? <span className="text-muted-foreground text-xs text-pretty">{item.detail}</span> : null}
      </div>
    ),
  },
  {
    // Kept on wider screens; on a phone the whole row is the way to the
    // inspection (`rowHref`), since this column is hidden there.
    key: 'inspection',
    header: 'Inspection',
    hideBelow: 'sm',
    cell: (item) =>
      item.inspection ? (
        <Link className="text-primary relative z-10 text-sm hover:underline" href={`/inspections/${item.inspection.id}`}>
          Open
        </Link>
      ) : (
        EMPTY
      ),
  },
];

const changeColumns: Array<Column<LeaseScheduleChange>> = [
  { key: 'day', header: 'Day', primary: true, cell: (change) => formatScheduledDate(change.scheduledOn) },
  { key: 'kind', header: 'Type', cell: (change) => KIND[change.kind] },
  {
    key: 'property',
    header: 'Property',
    cell: (change) => [change.property.address, change.property.city].filter(Boolean).join(', ') || EMPTY,
  },
  {
    key: 'action',
    header: 'What happens',
    className: 'max-w-sm',
    cell: (change) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{ACTION[change.action]}</span>
        {change.detail ? <span className="text-muted-foreground text-xs text-pretty">{change.detail}</span> : null}
      </div>
    ),
  },
];

function TabCount({ value }: { value: number }) {
  return <span className="text-muted-foreground font-mono text-xs tabular-nums">{value.toLocaleString()}</span>;
}

export default function LeaseSchedulePage() {
  const { has } = usePermissions();
  const canRun = has('inspections:manage');
  const schedule = useLeaseSchedule();
  const run = useLeaseScheduleRun();
  const [preview, setPreview] = useState<LeaseScheduleRun | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [tab, setTab] = useState('coming');

  const items = schedule.data?.items ?? [];
  const comingUp = items.filter((item) => COMING_UP.includes(item.outcome));
  const attention = items.filter((item) => ATTENTION.includes(item.outcome));
  const calledOff = items.filter((item) => !COMING_UP.includes(item.outcome) && !ATTENTION.includes(item.outcome));
  const state = schedule.data?.schedule;

  const previewRun = () =>
    run.mutate(true, {
      onSuccess: setPreview,
      onError: (error) => toast.error('The preview could not be made', { description: error.message }),
    });
  const bookNow = () =>
    run.mutate(false, {
      onSuccess: (result) => {
        setConfirming(false);
        setPreview(null);
        toast.success('The leases are up to date', { description: countsSentence(result.counts, false) });
      },
      onError: (error) => toast.error('The run did not finish', { description: error.message }),
    });

  const header = (
    <PageHeader
      actions={
        canRun ? (
          <>
            {/* The safe action carries the weight; the one that writes onto
                technicians' phones is the quieter one, behind its confirmation
                (console-development). */}
            <Button disabled={run.isPending} onClick={previewRun} size="sm">
              {run.isPending && run.variables === true ? <Spinner /> : <EyeIcon />}
              Preview
            </Button>
            <Button disabled={run.isPending} onClick={() => setConfirming(true)} size="sm" variant="outline">
              <SendIcon />
              Book now
            </Button>
          </>
        ) : null
      }
      description="Booked from Propertyware's leases."
      info={
        <>
          <p>
            A <b>move-out</b> the day after every lease ends, booked 60 days ahead, or at once when the
            tenant gives notice, for whoever handles move-outs.
          </p>
          <p>
            A <b>move-in</b> 22 days after a leaving tenant goes, booked up to 90 days ahead, for whoever
            handles move-ins. A missed move-in goes on the next working day.
          </p>
          <p>
            What the office books in Jobber comes first: one near the day is linked, never doubled, and one
            booked here gives way to it.
          </p>
        </>
      }
      infoLabel="How booking works"
      title="Move-ins & move-outs"
    />
  );

  if (schedule.isLoading)
    return (
      <>
        {header}
        <PageSkeleton cards={2} />
      </>
    );
  if (schedule.isError)
    return (
      <>
        {header}
        <ErrorState error={schedule.error} retry={() => void schedule.refetch()} />
      </>
    );

  const table = (rows: LeaseScheduleItem[], label: string) =>
    rows.length ? (
      <DataTable
        columns={itemColumns}
        label={label}
        // The row opens its inspection where there is one (console-development):
        // the Inspection column is hidden on a phone, and was the only way there.
        rowHref={(item) => (item.inspection ? `/inspections/${item.inspection.id}` : undefined)}
        rowKey={(item) => item.id}
        rows={rows}
      />
    ) : (
      <EmptyState description="Nothing here from the last week onward." icon={CalendarClockIcon} title={`No ${label.toLowerCase()}`} />
    );

  return (
    <>
      {header}
      <div className="grid gap-4">
        {/* No detail lines that repeat the (i) beside the title
            (console-development): the rules are said once, there. */}
        <StatGroup columns="grid-cols-2 lg:grid-cols-4">
          <Stat label="Coming up" value={comingUp.length.toLocaleString()} />
          <Stat
            label="Move-outs"
            value={comingUp.filter((item) => item.kind === 'MOVE_OUT').length.toLocaleString()}
          />
          <Stat
            label="Move-ins"
            value={comingUp.filter((item) => item.kind === 'MOVE_IN').length.toLocaleString()}
          />
          <Stat
            detail="a unit to choose, or a reason it could not be booked"
            label="Needs attention"
            tone={attention.length ? 'warning' : 'default'}
            value={attention.length.toLocaleString()}
          />
        </StatGroup>

        <StatStrip title="Booking">
          {/* Both times read the same way, relative with the exact moment on
              hover (console-development); one was a date and one "2 hours ago". */}
          <StatStripItem
            label="Daily run"
            value={
              state?.enabled ? (
                <>
                  on
                  {state.nextRunAt ? (
                    <>
                      , next{' '}
                      <span title={formatDateTime(state.nextRunAt)}>{formatRelative(state.nextRunAt)}</span>
                    </>
                  ) : null}
                </>
              ) : (
                'off until it is switched on on the server'
              )
            }
          />
          {state?.lastRun ? (
            <StatStripItem
              label="Last run"
              value={
                <>
                  <span title={formatDateTime(state.lastRun.at)}>{formatRelative(state.lastRun.at)}</span>:{' '}
                  {countsSentence(state.lastRun.counts, false)}
                </>
              }
            />
          ) : null}
        </StatStrip>

        <Tabs onValueChange={setTab} value={tab}>
          {/* The counts as quiet figures beside the names (console-development). */}
          <TabsList>
            <TabsTrigger value="coming">
              Coming up <TabCount value={comingUp.length} />
            </TabsTrigger>
            <TabsTrigger value="attention">
              Needs attention <TabCount value={attention.length} />
            </TabsTrigger>
            <TabsTrigger value="off">
              Called off <TabCount value={calledOff.length} />
            </TabsTrigger>
          </TabsList>
          <TabsContent className="mt-3" value="coming">
            {table(comingUp, 'Move-ins and move-outs coming up')}
          </TabsContent>
          <TabsContent className="mt-3" value="attention">
            {table(attention, 'Move-ins and move-outs needing attention')}
          </TabsContent>
          <TabsContent className="mt-3" value="off">
            {table(calledOff, 'Move-ins and move-outs called off')}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog onOpenChange={(open) => (open ? undefined : setPreview(null))} open={Boolean(preview)}>
        <DialogContent className="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>What a run would do today</DialogTitle>
            <DialogDescription>
              {preview
                ? `${preview.leases.toLocaleString()} leases read: ${countsSentence(preview.counts, true)}. Nothing has been booked.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {preview?.changes.length ? (
            <DataTable
              columns={changeColumns}
              label="What a run would do"
              rowKey={(change) => `${change.leaseId}|${change.kind}`}
              rows={preview.changes}
            />
          ) : null}
          {canRun && preview?.changes.length ? (
            <div className="flex justify-end">
              <Button disabled={run.isPending} onClick={() => setConfirming(true)}>
                <SendIcon />
                Book these now
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Book the move-ins and move-outs now?</AlertDialogTitle>
            <AlertDialogDescription>
              Each one the leases call for is created as an inspection and put on its technician’s phone. Ones the office
              already booked are linked, not doubled, and one booked here that the office has since booked itself is
              called off. Preview first to see the list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              disabled={run.isPending}
              onClick={(event) => {
                event.preventDefault();
                bookNow();
              }}
            >
              {run.isPending && run.variables === false ? <Spinner /> : null}
              Book now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
