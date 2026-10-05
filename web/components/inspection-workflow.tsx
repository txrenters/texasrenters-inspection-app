'use client';

import { layoutAreasFor, type AdminInspection } from '@texasrenters/shared';
import { useMemo, useState, type FormEvent } from 'react';

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
import { Checkbox } from '@/components/ui/checkbox';
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
import { useAdminMutations, usePropertyAreas } from '@/lib/queries';
// Type-only: the merge dialog is handed areas already fetched by its caller.
import type { useInspectionAreas } from '@/lib/queries';

// Radix Select rejects an empty string as an item value; the "nothing selected"
// row uses a sentinel translated back to '' at the boundary.
const NONE = '__none__';

/**
 * Closes an inspection the technician never submitted: the walkthrough happened
 * somewhere else, so there is nothing here to submit.
 *
 * All that is left of the "Finalization & follow-up" card (2026-10-05). The
 * office does not finalize: the technician's submission is the end of a visit,
 * and review is the office's own work afterwards, so finalize, TBD, follow-up,
 * reopen and "request more evidence" went with the card -- the last two sent
 * the job back to the technician, which marks the Jobber visit incomplete and
 * restarts their paid time. This one stays because an inspection walked in
 * another system and imported here would otherwise read "Scheduled" for ever.
 * It is offered from the page's More menu, before a submission only.
 *
 * Deliberately not a finalization: the evidence is not frozen.
 */
export function MarkCompleteDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const mutation = useAdminMutations().completeInspection;
  const [reason, setReason] = useState('');
  // Required by the backend too: the audit row is the only record of why an
  // inspection was closed without its submission.
  const blocked = reason.trim().length < 2;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    try {
      await mutation.mutateAsync({ id: inspectionId, reason: reason.trim() });
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
            <DialogTitle>Mark inspection complete</DialogTitle>
            <DialogDescription>
              For a walkthrough done outside this app, with nothing here to submit. Its evidence
              can still be reviewed afterwards.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="mark-complete-reason">Reason</FieldLabel>
            <Textarea
              autoFocus
              id="mark-complete-reason"
              onChange={(event) => setReason(event.target.value)}
              required
              rows={2}
              value={reason}
            />
            <FieldDescription>Recorded in the audit trail against your name.</FieldDescription>
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
              {mutation.isPending ? 'Saving…' : 'Mark complete'}
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
/**
 * Adds an approved area to an inspection that is already under way.
 *
 * The area list is a snapshot taken when the inspection was created, so editing
 * the property's layout does not reach it — which is exactly the surprise this
 * dialog exists to remove. It offers the property's approved areas that this
 * inspection does not already hold, and nothing else: a draft area has to be
 * approved on the property first, because adding it here would approve the
 * permanent layout as a side effect of a per-inspection decision.
 *
 * The eligible set mirrors the server's own resolution — the unit's approved
 * areas when it has any, the building-level layout otherwise — computed over
 * every approved area *before* subtracting the ones already present. Filtering
 * first would flip a fully-covered unit back to the building-level list and
 * offer areas the server then refuses.
 */
export function AddAreasDialog({
  inspectionId,
  propertyId,
  unitId,
  inspectionType,
  existingPropertyAreaIds,
  onClose,
}: {
  inspectionId: string;
  propertyId: string;
  unitId: string | null;
  inspectionType: AdminInspection['inspectionType'];
  existingPropertyAreaIds: string[];
  onClose: () => void;
}) {
  const areas = usePropertyAreas(propertyId);
  const mutation = useAdminMutations().addInspectionAreas;
  const [selected, setSelected] = useState<string[]>([]);

  const candidates = useMemo(() => {
    /**
     * The same rule the server scopes an inspection with.
     *
     * This listed every approved area, which is not the set the server will
     * accept: `layoutAreasFor` drops the ones that are not rooms -- an HVAC
     * visit's A/C unit, filters, thermostat and attic all live on the property
     * as `SYSTEM` areas -- and drops the standard template once a real floor
     * plan or an imported report has arrived.
     *
     * Missed when the create form was fixed, and it fails worse here. There the
     * ids only went up once somebody cleared a box; this dialog sends exactly
     * what was ticked, so offering an area the server refuses turns into
     * "Select only approved areas belonging to this property" on a dialog where
     * every area shown does belong to the property. One property, which has
     * four such areas beside its fifteen rooms, is where that would have been
     * met first.
     */
    const approved = layoutAreasFor(
      (areas.data ?? []).filter((area) => area.status === 'APPROVED'),
    );
    const scope = unitId
      ? approved.filter((area) => area.unitId === unitId)
      : ([] as typeof approved);
    const eligible = scope.length ? scope : approved.filter((area) => !area.unitId);
    const present = new Set(existingPropertyAreaIds);
    return eligible
      .filter((area) => !present.has(area.id))
      .sort((a, b) => a.inspectionOrder - b.inspectionOrder);
  }, [areas.data, existingPropertyAreaIds, unitId]);

  /**
   * Move-in and move-out are compared area by area against their baseline, so
   * an area added to one end has no counterpart at the other. Said before the
   * decision rather than after it — the server allows this deliberately, and
   * finding out from a report that does not line up is the outcome this avoids.
   */
  const breaksComparison = inspectionType === 'MOVE_IN' || inspectionType === 'MOVE_OUT';

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected.length) return;
    try {
      await mutation.mutateAsync({ id: inspectionId, propertyAreaIds: selected });
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
            <AlertDialogTitle>Add areas to this inspection</AlertDialogTitle>
            <AlertDialogDescription>
              The assigned technician is notified immediately, and the areas appear on their
              handset without a reload.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {breaksComparison ? (
            <Alert variant="destructive">
              <AlertDescription>
                This is a {inspectionType === 'MOVE_IN' ? 'move-in' : 'move-out'} inspection. An
                area added now has no counterpart in the inspection it is compared against, and
                will show as unmatched in the comparison.
              </AlertDescription>
            </Alert>
          ) : null}

          {areas.isPending ? (
            <p className="text-muted-foreground text-sm">Loading the property&apos;s areas…</p>
          ) : candidates.length ? (
            <div className="grid max-h-72 gap-1 overflow-y-auto">
              {candidates.map((area) => (
                <label
                  className="hover:bg-muted/50 flex items-center gap-3 rounded-md px-2 py-2 text-sm"
                  key={area.id}
                >
                  <Checkbox
                    checked={selected.includes(area.id)}
                    onCheckedChange={() => toggle(area.id)}
                  />
                  <span className="min-w-0">
                    {area.name}
                    {area.floor?.name ? (
                      <span className="text-muted-foreground"> · {area.floor.name}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Every approved area of this property is already part of this inspection. A newly
              added area is a draft until it is approved on the property, and only approved areas
              can be inspected.
            </p>
          )}

          {mutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClose} type="button">
              Cancel
            </AlertDialogCancel>
            <Button disabled={!selected.length || mutation.isPending} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              Add {selected.length || ''} {selected.length === 1 ? 'area' : 'areas'}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

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
