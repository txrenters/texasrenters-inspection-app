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
import { usePermissions } from '@/lib/auth';
import { useAdminMutations } from '@/lib/queries';

/**
 * What the dialog needs to know, which is less than a property record.
 *
 * Typed as these three facts rather than `AdminProperty` so the list — whose
 * rows carry less than the detail response — is not the one call site that
 * cannot open it. `inspectionCount` comes from `_count.inspections`, which both
 * responses have.
 */
export interface DeletableDemoProperty {
  id: string;
  name: string;
  inspectionCount: number;
}

/**
 * Permanent deletion of a demo property.
 *
 * ── WHY THE CONFIRMATION IS CONDITIONAL ─────────────────────────────────────
 *
 * A demo property nobody has walked holds nothing: the row, an address, and
 * fifteen guessed rooms. Asking somebody to type its name to delete that is
 * friction that teaches them to type names without reading, which is the habit
 * that makes the *inspection* dialog's confirmation worthless.
 *
 * The moment it has an inspection it is a different act — recordings leave
 * Cloudflare Stream and photos leave object storage, and none of it comes back.
 * So the name is required exactly then, and the reason is on screen beside it.
 *
 * ── WHY THE BUTTON MAY REFUSE ───────────────────────────────────────────────
 *
 * Deleting the inspections needs `inspections:delete`, the key that gates hard
 * deletion everywhere else. `properties:manage` is not a way around it. Somebody
 * without it can still delete a clean demo property, and is told plainly why
 * this one is different rather than being handed a disabled button.
 */
export function DemoPropertyDeleteDialog({
  property,
  onClose,
  /**
   * Where to go once it is gone. The detail page is *about* the deleted property
   * so it has to leave; the list is not, and navigating away from it would throw
   * away the reader's filters mid-cleanup.
   */
  redirectTo,
}: {
  property: DeletableDemoProperty;
  onClose: () => void;
  redirectTo?: string;
}) {
  const router = useRouter();
  const mutation = useAdminMutations().deleteDemoProperty;
  const [confirmation, setConfirmation] = useState('');

  const { inspectionCount } = property;
  const hasInspections = inspectionCount > 0;
  const canEraseInspections = usePermissions().has('inspections:delete');
  const blocked = hasInspections && !canEraseInspections;
  const matches = confirmation.trim().toLowerCase() === property.name.trim().toLowerCase();
  const confirmed = hasInspections ? matches : true;

  async function remove() {
    try {
      await mutation.mutateAsync(property.id);
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
          <AlertDialogTitle>
            {blocked ? 'This demo property cannot be deleted yet' : 'Delete this demo property?'}
          </AlertDialogTitle>
          <AlertDialogDescription>{property.name}</AlertDialogDescription>
        </AlertDialogHeader>

        {blocked ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>
              {inspectionCount === 1
                ? 'It holds an inspection'
                : `It holds ${inspectionCount} inspections`}
            </AlertTitle>
            <AlertDescription>
              <p>
                Deleting the property would delete{' '}
                {inspectionCount === 1 ? 'that inspection' : 'those inspections'} and{' '}
                {inspectionCount === 1 ? 'its' : 'their'} recordings, which needs the{' '}
                <span className="text-foreground font-semibold">inspections:delete</span>{' '}
                permission. Ask an administrator to grant it, or delete{' '}
                {inspectionCount === 1 ? 'the inspection' : 'the inspections'} first.
              </p>
            </AlertDescription>
          </Alert>
        ) : hasInspections ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>This cannot be undone</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                <li>
                  {inspectionCount === 1
                    ? 'Its inspection is deleted'
                    : `All ${inspectionCount} of its inspections are deleted`}
                </li>
                <li>Every recording is deleted from Cloudflare Stream</li>
                <li>Every photo is deleted from object storage</li>
                <li>Any shared report link stops working immediately</li>
              </ul>
              <p>An audit entry naming you survives the deletion. Nothing else does.</p>
            </AlertDescription>
          </Alert>
        ) : (
          /* The ordinary case: a demo property nobody walked. Worth saying that
             nothing real is at stake, so the reader does not have to wonder. */
          <Alert>
            <AlertDescription>
              Nothing has been inspected here, so there are no recordings or reports to lose. The
              property and its room list are removed, and an audit entry naming you remains.
            </AlertDescription>
          </Alert>
        )}

        {hasInspections && !blocked ? (
          <Field>
            <FieldLabel htmlFor="demo-delete-confirmation">
              Type <span className="text-foreground font-semibold">{property.name}</span> to confirm
            </FieldLabel>
            <Input
              autoComplete="off"
              id="demo-delete-confirmation"
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={property.name}
              value={confirmation}
            />
            <FieldDescription>Case does not matter.</FieldDescription>
          </Field>
        ) : null}

        {mutation.error ? (
          <Alert variant="destructive">
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending} onClick={onClose}>
            {blocked ? 'Close' : 'Keep property'}
          </AlertDialogCancel>
          {/* Not AlertDialogAction: that closes on click, which would dismiss the
              dialog before the confirmation check or the request ran. */}
          {blocked ? null : (
            <Button
              disabled={!confirmed || mutation.isPending}
              onClick={() => void remove()}
              type="button"
              variant="destructive"
            >
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Deleting…' : 'Delete permanently'}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
