'use client';

import { AlertTriangleIcon, PencilIcon } from 'lucide-react';
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
import { formatDateTime } from '@/lib/format';
import {
  asHours,
  useTimesheet,
  useTimesheetActions,
  type TimesheetGap,
  type TimesheetSegment,
  type TimesheetTotal,
} from '@/lib/timesheet-queries';

/**
 * The hours a technician is paid for, read from where they actually were.
 *
 * This replaces Start job / End job as the number payroll runs on. A month of
 * real work measured on 2026-09-23 found the buttons wrong in both directions:
 * one visit recorded 43.9 hours because End was never pressed, and others
 * recorded seven and eight minutes for visits the trail shows ran to two hours.
 *
 * The rule of this page is that nothing is hidden from the person being paid.
 * Time the trail could not account for sits beside the hours and never inside
 * them; a correction says who made it and why; and the difference between what
 * the trail said and what somebody decided stays visible on the row.
 */

/** The last fortnight, which is the period the office settles pay over. */
function defaultRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 13);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(today) };
}

const CATEGORY: Record<string, { label: string; variant: 'success' | 'info' | 'secondary' }> = {
  ONSITE: { label: 'On site', variant: 'success' },
  DRIVING: { label: 'Driving', variant: 'info' },
  GENERAL: { label: 'General', variant: 'secondary' },
};

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
  const [settling, setSettling] = useState<TimesheetGap | null>(null);
  /** What the last fill found, in the office's words rather than counts. */
  const [filled, setFilled] = useState<string | null>(null);

  if (sheet.isLoading) return <PageSkeleton />;
  if (sheet.isError) return <ErrorState error={sheet.error} retry={() => void sheet.refetch()} />;

  const data = sheet.data!;
  const openGaps = data.gaps.filter((gap) => !gap.resolved);
  const onsiteTotal = data.totals.reduce((sum, row) => sum + row.onsiteSeconds, 0);
  const gapTotal = data.totals.reduce((sum, row) => sum + row.unsettledGapSeconds, 0);

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
    {
      key: 'driving',
      header: 'Driving',
      numeric: true,
      hideBelow: 'md',
      cell: (row) => <span className="text-muted-foreground">{asHours(row.drivingSeconds)}</span>,
    },
    {
      key: 'general',
      header: 'General',
      numeric: true,
      hideBelow: 'md',
      cell: (row) => <span className="text-muted-foreground">{asHours(row.generalSeconds)}</span>,
    },
    {
      key: 'gap',
      header: 'Unaccounted for',
      numeric: true,
      cell: (row) =>
        row.unsettledGapSeconds ? (
          <span className="text-warning">{asHours(row.unsettledGapSeconds)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  const segmentColumns: Column<TimesheetSegment>[] = [
    { key: 'technician', header: 'Technician', primary: true, cell: (row) => row.technician },
    { key: 'property', header: 'Property', hideBelow: 'md', cell: (row) => row.address ?? '—' },
    {
      key: 'what',
      header: 'What',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={CATEGORY[row.category]?.variant ?? 'secondary'}>
            {CATEGORY[row.category]?.label ?? row.category}
          </Badge>
          {/* Said plainly. Somebody paid from this is entitled to know which
              numbers a person decided rather than the trail. */}
          {row.adjusted ? <Badge variant="outline">Corrected</Badge> : null}
          {row.source === 'MANUAL' ? <Badge variant="outline">Added by hand</Badge> : null}
        </div>
      ),
    },
    { key: 'from', header: 'From', hideBelow: 'lg', cell: (row) => formatDateTime(row.startedAt) },
    { key: 'to', header: 'To', hideBelow: 'lg', cell: (row) => formatDateTime(row.endedAt) },
    { key: 'time', header: 'Time', numeric: true, cell: (row) => asHours(row.durationSeconds) },
    ...(canChange
      ? [
          {
            key: 'correct',
            header: '',
            cell: (row: TimesheetSegment) => (
              <Button
                aria-label={`Correct this ${CATEGORY[row.category]?.label ?? ''} time`}
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

  const gapColumns: Column<TimesheetGap>[] = [
    { key: 'technician', header: 'Technician', primary: true, cell: (row) => row.technician },
    { key: 'from', header: 'From', cell: (row) => formatDateTime(row.startedAt) },
    { key: 'to', header: 'To', hideBelow: 'md', cell: (row) => formatDateTime(row.endedAt) },
    { key: 'long', header: 'Long', numeric: true, cell: (row) => asHours(row.durationSeconds) },
    {
      key: 'settled',
      header: 'Settled',
      cell: (row) =>
        row.resolved ? (
          <span className="text-muted-foreground text-xs">{row.resolution}</span>
        ) : (
          <Badge variant="destructive">Open</Badge>
        ),
    },
    ...(canChange
      ? [
          {
            key: 'settle',
            header: '',
            cell: (row: TimesheetGap) =>
              row.resolved ? null : (
                <Button className="relative z-10" onClick={() => setSettling(row)} size="sm" variant="secondary">
                  Settle
                </Button>
              ),
          } satisfies Column<TimesheetGap>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Timesheet"
        description="Hours read from where the technician actually was, rather than from a button."
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
          Jobs finished before any of this existed have no hours against them,
          and nothing else will ever go back for them: a submission reads its
          own job, and the sweep only looks a few hours back. Without this the
          page opens empty on its first day and there is nothing anybody can
          press about it.

          It fills only where there is nothing, so it cannot move an hour
          somebody has already been paid — which is what makes it safe to leave
          in the toolbar rather than behind a warning.
        */}
        {canChange ? (
          <Button
            disabled={actions.fillHours.isPending}
            onClick={() =>
              actions.fillHours.mutate(
                { from: range.from, to: range.to },
                {
                  onSuccess: (result) =>
                    setFilled(
                      result.considered === 0
                        ? 'Every job in these days already has its hours.'
                        : [
                            `Read ${result.measured} of ${result.considered} jobs.`,
                            result.unmeasurable
                              ? `${result.unmeasurable} could not be measured — no coordinates, or nobody assigned.`
                              : '',
                            result.more ? 'More of this range is left; press again.' : '',
                          ]
                            .filter(Boolean)
                            .join(' '),
                    ),
                },
              )
            }
            size="sm"
            variant="secondary"
          >
            {actions.fillHours.isPending ? 'Reading the trail…' : 'Fill in missing hours'}
          </Button>
        ) : null}
      </div>

      {filled ? <p className="text-muted-foreground -mt-2 pb-4 text-xs">{filled}</p> : null}

      <StatGroup columns="grid-cols-1 sm:grid-cols-3">
        <Stat label="On site" value={asHours(onsiteTotal)} />
        <Stat label="Technicians" value={String(data.totals.length)} />
        {/*
          Beside the hours, never inside them. An unsettled stretch is time
          nobody can account for: not hours worked, not hours not worked, a
          question — and a total that swallowed it would pay somebody the wrong
          amount without anybody noticing.
        */}
        <Stat
          label="Unaccounted for"
          tone={gapTotal ? 'warning' : 'default'}
          value={gapTotal ? asHours(gapTotal) : '—'}
        />
      </StatGroup>

      {openGaps.length ? (
        <div className="border-warning/40 bg-warning/10 mt-4 flex items-start gap-3 rounded-xl border p-3">
          <AlertTriangleIcon className="text-warning mt-0.5 shrink-0" size={16} />
          <div className="min-w-0 flex-1 text-sm">
            <p className="text-foreground font-medium">
              {openGaps.length === 1
                ? 'One stretch of time is unaccounted for'
                : `${openGaps.length} stretches of time are unaccounted for`}
            </p>
            <p className="text-muted-foreground text-xs">
              A phone that died, was left in a van, or lost its permission. Settle each one before
              this period is paid — those hours are missing from the totals above until you do.
            </p>
          </div>
        </div>
      ) : null}

      {/*
        Stacked rather than tabbed, and that is a decision rather than a
        default. The banner above tells the office to settle each open stretch
        before the period is paid; putting the button to do it behind a third
        tab would contradict the instruction. A payroll page should let somebody
        scroll once and see everything that bears on the number.
      */}
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
            description="Either nobody was working, or these jobs finished before their hours were being read. Fill in missing hours to find out which."
            title="Nothing recorded in these days"
          />
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-foreground mb-2 text-sm font-semibold">
          Unaccounted for{openGaps.length ? ` (${openGaps.length})` : ''}
        </h2>
        {data.gaps.length ? (
          <DataTable
            columns={gapColumns}
            label="Time the trail could not account for"
            rowKey={(row) => row.id}
            rows={data.gaps}
          />
        ) : (
          <EmptyState
            description="No stretch of these days went unrecorded."
            title="Every minute is accounted for"
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

      <SettleGapDialog
        gap={settling}
        onClose={() => setSettling(null)}
        onSettle={(resolution, creditedMinutes) => {
          if (!settling) return;
          actions.resolveGap.mutate(
            { gapId: settling.id, resolution, creditedMinutes },
            {
              onSuccess: (settled) =>
                toast.success(
                  settled.creditedMinutes
                    ? `${asHours(settled.creditedMinutes * 60)} added to the timesheet`
                    : 'Settled, with no time added',
                ),
              onError: (error) => toast.error('That could not be settled', { description: error.message }),
            },
          );
          setSettling(null);
        }}
      />
    </>
  );
}

/** `datetime-local` wants no seconds and no zone. */
const localValue = (iso: string) => {
  const at = new Date(iso);
  const offset = at.getTimezoneOffset() * 60_000;
  return new Date(at.getTime() - offset).toISOString().slice(0, 16);
};

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
    setStartedAt(localValue(segment.startedAt));
    setEndedAt(localValue(segment.endedAt));
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
            {segment?.technician} at {segment?.address ?? 'this property'}. The trail said{' '}
            {segment ? asHours(segment.durationSeconds) : ''}, and that is kept beside whatever you
            put here.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            From
            <input
              className={dateField}
              onChange={(event) => setStartedAt(event.target.value)}
              type="datetime-local"
              value={startedAt}
            />
          </label>
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            To
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
            disabled={reason.trim().length < 4 || !startedAt || !endedAt}
            onClick={() =>
              onSave(new Date(startedAt).toISOString(), new Date(endedAt).toISOString(), reason.trim())
            }
          >
            Save the correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settling a stretch nobody can account for.
 *
 * Two real answers, and this offers both without steering: the work happened
 * and the phone missed it, or the technician was not working. Leaving it open
 * is the only wrong one, because the hours stay out of the total either way and
 * nobody is told.
 */
function SettleGapDialog({
  gap,
  onClose,
  onSettle,
}: {
  gap: TimesheetGap | null;
  onClose: () => void;
  onSettle: (resolution: string, creditedMinutes?: number) => void;
}) {
  const [resolution, setResolution] = useState('');
  const [minutes, setMinutes] = useState('');

  const close = () => {
    setResolution('');
    setMinutes('');
    onClose();
  };

  const typed = Number(minutes);
  const credited = Number.isFinite(typed) && typed > 0 ? Math.round(typed) : undefined;

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : close())} open={Boolean(gap)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settle this stretch</DialogTitle>
          <DialogDescription>
            {gap
              ? `${asHours(gap.durationSeconds)} of ${gap.technician}'s day that the trail could not account for.`
              : ''}{' '}
            Credit the hours if the work happened, or say why none are owed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            What happened
            <textarea
              className="border-border bg-card text-foreground min-h-20 rounded-lg border px-2 py-1.5 text-sm"
              onChange={(event) => setResolution(event.target.value)}
              placeholder="Phone died at the Feldspar job; four hours added back."
              value={resolution}
            />
          </label>
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            Minutes to credit — leave it empty if none are owed
            <input
              className={dateField}
              inputMode="numeric"
              onChange={(event) => setMinutes(event.target.value)}
              placeholder="240"
              value={minutes}
            />
          </label>
        </div>
        <DialogFooter>
          <Button onClick={close} variant="secondary">
            Cancel
          </Button>
          <Button disabled={resolution.trim().length < 4} onClick={() => onSettle(resolution.trim(), credited)}>
            {credited ? `Credit ${asHours(credited * 60)}` : 'Settle with no time'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
