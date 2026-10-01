'use client';

import { zoneNumberOf } from '@texasrenters/shared';
import { RouteIcon } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { businessToday } from '@/lib/clock';
import { formatDistance } from '@/lib/format';
import {
  bookedInWords,
  dayClock,
  formatClock,
  formatMinutes,
  formatShortDay,
  leaveHomeAt,
  legOverLimit,
  limitState,
  longestLegSeconds,
  type LimitState,
} from '@/lib/planning';
import {
  usePlanDayRoute,
  usePlanningMutations,
  type OptimizedPlanDay,
  type PlanDay,
  type PlanDayAnchor,
  type PlanDayStop,
  type PlanRotation,
  type PlanSettings,
} from '@/lib/planning-queries';
import { cn } from '@/lib/utils';

import type { GroupFileRow } from './group-file';
import { GroupBadge } from './group-file-legend';
import { DEFAULT_MAP_DISPLAY, MapDisplaySwitches, type MapDisplay } from './group-file-view';
import type { MapFrame } from './group-file-map';
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

type TimelineEntry =
  | (PlanDayStop & { kind: 'visit' })
  | (Omit<PlanDayAnchor, 'kind'> & { kind: 'booked'; booking: PlanDayAnchor['kind'] });

/** A day's visits and the move-outs and move-ins it is built around, in driving order. */
function dayTimeline(day: PlanDay): TimelineEntry[] {
  return [
    ...day.stops.map((stop) => ({ ...stop, kind: 'visit' as const })),
    ...(day.anchors ?? []).map((anchor) => ({ ...anchor, kind: 'booked' as const, booking: anchor.kind })),
  ].sort((left, right) => (left.positionInDay ?? Number.MAX_SAFE_INTEGER) - (right.positionInDay ?? Number.MAX_SAFE_INTEGER));
}

const BOOKING_LABEL: Record<PlanDayAnchor['kind'], string> = { MOVE_OUT: 'Move-out', MOVE_IN: 'Move-in' };

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

/** The Monday a day's week starts on, `YYYY-MM-DD`. */
function mondayOf(date: string) {
  const day = new Date(date);
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday a day's week starts on, as its group heading. */
function weekOf(date: string) {
  const monday = new Date(`${mondayOf(date)}T00:00:00Z`);
  return `Week of ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(monday)}`;
}

/** A day as the office names it: "Thu, Dec 17 · Moses Rodriguez". */
const dayName = (day: PlanDay) => `${DAY.format(new Date(day.date))} · ${day.technician.displayName}`;

/** Whether a day is behind us: its order is history, and nothing joins it. */
const hasPassed = (day: PlanDay) => day.date.slice(0, 10) < businessToday();

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

/** The zones a day's visits are in, as "Zone 2" or "Zones 1, 2". */
function zonesOf(day: PlanDay) {
  const zones = [...new Set(day.stops.map((stop) => zoneNumberOf(stop.zone)).filter((zone): zone is string => Boolean(zone)))];
  zones.sort((left, right) => Number(left) - Number(right));
  return zones.length ? `${zones.length === 1 ? 'Zone' : 'Zones'} ${zones.join(', ')}` : null;
}

/**
 * A day's figures in the list, as the Group maker writes a group's: "9 visits
 * · 43 min drive · 26.7 km", and under it the day that makes. The drive is
 * between its properties; the drive from home is said apart (the office,
 * 2026-10-02), and is not in the day.
 */
function DayFigures({ day, settings }: { day: PlanDay; settings: PlanSettings }) {
  const drive = driveMinutes(day);
  const homeMinutes = day.homeDriveSeconds === null ? null : Math.round(day.homeDriveSeconds / 60);
  const onSite = limitState(day.onSiteMinutes, settings.maxOnSiteMinutes);
  const longest = longestLegSeconds(day);
  return (
    <>
      <span className="text-muted-foreground block text-xs">
        {day.stopCount} {day.stopCount === 1 ? 'visit' : 'visits'}
        {day.hvacStopCount ? ` · ${day.hvacStopCount} HVAC` : ''}
        {day.anchors?.length ? ` · ${bookedInWords(day.anchors, 'bare')}` : ''}
        {zonesOf(day) ? ` · ${zonesOf(day)}` : ''}
      </span>
      <span className="text-muted-foreground block text-xs">
        {drive === null ? 'Drive not measured' : `${drive} min drive`}
        {day.totalDriveMeters ? (
          <>
            {' · '}
            <span className="text-road-distance font-medium">{formatDistance(day.totalDriveMeters)}</span>
          </>
        ) : null}
      </span>
      <span className="text-muted-foreground block text-xs">
        <span className={toneOf(onSite)}>
          Est. day: {formatDrive(day.onSiteMinutes * 60 + (day.totalDriveSeconds ?? 0))}
        </span>
        {day.originKind === 'HOME' && homeMinutes !== null ? ` · ${homeMinutes} min from home` : ''}
      </span>
      {legOverLimit(longest, settings.maxLegMinutes) ? (
        <span className="text-destructive block text-xs">a {Math.round(longest! / 60)} min drive between properties</span>
      ) : null}
    </>
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
 * The quarter's days, as the Group maker shows a template's groups (the office,
 * 2026-10-02): the map beside the list of days, the day picked drawn from the
 * technician's home with every leg's drive on it, a property clicked on the map
 * joining the day picked, and each day's route put in the order that drives
 * least from home with one click. The day's visits and times are listed under.
 */
export function PlanDays({
  planId,
  days,
  visits,
  settings,
  selectedDayId,
  onSelect,
  onOpenStop,
  rotation,
  canChange = false,
  canMoveVisits = false,
  jobberEditsPushed = null,
}: {
  planId: string;
  days: PlanDay[];
  /** Every visit of the quarter, with no day or with one: what the map can move into a day. */
  visits: readonly DayStop[];
  settings: PlanSettings;
  selectedDayId: string;
  onSelect: (dayId: string) => void;
  /** A stop's pin or row was clicked: open its details. */
  onOpenStop?: (stopId: string) => void;
  /** Who has which zone each week, shown under each week's heading. */
  rotation?: PlanRotation | null;
  /** May change the plan: put a day in order, place a visit not booked yet. */
  canChange?: boolean;
  /** May reschedule a booked visit: the planner's grant and the inspections one. */
  canMoveVisits?: boolean;
  /** Whether the console's edits reach Jobber; null when not known (a quarter not published). */
  jobberEditsPushed?: boolean | null;
}) {
  const selected = days.find((day) => day.id === selectedDayId) ?? days[0] ?? null;
  const mutations = usePlanningMutations();
  const [display, setDisplay] = useState<MapDisplay>(DEFAULT_MAP_DISPLAY);
  const [fadeOthers, setFadeOthers] = useState(true);
  const [moving, setMoving] = useState<MovingVisit | null>(null);
  /** The map and the list fill the window on a large screen, as in the Group maker. */
  const fill = useFillHeight<HTMLDivElement>();

  const made = useMemo(() => planDaysFile(days, visits), [days, visits]);
  const weeks = useMemo(() => {
    const grouped = new Map<string, PlanDay[]>();
    for (const day of days) grouped.set(mondayOf(day.date), [...(grouped.get(mondayOf(day.date)) ?? []), day]);
    return [...grouped.entries()];
  }, [days]);
  // First names, as the office says them: "Zone 1 Moses".
  const firstNames = new Map(
    (rotation?.crew ?? []).map((member) => [member.technicianId, member.displayName?.split(' ')[0] ?? 'Someone']),
  );
  const zonesInWeek = new Map((rotation?.weeks ?? []).map((week) => [week.weekOf, week.zones]));
  // Every zone on the circle, in order: with more zones than crew, one waits its turn each week.
  const ownersOf = (monday: string) => {
    const week = zonesInWeek.get(monday);
    if (!week) return [];
    const owners = new Map(week.map((entry) => [entry.zone, entry.technicianId]));
    return (rotation?.zones ?? []).map((zone) => {
      const owner = owners.get(zone);
      return `Zone ${zone} ${owner ? (firstNames.get(owner) ?? 'Someone') : 'no one'}`;
    });
  };

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
  /**
   * Framed when another day is picked, or its home arrives -- never because a
   * click moved a visit into it: the map frames again only when the key changes.
   */
  const frame = useMemo<MapFrame>(
    () => ({
      key: `${selected?.id ?? ''}:${origin ? 'home' : ''}`,
      points: [...(group?.rows ?? []), ...(origin ? [origin] : [])],
    }),
    [group, origin, selected?.id],
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-muted-foreground min-w-0 text-sm">
          {days.length.toLocaleString()} {days.length === 1 ? 'day' : 'days'} ·{' '}
          {made.file.placed.toLocaleString()} {made.file.placed === 1 ? 'stop' : 'stops'}
          {made.file.ungrouped.length ? ` · ${made.file.ungrouped.length.toLocaleString()} with no day yet` : ''}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm" title="Every day but the one picked, faded">
            <Switch aria-label="Fade the other days" checked={fadeOthers} onCheckedChange={setFadeOthers} />
            Fade the other days
          </label>
          <MapDisplaySwitches display={display} onChange={setDisplay} />
          {canChange ? (
            <Button
              disabled={mutations.optimizeDays.isPending}
              onClick={optimizeEveryDay}
              size="sm"
              title="Every day from today on, in the order that drives least from the technician’s home"
              variant="outline"
            >
              {mutations.optimizeDays.isPending ? <Spinner /> : <RouteIcon />}
              {mutations.optimizeDays.isPending ? 'Optimizing every day…' : 'Optimize every day'}
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className="grid gap-3 lg:h-[36rem] lg:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_26rem]"
        ref={fill.ref}
        style={fill.height ? { height: fill.height } : undefined}
      >
        <div className="h-80 lg:h-full">
          <PlanDaysMap
            activeKey={selected?.id ?? null}
            display={display}
            fadeOthers={fadeOthers}
            frame={frame}
            groups={made.file.groups}
            onPickDay={onSelect}
            onRowClick={onRowClick}
            origin={origin}
            route={routeView}
            ungrouped={made.file.ungrouped}
            zones={zones}
          />
        </div>

        <nav aria-label="Planned technician-days" className="bg-card min-h-0 overflow-y-auto rounded-xl border">
          {weeks.map(([monday, weekDays]) => (
            <section className="grid" key={monday}>
              <h3 className="bg-card text-muted-foreground sticky top-0 z-10 border-b px-3 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">
                {weekOf(monday)}
                {ownersOf(monday).length ? (
                  <span className="block font-normal tracking-normal normal-case">{ownersOf(monday).join(' · ')}</span>
                ) : null}
              </h3>
              <ul className="divide-y">
                {weekDays.map((day) => {
                  const active = selected?.id === day.id;
                  const badge = made.groupOf.get(day.id);
                  return (
                    <li
                      className={cn('flex items-center gap-2 px-3 py-2', active ? 'bg-muted' : 'hover:bg-muted/50')}
                      key={day.id}
                    >
                      <button
                        aria-current={active || undefined}
                        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                        onClick={() => onSelect(day.id)}
                        type="button"
                      >
                        {badge ? <GroupBadge className="mt-0.5 shrink-0" group={badge} /> : null}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className={cn('truncate text-sm', active && 'font-semibold')}>{DAY.format(new Date(day.date))}</span>
                            <span className="text-muted-foreground truncate text-xs">{day.technician.displayName}</span>
                          </span>
                          {day.templateGroup ? <TemplateGroupTag className="text-xs" group={day.templateGroup} /> : null}
                          <DayFigures day={day} settings={settings} />
                        </span>
                      </button>
                      {canChange ? (
                        <Button
                          aria-label={`Optimize the route of ${dayName(day)}`}
                          disabled={hasPassed(day) || Boolean(optimizingDay) || mutations.optimizeDays.isPending}
                          onClick={() => optimizeDay(day)}
                          size="icon-sm"
                          title={
                            hasPassed(day)
                              ? 'This day has passed'
                              : 'Optimize route: the order that drives least from the technician’s home'
                          }
                          variant="ghost"
                        >
                          {optimizingDay === day.id ? <Spinner /> : <RouteIcon />}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      </div>
      {selected ? (
        <p className="text-muted-foreground -mt-1 text-xs">
          {canChange
            ? `Click a property on the map to move its visit into ${dayName(selected)}; click one of this day’s own, or a row in its list, to see its details.`
            : 'Click a property of this day on the map, or in the list, to see its details.'}
        </p>
      ) : null}
      {route.isSuccess && !route.data.geometry.length && (group?.rows.length ?? 0) > 1 ? (
        <p className="text-muted-foreground -mt-1 text-xs">The road could not be drawn, so the stops are joined with dashed straight lines.</p>
      ) : null}

      {selected ? <DayDetail day={selected} onOpenStop={onOpenStop} settings={settings} /> : null}

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

/** How the day's drives were measured, and what the driving shown covers. */
function measuredText(day: PlanDay) {
  const fromHome = day.originKind === 'HOME';
  // Said without the rule the order was chosen by: a build keeps to twenty
  // minutes between properties, and Optimize route only drives least.
  const counted = fromHome
    ? 'The day is routed from the technician’s home; the driving shown is between its properties, and the drive from home is shown apart.'
    : 'This day was built without the technician’s home, so it starts at its first job. Optimize its route, or rebuild the plan, to route it from home; the home comes from the technician’s planning profile.';
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
}: {
  day: PlanDay;
  settings: PlanSettings;
  onOpenStop?: (stopId: string) => void;
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
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-base font-semibold tracking-tight">{LONG_DAY.format(new Date(day.date))}</h2>
          <span className="text-sm font-medium">{day.technician.displayName}</span>
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
