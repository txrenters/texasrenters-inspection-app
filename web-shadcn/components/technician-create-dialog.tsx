'use client';

import { useState, type FormEvent } from 'react';

import { CredentialResult } from '@/components/credential-result';
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
import { Spinner } from '@/components/ui/spinner';
import { useAdminMutations } from '@/lib/queries';

export function TechnicianCreateDialog({ onClose }: { onClose: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const create = useAdminMutations().createTechnician;

  async function submit(event: FormEvent) {
    event.preventDefault();
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

  const result = create.data;
  const delivered = result?.emailDeliveryStatus === 'SENT';

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : handleClose())} open>
      <DialogContent
        // Creating an account is not cancellable midway, so Escape and an
        // outside click are both blocked while the mutation is in flight.
        onEscapeKeyDown={(event) => create.isPending && event.preventDefault()}
        onPointerDownOutside={(event) => create.isPending && event.preventDefault()}
        showCloseButton={!create.isPending}
      >
        <DialogHeader>
          <DialogTitle>
            {result ? 'Technician account created' : 'Create technician account'}
          </DialogTitle>
          <DialogDescription>
            {result
              ? delivered
                ? 'Their sign-in details have been emailed to them.'
                : 'Email delivery was unavailable. Share these credentials privately.'
              : 'Their mobile sign-in details are emailed to them automatically.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <CredentialResult
            delivered={delivered}
            displayName={result.displayName}
            email={result.email}
            onDone={onClose}
            subjectLabel="Technician"
            temporaryPassword={result.temporaryPassword}
          />
        ) : (
          <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
            <Field>
              <FieldLabel htmlFor="technician-name">Full name</FieldLabel>
              <Input
                autoComplete="name"
                autoFocus
                id="technician-name"
                maxLength={120}
                minLength={2}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="e.g. Jordan Ramirez"
                required
                value={displayName}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="technician-email">Work email</FieldLabel>
              <Input
                autoComplete="email"
                id="technician-email"
                maxLength={254}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="technician@company.com"
                required
                type="email"
                value={email}
              />
              {/* Said once, here. The old dialog's header promised the email and
                  a separate note still told the administrator the password was
                  theirs to pass on, which cannot both be true. */}
              <FieldDescription>
                They must replace the temporary password when they first sign in. If the email
                cannot be sent, it is shown here instead — the only time you will see it.
              </FieldDescription>
            </Field>

            {create.error ? (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                disabled={create.isPending}
                onClick={onClose}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              {/* Disabled only while the request is in flight. Greying it out
                  for empty fields washed the primary action out to less weight
                  than Cancel beside it, and said nothing about what was
                  missing. Both fields are required and the email is typed, so
                  submitting an incomplete form points at the field itself. */}
              <Button disabled={create.isPending} type="submit">
                {create.isPending ? <Spinner /> : null}
                {create.isPending ? 'Creating…' : 'Create account'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
