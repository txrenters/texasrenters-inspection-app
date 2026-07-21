'use client';

import type { AdminAssignment } from '@texasrenters/shared';
import { useEffect, useRef, useState } from 'react';

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
  const ref = useRef<HTMLDialogElement>(null);
  const [technicianId, setTechnicianId] = useState('');
  const [reason, setReason] = useState('');
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const mutations = useAdminMutations();
  const mutation = current ? mutations.reassign : mutations.assign;

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

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
    <dialog
      ref={ref}
      className="dialog"
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby="assignment-title"
    >
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="assignment-title">{current ? 'Reassign inspection' : 'Assign inspection'}</h2>
        {current ? (
          <p>
            Currently assigned to <strong>{current.technician?.displayName}</strong>. The previous
            assignment remains in history.
          </p>
        ) : (
          <p>Select an active inspection technician.</p>
        )}
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
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!technicianId || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : current ? 'Reassign' : 'Assign'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
