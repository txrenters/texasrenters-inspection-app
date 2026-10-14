'use client';

import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
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
import { businessToday, shiftDay } from '@/lib/clock';
import { formatShortDay } from '@/lib/planning';
import { usePlanUnschedulePreview, type UnscheduleKeptReason } from '@/lib/planning-queries';

/** Why a visit stays on its day, in the office's words. */
export const KEPT_REASON: Record<UnscheduleKeptReason, string> = {
  IN_USE: 'started, recorded on or done',
  CANCELLED: 'called off, and kept as the record',
  COMPANION_IN_USE: 'the other job on its visit has work on it',
};

/** One visit, unscheduled from its own window. */
export interface UnscheduleOne {
  stopId: string;
  address: string | null;
  /** Booked: its inspection is deleted, and its Jobber visit goes to the Unscheduled list. */
  booked: boolean;
  inJobber: boolean;
}

/**
 * Takes a published quarter's visits off their days, so a Rebuild can group
 * them again (the office, 2026-10-15: "starting next week unschedule all tbp
 * that was scheduled so we can regroup them using the tbp group maker").
 *
 * From a day on, read back before anything is done: how many booked visits go
 * to Jobber's Unscheduled list, how many only lose a day, and which stay and
 * why. Or one visit, from its window.
 */
export function PlanUnscheduleDialog({
  open,
  onOpenChange,
  planId,
  label,
  one = null,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId: string | undefined;
  /** "Q4 2026". */
  label: string;
  /** The one visit to unschedule; null for every visit from a day on. */
  one?: UnscheduleOne | null;
  pending?: boolean;
  onConfirm: (input: { from: string } | { stopIds: string[] }) => void;
}) {
  const today = businessToday();
  // Tomorrow by default: today's visits are usually under way.
  const [from, setFrom] = useState('');
  const day = from || shiftDay(today, 1);
  const preview = usePlanUnschedulePreview(planId, day, open && !one);
  const facts = preview.data;
  const total = (facts?.booked ?? 0) + (facts?.notBooked ?? 0);

  const close = (next: boolean) => {
    if (!next) setFrom('');
    onOpenChange(next);
  };

  if (one)
    return (
      <Dialog onOpenChange={close} open={open}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unschedule {one.address ?? 'this visit'}?</DialogTitle>
            <DialogDescription>
              {one.booked
                ? `Its inspection is deleted here${
                    one.inJobber ? ', and its Jobber visit moves to the Unscheduled list on the same job' : ''
                  }. A Rebuild gives it a day again, and “Publish the rest” books it${
                    one.inJobber ? ' on that same Jobber visit' : ''
                  }.`
                : 'It loses its day. A Rebuild gives it one again.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => close(false)} type="button" variant="outline">
              Keep it
            </Button>
            <Button disabled={pending} onClick={() => onConfirm({ stopIds: [one.stopId] })} type="button" variant="destructive">
              {pending ? <Spinner /> : null}
              Unschedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unschedule {label} visits</DialogTitle>
          <DialogDescription>
            Every visit from the day you choose leaves its day. A booked one&rsquo;s inspection is deleted here and its
            Jobber visit moves to the Unscheduled list on the same job. Then Rebuild groups them again &mdash; from a
            Group maker template if you choose one &mdash; and &ldquo;Publish the rest&rdquo; books them on their new
            days, on those same Jobber visits.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-2 text-sm font-medium">From</legend>
          <DatePicker aria-label="First day to unschedule" min={today} onChange={setFrom} value={day} />
          <FieldDescription>Visits started, recorded on or done stay where they are.</FieldDescription>
        </fieldset>

        {preview.isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : preview.error ? (
          <Alert variant="destructive">
            <AlertDescription>{preview.error.message}</AlertDescription>
          </Alert>
        ) : facts ? (
          <div className="grid gap-2 text-sm">
            {total === 0 ? (
              <p className="text-muted-foreground">Nothing has a day from {formatShortDay(day)} on.</p>
            ) : (
              <ul className="grid gap-1">
                {facts.booked ? (
                  <li>
                    <span className="font-medium">{facts.booked.toLocaleString()}</span> booked{' '}
                    {facts.booked === 1 ? 'visit goes' : 'visits go'} to Jobber&rsquo;s Unscheduled list
                    {facts.firstDay && facts.lastDay
                      ? ` (${formatShortDay(facts.firstDay)}${
                          facts.lastDay === facts.firstDay ? '' : ` – ${formatShortDay(facts.lastDay)}`
                        })`
                      : ''}
                  </li>
                ) : null}
                {facts.notBooked ? (
                  <li>
                    <span className="font-medium">{facts.notBooked.toLocaleString()}</span> not booked yet{' '}
                    {facts.notBooked === 1 ? 'loses its day' : 'lose their days'}
                  </li>
                ) : null}
              </ul>
            )}
            {facts.kept.length ? (
              <details className="text-muted-foreground">
                <summary className="cursor-pointer">
                  {facts.kept.length.toLocaleString()} {facts.kept.length === 1 ? 'stays' : 'stay'} on {facts.kept.length === 1 ? 'its day' : 'their days'}
                </summary>
                <ul className="mt-1 grid max-h-40 gap-0.5 overflow-y-auto text-xs">
                  {facts.kept.map((row) => (
                    <li key={row.stopId}>
                      {row.date ? `${formatShortDay(row.date)} · ` : ''}
                      {row.address ?? 'A visit'} — {KEPT_REASON[row.reason]}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {facts.jobberSwitchedOff ? (
              <Alert variant="destructive">
                <AlertDescription>
                  This server does not send changes to Jobber, so booked visits cannot be moved to its Unscheduled
                  list from here. Unschedule them in Jobber; they leave the console on the next sync.
                </AlertDescription>
              </Alert>
            ) : facts.booked ? (
              <p className="text-muted-foreground text-xs">
                Jobber is told a batch at a time, over the next minutes. A visit still on its way there is booked by
                the next &ldquo;Publish the rest&rdquo; once it has arrived.
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button onClick={() => close(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={pending || !facts || total === 0 || facts.jobberSwitchedOff}
            onClick={() => onConfirm({ from: day })}
            type="button"
            variant="destructive"
          >
            {pending ? <Spinner /> : null}
            Unschedule {total ? total.toLocaleString() : ''} {total === 1 ? 'visit' : 'visits'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
