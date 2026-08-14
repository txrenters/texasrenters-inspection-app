'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';

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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
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
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger asChild>
        <Button disabled={isPending} variant="destructive">
          Delete
        </Button>
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

        {preflight.isLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner />
            Loading what this account owns…
          </p>
        ) : null}

        {/* Named records, not a generic refusal: an administrator seeing "42
            video captures" understands why the account has to stay and what
            deactivating preserves. */}
        {blocked && data ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Deleting would erase inspection records</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {data.blockers.map((blocker) => (
                  <li key={blocker.kind}>{blocker.label}</li>
                ))}
              </ul>
              <p>
                These have to stay attributed to this {noun}. Deactivate the account instead - that
                revokes access immediately and keeps the record intact.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {/* The one consequence that is easy to miss: work already scheduled to
            this technician quietly becomes nobody's. */}
        {!blocked && ongoing > 0 ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>
              {ongoing} ongoing inspection{ongoing === 1 ? '' : 's'} will be unassigned
            </AlertTitle>
            <AlertDescription>
              {ongoing === 1 ? 'It returns' : 'They return'} to the unassigned queue and can be given
              to another technician. Nothing already captured is affected.
            </AlertDescription>
          </Alert>
        ) : null}

        {preflight.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{preflight.error.message}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>{blocked ? 'Close' : 'Cancel'}</AlertDialogCancel>
          {/* Withheld until the preflight answers. Enabling it while the check
              is still running would let someone confirm a deletion whose
              consequences the dialog has not yet stated. */}
          {!blocked ? (
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
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
