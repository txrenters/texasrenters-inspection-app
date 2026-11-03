'use client';

import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon } from 'lucide-react';
import Link from 'next/link';

import { formatCount } from '@/lib/format';
import type { Trend } from '@/lib/list-summary';
import { cn } from '@/lib/utils';

export interface SummaryItem {
  label: string;
  /** Undefined while it is being read; null when it could not be read. */
  value: number | null | undefined;
  /** The dot's colour, a whole class name: `bg-warning`. */
  dot: string;
  href?: string;
}

export interface SummaryMetric {
  title: string;
  /** "Past 30 days". */
  caption: string;
  /** Undefined while it is being read; null when it could not be read. */
  value: number | null | undefined;
  trend?: Trend | null;
  /** Whether a rise is good news (more visits done) or bad (more problems). */
  moreIsBetter?: boolean;
  /** Said after the trend, for a screen reader: "on the 30 days before". */
  comparedWith?: string;
  href?: string;
}

/**
 * Jobber's strip above a list: an "Overview" card of what the list holds,
 * each with its dot and count, then a card per figure worth watching, with how
 * it moved. It scrolls sideways when it does not fit, as Jobber's does, and is
 * drawn only in the Jobber-style shell -- the page decides that, so a classic
 * page never asks for its counts.
 */
export function ListSummary({
  label,
  metrics,
  overview,
}: {
  /** What the strip is about, for a screen reader: "Inspections at a glance". */
  label: string;
  metrics: readonly SummaryMetric[];
  overview: readonly SummaryItem[];
}) {
  return (
    <section aria-label={label} className="-mx-1 mb-6 overflow-x-auto px-1 pb-1">
      <div className="flex gap-3">
        <div className="bg-card flex min-w-60 flex-1 flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-heading text-base font-bold">Overview</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {overview.map((item) => {
              const body = (
                <>
                  <span aria-hidden className={cn('size-2 shrink-0 rounded-full', item.dot)} />
                  <span className="min-w-0 truncate">{item.label}</span>
                  <span className="text-muted-foreground font-mono tabular-nums">
                    ({shown(item.value)})
                  </span>
                </>
              );
              return (
                <li key={item.label}>
                  {item.href ? (
                    <Link className="flex items-center gap-2 hover:underline" href={item.href}>
                      {body}
                    </Link>
                  ) : (
                    <span className="flex items-center gap-2">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        {metrics.map((metric) => (
          <MetricCard key={metric.title} metric={metric} />
        ))}
      </div>
    </section>
  );
}

/** A figure, '…' while it is read, and a dash when it could not be, never a figure loading for ever. */
function shown(value: number | null | undefined) {
  return value === undefined ? '…' : value === null ? '—' : formatCount(value);
}

function MetricCard({ metric }: { metric: SummaryMetric }) {
  const trend = metric.trend;
  const good = trend ? (trend.direction === 'up') === (metric.moreIsBetter ?? true) : false;
  return (
    <div className="bg-card flex min-w-52 flex-1 flex-col rounded-lg border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-heading text-base font-bold">{metric.title}</h3>
          <p className="text-muted-foreground text-xs">{metric.caption}</p>
        </div>
        {metric.href ? (
          <Link aria-label={`Open ${metric.title.toLowerCase()}`} className="text-muted-foreground hover:text-foreground" href={metric.href}>
            <ArrowRightIcon aria-hidden className="size-4" />
          </Link>
        ) : null}
      </div>
      <div className="mt-auto flex items-end gap-2 pt-4">
        <span className="font-display text-heading text-3xl leading-none font-extrabold tabular-nums">
          {shown(metric.value)}
        </span>
        {trend && trend.direction !== 'flat' ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold',
              good ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
            )}
          >
            {trend.direction === 'up' ? <ArrowUpIcon aria-hidden className="size-3" /> : <ArrowDownIcon aria-hidden className="size-3" />}
            {trend.percent}%
            <span className="sr-only">
              {' '}
              {trend.direction === 'up' ? 'up' : 'down'} {metric.comparedWith ?? ''}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
