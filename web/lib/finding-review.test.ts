import type { AreaFinding } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import {
  comparisonLabel,
  findingMoment,
  formatMoment,
  frameTimes,
  frameUrl,
  nextPending,
  responsibilityLabel,
  suggestionToOffer,
  visualLabel,
} from './finding-review';

function finding(overrides: Partial<AreaFinding> = {}): AreaFinding {
  return {
    id: 'finding-1',
    title: 'Door hole and trim require repair',
    description: 'A hole below the handle.',
    category: 'Door',
    findingType: 'POSSIBLE_NEW_DAMAGE',
    severity: 'MEDIUM',
    comparisonResult: 'POSSIBLE_NEW_DAMAGE',
    confidence: 0.9,
    reviewStatus: 'PENDING_REVIEW',
    createdAt: '2026-10-02T00:33:00.000Z',
    recordingId: 'media-1',
    videoTimestampStart: 18,
    videoTimestampEnd: 24,
    photoCount: 0,
    ...overrides,
  };
}

describe('a finding’s moment', () => {
  it('is where in which recording the AI placed it', () => {
    expect(findingMoment(finding())).toEqual({ recordingId: 'media-1', start: 18, end: 24 });
  });

  it('is nothing for 0 to 0, which is the analysis having no time to cite', () => {
    // Offered as a link it sent the reviewer to the start of the video.
    expect(findingMoment(finding({ videoTimestampStart: 0, videoTimestampEnd: 0 }))).toBeNull();
  });

  it('is kept when it really does start at the beginning', () => {
    expect(findingMoment(finding({ videoTimestampStart: 0, videoTimestampEnd: 6 }))).toEqual({
      recordingId: 'media-1',
      start: 0,
      end: 6,
    });
  });

  it('is nothing without a recording', () => {
    expect(findingMoment(finding({ recordingId: null }))).toBeNull();
  });

  it('reads as a span, or one moment', () => {
    expect(formatMoment({ start: 61, end: 74 })).toBe('1:01–1:14');
    expect(formatMoment({ start: 61, end: 61 })).toBe('1:01');
  });
});

describe('the stills shown for a finding', () => {
  it('start a second early and spread across the moment', () => {
    expect(frameTimes({ start: 61, end: 74 }, 165)).toEqual([60, 65, 69, 74]);
  });

  it('are at least three seconds wide, so a short moment is not four copies of one blur', () => {
    expect(frameTimes({ start: 18, end: 18 }, 165)).toEqual([17, 18, 19, 20]);
  });

  it('stay inside the recording', () => {
    expect(frameTimes({ start: 0, end: 1 }, 165)).toEqual([0, 1, 2, 3]);
    expect(frameTimes({ start: 164, end: 170 }, 165)).toEqual([163, 164, 165]);
  });

  it('come from the signed thumbnail URL at that second', () => {
    expect(frameUrl('https://customer-x.cloudflarestream.com/tok/thumbnails/thumbnail.jpg', 61)).toBe(
      'https://customer-x.cloudflarestream.com/tok/thumbnails/thumbnail.jpg?time=61s&height=360',
    );
  });

  it('keep the half second of the AI’s sharpest frame', () => {
    expect(
      frameUrl('https://customer-x.cloudflarestream.com/tok/thumbnails/thumbnail.jpg', 21.5, 720),
    ).toBe('https://customer-x.cloudflarestream.com/tok/thumbnails/thumbnail.jpg?time=21.5s&height=720');
  });
});

describe('what the AI saw, in a few words', () => {
  it('names what the video showed, and what the AI spotted itself', () => {
    const at = '2026-10-03T10:00:00.000Z';
    expect(visualLabel(finding({ visual: { status: 'VISIBLE', checkedAt: at } }))).toBe('Seen in video');
    expect(visualLabel(finding({ visual: { status: 'NOT_VISIBLE', checkedAt: at } }))).toBe(
      'Not seen in video',
    );
    expect(visualLabel(finding({ source: 'AI_VISION' }))).toBe('Spotted by AI');
    expect(visualLabel(finding())).toBeNull();
  });

  it('offers the frame already filed, else the best one not set aside', () => {
    const suggestion = (id: string, rank: number, status: 'SUGGESTED' | 'ACCEPTED' | 'DISMISSED') => ({
      id,
      recordingId: 'media-1',
      atMs: 1000 * rank,
      rank,
      box: null,
      status,
    });
    expect(
      suggestionToOffer(
        finding({ frameSuggestions: [suggestion('b', 1, 'SUGGESTED'), suggestion('a', 0, 'DISMISSED')] }),
      )?.id,
    ).toBe('b');
    expect(
      suggestionToOffer(
        finding({ frameSuggestions: [suggestion('a', 0, 'SUGGESTED'), suggestion('b', 1, 'ACCEPTED')] }),
      )?.id,
    ).toBe('b');
    expect(suggestionToOffer(finding({ frameSuggestions: [suggestion('a', 0, 'DISMISSED')] }))).toBeNull();
  });
});

describe('what the reviewer is told', () => {
  it('says what a missing baseline means, not "missing evidence"', () => {
    expect(comparisonLabel('MISSING_EVIDENCE')).toBe('No move-in record to compare');
    expect(comparisonLabel('EXISTING_CONDITION')).toBe('Recorded at move-in');
  });

  it('words the AI lean as a suggestion, and says nothing when there is none', () => {
    expect(responsibilityLabel('TENANT_REVIEW_REQUIRED')).toBe(
      'AI suggests checking tenant responsibility',
    );
    expect(responsibilityLabel('UNDETERMINED')).toBeNull();
    expect(responsibilityLabel(null)).toBeNull();
  });
});

describe('the finding after a decision', () => {
  const list = [
    finding({ id: 'a' }),
    finding({ id: 'b', reviewStatus: 'APPROVED' }),
    finding({ id: 'c' }),
    finding({ id: 'd' }),
  ];

  it('is the next one still awaiting a decision', () => {
    expect(nextPending(list, 'a')?.id).toBe('c');
  });

  it('wraps to the top, and never offers the one just decided', () => {
    expect(nextPending(list, 'd')?.id).toBe('a');
    expect(nextPending([finding({ id: 'only' })], 'only')).toBeNull();
  });
});
