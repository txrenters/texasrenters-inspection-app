'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';

import type { DeletableInspection } from '@/components/inspection-delete-dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAdminMutations } from '@/lib/queries';

/** Typed to confirm. Short enough to type, specific enough not to be reflex. */
const CONFIRM_WORD = 'DELETE';

/**
 * Permanent deletion of several inspections at once.
 *
 * Separate from the single-inspection dialog rather than a mode of it, because
 * the two ask different questions. That one asks *which* inspection, and has
 * you copy the property name to prove you read it. Here the whole point is that
 * you already picked the set, so the risk is not misidentifying one row — it is
 * not appreciating how many rows there are. The count leads, the list is shown,
 * and the confirmation word is fixed.
 *
 * The server erases each inspection in its own transaction, so a batch can
 * genuinely half-succeed. This reports that outcome instead of a bare success,
 * and keeps the failures on screen with their reasons.
 */
export function InspectionBulkDeleteDialog({
  inspections,
  onClose,
  onDeleted,
}: {
  inspections: DeletableInspection[];
  onClose: () => void;
  /** Given the ids that actually went, so the page can drop them from selection. */
  onDeleted: (ids: string[]) => void;
}) {
  const mutation = useAdminMutations().deleteInspections;
  const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState<{
    deleted: string[];
    failed: { id: string; message: string }[];
  } | null>(null);

  const matches = confirmation.trim().toUpperCase() === CONFIRM_WORD;
  const finalizedCount = inspections.filter((item) => item.finalized).length;
  const nameOf = (id: string) => inspections.find((item) => item.id === id)?.name ?? id;

  async function remove() {
    try {
      const outcome = await mutation.mutateAsync(inspections.map((item) => item.id));
      onDeleted(outcome.deleted);
      // Held rather than closed on success: a partial failure is the whole
      // reason this endpoint reports per-id, and closing would discard it.
      if (outcome.failed.length) setResult(outcome);
      else onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  if (result)
    return (
      <AlertDialog onOpenChange={(next) => (next ? undefined : onClose())} open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Some inspections could not be deleted</AlertDialogTitle>
            <AlertDialogDescription>
              {result.deleted.length} of {inspections.length} were erased. The rest are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{result.failed.length} failed</AlertTitle>
            <AlertDescription>
              <ul className="grid gap-1">
                {result.failed.map((failure) => (
                  <li key={failure.id}>
                    <span className="font-medium">{nameOf(failure.id)}</span> - {failure.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>

          <AlertDialogFooter>
            <Button onClick={onClose} type="button">
              Close
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

  return (
    <AlertDialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {inspections.length} inspection{inspections.length === 1 ? '' : 's'} permanently?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Every recording, photo, finding and charge on {inspections.length === 1 ? 'it' : 'them'}{' '}
            is erased, including the video files themselves.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>This cannot be undone</AlertTitle>
          <AlertDescription>
            Shared report links stop working immediately. An audit entry naming you survives each
            deletion; nothing else does.
          </AlertDescription>
        </Alert>

        {/* Finalized inspections are deletable on purpose, but a sweep that
            quietly includes closed reports is the mistake worth catching. */}
        {finalizedCount ? (
          <Alert variant="warning">
            <AlertDescription>
              {finalizedCount} of these {finalizedCount === 1 ? 'was' : 'were'} already finalized.
              Their reports may have been shared with an owner or tenant.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="max-h-48 overflow-y-auto rounded-lg border">
          <ul className="divide-y">
            {inspections.map((item) => (
              <li className="flex items-center justify-between gap-2 p-2 text-sm" key={item.id}>
                <span className="min-w-0 truncate">
                  {item.name}
                  {item.unitName ? (
                    <span className="text-muted-foreground"> · {item.unitName}</span>
                  ) : null}
                </span>
                {item.finalized ? <Badge variant="warning">Finalized</Badge> : null}
              </li>
            ))}
          </ul>
        </div>

        <Field>
          <FieldLabel htmlFor="bulk-delete-confirmation">
            Type <span className="text-foreground font-semibold">{CONFIRM_WORD}</span> to confirm
          </FieldLabel>
          <Input
            autoComplete="off"
            id="bulk-delete-confirmation"
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={CONFIRM_WORD}
            value={confirmation}
          />
          <FieldDescription>Case does not matter.</FieldDescription>
        </Field>

        {mutation.error ? (
          <Alert variant="destructive">
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending} onClick={onClose}>
            Keep {inspections.length === 1 ? 'it' : 'them'}
          </AlertDialogCancel>
          <Button
            disabled={!matches || mutation.isPending}
            onClick={() => void remove()}
            type="button"
            variant="destructive"
          >
            {mutation.isPending ? <Spinner /> : null}
            {mutation.isPending
              ? 'Deleting…'
              : `Delete ${inspections.length} permanently`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

