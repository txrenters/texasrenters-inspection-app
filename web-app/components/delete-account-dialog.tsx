'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

import { useAccountDeletionPreflight } from '@/lib/queries';

/**
 * Confirmation for deleting a web user or a technician.
 *
 * Shared by both surfaces on purpose. The consequences are identical because
 * the accounts are the same record underneath, and two copies of this wording
 * would drift until one of them understated what deletion does.
 *
 * The dialog states consequences rather than asking for a leap of faith: the
 * count of inspections that will be handed back, or the evidence that makes
 * deletion impossible. The preflight is only fetched once the dialog opens, so
 * a page nobody is deleting from costs nothing.
 */
export function DeleteAccountDialog({
  scope,
  id,
  displayName,
  onDelete,
  isPending,
  error,
}: {
  scope: 'CONSOLE' | 'TECHNICIAN';
  id: string;
  displayName: string;
  onDelete: () => Promise<void>;
  isPending: boolean;
  error?: Error | null;
}) {
  const [open, setOpen] = useState(false);
  const preflight = useAccountDeletionPreflight(scope, id, open);
  const noun = scope === 'TECHNICIAN' ? 'technician' : 'user';

  const data = preflight.data;
  const blocked = Boolean(data && !data.canDelete);
  const ongoing = data?.releases.ongoingInspections ?? 0;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button className={buttonVariants({ variant: 'danger' })} disabled={isPending}>
          Delete
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {preflight.isLoading
              ? 'Checking what this account owns…'
              : blocked
                ? `This ${noun} cannot be deleted.`
                : `This permanently removes the ${noun} and their sign-in. It cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Named records, not a generic refusal: an administrator seeing "42
            video captures" understands why the account has to stay and what
            deactivating preserves. */}
        {blocked && data ? (
          <Alert variant="warning">
            <AlertTriangle aria-hidden className="size-4" />
            <div>
              <p className="font-semibold">Deleting would erase inspection records</p>
              <ul className="mt-2 list-disc pl-5">
                {data.blockers.map((blocker) => (
                  <li key={blocker.kind}>{blocker.label}</li>
                ))}
              </ul>
              <p className="mt-2">
                These have to stay attributed to this {noun}. Deactivate the account instead — that
                revokes access immediately and keeps the record intact.
              </p>
            </div>
          </Alert>
        ) : null}

        {/* The one consequence that is easy to miss: work already scheduled to
            this technician quietly becomes nobody's. */}
        {!blocked && ongoing > 0 ? (
          <Alert variant="warning">
            <AlertTriangle aria-hidden className="size-4" />
            <div>
              <p className="font-semibold">
                {ongoing} ongoing inspection{ongoing === 1 ? '' : 's'} will be unassigned
              </p>
              <p className="mt-1">
                {ongoing === 1 ? 'It returns' : 'They return'} to the unassigned queue and can be
                given to another technician. Nothing already captured is affected.
              </p>
            </div>
          </Alert>
        ) : null}

        {preflight.isError ? (
          <Alert variant="destructive" role="alert">
            {preflight.error.message}
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" role="alert">
            {error.message}
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel className={buttonVariants({ variant: 'secondary' })}>
            {blocked ? 'Close' : 'Cancel'}
          </AlertDialogCancel>
          {/* Withheld until the preflight answers. Enabling it while the check
              is still running would let someone confirm a deletion whose
              consequences the dialog has not yet stated. */}
          {!blocked ? (
            <AlertDialogAction
              className={buttonVariants({ variant: 'danger' })}
              disabled={isPending || preflight.isLoading || !data}
              onClick={(event) => {
                event.preventDefault();
                void onDelete().then(() => setOpen(false));
              }}
            >
              {isPending ? 'Deleting…' : `Delete ${noun}`}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
