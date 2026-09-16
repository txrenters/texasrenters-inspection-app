'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDistance } from '@/lib/format';
import { dayClock, formatClock, formatMinutes, leaveHomeAt, limitState, type LimitState } from '@/lib/planning';
import { usePlanDayRoute, type PlanDay, type PlanSettings } from '@/lib/planning-queries';
import { cn } from '@/lib/utils';

const PlanDayMap = dynamic(() => import('@/components/planning/plan-day-map').then((module) => module.PlanDayMap), {
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

const LIMIT_BAR: Record<LimitState, string> = {
  within: 'bg-primary/70',
  near: 'bg-warning',
  over: 'bg-destructive',
};

/** Minutes driving between a day's properties, or null when nothing measured it. */
const driveMinutes = (day: PlanDay) => (day.totalDriveSeconds === null ? null : Math.round(day.totalDriveSeconds / 60));

/** The Monday a day's week starts on, as its group heading. */
function weekOf(date: string) {
  const day = new Date(date);
  const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000);
  return `Week of ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(monday)}`;
}

function Meter({ label, value, limit, text }: { label: string; value: number; limit: number; text: string }) {
  const state = limitState(value, limit);
  return (
    <div className="grid gap-1">
      <div className={cn('flex items-baseline justify-between gap-2 text-xs', LIMIT_TEXT[state])}>
        <span>{label}</span>
        <span className="font-mono tabular-nums">{text}</span>
      </div>
      <div aria-hidden className="bg-muted h-1 overflow-hidden rounded-full">
        <div className={cn('h-full rounded-full', LIMIT_BAR[state])} style={{ width: `${Math.min(100, (value / Math.max(1, limit)) * 100)}%` }} />
      </div>
    </div>
  );
}

export function PlanDays({
  planId,
  days,
  settings,
  selectedDayId,
  onSelect,
  onOpenStop,
}: {
  planId: string;
  days: PlanDay[];
  settings: PlanSettings;
  selectedDayId: string;
  onSelect: (dayId: string) => void;
  /** A stop's pin or row was clicked: open its details. */
  onOpenStop?: (stopId: string) => void;
}) {
  const selected = days.find((day) => day.id === selectedDayId) ?? days[0] ?? null;
  const weeks = useMemo(() => {
    const grouped = new Map<string, PlanDay[]>();
    for (const day of days) grouped.set(weekOf(day.date), [...(grouped.get(weekOf(day.date)) ?? []), day]);
    return [...grouped.entries()];
  }, [days]);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
      <nav
        aria-label="Planned technician-days"
        className="bg-card grid gap-4 rounded-xl border p-2 lg:sticky lg:top-[calc(var(--app-header-height)+1rem)] lg:max-h-[calc(100vh-var(--app-header-height)-2rem)] lg:overflow-y-auto"
      >
        {weeks.map(([week, weekDays]) => (
          <section className="grid gap-1" key={week}>
            <h3 className="text-muted-foreground px-2 pt-1 text-xs font-medium tracking-wide uppercase">{week}</h3>
            {weekDays.map((day) => {
              const drive = driveMinutes(day);
              const active = selected?.id === day.id;
              return (
                <button
                  aria-current={active || undefined}
                  className={cn(
                    'hover:bg-accent focus-visible:ring-ring/50 grid gap-2 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-[3px]',
                    active && 'bg-accent',
                  )}
                  key={day.id}
                  onClick={() => onSelect(day.id)}
                  type="button"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{DAY.format(new Date(day.date))}</span>
                    <span className="text-muted-foreground truncate text-xs">{day.technician.displayName}</span>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {day.stopCount} {day.stopCount === 1 ? 'visit' : 'visits'}
                    {day.hvacStopCount ? ` · ${day.hvacStopCount} HVAC` : ''}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Meter
                      label="Inspecting"
                      limit={settings.maxOnSiteMinutes}
                      text={formatMinutes(day.onSiteMinutes)}
                      value={day.onSiteMinutes}
                    />
                    <Meter
                      label="Driving"
                      limit={settings.maxDriveMinutes}
                      text={drive === null ? 'not measured' : `${drive} min`}
                      value={drive ?? 0}
                    />
                  </div>
                </button>
              );
            })}
          </section>
        ))}
      </nav>

      {selected ? <DayDetail day={selected} onOpenStop={onOpenStop} planId={planId} settings={settings} /> : null}
    </div>
  );
}

/** How the day's drives were measured, and what the ninety minutes count. */
function measuredText(day: PlanDay) {
  const fromHome = day.originKind === 'HOME';
  const counted = fromHome
    ? 'The day is routed from the technician’s home; only the drives between properties count toward the limit.'
    : 'This day was built without the technician’s home, so it starts at its first job. Rebuild the plan to route days from home; the home comes from the technician’s planning profile.';
  switch (day.durationSource) {
    case 'GOOGLE_TRAFFIC_AWARE':
      return `Drives measured by Google for a 9 AM start. ${counted}`;
    case 'OSRM_FREE_FLOW':
      return `Drives measured without traffic. ${counted}`;
    case 'HAVERSINE':
      return 'No drive times could be measured for this day; the distances are in a straight line.';
    default:
      return fromHome
        ? 'One property, so there is nothing to drive between; the drive from home is not counted.'
        : 'One property, so there is nothing to drive between.';
  }
}

function DayDetail({
  planId,
  day,
  settings,
  onOpenStop,
}: {
  planId: string;
  day: PlanDay;
  settings: PlanSettings;
  onOpenStop?: (stopId: string) => void;
}) {
  const route = usePlanDayRoute(planId, day.id);
  const clock = useMemo(() => dayClock(day.stops), [day.stops]);
  const drive = driveMinutes(day);
  const ends = clock.at(-1)?.leaves;
  const homeMinutes = day.homeDriveSeconds === null ? null : Math.round(day.homeDriveSeconds / 60);
  const onSite = limitState(day.onSiteMinutes, settings.maxOnSiteMinutes);
  const driving = drive === null ? 'within' : limitState(drive, settings.maxDriveMinutes);

  return (
    <section aria-label={`${LONG_DAY.format(new Date(day.date))}, ${day.technician.displayName}`} className="grid gap-3">
      <div className="bg-card grid gap-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-base font-semibold tracking-tight">{LONG_DAY.format(new Date(day.date))}</h2>
          <span className="text-sm font-medium">{day.technician.displayName}</span>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Inspecting</dt>
            <dd className={cn('font-mono tabular-nums', toneOf(onSite))}>
              {formatMinutes(day.onSiteMinutes)} of {formatMinutes(settings.maxOnSiteMinutes)}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Driving</dt>
            <dd className={cn('font-mono tabular-nums', toneOf(driving))}>
              {drive === null ? 'not measured' : `${drive} of ${settings.maxDriveMinutes} min`}
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

      <div className="h-80 lg:h-[26rem]">
        <PlanDayMap
          dayKey={day.id}
          geometry={route.data?.geometry ?? []}
          home={route.data?.home ?? null}
          homeGeometry={route.data?.homeGeometry ?? []}
          onSelectStop={onOpenStop}
          stops={day.stops}
        />
      </div>
      {onOpenStop ? (
        <p className="text-muted-foreground -mt-1 text-xs">Click a property on the map, or in the list, to see its details.</p>
      ) : null}
      {route.isSuccess && !route.data.geometry.length && day.stops.length > 1 ? (
        <p className="text-muted-foreground -mt-1 text-xs">The road could not be drawn, so the stops are joined with dashed straight lines.</p>
      ) : null}

      <ol className="bg-card divide-border divide-y rounded-xl border">
        {clock.map((stop, index) => (
          <li className="grid gap-1 px-4 py-2.5" key={stop.id}>
            {index > 0 ? (
              <span className="text-muted-foreground text-xs">
                {stop.driveSecondsForecast === null ? 'Drive not measured' : `${stop.driveMinutes} min drive`}
              </span>
            ) : homeMinutes !== null ? (
              <span className="text-muted-foreground text-xs">{homeMinutes} min from home, not counted</span>
            ) : null}
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
                  <span>{[stop.city, stop.zone && /^\d+$/.test(stop.zone) ? `Zone ${stop.zone}` : null].filter(Boolean).join(' · ')}</span>
                  <Badge variant={stop.inspectionType === 'HVAC' ? 'info' : 'secondary'}>
                    {stop.inspectionType === 'HVAC' ? 'HVAC inspection' : 'Occupied inspection'}
                  </Badge>
                  <span>{formatMinutes(stop.onSiteMinutes ?? 0)}</span>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
