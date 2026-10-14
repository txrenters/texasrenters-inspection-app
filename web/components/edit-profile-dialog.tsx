'use client';

import { useEffect, useState, type FormEvent } from 'react';

import {
  formatPhoneNumber,
  normalizePhoneNumber,
  PHONE_NUMBER_HINT,
  type UpdateAccountProfileInput,
} from '@texasrenters/shared';

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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

export interface EditProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: { displayName: string; email: string; phone?: string | null };
  /**
   * Why the sign-in email cannot be changed from here, or null when it can.
   * The server enforces the same rules (`AccountProfileService`); this only
   * says so before anybody types.
   */
  emailLockedReason: string | null;
  /** A technician: Jobber matches its visits to them by this email. */
  matchedInJobber: boolean;
  /** Sends only the fields that changed. Resolves once saved. */
  onSave: (input: UpdateAccountProfileInput) => Promise<unknown>;
  isPending: boolean;
  error: Error | null;
}

/**
 * Name, sign-in email and phone, for the user page and the technician page --
 * one account either way.
 *
 * The email is the field that needs saying out loud. It is the address the
 * person signs in with, the one reset links go to, and (for a technician) the
 * one Jobber's visits are matched to. A change that is not made in Jobber too
 * leaves their visits importing as Unassigned, which is invisible until a day
 * goes wrong, so the warning appears the moment the address differs.
 */
export function EditProfileDialog({
  open,
  onOpenChange,
  profile,
  emailLockedReason,
  matchedInJobber,
  onSave,
  isPending,
  error,
}: EditProfileDialogProps) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone ? formatPhoneNumber(profile.phone) : '');

  // Each opening starts from what is saved, not from an abandoned edit.
  useEffect(() => {
    if (!open) return;
    setDisplayName(profile.displayName);
    setEmail(profile.email);
    setPhone(profile.phone ? formatPhoneNumber(profile.phone) : '');
  }, [open, profile.displayName, profile.email, profile.phone]);

  const typedPhone = phone.trim();
  const normalizedPhone = typedPhone ? normalizePhoneNumber(typedPhone) : null;
  const phoneInvalid = Boolean(typedPhone) && !normalizedPhone;
  const emailChanged =
    !emailLockedReason && email.trim().toLowerCase() !== profile.email.toLowerCase();

  const changes: UpdateAccountProfileInput = {};
  if (displayName.trim() !== profile.displayName) changes.displayName = displayName.trim();
  if (emailChanged) changes.email = email.trim();
  if (!phoneInvalid && normalizedPhone !== (profile.phone ?? null)) changes.phone = normalizedPhone;
  const changed = Object.keys(changes).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!changed || phoneInvalid) return;
    try {
      await onSave(changes);
      onOpenChange(false);
    } catch {
      // The page's mutation holds the sanitized API error; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>
            One account for the console and the inspection app, so a change here shows on both.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="profile-name">Full name</FieldLabel>
            <Input
              autoComplete="off"
              id="profile-name"
              maxLength={120}
              minLength={2}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              value={displayName}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="profile-email">Sign-in email</FieldLabel>
            <Input
              autoComplete="off"
              disabled={Boolean(emailLockedReason)}
              id="profile-email"
              maxLength={320}
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
            {emailLockedReason ? <FieldDescription>{emailLockedReason}</FieldDescription> : null}
          </Field>

          {emailChanged ? (
            <Alert variant="warning">
              <AlertDescription>
                <p>
                  They will sign in with the new address from now on, and any reset link already
                  sent to the old one stops working.
                </p>
                {matchedInJobber ? (
                  <p className="mt-1">
                    Jobber matches visits to technicians by email. Change it in Jobber too, or
                    their visits will import as Unassigned.
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="profile-phone">Phone (optional)</FieldLabel>
            <Input
              aria-describedby="profile-phone-hint"
              aria-invalid={phoneInvalid || undefined}
              autoComplete="off"
              id="profile-phone"
              inputMode="tel"
              maxLength={40}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(713) 555-0100"
              type="tel"
              value={phone}
            />
            {phoneInvalid ? (
              <FieldError id="profile-phone-hint">
                That is not a phone number we can read. {PHONE_NUMBER_HINT}
              </FieldError>
            ) : (
              <FieldDescription id="profile-phone-hint">{PHONE_NUMBER_HINT}</FieldDescription>
            )}
          </Field>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              disabled={isPending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={isPending || !changed || phoneInvalid} type="submit">
              {isPending ? <Spinner /> : null}
              {isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
