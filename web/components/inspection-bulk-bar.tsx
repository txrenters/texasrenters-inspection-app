'use client';

import { Trash2Icon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAdminMutations } from '@/lib/queries';

export interface BulkRow {
  id: string;
  name: string;
  /** Still to happen: the only rows these actions apply to. */
  upcoming: boolean;
  technicianId: string | null;
}

type Kind = 'assign' | 'reschedule' | 'cancel';

/**
 * A bar for the inspections picked on the list (console-development, T09).
 *
 * Built only from what one row can already do -- assign or reassign, move the
 * day, cancel with a reason -- applied to each picked row in turn, with the
 * server deciding each one exactly as it would alone. Nothing here books a
 * visit in Jobber. A visit already in Jobber follows its usual rule: changed
 * there too while sending to Jobber is on, refused (and listed) while it is off.
 *
 * Done and cancelled visits are left out of every action and counted, rather
 * than sent and refused one by one.
 */
export function InspectionBulkBar({
  rows,
  technicians,
  canAssign,
  canManage,
  canDelete,
  onDelete,
  onClear,
}: {
  rows: BulkRow[];
  technicians: Array<{ value: string; label: string }>;
  canAssign: boolean;
  canManage: boolean;
  canDelete: boolean;
  onDelete: () => void;
  onClear: () => void;
}) {
  const mutations = useAdminMutations();
  const [open, setOpen] = useState<Kind | null>(null);
  const [technicianId, setTechnicianId] = useState('');
  const [reason, setReason] = useState('');
  const [day, setDay] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ name: string; message: string }>>([]);

  if (!rows.length) return null;
  const upcoming = rows.filter((row) => row.upcoming);
  const leftOut = rows.length - upcoming.length;

  const close = () => {
    if (progress) return;
    setOpen(null);
    setFailures([]);
    setReason('');
    setDay('');
    setTechnicianId('');
  };

  /** One row at a time, so the server judges each exactly as it would alone, and a failure names its row. */
  async function each(targets: BulkRow[], act: (row: BulkRow) => Promise<unknown>, verb: string) {
    const failed: Array<{ name: string; message: string }> = [];
    setProgress({ done: 0, total: targets.length });
    for (const [index, row] of targets.entries()) {
      try {
        await act(row);
      } catch (error) {
        failed.push({ name: row.name, message: error instanceof Error ? error.message : 'The request failed.' });
      }
      setProgress({ done: index + 1, total: targets.length });
    }
    setProgress(null);
    const done = targets.length - failed.length;
    if (done) toast.success(`${done} ${done === 1 ? 'inspection' : 'inspections'} ${verb}`);
    if (failed.length) {
      setFailures(failed);
      return;
    }
    close();
    onClear();
  }

  const submit = () => {
    if (open === 'assign') {
      const targets = upcoming.filter((row) => row.technicianId !== technicianId);
      return each(
        targets,
        (row) =>
          row.technicianId
            ? mutations.reassign.mutateAsync({ id: row.id, technicianId, reason: reason.trim() || undefined })
            : mutations.assign.mutateAsync({ id: row.id, technicianId, reason: reason.trim() || undefined }),
        'assigned',
      );
    }
    if (open === 'reschedule')
      return each(
        upcoming,
        // The day as the edit dialog sends it: that date's UTC midnight.
        (row) => mutations.updateInspection.mutateAsync({ id: row.id, scheduledAt: new Date(day).toISOString() }),
        'moved',
      );
    if (open === 'cancel')
      return each(
        upcoming,
        (row) =>
          mutations.updateInspection.mutateAsync({
            id: row.id,
            status: 'CANCELLED',
            cancellationReason: reason.trim(),
          }),
        'cancelled',
      );
  };

  const ready =
    !progress &&
    upcoming.length > 0 &&
    (open === 'assign' ? Boolean(technicianId) : open === 'reschedule' ? Boolean(day) : reason.trim().length >= 2);
  const TITLES: Record<Kind, string> = {
    assign: 'Assign a technician',
    reschedule: 'Move to another day',
    cancel: 'Cancel inspections',
  };

  return (
    <>
      <div
        aria-label="Selected inspections"
        className="bg-popover text-popover-foreground fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border px-3 py-2 shadow-lg"
        role="toolbar"
      >
        <span className="px-1 text-sm">
          <span className="font-mono tabular-nums">{rows.length}</span> selected
        </span>
        <span aria-hidden className="bg-border mx-1 h-4 w-px" />
        {canAssign ? (
          <Button onClick={() => setOpen('assign')} size="sm" variant="outline">
            Assign
          </Button>
        ) : null}
        {canManage ? (
          <>
            <Button onClick={() => setOpen('reschedule')} size="sm" variant="outline">
              Reschedule
            </Button>
            <Button className="text-destructive" onClick={() => setOpen('cancel')} size="sm" variant="outline">
              Cancel
            </Button>
          </>
        ) : null}
        {canDelete ? (
          <Button className="text-destructive" onClick={onDelete} size="sm" variant="ghost">
            <Trash2Icon />
            Delete
          </Button>
        ) : null}
        <Button aria-label="Clear the selection" onClick={onClear} size="icon-sm" variant="ghost">
          <XIcon />
        </Button>
      </div>

      <Dialog onOpenChange={(next) => (next ? undefined : close())} open={open !== null}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{open ? TITLES[open] : ''}</DialogTitle>
            <DialogDescription>
              {upcoming.length === 1 ? '1 inspection' : `${upcoming.length} inspections`}
              {leftOut ? `; ${leftOut} done or cancelled ${leftOut === 1 ? 'is' : 'are'} left out` : ''}. Each is
              changed as if done on its own row. Any already in Jobber change there too while sending to Jobber is
              on; while it is off they are refused and listed here.
            </DialogDescription>
          </DialogHeader>

          {open === 'assign' ? (
            <div className="space-y-4">
              <Field>
                <FieldLabel htmlFor="bulk-technician">Technician</FieldLabel>
                <Select onValueChange={setTechnicianId} value={technicianId}>
                  <SelectTrigger className="w-full" id="bulk-technician">
                    <SelectValue placeholder="Choose a technician" />
                  </SelectTrigger>
                  <SelectContent>
                    {technicians.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Already on this technician: left as they are.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="bulk-assign-reason">Reason (optional)</FieldLabel>
                <Input id="bulk-assign-reason" maxLength={500} onChange={(event) => setReason(event.target.value)} value={reason} />
              </Field>
            </div>
          ) : null}

          {open === 'reschedule' ? (
            <Field>
              <FieldLabel htmlFor="bulk-day">New day (Texas)</FieldLabel>
              <DatePicker id="bulk-day" onChange={setDay} value={day} />
            </Field>
          ) : null}

          {open === 'cancel' ? (
            <Field>
              <FieldLabel htmlFor="bulk-cancel-reason">Cancellation reason</FieldLabel>
              <Textarea
                id="bulk-cancel-reason"
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                value={reason}
              />
              <FieldDescription>Recorded on each inspection. Assignments close; their history stays.</FieldDescription>
            </Field>
          ) : null}

          {failures.length ? (
            <Alert role="status" variant="warning">
              <AlertDescription>
                <p className="font-medium">
                  {failures.length === 1 ? '1 was not changed:' : `${failures.length} were not changed:`}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {failures.map((failure) => (
                    <li key={failure.name}>
                      {failure.name}: {failure.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button disabled={Boolean(progress)} onClick={close} variant="outline">
              {failures.length ? 'Close' : 'Keep as is'}
            </Button>
            {!failures.length ? (
              <Button
                disabled={!ready}
                onClick={() => void submit()}
                variant={open === 'cancel' ? 'destructive' : 'default'}
              >
                {progress
                  ? `${progress.done} of ${progress.total}…`
                  : open === 'cancel'
                    ? `Cancel ${upcoming.length}`
                    : open === 'reschedule'
                      ? `Move ${upcoming.length}`
                      : `Assign ${upcoming.length}`}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
