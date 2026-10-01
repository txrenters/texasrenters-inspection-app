'use client';

import type { AreaFinding } from '@texasrenters/shared';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import { useAdminMutations } from '@/lib/queries';

/**
 * Approve or reject a finding, inline where its evidence is shown.
 *
 * Findings review is the one decision this screen exists to support, so it must
 * live beside the evidence rather than on a separate page-wide list -- in the
 * area panel, and in the viewer's review panel beside the photograph itself.
 * The decision is a person's: approving AI output is always a click here, never
 * something the mark on an area or anything else implies.
 */
export function FindingReviewControls({
  finding,
  inspectionId,
}: {
  finding: AreaFinding;
  inspectionId: string;
}) {
  const { approveFinding, rejectFinding } = useAdminMutations();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const busy = approveFinding.isPending || rejectFinding.isPending;

  if (finding.reviewStatus !== 'PENDING_REVIEW')
    return finding.lastReview ? (
      <p className="text-muted-foreground text-xs">
        {finding.lastReview.reviewerName} · {formatDateTime(finding.lastReview.createdAt)}
        {finding.lastReview.reason ? ` · ${finding.lastReview.reason}` : ''}
      </p>
    ) : (
      <p className="text-muted-foreground text-xs">Reviewed</p>
    );

  if (rejecting)
    return (
      <div className="grid gap-2">
        <Textarea
          aria-label="Rejection reason"
          maxLength={1000}
          minLength={2}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why is this finding rejected?"
          value={reason}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => setRejecting(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Back
          </Button>
          <Button
            // A reason is mandatory: a rejected finding without one leaves no
            // record of why the AI output was overruled.
            disabled={reason.trim().length < 2 || busy}
            onClick={() =>
              void rejectFinding
                .mutateAsync({ id: finding.id, inspectionId, reason: reason.trim() })
                .then(() => setRejecting(false))
                .catch(() => undefined)
            }
            size="sm"
            type="button"
            variant="destructive"
          >
            {rejectFinding.isPending ? <Spinner /> : null}
            {rejectFinding.isPending ? 'Rejecting…' : 'Confirm reject'}
          </Button>
        </div>
        {rejectFinding.error ? (
          <Alert variant="destructive">
            <AlertDescription>{rejectFinding.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    );

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            void approveFinding.mutateAsync({ id: finding.id, inspectionId }).catch(() => undefined)
          }
          size="sm"
          type="button"
        >
          {approveFinding.isPending ? <Spinner /> : null}
          {approveFinding.isPending ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          disabled={busy}
          onClick={() => setRejecting(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
      {approveFinding.error ? (
        <Alert variant="destructive">
          <AlertDescription>{approveFinding.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
