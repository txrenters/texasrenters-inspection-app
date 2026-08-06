'use client';

import type { AdminInspection } from '@texasrenters/shared';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldError } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { Badge, formatDate } from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import { useAdminMutations } from '@/lib/queries';
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

/**
 * Administrator review workflow (spec §11/§16): the current lifecycle state plus
 * the human-only transitions — finalize, mark TBD, require a follow-up, or send
 * back for review. Technician submission never finalizes; only these actions do.
 */
// Radix Select rejects an empty string as an item value; the "nothing
// selected" row uses a sentinel translated back to '' at the boundary.
const NONE = '__none__';

export function InspectionWorkflowPanel({
  inspection,
  onFinalize,
}: {
  inspection: AdminInspection;
  onFinalize: () => void;
}) {
  const permissions = usePermissions();
  const [action, setAction] = useState<WorkflowAction | null>(null);
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
      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section aria-labelledby="inspection-workflow-title">
        <CardHeader className="p-0 pb-4">
        <div>
          <span className="block text-xs font-semibold text-muted-foreground">Review workflow</span>
          <CardTitle className="text-[17px]" id="inspection-workflow-title" tabIndex={-1}>Finalization &amp; follow-up</CardTitle>
          <CardDescription>
            Submitting is not completing — an administrator finalizes, defers, or requests a
            follow-up.
          </CardDescription>
        </div>
        <Badge value={inspection.status} />
      </CardHeader>

      <dl className="workflow-facts">
        <div className="workflow-fact">
          <dt>Technician submitted</dt>
          <dd>{inspection.submittedAt ? formatDate(inspection.submittedAt) : 'Not yet submitted'}</dd>
        </div>
        {inspection.finalizedAt ? (
          <div className="workflow-fact">
            {/* A reopened inspection keeps its finalization stamp — that is
                what freezes the evidence behind it — so the label says which
                of the two this is rather than implying it is still closed. */}
            <dt>{completed ? 'Finalized' : 'Last finalized'}</dt>
            <dd>
              {formatDate(inspection.finalizedAt)}
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
          <div className="workflow-fact workflow-fact-wide">
            <dt>Follow-up</dt>
            <dd>
              {inspection.followUpDueAt
                ? `Due ${formatDate(inspection.followUpDueAt)}`
                : 'No date set'}
              {inspection.followUpTasks ? ` — ${inspection.followUpTasks}` : ''}
            </dd>
          </div>
        ) : null}
        {inspection.completionBlockedReason || inspection.tbdReason ? (
          <div className="workflow-fact workflow-fact-wide">
            <dt>{inspection.status === 'TBD' ? 'Pending reason' : 'On hold'}</dt>
            <dd>{inspection.tbdReason ?? inspection.completionBlockedReason}</dd>
          </div>
        ) : null}
      </dl>

      {cancelled ? (
        <p className="workflow-frozen">
          This inspection is cancelled and can no longer transition.
        </p>
      ) : completed ? (
        <>
          <p className="workflow-frozen">
            This inspection is finalized. Reopening sends it back to the assigned technician to
            capture another area; everything already collected is kept.
          </p>
          {canReopen ? (
            <div className="workflow-actions">
              <button
                type="button"
                className={buttonVariants({ variant: 'secondary' })}
                onClick={() => setAction('reopen')}>
                Reopen inspection
              </button>
            </div>
          ) : null}
        </>
      ) : !reviewable ? (
        <p className="workflow-frozen">
          Review actions unlock once the technician submits the inspection.
        </p>
      ) : (
        <div className="workflow-actions">
          {canFinalize ? (
            <button type="button" className={buttonVariants({ variant: 'primary' })} onClick={onFinalize}>
              Finalize inspection
            </button>
          ) : null}
          {canManage ? (
            <>
              <button
                type="button"
                className={buttonVariants({ variant: 'secondary' })}
                onClick={() => setAction('under-review')}>
                Request more evidence
              </button>
              <button
                type="button"
                className={buttonVariants({ variant: 'secondary' })}
                onClick={() => setAction('follow-up')}>
                Require follow-up
              </button>
              <button
                type="button"
                className={buttonVariants({ variant: 'secondary' })}
                onClick={() => setAction('tbd')}>
                Mark TBD
              </button>
            </>
          ) : null}
          {canReopen ? (
            <button
              type="button"
              className={buttonVariants({ variant: 'secondary' })}
              onClick={() => setAction('reopen')}>
              Reopen inspection
            </button>
          ) : null}
        </div>
      )}

      {action ? (
        <WorkflowActionDialog
          inspectionId={inspection.id}
          action={action}
          onClose={() => setAction(null)}
        />
      ) : null}
      </section>
      </Card>
  );
}

const ACTION_COPY: Record<
  WorkflowAction,
  { title: string; description: string; confirm: string }> = {
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
    description: 'Move the inspection into administrator review and note what evidence is needed.',
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
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
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
        {action === 'follow-up' ? (
          <>
            <Field asChild>
<label>
              <span>Planned date (optional)</span>
              <input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
            </label>
</Field>
            <Field asChild>
<label>
              <span>Tasks / areas to cover (optional)</span>
              <textarea value={tasks} onChange={(event) => setTasks(event.target.value)} rows={2} />
            </label>
</Field>
          </>
        ) : null}
        <Field asChild>
<label>
          <span>{reasonRequired ? 'Reason' : 'Reason (optional)'}</span>
          <textarea
            autoFocus={reasonRequired}
            onChange={(event) => setReason(event.target.value)}
            required={reasonRequired}
            rows={2}
            value={reason}
          />
          {reasonRequired ? (
            <span className="text-[13px] text-muted-foreground">
              Recorded in the audit trail against your name.
            </span>
          ) : null}
        </label>
</Field>
        {mutation.error ? <FieldError>{mutation.error.message}</FieldError> : null}
          <DialogFooter>
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={onClose}>
              Cancel
            </button>
            <button
              className={buttonVariants({ variant: 'primary' })}
              disabled={mutation.isPending || blocked}
            >
              {mutation.isPending ? 'Saving…' : copy.confirm}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Exported so the area navigator in the evidence workspace can own this.
 * Merging areas is area management, and it belongs beside the area list a
 * reviewer is actually looking at rather than in a second list further down
 * the page that existed only to host this one button.
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    await mutation.mutateAsync({
      id: inspectionId,
      sourceAreaId,
      targetAreaId,
      reason: reason.trim() || undefined,
    });
    onClose();
  }

  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogContent className="sm:max-w-lg">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>Merge duplicate areas</AlertDialogTitle>
            <AlertDialogDescription>
              The source area&apos;s videos, photos, and findings move into the target area, and
              the source area is removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
        <Field asChild>
<label>
          <span>Source area (merged away)</span>
          <Select
            onValueChange={(next) => setSourceAreaId(next === NONE ? '' : next)}
            value={sourceAreaId || NONE}>
            <SelectTrigger>
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
        </label>
</Field>
        <Field asChild>
<label>
          <span>Target area (kept)</span>
          <Select
            onValueChange={(next) => setTargetAreaId(next === NONE ? '' : next)}
            value={targetAreaId || NONE}>
            <SelectTrigger>
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
        </label>
</Field>
        <Field asChild>
<label>
          <span>Reason (optional)</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
        </label>
</Field>
        {mutation.error ? <FieldError>{mutation.error.message}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel type="button" onClick={onClose}>
              Cancel
            </AlertDialogCancel>
            {/* Submits the form so the source/target selection is validated;
                AlertDialogAction would close before that runs. */}
            <button className={buttonVariants({ variant: 'danger' })} disabled={!valid || mutation.isPending}>
              {mutation.isPending ? 'Merging…' : 'Merge areas'}
            </button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
