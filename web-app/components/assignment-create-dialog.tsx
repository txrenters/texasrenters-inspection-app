'use client';

import { useMemo, useState } from 'react';
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
        <div className="field">
          <label htmlFor="assignment-inspection">Inspection</label>
          <select
            id="assignment-inspection"
            required
            value={inspectionId}
            disabled={inspections.isLoading}
            onChange={(event) => setInspectionId(event.target.value)}
          >
            <option value="">Select inspection</option>
            {assignableInspections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.propertywareBuilding?.name ?? 'Property'}
                {item.propertywareUnit?.name ? ` · ${item.propertywareUnit.name}` : ''}
              </option>
            ))}
          </select>
          {inspections.isError ? (
            <span className="field-error">{inspections.error.message}</span>
          ) : null}
          {!inspections.isLoading && !inspections.isError && !assignableInspections.length ? (
            <small>No active unassigned inspections are available.</small>
          ) : null}
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="assignment-new-technician">Technician</label>
          <select
            id="assignment-new-technician"
            required
            value={technicianId}
            disabled={technicians.isLoading}
            onChange={(event) => setTechnicianId(event.target.value)}
          >
            <option value="">Select technician</option>
            {technicians.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName} · {item.workload?.current ?? 0} current
              </option>
            ))}
          </select>
          {technicians.isError ? (
            <span className="field-error">{technicians.error.message}</span>
          ) : null}
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="assignment-new-reason">Assignment note</label>
          <textarea
            id="assignment-new-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Optional operational context"
          />
        </div>
        {mutation.error ? (
          <p className="field-error" role="alert">
            {mutation.error.message}
          </p>
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
