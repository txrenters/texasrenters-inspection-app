'use client';

import type { AdminAreaComparison, ComparisonClassification } from '@texasrenters/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { ComparisonItemsTable } from '@/components/comparison-items-table';
import { ReportShareDialog } from '@/components/report-share-dialog';
import { PageSkeleton } from '@/components/states';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  CLASSIFICATIONS,
  CLASSIFICATION_VARIANT,
  classLabel,
} from '@/lib/comparison-classification';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
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
import { itemTotals } from '@/lib/comparison-items';
import { comparisonShareBlockers } from '@/lib/comparison-share';
import { formatDateTime, humanize } from '@/lib/format';
import { useAdminMutations, useInspectionComparison } from '@/lib/queries';


/**
 * Move-in vs move-out comparison (spec §12). The draft is machine-generated; a
 * reviewer decides every room, approves it, and can then share it with the
 * owner or tenant (the office, 2026-10-06).
 */
export function InspectionComparisonPanel({ inspectionId }: { inspectionId: string }) {
  const permissions = usePermissions();
  const comparison = useInspectionComparison(inspectionId);
  const mutations = useAdminMutations();
  const [overrideArea, setOverrideArea] = useState<AdminAreaComparison | null>(null);
  const [sharing, setSharing] = useState(false);
  // Rooms whose items are open. Unset means the default: open where the room
  // needs a decision, so the reviewer lands on the evidence for it.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const canManage = permissions.has('inspections:manage');
  const canReview = permissions.has('comparisons:review');
  const data = comparison.data;
  const totals = data ? itemTotals(data.areas) : null;
  const itemized = data?.areas.some((area) => area.items?.length) ?? false;
  const blockers = data ? comparisonShareBlockers(data) : [];
  const undecided = data?.undecidedRooms ?? 0;
  /**
   * What an approval waits for, said before it is pressed. The server refuses
   * the same, so an approval can never put a room nobody decided, or verdicts
   * drawn from evidence that has since changed, in front of an owner or tenant.
   */
  const approvalBlocker = data?.outOfDateText
    ? 'Regenerate first: the comparison is out of date.'
    : undecided
      ? `Decide the ${undecided} ${undecided === 1 ? 'room' : 'rooms'} marked Requires review first (Override).`
      : null;

  return (
    <Card aria-labelledby="inspection-comparison-title" className="scroll-mt-20" id="comparison">
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle id="inspection-comparison-title">Move-in vs move-out</CardTitle>
          <CardDescription>
            Drafted from both inspections' checklists. A reviewer decides every room and approves
            it; an approved comparison can be shared with the owner or tenant.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {/* The same verdicts as a document: both inspections side by side. */}
          {data ? (
            <Button asChild size="sm" type="button" variant="outline">
              <Link href={`/inspections/${inspectionId}/comparison-report`}>Comparison report</Link>
            </Button>
          ) : null}
          {data && permissions.has('reports:share') ? (
            <Button
              disabled={blockers.length > 0}
              onClick={() => setSharing(true)}
              size="sm"
              title={blockers[0] ?? 'Send the approved comparison to the owner or tenant'}
              type="button"
            >
              Share
            </Button>
          ) : null}
          {data ? <StatusBadge value={data.overallCondition} /> : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {comparison.isLoading ? (
          <PageSkeleton cards={1} />
        ) : comparison.isError ? (
          <ErrorState error={comparison.error} retry={() => void comparison.refetch()} />
        ) : !data ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            <p className="text-muted-foreground text-sm">
              No comparison has been generated yet. It is drafted automatically once move-out review
              is ready.
            </p>
            {canManage ? (
              <Button
                disabled={mutations.generateComparison.isPending}
                onClick={() => mutations.generateComparison.mutate({ id: inspectionId })}
                type="button"
                variant="outline"
              >
                {mutations.generateComparison.isPending ? <Spinner /> : null}
                {mutations.generateComparison.isPending ? 'Generating…' : 'Generate comparison'}
              </Button>
            ) : null}
            {mutations.generateComparison.error ? (
              <Alert variant="destructive">
                <AlertDescription>{mutations.generateComparison.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : (
          <>
            {/* Verdicts are worked out when the comparison is generated; this
                says when the evidence under them has moved since. */}
            {data.outOfDateText ? (
              <Alert variant="warning">
                <AlertDescription>
                  Out of date. {data.outOfDateText}{' '}
                  {canManage ? 'Regenerate it to compare the evidence as it is now.' : ''}
                </AlertDescription>
              </Alert>
            ) : null}
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-muted/50 rounded-lg p-3">
                <dt className="text-muted-foreground text-xs">Status</dt>
                <dd className="mt-1">
                  <StatusBadge value={data.status} />
                </dd>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <dt className="text-muted-foreground text-xs">Generated</dt>
                <dd className="mt-1 text-sm font-medium">
                  {formatDateTime(data.generatedAt)} · v{data.version}
                </dd>
              </div>
              {data.requiresReviewCount > 0 ? (
                <div className="bg-muted/50 rounded-lg p-3">
                  <dt className="text-muted-foreground text-xs">Needs review</dt>
                  <dd className="text-warning mt-1 text-sm font-medium">
                    {data.requiresReviewCount} area{data.requiresReviewCount === 1 ? '' : 's'}
                  </dd>
                </div>
              ) : null}
              {itemized && totals ? (
                <div className="bg-muted/50 rounded-lg p-3">
                  <dt className="text-muted-foreground text-xs">Item by item</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {totals.fresh} new since move-in
                    {totals.fresh ? ` (${totals.freshRooms} room${totals.freshRooms === 1 ? '' : 's'})` : ''}
                  </dd>
                  <dd className="text-muted-foreground text-xs">
                    {totals.existing} already at move-in · {totals.cleaning} need cleaning
                    {totals.unknown ? ` · ${totals.unknown} not graded at move-in` : ''}
                  </dd>
                </div>
              ) : null}
              {data.reviewedByName ? (
                <div className="bg-muted/50 rounded-lg p-3">
                  <dt className="text-muted-foreground text-xs">Reviewed</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {data.reviewedByName}
                    {data.reviewedAt ? ` · ${formatDateTime(data.reviewedAt)}` : ''}
                  </dd>
                </div>
              ) : null}
            </dl>

            {!itemized && data.areas.length ? (
              <p className="text-muted-foreground text-sm">
                This comparison was generated before rooms were compared item by item.
                {canManage ? ' Regenerate it to see each checklist item at move-in and move-out.' : ''}
              </p>
            ) : null}

            <ul className="divide-y rounded-lg border">
              {data.areas.map((area) => (
                <AreaComparisonRow
                  area={area}
                  canReview={canReview}
                  inspectionId={inspectionId}
                  key={area.id}
                  onOverride={() => setOverrideArea(area)}
                  onToggle={(next) => setOpened((current) => ({ ...current, [area.id]: next }))}
                  open={opened[area.id] ?? (area.requiresReview && (area.items?.length ?? 0) > 0)}
                />
              ))}
            </ul>

            <div className="flex flex-wrap gap-2">
              {canReview && (data.status === 'DRAFT' || data.status === 'UNDER_REVIEW') ? (
                <>
                  <Button
                    disabled={mutations.reviewComparison.isPending || Boolean(approvalBlocker)}
                    onClick={() =>
                      mutations.reviewComparison.mutate({
                        inspectionId,
                        comparisonId: data.id,
                        decision: 'APPROVED',
                      })
                    }
                    type="button"
                  >
                    Approve comparison
                  </Button>
                  <Button
                    disabled={mutations.reviewComparison.isPending}
                    onClick={() =>
                      mutations.reviewComparison.mutate({
                        inspectionId,
                        comparisonId: data.id,
                        decision: 'REJECTED',
                      })
                    }
                    type="button"
                    variant="outline"
                  >
                    Reject
                  </Button>
                  {approvalBlocker ? (
                    <p className="text-muted-foreground self-center text-xs">{approvalBlocker}</p>
                  ) : null}
                </>
              ) : null}
              {/*
                Offered on an approved comparison too. The approval is the
                reviewer's to supersede: regenerating returns the record to
                draft and clears the reviewer, so nothing inherits a decision
                nobody made about it. Only the automatic trigger is refused.
              */}
              {canManage ? (
                <Button
                  disabled={mutations.generateComparison.isPending}
                  onClick={() => mutations.generateComparison.mutate({ id: inspectionId })}
                  type="button"
                  variant="outline"
                >
                  {mutations.generateComparison.isPending ? <Spinner /> : null}
                  {mutations.generateComparison.isPending ? 'Regenerating…' : 'Regenerate'}
                </Button>
              ) : null}
            </div>

            {mutations.reviewComparison.error ? (
              <Alert variant="destructive">
                <AlertDescription>{mutations.reviewComparison.error.message}</AlertDescription>
              </Alert>
            ) : null}
            {/* Regenerating could fail with nothing on screen to say so. */}
            {mutations.generateComparison.error ? (
              <Alert variant="destructive">
                <AlertDescription>{mutations.generateComparison.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </>
        )}
      </CardContent>

      {overrideArea ? (
        <OverrideAreaDialog
          approved={data?.status === 'APPROVED'}
          area={overrideArea}
          inspectionId={inspectionId}
          onClose={() => setOverrideArea(null)}
        />
      ) : null}
      {sharing ? (
        <ReportShareDialog inspectionId={inspectionId} kind="COMPARISON" onClose={() => setSharing(false)} />
      ) : null}
    </Card>
  );
}

/**
 * One room's verdict, and under it the room's checklist item by item.
 *
 * The verdict alone was the whole row once, and on Flower Gate it read
 * "uncertain" for thirteen rooms of fifteen. The items are what a reviewer
 * decides from, so a room that needs a decision opens on them.
 */
function AreaComparisonRow({
  area,
  inspectionId,
  canReview,
  open,
  onToggle,
  onOverride,
}: {
  area: AdminAreaComparison;
  inspectionId: string;
  canReview: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  onOverride: () => void;
}) {
  const items = area.items ?? [];
  return (
    <li className="grid gap-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {area.areaName}
            {area.floorName ? (
              <span className="text-muted-foreground font-normal"> · {area.floorName}</span>
            ) : null}
          </p>
          {area.summary ? <p className="text-muted-foreground text-sm">{area.summary}</p> : null}
          {area.originalClassification && area.originalClassification !== area.classification ? (
            <p className="text-muted-foreground text-xs">
              Overridden from {classLabel(area.originalClassification)}
              {area.overrideReason ? ` - ${area.overrideReason}` : ''}
            </p>
          ) : null}
          {/* About unreviewed AI output, so on screen only: never on the report. */}
          {area.aiNote ? <p className="text-warning text-xs">{area.aiNote}</p> : null}
          <p className="text-muted-foreground text-xs">
            {humanize(area.matchMethod).toLowerCase()}
            {area.matchConfidence ? ` · ${Math.round(area.matchConfidence * 100)}%` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge variant={CLASSIFICATION_VARIANT[area.classification] ?? 'secondary'}>
            {classLabel(area.classification)}
          </Badge>
          {area.requiresReview ? <Badge variant="warning">Review</Badge> : null}
          {canReview ? (
            <Button onClick={onOverride} size="sm" type="button" variant="ghost">
              Override
            </Button>
          ) : null}
        </div>
      </div>

      {items.length || area.moveOutAreaId ? (
        <div className="flex flex-wrap items-center gap-2">
          {items.length ? (
            <Button
              aria-expanded={open}
              onClick={() => onToggle(!open)}
              size="sm"
              type="button"
              variant="outline"
            >
              {open ? 'Hide items' : `Show ${items.length} items`}
            </Button>
          ) : null}
          {area.moveOutAreaId ? (
            <Button asChild size="sm" type="button" variant="ghost">
              <Link href={`/inspections/${inspectionId}?area=${area.moveOutAreaId}`}>
                Open the room&apos;s evidence
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      {open && items.length ? (
        <ComparisonItemsTable items={items} otherFindings={area.otherFindings ?? []} />
      ) : null}
    </li>
  );
}

function OverrideAreaDialog({
  inspectionId,
  area,
  approved,
  onClose,
}: {
  inspectionId: string;
  area: AdminAreaComparison;
  /** Overriding an approved comparison sends it back for approval. */
  approved: boolean;
  onClose: () => void;
}) {
  const mutation = useAdminMutations().overrideAreaComparison;
  const [classification, setClassification] = useState<ComparisonClassification>(
    area.classification,
  );
  const [reason, setReason] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        inspectionId,
        areaComparisonId: area.id,
        classification,
        reason: reason.trim() || undefined,
      });
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
            <DialogTitle>Override classification</DialogTitle>
            <DialogDescription>
              {area.areaName} - currently {classLabel(area.classification)}.
              {approved
                ? ' The comparison is approved: changing a room sends it back for approval, and its share links say “being updated” until then.'
                : ''}
            </DialogDescription>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor="override-classification">Classification</FieldLabel>
            <Select
              onValueChange={(next) => setClassification(next as ComparisonClassification)}
              value={classification}
            >
              <SelectTrigger className="w-full" id="override-classification">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLASSIFICATIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="override-reason">Reason, printed on the report</FieldLabel>
            {/* Printed beside the verdict it changes, where the owner or
                tenant reads it -- so it is required, and worth writing for
                them: "The move-in photographs show the same marks." */}
            <Textarea
              id="override-reason"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              required
              rows={3}
              value={reason}
            />
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
            <Button disabled={mutation.isPending || !reason.trim()} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Saving…' : 'Save override'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
