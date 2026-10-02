/**
 * Scoring the AI against the office's own decisions on one recording.
 *
 * The answer key is what reviewers already decided about the AI's findings
 * from the narration: kept (approved, as written or corrected) and rejected.
 * A draft is scored on four things -- what it still finds of what was kept,
 * what it misses, which rejected findings it raises again, and whether the
 * moment it cites is the one a reviewer confirmed by filing that frame as the
 * finding's photograph.
 *
 * Pure, and given the rows rather than querying, so the scoring is testable.
 */
import { pairFindings } from '@texasrenters/shared';

/** A decided finding, as the key holds it. */
export type KeyFinding = {
  id: string;
  /** The title now, and the AI's own wording when a reviewer corrected it. */
  titles: string[];
  category: string;
  startSeconds: number | null;
  decision: 'KEPT' | 'REJECTED';
  reasonCode: string | null;
  /** The frame a reviewer filed as its photograph, in ms: the confirmed moment. */
  confirmedMs: number | null;
};

/** One of the draft's findings, as the analysis proposed it. */
export type DraftFinding = {
  title: string;
  category: string;
  videoTimestampStart: number;
  videoTimestampEnd: number;
};

export type RecordingScore = {
  kept: number;
  found: number;
  missed: Array<{ id: string; title: string }>;
  rejected: number;
  /** Rejected findings the draft raises again: false alarms it would repeat. */
  repeated: Array<{ id: string; title: string; reasonCode: string | null }>;
  /** Draft findings the office never decided either way. */
  added: Array<{ title: string }>;
  /** Kept findings found that have a confirmed moment, and how many the draft placed. */
  timed: number;
  onTime: number;
};

/** Seconds either side of the draft's cited moment that still count as on it. */
export const ON_TIME_SECONDS = 5;

export function scoreRecording(key: KeyFinding[], draft: DraftFinding[]): RecordingScore {
  const { pairs, unpairedRight } = pairFindings(key, draft, {
    left: (finding) => ({
      titles: finding.titles,
      category: finding.category,
      startSeconds: finding.confirmedMs !== null ? finding.confirmedMs / 1000 : finding.startSeconds,
    }),
    right: (finding) => ({
      titles: [finding.title],
      category: finding.category,
      startSeconds: finding.videoTimestampStart,
    }),
  });
  const matched = new Map(pairs.map(([keyIndex, draftIndex]) => [keyIndex, draft[draftIndex]]));

  const score: RecordingScore = {
    kept: 0,
    found: 0,
    missed: [],
    rejected: 0,
    repeated: [],
    added: unpairedRight.map((index) => ({ title: draft[index].title })),
    timed: 0,
    onTime: 0,
  };
  key.forEach((finding, index) => {
    const proposed = matched.get(index);
    if (finding.decision === 'REJECTED') {
      score.rejected += 1;
      if (proposed)
        score.repeated.push({ id: finding.id, title: finding.titles[0], reasonCode: finding.reasonCode });
      return;
    }
    score.kept += 1;
    if (!proposed) {
      score.missed.push({ id: finding.id, title: finding.titles[0] });
      return;
    }
    score.found += 1;
    if (finding.confirmedMs === null) return;
    score.timed += 1;
    const confirmed = finding.confirmedMs / 1000;
    const start = proposed.videoTimestampStart;
    const end = Math.max(proposed.videoTimestampEnd, start);
    // A draft citing no moment (0 to 0) is not on it, however close 0:00 is.
    if (start + end > 0 && confirmed >= start - ON_TIME_SECONDS && confirmed <= end + ON_TIME_SECONDS)
      score.onTime += 1;
  });
  return score;
}

export type EvaluationTotals = {
  recordings: number;
  failed: number;
  kept: number;
  found: number;
  rejected: number;
  repeated: number;
  added: number;
  timed: number;
  onTime: number;
};

export function sumScores(scores: Array<RecordingScore | null>): EvaluationTotals {
  const totals: EvaluationTotals = {
    recordings: scores.length,
    failed: 0,
    kept: 0,
    found: 0,
    rejected: 0,
    repeated: 0,
    added: 0,
    timed: 0,
    onTime: 0,
  };
  for (const score of scores) {
    if (!score) {
      totals.failed += 1;
      continue;
    }
    totals.kept += score.kept;
    totals.found += score.found;
    totals.rejected += score.rejected;
    totals.repeated += score.repeated.length;
    totals.added += score.added.length;
    totals.timed += score.timed;
    totals.onTime += score.onTime;
  }
  return totals;
}
