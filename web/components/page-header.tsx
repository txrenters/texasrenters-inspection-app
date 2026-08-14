import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The heading block at the top of a page.
 *
 * Deliberately smaller than the old app's, which stacked a "TEXASRENTERS
 * OPERATIONS" eyebrow, a 24px title and a description above every screen — while
 * the header directly above it already carried a breadcrumb naming the same
 * page. That is three restatements of "you are on Inspections" and roughly 120px
 * of chrome before any data.
 *
 * The eyebrow is gone. The breadcrumb keeps the location; this keeps the title
 * and the actions.
 */
export function PageHeader({
  title,
  description,
  badges,
  actions,
  className,
}: {
  title: string;
  description?: string;
  /**
   * Status alongside the title, not below it in the first card on the page.
   *
   * "What state is this record in" is part of identifying the record, and a
   * reviewer scanning back to the top wants it in the same glance as the name.
   * Separate from `actions` on purpose: that slot is buttons, and a badge that
   * sits in a row of buttons reads as one you can press.
   */
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-wrap items-start justify-between gap-3 pb-3 sm:gap-4', className)}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          {badges ? <div className="flex flex-wrap items-center gap-1.5">{badges}</div> : null}
        </div>
        {description ? (
          <p className="text-muted-foreground max-w-2xl text-sm text-pretty">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A heading inside a page — for the sections a detail screen is built from. */
export function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
