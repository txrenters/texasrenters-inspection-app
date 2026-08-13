'use client';

import type { AdminInspection } from '@texasrenters/shared';
import { useState, type FormEvent } from 'react';

import { RequestEvidenceDialog } from '@/components/evidence-request/RequestEvidenceDialog';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { usePermissions } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import { useAdminMutations, useEvidenceRequests } from '@/lib/queries';
// Type-only: the merge dialog is handed areas already fetched by its caller.
import type { useInspectionAreas } from '@/lib/queries';

const REVIEWABLE: ReadonlyArray<AdminInspection['status']> = [
  'TECHNICIAN_SUBMITTED',
  'PROCESSING',
  'REVIEW_REQUIRED',
  'UNDER_REVIEW',
  'TBD',
  'FOLLOW_UP_REQUIRED',
];

type WorkflowAction = 'tbd' | 'follow-up' | 'under-review' | 'reopen';

// Radix Select rejects an empty string as an item value; the "nothing selected"
// row uses a sentinel translated back to '' at the boundary.
const NONE = '__none__';

/**
 * Administrator review workflow (spec §11/§16): the current lifecycle state plus
 * the human-only transitions — finalize, mark TBD, require a follow-up, or send
 * back for review. Technician submission never finalizes; only these actions do.
 */
export function InspectionWorkflowPanel({
  inspection,
  onFinalize,
}: {
  inspection: AdminInspection;
  onFinalize: () => void;
}) {
  const permissions = usePermissions();
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [requestingEvidence, setRequestingEvidence] = useState(false);
  const canManage = permissions.has('inspections:manage');
  const canFinalize = permissions.has('inspections:finalize');
  const reviewable = REVIEWABLE.includes(inspection.status);
  const cancelled = inspection.status === 'CANCELLED';
  const completed = inspection.status === 'COMPLETED';
  // Reopening can reverse a finalization, so it rides on `inspections:finalize`
  // rather than `inspections:manage`. A cancelled inspection is closed rather
  // than finished — that one is a new inspection, not a status flip.
  const canReopen = canFinalize && (completed || reviewable);

  return (
    <Card aria-labelledby="inspection-workflow-title" className="scroll-mt-20" id="workflow">
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle id="inspection-workflow-title" tabIndex={-1}>
            Finalization &amp; follow-up
          </CardTitle>
          <CardDescription>
            Submitting is not completing - an administrator finalizes, defers, or requests a
            follow-up.
          </CardDescription>
        </div>
        <StatusBadge value={inspection.status} />
      </CardHeader>

      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="bg-muted/50 rounded-lg p-3">
            <dt className="text-muted-foreground text-xs">Technician submitted</dt>
            <dd className="mt-1 text-sm font-medium">
              {inspection.submittedAt ? formatDateTime(inspection.submittedAt) : 'Not yet submitted'}
            </dd>
          </div>
          {inspection.finalizedAt ? (
            <div className="bg-muted/50 rounded-lg p-3">
              {/* A reopened inspection keeps its finalization stamp — that is
                  what freezes the evidence behind it — so the label says which
                  of the two this is rather than implying it is still closed. */}
              <dt className="text-muted-foreground text-xs">
                {completed ? 'Finalized' : 'Last finalized'}
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {formatDateTime(inspection.finalizedAt)}
                {inspection.finalizedBy ? ` · ${inspection.finalizedBy.displayName}` : ''}
              </dd>
            </div>
          ) : null}
          {/* Shown whenever the data exists, not only in the matching status.
              Reopening deliberately preserves the follow-up and TBD
              determinations, and gating these on the status meant they vanished
              from the screen at the exact moment an admin reopened the
              inspection to act on them. */}
          {inspection.followUpRequired || inspection.followUpDueAt || inspection.followUpTasks ? (
            <div className="bg-muted/50 rounded-lg p-3 sm:col-span-2">
              <dt className="text-muted-foreground text-xs">Follow-up</dt>
              <dd className="mt-1 text-sm font-medium">
                {inspection.followUpDueAt
                  ? `Due ${formatDate(inspection.followUpDueAt)}`
                  : 'No date set'}
                {inspection.followUpTasks ? ` - ${inspection.followUpTasks}` : ''}
              </dd>
            </div>
          ) : null}
          {inspection.completionBlockedReason || inspection.tbdReason ? (
            <div className="bg-muted/50 rounded-lg p-3 sm:col-span-2">
              <dt className="text-muted-foreground text-xs">
                {inspection.status === 'TBD' ? 'Pending reason' : 'On hold'}
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {inspection.tbdReason ?? inspection.completionBlockedReason}
              </dd>
            </div>
          ) : null}
        </dl>

        {cancelled ? (
          <Alert>
            <AlertDescription>
              This inspection is cancelled and can no longer transition.
            </AlertDescription>
          </Alert>
        ) : completed ? (
          <>
            <Alert variant="success">
              <AlertDescription>
                This inspection is finalized. Reopening sends it back to the assigned technician to
                capture another area; everything already collected is kept.
              </AlertDescription>
            </Alert>
            {canReopen ? (
              <Button onClick={() => setAction('reopen')} type="button" variant="outline">
                Reopen inspection
              </Button>
            ) : null}
          </>
        ) : !reviewable ? (
          <Alert>
            <AlertDescription>
              Review actions unlock once the technician submits the inspection.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-wrap gap-2">
            {canFinalize ? (
              <Button onClick={onFinalize} type="button">
                Finalize inspection
              </Button>
            ) : null}
            {canManage ? (
              <>
                {/* Opens a targeted request rather than calling `under-review`.
                    That action only relabels the inspection - UNDER_REVIEW is
                    not in the technician's queue, so the office could record
                    that evidence was missing while nothing ever reached the
                    field. */}
                <Button
                  onClick={() => setRequestingEvidence(true)}
                  type="button"
                  variant="outline"
                >
                  Request more evidence
                </Button>
                <Button onClick={() => setAction('follow-up')} type="button" variant="outline">
                  Require follow-up
                </Button>
                <Button onClick={() => setAction('tbd')} type="button" variant="outline">
                  Mark TBD
                </Button>
              </>
            ) : null}
            {canReopen ? (
              <Button onClick={() => setAction('reopen')} type="button" variant="outline">
                Reopen inspection
              </Button>
            ) : null}
          </div>
        )}

        <OpenEvidenceRequests inspectionId={inspection.id} />
      </CardContent>

      {action ? (
        <WorkflowActionDialog
          action={action}
          inspectionId={inspection.id}
          onClose={() => setAction(null)}
        />
      ) : null}
      {requestingEvidence ? (
        <RequestEvidenceDialog
          inspectionId={inspection.id}
          onClose={() => setRequestingEvidence(false)}
        />
      ) : null}
    </Card>
  );
}

const ACTION_COPY: Record<WorkflowAction, { title: string; description: string; confirm: string }> =
  {
    tbd: {
      title: 'Mark inspection TBD',
      description:
        'Defer finalization while the outcome is undetermined (another area, management review, or an owner/tenant response).',
      confirm: 'Mark TBD',
    },
    'follow-up': {
      title: 'Require a follow-up inspection',
      description: 'Record a planned date and the tasks or areas the follow-up must cover.',
      confirm: 'Require follow-up',
    },
    'under-review': {
      title: 'Send back for review',
      description:
        'Move the inspection into administrator review and note what evidence is needed.',
      confirm: 'Move to review',
    },
    reopen: {
      title: 'Reopen inspection',
      description:
        'Returns the inspection to the assigned technician so another area can be inspected. Existing recordings, photos and findings are kept. If it was finalized, that finalization is undone.',
      confirm: 'Reopen inspection',
    },
  };

// Reopen is the one action whose reason the backend requires, because it can
// reverse a finalization. Enforced here too so the block is a disabled button
// with a visible rule rather than a 400 after the fact.
const REASON_REQUIRED: ReadonlyArray<WorkflowAction> = ['reopen'];

/**
 * What the office is still waiting on from the field.
 *
 * Shown on the workflow panel because an outstanding request is the reason an
 * inspection is back with the technician — without it the status simply reads
 * IN_PROGRESS again and the reviewer has no record of what they asked for.
 *
 * Open requests only: a resolved or withdrawn one is history, and listing it
 * here would make the panel read as though work were still outstanding.
 */
function OpenEvidenceRequests({ inspectionId }: { inspectionId: string }) {
  const requests = useEvidenceRequests(inspectionId);
  const mutations = useAdminMutations();
  const open = (requests.data ?? []).filter((request) => request.status === 'OPEN');
  if (!open.length) return null;

  return (
    <section className="space-y-2 border-t pt-4">
      <h3 className="text-sm font-semibold">
        Awaiting the technician · {open.length} request{open.length === 1 ? '' : 's'}
      </h3>
      <ul className="grid gap-2">
        {open.map((request) => (
          <li className="flex items-start justify-between gap-3 rounded-lg border p-3" key={request.id}>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{request.inspectionArea.propertyArea.name}</p>
              {/* Empty means the whole area, and saying so is clearer than an
                  absent list the reviewer has to interpret. */}
              <p className="text-muted-foreground text-xs">
                {request.checklistItemIds.length
                  ? `${request.checklistItemIds.length} checklist item${request.checklistItemIds.length === 1 ? '' : 's'}`
                  : 'Whole area'}
                {' · '}
                {formatDateTime(request.requestedAt)}
              </p>
              <p className="text-sm">{request.note}</p>
            </div>
            <Button
              disabled={mutations.cancelEvidenceRequest.isPending}
              onClick={() =>
                mutations.cancelEvidenceRequest.mutate({ requestId: request.id, inspectionId })
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Withdraw
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkflowActionDialog({
  inspectionId,
  action,
  onClose,
}: {
  inspectionId: string;
  action: WorkflowAction;
  onClose: () => void;
}) {
  const mutations = useAdminMutations();
  const [reason, setReason] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [tasks, setTasks] = useState('');
  const copy = ACTION_COPY[action];
  const mutation =
    action === 'tbd'
      ? mutations.markInspectionTbd
      : action === 'follow-up'
        ? mutations.requireInspectionFollowUp
        : action === 'reopen'
          ? mutations.reopenInspection
          : mutations.markInspectionUnderReview;
  const reasonRequired = REASON_REQUIRED.includes(action);
  const blocked = reasonRequired && reason.trim().length < 2;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    try {
      if (action === 'reopen') {
        await mutations.reopenInspection.mutateAsync({ id: inspectionId, reason: reason.trim() });
      } else if (action === 'follow-up') {
        await mutations.requireInspectionFollowUp.mutateAsync({
          id: inspectionId,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
          tasks: tasks.trim() || undefined,
          reason: reason.trim() || undefined,
        });
      } else if (action === 'tbd') {
        await mutations.markInspectionTbd.mutateAsync({
          id: inspectionId,
          reason: reason.trim() || undefined,
        });
      } else {
        await mutations.markInspectionUnderReview.mutateAsync({
          id: inspectionId,
          reason: reason.trim() || undefined,
        });
      }
      onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>

          {action === 'follow-up' ? (
            <>
              <Field>
                <FieldLabel htmlFor="workflow-due-at">Planned date (optional)</FieldLabel>
                <DatePicker id="workflow-due-at" onChange={setDueAt} value={dueAt} />
              </Field>
              <Field>
                <FieldLabel htmlFor="workflow-tasks">Tasks / areas to cover (optional)</FieldLabel>
                <Textarea
                  id="workflow-tasks"
                  onChange={(event) => setTasks(event.target.value)}
                  rows={2}
                  value={tasks}
                />
              </Field>
            </>
          ) : null}

          <Field>
            <FieldLabel htmlFor="workflow-reason">
              {reasonRequired ? 'Reason' : 'Reason (optional)'}
            </FieldLabel>
            <Textarea
              autoFocus={reasonRequired}
              id="workflow-reason"
              onChange={(event) => setReason(event.target.value)}
              required={reasonRequired}
              rows={2}
              value={reason}
            />
            {reasonRequired ? (
              <FieldDescription>Recorded in the audit trail against your name.</FieldDescription>
            ) : null}
          </Field>

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={mutation.isPending || blocked} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Saving…' : copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Exported so the area navigator in the evidence workspace can own this.
 * Merging areas is area management, and it belongs beside the area list a
 * reviewer is actually looking at rather than in a second list further down the
 * page that existed only to host this one button.
 */
export function MergeAreasDialog({
  inspectionId,
  areas,
  onClose,
}: {
  inspectionId: string;
  areas: NonNullable<ReturnType<typeof useInspectionAreas>['data']>;
  onClose: () => void;
}) {
  const mutation = useAdminMutations().mergeInspectionAreas;
  const [sourceAreaId, setSourceAreaId] = useState('');
  const [targetAreaId, setTargetAreaId] = useState('');
  const [reason, setReason] = useState('');

  const valid = sourceAreaId && targetAreaId && sourceAreaId !== targetAreaId;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    try {
      await mutation.mutateAsync({
        id: inspectionId,
        sourceAreaId,
        targetAreaId,
        reason: reason.trim() || undefined,
      });
      onClose();
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <AlertDialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <AlertDialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge duplicate areas</AlertDialogTitle>
            <AlertDialogDescription>
              The source area&apos;s videos, photos, and findings move into the target area, and the
              source area is removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <Field>
            <FieldLabel htmlFor="merge-source">Source area (merged away)</FieldLabel>
            <Select
              onValueChange={(next) => setSourceAreaId(next === NONE ? '' : next)}
              value={sourceAreaId || NONE}
            >
              <SelectTrigger className="w-full" id="merge-source">
                <SelectValue placeholder="Select an area…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Select an area…</SelectItem>
                {areas.map((area) => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.name}
                    {area.floorName ? ` · ${area.floorName}` : ''} ({area.mediaCount}v/
                    {area.photoCount}p)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="merge-target">Target area (kept)</FieldLabel>
            <Select
              onValueChange={(next) => setTargetAreaId(next === NONE ? '' : next)}
              value={targetAreaId || NONE}
            >
              <SelectTrigger className="w-full" id="merge-target">
                <SelectValue placeholder="Select an area…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Select an area…</SelectItem>
                {areas
                  .filter((area) => area.id !== sourceAreaId)
                  .map((area) => (
                    <SelectItem key={area.id} value={area.id}>
                      {area.name}
                      {area.floorName ? ` · ${area.floorName}` : ''}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="merge-reason">Reason (optional)</FieldLabel>
            <Textarea
              id="merge-reason"
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              value={reason}
            />
          </Field>

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClose} type="button">
              Cancel
            </AlertDialogCancel>
            {/* Submits the form so the source/target selection is validated;
                AlertDialogAction would close before that runs. */}
            <Button disabled={!valid || mutation.isPending} type="submit" variant="destructive">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Merging…' : 'Merge areas'}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
