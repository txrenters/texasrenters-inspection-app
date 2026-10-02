'use client';

import type { AreaRecording } from '@texasrenters/shared';
import { SparklesIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import { useAdminMutations } from '@/lib/queries';

/**
 * Whether a recording's AI analysis can be run again from here.
 *
 * Not while its first pass is still going, and not for a video Cloudflare could
 * not encode, which has nothing to transcribe. ANALYSIS_FAILED is exactly the
 * case this is for. The server refuses the same cases; this only keeps the
 * button off a recording it would refuse.
 */
export function canReanalyze(recording: AreaRecording) {
  return recording.processingStatus === 'READY' || recording.processingStatus === 'ANALYSIS_FAILED';
}

/**
 * "Re-run AI" on one recording, and how the last re-run went.
 *
 * For after the analysis itself improved: a recording analysed under an older
 * prompt kept its findings for good. Re-running replaces only the findings still
 * awaiting a decision, which is the reviewer's queue, so it asks first and says
 * how many. Decided findings stay as they are.
 */
export function ReanalyzeControl({
  recording,
  inspectionId,
  areaId,
  pendingFindings,
}: {
  recording: AreaRecording;
  inspectionId: string;
  areaId: string;
  /** This recording's findings still awaiting a decision, which a re-run replaces. */
  pendingFindings: number;
}) {
  const mutation = useAdminMutations().reanalyzeRecording;
  const [confirming, setConfirming] = useState(false);
  const run = recording.analysisRun;

  if (run?.status === 'RUNNING')
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
        <Spinner aria-hidden className="size-3" />
        Re-running the AI. New findings appear here when it finishes.
      </p>
    );

  const start = () =>
    mutation.mutate(
      { mediaId: recording.id, inspectionId, areaId },
      { onSettled: () => setConfirming(false) },
    );

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
      {run?.status === 'FAILED' ? (
        <span className="text-warning">The last re-run failed: {run.message}</span>
      ) : run?.status === 'COMPLETED' ? (
        <span className="text-muted-foreground">AI re-run {formatDateTime(run.at)}</span>
      ) : null}
      {mutation.isError ? (
        <span className="text-destructive">{mutation.error.message}</span>
      ) : null}
      {confirming ? (
        <>
          <span className="text-muted-foreground">
            {pendingFindings
              ? `Replaces the ${pendingFindings} finding${pendingFindings === 1 ? '' : 's'} still awaiting a decision. Decided ones stay.`
              : 'Findings already decided stay as they are.'}
          </span>
          <Button disabled={mutation.isPending} onClick={start} size="sm" type="button">
            {mutation.isPending ? <Spinner /> : null}
            Re-run
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() => setConfirming(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button onClick={() => setConfirming(true)} size="sm" type="button" variant="ghost">
          <SparklesIcon aria-hidden />
          Re-run AI
        </Button>
      )}
    </div>
  );
}
