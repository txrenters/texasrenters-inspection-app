'use client';

import type { AdminInspection } from '@texasrenters/shared';
import { useEffect, useRef, useState } from 'react';

import { useAdminMutations } from '@/lib/queries';

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
  const ref = useRef<HTMLDialogElement>(null);
  const [scheduledAt, setScheduledAt] = useState(() => localDateTime(inspection.scheduledAt));
  const [priority, setPriority] = useState(inspection.priority);
  const [internalNotes, setInternalNotes] = useState(inspection.internalNotes ?? '');
  const mutation = useAdminMutations().updateInspection;

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

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
    <dialog ref={ref} className="dialog" onCancel={onClose} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <h2>Edit inspection</h2>
        <div className="field">
          <label htmlFor="edit-inspection-schedule">Scheduled date and time</label>
          <input
            id="edit-inspection-schedule"
            type="datetime-local"
            required
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="edit-inspection-priority">Priority</label>
          <select
            id="edit-inspection-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            <option value="STANDARD">Standard</option>
            <option value="HIGH">High</option>
          </select>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="edit-inspection-notes">Internal notes</label>
          <textarea
            id="edit-inspection-notes"
            value={internalNotes}
            maxLength={2000}
            onChange={(event) => setInternalNotes(event.target.value)}
          />
        </div>
        {mutation.error ? <p className="field-error">{mutation.error.message}</p> : null}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!scheduledAt || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function InspectionCancelDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const mutation = useAdminMutations().updateInspection;

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

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
    <dialog ref={ref} className="dialog" onCancel={onClose} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <h2>Cancel inspection</h2>
        <p>Cancellation closes the current technician assignment but preserves its history.</p>
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
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep inspection
          </button>
          <button
            className="button button-primary"
            disabled={reason.trim().length < 2 || mutation.isPending}
          >
            {mutation.isPending ? 'Cancelling…' : 'Cancel inspection'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function InspectionUnassignDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const mutation = useAdminMutations().unassign;

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({ id: inspectionId, reason: reason.trim() });
    onClose();
  }

  return (
    <dialog ref={ref} className="dialog" onCancel={onClose} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <h2>Unassign technician</h2>
        <p>
          The assignment remains in history and the inspection becomes available for reassignment.
        </p>
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
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep assignment
          </button>
          <button
            className="button button-primary"
            disabled={reason.trim().length < 2 || mutation.isPending}
          >
            {mutation.isPending ? 'Unassigning…' : 'Unassign technician'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
