'use client';

import { useMemo, useState } from 'react';
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

import { useAdminMutations, useInspections, useTechnicians } from '@/lib/queries';

const assignableStatuses = new Set(['SCHEDULED', 'IN_PROGRESS', 'PROCESSING', 'REVIEW_REQUIRED']);

// Radix Select rejects an empty string as an item value; the "nothing
// selected" row uses a sentinel translated back to '' at the boundary.
const NONE = '__none__';

export function AssignmentCreateDialog({ onClose }: { onClose: () => void }) {
  const [inspectionId, setInspectionId] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [reason, setReason] = useState('');
  const inspections = useInspections({ page: 1, pageSize: 100, unassignedOnly: true });
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const mutation = useAdminMutations().assign;
  const assignableInspections = useMemo(
    () => inspections.data?.items.filter((item) => assignableStatuses.has(item.status)) ?? [],
    [inspections.data?.items],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({
      id: inspectionId,
      technicianId,
      reason: reason.trim() || undefined,
      idempotencyKey: crypto.randomUUID(),
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create assignment</DialogTitle>
            <DialogDescription>
              Select an unassigned inspection and an active technician.
            </DialogDescription>
          </DialogHeader>
        <Field>
          <FieldLabel htmlFor="assignment-inspection">Inspection</FieldLabel>
          <Select
            disabled={inspections.isLoading}
            onValueChange={(next) => setInspectionId(next === NONE ? '' : next)}
            value={inspectionId || NONE}
          >
            <SelectTrigger id="assignment-inspection">
              <SelectValue placeholder="Select inspection" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Select inspection</SelectItem>
              {assignableInspections.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.propertywareBuilding?.name ?? 'Property'}
                  {item.propertywareUnit?.name ? ` · ${item.propertywareUnit.name}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {inspections.isError ? (
            <FieldError>{inspections.error.message}</FieldError>
          ) : null}
          {!inspections.isLoading && !inspections.isError && !assignableInspections.length ? (
            <small>No active unassigned inspections are available.</small>
          ) : null}
        </Field>
        <Field className="mt-3.5">
          <label htmlFor="assignment-new-technician">Technician</label>
          <Select
            disabled={technicians.isLoading}
            onValueChange={(next) => setTechnicianId(next === NONE ? '' : next)}
            value={technicianId || NONE}
          >
            <SelectTrigger id="assignment-new-technician">
              <SelectValue placeholder="Select technician" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Select technician</SelectItem>
              {technicians.data?.items.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.displayName} · {item.workload?.current ?? 0} current
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {technicians.isError ? (
            <FieldError>{technicians.error.message}</FieldError>
          ) : null}
        </Field>
        <Field className="mt-3.5">
          <label htmlFor="assignment-new-reason">Assignment note</label>
          <textarea
            id="assignment-new-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Optional operational context"
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
            <button
              className={buttonVariants({ variant: 'primary' })}
              disabled={!inspectionId || !technicianId || mutation.isPending}
            >
              {mutation.isPending ? 'Assigning…' : 'Create assignment'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
