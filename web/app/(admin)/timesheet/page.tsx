'use client';

import { ChevronDownIcon, PencilIcon } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { toast } from 'sonner';

import { DataTable, type Column } from '@/components/data-table';
import { DayFilter } from '@/components/day-filter';
import { SelectFilter } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { usePermissions } from '@/lib/auth';
import { businessDateTimeValue, businessToday, fromBusinessDateTimeValue, shiftDay } from '@/lib/clock';
import { formatDay, formatTime } from '@/lib/format';
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

/** Below this a silence is not worth a mention. */
const QUIET_WORTH_SAYING_SECONDS = 60;

/** The shortest reason the Save button accepts. */
const REASON_MIN_LENGTH = 4;

/**
 * What a person or a silence did to a visit's hours, in words. Every one of
 * them, at every width (console-development): they used to be four boxed chips
 * in a blank-headed column that a phone hid, and somebody paid from this is
 * entitled to know which hours a person decided rather than the trail, and
 * which the trail could only answer by carrying the clock through a silence.
 */
function payFlags(row: TimesheetVisit): string[] {
  return [
    row.adjusted ? 'Corrected' : null,
    row.addedByHand ? 'Added by hand' : null,
    row.stays > 1 ? `Stepped out ${row.stays - 1} ${row.stays === 2 ? 'time' : 'times'}` : null,
    row.quietSeconds >= QUIET_WORTH_SAYING_SECONDS ? `Phone quiet ${asHours(row.quietSeconds)}` : null,
  ].filter((flag): flag is string => Boolean(flag));
}

export default function TimesheetPage() {
  const { has } = usePermissions();
  const canChange = has('inspections:manage');
  const today = businessToday();
  const [date, setDate] = useState(today);
  const [technicianId, setTechnicianId] = useState<string | undefined>(undefined);
  // The whole day, for the technician picker: the filtered sheet holds only the
  // one technician chosen, and the picker has to offer the rest. The same query
  // as the sheet itself when nobody is picked, so it costs nothing then.
  const everyone = useTimesheet(date);
  const sheet = useTimesheet(date, technicianId);
  const actions = useTimesheetActions();

  const [correcting, setCorrecting] = useState<TimesheetVisit | null>(null);
  /** What the last recalculation did, in the office's words rather than counts. */
  const [recalculated, setRecalculated] = useState<string | null>(null);

  // A result describes the day it was asked on; it goes when the day does
  // (console-development), rather than sitting under a different date.
  const changeDate = (next: string | null) => {
    setDate(next ?? today);
    setRecalculated(null);
  };

  const technicianOptions = (everyone.data?.totals ?? []).map((row) => ({
    value: row.technicianId,
    label: row.technician,
  }));
  // A technician picked on another day may have no hours on this one; still
  // name them, so the filter never reads as "all" while it is narrowing.
  if (technicianId && !technicianOptions.some((option) => option.value === technicianId)) {
    const name = sheet.data?.totals.find((row) => row.technicianId === technicianId)?.technician;
    technicianOptions.push({ value: technicianId, label: name ?? 'Selected technician' });
  }

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
    <>
      <div className="flex flex-wrap items-center gap-2 pb-4">
        {/* The same day stepper as the lists (console-development). Never past
            today -- tomorrow has no hours yet -- and never "all dates", which a
            timesheet read one day at a time has no use for. */}
        <DayFilter allowAllDates={false} label="The day to show" max={today} onChange={changeDate} value={date} />
        {/* Clicking a name in the table still filters too; this says that it
            has, and is the way back (console-development). */}
        <SelectFilter
          allLabel="All technicians"
          label="Technician"
          onChange={(next) => setTechnicianId(next || undefined)}
          options={technicianOptions}
          value={technicianId ?? ''}
        />
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
              <Button className="ml-auto" disabled={actions.recalculate.isPending} size="sm" variant="outline">
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
      {/* Always mounted, so a screen reader hears the result when it arrives. */}
      <p aria-live="polite" className={recalculated ? 'text-muted-foreground -mt-2 pb-4 text-xs' : 'sr-only'}>
        {recalculated}
      </p>
    </>
  );

  const header = (
    <PageHeader
      info={
        <p>
          The clock runs while a technician is inside a property’s circle. Everything between
          properties is general time.
        </p>
      }
      infoLabel="How the hours are counted"
      title="Timesheet"
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
          title={`Show only ${row.technician}`}
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
    {
      key: 'property',
      header: 'Property',
      cell: (row) => {
        const flags = payFlags(row);
        return (
          <div className="min-w-0">
            <div>{row.address ?? '—'}</div>
            {flags.length ? (
              <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-1.5 text-xs">
                {flags.map((flag, index) => (
                  <Fragment key={flag}>
                    {index ? <span aria-hidden>·</span> : null}
                    <span>{flag}</span>
                  </Fragment>
                ))}
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'arrived',
      header: 'Arrived',
      cell: (row) => <span className="font-mono tabular-nums">{formatTime(row.arrivedAt)}</span>,
    },
    {
      key: 'left',
      header: 'Left',
      cell: (row) => <span className="font-mono tabular-nums">{formatTime(row.leftAt)}</span>,
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
                size="icon-sm"
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

      <StatGroup columns="grid-cols-1 sm:grid-cols-3">
        <Stat label="On site" value={asHours(onsiteTotal)} />
        <Stat label="General time" value={asHours(generalTotal)} />
        <Stat label="Total" value={asHours(onsiteTotal + generalTotal)} />
      </StatGroup>

      {/* Panels with a quiet name, not h2 headings over floating tables
          (console-development). */}
      {data.totals.length ? (
        <Panel className="mt-6" count={formatDay(date, 'long')} title="Hours by technician">
          <DataTable
            className="rounded-none border-0"
            columns={totalColumns}
            label="Hours by technician"
            rowKey={(row) => row.technicianId}
            rows={data.totals}
          />
        </Panel>
      ) : (
        <div className="mt-6">
          <EmptyState
            description="Nobody was inside the circle of a property they had a visit at. If somebody was working, check the property’s pin and its distances, then recalculate this day."
            title="Nothing recorded on this day"
          />
        </div>
      )}

      {data.visits.length ? (
        <Panel className="mt-6" title="Time at each property">
          <DataTable
            className="rounded-none border-0"
            columns={visitColumns}
            label="Time at each property"
            rowKey={(row) => row.key}
            rows={data.visits}
          />
        </Panel>
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
  const id = useId();
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
          <Field>
            <FieldLabel htmlFor={`${id}-arrived`}>Arrived (Texas time)</FieldLabel>
            <Input
              className="font-mono tabular-nums"
              id={`${id}-arrived`}
              onChange={(event) => setStartedAt(event.target.value)}
              type="datetime-local"
              value={startedAt}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-left`}>Left (Texas time)</FieldLabel>
            <Input
              className="font-mono tabular-nums"
              id={`${id}-left`}
              onChange={(event) => setEndedAt(event.target.value)}
              type="datetime-local"
              value={endedAt}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-reason`}>Why</FieldLabel>
            <Textarea
              aria-describedby={`${id}-reason-help`}
              className="min-h-20"
              id={`${id}-reason`}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Technician was on site; the phone was in the van."
              value={reason}
            />
            {/* Says why Save is greyed out before anybody wonders. */}
            <FieldDescription id={`${id}-reason-help`}>
              At least {REASON_MIN_LENGTH} characters. The technician is shown this if they ask why
              their hours changed.
            </FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={close} variant="secondary">
            Cancel
          </Button>
          <Button
            disabled={
              reason.trim().length < REASON_MIN_LENGTH ||
              !fromBusinessDateTimeValue(startedAt) ||
              !fromBusinessDateTimeValue(endedAt)
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
