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

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
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

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{current ? 'Reassign inspection' : 'Assign inspection'}</DialogTitle>
            <DialogDescription>
              {current ? (
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
            <FieldLabel htmlFor="technician">Technician</FieldLabel>
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
                      {item.displayName} · {item.workload?.current ?? 0} current
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="reason">
              {current ? 'Reason for reassignment' : 'Assignment note'}
            </FieldLabel>
            <Textarea
              id="reason"
              maxLength={NOTE_LIMIT}
              onChange={(event) => setReason(event.target.value)}
              placeholder={current ? 'Why is this being reassigned?' : 'Optional assignment note'}
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
            <Button disabled={!technicianId || mutation.isPending} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Saving…' : current ? 'Reassign' : 'Assign'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
