'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { AdminRoleSummary } from '@texasrenters/shared';

import { usePermissionCatalog, useAccessMutations } from '@/lib/queries';

export function RoleEditorDialog({
  role,
  onClose,
}: {
  role?: AdminRoleSummary | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const catalog = usePermissionCatalog();
  const { createRole, updateRole } = useAccessMutations();
  const editing = Boolean(role);
  const mutation = editing ? updateRole : createRole;

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<Set<string>>(new Set(role?.permissions ?? []));

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);

  function toggle(key: string) {
    setPermissions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      permissions: [...permissions],
    };
    try {
      if (role) await updateRole.mutateAsync({ id: role.id, ...payload });
      else await createRole.mutateAsync(payload);
      onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="role-editor-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <div>
            <span className="dialog-eyebrow">Access control</span>
            <h2 id="role-editor-title">{editing ? 'Edit role' : 'Create role'}</h2>
            <p>
              Compose a role from any permissions below. Roles are fully custom — nothing is granted
              until you assign this role to a user.
            </p>
          </div>
        </div>
        <div className="dialog-content">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="role-name">Role name</label>
              <input
                id="role-name"
                autoFocus
                required
                minLength={2}
                maxLength={80}
                placeholder="e.g. Charge reviewer"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="role-description">Description (optional)</label>
              <input
                id="role-description"
                maxLength={280}
                placeholder="What is this role for?"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>

          {catalog.isLoading ? (
            <p className="media-meta">Loading permissions…</p>
          ) : catalog.data ? (
            <div className="permission-groups">
              {catalog.data.groups.map((group) => (
                <fieldset key={group.group} className="permission-group">
                  <legend>{group.group}</legend>
                  <p className="permission-group-hint">{group.description}</p>
                  <div className="permission-options">
                    {group.permissions.map((permission) => (
                      <label key={permission.key} className="permission-option">
                        <input
                          type="checkbox"
                          checked={permissions.has(permission.key)}
                          onChange={() => toggle(permission.key)}
                        />
                        <span>
                          <strong>{permission.label}</strong>
                          <small>{permission.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          ) : null}

          <p className="media-meta">{permissions.size} permission(s) selected</p>

          {mutation.error ? (
            <div className="alert alert-danger" role="alert">
              {mutation.error.message}
            </div>
          ) : null}
          <div className="form-actions dialog-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={mutation.isPending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              type="submit"
              disabled={mutation.isPending || !name.trim()}
            >
              {mutation.isPending ? 'Saving…' : editing ? 'Save role' : 'Create role'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
