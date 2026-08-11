'use client';

import { useMemo, useState, type FormEvent } from 'react';

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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useAdminMutations, useInspections, useTechnicians } from '@/lib/queries';

const ASSIGNABLE_STATUSES = new Set([
  'SCHEDULED',
  'IN_PROGRESS',
  'PROCESSING',
  'REVIEW_REQUIRED',
]);

// Radix Select rejects an empty string as an item value; the "nothing selected"
// row uses a sentinel translated back to '' at the boundary.
const NONE = '__none__';

const NOTE_LIMIT = 500;

export function AssignmentCreateDialog({ onClose }: { onClose: () => void }) {
  const [inspectionId, setInspectionId] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [reason, setReason] = useState('');
  const inspections = useInspections({ page: 1, pageSize: 100, unassignedOnly: true });
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const mutation = useAdminMutations().assign;

  const assignableInspections = useMemo(
    () => inspections.data?.items.filter((item) => ASSIGNABLE_STATUSES.has(item.status)) ?? [],
    [inspections.data?.items],
  );

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

  const noInspections =
    !inspections.isLoading && !inspections.isError && assignableInspections.length === 0;

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Create assignment</DialogTitle>
            <DialogDescription>
              Select an unassigned inspection and an active technician.
            </DialogDescription>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor="assignment-inspection">Inspection</FieldLabel>
            <Select
              disabled={inspections.isLoading || noInspections}
              onValueChange={(next) => setInspectionId(next === NONE ? '' : next)}
              value={inspectionId || NONE}
            >
              <SelectTrigger className="w-full" id="assignment-inspection">
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
            <FieldError>{inspections.isError ? inspections.error.message : null}</FieldError>
            {noInspections ? (
              <FieldDescription>
                No active unassigned inspections are available.
              </FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="assignment-new-technician">Technician</FieldLabel>
            <Select
              disabled={technicians.isLoading}
              onValueChange={(next) => setTechnicianId(next === NONE ? '' : next)}
              value={technicianId || NONE}
            >
              <SelectTrigger className="w-full" id="assignment-new-technician">
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
            <FieldError>{technicians.isError ? technicians.error.message : null}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="assignment-new-reason">Assignment note</FieldLabel>
            <Textarea
              id="assignment-new-reason"
              maxLength={NOTE_LIMIT}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional operational context"
              value={reason}
            />
            {/* The old field had a maxLength and no counter, so typing simply
                stopped at 500 with nothing to say why. */}
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
            <Button disabled={!inspectionId || !technicianId || mutation.isPending} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Assigning…' : 'Create assignment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
