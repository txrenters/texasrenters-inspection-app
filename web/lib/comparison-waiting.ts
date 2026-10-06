import type { AdminInspectionComparison } from '@texasrenters/shared';

/**
 * What the comparison report is still waiting on, in words: recordings the AI
 * has not finished with, and findings nobody has confirmed yet. Empty when it
 * is waiting on nothing.
 *
 * Said, never enforced (the office, 2026-10-07). The report can be sent at any
 * time and keeps itself current; an owner or tenant with the link sees each
 * confirmed finding the next time they open it. These only tell the office
 * what has not reached it yet -- an unconfirmed finding is not on it.
 */
export function comparisonWaitingOn(
  comparison: Pick<AdminInspectionComparison, 'recordingsProcessing' | 'findingsToConfirm'>,
) {
  const notes: string[] = [];
  const recordings = comparison.recordingsProcessing ?? 0;
  if (recordings)
    notes.push(
      recordings === 1
        ? '1 move-out recording is still being processed; its findings will follow.'
        : `${recordings} move-out recordings are still being processed; their findings will follow.`,
    );
  const findings = comparison.findingsToConfirm ?? 0;
  if (findings)
    notes.push(
      findings === 1
        ? '1 finding is waiting to be confirmed on the inspection page; it joins the report once confirmed.'
        : `${findings} findings are waiting to be confirmed on the inspection page; they join the report once confirmed.`,
    );
  return notes;
}
