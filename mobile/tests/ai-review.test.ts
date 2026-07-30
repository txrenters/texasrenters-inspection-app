import type { Finding } from '../src/domain/models';
import {
  AI_REVIEW_DISCLAIMER,
  COMPARISON_LABELS,
  describeConfidence,
  findingTone,
  formatTimestamp,
  formatTimestampRange,
  isRoomSummary,
  reviewStatusLabel,
  ROOM_SUMMARY_TITLE,
} from '../src/utils/ai-review';

describe('isRoomSummary', () => {
  it('matches the server-side summary title regardless of case or padding', () => {
    expect(isRoomSummary({ title: ROOM_SUMMARY_TITLE })).toBe(true);
    expect(isRoomSummary({ title: '  room condition summary  ' })).toBe(true);
  });

  it('does not match a real defect', () => {
    expect(isRoomSummary({ title: 'Scuffed baseboard' })).toBe(false);
  });
});

describe('describeConfidence', () => {
  it('accepts a 0–1 fraction', () => {
    expect(describeConfidence(0.82)).toMatchObject({ percent: 82, needsVerification: false });
  });

  it('accepts a 0–100 percentage', () => {
    // The API has returned both shapes; rendering 0.82 as "1%" would mislead.
    expect(describeConfidence(82)).toMatchObject({ percent: 82, needsVerification: false });
  });

  it('flags medium and low confidence as needing verification', () => {
    expect(describeConfidence(0.65).needsVerification).toBe(true);
    expect(describeConfidence(0.2).needsVerification).toBe(true);
  });

  it('reads a small value above 1 as a percentage, not a broken fraction', () => {
    expect(describeConfidence(1.5)).toMatchObject({ percent: 2, needsVerification: true });
  });

  it('reports impossible values as unavailable rather than clamping them', () => {
    // Clamping is the dangerous option: 150 would become "100% — high
    // confidence", turning a broken value into apparent certainty.
    for (const bad of [-1, 150, Number.NaN, Number.POSITIVE_INFINITY]) {
      const band = describeConfidence(bad);
      expect(band).toMatchObject({ percent: 0, needsVerification: true });
      expect(band.label).toBe('Confidence unavailable');
    }
  });
});

describe('formatTimestamp', () => {
  it('renders m:ss with a zero-padded seconds field', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(9)).toBe('0:09');
    expect(formatTimestamp(84)).toBe('1:24');
    expect(formatTimestamp(3600)).toBe('60:00');
  });

  it('does not emit negative or NaN times', () => {
    expect(formatTimestamp(-5)).toBe('0:00');
    expect(formatTimestamp(Number.NaN)).toBe('0:00');
  });
});

describe('formatTimestampRange', () => {
  it('renders a range', () => {
    expect(formatTimestampRange(84, 91)).toBe('1:24 – 1:31');
  });

  it('collapses to a single time when the range has no width', () => {
    expect(formatTimestampRange(84, 84)).toBe('1:24');
    expect(formatTimestampRange(84, 10)).toBe('1:24');
  });

  it('returns null when there is no usable timestamp, so the row can be omitted', () => {
    // Printing "0:00 – 0:00" would imply the AI located something at the very
    // start of the recording, which is a different claim from "unknown".
    expect(formatTimestampRange(0, 0)).toBeNull();
    expect(formatTimestampRange(Number.NaN, 5)).toBeNull();
  });
});

describe('findingTone', () => {
  it('treats possible new damage as the most urgent tone', () => {
    expect(findingTone({ severity: 'HIGH', comparisonResult: 'POSSIBLE_NEW_DAMAGE' })).toBe(
      'danger',
    );
    expect(findingTone({ severity: 'LOW', comparisonResult: 'POSSIBLE_NEW_DAMAGE' })).toBe(
      'warning',
    );
  });

  it('does not escalate a pre-existing condition on severity alone', () => {
    // A HIGH-severity crack matched to the move-in baseline is not the tenant's
    // problem; colouring it red would push the technician to the wrong call.
    expect(findingTone({ severity: 'HIGH', comparisonResult: 'EXISTING_CONDITION' })).toBe('info');
    expect(findingTone({ severity: 'HIGH', comparisonResult: 'NORMAL_WEAR' })).toBe('info');
  });

  it('warns when the AI lacked evidence', () => {
    expect(findingTone({ severity: 'LOW', comparisonResult: 'MISSING_EVIDENCE' })).toBe('warning');
    expect(findingTone({ severity: 'LOW', comparisonResult: 'INSUFFICIENT_DATA' })).toBe(
      'warning',
    );
  });
});

describe('labels', () => {
  it('covers every comparison result the API can return', () => {
    const results: Finding['comparisonResult'][] = [
      'POSSIBLE_NEW_DAMAGE',
      'EXISTING_CONDITION',
      'NO_MATERIAL_CHANGE',
      'NORMAL_WEAR',
      'OWNER_MAINTENANCE',
      'MISSING_EVIDENCE',
      'INSUFFICIENT_DATA',
    ];
    for (const result of results) {
      expect(COMPARISON_LABELS[result]).toBeTruthy();
      // Raw enum values must never reach a technician.
      expect(COMPARISON_LABELS[result]).not.toMatch(/_/);
    }
  });

  it('falls back to a safe review status rather than showing a raw enum', () => {
    expect(reviewStatusLabel('SOMETHING_NEW')).toBe('Awaiting office review');
    expect(reviewStatusLabel('APPROVED')).toBe('Accepted by the office');
  });
});

describe('AI_REVIEW_DISCLAIMER', () => {
  it('states that the office decides and that charges are not determined here', () => {
    // This wording is the guardrail the spec requires; assert it cannot be
    // quietly weakened into a generic "AI may make mistakes" notice.
    expect(AI_REVIEW_DISCLAIMER).toMatch(/authorized reviewer/i);
    expect(AI_REVIEW_DISCLAIMER).toMatch(/charges/i);
    expect(AI_REVIEW_DISCLAIMER).toMatch(/office decides/i);
  });
});
