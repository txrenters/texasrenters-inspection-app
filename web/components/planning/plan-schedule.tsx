'use client';

import { zoneNumberOf, type Quarter } from '@texasrenters/shared';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarOffIcon,
  ChevronDownIcon,
  MapIcon,
  RouteIcon,
  SlidersHorizontalIcon,
  XIcon,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

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
import { PROPERTY_ZOOM } from '@/components/map-camera';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { businessToday } from '@/lib/clock';
import { formatDistance } from '@/lib/format';
import {
  dayClock,
  formatClock,
  formatMinutes,
  formatShortDay,
  leaveHomeAt,
  legOverLimit,
  limitState,
  type LimitState,
} from '@/lib/planning';
import {
  usePlanDayRoute,
  usePlanningMutations,
  type OptimizedPlanDay,
  type PlanDay,
  type PlanDayAnchor,
  type PlanRotation,
  type PlanSettings,
} from '@/lib/planning-queries';
import { cn } from '@/lib/utils';

import { FilterPill, type FilterOption } from './filter-pill';
import type { GroupFileRow } from './group-file';
import { DEFAULT_MAP_DISPLAY, MapDisplaySwitches, type MapDisplay } from './group-file-view';
import type { MapFrame } from './group-file-map';
import {
  calendarDates,
  calendarTitle,
  clampToCalendar,
  dayTimeline,
  PlanCalendar,
  quarterCrew,
  quarterMonths,
  stepCursor,
  type CalendarFilter,
  type CalendarView,
} from './plan-calendar';
import type { DayStop } from './plan-day-groups';
import { dayRouteView, planDaysFile, type DayMapEntry } from './plan-days-groups';
import { formatDrive } from './road-routes';
import { useFillHeight } from './use-fill-height';
import { zoneTerritories } from './zone-territories';

const PlanDaysMap = dynamic(() => import('./plan-days-map').then((module) => module.PlanDaysMap), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-lg" />,
});

/** A planned day is a DATE, so it is read in UTC: in Manila, local time would show the day before. */
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

const LIMIT_TEXT: Record<LimitState, string> = {
  within: 'text-muted-foreground',
  near: 'text-warning',
  over: 'text-destructive',
};

/** Limit colour on a figure that is otherwise ordinary text: only near and over say anything. */
const toneOf = (state: LimitState) => (state === 'within' ? '' : LIMIT_TEXT[state]);

const BOOKING_LABEL: Record<PlanDayAnchor['kind'], string> = { MOVE_OUT: 'Move-out', MOVE_IN: 'Move-in' };

const VIEWS: { value: CalendarView; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
];

const TYPE_OPTIONS: FilterOption[] = [
  { value: 'HVAC', label: 'HVAC inspections' },
  { value: 'OCCUPIED', label: 'Occupied inspections' },
  { value: 'BOOKED', label: 'Move-outs and move-ins' },
];

/** A visit on a day is either still the plan's, or booked in Jobber by a publish. */
const STATUS_OPTIONS: FilterOption[] = [
  { value: 'PLANNED', label: 'Not booked yet' },
  { value: 'PUBLISHED', label: 'Booked in Jobber' },
];

/** What the office needs to do about a move-out or move-in a day is built around, if anything. */
export function bookedProblem(
  day: PlanDay,
  anchor: Pick<PlanDayAnchor, 'cancelled' | 'scheduledOn' | 'assignedTechnician'>,
): string | null {
  if (anchor.cancelled) return 'Cancelled since the plan was laid out · rebuild';
  if (anchor.scheduledOn !== day.date.slice(0, 10)) return `Moved to ${formatShortDay(anchor.scheduledOn)} · rebuild`;
  // A move-out or move-in is on the day of whoever it was assigned to (2026-10-01);
  // assigned to someone else since, the day no longer holds it.
  if (anchor.assignedTechnician?.id !== day.technician.id)
    return `${anchor.assignedTechnician ? `Now ${anchor.assignedTechnician.displayName}’s` : 'Not assigned now'} · rebuild`;
  return null;
}

/** Minutes driving between a day's properties, or null when nothing measured it. */
const driveMinutes = (day: PlanDay) => (day.totalDriveSeconds === null ? null : Math.round(day.totalDriveSeconds / 60));

/** A day as the office names it: "Thu, Dec 17 · Moses Rodriguez". */
const dayName = (day: PlanDay) => `${DAY.format(new Date(day.date))} · ${day.technician.displayName}`;

const dateOf = (day: PlanDay) => day.date.slice(0, 10);

/** Whether a day is behind us: its order is history, and nothing joins it. */
const hasPassed = (day: PlanDay) => dateOf(day) < businessToday();

/** The day the page opens on: the first from today on, or the quarter's first when every day has passed. */
function firstDayToShow(days: readonly PlanDay[]) {
  const today = businessToday();
  let next: PlanDay | null = null;
  for (const day of days) if (dateOf(day) >= today && (!next || dateOf(day) < dateOf(next))) next = day;
  return next ?? days[0] ?? null;
}

/**
 * The office's template group a day was laid out from: its colour and "Group 12
 * · Katy North", as the Group maker names it (the office, 2026-10-01).
 */
export function TemplateGroupTag({
  group,
  className,
}: {
  group: NonNullable<PlanDay['templateGroup']>;
  className?: string;
}) {
  const number = `Group ${group.position}`;
  const name = group.name.trim();
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span
        aria-hidden
        className="inline-block size-2.5 shrink-0 rounded-full border border-white shadow-sm"
        style={{ backgroundColor: group.color }}
      />
      <span className="truncate">{name && name !== number ? `${number} · ${name}` : number}</span>
    </span>
  );
}

/** A day put in its best order, in words: what it did to the driving. */
function optimizedInWords(days: readonly OptimizedPlanDay[]) {
  const changed = days.filter((day) => day.changed);
  const minutes = (seconds: number) => formatDrive(seconds);
  const total = (pick: (day: OptimizedPlanDay) => number | null) => changed.reduce((sum, day) => sum + (pick(day) ?? 0), 0);
  if (!changed.length) return null;
  return `driving between properties ${minutes(total((day) => day.driveSecondsBefore))} → ${minutes(
    total((day) => day.driveSecondsAfter),
  )}; from home ${minutes(total((day) => day.homeDriveSecondsBefore))} → ${minutes(total((day) => day.homeDriveSecondsAfter))}`;
}

type MovingVisit = Extract<DayMapEntry, { kind: 'visit' }>;

/**
 * The quarter's days as a schedule, laid out as Jobber's (the office,
 * 2026-10-05): the calendar on the left -- a month, a week or a day -- with
 * Team, Type and Status filters, and the map on the right drawing the day
 * picked and nothing else, from the technician's home with each leg's drive.
 * The other days come back faded behind a switch, for moving a visit into the
 * day picked with a click on its property. The day's visits and times are
 * listed under, with Optimize route.
 */
export function PlanSchedule({
  planId,
  quarter,
  startsOn = null,
  days,
  visits,
  settings,
  rotation = null,
  selectedDayId,
  onSelect,
  view,
  onViewChange,
  onOpenStop,
  unscheduledCount = 0,
  onShowUnscheduled,
  onToday,
  canChange = false,
  canMoveVisits = false,
  jobberEditsPushed = null,
}: {
  planId: string;
  quarter: Quarter;
  /** The plan's own first day, `YYYY-MM-DD`, when it is not the quarter's. */
  startsOn?: string | null;
  days: PlanDay[];
  /** Every visit of the quarter, with no day or with one: what the map can move into a day. */
  visits: readonly DayStop[];
  settings: PlanSettings;
  rotation?: PlanRotation | null;
  selectedDayId: string;
  onSelect: (dayId: string) => void;
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  /** A stop's pin or row was clicked: open its details. */
  onOpenStop?: (stopId: string) => void;
  /** Visits with no day yet, on the button that lists them. */
  unscheduledCount?: number;
  onShowUnscheduled?: () => void;
  /** Today is in another quarter's calendar: open that quarter. Absent when it is in this one. */
  onToday?: () => void;
  /** May change the plan: put a day in order, place a visit not booked yet. */
  canChange?: boolean;
  /** May reschedule a booked visit: the planner's grant and the inspections one. */
  canMoveVisits?: boolean;
  /** Whether the console's edits reach Jobber; null when not known (a quarter not published). */
  jobberEditsPushed?: boolean | null;
}) {
  const months = useMemo(
    () => quarterMonths({ year: quarter.year, quarter: quarter.quarter }, startsOn),
    [quarter.year, quarter.quarter, startsOn],
  );
  const crew = useMemo(() => quarterCrew(days, rotation), [days, rotation]);
  const order = useMemo(() => new Map(crew.map((member, index) => [member.id, index])), [crew]);
  const selected = days.find((day) => day.id === selectedDayId) ?? firstDayToShow(days);
  const mutations = usePlanningMutations();
  const [cursor, setCursor] = useState(() => clampToCalendar(selected ? dateOf(selected) : businessToday(), months));
  const [hiddenTeam, setHiddenTeam] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenStatuses, setHiddenStatuses] = useState<ReadonlySet<string>>(() => new Set());
  const [showMap, setShowMap] = useState(true);
  // Only the day picked, unless asked (the office, 2026-10-05: the other days all around it confused the map).
  const [showOthers, setShowOthers] = useState(false);
  // The zones' ground is off too: one day on the map reads alone (the office, 2026-10-05), and it is a switch away.
  const [display, setDisplay] = useState<MapDisplay>({ ...DEFAULT_MAP_DISPLAY, zones: false });
  const [moving, setMoving] = useState<MovingVisit | null>(null);
  /**
   * A visit or booking clicked on the week or the day, which the map goes to
   * with its details open (the office, 2026-10-06: "nothing happens if I click
   * each property from the calendar"). Picking a day, or another day, lets go.
   */
  // `at` makes a second click on the same visit go back to it after the map was moved.
  const [focus, setFocus] = useState<{ dayId: string; stopId: string; at: number } | null>(null);
  /** The calendar and the map fill the window on a large screen, as in the Group maker. */
  const fill = useFillHeight<HTMLDivElement>();

  const filter = useMemo<CalendarFilter>(
    () => ({
      visit: (stop) =>
        !hiddenTypes.has(stop.inspectionType) && !hiddenStatuses.has(stop.status === 'PUBLISHED' ? 'PUBLISHED' : 'PLANNED'),
      bookings: !hiddenTypes.has('BOOKED'),
    }),
    [hiddenStatuses, hiddenTypes],
  );
  const shownDays = useMemo(() => {
    const filtering = hiddenTypes.size > 0 || hiddenStatuses.size > 0;
    return days.filter(
      (day) =>
        !hiddenTeam.has(day.technicianId) &&
        (!filtering || day.stops.some(filter.visit) || (filter.bookings && Boolean(day.anchors?.length))),
    );
  }, [days, filter, hiddenStatuses.size, hiddenTeam, hiddenTypes.size]);
  const teamOptions = useMemo<FilterOption[]>(
    () =>
      crew
        .filter((member) => member.days > 0)
        .map((member) => ({
          value: member.id,
          label: member.name,
          swatch: member.colour,
          detail: `${member.days} ${member.days === 1 ? 'day' : 'days'} · ${member.visits} visits`,
        })),
    [crew],
  );

  const dates = calendarDates(months);
  const today = businessToday();
  const todayInQuarter = dates.length > 0 && today >= dates[0]! && today <= dates.at(-1)!;
  /** A date's technician-days the filters let through, in the crew's order. */
  const daysOn = (date: string) =>
    shownDays
      .filter((day) => dateOf(day) === date)
      .sort((left, right) => (order.get(left.technicianId) ?? 0) - (order.get(right.technicianId) ?? 0));
  /**
   * To a date, and a view. The Day view is about the date, so the map follows
   * it: that date's first technician-day, unless one of its days is picked
   * already. Today does the same in any view -- the map shows today's route.
   */
  const goTo = (date: string, next: CalendarView = view, follow = next === 'day') => {
    const target = clampToCalendar(date, months);
    setCursor(target);
    if (next !== view) onViewChange(next);
    if (follow && (!selected || dateOf(selected) !== target)) {
      const first = daysOn(target)[0];
      if (first) {
        setFocus(null);
        onSelect(first.id);
      }
    }
  };
  /**
   * Today, as Jobber's button: always there (the office, 2026-10-06, finding
   * it greyed out on a quarter that starts in December). A quarter whose
   * calendar does not reach today hands over to the one that does.
   */
  const goToToday = () => {
    if (todayInQuarter || !onToday) goTo(today, view, true);
    else onToday();
  };
  const pick = (dayId: string) => {
    const day = days.find((entry) => entry.id === dayId);
    if (day) setCursor(dateOf(day));
    setFocus(null);
    onSelect(dayId);
  };
  /** A visit or booking clicked on the calendar: its day picked, and the map on it. */
  const pickStop = (dayId: string, stopId: string) => {
    const day = days.find((entry) => entry.id === dayId);
    if (day) setCursor(dateOf(day));
    if (dayId !== selected?.id) onSelect(dayId);
    setFocus({ dayId, stopId, at: Date.now() });
    setShowMap(true);
  };
  const previous = stepCursor(view, cursor, -1, months);
  const next = stepCursor(view, cursor, 1, months);

  const made = useMemo(() => planDaysFile(days, visits), [days, visits]);
  /** The pin the map is on: a stop of the day picked, while it is still that day's. */
  const focused = focus && focus.dayId === selected?.id ? (made.rowOfStop.get(focus.stopId) ?? null) : null;
  const route = usePlanDayRoute(planId, selected?.id);
  const group = selected ? (made.groupOf.get(selected.id) ?? null) : null;
  const home = route.data?.home ?? null;
  /** The day starts at home when it was routed from there: the "From" on the map. */
  const origin = useMemo(
    () =>
      selected?.originKind === 'HOME' && home
        ? { latitude: home.latitude, longitude: home.longitude, title: `From: ${home.address ?? 'the technician’s home'}` }
        : null,
    [home, selected?.originKind],
  );
  const routeView = useMemo(
    () => (selected && group ? dayRouteView(selected, group, route.data, origin) : undefined),
    [group, origin, route.data, selected],
  );
  /** Every property's zone, with a day or not: a zone is the tenancy's, not the day's. */
  const zones = useMemo(
    () =>
      display.zones ? zoneTerritories([...made.file.groups.flatMap((one) => one.rows), ...made.file.ungrouped]) : [],
    [display.zones, made],
  );
  /** What the map draws: the day picked alone, or every day faded behind it and the visits with no day. */
  const mapGroups = useMemo(
    () => (showOthers ? made.file.groups : group ? [group] : []),
    [group, made.file.groups, showOthers],
  );
  /**
   * Framed when another day is picked, or its home arrives -- never because a
   * click moved a visit into it: the map frames again only when the key changes.
   */
  const frame = useMemo<MapFrame>(
    () =>
      focused && focus
        ? { key: `stop:${focus.stopId}:${focus.at}`, points: [focused], zoom: PROPERTY_ZOOM }
        : {
            key: `${selected?.id ?? ''}:${origin ? 'home' : ''}`,
            points: [...(group?.rows ?? []), ...(origin ? [origin] : [])],
          },
    [focus, focused, group, origin, selected?.id],
  );

  const optimizeDay = (day: PlanDay) =>
    mutations.optimizeDay.mutate(
      { planId, dayId: day.id },
      {
        onSuccess: ({ days: optimized }) => {
          const words = optimizedInWords(optimized);
          if (words) toast.success(`${dayName(day)} is in its best order`, { description: words });
          else toast.info(`${dayName(day)} was already in the order that drives least from home`);
        },
        onError: (error) => toast.error('The route could not be optimized', { description: error.message }),
      },
    );
  const optimizeEveryDay = () =>
    mutations.optimizeDays.mutate(planId, {
      onSuccess: ({ days: optimized }) => {
        const changed = optimized.filter((day) => day.changed).length;
        const words = optimizedInWords(optimized);
        if (words)
          toast.success(`${changed} of ${optimized.length} ${optimized.length === 1 ? 'day' : 'days'} put in a better order`, {
            description: words,
          });
        else toast.info('Every day from today on was already in the order that drives least from home');
      },
      onError: (error) => toast.error('The routes could not be optimized', { description: error.message }),
    });

  const onRowClick = (row: GroupFileRow) => {
    const entry = made.entries.get(row.rowNumber);
    if (!entry || !selected) return;
    if (entry.kind === 'booking') {
      toast.info('A move-out or move-in is its own inspection', { description: 'Move it from the inspection, or in Jobber.' });
      return;
    }
    // One of the day's own: its details, as a click on it in the list opens them.
    if (entry.dayId === selected.id) {
      onOpenStop?.(entry.stopId);
      return;
    }
    setMoving(entry);
  };
  /** Why a visit cannot join the day picked from here, or null when it can. */
  const cannotMove = (visit: MovingVisit): string | null => {
    if (!selected) return 'Pick a day first.';
    if (!canChange) return 'Changing the plan needs permission to publish it.';
    if (hasPassed(selected)) return 'That day has passed, so nothing can join it.';
    if (!visit.booked) return null;
    if (!canMoveVisits) return 'Moving a booked visit reschedules its inspection, which needs permission to manage inspections.';
    if (visit.technicianId !== selected.technicianId)
      return 'A booked visit moves here only to another day of the same technician. Give it to someone else from its inspection.';
    if (jobberEditsPushed === false)
      return 'This visit is booked in Jobber, and the console’s edits are not sent to Jobber. Move it in Jobber.';
    return null;
  };
  const move = (visit: MovingVisit) => {
    if (!selected) return;
    const to = dayName(selected);
    mutations.moveToDay.mutate(
      { planId, dayId: selected.id, stopId: visit.stopId },
      {
        onSuccess: ({ days: optimized }) => {
          const joined = optimized.find((day) => day.dayId === selected.id);
          toast.success(`${visit.address || 'The visit'} moved to ${to}`, {
            description: [
              visit.booked ? 'Rescheduled here and in Jobber.' : null,
              joined?.driveSecondsAfter != null
                ? `The day now drives ${formatDrive(joined.driveSecondsAfter)} between its properties.`
                : null,
            ]
              .filter(Boolean)
              .join(' '),
          });
        },
        onError: (error) => toast.error('The visit was not moved', { description: error.message }),
      },
    );
  };

  const optimizingDay = mutations.optimizeDay.isPending ? mutations.optimizeDay.variables?.dayId : null;
  const fromDay = moving?.dayId ? (days.find((day) => day.id === moving.dayId) ?? null) : null;
  const blocked = moving ? cannotMove(moving) : null;

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={`${calendarTitle(cursor)}: choose a month`}
                className="hover:bg-accent -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-lg font-semibold tracking-tight"
                type="button"
              >
                {calendarTitle(cursor)}
                <ChevronDownIcon className="text-muted-foreground size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {months.map((month) => (
                <DropdownMenuItem key={month.key} onSelect={() => goTo(calendarDates([month])[0] ?? cursor)}>
                  {month.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-1">
            <Button aria-label={`Previous ${view}`} disabled={previous === cursor} onClick={() => goTo(previous)} size="icon-sm" variant="outline">
              <ArrowLeftIcon />
            </Button>
            <Button aria-label={`Next ${view}`} disabled={next === cursor} onClick={() => goTo(next)} size="icon-sm" variant="outline">
              <ArrowRightIcon />
            </Button>
            <Button
              onClick={goToToday}
              size="sm"
              title={todayInQuarter || !onToday ? undefined : 'Today is in another quarter: opens that one'}
              variant="outline"
            >
              Today
            </Button>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <FilterPill hidden={hiddenTeam} label="Team" onChange={setHiddenTeam} options={teamOptions} />
            <FilterPill hidden={hiddenTypes} label="Type" onChange={setHiddenTypes} options={TYPE_OPTIONS} />
            <FilterPill hidden={hiddenStatuses} label="Status" onChange={setHiddenStatuses} options={STATUS_OPTIONS} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div aria-label="Calendar view" className="inline-flex rounded-md border p-0.5" role="group">
            {VIEWS.map((entry) => (
              <button
                aria-pressed={view === entry.value}
                className={cn(
                  'rounded px-3 py-1 text-sm font-medium transition-colors',
                  view === entry.value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                key={entry.value}
                onClick={() => goTo(cursor, entry.value)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
          {onShowUnscheduled ? (
            <Button
              aria-label={`${unscheduledCount.toLocaleString()} ${unscheduledCount === 1 ? 'visit' : 'visits'} with no day yet`}
              onClick={onShowUnscheduled}
              size="sm"
              title="Visits with no day yet"
              variant="outline"
            >
              <CalendarOffIcon />
              <span className="font-mono tabular-nums">{unscheduledCount.toLocaleString()}</span>
            </Button>
          ) : null}
          <Button
            aria-label={showMap ? 'Hide the map' : 'Show the map'}
            aria-pressed={showMap}
            onClick={() => setShowMap(!showMap)}
            size="icon-sm"
            variant={showMap ? 'default' : 'outline'}
          >
            <MapIcon />
          </Button>
        </div>
      </div>

      <div
        className={cn('grid gap-3', showMap && 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-[minmax(0,1fr)]')}
        ref={fill.ref}
        style={fill.height ? { height: fill.height } : undefined}
      >
        <div className="bg-card min-h-0 overflow-auto rounded-xl border">
          <PlanCalendar
            crew={crew}
            cursor={cursor}
            days={shownDays}
            filter={filter}
            focusedStopId={focused ? focus?.stopId : undefined}
            onFocusStop={pickStop}
            onOpenDate={(date) => goTo(date, 'day')}
            onSelect={pick}
            quarter={quarter}
            selectedDayId={selected?.id}
            settings={settings}
            startsOn={startsOn}
            view={view}
          />
        </div>

        {showMap ? (
          <div className="bg-card flex h-96 min-h-0 flex-col overflow-hidden rounded-xl border lg:h-auto">
            <div className="flex items-center gap-x-3 border-b px-3 py-1.5">
              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm whitespace-nowrap" title="The quarter’s other days, faded, and the visits with no day yet">
                <Switch aria-label="Show other days" checked={showOthers} onCheckedChange={setShowOthers} />
                Show other days
              </label>
              <div className="ml-auto flex items-center gap-1">
                {canChange ? (
                  <Button
                    aria-label="Optimize every day"
                    disabled={mutations.optimizeDays.isPending}
                    onClick={optimizeEveryDay}
                    size="sm"
                    title="Every day from today on, in the order that drives least from the technician’s home"
                    variant="ghost"
                  >
                    {mutations.optimizeDays.isPending ? <Spinner /> : <RouteIcon />}
                    <span className="hidden 2xl:inline">{mutations.optimizeDays.isPending ? 'Optimizing…' : 'Optimize every day'}</span>
                  </Button>
                ) : null}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button aria-label="Map options" size="icon-sm" variant="ghost">
                      <SlidersHorizontalIcon />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="grid w-60 gap-3">
                    <MapDisplaySwitches display={display} onChange={setDisplay} />
                  </PopoverContent>
                </Popover>
                <Button aria-label="Close the map" onClick={() => setShowMap(false)} size="icon-sm" variant="ghost">
                  <XIcon />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <PlanDaysMap
                activeKey={selected?.id ?? null}
                display={display}
                fadeOthers
                focusRow={focused?.rowNumber ?? null}
                frame={frame}
                groups={mapGroups}
                onPickDay={pick}
                onRowClick={onRowClick}
                origin={origin}
                route={routeView}
                ungrouped={showOthers ? made.file.ungrouped : []}
                zones={zones}
              />
            </div>
          </div>
        ) : null}
      </div>

      {selected && showMap && showOthers && canChange ? (
        <p className="text-muted-foreground -mt-1 text-xs">Click a property on the map to move its visit into {dayName(selected)}.</p>
      ) : null}
      {showMap && route.isSuccess && !route.data.geometry.length && (group?.rows.length ?? 0) > 1 ? (
        <p className="text-muted-foreground -mt-1 text-xs">The road could not be drawn, so the stops are joined with dashed straight lines.</p>
      ) : null}

      {selected ? (
        <DayDetail
          day={selected}
          onOpenStop={onOpenStop}
          onOptimize={canChange ? () => optimizeDay(selected) : undefined}
          optimizing={optimizingDay === selected.id}
          optimizeDisabled={hasPassed(selected) || Boolean(optimizingDay) || mutations.optimizeDays.isPending}
          settings={settings}
        />
      ) : null}

      <AlertDialog onOpenChange={(open) => !open && setMoving(null)} open={moving !== null}>
        {moving && selected ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Move {moving.address || 'this visit'} to {dayName(selected)}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {fromDay ? `It is on ${dayName(fromDay)} now.` : 'It has no day yet.'}{' '}
                {moving.booked
                  ? 'It is booked, so its inspection is rescheduled, here and in Jobber.'
                  : 'It joins the day as one of its visits.'}{' '}
                Both days are then put in the order that drives least from home.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {blocked ? <p className="text-destructive text-sm">{blocked}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={Boolean(blocked) || mutations.moveToDay.isPending}
                onClick={() => {
                  move(moving);
                  setMoving(null);
                }}
              >
                Move here
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}

/** How the day's drives were measured, in a line. */
function measuredText(day: PlanDay) {
  const fromHome = day.originKind === 'HOME';
  const counted = fromHome
    ? 'Routed from the technician’s home; the drive from home is shown apart.'
    : 'Built without the technician’s home, so it starts at its first job. Optimize the route to start it from home.';
  switch (day.durationSource) {
    case 'GOOGLE_TRAFFIC_AWARE':
      return `Drives measured by Google for a 9 AM start. ${counted}`;
    case 'MAPBOX_FREE_FLOW':
      // Free-flow on purpose, not a limitation: the office asked for times
      // from the road rather than from whatever the traffic was on the
      // afternoon the quarter happened to be built.
      return `Drives measured on the road, without traffic. ${counted}`;
    case 'OSRM_FREE_FLOW':
      return `Drives measured without traffic. ${counted}`;
    case 'HAVERSINE':
      return 'No drive times could be measured for this day; the distances are in a straight line.';
    default:
      return fromHome
        ? 'One property, so there is nothing to drive between; the drive from home is shown apart.'
        : 'One property, so there is nothing to drive between.';
  }
}

/** The day picked: its figures, and its stops with their times, in driving order. */
function DayDetail({
  day,
  settings,
  onOpenStop,
  onOptimize,
  optimizing = false,
  optimizeDisabled = false,
}: {
  day: PlanDay;
  settings: PlanSettings;
  onOpenStop?: (stopId: string) => void;
  /** Put the day in the order that drives least from home; absent without the grant. */
  onOptimize?: () => void;
  optimizing?: boolean;
  optimizeDisabled?: boolean;
}) {
  const timeline = useMemo(() => dayTimeline(day), [day]);
  const clock = useMemo(() => dayClock(timeline), [timeline]);
  const drive = driveMinutes(day);
  const ends = clock.at(-1)?.leaves;
  const homeMinutes = day.homeDriveSeconds === null ? null : Math.round(day.homeDriveSeconds / 60);
  const onSite = limitState(day.onSiteMinutes, settings.maxOnSiteMinutes);

  return (
    <section aria-label={`${LONG_DAY.format(new Date(day.date))}, ${day.technician.displayName}`} className="grid gap-3">
      <div className="bg-card grid gap-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <h2 className="text-base font-semibold tracking-tight">{LONG_DAY.format(new Date(day.date))}</h2>
            <span className="text-sm font-medium">{day.technician.displayName}</span>
          </div>
          {onOptimize ? (
            <Button
              aria-label={`Optimize the route of ${dayName(day)}`}
              disabled={optimizeDisabled}
              onClick={onOptimize}
              size="sm"
              title={hasPassed(day) ? 'This day has passed' : 'The order that drives least from the technician’s home'}
              variant="outline"
            >
              {optimizing ? <Spinner /> : <RouteIcon />}
              Optimize route
            </Button>
          ) : null}
        </div>
        {day.templateGroup ? <TemplateGroupTag className="text-sm" group={day.templateGroup} /> : null}
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Inspecting</dt>
            <dd className={cn('font-mono tabular-nums', toneOf(onSite))}>
              {formatMinutes(day.onSiteMinutes)} of {formatMinutes(settings.maxOnSiteMinutes)}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Driving</dt>
            <dd className="font-mono tabular-nums">
              {drive === null ? 'not measured' : `${drive} min between properties`}
              {day.totalDriveMeters ? ` · ${formatDistance(day.totalDriveMeters)}` : ''}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Day</dt>
            <dd className="font-mono tabular-nums">
              {clock.length ? `${formatClock(clock[0]!.arrives)} – ${formatClock(ends!)}` : '—'}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">From home</dt>
            <dd className="font-mono tabular-nums">
              {day.originKind !== 'HOME'
                ? 'not used'
                : homeMinutes === null || !clock.length
                  ? 'not measured'
                  : `${homeMinutes} min${day.homeDriveMeters ? ` · ${formatDistance(day.homeDriveMeters)}` : ''} · leave ${formatClock(
                      leaveHomeAt(clock[0]!.arrives, day.homeDriveSeconds!),
                    )}`}
            </dd>
          </div>
        </dl>
        <p className="text-muted-foreground text-xs">{measuredText(day)}</p>
      </div>

      <ol className="bg-card divide-border divide-y rounded-xl border">
        {clock.map((stop, index) => (
          <li className="grid gap-1 px-4 py-2.5" key={stop.id}>
            {index > 0 ? (
              legOverLimit(stop.driveSecondsForecast, settings.maxLegMinutes) ? (
                <span className="text-destructive text-xs">
                  {stop.driveMinutes} min drive · over the {settings.maxLegMinutes} min between properties
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">
                  {stop.driveSecondsForecast === null ? 'Drive not measured' : `${stop.driveMinutes} min drive`}
                </span>
              )
            ) : homeMinutes !== null ? (
              <span className="text-muted-foreground text-xs">{homeMinutes} min from home</span>
            ) : null}
            {stop.kind === 'booked' ? (
              <div className="-mx-2 flex items-start gap-3 rounded-md px-2 py-1">
                <span
                  aria-hidden
                  className="bg-warning mt-0.5 flex size-6 shrink-0 rotate-45 items-center justify-center rounded-sm"
                >
                  <span className="-rotate-45 text-[11px] font-bold text-white">{stop.positionInDay ?? index + 1}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <Link className="truncate text-sm font-medium hover:underline" href={`/inspections/${stop.inspectionId}`}>
                      {stop.address ?? 'Unknown address'}
                    </Link>
                    <span className="text-muted-foreground font-mono text-xs tabular-nums">
                      {formatClock(stop.arrives)} – {formatClock(stop.leaves)}
                    </span>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                    {stop.city ? <span>{stop.city}</span> : null}
                    <Badge variant="warning">{BOOKING_LABEL[stop.booking]}</Badge>
                    <span>{formatMinutes(stop.onSiteMinutes)}</span>
                    {bookedProblem(day, stop) ? (
                      <span className="text-destructive">{bookedProblem(day, stop)}</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
            <button
              aria-label={`Details of stop ${stop.positionInDay ?? index + 1}, ${stop.address ?? 'unknown address'}`}
              className="hover:bg-accent/60 focus-visible:ring-ring/50 -mx-2 flex items-start gap-3 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-[3px] disabled:pointer-events-none"
              disabled={!onOpenStop}
              onClick={() => onOpenStop?.(stop.id)}
              type="button"
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center text-[11px] font-bold text-white',
                  stop.inspectionType === 'HVAC' ? 'bg-map-property rounded-md' : 'bg-map-route rounded-full',
                )}
              >
                {stop.positionInDay ?? index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="truncate text-sm font-medium">{stop.address ?? 'Unknown address'}</span>
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {formatClock(stop.arrives)} – {formatClock(stop.leaves)}
                  </span>
                </div>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                  <span>{[stop.city, zoneNumberOf(stop.zone) ? `Zone ${zoneNumberOf(stop.zone)}` : null].filter(Boolean).join(' · ')}</span>
                  <Badge variant={stop.inspectionType === 'HVAC' ? 'info' : 'secondary'}>
                    {stop.inspectionType === 'HVAC' ? 'HVAC inspection' : 'Occupied inspection'}
                  </Badge>
                  <span>{formatMinutes(stop.onSiteMinutes ?? 0)}</span>
                </div>
              </div>
            </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
