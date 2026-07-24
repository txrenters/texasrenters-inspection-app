'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useAccessMutations, useRoles } from '@/lib/queries';

export function UserCreateDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const create = useAccessMutations().createUser;
  const roles = useRoles({ page: 1, pageSize: 100 });

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);

  const toggle = (set: Set<string>, apply: (next: Set<string>) => void, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCopied(false);
    try {
      await create.mutateAsync({
        displayName: displayName.trim(),
        email: email.trim(),
        roleIds: [...roleIds],
      });
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="create-user-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div>
          <span className="dialog-eyebrow">User management</span>
          <h2 id="create-user-title">Create user</h2>
          <p>
            Provision a web account with a one-time temporary password. Access is defined entirely
            by the roles you assign.
          </p>
        </div>
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
                <span>User</span>
                <strong>{create.data.displayName}</strong>
              </div>
              <div>
                <span>Email</span>
                <code>{create.data.email}</code>
              </div>
              <div className="credential-password">
                <span>Temporary password · shown once</span>
                <code>{create.data.temporaryPassword}</code>
              </div>
            </div>
            <div
              className={`alert ${
                create.data.emailDeliveryStatus === 'SENT' ? 'alert-success' : 'alert-warning'
              }`}
            >
              {create.data.emailDeliveryStatus === 'SENT'
                ? 'The sign-in instructions were emailed to this user.'
                : 'Email delivery was unavailable. Share the temporary password through an approved private channel.'}
            </div>
            <div className="form-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(create.data!.temporaryPassword)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }
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
                <label htmlFor="user-name">Full name</label>
                <input
                  id="user-name"
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
                <label htmlFor="user-email">Work email</label>
                <input
                  id="user-email"
                  required
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  placeholder="user@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            </div>

            <fieldset className="permission-group">
              <legend>Roles</legend>
              <p className="permission-group-hint">
                Select at least one administrator-defined role. The account receives only the
                permissions granted by the selected roles.
              </p>
              {roles.isLoading ? (
                <p className="media-meta">Loading roles…</p>
              ) : roles.data?.items.length ? (
                <div className="permission-options">
                  {roles.data.items.map((role) => (
                    <label key={role.id} className="permission-option">
                      <input
                        type="checkbox"
                        checked={roleIds.has(role.id)}
                        onChange={() => toggle(roleIds, setRoleIds, role.id)}
                      />
                      <span>
                        <strong>{role.name}</strong>
                        <small>
                          {role.description ?? `${role.permissions.length} permission(s)`}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="media-meta">
                  No roles exist yet. Create a role before provisioning a user.
                </p>
              )}
            </fieldset>

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
                disabled={
                  create.isPending || !displayName.trim() || !email.trim() || roleIds.size === 0
                }
              >
                {create.isPending ? 'Creating…' : 'Create user'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
