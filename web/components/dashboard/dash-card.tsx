import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A card on the dashboard: a title in words, a line saying what it shows, and
 * its controls at the right.
 *
 * Not `Panel`. A panel's title is a small uppercase label, which is right above
 * a list and wrong above a chart: the chart's title is the first thing read,
 * and it has to say what the marks are.
 */
export function DashCard({
  title,
  titleId,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  /** The heading's id, so the section is named by its own title. */
  titleId: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section aria-labelledby={titleId} className={cn('bg-card min-w-0 rounded-xl border', className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
        <div className="mr-auto min-w-0">
          <h2 className="text-[15px] leading-snug font-semibold" id={titleId}>
            {title}
          </h2>
          {subtitle ? <p className="text-muted-foreground text-[13px]">{subtitle}</p> : null}
        </div>
        {actions}
      </header>
      <div className={cn('px-5 pt-4 pb-5', bodyClassName)}>{children}</div>
    </section>
  );
}

/** A swatch and its name, for a chart's legend. The words stay in ink; the mark carries the colour. */
export function LegendItem({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', swatch)} />
      {children}
    </span>
  );
}

/** Planned and not yet booked: drawn hatched wherever it appears, so it never reads as work on the calendar. */
export const HATCH =
  'bg-[repeating-linear-gradient(45deg,var(--muted-foreground)_0_2px,transparent_2px_5px)] opacity-70';

/** One headline figure: what it counts, the number, and a line or two of context. */
export function Kpi({
  label,
  tone,
  value,
  unit,
  children,
}: {
  label: string;
  tone?: 'warning';
  value: ReactNode;
  unit?: string;
  children?: ReactNode;
}) {
  return (
    <div className="bg-card flex min-w-0 flex-col gap-1.5 rounded-xl border px-5 py-4">
      <p className="text-muted-foreground flex items-center gap-2 text-[13px] font-medium">
        {tone === 'warning' ? <span aria-hidden className="bg-warning size-2 shrink-0 rounded-full" /> : null}
        {label}
      </p>
      <p className="text-[2rem] leading-tight font-semibold tracking-tight">
        {value}
        {unit ? <span className="text-muted-foreground ml-1.5 text-sm font-normal tracking-normal">{unit}</span> : null}
      </p>
      {children}
    </div>
  );
}

/** A thin bar of parts of one whole; what is left of the track is the remainder. */
export function Meter({
  label,
  parts,
  className,
}: {
  /** Read out in place of the bar: it must say everything the bar shows. */
  label: string;
  parts: Array<{ value: number; className: string }>;
  className?: string;
}) {
  return (
    <div aria-label={label} className={cn('bg-muted flex h-1.5 gap-0.5 overflow-hidden rounded-full', className)} role="img">
      {parts
        .filter((part) => part.value > 0)
        .map((part, index) => (
          <span className={cn('h-full min-w-[3px]', part.className)} key={index} style={{ flex: `${part.value} 1 0` }} />
        ))}
    </div>
  );
}
