'use client';

import { OUTLOOK_VISIT_TYPES, type AdminDashboardOutlook, type OutlookDay, type OutlookVisitType } from '@texasrenters/shared';
import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { SegmentedControl } from '@/components/ui/segmented';
import { VISIT_TYPE_LABELS, daySummary, outlookWeeks, scaleTop } from '@/lib/dashboard-outlook';
import { formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';

import { DashCard, HATCH, LegendItem } from './dash-card';

/** Each kind of visit keeps its colour whatever else is on the chart. OTHER is neutral on purpose. */
const TYPE_FILL: Record<OutlookVisitType, string> = {
  OCCUPIED: 'bg-series-1',
  MOVE_OUT: 'bg-series-2',
  MOVE_IN: 'bg-series-3',
  HVAC: 'bg-series-4',
  OTHER: 'bg-muted-foreground/60',
};

const PLOT_HEIGHT = 208;
const RANGES = [
  { value: '2', label: '2 weeks' },
  { value: '6', label: '6 weeks' },
] as const;

/**
 * Visits per day for the weeks ahead, stacked by kind.
 *
 * Solid is on the calendar. Hatched is in a quarter plan and not booked yet,
 * which is the part of the future the calendar alone cannot show. Each column
 * opens its day on the Schedule.
 */
export function ScheduleAhead({ outlook }: { outlook: AdminDashboardOutlook }) {
  const [range, setRange] = useState<'2' | '6'>('6');
  const [hovered, setHovered] = useState<string | null>(null);
  const weeks = outlookWeeks(outlook.days, Number(range));
  const shown = weeks.flat();
  const top = scaleTop(shown);
  const types = OUTLOOK_VISIT_TYPES.filter((type) => type !== 'OTHER' || shown.some((day) => day.booked.OTHER));
  const anyPlanned = shown.some((day) => day.planned);
  const read = shown.find((day) => day.date === hovered) ?? shown.find((day) => day.date === outlook.today) ?? shown[0];
  // Three lines under the top of the scale: a fourth would sit on the plot's
  // upper edge, with its label out among the legend.
  const ticks = [1, 2, 3].map((step) => (top / 4) * step).filter(Number.isInteger);

  return (
    <DashCard
      actions={
        <>
          <SegmentedControl aria-label="How far ahead" onChange={setRange} options={RANGES} value={range} />
          <Link className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap hover:underline" href="/schedule">
            Open schedule
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
        </>
      }
      subtitle="Visits per day, by type"
      title="Schedule ahead"
      titleId="dashboard-schedule-ahead"
    >
      <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
        {read ? (
          <p aria-live="polite" className="text-[13.5px]">
            <span className="font-semibold">
              {formatDay(read.date)}
              {read.date === outlook.today ? ' (today)' : ''}
            </span>
            <span className="text-muted-foreground"> · {daySummary(read)}</span>
          </p>
        ) : null}
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
          {types.map((type) => (
            <LegendItem key={type} swatch={TYPE_FILL[type]}>
              {VISIT_TYPE_LABELS[type]}
            </LegendItem>
          ))}
          {anyPlanned ? <LegendItem swatch={HATCH}>Planned, not booked</LegendItem> : null}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[520px] pl-7">
          <div className="relative flex gap-3.5 border-b" style={{ height: PLOT_HEIGHT }}>
            {ticks.map((tick) => (
              <div
                aria-hidden
                className="bg-border/60 absolute inset-x-0 h-px"
                key={tick}
                style={{ bottom: (tick / top) * PLOT_HEIGHT }}
              >
                <span className="text-muted-foreground absolute -top-2 -left-7 w-5.5 text-right font-mono text-[11px]">
                  {tick}
                </span>
              </div>
            ))}
            {weeks.map((week) => (
              <div className="relative flex flex-1 items-end gap-1" key={week[0]?.date}>
                {week.map((day) => (
                  <DayColumn
                    day={day}
                    key={day.date}
                    onRead={setHovered}
                    past={day.date < outlook.today}
                    today={day.date === outlook.today}
                    top={top}
                  />
                ))}
              </div>
            ))}
          </div>
          <div aria-hidden className="text-muted-foreground flex gap-3.5 pt-1.5 font-mono text-[11px]">
            {weeks.map((week) => (
              <div className="flex-1" key={week[0]?.date}>
                <div className="flex gap-1">
                  {week.map((day) => (
                    <span
                      className={cn('flex-1 text-center', day.date === outlook.today && 'text-foreground font-medium')}
                      key={day.date}
                    >
                      {formatDay(day.date).charAt(0)}
                    </span>
                  ))}
                </div>
                <div className="text-foreground mt-0.5">{week[0] ? formatDay(week[0].date).split(', ')[1] : null}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-muted-foreground mt-3 text-xs">
        Solid is on the calendar.
        {anyPlanned ? ' Hatched is in a quarter plan and not booked yet.' : ''} Days already worked are dimmed.
      </p>
    </DashCard>
  );
}

function DayColumn({
  day,
  top,
  today,
  past,
  onRead,
}: {
  day: OutlookDay;
  top: number;
  today: boolean;
  past: boolean;
  onRead: (date: string | null) => void;
}) {
  // Bottom to top. A segment is its count on the scale, less the 2px gap that
  // separates it from the one below; the gap, not a border, is what tells
  // neighbours apart.
  const segments = [
    ...OUTLOOK_VISIT_TYPES.filter((type) => day.booked[type]).map((type) => ({
      key: type as string,
      count: day.booked[type],
      fill: TYPE_FILL[type],
    })),
    ...(day.planned ? [{ key: 'PLANNED', count: day.planned, fill: HATCH }] : []),
  ];
  return (
    <Link
      aria-label={`${formatDay(day.date, 'long')}${today ? ' (today)' : ''}: ${daySummary(day)}`}
      className={cn(
        'hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring/50 flex h-full flex-1 flex-col-reverse items-center gap-0.5 rounded-t-[4px] outline-none focus-visible:ring-[3px]',
        past && 'opacity-45',
      )}
      href={`/schedule?date=${day.date}`}
      onBlur={() => onRead(null)}
      onFocus={() => onRead(day.date)}
      onMouseEnter={() => onRead(day.date)}
      onMouseLeave={() => onRead(null)}
    >
      {segments.map((segment, index) => (
        <span
          className={cn('w-full max-w-6 shrink-0', segment.fill, index === segments.length - 1 && 'rounded-t-[4px]')}
          key={segment.key}
          style={{ height: Math.max(2, (segment.count / top) * PLOT_HEIGHT - 2) }}
        />
      ))}
    </Link>
  );
}
