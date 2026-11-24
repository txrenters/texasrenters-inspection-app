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
  work: 'Jobber work',
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
  // Jobber work that is not an inspection (2026-11-25): Jobber's title and tick, nothing to open here.
  const work = Boolean(row.jobberWork);
  const done = group === 'done' || (work && Boolean(row.jobber?.completed));
  const label = work ? (row.jobber?.title ?? row.property) : row.property;
  const start = visitStart(row);
  const time = businessTimeOfDay(start);
  const person = named !== undefined ? named : personOf(row);
  // Everyone Jobber has on its own work, as its popup lists them; one person otherwise.
  const team: (string | null)[] = work && row.jobber?.technician?.includes(', ') ? row.jobber.technician.split(', ') : [person];
  const differs = row.state !== 'MATCHES';
  const warning = jobberDayTone(row.state);
  // The other kinds of work in its job, drawn on this one card (2026-11-20).
  const more = row.job ? row.job.kinds.length - 1 : 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-[3px] px-1.5 py-1 text-left text-xs leading-tight outline-none focus-visible:ring-[3px]',
            tone.bar,
            tone.tint,
            (isOneSided(row.state) || work) && 'border border-l-[3px] border-dashed',
            work && 'border-muted-foreground/40 bg-muted/40',
            (done || group === 'cancelled') && 'opacity-70',
            className,
          )}
          style={style}
          type="button"
        >
          {showPerson ? <PersonDisc className="size-4 text-[8px]" name={person} /> : null}
          {done ? <CheckIcon aria-label="Done" className="text-success size-3 shrink-0" /> : null}
          {time ? (
            <span className="text-muted-foreground shrink-0 font-mono text-[10.5px]">{time.replace(' ', '')}</span>
          ) : null}
          <span className={cn('text-heading min-w-0 truncate font-medium', group === 'cancelled' && 'line-through')}>
            {label}
          </span>
          {more > 0 ? (
            <span
              aria-label={`and ${more} more ${more === 1 ? 'kind' : 'kinds'} of work in the job`}
              className="text-muted-foreground shrink-0 text-[10.5px] font-semibold"
            >
              +{more}
            </span>
          ) : null}
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
        {work ? (
          <JobberWorkDetails date={date} done={done} row={row} team={team} time={time} />
        ) : (
          <>
        <div className={cn('border-l-4 px-4 pt-3 pb-3', tone.bar)}>
          <p className="text-muted-foreground text-xs">
            {work
              ? `Jobber work · ${done ? 'Done' : 'To do'}`
              : `${row.job ? `Job ${row.job.number}` : typeTitle(row.inspectionType)} · ${STATUS_WORDS[group] ?? humanize(row.status)}`}
          </p>
          <p className="text-heading mt-0.5 font-semibold">{label}</p>
          {work && label !== row.property ? <p className="text-muted-foreground mt-0.5 text-xs">{row.property}</p> : null}
          {row.job ? <p className="text-muted-foreground mt-0.5 text-xs">{row.job.title}</p> : null}
        </div>
        {/* What Jobber's popup shows under Details (2026-11-25): the job, and what to do there. */}
        {row.jobber?.jobNumber || row.jobber?.details ? (
          <div className="border-t px-4 py-3 text-sm">
            <p className="text-muted-foreground text-xs font-medium">Details</p>
            {row.jobber.jobNumber && !row.job ? <p className="mt-0.5 font-medium">Job #{row.jobber.jobNumber}</p> : null}
            {row.jobber.details ? (
              <p className="text-muted-foreground mt-1 line-clamp-4 text-xs whitespace-pre-line">{row.jobber.details}</p>
            ) : null}
          </div>
        ) : null}
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-t px-4 py-3 text-sm">
          {row.job ? (
            <>
              <dt className="text-muted-foreground">Work</dt>
              <dd>{row.job.kinds.map((kind) => typeTitle(kind)).join(', ')}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Team</dt>
          <dd className="flex min-w-0 flex-col gap-1">
            {team.map((name, index) => (
              <span className="flex min-w-0 items-center gap-2" key={name ?? index}>
                <PersonDisc name={name} />
                <span className="truncate">{name ?? 'Unassigned'}</span>
              </span>
            ))}
          </dd>
          {row.jobber?.address ? (
            <>
              <dt className="text-muted-foreground">Location</dt>
              <dd>{row.jobber.address}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">When</dt>
          <dd>
            {weekdayOf(date)}, {formatScheduledDate(date)} · {time ?? 'Anytime'}
          </dd>
          <dt className="text-muted-foreground">Jobber</dt>
          <dd className="min-w-0">
            {row.jobber?.title && !work ? <span className="block truncate">{row.jobber.title}</span> : null}
            <span className={cn(differs ? (warning === 'destructive' ? 'text-destructive' : 'text-warning') : 'text-muted-foreground')}>
              {work ? 'From Jobber, not an inspection' : differs ? JOBBER_DAY_LABEL[row.state] : 'Matches Jobber'}
            </span>
            {differs && row.differences[0] && row.differences[0] !== JOBBER_DAY_LABEL[row.state] ? (
              <span className="text-muted-foreground block text-xs">{row.differences[0]}</span>
            ) : null}
            {row.importNote ? <span className="text-muted-foreground block text-xs">{row.importNote}</span> : null}
          </dd>
        </dl>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          {row.job ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${row.job.id}`}>Open job</Link>
            </Button>
          ) : null}
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
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Jobber work's popup, laid out as Jobber's own visit popup (the office,
 * 2026-11-25: "we should copy jobber when clicking the job"): the title,
 * "Visit", Completed, Details with the job, Team, Location, Start. Read-only:
 * the Completed box shows Jobber's tick and changes nothing, and there is no
 * Edit -- the visit is changed in Jobber.
 */
function JobberWorkDetails({
  row,
  date,
  done,
  team,
  time,
}: {
  row: JobberDayRow;
  date: string;
  done: boolean;
  team: (string | null)[];
  time: string | null;
}) {
  const jobber = row.jobber;
  return (
    <>
      <div className="px-4 pt-3 pb-3">
        <p className="text-heading leading-snug font-semibold">{jobber?.title ?? row.property}</p>
        <p className="text-muted-foreground text-xs">Visit</p>
        <p className="mt-2 flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn(
              'inline-flex size-4 items-center justify-center rounded-sm border',
              done ? 'border-success bg-success text-background' : 'border-muted-foreground/50',
            )}
          >
            {done ? <CheckIcon className="size-3" /> : null}
          </span>
          {done ? 'Completed' : 'Not completed'}
        </p>
      </div>
      <dl className="space-y-3 border-t px-4 py-3 text-sm">
        {jobber?.jobNumber || jobber?.details ? (
          <div>
            <dt className="font-semibold">Details</dt>
            <dd className="mt-0.5">
              <p>
                {row.property}
                {jobber.jobNumber ? (
                  <>
                    {' - '}
                    <span>Job #{jobber.jobNumber}</span>
                  </>
                ) : null}
              </p>
              {jobber.details ? (
                <p className="text-muted-foreground mt-1 line-clamp-4 whitespace-pre-line">{jobber.details}</p>
              ) : null}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="font-semibold">Team</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {team.map((name, index) => (
              <span className="bg-muted flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-0.5" key={name ?? index}>
                <PersonDisc name={name} />
                <span className="truncate">{name ?? 'Unassigned'}</span>
              </span>
            ))}
          </dd>
        </div>
        {jobber?.address ? (
          <div>
            <dt className="font-semibold">Location</dt>
            <dd className="mt-0.5">{jobber.address}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-semibold">Start</dt>
          <dd className="mt-0.5">
            <p>{formatScheduledDate(date)}</p>
            <p>{time ?? 'Anytime'}</p>
          </dd>
        </div>
      </dl>
      <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
        <span className="text-muted-foreground text-xs">From Jobber · change it there</span>
        <Button asChild size="sm" variant="outline">
          <Link href={`/schedule?mode=compare&view=day&date=${date}`}>See it against Jobber</Link>
        </Button>
      </div>
    </>
  );
}
