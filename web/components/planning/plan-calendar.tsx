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
import { useMemo } from 'react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { bookedInWords, dayOutsideRules, formatMinutes } from '@/lib/planning';
import type { PlanDay, PlanRotation, PlanSettings } from '@/lib/planning-queries';
import { cn } from '@/lib/utils';

/** One colour a technician keeps across the quarter, in the crew's zone order. */
const TECHNICIAN_COLOURS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];

/** Planned days are DATES, so they are read in UTC: in Manila, local time would show the day before. */
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DAY_MS = 86_400_000;

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

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

/** "Zone 2", or "Zones 1, 2" for a day that crosses two. */
function zonesOf(day: PlanDay) {
  const zones = [...new Set(day.stops.map((stop) => zoneNumberOf(stop.zone)).filter((zone): zone is string => Boolean(zone)))];
  zones.sort((left, right) => Number(left) - Number(right));
  return zones;
}

/**
 * The quarter's technician-days as a calendar: a month at a time, each day with
 * everyone out on it.
 *
 * Each technician keeps one colour, so a week reads at a glance as who covers
 * it; a day outside the office's rules is marked on its chip. A chip opens that
 * day, with its route and visits, in the Days tab.
 */
export function PlanCalendar({
  quarter,
  days,
  settings,
  rotation,
  selectedDayId,
  onSelect,
  startsOn = null,
}: {
  quarter: Quarter;
  days: PlanDay[];
  settings: PlanSettings;
  rotation?: PlanRotation | null;
  selectedDayId?: string;
  onSelect: (dayId: string) => void;
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

  // The crew in its zone order first, anyone else after by name: colours follow that order.
  const technicians = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; days: number; visits: number }>();
    for (const member of rotation?.crew ?? [])
      seen.set(member.technicianId, { id: member.technicianId, name: member.displayName ?? 'Someone', days: 0, visits: 0 });
    const others = new Map<string, { id: string; name: string; days: number; visits: number }>();
    for (const day of days) {
      const entry =
        seen.get(day.technicianId) ??
        others.get(day.technicianId) ??
        others.set(day.technicianId, { id: day.technicianId, name: day.technician.displayName, days: 0, visits: 0 }).get(day.technicianId)!;
      entry.days += 1;
      entry.visits += day.stopCount;
    }
    return [...[...seen.values()], ...[...others.values()].sort((left, right) => left.name.localeCompare(right.name))];
  }, [days, rotation]);
  const order = useMemo(() => new Map(technicians.map((technician, index) => [technician.id, index])), [technicians]);
  const colourOf = (technicianId: string) => TECHNICIAN_COLOURS[(order.get(technicianId) ?? 0) % TECHNICIAN_COLOURS.length];

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

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {technicians
          .filter((technician) => technician.days > 0)
          .map((technician) => (
            <span className="flex items-center gap-2" key={technician.id}>
              <span aria-hidden className={cn('size-2.5 rounded-full', colourOf(technician.id))} />
              <span className="font-medium">{technician.name}</span>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {technician.days} {technician.days === 1 ? 'day' : 'days'} · {technician.visits} visits
              </span>
            </span>
          ))}
      </div>

      {months.map((month) => {
        const monthDays = month.weeks.flat().flatMap((date) => (date ? (byDate.get(date) ?? []) : []));
        return (
          <section aria-label={month.label} className="grid gap-2" key={month.key}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-base font-semibold tracking-tight">{month.label}</h3>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {monthDays.length} technician-days · {monthDays.reduce((total, day) => total + day.stopCount, 0)} visits
              </span>
            </div>
            <div className="bg-card rounded-xl border">
              <Table className="min-w-[44rem] table-fixed">
                <TableHeader>
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
                        if (!date)
                          return <TableCell aria-hidden className="bg-muted/40 border-r last:border-r-0" key={index} />;
                        const entries = byDate.get(date) ?? [];
                        const note = closed.has(date)
                          ? federal.has(date)
                            ? 'US holiday'
                            : 'Closed'
                          : isRescheduleMonday(date, { year, quarter: number }, startsOn)
                            ? 'Kept free'
                            : null;
                        return (
                          <TableCell
                            className={cn('h-24 border-r p-1.5 align-top last:border-r-0', note && 'bg-muted/40')}
                            key={date}
                          >
                            <div className="grid gap-1">
                              <div className="flex items-baseline justify-between gap-2 px-0.5">
                                <span className="font-mono text-xs tabular-nums">{Number(date.slice(8))}</span>
                                {note ? <span className="text-muted-foreground truncate text-[11px]">{note}</span> : null}
                              </div>
                              {entries.map((day) => {
                                const outside = dayOutsideRules(day, settings);
                                const zones = zonesOf(day);
                                const booked = day.anchors ?? [];
                                const name = day.technician.displayName;
                                const label = `${LONG_DAY.format(new Date(`${date}T00:00:00Z`))}: ${name}, ${day.stopCount} ${
                                  day.stopCount === 1 ? 'visit' : 'visits'
                                }${day.hvacStopCount ? ` (${day.hvacStopCount} HVAC)` : ''}${
                                  zones.length ? `, ${zones.length === 1 ? 'zone' : 'zones'} ${zones.join(', ')}` : ''
                                }${booked.length ? `, built around ${bookedInWords(booked)}` : ''}, ${formatMinutes(
                                  day.onSiteMinutes,
                                )} inspecting${outside ? ', outside the rules' : ''}`;
                                return (
                                  <button
                                    aria-current={day.id === selectedDayId || undefined}
                                    aria-label={label}
                                    className={cn(
                                      'hover:bg-accent focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-[3px]',
                                      day.id === selectedDayId && 'bg-accent border-ring',
                                      outside && 'border-destructive/60',
                                    )}
                                    key={day.id}
                                    onClick={() => onSelect(day.id)}
                                    title={label}
                                    type="button"
                                  >
                                    <span aria-hidden className={cn('size-2 shrink-0 rounded-full', colourOf(day.technicianId))} />
                                    <span className="truncate font-medium">{name.split(' ')[0]}</span>
                                    {zones.length ? (
                                      <span className="text-muted-foreground shrink-0 font-mono">Z{zones.join(',')}</span>
                                    ) : null}
                                    {/* The diamond of a move-out or move-in, as on the day's map. */}
                                    {booked.length ? <span aria-hidden className="bg-warning size-2 shrink-0 rotate-45 rounded-[1px]" /> : null}
                                    <span
                                      className={cn('ml-auto shrink-0 font-mono tabular-nums', outside && 'text-destructive')}
                                    >
                                      {day.stopCount}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
