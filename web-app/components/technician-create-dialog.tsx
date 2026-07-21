'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useAdminMutations } from '@/lib/queries';

export function TechnicianCreateDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const create = useAdminMutations().createTechnician;

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCopied(false);
    try {
      await create.mutateAsync({ displayName: displayName.trim(), email: email.trim() });
    } catch {
      // The mutation exposes the sanitized API error in the dialog.
    }
  }

  function handleCancel(event: React.SyntheticEvent<HTMLDialogElement>) {
    if (create.isPending) {
      event.preventDefault();
      return;
    }
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog technician-dialog"
      aria-labelledby="create-technician-title"
      aria-describedby="create-technician-description"
      onCancel={handleCancel}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div className="dialog-heading-copy">
          <span className="dialog-icon" aria-hidden>
            <svg viewBox="0 0 24 24" role="presentation">
              <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0M19 7v6m-3-3h6" />
            </svg>
          </span>
          <div>
            <span className="dialog-eyebrow">Technician access</span>
            <h2 id="create-technician-title">Create technician account</h2>
            <p id="create-technician-description">
              Generate secure mobile access with a one-time temporary password.
            </p>
          </div>
        </div>
        <button
          className="dialog-close"
          type="button"
          aria-label="Close create technician dialog"
          disabled={create.isPending}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="dialog-content">
        {create.data ? (
          <div className="credential-card" role="status" aria-live="polite">
            <div className="credential-success-heading">
              <span aria-hidden>✓</span>
              <div>
                <strong>Account created</strong>
                <p>Share these credentials through an approved private channel.</p>
              </div>
            </div>
            <div className="credential-grid">
              <div>
                <span>Technician</span>
                <strong>{create.data.displayName}</strong>
              </div>
              <div>
                <span>Work email</span>
                <code>{create.data.email}</code>
              </div>
              <div className="credential-password">
                <span>Temporary password · shown once</span>
                <code>{create.data.temporaryPassword}</code>
              </div>
            </div>
            <div className="form-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(create.data!.temporaryPassword)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? 'Password copied' : 'Copy temporary password'}
              </button>
              <button className="button button-primary" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="technician-name">Full name</label>
                <input
                  id="technician-name"
                  autoFocus
                  required
                  minLength={2}
                  maxLength={120}
                  autoComplete="name"
                  placeholder="e.g. Jordan Ramirez"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="technician-email">Work email</label>
                <input
                  id="technician-email"
                  required
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  placeholder="technician@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            </div>
            <div className="temporary-password-note">
              <span aria-hidden>
                <svg viewBox="0 0 24 24" role="presentation">
                  <path d="M7 10V8a5 5 0 0 1 10 0v2m-11 0h12v10H6V10Z" />
                </svg>
              </span>
              <p>
                The temporary password is displayed once. The technician must replace it during
                their first mobile sign-in.
              </p>
            </div>
            {create.error ? (
              <div className="alert alert-danger" role="alert">
                {create.error.message}
              </div>
            ) : null}
            <div className="form-actions dialog-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={create.isPending}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={create.isPending || !displayName.trim() || !email.trim()}
              >
                {create.isPending ? 'Creating…' : 'Create account'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
