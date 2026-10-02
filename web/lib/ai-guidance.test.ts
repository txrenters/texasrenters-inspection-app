import type { AiAnalysisPreview } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import {
  comparePreview,
  decidedShares,
  officeDecision,
  previewVerdict,
  rejectReasonRow,
  titleSimilarity,
} from './ai-guidance';

/**
 * Reading a trial of draft house rules against what the office decided on the
 * same recording, and the scorecard's shares.
 */

type Current = AiAnalysisPreview['current'][number];
type Draft = AiAnalysisPreview['draft'][number];

const current = (id: string, title: string, fields: Partial<Current> = {}): Current => ({
  id,
  title,
  description: '',
  severity: 'MEDIUM',
  findingType: 'POSSIBLE_NEW_DAMAGE',
  category: 'Walls',
  source: 'NARRATION',
  reviewStatus: 'APPROVED',
  videoTimestampStart: 0,
  videoTimestampEnd: 0,
  lastReview: { status: 'APPROVED', reason: null, reasonCode: null },
  ...fields,
});

const draft = (title: string): Draft => ({
  title,
  description: '',
  severity: 'LOW',
  findingType: 'MAINTENANCE',
  category: 'Walls',
  comparisonResult: 'NORMAL_WEAR',
  possibleResponsibility: 'UNDETERMINED',
  confidence: 0.7,
  videoTimestampStart: 0,
  videoTimestampEnd: 0,
});

describe('which draft finding names the same problem', () => {
  it('matches titles worded differently that share what they are about', () => {
    expect(titleSimilarity('Holes in the bedroom door', 'Door has two holes')).toBeGreaterThan(0.34);
    expect(titleSimilarity('Stained carpet', 'Broken window screen')).toBe(0);
  });

  it('pairs each finding once, best pair first, and says what was dropped and added', () => {
    const comparison = comparePreview({
      current: [
        current('door', 'Holes in the bedroom door'),
        current('nail', 'Small nail holes in wall', {
          reviewStatus: 'REJECTED',
          lastReview: { status: 'REJECTED', reason: null, reasonCode: 'NORMAL_WEAR' },
        }),
      ],
      draft: [draft('Bedroom door has holes'), draft('Missing smoke detector')],
    });

    expect(comparison.matched.map((pair) => [pair.current.id, pair.draft.title])).toEqual([
      ['door', 'Bedroom door has holes'],
    ]);
    expect(comparison.dropped.map((finding) => finding.id)).toEqual(['nail']);
    expect(comparison.added.map((finding) => finding.title)).toEqual(['Missing smoke detector']);
    expect(previewVerdict(comparison)).toBe(
      'Of the 1 the office rejected, the draft drops 1. Of the 1 it approved, the draft still finds 1. 1 new finding.',
    );
  });

  it('says so when nothing on the recording was decided', () => {
    expect(previewVerdict({ matched: [], dropped: [], added: [] })).toBe(
      'Nothing decided on this recording to compare with.',
    );
  });
});

describe('what the office did with a finding', () => {
  it('names the reason for a rejection and a correction for an edit', () => {
    expect(
      officeDecision(
        current('a', 'x', {
          reviewStatus: 'REJECTED',
          lastReview: { status: 'REJECTED', reason: null, reasonCode: 'NOT_IN_VIDEO' },
        }),
      ),
    ).toBe('Rejected · Not in the video');
    expect(
      officeDecision(
        current('b', 'x', { lastReview: { status: 'EDITED', reason: null, reasonCode: null } }),
      ),
    ).toBe('Approved with edits');
    expect(officeDecision(current('c', 'x', { reviewStatus: 'PENDING_REVIEW' }))).toBe(
      'Not decided yet',
    );
  });
});

describe('the scorecard', () => {
  it('shares are of the decided findings, never of those still waiting', () => {
    expect(decidedShares({ findings: 10, pending: 6, kept: 2, corrected: 1, rejected: 1 })).toEqual({
      decided: 4,
      kept: 50,
      corrected: 25,
      rejected: 25,
    });
    expect(decidedShares({ findings: 3, pending: 3, kept: 0, corrected: 0, rejected: 0 }).kept).toBe(
      0,
    );
  });

  it('names rejections made before reasons were asked', () => {
    expect(rejectReasonRow('UNSPECIFIED')).toBe('No reason chosen');
    expect(rejectReasonRow('ALREADY_AT_MOVE_IN')).toBe('Already at move-in');
  });
});
