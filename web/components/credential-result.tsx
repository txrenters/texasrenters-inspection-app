'use client';

import { CheckCircle2Icon, CopyIcon, InfoIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';

/**
 * What a newly provisioned account shows after creation.
 *
 * Shared by the technician and user dialogs, which had two copies of this that
 * differed only in the word "Technician"/"User" — and so could drift on the one
 * thing that matters here, which is whether the temporary password is shown.
 *
 * It is shown **only when the email failed**. Showing it either way made
 * relaying it by hand look like the expected next step, and left a live
 * credential on screen for someone who had already been sent it.
 */
export function CredentialResult({
  subjectLabel,
  displayName,
  email,
  temporaryPassword,
  delivered,
  onDone,
}: {
  subjectLabel: string;
  displayName: string;
  email: string;
  temporaryPassword: string;
  delivered: boolean;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div aria-live="polite" className="grid gap-4" role="status">
      <dl className="grid gap-3 rounded-lg border p-4">
        <div className="grid gap-1">
          <dt className="text-muted-foreground text-xs font-medium">{subjectLabel}</dt>
          <dd className="text-sm font-medium">{displayName}</dd>
        </div>
        <div className="grid gap-1">
          <dt className="text-muted-foreground text-xs font-medium">Email</dt>
          <dd className="font-mono text-sm break-all">{email}</dd>
        </div>
        {!delivered ? (
          <div className="grid gap-1">
            <dt className="text-muted-foreground text-xs font-medium">
              Temporary password · shown once
            </dt>
            <dd className="bg-muted rounded-md p-2 font-mono text-sm break-all">
              {temporaryPassword}
            </dd>
          </div>
        ) : null}
      </dl>

      <Alert variant={delivered ? 'success' : 'warning'}>
        {delivered ? <CheckCircle2Icon /> : <InfoIcon />}
        <AlertDescription>
          {delivered
            ? `Sign-in instructions and a temporary password were emailed to ${email}. They must change it on first sign-in. Nothing needs sending by hand.`
            : 'Email delivery was unavailable, so this password was not sent. Share it through an approved private channel - it is shown only here, only once.'}
        </AlertDescription>
      </Alert>

      <DialogFooter>
        {!delivered ? (
          <Button
            onClick={() => {
              void navigator.clipboard
                .writeText(temporaryPassword)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
            type="button"
            variant="outline"
          >
            <CopyIcon />
            {copied ? 'Password copied' : 'Copy temporary password'}
          </Button>
        ) : null}
        <Button onClick={onDone} type="button">
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
