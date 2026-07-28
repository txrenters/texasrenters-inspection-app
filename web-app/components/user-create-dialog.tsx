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

import { useAccessMutations, useRoles } from '@/lib/queries';

export function UserCreateDialog({ onClose }: { onClose: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const create = useAccessMutations().createUser;
  const roles = useRoles({ page: 1, pageSize: 100 });

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
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>
            Provision a web account with a one-time temporary password. Access is defined entirely
            by the roles you assign.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
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
            <DialogFooter>
              <button
                className={buttonVariants({ variant: 'secondary' })}
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
              <button className={buttonVariants({ variant: 'primary' })} type="button" onClick={onClose}>
                Done
              </button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <div className="form-grid">
              <Field>
                <FieldLabel htmlFor="user-name">Full name</FieldLabel>
                <Input
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
              </Field>
              <Field>
                <FieldLabel htmlFor="user-email">Work email</FieldLabel>
                <Input
                  id="user-email"
                  required
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  placeholder="user@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
            </div>

            <fieldset className="permission-group">
              <legend>Roles</legend>
              <p className="permission-group-hint">
                Select at least one administrator-defined role. The account receives only the
                permissions granted by the selected roles.
              </p>
              {roles.isLoading ? (
                <p className="text-[13px] text-muted-foreground">Loading roles…</p>
              ) : roles.data?.items.length ? (
                <div className="permission-options">
                  {roles.data.items.map((role) => (
                    <label key={role.id} className="permission-option">
                      <Checkbox
                        checked={roleIds.has(role.id)}
                        onCheckedChange={() => toggle(roleIds, setRoleIds, role.id)}
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
                <p className="text-[13px] text-muted-foreground">
                  No roles exist yet. Create a role before provisioning a user.
                </p>
              )}
            </fieldset>

            {create.error ? (
              <Alert variant="destructive" role="alert">
                {create.error.message}
              </Alert>
            ) : null}
            <DialogFooter>
              <button
                className={buttonVariants({ variant: 'secondary' })}
                type="button"
                disabled={create.isPending}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className={buttonVariants({ variant: 'primary' })}
                type="submit"
                disabled={
                  create.isPending || !displayName.trim() || !email.trim() || roleIds.size === 0
                }
              >
                {create.isPending ? 'Creating…' : 'Create user'}
              </button>
            </DialogFooter>
          </form>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
