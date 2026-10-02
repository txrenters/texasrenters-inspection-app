import { describe, expect, it } from 'vitest';

import {
  findingMatchScore,
  pairFindings,
  SAME_FINDING,
  titleSimilarity,
} from '../src/contracts/finding-match.js';

/**
 * Whether two findings name the same problem when one has no id: the AI's
 * draft against what the office decided. The AI rewords freely between runs.
 */

describe('whether two findings are the same problem', () => {
  it('compares the words of the titles, not their order or plurals', () => {
    expect(titleSimilarity('Holes in the bedroom door', 'Bedroom door has holes')).toBe(1);
    expect(titleSimilarity('Stained carpet', 'Broken window screen')).toBe(0);
  });

  it('lets the same moment or category tip a weak title match over, never make one', () => {
    const decided = { titles: ['Door frame chipped'], category: 'Doors', startSeconds: 30 };
    const weak = { titles: ['Frame damage by the entry'], category: 'Trim', startSeconds: 32 };
    expect(findingMatchScore(decided, weak)).toBeGreaterThanOrEqual(SAME_FINDING);
    expect(findingMatchScore(decided, { ...weak, startSeconds: 200 })).toBeLessThan(SAME_FINDING);
    expect(
      findingMatchScore(decided, { titles: ['Smoke alarm missing'], category: 'Doors', startSeconds: 30 }),
    ).toBe(0);
  });

  it('treats 0:00 as citing no moment', () => {
    const left = { titles: ['Door frame chipped'], startSeconds: 0 };
    const right = { titles: ['Frame damage by the entry'], startSeconds: 0 };
    expect(findingMatchScore(left, right)).toBeLessThan(SAME_FINDING);
  });

  it('knows a corrected finding by any of its wordings', () => {
    expect(
      findingMatchScore(
        { titles: ['Scuffed paint near the door', 'Damaged wall near the door'] },
        { titles: ['Damaged wall near the door'] },
      ),
    ).toBe(1);
  });
});

describe('pairing two lists', () => {
  it('takes the best pairs first and uses each finding once', () => {
    const view = (title: string) => ({ titles: [title] });
    const result = pairFindings(
      ['Holes in the entrance door', 'Entrance door paint peeling'],
      ['Entrance door has holes', 'Missing smoke detector'],
      { left: view, right: view },
    );

    expect(result.pairs).toEqual([[0, 0]]);
    expect(result.unpairedLeft).toEqual([1]);
    expect(result.unpairedRight).toEqual([1]);
  });
});
