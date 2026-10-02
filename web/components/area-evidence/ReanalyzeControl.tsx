'use client';

import type { AreaRecording } from '@texasrenters/shared';
import { SparklesIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
 * "Re-run AI" on one recording, in the recording's header beside its status.
 *
 * For after the analysis itself improved: a recording analysed under an older
 * prompt kept its findings for good. Re-running replaces only the findings still
 * awaiting a decision, which is the reviewer's queue, so it asks first and says
 * how many. Decided findings stay as they are.
 *
 * It used to sit at the foot of the card, under a player that fills the panel,
 * and vanished once the inspection was finalized -- which read as the button
 * having been removed. It runs on a finalized inspection now: a re-run writes
 * findings, never the inspection's status, so the visit stays closed in Jobber
 * and the technician's time stands.
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
  const [open, setOpen] = useState(false);

  if (recording.analysisRun?.status === 'RUNNING')
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
        <Spinner aria-hidden className="size-3" />
        Re-running the AI…
      </span>
    );

  const start = () =>
    mutation.mutate(
      { mediaId: recording.id, inspectionId, areaId },
      { onSuccess: () => setOpen(false) },
    );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button className="h-7 text-xs" size="sm" type="button" variant="outline">
          <SparklesIcon aria-hidden />
          Re-run AI
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid gap-3 text-sm">
        <p className="font-medium">Run the AI on this recording again?</p>
        <p className="text-muted-foreground">
          {pendingFindings
            ? `Replaces the ${pendingFindings} finding${pendingFindings === 1 ? '' : 's'} still awaiting a decision. Decided ones stay.`
            : 'Findings already decided stay as they are.'}
        </p>
        {mutation.isError ? <p className="text-destructive">{mutation.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button
            disabled={mutation.isPending}
            onClick={() => setOpen(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button disabled={mutation.isPending} onClick={start} size="sm" type="button">
            {mutation.isPending ? <Spinner /> : null}
            Re-run
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * How the last re-run went, under the recording's header. Its own line so the
 * header stays one row on the narrow player beside the findings.
 */
export function ReanalyzeStatus({ recording }: { recording: AreaRecording }) {
  const run = recording.analysisRun;
  if (run?.status === 'FAILED')
    return <p className="text-warning text-xs">The last AI re-run failed: {run.message}</p>;
  if (run?.status === 'COMPLETED')
    return (
      <p className="text-muted-foreground text-xs">AI re-run {formatDateTime(run.at)}</p>
    );
  return null;
}
