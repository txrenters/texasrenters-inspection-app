'use client';

import { useState, type FormEvent } from 'react';
import { UserPlusIcon } from 'lucide-react';

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

import { useAdminMutations } from '@/lib/queries';

export function TechnicianCreateDialog({ onClose }: { onClose: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const create = useAdminMutations().createTechnician;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCopied(false);
    try {
      await create.mutateAsync({ displayName: displayName.trim(), email: email.trim() });
    } catch {
      // The mutation exposes the sanitized API error in the dialog.
    }
  }

  function handleClose() {
    // Never abandon an in-flight account creation.
    if (create.isPending) return;
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : handleClose())}>
      <DialogContent
        className="sm:max-w-2xl"
        // Creating an account is not cancellable midway, so Escape and an
        // outside click are both blocked while the mutation is in flight —
        // preserving the guard the native dialog's onCancel provided.
        showCloseButton={!create.isPending}
        onEscapeKeyDown={(event) => create.isPending && event.preventDefault()}
        onPointerDownOutside={(event) => create.isPending && event.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-primary" aria-hidden>
              <UserPlusIcon className="size-5" />
            </span>
            <div className="grid gap-1">
              <DialogTitle>Create technician account</DialogTitle>
              <DialogDescription>
                Generate secure mobile access with a one-time temporary password.
              </DialogDescription>
            </div>
          </div>
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
            <div
              className={`alert ${
                create.data.emailDeliveryStatus === 'SENT' ? 'alert-success' : 'alert-warning'
              }`}
            >
              {create.data.emailDeliveryStatus === 'SENT'
                ? 'The mobile sign-in instructions were emailed to this technician.'
                : 'Email delivery was unavailable. Share the temporary password through an approved private channel.'}
            </div>
            <DialogFooter>
              <button
                className={buttonVariants({ variant: 'secondary' })}
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
              <button className={buttonVariants({ variant: 'primary' })} type="button" onClick={onClose}>
                Done
              </button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <div className="form-grid">
              <Field>
                <FieldLabel htmlFor="technician-name">Full name</FieldLabel>
                <Input
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
              </Field>
              <Field>
                <FieldLabel htmlFor="technician-email">Work email</FieldLabel>
                <Input
                  id="technician-email"
                  required
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  placeholder="technician@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
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
                disabled={create.isPending || !displayName.trim() || !email.trim()}
              >
                {create.isPending ? 'Creating…' : 'Create account'}
              </button>
            </DialogFooter>
          </form>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
