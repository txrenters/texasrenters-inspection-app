/**
 * Reading a preview of draft house rules against what the office decided, and
 * the scorecard's numbers, kept apart from the components so they are testable
 * without a browser.
 */

import type {
  AiAnalysisPreview,
  AiEvaluationRunSummary,
  AiScoreTally,
} from '@texasrenters/shared';
import { pairFindings, rejectReasonLabel } from '@texasrenters/shared';

export { titleSimilarity } from '@texasrenters/shared';

type CurrentFinding = AiAnalysisPreview['current'][number];
type DraftFinding = AiAnalysisPreview['draft'][number];

export type PreviewComparison = {
  /** A finding the draft still makes, beside the draft's wording of it. */
  matched: Array<{ current: CurrentFinding; draft: DraftFinding }>;
  /** Findings made now that the draft does not make. */
  dropped: CurrentFinding[];
  /** Findings only the draft makes. */
  added: DraftFinding[];
};

/**
 * Pair each current finding with the draft finding naming the same problem,
 * by the rule the test-set run uses (`pairFindings`): the draft has no ids, and
 * the AI rewords freely between runs.
 */
export function comparePreview(preview: Pick<AiAnalysisPreview, 'current' | 'draft'>) {
  const view = (finding: CurrentFinding | DraftFinding) => ({
    titles: [finding.title],
    category: finding.category,
    startSeconds: finding.videoTimestampStart,
  });
  const { pairs, unpairedLeft, unpairedRight } = pairFindings(preview.current, preview.draft, {
    left: view,
    right: view,
  });
  return {
    matched: pairs.map(([current, draft]) => ({
      current: preview.current[current],
      draft: preview.draft[draft],
    })),
    dropped: unpairedLeft.map((index) => preview.current[index]),
    added: unpairedRight.map((index) => preview.draft[index]),
  } satisfies PreviewComparison;
}

/** What the office did with a current finding, in a couple of words. */
export function officeDecision(finding: CurrentFinding) {
  if (finding.reviewStatus === 'PENDING_REVIEW') return 'Not decided yet';
  if (finding.reviewStatus === 'REJECTED') {
    const reason = rejectReasonLabel(finding.lastReview?.reasonCode);
    return reason ? `Rejected · ${reason}` : 'Rejected';
  }
  if (finding.lastReview?.status === 'EDITED' || finding.reviewStatus === 'EDITED')
    return 'Approved with edits';
  return 'Approved';
}

const rejected = (finding: CurrentFinding) => finding.reviewStatus === 'REJECTED';
const kept = (finding: CurrentFinding) =>
  finding.reviewStatus === 'APPROVED' || finding.reviewStatus === 'EDITED';

/**
 * The preview's verdict in one or two sentences: did the draft stop making the
 * findings the office rejected, and does it still make the ones it kept?
 */
export function previewVerdict(comparison: PreviewComparison) {
  const rejectedNow = [...comparison.matched.map((pair) => pair.current), ...comparison.dropped]
    .filter(rejected).length;
  const rejectedGone = comparison.dropped.filter(rejected).length;
  const keptNow = [...comparison.matched.map((pair) => pair.current), ...comparison.dropped]
    .filter(kept).length;
  const keptStill = comparison.matched.filter((pair) => kept(pair.current)).length;
  const parts: string[] = [];
  if (rejectedNow)
    parts.push(
      `Of the ${rejectedNow} the office rejected, the draft drops ${rejectedGone}.`,
    );
  if (keptNow) parts.push(`Of the ${keptNow} it approved, the draft still finds ${keptStill}.`);
  if (comparison.added.length)
    parts.push(
      `${comparison.added.length} new ${comparison.added.length === 1 ? 'finding' : 'findings'}.`,
    );
  return parts.join(' ') || 'Nothing decided on this recording to compare with.';
}

/** Of the decided findings, the share kept, corrected and rejected, as whole percents. */
export function decidedShares(tally: AiScoreTally) {
  const decided = tally.kept + tally.corrected + tally.rejected;
  const share = (count: number) => (decided ? Math.round((count / decided) * 100) : 0);
  return {
    decided,
    kept: share(tally.kept),
    corrected: share(tally.corrected),
    rejected: share(tally.rejected),
  };
}

/** A rejection reason as the scorecard lists it. */
export function rejectReasonRow(code: string) {
  return code === 'UNSPECIFIED' ? 'No reason chosen' : (rejectReasonLabel(code) ?? code);
}

/** "18 of 22 (82%)", or "none" when there was nothing to count. */
export function outOf(part: number, whole: number) {
  if (!whole) return 'none';
  return `${part} of ${whole} (${Math.round((part / whole) * 100)}%)`;
}

/** Which rules a test run tried, in a few words. */
export function runRulesLabel(
  run: Pick<AiEvaluationRunSummary, 'guidanceVersion' | 'houseRulesLength'>,
) {
  if (run.guidanceVersion) return `Saved rules, version ${run.guidanceVersion}`;
  if (!run.houseRulesLength) return 'No house rules';
  return `Draft rules (${run.houseRulesLength.toLocaleString('en-US')} characters)`;
}

/**
 * A starting point for the office's own rules, shown until it writes some. The
 * office edits it; nothing here is applied until it is saved.
 */
export const HOUSE_RULES_TEMPLATE = `Normal wear and tear (not damage; the tenant is not charged):
- Light scuffs, small nail holes from hanging pictures, faded paint, minor carpet wear in walkways.
- Loose or worn hardware, worn grout, light surface scratches on floors.

Damage (possible tenant responsibility, always for the office to decide):
- Holes larger than a nail hole, broken or missing fixtures, burns, pet damage, stains that do not clean.
- Anything the move-in recorded as fine that is now broken.

Cleaning:
- Dirty but undamaged is a cleaning item, not damage. Say so in the title.

Severity:
- HIGH: safety, water, electrical, or anything stopping a room being rented.
- MEDIUM: needs a repair before the next tenant.
- LOW: cosmetic.

Texas Property Code 92.001 defines normal wear and tear, and 92.104 does not let a security deposit be kept for it.`;
