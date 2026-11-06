'use client';

import { InfoIcon, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { useConsoleShell } from '@/components/console-shell-context';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  titleHref,
  description,
  badges,
  actions,
  info,
  infoLabel = 'How this works',
  record,
  className,
}: {
  title: string;
  /** Where the title leads, when it names something with a page of its own. */
  titleHref?: string;
  /**
   * The rules behind the page, one click away rather than above the work
   * (console-development): a paragraph of booking rules over every visit to a
   * list is read once and scrolled past for ever after.
   */
  info?: ReactNode;
  infoLabel?: string;
  /** A sentence, or a line of figures with controls in it (the benefit package plan's summary). */
  description?: ReactNode;
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
  /**
   * The page is one record -- an inspection, a property -- and, in the
   * Jobber-style shell, is headed as Jobber heads one: the record's icon in its
   * colour and its status on a line above, the actions at the right of that
   * line, the name large beneath. Ignored in the classic console.
   */
  record?: { icon: LucideIcon; tone: string; label: string };
  className?: string;
}) {
  const jobber = useConsoleShell() === 'jobber';
  const heading = titleHref ? (
    <Link className="underline-offset-4 hover:underline" href={titleHref}>
      {title}
    </Link>
  ) : (
    title
  );

  if (record && jobber) {
    const Icon = record.icon;
    return (
      <header className={cn('flex flex-col gap-3 pb-6', className)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={cn('bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded-lg', record.tone)}
              title={record.label}
            >
              <Icon aria-hidden className="size-5" />
              <span className="sr-only">{record.label}</span>
            </span>
            {badges ? <div className="flex flex-wrap items-center gap-1.5">{badges}</div> : null}
          </div>
          {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="font-display text-heading text-[1.75rem] leading-tight font-extrabold sm:text-[2.25rem]">
              {heading}
            </h1>
            {info ? <InfoButton info={info} infoLabel={infoLabel} /> : null}
          </div>
          {typeof description === 'string' ? (
            description && <p className="text-muted-foreground max-w-2xl text-sm text-pretty">{description}</p>
          ) : description ? (
            <div className="text-muted-foreground text-sm">{description}</div>
          ) : null}
        </div>
      </header>
    );
  }

  return (
    <div
      className={cn('flex flex-wrap items-start justify-between gap-3 pb-3 sm:gap-4 jobber:pb-6', className)}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* In the Jobber-style shell, Jobber's page title: large, heavy,
              in the display face, and allowed to wrap as Jobber's do. */}
          <h1 className="jobber:font-display jobber:text-heading jobber:text-[1.75rem] sm:jobber:text-[2rem] jobber:leading-tight jobber:font-extrabold jobber:tracking-normal jobber:whitespace-normal truncate text-lg font-semibold tracking-tight">
            {heading}
          </h1>
          {info ? <InfoButton info={info} infoLabel={infoLabel} /> : null}
          {badges ? <div className="flex flex-wrap items-center gap-1.5">{badges}</div> : null}
        </div>
        {typeof description === 'string' ? (
          description && <p className="text-muted-foreground max-w-2xl text-sm text-pretty">{description}</p>
        ) : description ? (
          <div className="text-muted-foreground text-sm">{description}</div>
        ) : null}
      </div>
      {/* `max-w-full`: never wider than the header, so the buttons wrap. Without
          it the group kept its one-line width on a phone and pushed the page
          sideways (the plan's Publish button sat past the edge at 375px). */}
      {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** The (i) beside a title, opening the page's rules. */
function InfoButton({ info, infoLabel }: { info: ReactNode; infoLabel: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={infoLabel} className="text-muted-foreground -ml-1.5" size="icon-sm" variant="ghost">
          <InfoIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] text-sm">
        <p className="text-muted-foreground mb-2 font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase">
          {infoLabel}
        </p>
        <div className="space-y-2 leading-relaxed">{info}</div>
      </PopoverContent>
    </Popover>
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
        <h2 className="jobber:text-heading jobber:text-xl jobber:font-bold text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
