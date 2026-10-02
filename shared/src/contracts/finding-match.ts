/**
 * Whether two findings name the same problem, when one of them has no id to
 * go by: a draft of the AI's analysis against what the office decided.
 *
 * The AI rewords freely between runs ("Damaged wall near the door", "Door-side
 * wall has a hole"), so this is a score, not an equality: the words two titles
 * share, more when the two cite the same moment of the recording or the same
 * category. Shared so the console's one-recording trial and the server's
 * test-set run pair findings by one rule.
 */

/** Words that say nothing about which problem a title names. */
const FILLER = new Set([
  'the', 'and', 'with', 'from', 'near', 'on', 'in', 'at', 'of', 'to', 'a', 'an',
  'possible', 'minor', 'small', 'some', 'room', 'area', 'visible', 'noted',
]);

function words(title: string) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/s$/, ''))
      .filter((word) => word.length > 2 && !FILLER.has(word)),
  );
}

/** How alike two titles are, 0 to 1: shared words over all words. */
export function titleSimilarity(left: string, right: string) {
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** A finding as matching sees it. `titles` holds more than one when it was reworded. */
export interface MatchableFinding {
  titles: string[];
  category?: string | null;
  /** Seconds into the recording; null or 0 when it cites no moment. */
  startSeconds?: number | null;
}

/** Seconds apart within which two findings cite the same moment. */
const SAME_MOMENT_SECONDS = 10;

/** The score at which two findings are the same problem. */
export const SAME_FINDING = 0.34;

/**
 * How likely two findings are the same problem. Title words carry it: the
 * same moment or category only tips a weak title match over, never makes one.
 */
export function findingMatchScore(left: MatchableFinding, right: MatchableFinding) {
  const title = Math.max(
    0,
    ...left.titles.flatMap((a) => right.titles.map((b) => titleSimilarity(a, b))),
  );
  if (title === 0) return 0;
  const leftAt = left.startSeconds || null;
  const rightAt = right.startSeconds || null;
  const sameMoment =
    leftAt !== null && rightAt !== null && Math.abs(leftAt - rightAt) <= SAME_MOMENT_SECONDS;
  const category = (value?: string | null) => value?.trim().toLowerCase() || null;
  const sameCategory = category(left.category) !== null && category(left.category) === category(right.category);
  return title + (sameMoment ? 0.2 : 0) + (sameCategory ? 0.1 : 0);
}

/**
 * Pair two lists of findings, best pairs first, each finding used once.
 * Returns index pairs, and the indexes on each side left unpaired.
 */
export function pairFindings<L, R>(
  left: L[],
  right: R[],
  view: { left: (item: L) => MatchableFinding; right: (item: R) => MatchableFinding },
) {
  const candidates: Array<{ left: number; right: number; score: number }> = [];
  left.forEach((leftItem, leftIndex) =>
    right.forEach((rightItem, rightIndex) => {
      const score = findingMatchScore(view.left(leftItem), view.right(rightItem));
      if (score >= SAME_FINDING) candidates.push({ left: leftIndex, right: rightIndex, score });
    }),
  );
  candidates.sort((a, b) => b.score - a.score);
  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const candidate of candidates) {
    if (usedLeft.has(candidate.left) || usedRight.has(candidate.right)) continue;
    usedLeft.add(candidate.left);
    usedRight.add(candidate.right);
    pairs.push([candidate.left, candidate.right]);
  }
  return {
    pairs,
    unpairedLeft: left.map((_, index) => index).filter((index) => !usedLeft.has(index)),
    unpairedRight: right.map((_, index) => index).filter((index) => !usedRight.has(index)),
  };
}
