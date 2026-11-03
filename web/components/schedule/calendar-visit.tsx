'use client';

import type { JobberDayRow } from '@texasrenters/shared';
import { CheckIcon, UserRoundXIcon } from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { businessTimeOfDay } from '@/lib/clock';
import { formatScheduledDate, humanize, initials } from '@/lib/format';
import { typeTitle, typeTone } from '@/lib/inspection-type-tone';
import { JOBBER_DAY_LABEL, isOneSided, jobberDayTone } from '@/lib/jobber-day';
import { statusGroup, visitStart, weekdayOf } from '@/lib/schedule-calendar';
import { cn } from '@/lib/utils';

/** Who a visit is with, as either side names them. */
export const personOf = (row: JobberDayRow) => row.here?.technician ?? row.jobber?.technician ?? null;

/**
 * A person's initials on a dark disc, as Jobber marks who is on a visit. A
 * dashed ring with a struck-out figure for nobody, so "Unassigned" is never
 * just a missing disc.
 */
export function PersonDisc({ name, className }: { name: string | null; className?: string }) {
  if (!name)
    return (
      <span
        aria-hidden
        className={cn(
          'text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed',
          className,
        )}
      >
        <UserRoundXIcon className="size-3" />
      </span>
    );
  return (
    <span
      aria-hidden
      className={cn(
        'bg-heading text-background inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-bold',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

const STATUS_WORDS: Record<string, string> = {
  upcoming: 'To do',
  active: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
  jobber: 'Only in Jobber',
};

/**
 * One visit on the calendar, as Jobber draws one: a tinted card in its type's
 * colour with who is on it, a tick once it is done, and its time when it has
 * one. A visit that differs from Jobber carries a dot; one that exists on only
 * one side is dashed, as on the comparison.
 *
 * A click opens what Jobber's visit popover shows -- what, who, when, and the
 * way to the inspection -- and changes nothing. Editing stays on the
 * inspection, behind its own confirmations; Jobber's "Completed" box has no
 * counterpart here on purpose.
 */
export function CalendarVisit({
  date,
  person: named,
  row,
  showPerson = true,
  style,
  className,
}: {
  date: string;
  /**
   * Who it is with, as the calendar resolved it from the day's technicians.
   * Falls back to the row's own names, which either side may leave empty.
   */
  person?: string | null;
  row: JobberDayRow;
  /** Off in a technician's own column, where the column already says who. */
  showPerson?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const tone = typeTone(row.inspectionType);
  const group = statusGroup(row);
  const start = visitStart(row);
  const time = businessTimeOfDay(start);
  const person = named !== undefined ? named : personOf(row);
  const differs = row.state !== 'MATCHES';
  const warning = jobberDayTone(row.state);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-[3px] px-1.5 py-1 text-left text-xs leading-tight outline-none focus-visible:ring-[3px]',
            tone.bar,
            tone.tint,
            isOneSided(row.state) && 'border border-l-[3px] border-dashed',
            (group === 'done' || group === 'cancelled') && 'opacity-70',
            className,
          )}
          style={style}
          type="button"
        >
          {showPerson ? <PersonDisc className="size-4 text-[8px]" name={person} /> : null}
          {group === 'done' ? <CheckIcon aria-label="Done" className="text-success size-3 shrink-0" /> : null}
          {time ? (
            <span className="text-muted-foreground shrink-0 font-mono text-[10.5px]">{time.replace(' ', '')}</span>
          ) : null}
          <span className={cn('text-heading min-w-0 truncate font-medium', group === 'cancelled' && 'line-through')}>
            {row.property}
          </span>
          {differs ? (
            <span
              aria-label={JOBBER_DAY_LABEL[row.state]}
              className={cn(
                'ml-auto size-1.5 shrink-0 rounded-full',
                warning === 'destructive' ? 'bg-destructive' : 'bg-warning',
              )}
              role="img"
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div className={cn('border-l-4 px-4 pt-3 pb-3', tone.bar)}>
          <p className="text-muted-foreground text-xs">
            {typeTitle(row.inspectionType)} · {STATUS_WORDS[group] ?? humanize(row.status)}
          </p>
          <p className="text-heading mt-0.5 font-semibold">{row.property}</p>
        </div>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-t px-4 py-3 text-sm">
          <dt className="text-muted-foreground">Team</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <PersonDisc name={person} />
            <span className="truncate">{person ?? 'Unassigned'}</span>
          </dd>
          <dt className="text-muted-foreground">When</dt>
          <dd>
            {weekdayOf(date)}, {formatScheduledDate(date)} · {time ?? 'Anytime'}
          </dd>
          <dt className="text-muted-foreground">Jobber</dt>
          <dd className="min-w-0">
            {row.jobber?.title ? <span className="block truncate">{row.jobber.title}</span> : null}
            <span className={cn(differs ? (warning === 'destructive' ? 'text-destructive' : 'text-warning') : 'text-muted-foreground')}>
              {differs ? JOBBER_DAY_LABEL[row.state] : 'Matches Jobber'}
            </span>
            {differs && row.differences[0] && row.differences[0] !== JOBBER_DAY_LABEL[row.state] ? (
              <span className="text-muted-foreground block text-xs">{row.differences[0]}</span>
            ) : null}
            {row.importNote ? <span className="text-muted-foreground block text-xs">{row.importNote}</span> : null}
          </dd>
        </dl>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          {row.inspectionId ? (
            <Button asChild size="sm">
              <Link href={`/inspections/${row.inspectionId}`}>Open inspection</Link>
            </Button>
          ) : (
            // A Jobber-only visit has no inspection to open. The comparison is
            // where it can be made into one, behind that page's own buttons.
            <Button asChild size="sm" variant="outline">
              <Link href={`/schedule?mode=compare&view=day&date=${date}`}>See it against Jobber</Link>
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
