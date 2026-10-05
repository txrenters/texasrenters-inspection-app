'use client';

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PencilIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePermissions } from '@/lib/auth';
import { businessDateTimeValue, businessToday, fromBusinessDateTimeValue, shiftDay } from '@/lib/clock';
import { formatTime } from '@/lib/format';
import {
  asHours,
  useTimesheet,
  useTimesheetActions,
  type TimesheetTotal,
  type TimesheetVisit,
} from '@/lib/timesheet-queries';

/**
 * The hours a technician worked, one Texas day at a time.
 *
 * Start job and End job play no part in it. A technician looks round a
 * property before pressing Start and does not always press End when they
 * leave, so the clock follows the technician instead: it runs while they are
 * inside the 20 m circle of a property they have a visit at, and everything
 * else between the first arrival of the day and the last departure is general
 * time.
 *
 * One day, and one row per property on it -- the office, 2026-10-06. A range
 * drew every stretch of a fortnight to show a handful of them, and its two
 * ends could be put the wrong way round, which from Manila happened on the
 * first morning because "today" there is already tomorrow in Texas. And a
 * technician who stepped out to the van three times was at that house once;
 * the row says when they first arrived, when they last left, and how long of
 * that they were inside.
 */

/**
 * How far back the trail goes, and so how far back recalculating can reach.
 *
 * The fixes are pruned after thirty days. Older days keep the hours they have
 * -- the server will not rewrite a day it has no trail for.
 */
const TRAIL_DAYS = 30;

/** Below this a silence is not worth a badge. */
const QUIET_WORTH_SAYING_SECONDS = 60;

const dateField = 'h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground';

/** "Tuesday, October 6", for a day held as `yyyy-MM-dd`. Noon UTC is the same date everywhere. */
const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

export default function TimesheetPage() {
  const { has } = usePermissions();
  const canChange = has('inspections:manage');
  const today = businessToday();
  const [date, setDate] = useState(today);
  const [technicianId, setTechnicianId] = useState<string | undefined>(undefined);
  const sheet = useTimesheet(date, technicianId);
  const actions = useTimesheetActions();

  const [correcting, setCorrecting] = useState<TimesheetVisit | null>(null);
  /** What the last recalculation did, in the office's words rather than counts. */
  const [recalculated, setRecalculated] = useState<string | null>(null);

  const recalculate = (from: string, to: string) =>
    actions.recalculate.mutate(
      { from, to },
      {
        onSuccess: (result) =>
          setRecalculated(
            result.changed === 0
              ? `${result.days === 1 ? 'This day already says' : 'These days already say'} what the trail says. Nothing changed.`
              : `Read ${result.days} ${result.days === 1 ? 'day' : 'days'} again. ` +
                  `${result.changed} technician-${result.changed === 1 ? 'day' : 'days'} changed; ` +
                  'hours corrected by hand were left as they are.',
          ),
        onError: (error) => toast.error('The hours could not be recalculated', { description: error.message }),
      },
    );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 pb-4">
      <Button
        aria-label="The day before"
        onClick={() => setDate((current) => shiftDay(current, -1))}
        size="icon"
        variant="outline"
      >
        <ChevronLeftIcon />
      </Button>
      <DatePicker
        aria-label="The day to show"
        className="w-auto min-w-56"
        max={today}
        // Clearing the picker is not a day; it falls back to today rather than
        // asking for the hours of no date at all.
        onChange={(next) => setDate(next || today)}
        value={date}
      />
      <Button
        aria-label="The day after"
        disabled={date >= today}
        onClick={() => setDate((current) => shiftDay(current, 1))}
        size="icon"
        variant="outline"
      >
        <ChevronRightIcon />
      </Button>
      {date !== today ? (
        <Button onClick={() => setDate(today)} size="sm" variant="secondary">
          Today
        </Button>
      ) : null}
      {technicianId ? (
        <Button onClick={() => setTechnicianId(undefined)} size="sm" variant="secondary">
          All technicians
        </Button>
      ) : null}
      {/*
        Today and yesterday are read without anybody asking. This is for the
        days behind them: after a property's pin or its distances are
        corrected, and once after the rule itself changes -- which is the
        thirty days, read in one go on the server rather than drawn here.

        It leaves alone every hour somebody corrected by hand, and pressing it
        twice gives the same answer, which is what makes it safe to leave in
        the toolbar rather than behind a warning.
      */}
      {canChange ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="ml-auto" disabled={actions.recalculate.isPending} size="sm" variant="secondary">
              {actions.recalculate.isPending ? 'Reading the trail…' : 'Recalculate'}
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => recalculate(date, date)}>This day</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => recalculate(shiftDay(today, -(TRAIL_DAYS - 1)), today)}>
              The last {TRAIL_DAYS} days
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );

  const header = (
    <PageHeader
      title="Timesheet"
      description="The clock runs while a technician is inside a property’s circle. Everything between properties is general time."
    />
  );

  if (sheet.isLoading)
    return (
      <>
        {header}
        {toolbar}
        <PageSkeleton />
      </>
    );
  if (sheet.isError)
    return (
      <>
        {header}
        {toolbar}
        <ErrorState error={sheet.error} retry={() => void sheet.refetch()} />
      </>
    );

  const data = sheet.data!;
  const onsiteTotal = data.totals.reduce((sum, row) => sum + row.onsiteSeconds, 0);
  const generalTotal = data.totals.reduce((sum, row) => sum + row.generalSeconds, 0);

  const totalColumns: Column<TimesheetTotal>[] = [
    {
      key: 'technician',
      header: 'Technician',
      primary: true,
      cell: (row) => (
        <button
          className="font-medium underline-offset-2 hover:underline"
          onClick={() => setTechnicianId(row.technicianId)}
          type="button"
        >
          {row.technician}
        </button>
      ),
    },
    { key: 'onsite', header: 'On site', numeric: true, cell: (row) => asHours(row.onsiteSeconds) },
    { key: 'general', header: 'General time', numeric: true, cell: (row) => asHours(row.generalSeconds) },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (row) => <span className="font-medium">{asHours(row.totalSeconds)}</span>,
    },
    {
      // Inside the total, not beside it. Its own column so that a day carried
      // through a long silence does not look the same as one that was measured.
      key: 'quiet',
      header: 'Phone quiet',
      numeric: true,
      hideBelow: 'md',
      cell: (row) => (
        <span className="text-muted-foreground">
          {row.quietSeconds >= QUIET_WORTH_SAYING_SECONDS ? asHours(row.quietSeconds) : '—'}
        </span>
      ),
    },
  ];

  const visitColumns: Column<TimesheetVisit>[] = [
    { key: 'technician', header: 'Technician', primary: true, cell: (row) => row.technician },
    { key: 'property', header: 'Property', cell: (row) => row.address ?? '—' },
    { key: 'arrived', header: 'Arrived', cell: (row) => formatTime(row.arrivedAt) },
    { key: 'left', header: 'Left', cell: (row) => formatTime(row.leftAt) },
    {
      key: 'notes',
      header: '',
      hideBelow: 'md',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Said plainly. Somebody paid from this is entitled to know which
              hours a person decided rather than the trail, and which the
              trail could only answer by carrying the clock through a silence. */}
          {row.adjusted ? <Badge variant="outline">Corrected</Badge> : null}
          {row.addedByHand ? <Badge variant="outline">Added by hand</Badge> : null}
          {row.stays > 1 ? (
            <Badge variant="outline">
              Stepped out {row.stays - 1} {row.stays === 2 ? 'time' : 'times'}
            </Badge>
          ) : null}
          {row.quietSeconds >= QUIET_WORTH_SAYING_SECONDS ? (
            <Badge variant="outline">Phone quiet {asHours(row.quietSeconds)}</Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: 'onsite',
      header: 'On site',
      numeric: true,
      cell: (row) => <span className="font-medium">{asHours(row.onsiteSeconds)}</span>,
    },
    ...(canChange
      ? [
          {
            key: 'correct',
            header: '',
            cell: (row: TimesheetVisit) => (
              <Button
                aria-label={`Correct the time at ${row.address ?? 'this property'}`}
                className="relative z-10"
                onClick={() => setCorrecting(row)}
                size="sm"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
            ),
          } satisfies Column<TimesheetVisit>,
        ]
      : []),
  ];

  return (
    <>
      {header}
      {toolbar}

      {recalculated ? <p className="text-muted-foreground -mt-2 pb-4 text-xs">{recalculated}</p> : null}

      <StatGroup columns="grid-cols-1 sm:grid-cols-3">
        <Stat label="On site" value={asHours(onsiteTotal)} />
        <Stat label="General time" value={asHours(generalTotal)} />
        <Stat label="Total" value={asHours(onsiteTotal + generalTotal)} />
      </StatGroup>

      <section className="mt-6">
        <h2 className="text-foreground mb-2 text-sm font-semibold">Hours by technician · {dayLabel(date)}</h2>
        {data.totals.length ? (
          <DataTable
            columns={totalColumns}
            label="Hours by technician"
            rowKey={(row) => row.technicianId}
            rows={data.totals}
          />
        ) : (
          <EmptyState
            description="Nobody was inside the circle of a property they had a visit at. If somebody was working, check the property’s pin and its distances, then recalculate this day."
            title="Nothing recorded on this day"
          />
        )}
      </section>

      {data.visits.length ? (
        <section className="mt-6">
          <h2 className="text-foreground mb-2 text-sm font-semibold">Time at each property</h2>
          <DataTable
            columns={visitColumns}
            label="Time at each property"
            rowKey={(row) => row.key}
            rows={data.visits}
          />
        </section>
      ) : null}

      <CorrectDialog
        onClose={() => setCorrecting(null)}
        onSave={(startedAt, endedAt, reason) => {
          if (!correcting) return;
          actions.correct.mutate(
            { segmentIds: correcting.segmentIds, startedAt, endedAt, reason },
            {
              onSuccess: (saved) =>
                toast.success(`Corrected to ${asHours(saved.durationSeconds)} on site`, {
                  description: 'What the trail said is kept beside it.',
                }),
              onError: (error) => toast.error('That could not be saved', { description: error.message }),
            },
          );
          setCorrecting(null);
        }}
        visit={correcting}
      />
    </>
  );
}

/**
 * Correcting a technician's time at one property.
 *
 * The row is the whole visit, so the correction is too: whatever stretches
 * are behind it become one, on site from here to here. Both ends are asked
 * for even when only one moves -- "it ran from here to here" can be checked
 * afterwards in a way that "make it end later" cannot. The reason is
 * required, and it is what the technician is shown if they ever ask why their
 * hours changed.
 */
function CorrectDialog({
  visit,
  onClose,
  onSave,
}: {
  visit: TimesheetVisit | null;
  onClose: () => void;
  onSave: (startedAt: string, endedAt: string, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [startedAt, setStartedAt] = useState('');
  const [endedAt, setEndedAt] = useState('');

  // Filled from the visit the first time it opens, then left to the person.
  if (visit && !startedAt) {
    setStartedAt(businessDateTimeValue(visit.arrivedAt));
    setEndedAt(businessDateTimeValue(visit.leftAt));
  }

  const close = () => {
    setReason('');
    setStartedAt('');
    setEndedAt('');
    onClose();
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : close())} open={Boolean(visit)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct the time at {visit?.address ?? 'this property'}</DialogTitle>
          <DialogDescription>
            {visit
              ? `${visit.technician} was inside the circle for ${asHours(visit.onsiteSeconds)} between ` +
                `${formatTime(visit.arrivedAt)} and ${formatTime(visit.leftAt)}. `
              : ''}
            Saving makes it on site the whole time from the start to the end below. What the trail said is
            kept beside it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            Arrived (Texas time)
            <input
              className={dateField}
              onChange={(event) => setStartedAt(event.target.value)}
              type="datetime-local"
              value={startedAt}
            />
          </label>
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            Left (Texas time)
            <input
              className={dateField}
              onChange={(event) => setEndedAt(event.target.value)}
              type="datetime-local"
              value={endedAt}
            />
          </label>
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            Why
            <textarea
              className="border-border bg-card text-foreground min-h-20 rounded-lg border px-2 py-1.5 text-sm"
              onChange={(event) => setReason(event.target.value)}
              placeholder="Technician was on site; the phone was in the van."
              value={reason}
            />
          </label>
        </div>
        <DialogFooter>
          <Button onClick={close} variant="secondary">
            Cancel
          </Button>
          <Button
            disabled={
              reason.trim().length < 4 || !fromBusinessDateTimeValue(startedAt) || !fromBusinessDateTimeValue(endedAt)
            }
            onClick={() =>
              onSave(fromBusinessDateTimeValue(startedAt)!, fromBusinessDateTimeValue(endedAt)!, reason.trim())
            }
          >
            Save the correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
