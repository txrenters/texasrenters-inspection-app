'use client';

import type { AdminAssignment } from '@texasrenters/shared';
import { useState, type FormEvent } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useAdminMutations, useTechnicians } from '@/lib/queries';

// Radix Select rejects an empty string as an item value; the "nothing selected"
// row uses a sentinel translated back to '' at the boundary.
const NONE = '__none__';

const NOTE_LIMIT = 500;

/**
 * Who is on an inspection: assign, reassign -- or, once the visit is done,
 * correct who did it (`afterVisit`, the office 2026-11-25: "it says Kevin but
 * we should have an option to replace it, like Moses").
 *
 * The correction sends nobody and tells nobody: the visit is over. It changes
 * the record, which the timesheet, Actual vs Budget and a new invoice read,
 * and Jobber's visit with it. So the reason is required, not optional.
 */
export function AssignmentDialog({
  inspectionId,
  current,
  afterVisit = false,
  bookedWith,
  onClose,
}: {
  inspectionId: string;
  current?: AdminAssignment;
  /** The visit is done: change who did it, rather than who is sent. */
  afterVisit?: boolean;
  /** The other inspection on the same Jobber visit, "HVAC", which changes with this one. */
  bookedWith?: string | null;
  onClose: () => void;
}) {
  const [technicianId, setTechnicianId] = useState('');
  const [reason, setReason] = useState('');
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const mutations = useAdminMutations();
  const routing = current ? mutations.reassign : mutations.assign;
  const mutation = afterVisit ? mutations.changeDoneTechnician : routing;
  const reasonRequired = afterVisit;
  const ready = Boolean(technicianId) && (!reasonRequired || reason.trim().length >= 2);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (afterVisit)
        await mutations.changeDoneTechnician.mutateAsync({
          id: inspectionId,
          technicianId,
          reason: reason.trim(),
        });
      else
        await routing.mutateAsync({
          id: inspectionId,
          technicianId,
          reason: reason.trim() || undefined,
          idempotencyKey: crypto.randomUUID(),
        });
      onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  const title = afterVisit ? 'Change technician' : current ? 'Reassign inspection' : 'Assign inspection';
  const action = afterVisit ? 'Change technician' : current ? 'Reassign' : 'Assign';

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {afterVisit ? (
                <>
                  {current ? (
                    <>
                      This visit is done and shows{' '}
                      <span className="text-foreground font-medium">{current.technician?.displayName}</span>.
                    </>
                  ) : (
                    'This visit is done and shows no technician.'
                  )}{' '}
                  Choose who did it. Nobody is notified, and Jobber&apos;s visit is changed to
                  match. {current ? 'The previous technician stays in the history.' : null}
                </>
              ) : current ? (
                <>
                  Currently assigned to{' '}
                  <span className="text-foreground font-medium">
                    {current.technician?.displayName}
                  </span>
                  . The previous assignment remains in history.
                </>
              ) : (
                'Select an active inspection technician.'
              )}
            </DialogDescription>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor="technician">{afterVisit ? 'Who did it' : 'Technician'}</FieldLabel>
            <Select
              disabled={technicians.isLoading}
              onValueChange={(next) => setTechnicianId(next === NONE ? '' : next)}
              value={technicianId || NONE}
            >
              <SelectTrigger className="w-full" id="technician">
                <SelectValue placeholder="Select technician" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Select technician</SelectItem>
                {technicians.data?.items
                  .filter((item) => item.id !== current?.technicianId)
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {/* What they have on now says nothing about a visit already done. */}
                      {afterVisit
                        ? item.displayName
                        : `${item.displayName} · ${item.workload?.current ?? 0} current`}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {afterVisit && bookedWith ? (
              <FieldDescription>
                The {bookedWith} inspection on the same Jobber visit changes with it, once it is done.
              </FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="reason">
              {afterVisit ? 'Reason' : current ? 'Reason for reassignment' : 'Assignment note'}
            </FieldLabel>
            <Textarea
              id="reason"
              maxLength={NOTE_LIMIT}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                afterVisit
                  ? 'Who actually went, and how you know'
                  : current
                    ? 'Why is this being reassigned?'
                    : 'Optional assignment note'
              }
              required={reasonRequired}
              value={reason}
            />
            <FieldDescription>
              {reason.length}/{NOTE_LIMIT} characters
            </FieldDescription>
          </Field>

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!ready || mutation.isPending} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Saving…' : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
