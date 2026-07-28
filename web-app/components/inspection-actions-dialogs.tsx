'use client';

import type { AdminInspection } from '@texasrenters/shared';
import { useState } from 'react';
import { PencilIcon } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

import { useAdminMutations } from '@/lib/queries';
import { Badge } from './shared';

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function InspectionEditDialog({
  inspection,
  onClose,
}: {
  inspection: AdminInspection;
  onClose: () => void;
}) {
  const [scheduledAt, setScheduledAt] = useState(() => localDateTime(inspection.scheduledAt));
  const [priority, setPriority] = useState(inspection.priority);
  const [internalNotes, setInternalNotes] = useState(inspection.internalNotes ?? '');
  const mutation = useAdminMutations().updateInspection;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({
      id: inspection.id,
      scheduledAt: new Date(scheduledAt).toISOString(),
      priority,
      internalNotes: internalNotes.trim(),
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-primary" aria-hidden>
                <PencilIcon className="size-5" />
              </span>
              <div className="grid gap-1">
                <DialogTitle>Edit inspection</DialogTitle>
                <DialogDescription>
                  Update operational details without changing the inspection&rsquo;s audited
                  identity.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

        <div className="inspection-edit-context" aria-label="Fixed inspection context">
          <div>
            <span>Property</span>
            <strong>{inspection.propertywareBuilding?.name ?? 'Property snapshot'}</strong>
          </div>
          <div>
            <span>Scope</span>
            <strong>{inspection.propertywareUnit?.name ?? 'Entire property'}</strong>
          </div>
          <div>
            <span>Type</span>
            <Badge value={inspection.inspectionType} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="edit-inspection-schedule">Scheduled date and time</label>
          <input
            id="edit-inspection-schedule"
            type="datetime-local"
            required
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
          <small className="field-help">
            Controls when this inspection appears in the technician’s schedule.
          </small>
        </div>
        <div className="field inspection-edit-field">
          <label htmlFor="edit-inspection-priority">Priority</label>
          <select
            id="edit-inspection-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            <option value="STANDARD">Standard</option>
            <option value="HIGH">High</option>
          </select>
          <small className="field-help">
            Use High only when the inspection requires operational attention.
          </small>
        </div>
        <div className="field inspection-edit-field">
          <div className="field-label-row">
            <label htmlFor="edit-inspection-notes">Technician instructions and internal notes</label>
            <span>{internalNotes.length}/2000</span>
          </div>
          <textarea
            id="edit-inspection-notes"
            value={internalNotes}
            maxLength={2000}
            onChange={(event) => setInternalNotes(event.target.value)}
          />
          <small className="field-help">
            Visible to authorized operations staff and the assigned technician in the mobile app.
          </small>
        </div>
        <div className="inspection-edit-guidance">
          <strong>Why can’t the property, lease, or type be changed?</strong>
          <p>
            Those values are snapshotted when the inspection is created and determine its approved
            areas and lifecycle comparison. Cancel and recreate the inspection if its identity is
            incorrect.
          </p>
        </div>
        {mutation.error ? <p className="field-error">{mutation.error.message}</p> : null}
          <DialogFooter>
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={onClose}>
              Cancel
            </button>
            <button className={buttonVariants({ variant: 'primary' })} disabled={!scheduledAt || mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function InspectionCancelDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const mutation = useAdminMutations().updateInspection;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({
      id: inspectionId,
      status: 'CANCELLED',
      cancellationReason: reason.trim(),
    });
    onClose();
  }

  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel inspection</AlertDialogTitle>
            <AlertDialogDescription>
              Cancellation closes the current technician assignment but preserves its history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="field">
            <label htmlFor="cancel-inspection-reason">Cancellation reason</label>
            <textarea
              id="cancel-inspection-reason"
              required
              minLength={2}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {mutation.error ? <p className="field-error">{mutation.error.message}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel type="button" onClick={onClose}>
              Keep inspection
            </AlertDialogCancel>
            {/* Submits the form rather than closing, so the reason is validated
                first; AlertDialogAction would close on click. */}
            <button
              className={buttonVariants({ variant: 'danger' })}
              disabled={reason.trim().length < 2 || mutation.isPending}
            >
              {mutation.isPending ? 'Cancelling…' : 'Cancel inspection'}
            </button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function InspectionUnassignDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const mutation = useAdminMutations().unassign;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({ id: inspectionId, reason: reason.trim() });
    onClose();
  }

  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>Unassign technician</AlertDialogTitle>
            <AlertDialogDescription>
              The assignment remains in history and the inspection becomes available for
              reassignment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="field">
            <label htmlFor="unassign-inspection-reason">Reason</label>
            <textarea
              id="unassign-inspection-reason"
              required
              minLength={2}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {mutation.error ? <p className="field-error">{mutation.error.message}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel type="button" onClick={onClose}>
              Keep assignment
            </AlertDialogCancel>
            <button
              className={buttonVariants({ variant: 'danger' })}
              disabled={reason.trim().length < 2 || mutation.isPending}
            >
              {mutation.isPending ? 'Unassigning…' : 'Unassign technician'}
            </button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
