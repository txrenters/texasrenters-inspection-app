'use client';

import type { AdminInspection } from '@texasrenters/shared';
import { useState, type FormEvent } from 'react';

import { StatusBadge } from '@/components/status-badge';
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
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useAdminMutations } from '@/lib/queries';

const NOTES_LIMIT = 2000;
const REASON_LIMIT = 500;

export function InspectionEditDialog({
  inspection,
  onClose,
}: {
  inspection: AdminInspection;
  onClose: () => void;
}) {
  // The first ten characters of the ISO value, which is its UTC date — the day
  // the administrator picked. Deriving it from local parts instead would show
  // the previous day west of Greenwich, since a DATE serialises to midnight UTC.
  const [scheduledAt, setScheduledAt] = useState(() => inspection.scheduledAt.slice(0, 10));
  const [priority, setPriority] = useState(inspection.priority);
  const [internalNotes, setInternalNotes] = useState(inspection.internalNotes ?? '');
  const mutation = useAdminMutations().updateInspection;

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        id: inspection.id,
        scheduledAt: new Date(scheduledAt).toISOString(),
        priority,
        internalNotes: internalNotes.trim(),
      });
      onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-xl">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Edit inspection</DialogTitle>
            <DialogDescription>
              Update operational details without changing the inspection&rsquo;s audited identity.
            </DialogDescription>
          </DialogHeader>

          <dl
            aria-label="Fixed inspection context"
            className="bg-muted/40 grid gap-3 rounded-lg border p-3 sm:grid-cols-3"
          >
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">Property</dt>
              <dd className="truncate text-sm font-medium">
                {inspection.propertywareBuilding?.name ?? 'Property snapshot'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">Scope</dt>
              <dd className="truncate text-sm font-medium">
                {inspection.propertywareUnit?.name ?? 'Entire property'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">Type</dt>
              <dd className="mt-0.5">
                <StatusBadge value={inspection.inspectionType} />
              </dd>
            </div>
          </dl>

          <Field>
            <FieldLabel htmlFor="edit-inspection-schedule">Scheduled date</FieldLabel>
            {/* Date only, matching the DATE column. The hour this used to collect
                was never used by the schedule it claims to control. */}
            <DatePicker id="edit-inspection-schedule" onChange={setScheduledAt} value={scheduledAt} />
            <FieldDescription>
              Controls when this inspection appears in the technician&rsquo;s schedule.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="edit-inspection-priority">Priority</FieldLabel>
            <Select onValueChange={setPriority} value={priority}>
              <SelectTrigger className="w-full" id="edit-inspection-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="STANDARD">Standard</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Use High only when the inspection requires operational attention.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="edit-inspection-notes">
              Technician instructions and internal notes
            </FieldLabel>
            <Textarea
              id="edit-inspection-notes"
              maxLength={NOTES_LIMIT}
              onChange={(event) => setInternalNotes(event.target.value)}
              value={internalNotes}
            />
            <FieldDescription>
              Visible to authorized operations staff and the assigned technician in the mobile app ·{' '}
              {internalNotes.length}/{NOTES_LIMIT}
            </FieldDescription>
          </Field>

          <Alert>
            <AlertDescription>
              The property, lease and type are snapshotted when the inspection is created and
              determine its approved areas and lifecycle comparison. Cancel and recreate the
              inspection if its identity is incorrect.
            </AlertDescription>
          </Alert>

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!scheduledAt || mutation.isPending} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The two "state a reason, then confirm" flows.
 *
 * Both are AlertDialogs whose action is a real submit button rather than
 * `AlertDialogAction` — that closes the dialog on click, which would skip the
 * reason validation entirely.
 */
function ReasonAlertDialog({
  title,
  description,
  label,
  cancelLabel,
  confirmLabel,
  pendingLabel,
  inputId,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  label: string;
  cancelLabel: string;
  confirmLabel: string;
  pendingLabel: string;
  inputId: string;
  pending: boolean;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');

  return (
    <AlertDialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <AlertDialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(reason.trim());
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>

          <Field>
            <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
            <Textarea
              id={inputId}
              maxLength={REASON_LIMIT}
              minLength={2}
              onChange={(event) => setReason(event.target.value)}
              required
              value={reason}
            />
            <FieldDescription>
              {reason.length}/{REASON_LIMIT} characters
            </FieldDescription>
          </Field>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClose} type="button">
              {cancelLabel}
            </AlertDialogCancel>
            <Button disabled={reason.trim().length < 2 || pending} type="submit" variant="destructive">
              {pending ? <Spinner /> : null}
              {pending ? pendingLabel : confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function InspectionCancelDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const mutation = useAdminMutations().updateInspection;
  return (
    <ReasonAlertDialog
      cancelLabel="Keep inspection"
      confirmLabel="Cancel inspection"
      description="Cancellation closes the current technician assignment but preserves its history."
      error={mutation.error}
      inputId="cancel-inspection-reason"
      label="Cancellation reason"
      onClose={onClose}
      onSubmit={async (reason) => {
        try {
          await mutation.mutateAsync({
            id: inspectionId,
            status: 'CANCELLED',
            cancellationReason: reason,
          });
          onClose();
        } catch {
          // The mutation surfaces the sanitized API error inline.
        }
      }}
      pending={mutation.isPending}
      pendingLabel="Cancelling…"
      title="Cancel inspection"
    />
  );
}

export function InspectionUnassignDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const mutation = useAdminMutations().unassign;
  return (
    <ReasonAlertDialog
      cancelLabel="Keep assignment"
      confirmLabel="Unassign technician"
      description="The assignment remains in history and the inspection becomes available for reassignment."
      error={mutation.error}
      inputId="unassign-inspection-reason"
      label="Reason"
      onClose={onClose}
      onSubmit={async (reason) => {
        try {
          await mutation.mutateAsync({ id: inspectionId, reason });
          onClose();
        } catch {
          // The mutation surfaces the sanitized API error inline.
        }
      }}
      pending={mutation.isPending}
      pendingLabel="Unassigning…"
      title="Unassign technician"
    />
  );
}
