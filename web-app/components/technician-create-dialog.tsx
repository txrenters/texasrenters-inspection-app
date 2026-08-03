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
                Their mobile sign-in details are emailed to them automatically.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-4">
        {create.data ? (() => {
          const delivered = create.data.emailDeliveryStatus === 'SENT';
          return (
          <div className="credential-card" role="status" aria-live="polite">
            {/* The password is only the administrator's problem when the email
                did not go out. Showing it either way made relaying it by hand
                look like the expected next step, and left a live credential on
                screen for a technician who had already been sent it. */}
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
                <span>Technician</span>
                <strong>{create.data.displayName}</strong>
              </div>
              <div>
                <span>Work email</span>
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
                ? `Mobile sign-in instructions and a temporary password were emailed to ${create.data.email}. They must change it on first sign-in. Nothing needs sending by hand.`
                : 'Email delivery was unavailable, so this password was not sent. Share it through an approved private channel — it is shown only here, only once.'}
            </div>
            <DialogFooter>
              {!delivered ? (
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
              {/* Said once, here. The header used to promise the email and this
                  note still told the administrator the password was theirs to
                  pass on, which cannot both be true. */}
              <p>
                They must replace the temporary password when they first sign in. If the email
                cannot be sent, it is shown here instead — that is the only time you will see it.
              </p>
            </div>
            {create.error ? (
              <Alert variant="destructive" role="alert">
                {create.error.message}
              </Alert>
            ) : null}
            {/* DialogContent spaces its own children, but this footer sits
                inside the form and so inherits none of it — the buttons ended
                up flush against the card above them. */}
            <DialogFooter className="mt-[18px]">
              <button
                className={buttonVariants({ variant: 'secondary' })}
                type="button"
                disabled={create.isPending}
                onClick={onClose}
              >
                Cancel
              </button>
              {/* Disabled only while the request is in flight. Greying it out
                  for empty fields washed the primary action out to less weight
                  than Cancel beside it, and said nothing about what was
                  missing. Both fields are required and the email is typed, so
                  submitting an incomplete form points at the field itself. */}
              <button
                className={buttonVariants({ variant: 'primary' })}
                type="submit"
                disabled={create.isPending}
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
