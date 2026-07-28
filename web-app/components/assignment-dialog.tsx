'use client';

import type { AdminAssignment } from '@texasrenters/shared';
import { useState } from 'react';
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
        <div className="field">
          <label htmlFor="technician">Technician</label>
          <select
            id="technician"
            required
            value={technicianId}
            onChange={(event) => setTechnicianId(event.target.value)}
          >
            <option value="">Select technician</option>
            {technicians.data?.items
              .filter((item) => item.id !== current?.technicianId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName} · {item.workload?.current ?? 0} current
                </option>
              ))}
          </select>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="reason">Reason or note</label>
          <textarea
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={current ? 'Reason for reassignment' : 'Optional assignment note'}
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
            <button className={buttonVariants({ variant: 'primary' })} disabled={!technicianId || mutation.isPending}>
              {mutation.isPending ? 'Saving…' : current ? 'Reassign' : 'Assign'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
