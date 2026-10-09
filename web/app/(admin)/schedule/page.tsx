'use client';

import type { JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import { useQueries } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { Panel, PanelRow } from '@/components/panel';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { businessTimeOfDay, businessToday, shiftDay } from '@/lib/clock';
import { formatRelative } from '@/lib/format';
import { JOBBER_DAY_LABEL, TYPE_MARK, isOneSided, jobberDayTone } from '@/lib/jobber-day';
import { jobberDayQuery } from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';
import { cn } from '@/lib/utils';

/**
 * The week by technician, every visit marked against Jobber
 * (console-development, 2026-10-09).
 *
 * Read-only: built from the day comparison, which reads what the Jobber sync
 * last stored. Nothing on this page changes Jobber.
 */

const CHIPS_SHOWN = 4;

/** Monday of the week a `yyyy-MM-dd` falls in. Calendar arithmetic only; noon UTC is that date everywhere. */
function mondayOf(date: string) {
  const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return shiftDay(date, -((weekday + 6) % 7));
}

const dayLabel = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
/** "Mon 5": weekday first, which `toLocaleDateString` will not do for weekday + day alone. */
const columnLabel = (date: string) =>
  `${dayLabel(date, { weekday: 'short' })} ${Number(date.slice(8, 10))}`;

/**
 * The words under a difference's name, only where they add to it: the two
 * times, the two days, the two people. "Cancelled here, open in Jobber" says
 * everything its own sentence would.
 */
const SAYS_MORE = new Set(['TIME_DIFFERS', 'DAY_DIFFERS', 'TECHNICIAN_DIFFERS', 'UNSEEN']);
const detailOf = (row: JobberDayRow) =>
  (SAYS_MORE.has(row.state) ? row.differences : row.differences.slice(1)).join(' · ');

export default function SchedulePage() {
  const today = businessToday();
  const [state, setState] = useUrlState({ date: '', view: 'week' });
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(state.date) ? state.date : today;
  const week = state.view !== 'day';
  const monday = mondayOf(anchor);
  const allDays = useMemo(
    () => (week ? Array.from({ length: 7 }, (_, index) => shiftDay(monday, index)) : [anchor]),
    [week, monday, anchor],
  );

  const results = useQueries({ queries: allDays.map((date) => jobberDayQuery(date)) });
  const loading = results.some((result) => result.isLoading);
  const failed = results.find((result) => result.isError);
  const byDate = new Map(
    results
      .map((result) => result.data)
      .filter((data): data is JobberDayComparison => Boolean(data))
      .map((data) => [data.date, data]),
  );

  // Saturday and Sunday only when something is on them.
  const days = allDays.filter(
    (date, index) => !week || index < 5 || (byDate.get(date)?.rows.length ?? 0) > 0,
  );
  const syncedAt = [...byDate.values()].map((data) => data.syncedAt).find(Boolean) ?? null;

  const people = useMemo(() => {
    const totals = new Map<string, { id: string | null; name: string; total: number }>();
    for (const data of byDate.values())
      for (const person of data.technicians) {
        const key = person.technicianId ?? '';
        const entry = totals.get(key) ?? { id: person.technicianId, name: person.name, total: 0 };
        entry.total += person.here + person.inJobber;
        totals.set(key, entry);
      }
    return [...totals.values()].sort(
      (a, b) => Number(a.id === null) - Number(b.id === null) || b.total - a.total || a.name.localeCompare(b.name),
    );
  }, [byDate]);

  const differences = days.flatMap((date) =>
    (byDate.get(date)?.rows ?? []).filter((row) => row.state !== 'MATCHES').map((row) => ({ date, row })),
  );
  const otherWork = days.flatMap((date) => (byDate.get(date)?.otherWork ?? []).map((work) => ({ date, work })));

  const step = (direction: number) =>
    setState({ date: shiftDay(anchor, direction * (week ? 7 : 1)) });
  const rangeLabel = week
    ? `${dayLabel(days[0]!, { month: 'short', day: 'numeric' })} – ${dayLabel(days.at(-1)!, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : dayLabel(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <>
      <PageHeader
        description={
          <span>
            Every visit beside Jobber, as of the last sync
            {syncedAt ? <span className="font-mono text-xs"> · synced {formatRelative(syncedAt)}</span> : null}.
          </span>
        }
        title="Schedule"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="bg-card flex items-center rounded-md border">
          <Button aria-label={week ? 'Previous week' : 'Previous day'} onClick={() => step(-1)} size="icon-sm" variant="ghost">
            <ChevronLeftIcon />
          </Button>
          <span className="px-2 font-mono text-xs whitespace-nowrap tabular-nums">{rangeLabel}</span>
          <Button aria-label={week ? 'Next week' : 'Next day'} onClick={() => step(1)} size="icon-sm" variant="ghost">
            <ChevronRightIcon />
          </Button>
        </div>
        <Button onClick={() => setState({ date: '' })} size="sm" variant="outline">
          Today
        </Button>
        <div aria-label="View" className="bg-card flex gap-0.5 rounded-md border p-0.5" role="group">
          {(['day', 'week'] as const).map((view) => (
            <Button
              aria-pressed={(view === 'week') === week}
              className={cn('h-7 px-3 text-xs', (view === 'week') === week && 'bg-accent')}
              key={view}
              onClick={() => setState({ view })}
              size="sm"
              variant="ghost"
            >
              {view === 'week' ? 'Week' : 'Day'}
            </Button>
          ))}
        </div>
        <div className="text-muted-foreground ml-auto flex flex-wrap items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="bg-card inline-block h-2.5 w-3.5 rounded-sm border" /> Matches Jobber
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-card border-l-warning inline-block h-2.5 w-3.5 rounded-sm border border-l-2" /> Differs
          </span>
          <span className="flex items-center gap-1.5">
            <span className="border-warning inline-block h-2.5 w-3.5 rounded-sm border border-dashed" /> Only on one side
          </span>
        </div>
      </div>

      {failed ? (
        <ErrorState error={failed.error} retry={() => results.forEach((result) => void result.refetch())} />
      ) : loading && !byDate.size ? (
        <Skeleton className="h-80 rounded-xl" />
      ) : !people.length ? (
        <Panel title={week ? 'This week' : 'This day'}>
          <p className="text-muted-foreground px-4 py-6 text-sm">Nothing is booked here or in Jobber.</p>
        </Panel>
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <div className={cn(week && 'min-w-[1040px]')}>
            <div
              className="bg-muted/60 grid border-b"
              style={{ gridTemplateColumns: `200px repeat(${days.length}, minmax(0, 1fr))` }}
            >
              <span className="text-muted-foreground px-4 py-2.5 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
                Technician
              </span>
              {days.map((date) => {
                const data = byDate.get(date);
                const count = data?.rows.filter((row) => row.here && row.status !== 'CANCELLED').length ?? 0;
                return (
                  <span
                    className={cn(
                      'flex items-baseline gap-2 border-l px-3 py-2.5 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase',
                      date === today ? 'text-highlight' : 'text-muted-foreground',
                    )}
                    key={date}
                  >
                    {columnLabel(date)}
                    {date === today ? ' · Today' : ''}
                    <span className="text-muted-foreground font-normal normal-case">{count}</span>
                  </span>
                );
              })}
            </div>
            {people.map((person) => (
              <div
                className="grid border-b last:border-b-0"
                key={person.id ?? 'nobody'}
                style={{ gridTemplateColumns: `200px repeat(${days.length}, minmax(0, 1fr))` }}
              >
                <div className="px-4 py-3">
                  <p className={cn('text-sm', person.id === null && 'text-warning')}>{person.name}</p>
                  <p className="text-muted-foreground font-mono text-[11px]">
                    {person.total} {person.total === 1 ? 'visit' : 'visits'}
                  </p>
                </div>
                {days.map((date) => (
                  <DayCell
                    date={date}
                    isToday={date === today}
                    key={date}
                    rows={(byDate.get(date)?.rows ?? []).filter((row) => row.technicianId === person.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <Panel
        className="mt-5"
        count={differences.length || undefined}
        countTone="warning"
        title={week ? 'Differences this week' : 'Differences this day'}
      >
        {differences.length ? (
          <div className="divide-y">
            {differences.map(({ date, row }) => (
              <PanelRow
                detail={
                  <>
                    {row.property}
                    {row.here?.technician || row.jobber?.technician
                      ? ` · ${row.here?.technician ?? row.jobber?.technician}`
                      : ''}
                    {` · ${dayLabel(date, { weekday: 'short', month: 'short', day: 'numeric' })}`}
                    {row.waitingToSend ? ' · our change is waiting to go to Jobber' : ''}
                  </>
                }
                key={`${date}:${row.key}`}
                title={
                  <span>
                    {JOBBER_DAY_LABEL[row.state]}
                    {detailOf(row) ? <span className="text-muted-foreground"> · {detailOf(row)}</span> : null}
                    {row.importNote ? <span className="text-muted-foreground"> · {row.importNote}</span> : null}
                  </span>
                }
                tone={jobberDayTone(row.state) === 'destructive' ? 'destructive' : 'warning'}
                trailing={
                  row.inspectionId ? (
                    <Button asChild className="h-7 px-2 text-xs" size="sm" variant="ghost">
                      <Link href={`/inspections/${row.inspectionId}`}>Open</Link>
                    </Button>
                  ) : null
                }
              />
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground px-4 py-6 text-sm">
            {loading ? 'Comparing with Jobber…' : 'Everything here matches Jobber.'}
          </p>
        )}
      </Panel>

      {otherWork.length ? (
        <Panel className="mt-5" count={otherWork.length} title="Also in Jobber, not inspections">
          <div className="divide-y">
            {otherWork.map(({ date, work }) => (
              <PanelRow
                detail={`${work.property}${work.technician ? ` · ${work.technician}` : ''} · ${columnLabel(date)} · ${work.reason}`}
                key={`${date}:${work.jobberVisitId}`}
                title={work.title ?? 'Untitled visit'}
                tone="muted"
              />
            ))}
          </div>
        </Panel>
      ) : null}
    </>
  );
}

function DayCell({ rows, date, isToday }: { rows: JobberDayRow[]; date: string; isToday: boolean }) {
  const [open, setOpen] = useState(false);
  const sorted = [...rows].sort((a, b) =>
    (a.here?.startAt ?? a.jobber?.startAt ?? '~').localeCompare(b.here?.startAt ?? b.jobber?.startAt ?? '~'),
  );
  const shown = open ? sorted : sorted.slice(0, CHIPS_SHOWN);
  return (
    <div className={cn('flex min-h-16 flex-col gap-1 border-l p-2', isToday && 'bg-highlight/[0.03]')}>
      {shown.map((row) => (
        <Chip date={date} key={row.key} row={row} />
      ))}
      {sorted.length > CHIPS_SHOWN ? (
        <button
          className="text-muted-foreground hover:text-foreground self-start px-2 text-[11px]"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? 'Show fewer' : `+${sorted.length - CHIPS_SHOWN} more`}
        </button>
      ) : null}
    </div>
  );
}

function Chip({ row, date }: { row: JobberDayRow; date: string }) {
  const tone = jobberDayTone(row.state);
  const time = businessTimeOfDay(row.here?.startAt ?? row.jobber?.startAt) ?? '—';
  const cancelled = row.status === 'CANCELLED';
  const body = (
    <>
      <span className="flex items-baseline gap-1.5 text-[11.5px]">
        <span className="text-muted-foreground font-mono text-[10.5px] whitespace-nowrap">{time.replace(' ', '')}</span>
        <span className={cn('min-w-0 truncate', cancelled && 'line-through')}>{row.property}</span>
        <span className="text-muted-foreground ml-auto font-mono text-[9.5px]">
          {row.inspectionType ? (TYPE_MARK[row.inspectionType] ?? '') : ''}
        </span>
      </span>
      {row.state !== 'MATCHES' ? (
        <span className={cn('truncate text-[10.5px]', tone === 'destructive' ? 'text-destructive' : 'text-warning')}>
          {row.differences[0]}
        </span>
      ) : row.status && row.status !== 'SCHEDULED' && row.status !== 'IN_PROGRESS' ? (
        <span className="text-muted-foreground text-[10.5px]">Done</span>
      ) : null}
    </>
  );
  const className = cn(
    'bg-background/40 hover:bg-accent flex min-w-0 flex-col gap-0.5 rounded-md border px-2 py-1.5 transition-colors',
    isOneSided(row.state) && 'border-warning/70 border-dashed',
    !isOneSided(row.state) && tone === 'warning' && 'border-l-warning border-l-2',
    tone === 'destructive' && 'border-l-destructive border-l-2',
    row.status && row.status !== 'SCHEDULED' && row.status !== 'IN_PROGRESS' && row.state === 'MATCHES' && 'opacity-60',
  );
  return row.inspectionId ? (
    <Link className={className} href={`/inspections/${row.inspectionId}`} title={`${row.property} · ${date}`}>
      {body}
    </Link>
  ) : (
    <div className={className} title={row.importNote ?? row.property}>
      {body}
    </div>
  );
}
