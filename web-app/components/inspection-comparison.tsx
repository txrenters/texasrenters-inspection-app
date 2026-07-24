'use client';

import type { AdminAreaComparison, ComparisonClassification } from '@texasrenters/shared';
import { useEffect, useRef, useState } from 'react';

import { Badge, ErrorState, LoadingState, formatDate } from '@/components/ui';
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
    <section
      className="panel inspection-comparison-panel"
      aria-labelledby="inspection-comparison-title"
    >
      <div className="panel-header">
        <div>
          <span className="section-kicker">Move-in comparison</span>
          <h2 id="inspection-comparison-title">Move-in vs move-out</h2>
          <p className="panel-description">
            Deterministic draft comparing this move-out against the move-in baseline. A reviewer
            approves it.
          </p>
        </div>
        {data ? <Badge value={data.overallCondition} /> : null}
      </div>

      {comparison.isLoading ? (
        <LoadingState label="Loading comparison…" />
      ) : comparison.isError ? (
        <ErrorState error={comparison.error} retry={() => void comparison.refetch()} />
      ) : !data ? (
        <div className="comparison-empty">
          <p className="panel-description">
            No comparison has been generated yet. It is drafted automatically once move-out review
            is ready.
          </p>
          {canManage ? (
            <button
              type="button"
              className="button button-secondary"
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
                      className="button button-secondary comparison-override-button"
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
                  className="button button-primary"
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
                  className="button button-secondary"
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
                className="button button-secondary"
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
  const ref = useRef<HTMLDialogElement>(null);
  const mutation = useAdminMutations().overrideAreaComparison;
  const [classification, setClassification] = useState<ComparisonClassification>(
    area.classification,
  );
  const [reason, setReason] = useState('');

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

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
    <dialog ref={ref} className="dialog" onCancel={onClose} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <h2>Override classification</h2>
        <p>
          {area.areaName} — currently {classLabel(area.classification)}.
        </p>
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
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save override'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
