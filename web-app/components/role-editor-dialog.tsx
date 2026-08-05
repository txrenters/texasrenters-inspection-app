'use client';

import { useState, type FormEvent } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import type { AdminRoleSummary } from '@texasrenters/shared';

import { usePermissionCatalog, useAccessMutations } from '@/lib/queries';

export function RoleEditorDialog({
  role,
  onClose,
}: {
  role?: AdminRoleSummary | null;
  onClose: () => void;
}) {
  const catalog = usePermissionCatalog();
  const { createRole, updateRole } = useAccessMutations();
  const editing = Boolean(role);
  const mutation = editing ? updateRole : createRole;

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<Set<string>>(new Set(role?.permissions ?? []));

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
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      {/* Bounded and column-laid, so the permission catalogue scrolls inside
          the dialog instead of growing it past the viewport. There are two
          dozen permissions across six groups; unbounded, the title scrolled off
          the top of the screen and Save was somewhere below the fold with no
          way to reach it. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit role' : 'Create role'}</DialogTitle>
            <DialogDescription>
              Compose a role from any permissions below. Roles are fully custom — nothing is
              granted until you assign this role to a user.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
          <div className="form-grid">
            <Field>
              <FieldLabel htmlFor="role-name">Role name</FieldLabel>
              <Input
                id="role-name"
                autoFocus
                required
                minLength={2}
                maxLength={80}
                placeholder="e.g. Charge reviewer"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="role-description">Description (optional)</FieldLabel>
              <Input
                id="role-description"
                maxLength={280}
                placeholder="What is this role for?"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>

          {/* The only part that scrolls. min-h-0 is load-bearing: a flex child
              defaults to min-height:auto and refuses to shrink below its
              content, so without it the list pushes the dialog open again and
              the overflow never engages. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
          {catalog.isLoading ? (
            <p className="text-[13px] text-muted-foreground">Loading permissions…</p>
          ) : catalog.data ? (
            <div className="permission-groups">
              {catalog.data.groups.map((group) => (
                <fieldset key={group.group} className="permission-group">
                  <legend>{group.group}</legend>
                  <p className="permission-group-hint">{group.description}</p>
                  <div className="permission-options">
                    {group.permissions.map((permission) => (
                      <label key={permission.key} className="permission-option">
                        <Checkbox
                          checked={permissions.has(permission.key)}
                          onCheckedChange={() => toggle(permission.key)}
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
          </div>

          {/* Outside the scroll region: the running count is the one thing you
              need while working down a long list, so it stays put. */}
          <p className="text-[13px] text-muted-foreground">{permissions.size} permission(s) selected</p>

          {mutation.error ? (
            <Alert variant="destructive" role="alert">
              {mutation.error.message}
            </Alert>
          ) : null}
          <DialogFooter>
            <button
              className={buttonVariants({ variant: 'secondary' })}
              type="button"
              disabled={mutation.isPending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className={buttonVariants({ variant: 'primary' })}
              type="submit"
              disabled={mutation.isPending || !name.trim()}
            >
              {mutation.isPending ? 'Saving…' : editing ? 'Save role' : 'Create role'}
            </button>
          </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
