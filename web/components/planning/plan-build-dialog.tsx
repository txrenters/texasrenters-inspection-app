'use client';

import { type Quarter } from '@texasrenters/shared';
import { useId, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldDescription } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { businessToday } from '@/lib/clock';
import { formatShortDay, planStartOptions, planStartValue, type PlanStartOption } from '@/lib/planning';
import { usePlanTechnicians } from '@/lib/planning-queries';
import { cn } from '@/lib/utils';

/** Who to send out and the first day, as the Build dialog hands them over. */
export interface PlanBuildChoice {
  technicianIds: string[];
  /** `YYYY-MM-DD`: fifteen days early, on time, or fifteen days late. */
  startsOn: string;
  /** Lay the visits already published out again, moving their booked dates. */
  movePublishedVisits: boolean;
  /**
   * Send the visits out to nobody: not on a phone, and into Jobber's Unassigned
   * list for the office to hand out there (the office, 2026-09-29). Nobody is
   * chosen then, and `technicianIds` is empty.
   *
   * Asked here rather than at publish time because it is stored on the plan: a
   * visit reaches Jobber minutes to hours after publishing, and the answer has
   * to be waiting for it.
   */
  jobberUnassigned: boolean;
  /** Visits in a day: the planner fills to this where the driving allows. */
  stopsPerDay: number;
  /** Zones left out of the build, by number. */
  excludedZones: string[];
}

/**
 * What a day may hold, and what it costs.
 *
 * Measured on the office's own Q4: at ten a day, 41 of 47 days come out
 * exactly full at a five-minute median hop between properties. Twelve is
 * offered because the planner allows it, but ten occupied visits already fill
 * about 5.7 hours of a six-hour day once the driving is counted -- twelve does
 * not fit unless the day is mostly HVAC.
 */
export const DAY_SIZES = [9, 10, 12] as const;

/** The zones the office works. Five is theirs to arrange by hand. */
export const PLAN_ZONES = ['1', '2', '3', '4', '5'] as const;

/**
 * Who to send out, and from which day, asked before a quarter is built.
 *
 * The office (2026-09-19): "before generating ... it should ask for the
 * technicians so a list of technicians will appear then with check box we can
 * select who", "then the +-15 days if we will apply the +15 or -15 or on time
 * quarter schedule". Two questions, no more: the office found a form of visit
 * minutes and closed days confusing (2026-09-16). The first time the crew on the
 * planning profiles is ticked; a rebuild starts from the plan's own choice.
 */
export function PlanBuildDialog({
  open,
  onOpenChange,
  quarter,
  label,
  rebuild,
  chosen = [],
  startsOn = null,
  jobberUnassigned = false,
  pending = false,
  onBuild,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quarter: Quarter;
  /** "Q4 2026". */
  label: string;
  /** Rebuilding a plan there is, rather than building the first. */
  rebuild: boolean;
  /** The technicians the plan was last built for; empty, the crew. */
  chosen?: readonly string[];
  /** The plan's own first day, when it has one. */
  startsOn?: string | null;
  /** The plan's own answer, so a rebuild opens on the last one given. */
  jobberUnassigned?: boolean;
  pending?: boolean;
  onBuild: (choice: PlanBuildChoice) => void;
}) {
  const technicians = usePlanTechnicians(open);
  const today = businessToday();
  const starts = useMemo(() => planStartOptions(quarter, startsOn, today), [quarter, startsOn, today]);
  const startName = useId();
  const daySizeName = useId();
  // What the coordinator changed; until then, the plan's choice or the crew.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [start, setStart] = useState<PlanStartOption['value'] | null>(null);
  // Off unless asked for. Moving a published visit changes a date the office
  // has already told Jobber about, which is not something a rebuild should do
  // because somebody clicked the usual button.
  const [movePublished, setMovePublished] = useState(false);
  // `null` until it is touched, so the plan's own answer shows through — the
  // same shape as `picked` and `start` above, and for the same reason. Unlike
  // `movePublished`, which is a one-off for this rebuild, this is stored on the
  // plan and so has a previous answer to fall back to.
  const [unassigned, setUnassigned] = useState<boolean | null>(null);
  const sendUnassigned = unassigned ?? jobberUnassigned;
  /**
   * Nine unless the office says otherwise, which is the planner's own default.
   * This is the control that actually moves the number of days in a quarter --
   * the grouping radius never did.
   */
  const [stopsPerDay, setStopsPerDay] = useState<number>(9);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const listed = useMemo(() => technicians.data ?? [], [technicians.data]);
  const initial = useMemo(() => {
    const fromPlan = chosen.filter((id) => listed.some((technician) => technician.id === id));
    return new Set(fromPlan.length ? fromPlan : listed.filter((technician) => technician.crewOrder !== null).map((technician) => technician.id));
  }, [chosen, listed]);
  const selected = picked ?? initial;
  const chosenStart = starts.find((option) => option.value === (start ?? planStartValue(starts, startsOn))) ?? starts[1]!;

  const close = (next: boolean) => {
    if (!next) {
      setPicked(null);
      setStart(null);
      setMovePublished(false);
      setUnassigned(null);
      setStopsPerDay(9);
      setSkipped(new Set());
    }
    onOpenChange(next);
  };
  const toggle = (technicianId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(technicianId);
    else next.delete(technicianId);
    setPicked(next);
  };
  const build = () => {
    onBuild({
      // In the list's order -- the crew's, then by name -- which is the order the zones go round.
      // Nobody, for a quarter sent out to nobody: the server sizes its days for the crew.
      technicianIds: sendUnassigned
        ? []
        : listed.filter((technician) => selected.has(technician.id)).map((technician) => technician.id),
      startsOn: chosenStart.date,
      movePublishedVisits: rebuild && movePublished,
      jobberUnassigned: sendUnassigned,
      stopsPerDay,
      excludedZones: [...skipped].sort(),
    });
    setPicked(null);
    setStart(null);
    setMovePublished(false);
    setUnassigned(null);
    setStopsPerDay(9);
    setSkipped(new Set());
  };
  const count = listed.filter((technician) => selected.has(technician.id)).length;
  /** How many days a quarter sent out to nobody runs at once: the benefit-package crew's. */
  const crewSize = listed.filter((technician) => technician.crewOrder !== null).length;

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{rebuild ? `Rebuild ${label}` : `Build the ${label} plan`}</DialogTitle>
          <DialogDescription>
            Choose who goes out and when the quarter starts. The visits are grouped into days of 9 for the least
            driving — a 10th where it is within 5 minutes of the day — and never more than 20 minutes from one property
            to the next.
          </DialogDescription>
        </DialogHeader>

        {/* First, because it decides whether anyone is chosen at all (the office,
            2026-09-29: "I already clicked that unassigned ... but still needs to
            select a technician?"). Sent out to nobody, nobody has the visits --
            not on a phone and not in Jobber -- until the office hands them out in
            Jobber, and the sync gives each to whoever it names. */}
        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-medium">Who gets the visits</legend>
          <label className="hover:bg-accent/60 flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2">
            <Checkbox
              checked={sendUnassigned}
              className="mt-0.5"
              onCheckedChange={(checked) => setUnassigned(checked === true)}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Send the visits out unassigned</span>
              <span className="text-muted-foreground block text-xs">
                Nobody gets them &mdash; not on a phone, and not in Jobber, where they arrive in the
                Unassigned list. Whoever you hand a visit to in Jobber gets it on their phone at the next
                sync.
              </span>
            </span>
          </label>
          <FieldDescription>
            {sendUnassigned
              ? 'Rebuilding later will not put a name on a visit, here or in Jobber.'
              : 'Each visit goes to whoever its day belongs to, on their phone and in Jobber where Jobber knows them.'}
          </FieldDescription>
        </fieldset>

        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-medium">Technicians</legend>
          {sendUnassigned ? (
            <p className="text-muted-foreground text-sm">
              Nobody to choose: the visits go out unassigned. The quarter is planned in{' '}
              {crewSize > 0 ? crewSize : 'the'} day group{crewSize === 1 ? '' : 's'} at a time, the size of the
              benefit-package crew, and each day starts at its own first visit.
            </p>
          ) : technicians.isLoading ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : listed.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active technicians to send out.</p>
          ) : (
            <ul className="divide-border max-h-64 divide-y overflow-y-auto rounded-lg border">
              {listed.map((technician) => (
                <li key={technician.id}>
                  <label className="hover:bg-accent/60 flex cursor-pointer items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={selected.has(technician.id)}
                      onCheckedChange={(checked) => toggle(technician.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{technician.displayName}</span>
                      <span className="text-muted-foreground block text-xs">
                        {technician.crewOrder === null ? 'Not on the benefit-package crew' : 'Benefit-package crew'}
                        {technician.hasHome ? '' : ' · no home on file, so days start at the first visit'}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {sendUnassigned ? null : (
            <p className="text-muted-foreground text-xs">
              {count} chosen. Each works every day until the month&rsquo;s visits are done, starting in a zone of
              their own each week.
            </p>
          )}
        </fieldset>

        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-medium">Start</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {starts.map((option) => (
              <label
                className={cn(
                  'hover:bg-accent/60 grid cursor-pointer gap-0.5 rounded-lg border px-3 py-2',
                  option.value === chosenStart.value && 'border-ring bg-accent',
                )}
                key={option.value}
              >
                <span className="flex items-center gap-2">
                  <input
                    checked={option.value === chosenStart.value}
                    className="accent-primary"
                    name={startName}
                    onChange={() => setStart(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span className="text-sm font-medium">{option.label}</span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatShortDay(option.date)}
                  {option.past ? ' · days already gone are skipped' : ''}
                </span>
              </label>
            ))}
          </div>
          <FieldDescription>
            Days before the quarter take its first month’s visits. The second and third months keep their own.
          </FieldDescription>
        </fieldset>

        {/* Only on a rebuild. On a first build there is nothing published to
            move, and an option that can never do anything is a question the
            reader has to answer for no reason. */}
        {rebuild ? (
          <fieldset className="grid min-w-0 gap-2">
            <legend className="mb-2 text-sm font-medium">Visits already published</legend>
            <label className="hover:bg-accent/60 flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2">
              <Checkbox
                checked={movePublished}
                className="mt-0.5"
                onCheckedChange={(checked) => setMovePublished(checked === true)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Lay published visits out again</span>
                <span className="text-muted-foreground block text-xs">
                  Their dates move with the rest of the quarter, and each one is rescheduled in Jobber. Left
                  off, they stay on the day they were published and the rebuild works around them.
                </span>
              </span>
            </label>
            <FieldDescription>
              A visit already inspected is never moved, whichever way this is set.
            </FieldDescription>
          </fieldset>
        ) : null}

        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-medium">Visits a day</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {DAY_SIZES.map((size) => (
              <label
                className={cn(
                  'hover:bg-accent/60 grid cursor-pointer gap-0.5 rounded-lg border px-3 py-2',
                  size === stopsPerDay && 'border-ring bg-accent',
                )}
                key={size}
              >
                <span className="flex items-center gap-2">
                  <input
                    checked={size === stopsPerDay}
                    className="accent-primary"
                    name={daySizeName}
                    onChange={() => setStopsPerDay(size)}
                    type="radio"
                    value={size}
                  />
                  <span className="text-sm font-medium">{size} a day</span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {size === 9
                    ? 'the planner’s own default'
                    : size === 10
                      ? 'fills the day, about 5½ hours'
                      : 'only where the day is mostly HVAC'}
                </span>
              </label>
            ))}
          </div>
          <FieldDescription>
            A day is filled to this where the driving allows it &mdash; never more than 20 minutes from
            one property to the next, so a thin patch still makes a short day.
          </FieldDescription>
        </fieldset>

        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-medium">Zones</legend>
          <div className="flex flex-wrap gap-2">
            {PLAN_ZONES.map((zone) => {
              const on = !skipped.has(zone);
              return (
                <label
                  className={cn(
                    'hover:bg-accent/60 flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2',
                    on ? 'border-ring bg-accent' : 'text-muted-foreground',
                  )}
                  key={zone}
                >
                  <Checkbox
                    checked={on}
                    onCheckedChange={(checked) => {
                      const next = new Set(skipped);
                      if (checked === true) next.delete(zone);
                      else next.add(zone);
                      setSkipped(next);
                    }}
                  />
                  <span className="text-sm font-medium">Zone {zone}</span>
                </label>
              );
            })}
          </div>
          <FieldDescription>
            A zone left out is held back and said so, not dropped &mdash; its visits wait for the
            office to arrange them.
          </FieldDescription>
        </fieldset>

        <DialogFooter>
          <Button onClick={() => close(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={pending || technicians.isLoading || (!sendUnassigned && count === 0)}
            onClick={build}
            type="button"
          >
            {pending ? <Spinner /> : null}
            {rebuild ? 'Rebuild' : 'Build'}{' '}
            {sendUnassigned ? 'unassigned' : `for ${count} ${count === 1 ? 'technician' : 'technicians'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
