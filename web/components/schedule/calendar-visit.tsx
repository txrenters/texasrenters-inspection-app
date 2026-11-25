'use client';

import type { JobberDayRow } from '@texasrenters/shared';
import { CheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { businessTimeOfDay } from '@/lib/clock';
import { formatScheduledDate, humanize } from '@/lib/format';
import { typeTitle, typeTone } from '@/lib/inspection-type-tone';
import { JOBBER_DAY_LABEL, isOneSided, jobberDayTone } from '@/lib/jobber-day';
import { statusGroup, visitName, visitStart, weekdayOf } from '@/lib/schedule-calendar';
import { cn } from '@/lib/utils';

import { JobberVisitPopup, useDragged } from './jobber-visit-popup';
import { PersonDisc } from './person-disc';
import { WorkOrderTag } from './work-order-tag';

/** Who a visit is with, as either side names them. */
export const personOf = (row: JobberDayRow) => row.here?.technician ?? row.jobber?.technician ?? null;

export { PersonDisc };

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
 * A click on a visit Jobber has opens Jobber's own popup (JobberVisitPopup):
 * the same size, moved by its handle, with its buttons -- none of which change
 * Jobber yet. A visit only here opens what it is and the way to it.
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
  const label = visitName(row);
  const start = visitStart(row);
  const time = businessTimeOfDay(start);
  const person = named !== undefined ? named : personOf(row);
  // Everyone Jobber has on it, as its popup lists them; one person otherwise.
  const team: (string | null)[] = row.jobber?.technician?.includes(', ') ? row.jobber.technician.split(', ') : [person];
  const [open, setOpen] = useState(false);
  const dragged = useDragged();
  const differs = row.state !== 'MATCHES';
  const warning = jobberDayTone(row.state);
  // The other kinds of work in its job, drawn on this one card (2026-11-20).
  const more = row.job ? row.job.kinds.length - 1 : 0;
  const needsApproval = Boolean(row.workOrder && !row.workOrder.approved);

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (next) dragged.reset();
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            'focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-[3px] px-1.5 py-1 text-left text-xs leading-tight outline-none focus-visible:ring-[3px]',
            tone.bar,
            tone.tint,
            (isOneSided(row.state) || work) && 'border border-l-[3px] border-dashed',
            work && 'border-muted-foreground/40 bg-muted/40',
            (done || group === 'cancelled') && 'opacity-70',
            // Not approved yet (2026-11-26): an amber outline, so nobody is sent before it is.
            needsApproval && 'border-warning border border-l-[3px] border-dashed',
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
          <WorkOrderTag compact workOrder={row.workOrder} />
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
      <PopoverContent
        align="start"
        className={cn('max-w-[calc(100vw-2rem)] p-0', row.jobber ? 'w-[300px]' : 'w-80')}
        style={row.jobber ? { transform: `translate(${dragged.offset.x}px, ${dragged.offset.y}px)` } : undefined}
      >
        {row.jobber ? (
          <JobberVisitPopup
            date={date}
            done={done || Boolean(row.jobber.completed)}
            flag={<WorkOrderTag workOrder={row.workOrder} />}
            more={
              <>
                {row.job ? (
                  <DropdownMenuItem asChild>
                    <Link href={`/jobs/${row.job.id}`}>Open job</Link>
                  </DropdownMenuItem>
                ) : null}
                {row.inspectionId ? (
                  <DropdownMenuItem asChild>
                    <Link href={`/inspections/${row.inspectionId}`}>Open inspection</Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link href={`/schedule?mode=compare&view=day&date=${date}`}>
                    {work ? 'See it against Jobber' : differs ? JOBBER_DAY_LABEL[row.state] : 'Matches Jobber'}
                  </Link>
                </DropdownMenuItem>
              </>
            }
            onClose={() => setOpen(false)}
            onHandle={dragged.onPointerDown}
            row={row}
            team={team}
            time={time}
          />
        ) : (
          <>
        <div className={cn('border-l-4 px-4 pt-3 pb-3', tone.bar)}>
          <p className="text-muted-foreground text-xs">
            {work
              ? `Jobber work · ${done ? 'Done' : 'To do'}`
              : `${row.job ? `Job ${row.job.number}` : typeTitle(row.inspectionType)} · ${STATUS_WORDS[group] ?? humanize(row.status)}`}
          </p>
          <p className="text-heading mt-0.5 font-semibold">{label}</p>
          <WorkOrderTag className="mt-1" workOrder={row.workOrder} />
          {label !== row.property ? <p className="text-muted-foreground mt-0.5 text-xs">{row.property}</p> : null}
          {row.job ? <p className="text-muted-foreground mt-0.5 text-xs">{row.job.title}</p> : null}
        </div>
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
          <dt className="text-muted-foreground">When</dt>
          <dd>
            {weekdayOf(date)}, {formatScheduledDate(date)} · {time ?? 'Anytime'}
          </dd>
          <dt className="text-muted-foreground">Jobber</dt>
          <dd className="min-w-0">
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

