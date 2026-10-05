'use client';

import {
  closedDaysOfQuarter,
  isRescheduleMonday,
  quarterFirstDay,
  usFederalHolidays,
  weekStartOf,
  zoneNumberOf,
  type Quarter,
} from '@texasrenters/shared';
import { useMemo, type ReactNode } from 'react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { businessToday } from '@/lib/clock';
import { bookedInWords, dayClock, dayOutsideRules, formatClock, formatMinutes } from '@/lib/planning';
import type { PlanDay, PlanDayAnchor, PlanDayStop, PlanRotation, PlanSettings } from '@/lib/planning-queries';
import { cn } from '@/lib/utils';

import { formatDrive } from './road-routes';

/** One colour a technician keeps across the quarter, in the crew's zone order. */
const TECHNICIAN_COLOURS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];

/** Planned days are DATES, so they are read in UTC: in Manila, local time would show the day before. */
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const SHORT_WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DAY_MS = 86_400_000;

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);
const at = (date: string) => new Date(`${date}T00:00:00Z`);

/** Month, week or day, as Jobber's schedule offers them (the office, 2026-10-05). */
export type CalendarView = 'month' | 'week' | 'day';

export interface CalendarMonth {
  /** `YYYY-MM-01`. */
  key: string;
  label: string;
  /** Monday to Friday, `YYYY-MM-DD`, and null where the week reaches outside the month. */
  weeks: (string | null)[][];
}

/**
 * The quarter's three months as weeks of weekdays, and the days before them of
 * a plan that starts early (the office, 2026-09-19: "for the q4 we can start as
 * early as september") -- from its first day to the end of that month.
 *
 * Monday to Friday only: nothing is ever planned on a weekend, and five columns
 * leave each day room for every technician out on it.
 */
export function quarterMonths(quarter: Quarter, startsOn?: string | null): CalendarMonth[] {
  const monthOf = (offset: number, from?: number) => {
    const first = Date.UTC(quarter.year, (quarter.quarter - 1) * 3 + offset, 1);
    const next = Date.UTC(quarter.year, (quarter.quarter - 1) * 3 + offset + 1, 1);
    const shownFrom = from ?? first;
    const weeks: (string | null)[][] = [];
    for (let monday = Date.parse(`${weekStartOf(isoDate(shownFrom))}T00:00:00Z`); monday < next; monday += 7 * DAY_MS) {
      const week = WEEKDAYS.map((_, day) => {
        const time = monday + day * DAY_MS;
        return time >= shownFrom && time < next ? isoDate(time) : null;
      });
      if (week.some(Boolean)) weeks.push(week);
    }
    return { key: isoDate(first), label: MONTH.format(first), weeks };
  };
  const early = startsOn && startsOn < quarterFirstDay(quarter) ? [monthOf(-1, Date.parse(`${startsOn}T00:00:00Z`))] : [];
  return [...early, ...[0, 1, 2].map((offset) => monthOf(offset))];
}

/** Every weekday the quarter's calendar shows, first to last. */
export function calendarDates(months: readonly CalendarMonth[]): string[] {
  return months.flatMap((month) => month.weeks.flat().filter((date): date is string => date !== null));
}

/** A date the calendar shows: the one given, or the next weekday it does, kept inside the quarter. */
export function clampToCalendar(date: string, months: readonly CalendarMonth[]): string {
  const dates = calendarDates(months);
  return dates.find((shown) => shown >= date) ?? dates.at(-1) ?? date;
}

/** Where the arrows go from the date in view: a day, a week or a month on, never out of the quarter. */
export function stepCursor(view: CalendarView, cursor: string, direction: 1 | -1, months: readonly CalendarMonth[]): string {
  const dates = calendarDates(months);
  if (view === 'day') return dates[dates.indexOf(cursor) + direction] ?? cursor;
  if (view === 'week') {
    const monday = isoDate(Date.parse(`${weekStartOf(cursor)}T00:00:00Z`) + direction * 7 * DAY_MS);
    return dates.find((date) => weekStartOf(date) === monday) ?? cursor;
  }
  const index = months.findIndex((month) => month.weeks.some((week) => week.includes(cursor)));
  const next = months[index + direction];
  return next ? (calendarDates([next])[0] ?? cursor) : cursor;
}

/** The heading over the calendar: the month of the date in view, as Jobber heads its schedule. */
export const calendarTitle = (cursor: string) => MONTH.format(at(cursor));

/** The weekdays of the week a date is in, Monday first. */
export function weekOf(date: string): string[] {
  const monday = Date.parse(`${weekStartOf(date)}T00:00:00Z`);
  return WEEKDAYS.map((_, index) => isoDate(monday + index * DAY_MS));
}

export interface CrewMember {
  id: string;
  name: string;
  days: number;
  visits: number;
  /** Its colour on the calendar and in the Team filter. */
  colour: string;
}

/** Who is out in the quarter: the crew in its zone order first, anyone else after by name. Colours follow that order. */
export function quarterCrew(days: readonly PlanDay[], rotation?: PlanRotation | null): CrewMember[] {
  const seen = new Map<string, Omit<CrewMember, 'colour'>>();
  for (const member of rotation?.crew ?? [])
    seen.set(member.technicianId, { id: member.technicianId, name: member.displayName ?? 'Someone', days: 0, visits: 0 });
  const others = new Map<string, Omit<CrewMember, 'colour'>>();
  for (const day of days) {
    const entry =
      seen.get(day.technicianId) ??
      others.get(day.technicianId) ??
      others.set(day.technicianId, { id: day.technicianId, name: day.technician.displayName, days: 0, visits: 0 }).get(day.technicianId)!;
    entry.days += 1;
    entry.visits += day.stopCount;
  }
  return [...seen.values(), ...[...others.values()].sort((left, right) => left.name.localeCompare(right.name))].map(
    (member, index) => ({ ...member, colour: TECHNICIAN_COLOURS[index % TECHNICIAN_COLOURS.length]! }),
  );
}

/** A day group's number, for a quarter sent out unassigned: "Day group 2" is 2. */
const groupNumber = (name: string) => /^day group\s+(\S+)$/i.exec(name.trim())?.[1] ?? null;

/**
 * A technician on a chip: the first name -- or "Group 2" on a quarter sent out
 * unassigned, whose days are named "Day group 2" and read "Day" on every chip
 * when cut at the first word (found 2026-10-05).
 */
export function shortName(name: string) {
  const group = groupNumber(name);
  return group ? `Group ${group}` : (name.trim().split(/\s+/)[0] ?? name);
}

/** "MR" for Moses Rodriguez, as Jobber marks a visit; "G2" for Day group 2. */
export function initialsOf(name: string) {
  const group = groupNumber(name);
  if (group) return `G${group}`.slice(0, 3);
  const words = name.trim().split(/\s+/).filter(Boolean);
  return `${words[0]?.[0] ?? ''}${words.length > 1 ? (words.at(-1)?.[0] ?? '') : ''}`.toUpperCase() || '?';
}

export type TimelineEntry =
  | (PlanDayStop & { kind: 'visit' })
  | (Omit<PlanDayAnchor, 'kind'> & { kind: 'booked'; booking: PlanDayAnchor['kind'] });

/** A day's visits and the move-outs and move-ins it is built around, in driving order. */
export function dayTimeline(day: PlanDay): TimelineEntry[] {
  return [
    ...day.stops.map((stop) => ({ ...stop, kind: 'visit' as const })),
    ...(day.anchors ?? []).map((anchor) => ({ ...anchor, kind: 'booked' as const, booking: anchor.kind })),
  ].sort((left, right) => (left.positionInDay ?? Number.MAX_SAFE_INTEGER) - (right.positionInDay ?? Number.MAX_SAFE_INTEGER));
}

/** What the calendar's filters let through: which visits, and whether the move-outs and move-ins show. */
export interface CalendarFilter {
  visit: (stop: PlanDayStop) => boolean;
  bookings: boolean;
}

const SHOW_ALL: CalendarFilter = { visit: () => true, bookings: true };

/** "Zone 2", or "Zones 1, 2" for a day that crosses two. */
function zonesOf(day: PlanDay) {
  const zones = [...new Set(day.stops.map((stop) => zoneNumberOf(stop.zone)).filter((zone): zone is string => Boolean(zone)))];
  zones.sort((left, right) => Number(left) - Number(right));
  return zones;
}

/** A day in full, for a reader that cannot see its chip's colour and marks. */
function dayLabel(day: PlanDay, settings: PlanSettings) {
  const zones = zonesOf(day);
  const booked = day.anchors ?? [];
  return `${LONG_DAY.format(at(day.date.slice(0, 10)))}: ${day.technician.displayName}, ${day.stopCount} ${
    day.stopCount === 1 ? 'visit' : 'visits'
  }${day.hvacStopCount ? ` (${day.hvacStopCount} HVAC)` : ''}${
    zones.length ? `, ${zones.length === 1 ? 'zone' : 'zones'} ${zones.join(', ')}` : ''
  }${booked.length ? `, built around ${bookedInWords(booked)}` : ''}, ${formatMinutes(day.onSiteMinutes)} inspecting${
    dayOutsideRules(day, settings) ? ', outside the rules' : ''
  }`;
}

const visitWord = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'visit' : 'visits'}`;

/** "13 visits" in a small outlined box, as Jobber counts a day. */
function CountPill({ count, className }: { count: number; className?: string }) {
  return (
    <span className={cn('text-muted-foreground rounded border px-1 font-mono text-[11px] leading-4 tabular-nums', className)}>
      {visitWord(count)}
    </span>
  );
}

/** A technician's initials in their colour. */
function Avatar({ name, colour, className }: { name: string; colour: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold tracking-tight text-white',
        colour,
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

interface Shared {
  settings: PlanSettings;
  filter: CalendarFilter;
  today: string;
  selectedDayId?: string;
  /** The day's technician-days, in the crew's order. */
  daysOn: (date: string) => PlanDay[];
  noteOf: (date: string) => string | null;
  colourOf: (technicianId: string) => string;
  onSelect: (dayId: string) => void;
  onOpenDate?: (date: string) => void;
  /** The visit or booking the map is on. */
  focusedStopId?: string;
  onFocusStop?: (dayId: string, stopId: string) => void;
}

/** The visits and bookings of a day the filters let through, in driving order. */
const shownEntries = (day: PlanDay, filter: CalendarFilter) =>
  dayTimeline(day).filter((entry) => (entry.kind === 'visit' ? filter.visit(entry) : filter.bookings));

const shownVisits = (days: readonly PlanDay[], filter: CalendarFilter) =>
  days.reduce((total, day) => total + day.stops.filter(filter.visit).length, 0);

/**
 * The quarter's technician-days as a calendar, a month, a week or a day at a
 * time (the office, 2026-10-05, from Jobber's schedule).
 *
 * Each technician keeps one colour, so a week reads at a glance as who covers
 * it; a day outside the office's rules is marked on its chip. A technician-day
 * clicked anywhere is the one picked -- the map beside the calendar draws it.
 */
export function PlanCalendar({
  quarter,
  days,
  settings,
  crew,
  view = 'month',
  cursor,
  selectedDayId,
  onSelect,
  onOpenDate,
  focusedStopId,
  onFocusStop,
  filter = SHOW_ALL,
  startsOn = null,
}: {
  quarter: Quarter;
  days: readonly PlanDay[];
  settings: PlanSettings;
  /** Who is out, in order, with their colours (`quarterCrew`). */
  crew: readonly CrewMember[];
  view?: CalendarView;
  /** The date in view, `YYYY-MM-DD`; the quarter's first when absent. */
  cursor?: string;
  selectedDayId?: string;
  onSelect: (dayId: string) => void;
  /** A date's number was clicked: open that day. */
  onOpenDate?: (date: string) => void;
  /** The visit or booking the map is on, outlined where it is listed. */
  focusedStopId?: string;
  /**
   * A visit or booking was clicked on the week or the day: put the map on it
   * (the office, 2026-10-06). Without it, a click picks the visit's day.
   */
  onFocusStop?: (dayId: string, stopId: string) => void;
  filter?: CalendarFilter;
  /** The plan's own first day, `YYYY-MM-DD`, when it is not the quarter's. */
  startsOn?: string | null;
}) {
  const { year, quarter: number } = quarter;
  const months = useMemo(() => quarterMonths({ year, quarter: number }, startsOn), [year, number, startsOn]);
  // A plan for January can start in December: that year's holidays too.
  const federal = useMemo(() => new Set([...usFederalHolidays(year - 1), ...usFederalHolidays(year)]), [year]);
  const closed = useMemo(
    () => new Set(closedDaysOfQuarter({ year, quarter: number }, settings.holidays, startsOn)),
    [year, number, settings.holidays, startsOn],
  );
  const order = useMemo(() => new Map(crew.map((member, index) => [member.id, index])), [crew]);
  const colours = useMemo(() => new Map(crew.map((member) => [member.id, member.colour])), [crew]);
  const byDate = useMemo(() => {
    const grouped = new Map<string, PlanDay[]>();
    for (const day of days) {
      const date = day.date.slice(0, 10);
      grouped.set(date, [...(grouped.get(date) ?? []), day]);
    }
    for (const entries of grouped.values())
      entries.sort((left, right) => (order.get(left.technicianId) ?? 0) - (order.get(right.technicianId) ?? 0));
    return grouped;
  }, [days, order]);

  const shown = clampToCalendar(cursor ?? calendarDates(months)[0] ?? quarterFirstDay(quarter), months);
  const shared: Shared = {
    settings,
    filter,
    today: businessToday(),
    selectedDayId,
    daysOn: (date) => byDate.get(date) ?? [],
    noteOf: (date) =>
      closed.has(date)
        ? federal.has(date)
          ? 'US holiday'
          : 'Closed'
        : isRescheduleMonday(date, { year, quarter: number }, startsOn)
          ? 'Kept free'
          : null,
    colourOf: (technicianId) => colours.get(technicianId) ?? TECHNICIAN_COLOURS[0]!,
    onSelect,
    onOpenDate,
    focusedStopId,
    onFocusStop,
  };

  if (view === 'day') return <DayView date={shown} shared={shared} />;
  if (view === 'week') return <WeekView dates={weekOf(shown).filter((date) => calendarDates(months).includes(date))} shared={shared} />;
  const month = months.find((entry) => entry.weeks.some((week) => week.includes(shown))) ?? months[0]!;
  return <MonthView month={month} shared={shared} />;
}

/** A date's number, which opens that day; today's stands out, as in Jobber. */
function DateButton({ date, shared, children, className }: { date: string; shared: Shared; children: ReactNode; className?: string }) {
  const today = date === shared.today;
  const look = cn(
    'inline-flex items-baseline gap-1 rounded-md px-1.5 py-0.5 font-mono tabular-nums',
    today ? 'bg-primary text-primary-foreground' : shared.onOpenDate && 'hover:bg-accent',
    className,
  );
  if (!shared.onOpenDate) return <span className={look}>{children}</span>;
  return (
    <button
      aria-label={`Open ${LONG_DAY.format(at(date))}`}
      className={look}
      onClick={() => shared.onOpenDate?.(date)}
      type="button"
    >
      {children}
    </button>
  );
}

function MonthView({ month, shared }: { month: CalendarMonth; shared: Shared }) {
  return (
    <section aria-label={month.label}>
      <Table className="min-w-[30rem] table-fixed">
        {/* Pinned to the top of the calendar's own scroll box, not below the app's header. */}
        <TableHeader className="lg:top-0">
          <TableRow className="hover:bg-transparent">
            {WEEKDAYS.map((weekday) => (
              <TableHead className="tracking-wide uppercase" key={weekday} scope="col">
                {weekday}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {month.weeks.map((week) => (
            // A week, not a record: no row highlight under the pointer.
            <TableRow className="hover:bg-transparent" key={week.find(Boolean)}>
              {week.map((date, index) => {
                if (!date) return <TableCell aria-hidden className="bg-muted/40 border-r last:border-r-0" key={index} />;
                const entries = shared.daysOn(date);
                const note = shared.noteOf(date);
                const visits = shownVisits(entries, shared.filter);
                return (
                  <TableCell className={cn('h-24 border-r p-1.5 align-top last:border-r-0', note && 'bg-muted/40')} key={date}>
                    <div className="grid gap-1">
                      <div className="flex items-center justify-between gap-1">
                        <DateButton className="text-xs" date={date} shared={shared}>
                          {Number(date.slice(8))}
                        </DateButton>
                        {visits ? <CountPill className="truncate" count={visits} /> : null}
                      </div>
                      {note ? <span className="text-muted-foreground truncate px-0.5 text-[11px]">{note}</span> : null}
                      {entries.map((day) => (
                        <DayChip day={day} key={day.id} shared={shared} />
                      ))}
                    </div>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/** A technician-day on the month: who, the zone, the move-out diamond, and how many visits. */
function DayChip({ day, shared }: { day: PlanDay; shared: Shared }) {
  const outside = dayOutsideRules(day, shared.settings);
  const zones = zonesOf(day);
  const label = dayLabel(day, shared.settings);
  return (
    <button
      aria-current={day.id === shared.selectedDayId || undefined}
      aria-label={label}
      className={cn(
        'hover:bg-accent focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-[3px]',
        day.id === shared.selectedDayId && 'bg-accent border-ring',
        outside && 'border-destructive/60',
      )}
      onClick={() => shared.onSelect(day.id)}
      title={label}
      type="button"
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', shared.colourOf(day.technicianId))} />
      <span className="truncate font-medium">{shortName(day.technician.displayName)}</span>
      {zones.length ? <span className="text-muted-foreground shrink-0 font-mono">Z{zones.join(',')}</span> : null}
      {/* The diamond of a move-out or move-in, as on the day's map. */}
      {day.anchors?.length ? <span aria-hidden className="bg-warning size-2 shrink-0 rotate-45 rounded-[1px]" /> : null}
      <span className={cn('ml-auto shrink-0 font-mono tabular-nums', outside && 'text-destructive')}>
        {day.stops.filter(shared.filter.visit).length}
      </span>
    </button>
  );
}

/** One visit or booking as Jobber lists it on the week and the day: the address, and what it is. */
function VisitChip({
  entry,
  day,
  shared,
  time,
}: {
  entry: TimelineEntry;
  day: PlanDay;
  shared: Shared;
  time?: string;
}) {
  const zone = entry.kind === 'visit' ? zoneNumberOf(entry.zone) : null;
  const focused = entry.id === shared.focusedStopId;
  const what =
    entry.kind === 'booked'
      ? entry.booking === 'MOVE_OUT'
        ? 'Move-out'
        : 'Move-in'
      : entry.inspectionType === 'HVAC'
        ? 'HVAC'
        : 'Occupied';
  return (
    <button
      aria-current={focused || undefined}
      aria-label={`${entry.address ?? 'Unknown address'}, ${what.toLowerCase()}, on ${day.technician.displayName}’s day`}
      className={cn(
        'hover:bg-accent focus-visible:ring-ring/50 grid w-full min-w-0 gap-0.5 rounded-md border px-1.5 py-1 text-left text-xs outline-none focus-visible:ring-[3px]',
        entry.kind === 'booked' ? 'border-warning/50 bg-warning/10' : 'bg-muted/40',
        focused && 'border-ring bg-accent ring-ring ring-1',
      )}
      onClick={() => (shared.onFocusStop ? shared.onFocusStop(day.id, entry.id) : shared.onSelect(day.id))}
      title="Show it on the map"
      type="button"
    >
      <span className="line-clamp-2 leading-snug">
        {time ? <span className="text-muted-foreground font-mono tabular-nums">{time} </span> : null}
        {entry.address ?? 'Unknown address'}
      </span>
      <span className="text-muted-foreground truncate text-[11px]">{[zone ? `Zone ${zone}` : null, what].filter(Boolean).join(' · ')}</span>
    </button>
  );
}

function WeekView({ dates, shared }: { dates: string[]; shared: Shared }) {
  return (
    <section aria-label={`Week of ${LONG_DAY.format(at(weekOf(dates[0]!)[0]!))}`} className="grid min-w-[34rem] grid-cols-5 divide-x">
      {weekOf(dates[0]!).map((date) => {
        const inQuarter = dates.includes(date);
        const entries = inQuarter ? shared.daysOn(date) : [];
        const note = inQuarter ? shared.noteOf(date) : null;
        const visits = shownVisits(entries, shared.filter);
        return (
          <div aria-label={LONG_DAY.format(at(date))} className={cn('min-w-0', (note || !inQuarter) && 'bg-muted/40')} key={date} role="group">
            <div className="bg-card sticky top-0 z-10 grid justify-items-center gap-1 border-b px-1 py-2">
              <DateButton className="text-sm" date={date} shared={inQuarter ? shared : { ...shared, onOpenDate: undefined }}>
                {Number(date.slice(8))} <span className="font-sans font-medium">{SHORT_WEEKDAY.format(at(date))}</span>
              </DateButton>
              {visits ? (
                <CountPill count={visits} />
              ) : (
                <span className="text-muted-foreground h-4 truncate text-[11px] leading-4">{note ?? ''}</span>
              )}
            </div>
            <div className="grid content-start gap-2 p-1.5">
              {entries.map((day) => {
                const selected = day.id === shared.selectedDayId;
                return (
                  <div className={cn('grid gap-1 rounded-lg p-0.5', selected && 'bg-accent/60 ring-ring ring-1')} key={day.id}>
                    <button
                      aria-current={selected || undefined}
                      aria-label={dayLabel(day, shared.settings)}
                      className="hover:bg-accent flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs"
                      onClick={() => shared.onSelect(day.id)}
                      type="button"
                    >
                      <Avatar colour={shared.colourOf(day.technicianId)} name={day.technician.displayName} />
                      <span className="truncate font-medium">{shortName(day.technician.displayName)}</span>
                      <span
                        className={cn(
                          'text-muted-foreground ml-auto shrink-0 font-mono tabular-nums',
                          dayOutsideRules(day, shared.settings) && 'text-destructive',
                        )}
                      >
                        {day.stops.filter(shared.filter.visit).length}
                      </span>
                    </button>
                    {shownEntries(day, shared.filter).map((entry) => (
                      <VisitChip day={day} entry={entry} key={entry.id} shared={shared} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function DayView({ date, shared }: { date: string; shared: Shared }) {
  const entries = shared.daysOn(date);
  const note = shared.noteOf(date);
  return (
    <section aria-label={LONG_DAY.format(at(date))} className="grid content-start gap-3 p-3">
      <div className="grid justify-items-center gap-1">
        <DateButton className="text-base" date={date} shared={{ ...shared, onOpenDate: undefined }}>
          {Number(date.slice(8))} <span className="font-sans font-medium">{SHORT_WEEKDAY.format(at(date))}</span>
        </DateButton>
        {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
      </div>
      {entries.length ? (
        // Side by side however many are out, as Jobber's day: the calendar scrolls sideways rather than stacking them.
        <div className="grid auto-cols-[minmax(12rem,1fr)] grid-flow-col items-start gap-2">
          {entries.map((day) => (
            <DayColumn day={day} key={day.id} shared={shared} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground py-10 text-center text-sm">Nothing planned on this day.</p>
      )}
    </section>
  );
}

/** A technician's day, as Jobber gives each person a column: who, how many, and the visits with their times. */
function DayColumn({ day, shared }: { day: PlanDay; shared: Shared }) {
  const selected = day.id === shared.selectedDayId;
  const clock = dayClock(dayTimeline(day));
  const drive = day.totalDriveSeconds;
  return (
    <div className={cn('grid gap-1.5 rounded-lg border p-1.5', selected ? 'border-ring bg-accent/40' : 'hover:bg-muted/40')}>
      <button
        aria-current={selected || undefined}
        aria-label={dayLabel(day, shared.settings)}
        className="hover:bg-accent flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left"
        onClick={() => shared.onSelect(day.id)}
        type="button"
      >
        <Avatar className="size-6 text-[10px]" colour={shared.colourOf(day.technicianId)} name={day.technician.displayName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{day.technician.displayName}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {drive === null ? 'Drive not measured' : `${Math.round(drive / 60)} min drive`} · Est. day{' '}
            {formatDrive(day.onSiteMinutes * 60 + (drive ?? 0))}
          </span>
        </span>
        <CountPill
          className={cn(dayOutsideRules(day, shared.settings) && 'border-destructive/60 text-destructive')}
          count={day.stops.filter(shared.filter.visit).length}
        />
      </button>
      {clock
        .filter((entry) => (entry.kind === 'visit' ? shared.filter.visit(entry) : shared.filter.bookings))
        .map((entry) => (
          <VisitChip day={day} entry={entry} key={entry.id} shared={shared} time={formatClock(entry.arrives)} />
        ))}
    </div>
  );
}
