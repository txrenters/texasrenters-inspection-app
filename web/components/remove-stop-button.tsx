'use client';

import type { AssignedStop } from '@texasrenters/shared';
import { XIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** What the audit trail records when nobody types a reason of their own. */
export const MAP_REMOVAL_REASON = 'Taken off the day on the technician map';

/**
 * The "x" on a visit in the technician map's roster (the office, 2026-10-02:
 * remove a visit quickly, without going to the inspection page).
 *
 * It unassigns -- the inspection page's own Unassign, with its audit entry and
 * its push to Jobber. The visit stays booked for that day with nobody on it, so
 * it can go to somebody else; nothing is cancelled or deleted. One more click
 * to confirm, because a stray click on a row should not move somebody's work.
 *
 * Drawn only where the API said the removal would stick (`stop.removable`). A
 * Jobber visit whose console edits are not sent to Jobber shows the "x" greyed
 * out with the reason, rather than one that the next sync quietly undoes.
 */
export function RemoveStopButton({
  onRemove,
  stop,
  technicianName,
}: {
  onRemove: (stop: AssignedStop, reason: string) => Promise<void>;
  stop: AssignedStop;
  technicianName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(MAP_REMOVAL_REASON);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (stop.removable !== true) {
    if (stop.notRemovableBecause !== 'JOBBER_EDITS_OFF') return null;
    return (
      <span
        aria-label={`${stop.propertyName} cannot be taken off the day here`}
        className="text-muted-foreground/40 inline-flex size-6 shrink-0 cursor-not-allowed items-center justify-center"
        role="img"
        title="A Jobber visit: change it in Jobber. Changes made here are not sent to Jobber on this server, so the next sync would put it back."
      >
        <XIcon className="size-3.5" />
      </span>
    );
  }

  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await onRemove(stop, reason.trim().length >= 2 ? reason.trim() : MAP_REMOVAL_REASON);
      setOpen(false);
    } catch (reasonForFailure) {
      setError(
        reasonForFailure instanceof Error
          ? reasonForFailure.message
          : 'The visit could not be taken off the day.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setReason(MAP_REMOVAL_REASON);
          setError(null);
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={`Take ${stop.propertyName} off ${technicianName}'s day`}
          className="text-muted-foreground hover:text-destructive size-6 shrink-0"
          size="icon-sm"
          title="Take off this day"
          type="button"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-2 text-xs">
        <p className="text-sm font-medium">Take {stop.propertyName} off {technicianName}&rsquo;s day?</p>
        <p className="text-muted-foreground leading-relaxed">
          It stays booked for this day with nobody on it, so it can go to someone else. The
          change is recorded, and sent to Jobber.
        </p>
        <label className="grid gap-1">
          <span className="text-muted-foreground">Reason</span>
          <Input
            className="h-8 text-xs"
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </label>
        {error ? <p className="text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)} size="sm" type="button" variant="ghost">
            Keep
          </Button>
          <Button disabled={pending} onClick={() => void remove()} size="sm" type="button" variant="destructive">
            {pending ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
