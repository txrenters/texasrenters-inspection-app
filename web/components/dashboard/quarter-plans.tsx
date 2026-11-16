'use client';

import type { AdminDashboardOutlook, OutlookQuarter, OutlookRunningTotal } from '@texasrenters/shared';
import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type PointerEvent } from 'react';

import {
  PACE_WEEKS,
  addDays,
  aheadOfPlanLabel,
  daysBetween,
  percentDone,
  quarterPace,
  totalAt,
} from '@/lib/dashboard-outlook';
import { formatCount, formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';

import { DashCard, LegendItem, Meter } from './dash-card';

const PHASE_TAG: Record<OutlookQuarter['phase'], string> = {
  PAST: 'Closed',
  CURRENT: 'This quarter',
  NEXT: 'Next quarter',
};
const STATUS_TAG: Partial<Record<OutlookQuarter['planStatus'], string>> = {
  DRAFT: 'Draft plan',
  PUBLISHING: 'Publishing',
  PUBLISH_FAILED: 'Publish failed',
};

function Tag({ children, live }: { children: string; live?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-[11.5px] font-medium',
        live ? 'bg-warning/10 text-foreground' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

/** What a quarter's bar shows, in words: the same four numbers, none left to colour alone. */
function quarterWords(quarter: OutlookQuarter): string {
  if (quarter.phase === 'PAST') {
    const left = quarter.total - quarter.done;
    return left ? `${formatCount(left)} not done` : 'Every visit done';
  }
  return [
    quarter.done ? `${formatCount(quarter.done)} done` : null,
    quarter.booked ? `${formatCount(quarter.booked)} booked` : null,
    quarter.planned ? `${formatCount(quarter.planned)} planned, not booked` : null,
    quarter.notScheduled ? `${formatCount(quarter.notScheduled)} not scheduled` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function QuarterRow({ quarter }: { quarter: OutlookQuarter }) {
  const statusTag = STATUS_TAG[quarter.planStatus];
  return (
    <li className="border-t py-3.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{quarter.label}</span>
        <Tag live={quarter.phase === 'CURRENT'}>{PHASE_TAG[quarter.phase]}</Tag>
        {statusTag ? <Tag>{statusTag}</Tag> : null}
        <span className="ml-auto tabular-nums">
          <span className="font-semibold">{percentDone(quarter)}%</span>
          <span className="text-muted-foreground text-xs">
            {' '}
            · {formatCount(quarter.done)} of {formatCount(quarter.total)}
          </span>
        </span>
      </div>
      <Meter
        className="my-2.5 h-2.5"
        label={`${quarter.label}: ${quarterWords(quarter)}, of ${formatCount(quarter.total)}`}
        parts={[
          { value: quarter.done, className: 'bg-plan-done' },
          { value: quarter.booked, className: 'bg-plan-booked' },
          { value: quarter.planned, className: 'bg-plan-planned' },
          { value: quarter.total - quarter.done - quarter.booked - quarter.planned, className: 'bg-transparent' },
        ]}
      />
      <p className="text-muted-foreground text-xs tabular-nums">{quarterWords(quarter)}</p>
    </li>
  );
}

/**
 * Each quarter's benefit-package plan: how much is done, booked, planned and
 * not on any day, with this quarter's pace drawn against its plan.
 */
export function QuarterPlans({ outlook }: { outlook: AdminDashboardOutlook }) {
  const current = outlook.quarters.find((quarter) => quarter.phase === 'CURRENT');
  return (
    <DashCard
      actions={
        <>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
            <LegendItem swatch="bg-plan-done">Done</LegendItem>
            <LegendItem swatch="bg-plan-booked">Booked</LegendItem>
            <LegendItem swatch="bg-plan-planned">Planned, not booked</LegendItem>
            <LegendItem swatch="bg-muted">Not scheduled</LegendItem>
          </div>
          <Link className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap hover:underline" href="/planning">
            Open planning
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
        </>
      }
      subtitle="Occupied inspections in the quarterly package"
      title="TBP by quarter"
      titleId="dashboard-quarter-plans"
    >
      {outlook.quarters.length ? (
        <div className="flex flex-wrap gap-x-10 gap-y-6">
          <ul className="min-w-0 flex-[1_1_340px]">
            {outlook.quarters.map((quarter) => (
              <QuarterRow key={quarter.planId} quarter={quarter} />
            ))}
          </ul>
          <div className="min-w-0 flex-[2_1_420px]">
            {current && current.total ? (
              <QuarterPaceChart quarter={current} today={outlook.today} />
            ) : (
              <p className="text-muted-foreground text-sm">This quarter has no plan to measure a pace against.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No quarter has a plan yet. Build one in Planning and it is drawn here.
        </p>
      )}
    </DashCard>
  );
}

const WIDTH = 540;
const HEIGHT = 226;
const LEFT = 40;
const RIGHT = 520;
const BASE = 190;
const TOP = 24;

/** A round step for the count axis: at most four lines between zero and the total. */
function tickStep(total: number): number {
  return [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((step) => total / step <= 4) ?? 5000;
}

/**
 * Done so far against the plan, and where the last weeks' pace lands.
 *
 * One axis: visits, counted from zero. The plan and the work share it, so the
 * gap between the two lines is the number of visits ahead or behind.
 */
export function QuarterPaceChart({ quarter, today }: { quarter: OutlookQuarter; today: string }) {
  const [read, setRead] = useState<string | null>(null);
  const pace = quarterPace(quarter, today);
  const span = Math.max(1, daysBetween(quarter.startsOn, quarter.endsOn));
  const x = (day: string) =>
    LEFT + ((RIGHT - LEFT) * Math.min(span, Math.max(0, daysBetween(quarter.startsOn, day)))) / span;
  const y = (count: number) => BASE - ((BASE - TOP) * Math.min(count, quarter.total)) / quarter.total;
  const line = (points: OutlookRunningTotal[], until: string, end?: number) =>
    [
      `${LEFT},${BASE}`,
      ...points.filter((point) => point.date <= until).map((point) => `${x(point.date)},${y(point.count)}`),
      ...(end === undefined ? [] : [`${x(until)},${y(end)}`]),
    ].join(' ');

  const inQuarter = today >= quarter.startsOn && today <= quarter.endsOn;
  const now = inQuarter ? today : quarter.endsOn;
  const done = totalAt(quarter.progress, now);
  const progress = line(quarter.progress, now, done);

  // The dashed line runs from today to the day the pace finishes the quarter;
  // past the quarter's end it stops at the edge, at the count reached by then.
  let projection: { x: number; y: number } | null = null;
  if (inQuarter && pace.finishOn) {
    const whole = daysBetween(today, pace.finishOn);
    const shown = Math.min(whole, daysBetween(today, quarter.endsOn));
    projection = {
      x: x(addDays(today, shown)),
      y: y(done + ((quarter.total - done) * shown) / Math.max(1, whole)),
    };
  }

  const headline = !inQuarter
    ? `${formatCount(quarter.done)} of ${formatCount(quarter.total)} done`
    : pace.remaining === 0
      ? 'Every visit is done'
      : !pace.finishOn
        ? `Nothing done in the last ${PACE_WEEKS} weeks, so no finish day`
        : pace.late
          ? `at this pace it finishes ${formatDay(pace.finishOn, 'long')}, after the quarter ends`
          : `on course to finish ${formatDay(pace.finishOn, 'long')}`;

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = ((event.clientX - box.left) / box.width) * WIDTH;
    const share = Math.min(1, Math.max(0, (at - LEFT) / (RIGHT - LEFT)));
    setRead(addDays(quarter.startsOn, Math.round(share * span)));
  };
  const step = tickStep(quarter.total);
  const ticks = Array.from({ length: Math.floor(quarter.total / step) }, (_, index) => (index + 1) * step);
  const finishLabelFits =
    projection && !pace.late && projection.x - x(today) > 70 && RIGHT - projection.x > 70 && pace.finishOn;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p aria-live="polite" className="text-[13.5px]">
          {read ? (
            <>
              <span className="font-semibold">{formatDay(read)}</span>
              <span className="text-muted-foreground">
                {' '}
                · {read <= today ? `${formatCount(totalAt(quarter.progress, read))} done, ` : ''}
                {formatCount(totalAt(quarter.plan, read))} in the plan by then
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold">{quarter.label} pace</span>
              <span className="text-muted-foreground"> · {headline}</span>
            </>
          )}
        </p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="bg-plan-done h-0.5 w-4.5 rounded-full" />
            Done
          </span>
          {projection ? (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="border-plan-done w-4.5 border-t-2 border-dashed" />
              Projected
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="bg-muted-foreground/70 h-px w-4.5" />
            Plan
          </span>
        </div>
      </div>
      <svg
        aria-label={`${quarter.label}: ${formatCount(quarter.done)} of ${formatCount(quarter.total)} done, ${aheadOfPlanLabel(pace.aheadOfPlan).toLowerCase()}; ${headline}.`}
        className="mt-2.5 block h-auto w-full touch-none"
        onPointerLeave={() => setRead(null)}
        onPointerMove={onMove}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="stroke-border/60" x1={LEFT} x2={RIGHT} y1={y(tick)} y2={y(tick)} />
            <text className="fill-muted-foreground font-mono text-[11px]" textAnchor="end" x={LEFT - 8} y={y(tick) + 4}>
              {formatCount(tick)}
            </text>
          </g>
        ))}
        <line className="stroke-border" x1={LEFT} x2={RIGHT} y1={BASE} y2={BASE} />
        <text className="fill-muted-foreground font-mono text-[11px]" x={LEFT} y={BASE + 20}>
          {formatDay(quarter.startsOn).split(', ')[1]}
        </text>
        <text className="fill-muted-foreground font-mono text-[11px]" textAnchor="end" x={RIGHT} y={BASE + 20}>
          {formatDay(quarter.endsOn).split(', ')[1]}
        </text>
        {inQuarter && x(today) - LEFT > 70 && RIGHT - x(today) > 70 ? (
          <text className="fill-foreground font-mono text-[11px]" textAnchor="middle" x={x(today)} y={BASE + 20}>
            Today
          </text>
        ) : null}
        {finishLabelFits && projection ? (
          <text className="fill-muted-foreground font-mono text-[11px]" textAnchor="middle" x={projection.x} y={BASE + 20}>
            {formatDay(pace.finishOn).split(', ')[1]}
          </text>
        ) : null}

        <polyline className="stroke-muted-foreground/70 fill-none" points={line(quarter.plan, quarter.endsOn)} strokeWidth={1.5} />
        {inQuarter ? <line className="stroke-border" x1={x(today)} x2={x(today)} y1={TOP - 6} y2={BASE} /> : null}
        <polygon className="fill-plan-done/10" points={`${progress} ${x(now)},${BASE}`} />
        <polyline
          className="stroke-plan-done fill-none"
          points={progress}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
        {projection ? (
          <>
            <line
              className="stroke-plan-done"
              strokeDasharray="5 5"
              strokeLinecap="round"
              strokeWidth={2}
              x1={x(today)}
              x2={projection.x}
              y1={y(done)}
              y2={projection.y}
            />
            <circle className="fill-card stroke-plan-done" cx={projection.x} cy={projection.y} r={5} strokeWidth={2} />
          </>
        ) : null}
        <circle className="fill-plan-done stroke-card" cx={x(now)} cy={y(done)} r={5} strokeWidth={2} />
        {read ? <line className="stroke-foreground/40" x1={x(read)} x2={x(read)} y1={TOP - 6} y2={BASE} /> : null}
      </svg>
      <p className="text-muted-foreground mt-1 text-xs">
        {inQuarter && pace.finishOn
          ? `Projection: the last ${PACE_WEEKS} weeks' pace, ${formatCount(pace.perWeek)} a week, carried forward over working days. `
          : ''}
        {aheadOfPlanLabel(pace.aheadOfPlan)}: {formatCount(quarter.done)} done against {formatCount(quarter.dueByToday)} the
        plan had on days before today.
      </p>
    </div>
  );
}
