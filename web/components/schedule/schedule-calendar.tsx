'use client';

import type { JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import { useQueries } from '@tanstack/react-query';
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, MapIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { FilterPill, type FilterOption } from '@/components/planning/filter-pill';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/auth';
import { businessToday } from '@/lib/clock';
import { fromDateValue, toDateValue } from '@/lib/date-range';
import { typeTitle } from '@/lib/inspection-type-tone';
import { jobberDayQuery } from '@/lib/queries';
import {
  CALENDAR_VIEWS,
  counts,
  dayColumns,
  dayOfMonth,
  daysToRead,
  hourWindow,
  isShown,
  monthOf,
  monthTitle,
  NOBODY,
  NO_FILTERS,
  sortVisits,
  STATUS_GROUPS,
  stepAnchor,
  technicianKey,
  texasMinutes,
  UNKNOWN_TYPE,
  visitStart,
  weekdayOf,
  type CalendarFilters,
  type CalendarView,
} from '@/lib/schedule-calendar';
import { cn } from '@/lib/utils';

import { CalendarVisit, PersonDisc, personOf } from './calendar-visit';
import { ScheduleMap } from './schedule-map';
import { UnassignedDrawer } from './unassigned-drawer';

/** Height of one hour on the time grid. */
const HOUR_PX = 48;
/** Anytime visits a week's day shows before "+N more". */
const WEEK_SHOWN = 6;
/** And a technician's column on the Day view. */
const DAY_SHOWN = 12;
/** And a day of the month. */
const MONTH_SHOWN = 3;

/** The person a visit is with, by the technician it is grouped under; null for nobody. */
type NameOf = (row: JobberDayRow) => string | null;

/** A day's visits grouped by who is on them, Unassigned first as on the Day view. */
const personFirst = (nameOf: NameOf) => (row: JobberDayRow) => nameOf(row) ?? '';

export interface ScheduleCalendarState {
  anchor: string;
  view: CalendarView;
  map: boolean;
}

/**
 * The Schedule as Jobber's (the office, 2026-11-04: "we want the features for
 * familiarity"): the month in the title, arrows and Today, Type / Team / Status
 * pills, Month / Week / Day, the work nobody is on, and the map beside it.
 *
 * Every visit comes from the day comparison the Schedule already reads, so a
 * visit that differs from Jobber is marked here too, and one Jobber has that
 * the console does not shows dashed. Nothing on this view changes anything:
 * a visit opens its inspection, where the changes are made.
 *
 * Requests: one per day shown -- 1 for a day, 7 for a week, re-read each
 * minute as the comparison is elsewhere; up to 31 for a month, read once and
 * not polled. None of them calls Jobber or a billed provider.
 */
export function ScheduleCalendar({
  state,
  onChange,
  modeSwitch,
}: {
  state: ScheduleCalendarState;
  onChange: (next: Partial<ScheduleCalendarState>) => void;
  /** The way to the comparison with Jobber, in the toolbar. */
  modeSwitch: ReactNode;
}) {
  const today = businessToday();
  const { anchor, view, map } = state;
  const { has } = usePermissions();
  const canMap = has('technicians:read') && has('properties:read');
  const [hidden, setHidden] = useState<CalendarFilters>(NO_FILTERS);

  const days = useMemo(() => daysToRead(view, anchor), [view, anchor]);
  const results = useQueries({
    queries: days.map((date) => ({
      ...jobberDayQuery(date),
      refetchInterval: view === 'month' ? (false as const) : 60_000,
    })),
  });
  const failed = results.find((result) => result.isError);
  const loading = results.some((result) => result.isLoading);
  // At most 31 days: cheap enough to rebuild each render.
  const byDate = new Map(
    results
      .map((result) => result.data)
      .filter((data): data is JobberDayComparison => Boolean(data))
      .map((data) => [data.date, data] as const),
  );

  /**
   * Who a visit is with, by the technician it is grouped under. Read from the
   * days' own technician lists rather than the row's names, which either side
   * may leave empty: a visit under somebody must never show the "nobody" disc.
   */
  const names = new Map<string, string>();
  for (const data of byDate.values())
    for (const person of data.technicians) if (person.technicianId) names.set(person.technicianId, person.name);
  const nameOf: NameOf = (row) => (row.technicianId ? (names.get(row.technicianId) ?? personOf(row)) : null);

  const options = filterOptions(byDate, nameOf);
  const shownOn = (date: string) => (byDate.get(date)?.rows ?? []).filter((row) => isShown(row, hidden));
  const openDay = (date: string) => onChange({ view: 'day', anchor: date });

  return (
    <>
      <h1 className="sr-only">Schedule</h1>
      <div className="flex flex-col gap-3 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <MonthTitlePicker anchor={anchor} onPick={(date) => onChange({ anchor: date })} />
          <div className="flex items-center gap-1">
            <Button
              aria-label={`Previous ${view}`}
              onClick={() => onChange({ anchor: stepAnchor(view, anchor, -1) })}
              size="icon-sm"
              variant="outline"
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              aria-label={`Next ${view}`}
              onClick={() => onChange({ anchor: stepAnchor(view, anchor, 1) })}
              size="icon-sm"
              variant="outline"
            >
              <ArrowRightIcon />
            </Button>
            <Button disabled={anchor === today} onClick={() => onChange({ anchor: today })} size="sm" variant="outline">
              Today
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <FilterPill
              hidden={hidden.types}
              label="Type"
              onChange={(types) => setHidden({ ...hidden, types })}
              options={options.types}
            />
            <FilterPill
              hidden={hidden.technicians}
              label="Team"
              onChange={(technicians) => setHidden({ ...hidden, technicians })}
              options={options.technicians}
            />
            <FilterPill
              hidden={hidden.statuses}
              label="Status"
              onChange={(statuses) => setHidden({ ...hidden, statuses })}
              options={STATUS_GROUPS}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {modeSwitch}
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <SegmentedControl
              aria-label="View"
              onChange={(next) => onChange({ view: next })}
              options={CALENDAR_VIEWS}
              value={view}
            />
            <UnassignedDrawer />
            {canMap ? (
              <Button
                aria-pressed={map}
                onClick={() => onChange({ map: !map })}
                size="sm"
                title="The day's visits on the map"
                variant={map ? 'default' : 'outline'}
              >
                <MapIcon />
                Map
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className={cn(map && canMap && 'grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,38%)]')}>
        <div className="min-w-0">
          {failed ? (
            <ErrorState error={failed.error} retry={() => results.forEach((result) => void result.refetch())} />
          ) : loading && !byDate.size ? (
            <Skeleton className="h-96 rounded-xl" />
          ) : view === 'day' ? (
            <DayView
              date={anchor}
              day={byDate.get(anchor)}
              hidden={hidden}
              nameOf={nameOf}
              rows={shownOn(anchor)}
              today={today}
            />
          ) : view === 'week' ? (
            <WeekView days={days} nameOf={nameOf} onOpenDay={openDay} shownOn={shownOn} today={today} />
          ) : (
            <MonthView anchor={anchor} nameOf={nameOf} onOpenDay={openDay} shownOn={shownOn} today={today} />
          )}
        </div>
        {map && canMap ? <ScheduleMap date={anchor} /> : null}
      </div>
    </>
  );
}

/** The Type and Team pills' choices: what is on the days loaded, so nothing is offered that matches nothing. */
function filterOptions(byDate: ReadonlyMap<string, JobberDayComparison>, nameOf: NameOf) {
  const types = new Map<string, FilterOption>();
  const people = new Map<string, FilterOption>([[NOBODY, { value: NOBODY, label: 'Unassigned' }]]);
  for (const day of byDate.values())
    for (const row of day.rows) {
      const type = row.inspectionType ?? UNKNOWN_TYPE;
      if (!types.has(type))
        types.set(type, { value: type, label: row.inspectionType ? typeTitle(type) : 'Type not known yet' });
      const key = technicianKey(row.technicianId);
      if (!people.has(key)) people.set(key, { value: key, label: nameOf(row) ?? 'Unassigned' });
    }
  const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);
  const [nobody, ...rest] = [...people.values()];
  return { types: [...types.values()].sort(byLabel), technicians: [nobody, ...rest.sort(byLabel)] };
}

/** Jobber's title: the month, opening a calendar to jump to any day. */
function MonthTitlePicker({ anchor, onPick }: { anchor: string; onPick: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`${monthTitle(anchor)}, choose a day`}
          className="font-display text-heading hover:bg-accent focus-visible:ring-ring/50 -ml-1 flex items-center gap-1.5 rounded-md px-1 text-2xl leading-tight font-bold tracking-tight outline-none focus-visible:ring-[3px]"
          type="button"
        >
          {monthTitle(anchor)}
          <ChevronDownIcon aria-hidden className="text-muted-foreground size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          autoFocus
          defaultMonth={fromDateValue(anchor)}
          mode="single"
          onSelect={(date) => {
            if (!date) return;
            onPick(toDateValue(date));
            setOpen(false);
          }}
          selected={fromDateValue(anchor)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** "3 visits" on a column's head, as Jobber's chip says it. */
function VisitCount({ count }: { count: number }) {
  return (
    <span className="text-muted-foreground bg-card inline-flex rounded-full border px-1.5 text-[11px] leading-5 font-medium whitespace-nowrap">
      {count} {count === 1 ? 'visit' : 'visits'}
    </span>
  );
}

/** A stack of Anytime visits, the first few showing and the rest a click away. */
function VisitStack({
  date,
  nameOf,
  rows,
  shown,
  showPerson,
}: {
  date: string;
  nameOf: NameOf;
  rows: readonly JobberDayRow[];
  shown: number;
  showPerson: boolean;
}) {
  const [open, setOpen] = useState(false);
  const visible = open ? rows : rows.slice(0, shown);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {visible.map((row) => (
        <CalendarVisit date={date} key={row.key} person={nameOf(row)} row={row} showPerson={showPerson} />
      ))}
      {rows.length > shown ? (
        <button
          className="text-primary self-start px-1 text-[11px] font-semibold hover:underline"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? 'Show fewer' : `+${rows.length - shown} more`}
        </button>
      ) : null}
    </div>
  );
}

interface GridColumn {
  key: string;
  date: string;
  rows: JobberDayRow[];
}

/**
 * The hours under the Anytime row, for the visits that have a clock time.
 * Left out when none do, rather than drawn as an empty afternoon. A red line
 * marks now on today, as Jobber's does.
 */
function TimeGrid({
  columns,
  nameOf,
  template,
  today,
}: {
  columns: GridColumn[];
  nameOf: NameOf;
  template: string;
  today: string;
}) {
  const timed = columns.flatMap((column) =>
    column.rows.flatMap((row) => {
      const start = visitStart(row);
      return start ? [texasMinutes(start)] : [];
    }),
  );
  const span = hourWindow(timed);
  if (!span) return null;
  const hours = Array.from({ length: span.to - span.from }, (_, index) => span.from + index);
  const height = hours.length * HOUR_PX;
  const now = texasMinutes(new Date());
  const offset = (minutes: number) => ((minutes - span.from * 60) / 60) * HOUR_PX;

  return (
    <div className="grid border-t" style={{ gridTemplateColumns: template }}>
      <div className="relative" style={{ height }}>
        {hours.map((hour) => (
          <span
            className="text-muted-foreground absolute right-2 -translate-y-1/2 font-mono text-[10.5px] whitespace-nowrap"
            key={hour}
            style={{ top: (hour - span.from) * HOUR_PX }}
          >
            {hour === 0 || hour === 24 ? '12 AM' : hour === 12 ? '12 PM' : hour < 12 ? `${hour} AM` : `${hour - 12} PM`}
          </span>
        ))}
      </div>
      {columns.map((column) => {
        const placed = column.rows
          .map((row) => ({ row, start: visitStart(row) }))
          .filter((entry): entry is { row: JobberDayRow; start: string } => Boolean(entry.start))
          .sort((a, b) => a.start.localeCompare(b.start));
        return (
          <div className="relative border-l" key={column.key} style={{ height }}>
            {hours.map((hour) => (
              <span
                aria-hidden
                className="border-border/70 absolute inset-x-0 border-t"
                key={hour}
                style={{ top: (hour - span.from) * HOUR_PX }}
              />
            ))}
            {column.date === today && now >= span.from * 60 && now <= span.to * 60 ? (
              <span
                aria-label="Now"
                className="bg-destructive absolute inset-x-0 z-10 h-0.5"
                role="img"
                style={{ top: offset(now) }}
              />
            ) : null}
            {placed.map(({ row, start }, index) => {
              // Two at the same time sit side by side, slightly in.
              const overlap = placed
                .slice(0, index)
                .filter((other) => Math.abs(texasMinutes(other.start) - texasMinutes(start)) < 45).length;
              return (
                <CalendarVisit
                  className="absolute w-auto shadow-xs"
                  date={column.date}
                  key={row.key}
                  person={nameOf(row)}
                  row={row}
                  style={{ top: offset(texasMinutes(start)) + 2, left: 4 + overlap * 10, right: 4 }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Jobber's Day view: a column per technician, "Unassigned" first. */
function DayView({
  date,
  day,
  hidden,
  nameOf,
  rows,
  today,
}: {
  date: string;
  day: JobberDayComparison | undefined;
  hidden: CalendarFilters;
  nameOf: NameOf;
  rows: JobberDayRow[];
  today: string;
}) {
  const columns = dayColumns(day).filter((column) => !hidden.technicians.has(technicianKey(column.technicianId)));
  const template = `3.5rem repeat(${columns.length}, minmax(12rem, 1fr))`;
  const grid = columns.map((column) => ({
    key: technicianKey(column.technicianId),
    date,
    rows: sortVisits(
      rows.filter((row) => row.technicianId === column.technicianId),
      (row) => row.property,
    ),
    name: column.name,
    technicianId: column.technicianId,
  }));

  return (
    <div className="bg-card overflow-x-auto rounded-xl border">
      <div style={{ minWidth: `calc(3.5rem + ${columns.length} * 12rem)` }}>
        <p className="text-heading border-b px-4 py-2.5 text-left text-sm font-semibold sm:text-center">
          {dayOfMonth(date)} {weekdayOf(date)}
          {date === today ? <span className="text-muted-foreground font-normal"> · Today</span> : null}
        </p>
        <div className="grid border-b" style={{ gridTemplateColumns: template }}>
          <span />
          {grid.map((column) => (
            <div className="flex min-w-0 flex-col items-center gap-1 border-l px-2 py-2.5" key={column.key}>
              <span className="flex max-w-full min-w-0 items-center gap-2">
                <PersonDisc name={column.technicianId ? column.name : null} />
                <span className={cn('truncate text-sm font-semibold', column.technicianId ? 'text-heading' : 'text-warning')}>
                  {column.name}
                </span>
              </span>
              <VisitCount count={column.rows.filter(counts).length} />
            </div>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: template }}>
          <span className="text-muted-foreground px-2 py-2 text-right text-[11px]">Anytime</span>
          {grid.map((column) => (
            <div className="min-w-0 border-l p-1.5" key={column.key}>
              <VisitStack
                date={date}
                nameOf={nameOf}
                rows={column.rows.filter((row) => !visitStart(row))}
                showPerson={false}
                shown={DAY_SHOWN}
              />
            </div>
          ))}
        </div>
        <TimeGrid columns={grid} nameOf={nameOf} template={template} today={today} />
      </div>
    </div>
  );
}

/** Jobber's Week view: Sunday to Saturday, a column a day. */
function WeekView({
  days,
  nameOf,
  onOpenDay,
  shownOn,
  today,
}: {
  days: string[];
  nameOf: NameOf;
  onOpenDay: (date: string) => void;
  shownOn: (date: string) => JobberDayRow[];
  today: string;
}) {
  const template = `3.5rem repeat(${days.length}, minmax(9rem, 1fr))`;
  const grid = days.map((date) => ({
    key: date,
    date,
    rows: sortVisits(shownOn(date), personFirst(nameOf)),
  }));

  return (
    <div className="bg-card overflow-x-auto rounded-xl border">
      <div style={{ minWidth: `calc(3.5rem + ${days.length} * 9rem)` }}>
        <div className="grid border-b" style={{ gridTemplateColumns: template }}>
          <span />
          {grid.map((column) => (
            <div className="flex flex-col items-center gap-1 border-l px-2 py-2.5" key={column.key}>
              {/* The day's head opens its Day view, as Jobber's does. */}
              <button
                aria-label={`Open ${weekdayOf(column.date)} ${dayOfMonth(column.date)} as a day`}
                className={cn(
                  'focus-visible:ring-ring/50 rounded-md px-2 py-0.5 text-sm font-semibold outline-none focus-visible:ring-[3px]',
                  column.date === today ? 'bg-primary text-primary-foreground' : 'text-heading hover:bg-accent',
                )}
                onClick={() => onOpenDay(column.date)}
                type="button"
              >
                {dayOfMonth(column.date)} {weekdayOf(column.date)}
              </button>
              <VisitCount count={column.rows.filter(counts).length} />
            </div>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: template }}>
          <span className="text-muted-foreground px-2 py-2 text-right text-[11px]">Anytime</span>
          {grid.map((column) => (
            <div className="min-w-0 border-l p-1.5" key={column.key}>
              <VisitStack
                date={column.date}
                nameOf={nameOf}
                rows={column.rows.filter((row) => !visitStart(row))}
                showPerson
                shown={WEEK_SHOWN}
              />
            </div>
          ))}
        </div>
        <TimeGrid columns={grid} nameOf={nameOf} template={template} today={today} />
      </div>
    </div>
  );
}

/** Jobber's Month view: whole weeks, the month's own days filled in. */
function MonthView({
  anchor,
  nameOf,
  onOpenDay,
  shownOn,
  today,
}: {
  anchor: string;
  nameOf: NameOf;
  onOpenDay: (date: string) => void;
  shownOn: (date: string) => JobberDayRow[];
  today: string;
}) {
  const { days, grid } = monthOf(anchor);
  const inMonth = new Set(days);

  return (
    <div className="bg-card overflow-x-auto rounded-xl border">
      <div className="min-w-[44rem]">
        <div className="grid grid-cols-7 border-b">
          {grid.slice(0, 7).map((date) => (
            <span className="text-muted-foreground px-2 py-2 text-center text-xs font-semibold" key={date}>
              {weekdayOf(date)}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((date, index) => {
            const own = inMonth.has(date);
            const rows = own ? sortVisits(shownOn(date), personFirst(nameOf)) : [];
            const working = rows.filter(counts).length;
            return (
              <div
                className={cn(
                  'flex min-h-32 min-w-0 flex-col gap-1 p-1.5',
                  index % 7 !== 0 && 'border-l',
                  index >= 7 && 'border-t',
                  !own && 'bg-muted/40',
                )}
                key={date}
              >
                <div className="flex items-center justify-between gap-1">
                  <button
                    aria-label={`Open ${weekdayOf(date)} ${dayOfMonth(date)} as a day`}
                    className={cn(
                      'focus-visible:ring-ring/50 inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold outline-none focus-visible:ring-[3px]',
                      date === today ? 'bg-primary text-primary-foreground' : own ? 'text-heading hover:bg-accent' : 'text-muted-foreground',
                    )}
                    disabled={!own}
                    onClick={() => onOpenDay(date)}
                    type="button"
                  >
                    {dayOfMonth(date)}
                  </button>
                  {working ? (
                    <span className="text-muted-foreground text-[11px]">
                      {working} {working === 1 ? 'visit' : 'visits'}
                    </span>
                  ) : null}
                </div>
                {rows.slice(0, MONTH_SHOWN).map((row) => (
                  <CalendarVisit date={date} key={row.key} person={nameOf(row)} row={row} />
                ))}
                {rows.length > MONTH_SHOWN ? (
                  <button
                    className="text-primary self-start px-1 text-[11px] font-semibold hover:underline"
                    onClick={() => onOpenDay(date)}
                    type="button"
                  >
                    +{rows.length - MONTH_SHOWN} more
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
