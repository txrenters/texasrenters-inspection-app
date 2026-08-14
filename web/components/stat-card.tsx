import type { ComponentType, ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Numbers, in the two shapes this console actually needs.
 *
 * The old `MetricCard` carried a coloured left rail whose tone was passed in per
 * call site, so the same figure was blue on one screen and amber on another and
 * neither meant anything. That is fixed. What replaced it still had a second
 * problem: every number was a separate bordered, shadowed card, so a dashboard
 * with nine figures was nine floating boxes, and the four that need acting on
 * looked exactly like the five that change once a night.
 *
 * So there are two components, and choosing between them is the hierarchy:
 *
 *   `StatGroup` / `Stat`   one panel, hairline-divided. For figures somebody
 *                          acts on. Reads as a single instrument.
 *   `StatStrip`            a compact inline row, no boxes at all. For reference
 *                          counts that are context, not work.
 *
 * If every number on a screen is in a StatGroup, the screen has no hierarchy.
 */

/**
 * The hairlines are `gap-px` over a `bg-border` container, not `divide-x`.
 * Divide utilities only draw between direct siblings in one flow direction, so a
 * responsive grid that wraps from four columns to two loses the horizontal
 * rules exactly where it starts needing them. The gap technique draws every
 * seam, at any column count, with no per-breakpoint overrides.
 *
 * The corollary is that column count must equal item count on every breakpoint,
 * or a trailing empty cell shows through as a block of border colour. Callers
 * pass whole-row column counts: three items go 1/3, four go 2/4. A prime number
 * of figures is a sign they are not all one group.
 */
export function StatGroup({
  children,
  columns,
  className,
}: {
  children: ReactNode;
  /** Tailwind grid classes. Must divide the child count evenly at every size. */
  columns: string;
  className?: string;
}) {
  return (
    <div
      className={cn('bg-border grid gap-px overflow-hidden rounded-xl border', columns, className)}
    >
      {children}
    </div>
  );
}

/** One cell of a StatGroup. Carries no border of its own; the group draws them. */
export function Stat({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'default',
  action,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: ComponentType<{ className?: string }>;
  /**
   * Reserved for the two cases where a figure is genuinely actionable: a queue
   * that needs attention, a failure count. Expressed on the value itself, never
   * as a decorative stripe.
   */
  tone?: 'default' | 'warning' | 'destructive' | 'success';
  action?: ReactNode;
}) {
  return (
    <div className="bg-card flex flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground text-sm font-medium">{label}</p>
        {Icon ? <Icon className="text-muted-foreground size-4 shrink-0" /> : null}
      </div>
      <p
        className={cn(
          // `font-mono` for the same reason the numeric table columns use it:
          // these sit in a row and get compared across, so the digits need one
          // width and one left edge.
          'mt-2 font-mono text-2xl font-semibold tracking-tight tabular-nums',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </p>
      {detail ? <p className="text-muted-foreground mt-1 text-xs">{detail}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function StatGroupSkeleton({ columns, count }: { columns: string; count: number }) {
  return (
    <StatGroup columns={columns}>
      {Array.from({ length: count }, (_, index) => (
        <div className="bg-card p-4" key={index}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-7 w-16" />
          <Skeleton className="mt-2 h-3 w-32" />
        </div>
      ))}
    </StatGroup>
  );
}

/**
 * Reference counts, as one line.
 *
 * Deliberately not boxes. These are the figures somebody glances at to orient,
 * not the ones they came to the screen for, and giving them the same panel as
 * the operational queue is what made the old dashboard read as nine equal
 * things. Wraps to as many lines as it needs on a narrow window.
 */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        'bg-card flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border px-4 py-3',
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function StatStripItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="font-mono text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
