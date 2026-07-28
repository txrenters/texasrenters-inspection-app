'use client';

import type { AdminAreaComparison, ComparisonClassification } from '@texasrenters/shared';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { Badge, ErrorState, LoadingState, formatDate } from '@/components/shared';
import { usePermissions } from '@/lib/auth';
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
  return CLASSIFICATIONS.find((c) => c.value === value)?.label ?? value.replaceAll('_', ' ');
}

/**
 * Move-in vs move-out comparison (spec §12). The draft is machine-generated;
 * a reviewer approves/rejects it and can override any area classification.
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
    <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section
        className="inspection-comparison-panel"
        aria-labelledby="inspection-comparison-title"
      >
      <CardHeader className="p-0 pb-4">
        <div>
          <span className="section-kicker">Move-in comparison</span>
          <CardTitle id="inspection-comparison-title" className="text-[17px]">
            Move-in vs move-out
          </CardTitle>
          <CardDescription>
            Deterministic draft comparing this move-out against the move-in baseline. A reviewer
            approves it.
          </CardDescription>
        </div>
        {data ? <Badge value={data.overallCondition} /> : null}
      </CardHeader>

      {comparison.isLoading ? (
        <LoadingState label="Loading comparison…" />
      ) : comparison.isError ? (
        <ErrorState error={comparison.error} retry={() => void comparison.refetch()} />
      ) : !data ? (
        <div className="comparison-empty">
          <p className="text-xs leading-relaxed text-muted-foreground">
            No comparison has been generated yet. It is drafted automatically once move-out review
            is ready.
          </p>
          {canManage ? (
            <button
              type="button"
              className={buttonVariants({ variant: 'secondary' })}
              disabled={mutations.generateComparison.isPending}
              onClick={() => mutations.generateComparison.mutate({ id: inspectionId })}
            >
              {mutations.generateComparison.isPending ? 'Generating…' : 'Generate comparison'}
            </button>
          ) : null}
          {mutations.generateComparison.error ? (
            <p className="field-error">{mutations.generateComparison.error.message}</p>
          ) : null}
        </div>
      ) : (
        <>
          <dl className="workflow-facts">
            <div className="workflow-fact">
              <dt>Status</dt>
              <dd>
                <Badge value={data.status} />
              </dd>
            </div>
            <div className="workflow-fact">
              <dt>Generated</dt>
              <dd>
                {formatDate(data.generatedAt)} · v{data.version} · {data.generator.toLowerCase()}
              </dd>
            </div>
            {data.requiresReviewCount > 0 ? (
              <div className="workflow-fact">
                <dt>Needs review</dt>
                <dd>
                  {data.requiresReviewCount} area{data.requiresReviewCount === 1 ? '' : 's'}
                </dd>
              </div>
            ) : null}
            {data.reviewedByName ? (
              <div className="workflow-fact">
                <dt>Reviewed</dt>
                <dd>
                  {data.reviewedByName}
                  {data.reviewedAt ? ` · ${formatDate(data.reviewedAt)}` : ''}
                </dd>
              </div>
            ) : null}
          </dl>

          <ul className="comparison-area-list">
            {data.areas.map((area) => (
              <li key={area.id} className="comparison-area-item">
                <div className="comparison-area-main">
                  <strong>{area.areaName}</strong>
                  {area.floorName ? <span className="area-meta"> · {area.floorName}</span> : null}
                  {area.summary ? <p className="comparison-area-summary">{area.summary}</p> : null}
                  {area.originalClassification &&
                  area.originalClassification !== area.classification ? (
                    <p className="area-meta">
                      Overridden from {classLabel(area.originalClassification)}
                      {area.overrideReason ? ` — ${area.overrideReason}` : ''}
                    </p>
                  ) : null}
                </div>
                <div className="comparison-area-meta">
                  <span
                    className={`comparison-chip comparison-chip--${area.classification.toLowerCase()}`}
                  >
                    {classLabel(area.classification)}
                  </span>
                  {area.requiresReview ? (
                    <span className="comparison-chip comparison-chip--flag">Review</span>
                  ) : null}
                  <span className="area-meta">
                    {area.matchMethod.replaceAll('_', ' ').toLowerCase()}
                    {area.matchConfidence
                      ? ` · ${Math.round(area.matchConfidence * 100)}%`
                      : ''}
                  </span>
                  {canReview ? (
                    <button
                      type="button"
                      className={cn(buttonVariants({ variant: 'secondary' }), 'comparison-override-button')}
                      onClick={() => setOverrideArea(area)}
                    >
                      Override
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <div className="comparison-actions">
            {canReview && (data.status === 'DRAFT' || data.status === 'UNDER_REVIEW') ? (
              <>
                <button
                  type="button"
                  className={buttonVariants({ variant: 'primary' })}
                  disabled={mutations.reviewComparison.isPending}
                  onClick={() =>
                    mutations.reviewComparison.mutate({
                      inspectionId,
                      comparisonId: data.id,
                      decision: 'APPROVED',
                    })
                  }
                >
                  Approve comparison
                </button>
                <button
                  type="button"
                  className={buttonVariants({ variant: 'secondary' })}
                  disabled={mutations.reviewComparison.isPending}
                  onClick={() =>
                    mutations.reviewComparison.mutate({
                      inspectionId,
                      comparisonId: data.id,
                      decision: 'REJECTED',
                    })
                  }
                >
                  Reject
                </button>
              </>
            ) : null}
            {canManage && data.status !== 'APPROVED' ? (
              <button
                type="button"
                className={buttonVariants({ variant: 'secondary' })}
                disabled={mutations.generateComparison.isPending}
                onClick={() => mutations.generateComparison.mutate({ id: inspectionId })}
              >
                {mutations.generateComparison.isPending ? 'Regenerating…' : 'Regenerate'}
              </button>
            ) : null}
          </div>
          {mutations.reviewComparison.error ? (
            <p className="field-error">{mutations.reviewComparison.error.message}</p>
          ) : null}
        </>
      )}

      {overrideArea ? (
        <OverrideAreaDialog
          inspectionId={inspectionId}
          area={overrideArea}
          onClose={() => setOverrideArea(null)}
        />
      ) : null}
      </section>
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({
      inspectionId,
      areaComparisonId: area.id,
      classification,
      reason: reason.trim() || undefined,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Override classification</DialogTitle>
            <DialogDescription>
              {area.areaName} — currently {classLabel(area.classification)}.
            </DialogDescription>
          </DialogHeader>
        <label className="field">
          <span>Classification</span>
          <select
            value={classification}
            onChange={(event) => setClassification(event.target.value as ComparisonClassification)}
          >
            {CLASSIFICATIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Reason (optional)</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
        </label>
        {mutation.error ? <p className="field-error">{mutation.error.message}</p> : null}
          <DialogFooter>
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={onClose}>
              Cancel
            </button>
            <button className={buttonVariants({ variant: 'primary' })} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save override'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
