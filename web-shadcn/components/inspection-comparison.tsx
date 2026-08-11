'use client';

import type { AdminAreaComparison, ComparisonClassification } from '@texasrenters/shared';
import { useState, type FormEvent } from 'react';

import { PageSkeleton } from '@/components/states';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
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
import { formatDateTime, humanize } from '@/lib/format';
import { useAdminMutations, useInspectionComparison } from '@/lib/queries';

const CLASSIFICATIONS: ReadonlyArray<{ value: ComparisonClassification; label: string }> = [
  { value: 'UNCHANGED', label: 'Unchanged' },
  { value: 'IMPROVED', label: 'Improved' },
  { value: 'NEW_DAMAGE', label: 'New damage' },
  { value: 'WORSENED', label: 'Worsened' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'MISSING_BASELINE', label: 'Missing baseline' },
  { value: 'MISSING_MOVE_OUT_EVIDENCE', label: 'Missing move-out evidence' },
  { value: 'NOT_COMPARABLE', label: 'Not comparable' },
  { value: 'REQUIRES_REVIEW', label: 'Requires review' },
];

function classLabel(value: string) {
  return CLASSIFICATIONS.find((option) => option.value === value)?.label ?? humanize(value);
}

/**
 * What each classification means for the tenancy, expressed as a tone.
 *
 * The old app carried nine `.comparison-chip--*` CSS rules for this. Grouping
 * them by consequence is the point: "new damage" and "worsened" are the two that
 * cost someone money, and they should not look like "improved".
 */
const CLASSIFICATION_VARIANT: Record<string, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  UNCHANGED: 'secondary',
  IMPROVED: 'success',
  RESOLVED: 'success',
  NEW_DAMAGE: 'destructive',
  WORSENED: 'destructive',
  MISSING_BASELINE: 'warning',
  MISSING_MOVE_OUT_EVIDENCE: 'warning',
  NOT_COMPARABLE: 'secondary',
  REQUIRES_REVIEW: 'warning',
};

/**
 * Move-in vs move-out comparison (spec §12). The draft is machine-generated; a
 * reviewer approves/rejects it and can override any area classification.
 */
export function InspectionComparisonPanel({ inspectionId }: { inspectionId: string }) {
  const permissions = usePermissions();
  const comparison = useInspectionComparison(inspectionId);
  const mutations = useAdminMutations();
  const [overrideArea, setOverrideArea] = useState<AdminAreaComparison | null>(null);
  const canManage = permissions.has('inspections:manage');
  const canReview = permissions.has('comparisons:review');
  const data = comparison.data;

  return (
    <Card aria-labelledby="inspection-comparison-title" className="scroll-mt-20" id="comparison">
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle id="inspection-comparison-title">Move-in vs move-out</CardTitle>
          <CardDescription>
            Deterministic draft comparing this move-out against the move-in baseline. A reviewer
            approves it.
          </CardDescription>
        </div>
        {data ? <StatusBadge value={data.overallCondition} /> : null}
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

            <ul className="divide-y rounded-lg border">
              {data.areas.map((area) => (
                <li
                  className="flex flex-wrap items-start justify-between gap-3 p-3"
                  key={area.id}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium">
                      {area.areaName}
                      {area.floorName ? (
                        <span className="text-muted-foreground font-normal"> · {area.floorName}</span>
                      ) : null}
                    </p>
                    {area.summary ? (
                      <p className="text-muted-foreground text-sm">{area.summary}</p>
                    ) : null}
                    {area.originalClassification &&
                    area.originalClassification !== area.classification ? (
                      <p className="text-muted-foreground text-xs">
                        Overridden from {classLabel(area.originalClassification)}
                        {area.overrideReason ? ` — ${area.overrideReason}` : ''}
                      </p>
                    ) : null}
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
                      <Button onClick={() => setOverrideArea(area)} size="sm" type="button" variant="ghost">
                        Override
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-2">
              {canReview && (data.status === 'DRAFT' || data.status === 'UNDER_REVIEW') ? (
                <>
                  <Button
                    disabled={mutations.reviewComparison.isPending}
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
                </>
              ) : null}
              {canManage && data.status !== 'APPROVED' ? (
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
          </>
        )}
      </CardContent>

      {overrideArea ? (
        <OverrideAreaDialog
          area={overrideArea}
          inspectionId={inspectionId}
          onClose={() => setOverrideArea(null)}
        />
      ) : null}
    </Card>
  );
}

function OverrideAreaDialog({
  inspectionId,
  area,
  onClose,
}: {
  inspectionId: string;
  area: AdminAreaComparison;
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
              {area.areaName} — currently {classLabel(area.classification)}.
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
            <FieldLabel htmlFor="override-reason">Reason (optional)</FieldLabel>
            <Textarea
              id="override-reason"
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

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={mutation.isPending} type="submit">
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Saving…' : 'Save override'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
