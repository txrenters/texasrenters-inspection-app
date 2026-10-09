import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The one style for a section's NAME (console-development): small, uppercase,
 * tracked mono, muted. Panels, figure groups, card titles (`variant="label"`)
 * and any hand-made section heading use this, so a name never competes with
 * the values under it.
 */
export const SECTION_LABEL = 'text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase';

/**
 * One bordered surface per topic, rows split by hairlines inside it.
 *
 * The console used Card + CardHeader + CardTitle for this, which renders the
 * panel's name as a bold heading the same weight as the page's own sections,
 * so a dashboard of four panels read as four competing headlines. A panel's
 * name is a LABEL: small, uppercase, tracked, muted. It says what the box is
 * without asking to be read first. (console-development, 2026-10-09.)
 */
export function Panel({
  title,
  count,
  countTone = 'default',
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  /** A figure beside the name, e.g. how many rows need a person. */
  count?: ReactNode;
  countTone?: 'default' | 'warning';
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('bg-card overflow-hidden rounded-xl border', className)}>
      <header className="flex min-h-11 items-center gap-3 border-b px-4 py-2">
        <h2 className={SECTION_LABEL}>{title}</h2>
        {count !== undefined && count !== null ? (
          <span
            className={cn(
              'font-mono text-xs tabular-nums',
              countTone === 'warning' ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {count}
          </span>
        ) : null}
        {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/**
 * A row in a panel: a tone dot, a line, and a quieter line under it. The dot
 * is the only colour; the words stay in the ordinary text colours.
 */
export function PanelRow({
  tone = 'muted',
  title,
  detail,
  trailing,
  className,
}: {
  tone?: 'warning' | 'destructive' | 'success' | 'info' | 'muted';
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-2.5 sm:flex-nowrap', className)}>
      <span
        aria-hidden
        className={cn(
          'mt-[7px] size-1.5 shrink-0 rounded-full',
          tone === 'warning' && 'bg-warning',
          tone === 'destructive' && 'bg-destructive',
          tone === 'success' && 'bg-success',
          tone === 'info' && 'bg-info',
          tone === 'muted' && 'bg-muted-foreground/50',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm">{title}</div>
        {detail ? <div className="text-muted-foreground mt-0.5 text-xs break-words">{detail}</div> : null}
      </div>
      {/* Under the words on a phone, beside them from `sm`: three action
          buttons beside a sentence squeezed the sentence to nothing at 375px. */}
      {trailing ? <div className="basis-full pl-[18px] sm:basis-auto sm:shrink-0 sm:pl-0">{trailing}</div> : null}
    </div>
  );
}
