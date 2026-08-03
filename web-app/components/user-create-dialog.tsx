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
            Their sign-in details and a one-time temporary password are emailed to them
            automatically; you only need to pass anything on by hand if that email fails. Access is
            defined entirely by the roles you assign.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
        {create.data ? (() => {
          const delivered = create.data.emailDeliveryStatus === 'SENT';
          return (
          <div className="credential-card" role="status" aria-live="polite">
            {/* The password is only the administrator's problem when the email
                did not go out. Showing it either way made relaying it by hand
                look like the expected next step, and left a live credential on
                screen for someone who had already been sent it. */}
            <div className="credential-success-heading">
              <span aria-hidden>✓</span>
              <div>
                <strong>Account created</strong>
                <p>
                  {delivered
                    ? 'Their sign-in details have been emailed to them.'
                    : 'Share these credentials through an approved private channel.'}
                </p>
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
              {!delivered ? (
                <div className="credential-password">
                  <span>Temporary password · shown once</span>
                  <code>{create.data.temporaryPassword}</code>
                </div>
              ) : null}
            </div>
            <div className={`alert ${delivered ? 'alert-success' : 'alert-warning'}`}>
              {delivered
                ? `Sign-in instructions and a temporary password were emailed to ${create.data.email}. They must change it on first sign-in. Nothing needs sending by hand.`
                : 'Email delivery was unavailable, so this password was not sent. Share it through an approved private channel — it is shown only here, only once.'}
            </div>
            <DialogFooter>
              {!delivered ? (
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
              ) : null}
              <button className={buttonVariants({ variant: 'primary' })} type="button" onClick={onClose}>
                Done
              </button>
            </DialogFooter>
          </div>
          );
        })() : (
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
            {/* Inside the form, so it inherits none of DialogContent's own
                spacing and would otherwise sit flush against the fieldset. */}
            <DialogFooter className="mt-[18px]">
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
