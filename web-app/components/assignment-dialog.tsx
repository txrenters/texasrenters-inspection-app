'use client';

import type { AdminAssignment } from '@texasrenters/shared';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { useAdminMutations, useTechnicians } from '@/lib/queries';

// Radix Select rejects an empty string as an item value; the "nothing
// selected" row uses a sentinel translated back to '' at the boundary.
const NONE = '__none__';

export function AssignmentDialog({
  inspectionId,
  current,
  onClose,
}: {
  inspectionId: string;
  current?: AdminAssignment;
  onClose: () => void;
}) {
  const [technicianId, setTechnicianId] = useState('');
  const [reason, setReason] = useState('');
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const mutations = useAdminMutations();
  const mutation = current ? mutations.reassign : mutations.assign;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({
      id: inspectionId,
      technicianId,
      reason: reason || undefined,
      idempotencyKey: crypto.randomUUID(),
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{current ? 'Reassign inspection' : 'Assign inspection'}</DialogTitle>
            <DialogDescription>
              {current ? (
                <>
                  Currently assigned to <strong>{current.technician?.displayName}</strong>. The
                  previous assignment remains in history.
                </>
              ) : (
                'Select an active inspection technician.'
              )}
            </DialogDescription>
          </DialogHeader>
        <Field>
          <FieldLabel htmlFor="technician">Technician</FieldLabel>
          <Select
            onValueChange={(next) => setTechnicianId(next === NONE ? '' : next)}
            value={technicianId || NONE}
          >
            <SelectTrigger id="technician">
              <SelectValue placeholder="Select technician" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Select technician</SelectItem>
              {technicians.data?.items
                .filter((item) => item.id !== current?.technicianId)
                .map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.displayName} · {item.workload?.current ?? 0} current
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="mt-3.5">
          <label htmlFor="reason">Reason or note</label>
          <textarea
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={current ? 'Reason for reassignment' : 'Optional assignment note'}
          />
        </Field>
        {mutation.error ? (
          <FieldError>
            {mutation.error.message}
          </FieldError>
        ) : null}
          <DialogFooter>
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={onClose}>
              Cancel
            </button>
            <button className={buttonVariants({ variant: 'primary' })} disabled={!technicianId || mutation.isPending}>
              {mutation.isPending ? 'Saving…' : current ? 'Reassign' : 'Assign'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
