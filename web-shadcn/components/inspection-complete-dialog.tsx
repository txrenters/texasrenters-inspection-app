'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useAdminMutations } from '@/lib/queries';

/**
 * Finalization — the one action that closes an inspection.
 *
 * This is all that survives of `web-app`'s `inspection-review.tsx`. That file
 * also exported `InspectionMediaSection`, `InspectionPhotosSection`,
 * `InspectionSummariesSection` and `InspectionFindingsSection` — four page-wide,
 * media-type-first panels that `AreaEvidenceWorkspace` replaced. Nothing has
 * imported them since; they were ~430 lines of dead code and are not carried
 * over.
 */
export function InspectionCompleteDialog({
  inspectionId,
  pendingFindings,
  onClose,
}: {
  inspectionId: string;
  pendingFindings: number;
  onClose: () => void;
}) {
  const mutation = useAdminMutations().finalizeInspection;
  const [overrideReason, setOverrideReason] = useState('');
  // Finalization is a human-only decision (spec §11). Unresolved required review
  // items block it unless the administrator documents an override.
  const needsOverride = pendingFindings > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        id: inspectionId,
        overrideReason: overrideReason.trim() || undefined,
      });
      onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <AlertDialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <AlertDialogContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize inspection</AlertDialogTitle>
            <AlertDialogDescription>
              Finalizing completes this inspection. It can no longer be edited, assigned, or
              cancelled afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {needsOverride ? (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertDescription>
                {pendingFindings} AI finding{pendingFindings === 1 ? '' : 's'} still await human
                review. Resolve them, or document an override reason to finalize anyway.
              </AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="finalize-override-reason">
              Override reason{needsOverride ? '' : ' (optional)'}
            </FieldLabel>
            <Textarea
              autoFocus={needsOverride}
              id="finalize-override-reason"
              onChange={(event) => setOverrideReason(event.target.value)}
              placeholder={
                needsOverride
                  ? 'Required — explain why the inspection is being finalized with items outstanding'
                  : 'Only needed to finalize while items are still outstanding'
              }
              rows={2}
              value={overrideReason}
            />
          </Field>

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClose} type="button">
              Keep open
            </AlertDialogCancel>
            {/* Form submit, not AlertDialogAction: finalizing with outstanding
                findings requires a documented override, and Action would close
                before that validation ran. */}
            <Button
              disabled={mutation.isPending || (needsOverride && !overrideReason.trim())}
              type="submit"
            >
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Finalizing…' : 'Finalize inspection'}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
