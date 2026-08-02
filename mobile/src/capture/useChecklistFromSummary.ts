import { useEffect, useRef } from 'react';

import type { Finding } from '../domain/models';
import { useDemoStore } from '../stores/demo.store';
import { matchChecklistMentions, type ChecklistItem } from './area-checklist';

/**
 * Ticks checklist items the AI summary shows were covered.
 *
 * The summary is written from the recording's transcript, so it is the closest
 * thing to "what the technician actually said" that reaches the client — no
 * transcript endpoint exists, and live speech recognition is unavailable in
 * Expo Go. Matching against it gives automatic coverage today without a
 * development build or a schema change.
 *
 * Adds only. A mention is evidence something was discussed, never evidence it
 * was not, so this can never untick what the technician set by hand — see
 * `markChecklistItemsCovered`.
 *
 * The summary is worth being modest about: it is a condensed narrative, not a
 * verbatim transcript, so it will miss things that were said. That is the right
 * direction to fail in — under-ticking leaves the technician to confirm, while
 * over-ticking would claim coverage nobody provided.
 */
export function useChecklistFromSummary(
  areaId: string,
  items: readonly ChecklistItem[],
  summary: Pick<Finding, 'id' | 'observation' | 'aiSummary'> | undefined,
) {
  const markCovered = useDemoStore((state) => state.markChecklistItemsCovered);
  // Keyed by the summary that produced the ticks: re-running for the same one
  // would fight a technician who deliberately unticked something the AI matched.
  const appliedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!areaId || !summary || !items.length) return;
    if (appliedFor.current === summary.id) return;

    const text = [summary.observation, summary.aiSummary].filter(Boolean).join(' ');
    if (!text.trim()) return;

    appliedFor.current = summary.id;
    const covered = matchChecklistMentions(items, text);
    if (covered.length) markCovered(areaId, covered);
  }, [areaId, items, markCovered, summary]);
}
