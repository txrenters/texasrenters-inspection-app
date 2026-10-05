'use client';

import { PencilIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePermissions } from '@/lib/auth';
import { businessDateTimeValue, businessToday, fromBusinessDateTimeValue, shiftDay } from '@/lib/clock';
import { formatDateTime } from '@/lib/format';
import {
  asHours,
  useTimesheet,
  useTimesheetActions,
  type TimesheetSegment,
  type TimesheetTotal,
} from '@/lib/timesheet-queries';

/**
 * The hours a technician worked, read from where they actually were.
 *
 * Start job and End job play no part in it. A technician looks round a
 * property before pressing Start and does not always press End when they
 * leave, so the office asked on 2026-10-06 for the clock to follow the
 * technician instead: it runs while they are inside the 20 m circle of a
 * property they have a visit at, and everything else between the first arrival
 * of the day and the last departure is general time.
 *
 * Two figures and their total, then, and no third pile. The page used to keep
 * a list of stretches the phone had gone quiet for, each to be settled by hand
 * before anybody was paid -- 59 of them in one fortnight, nearly all of them a
 * phone indoors for a few minutes. Those minutes are counted now, and marked,
 * so the office can still see which hours were measured and which were carried
 * through a silence; and a correction still says that a person made it.
 */

/** The last fortnight, which is the period the office settles pay over, in Texas days. */
function defaultRange() {
  const today = businessToday();
  return { from: shiftDay(today, -13), to: today };
}

const CATEGORY = {
  ONSITE: { label: 'On site', variant: 'success' },
  GENERAL: { label: 'General time', variant: 'secondary' },
} as const;

/**
 * Below this a silence is not worth a badge.
 *
 * The rule only calls the phone quiet after five minutes without a fix, so
 * anything it reports is already longer than this; the floor is here so a
 * rounding remainder on a piece of a corrected stretch never shows as "0m".
 */
const QUIET_WORTH_SAYING_SECONDS = 60;

const dateField =
  'h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground';

export default function TimesheetPage() {
  const { has } = usePermissions();
  const canChange = has('inspections:manage');
  const [range, setRange] = useState(defaultRange);
  const [technicianId, setTechnicianId] = useState<string | undefined>(undefined);
  const sheet = useTimesheet(range.from, range.to, technicianId);
  const actions = useTimesheetActions();

  const [adjusting, setAdjusting] = useState<TimesheetSegment | null>(null);
  /** What the last recalculation did, in the office's words rather than counts. */
  const [recalculated, setRecalculated] = useState<string | null>(null);

  if (sheet.isLoading) return <PageSkeleton />;
  if (sheet.isError) return <ErrorState error={sheet.error} retry={() => void sheet.refetch()} />;

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
      cell: (row) =>
        row.quietSeconds >= QUIET_WORTH_SAYING_SECONDS ? (
          <span className="text-muted-foreground">{asHours(row.quietSeconds)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  const segmentColumns: Column<TimesheetSegment>[] = [
    { key: 'technician', header: 'Technician', primary: true, cell: (row) => row.technician },
    {
      key: 'property',
      header: 'Property',
      cell: (row) =>
        row.address ?? <span className="text-muted-foreground">Between properties</span>,
    },
    {
      key: 'what',
      header: 'What',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={CATEGORY[row.category].variant}>{CATEGORY[row.category].label}</Badge>
          {/* Said plainly. Somebody paid from this is entitled to know which
              numbers a person decided rather than the trail, and which the
              trail could only answer by carrying the clock through a silence. */}
          {row.adjusted ? <Badge variant="outline">Corrected</Badge> : null}
          {row.source === 'MANUAL' ? <Badge variant="outline">Added by hand</Badge> : null}
          {row.quietSeconds >= QUIET_WORTH_SAYING_SECONDS ? (
            <Badge variant="outline">Phone quiet {asHours(row.quietSeconds)}</Badge>
          ) : null}
        </div>
      ),
    },
    { key: 'from', header: 'From', hideBelow: 'md', cell: (row) => formatDateTime(row.startedAt) },
    { key: 'to', header: 'To', hideBelow: 'lg', cell: (row) => formatDateTime(row.endedAt) },
    { key: 'time', header: 'Time', numeric: true, cell: (row) => asHours(row.durationSeconds) },
    ...(canChange
      ? [
          {
            key: 'correct',
            header: '',
            cell: (row: TimesheetSegment) => (
              <Button
                aria-label={`Correct this ${CATEGORY[row.category].label} time`}
                className="relative z-10"
                onClick={() => setAdjusting(row)}
                size="sm"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
            ),
          } satisfies Column<TimesheetSegment>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Timesheet"
        description="The clock runs while a technician is inside a property’s circle. Everything between properties is general time."
      />

      <div className="flex flex-wrap items-end gap-3 pb-4">
        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
          From
          <input
            className={dateField}
            onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))}
            type="date"
            value={range.from}
          />
        </label>
        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
          To
          <input
            className={dateField}
            onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))}
            type="date"
            value={range.to}
          />
        </label>
        {technicianId ? (
          <Button onClick={() => setTechnicianId(undefined)} size="sm" variant="secondary">
            All technicians
          </Button>
        ) : null}
        {/*
          Today and yesterday are read without anybody asking. This is for the
          days behind them: after a property's pin or its distances are
          corrected, and once after the rule itself changes.

          It leaves alone every hour somebody corrected by hand, and pressing
          it twice gives the same answer -- which is what makes it safe to
          leave in the toolbar rather than behind a warning.
        */}
        {canChange ? (
          <Button
            disabled={actions.recalculate.isPending}
            onClick={() =>
              actions.recalculate.mutate(
                { from: range.from, to: range.to },
                {
                  onSuccess: (result) =>
                    setRecalculated(
                      result.changed === 0
                        ? 'These days already say what the trail says. Nothing changed.'
                        : `Read ${result.days} ${result.days === 1 ? 'day' : 'days'} again. ` +
                            `${result.changed} technician-${result.changed === 1 ? 'day' : 'days'} changed; ` +
                            'hours corrected by hand were left as they are.',
                    ),
                  onError: (error) =>
                    toast.error('These days could not be recalculated', { description: error.message }),
                },
              )
            }
            size="sm"
            variant="secondary"
          >
            {actions.recalculate.isPending ? 'Reading the trail…' : 'Recalculate these days'}
          </Button>
        ) : null}
      </div>

      {recalculated ? <p className="text-muted-foreground -mt-2 pb-4 text-xs">{recalculated}</p> : null}

      <StatGroup columns="grid-cols-1 sm:grid-cols-3">
        <Stat label="On site" value={asHours(onsiteTotal)} />
        <Stat label="General time" value={asHours(generalTotal)} />
        <Stat label="Total" value={asHours(onsiteTotal + generalTotal)} />
      </StatGroup>

      <section className="mt-6">
        <h2 className="text-foreground mb-2 text-sm font-semibold">Hours by technician</h2>
        {data.totals.length ? (
          <DataTable
            columns={totalColumns}
            label="Hours by technician"
            rowKey={(row) => row.technicianId}
            rows={data.totals}
          />
        ) : (
          <EmptyState
            description="Nobody was inside the circle of a property they had a visit at. If somebody was working, check the property’s pin and its distances, then recalculate."
            title="Nothing recorded in these days"
          />
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-foreground mb-2 text-sm font-semibold">Every stretch</h2>
        {data.segments.length ? (
          <DataTable
            columns={segmentColumns}
            label="Every stretch of time"
            rowKey={(row) => row.id}
            rows={data.segments}
          />
        ) : (
          <EmptyState title="No stretches in these days" />
        )}
      </section>

      <AdjustDialog
        onClose={() => setAdjusting(null)}
        onSave={(startedAt, endedAt, reason) => {
          if (!adjusting) return;
          actions.adjust.mutate(
            { segmentId: adjusting.id, startedAt, endedAt, reason },
            {
              onSuccess: (saved) =>
                toast.success(`Corrected to ${asHours(saved.durationSeconds)}`, {
                  description: 'What the trail said is kept beside it.',
                }),
              onError: (error) => toast.error('That could not be saved', { description: error.message }),
            },
          );
          setAdjusting(null);
        }}
        segment={adjusting}
      />
    </>
  );
}


/**
 * Correcting a stretch the trail got wrong.
 *
 * Both ends are asked for even when only one moves: "it ran from here to here"
 * can be checked afterwards in a way that "make it end later" cannot. The
 * reason is required, and it is what the technician is shown if they ever ask
 * why their hours changed.
 */
function AdjustDialog({
  segment,
  onClose,
  onSave,
}: {
  segment: TimesheetSegment | null;
  onClose: () => void;
  onSave: (startedAt: string, endedAt: string, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [startedAt, setStartedAt] = useState('');
  const [endedAt, setEndedAt] = useState('');

  // Filled from the segment the first time it opens, then left to the person.
  if (segment && !startedAt) {
    setStartedAt(businessDateTimeValue(segment.startedAt));
    setEndedAt(businessDateTimeValue(segment.endedAt));
  }

  const close = () => {
    setReason('');
    setStartedAt('');
    setEndedAt('');
    onClose();
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : close())} open={Boolean(segment)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct this time</DialogTitle>
          <DialogDescription>
            {segment?.technician}, {segment?.address ? `at ${segment.address}` : 'between properties'}. The trail said{' '}
            {segment ? asHours(segment.durationSeconds) : ''}, and that is kept beside whatever you
            put here.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            From (Texas time)
            <input
              className={dateField}
              onChange={(event) => setStartedAt(event.target.value)}
              type="datetime-local"
              value={startedAt}
            />
          </label>
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            To (Texas time)
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
            disabled={reason.trim().length < 4 || !fromBusinessDateTimeValue(startedAt) || !fromBusinessDateTimeValue(endedAt)}
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
