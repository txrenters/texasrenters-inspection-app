'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAdminMutations } from '@/lib/queries';

/**
 * Permanent deletion of an inspection.
 *
 * The one irreversible action in the product, so it is the only one that asks
 * the reader to type something. A plain "are you sure" is answered reflexively
 * after the third time — copying the property name forces a look at *which*
 * inspection is about to go, which is the mistake that actually happens when
 * several are open in tabs.
 *
 * The consequences are enumerated rather than summarised. Everything here is
 * destroyed together: video files leave Cloudflare Stream, photos leave object
 * storage, and no other screen can bring any of it back.
 */
/**
 * Deliberately not `AdminInspection`.
 *
 * A row in the inspections table carries less than the detail response — no
 * `finalizedAt`, for one — and typing this against the full record would make
 * the list the only call site that could not open it. These four facts are all
 * the dialog reads.
 */
export interface DeletableInspection {
  id: string;
  /** Property name, which is also what the reader has to type to confirm. */
  name: string;
  unitName?: string | null;
  finalized: boolean;
}

export function InspectionDeleteDialog({
  inspection,
  onClose,
  /**
   * Where to go once the record is gone. The detail page is *about* the deleted
   * inspection so it has to leave; the list is not, and navigating away from it
   * would throw away the reader's filters mid-cleanup.
   */
  redirectTo,
}: {
  inspection: DeletableInspection;
  onClose: () => void;
  redirectTo?: string;
}) {
  const router = useRouter();
  const mutation = useAdminMutations().deleteInspection;
  const [confirmation, setConfirmation] = useState('');

  const expected = inspection.name;
  const matches = confirmation.trim().toLowerCase() === expected.trim().toLowerCase();
  const finalized = inspection.finalized;

  async function remove() {
    try {
      await mutation.mutateAsync(inspection.id);
      if (redirectTo) router.replace(redirectTo);
      else onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline; the dialog stays
      // open so the reader can see why nothing happened.
    }
  }

  return (
    <AlertDialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this inspection permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            {expected}
            {inspection.unitName ? ` · ${inspection.unitName}` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>This cannot be undone</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              <li>Every recording is deleted from Cloudflare Stream</li>
              <li>Every photo is deleted from object storage</li>
              <li>Findings, charges, pet review and the comparison are erased</li>
              <li>Any shared report link stops working immediately</li>
            </ul>
            <p>
              An audit entry naming you survives the deletion. Nothing else does — to close an
              inspection reversibly, cancel it instead.
            </p>
          </AlertDescription>
        </Alert>

        {/* Finalized inspections are deletable on purpose, but the fact that
            this one *was* closed is worth saying out loud before it goes. */}
        {finalized ? (
          <Alert variant="warning">
            <AlertDescription>
              This inspection was already finalized. Its report may have been shared with an owner
              or tenant.
            </AlertDescription>
          </Alert>
        ) : null}

        <Field>
          <FieldLabel htmlFor="delete-confirmation">
            Type <span className="text-foreground font-semibold">{expected}</span> to confirm
          </FieldLabel>
          <Input
            autoComplete="off"
            id="delete-confirmation"
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={expected}
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
            Keep inspection
          </AlertDialogCancel>
          {/* Not AlertDialogAction: that closes on click, which would dismiss
              the dialog before the confirmation check or the request ran. */}
          <Button
            disabled={!matches || mutation.isPending}
            onClick={() => void remove()}
            type="button"
            variant="destructive"
          >
            {mutation.isPending ? <Spinner /> : null}
            {mutation.isPending ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
