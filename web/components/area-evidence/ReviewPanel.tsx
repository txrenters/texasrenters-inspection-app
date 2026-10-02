'use client';

import type { AreaEvidenceBundle, AreaFinding } from '@texasrenters/shared';
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { decisionLine } from '@/lib/finding-review';
import { formatDateTime } from '@/lib/format';

import { STATUS_META } from './area-status';
import { AreaReviewControl } from './AreaReviewControl';
import { FindingReviewControls } from './FindingReviewControls';
import { ConditionLines } from './PhotoSheet';

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
      {children}
    </h3>
  );
}

/**
 * Everything needed to finish an area, beside its photographs.
 *
 * Reviewing used to mean the viewer for the photographs, then the area panel
 * for the findings, the Condition tab for the answers, and the panel header
 * for the mark -- and back into the viewer for the next area. This puts the
 * area's answers, its findings with Approve and Reject, and the review mark
 * next to the photograph being looked at, so an inspection can be reviewed in
 * one pass: look, decide, mark, next area.
 *
 * Every decision is still a person's click. The panel decides nothing itself,
 * and the mark is still refused while a finding awaits a decision.
 */
export function ReviewPanel({
  inspectionId,
  bundle,
  canReview,
  finalized,
  onNextArea,
}: {
  inspectionId: string;
  bundle: AreaEvidenceBundle;
  canReview: boolean;
  finalized: boolean;
  /** Absent at the last area with photographs. */
  onNextArea?: () => void;
}) {
  const { area, findings } = bundle;
  const meta = STATUS_META[area.reviewStatus];
  // The ones awaiting a decision first: they are what stands between this area
  // and its mark.
  const ordered = [
    ...findings.filter((finding) => finding.reviewStatus === 'PENDING_REVIEW'),
    ...findings.filter((finding) => finding.reviewStatus !== 'PENDING_REVIEW'),
  ];

  return (
    <div className="grid content-start gap-4">
      <section className="grid gap-1.5">
        <p className="text-sm font-semibold">{area.name}</p>
        <span>
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </span>
        {area.skipReason ? (
          <p className="text-muted-foreground text-xs italic">Skipped: {area.skipReason}</p>
        ) : null}
        {area.technicianNote?.trim() ? (
          <p className="text-xs">Note: {area.technicianNote.trim()}</p>
        ) : null}
      </section>

      <section className="grid gap-1.5">
        <SectionTitle>Condition</SectionTitle>
        <ConditionLines checklist={bundle.checklist} />
      </section>

      <section className="grid gap-2">
        <SectionTitle>Findings{findings.length ? ` (${findings.length})` : ''}</SectionTitle>
        {ordered.length ? (
          <ul className="grid gap-2">
            {ordered.map((finding) => (
              <FindingCard
                canReview={canReview && !finalized}
                finding={finding}
                inspectionId={inspectionId}
                key={finding.id}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">No findings in this area.</p>
        )}
      </section>

      <section className="grid gap-2 border-t pt-3">
        <AreaReviewControl
          align="start"
          bundle={bundle}
          canReview={canReview}
          finalized={finalized}
          inspectionId={inspectionId}
        />
        {onNextArea ? (
          <Button
            className="justify-self-start"
            onClick={onNextArea}
            size="sm"
            type="button"
            variant="outline"
          >
            Next area
            <ChevronRightIcon aria-hidden />
          </Button>
        ) : null}
      </section>
    </div>
  );
}

function FindingCard({
  finding,
  inspectionId,
  canReview,
}: {
  finding: AreaFinding;
  inspectionId: string;
  canReview: boolean;
}) {
  return (
    <li className="grid gap-1.5 rounded-lg border p-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium">{finding.title}</span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge showIcon={false} value={finding.severity} />
          <StatusBadge showIcon={false} value={finding.reviewStatus} />
        </span>
      </div>
      {finding.description ? (
        <p className="text-muted-foreground line-clamp-3 text-xs">{finding.description}</p>
      ) : null}
      {canReview ? (
        <FindingReviewControls finding={finding} inspectionId={inspectionId} />
      ) : finding.lastReview ? (
        <p className="text-muted-foreground text-xs">
          {decisionLine(finding.lastReview, formatDateTime(finding.lastReview.createdAt))}
        </p>
      ) : null}
    </li>
  );
}
