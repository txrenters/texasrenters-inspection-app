'use client';

import type { AdminRoleSummary } from '@texasrenters/shared';
import { useState, type FormEvent } from 'react';

import { CheckboxCard } from '@/components/checkbox-card';
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAccessMutations, usePermissionCatalog } from '@/lib/queries';

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

  /** Whole-group select/clear. A group of eight was eight clicks before. */
  function setGroup(keys: string[], selected: boolean) {
    setPermissions((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (selected) next.add(key);
        else next.delete(key);
      }
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
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-3xl">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit role' : 'Create role'}</DialogTitle>
            <DialogDescription>
              Compose a role from any permissions below. Roles are fully custom — nothing is granted
              until you assign this role to a user.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="role-name">Role name</FieldLabel>
              <Input
                autoFocus
                id="role-name"
                maxLength={80}
                minLength={2}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Charge reviewer"
                required
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="role-description">Description (optional)</FieldLabel>
              <Input
                id="role-description"
                maxLength={280}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this role for?"
                value={description}
              />
            </Field>
          </div>

          {/* The only part that scrolls. Two dozen permissions across six groups
              otherwise grow the dialog taller than the screen, and since the
              primitive centres itself with a -50% translate it bleeds off the
              top and the bottom at once: the title above the viewport, Save
              below it, neither reachable.

              The max-height has to be an explicit length. `flex-1` only resolves
              to a height through an unbroken chain of flex parents carrying
              min-h-0; a fixed bound needs no such chain and scrolls as a plain
              grid item.

              -mx-6/px-6 cancels the dialog's own p-6 and reapplies it inside, so
              the scrollbar rides the dialog edge instead of floating in the
              padding. The scrollbar is deliberately not hidden — with a list
              this long it is the only thing announcing there is more below. */}
          <div className="-mx-6 max-h-[46vh] overflow-y-auto px-6">
            {catalog.isLoading ? (
              <div className="grid gap-2">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton className="h-14 rounded-lg" key={index} />
                ))}
              </div>
            ) : catalog.data ? (
              <div className="grid gap-5">
                {catalog.data.groups.map((group) => {
                  const keys = group.permissions.map((permission) => permission.key);
                  const selectedCount = keys.filter((key) => permissions.has(key)).length;
                  const allSelected = selectedCount === keys.length;
                  return (
                    <fieldset className="grid gap-2" key={group.group}>
                      <div className="flex items-end justify-between gap-3">
                        <legend className="grid gap-0.5">
                          <span className="text-sm font-medium">{group.group}</span>
                          <span className="text-muted-foreground text-xs">{group.description}</span>
                        </legend>
                        <Button
                          onClick={() => setGroup(keys, !allSelected)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {allSelected ? 'Clear all' : 'Select all'}
                        </Button>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {group.permissions.map((permission) => (
                          <CheckboxCard
                            checked={permissions.has(permission.key)}
                            description={permission.description}
                            key={permission.key}
                            onCheckedChange={() => toggle(permission.key)}
                            title={permission.label}
                          />
                        ))}
                      </div>
                    </fieldset>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* Outside the scroll region: the running count is the one thing you
              need while working down a long list, so it stays put. */}
          <FieldDescription aria-live="polite">
            {permissions.size} permission{permissions.size === 1 ? '' : 's'} selected
            {permissions.size === 0 ? ' — this role will grant no access.' : null}
          </FieldDescription>

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button disabled={mutation.isPending} onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={mutation.isPending || !name.trim()} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Saving…' : editing ? 'Save role' : 'Create role'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
