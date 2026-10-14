import type { GroupSuggestion } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { addedText, changesSummary, leftReasonText, roomText, suggestionTitle } from './package-changes';

/** The words for what changed in the benefit package under a template (2026-10-15). */

describe('why a property left, in words', () => {
  it('says the office’s own switches with the Texas date and who', () => {
    expect(
      leftReasonText({ code: 'MANAGEMENT_ENDED', since: '2026-10-14T03:00:00.000Z', by: 'Ann', detail: null }),
      // 03:00 UTC on the 14th is still the 13th in Texas.
    ).toBe('Owner ended the management on Oct 13, 2026 by Ann');
  });

  it('says what the tenant report says instead of Yes', () => {
    expect(leftReasonText({ code: 'NOT_ENROLLED', since: null, by: null, detail: 'No, Not Verified' })).toBe(
      'Not enrolled on the tenant report: it says No, Not Verified',
    );
  });

  it('names the zone the package does not cover', () => {
    expect(leftReasonText({ code: 'ZONE_EXCLUDED', since: null, by: null, detail: 'Zone 5' })).toBe(
      'Zone 5 is not part of the benefit package',
    );
  });

  it('dates a lease that left the report, when it can', () => {
    expect(leftReasonText({ code: 'NO_ACTIVE_LEASE', since: null, by: null, detail: null })).toBe('No lease on the tenant report');
    expect(leftReasonText({ code: 'NO_ACTIVE_LEASE', since: '2026-10-02T15:00:00.000Z', by: null, detail: null })).toBe(
      'No lease on the tenant report since Oct 2, 2026',
    );
  });
});

describe('the summary line', () => {
  it('counts each kind of change that there is, and is empty when there is none', () => {
    const one = { buildingId: 'x' } as never;
    expect(changesSummary({ leavers: [one, one], newcomers: [one], unplaced: [] })).toBe(
      '2 left the package · 1 new, not in a group',
    );
    expect(changesSummary({ leavers: [], newcomers: [], unplaced: [one] })).toBe('1 in a group with no position on the map');
    expect(changesSummary({ leavers: [], newcomers: [], unplaced: [] })).toBeNull();
  });
});

describe('a suggested group', () => {
  const suggestion: GroupSuggestion = {
    group: { id: 'g', position: 3, name: 'Group 3', color: '#e6194b' },
    members: 8,
    target: 10,
    hasRoom: true,
    addedMinutes: 4,
    timing: 'ROAD',
    nearest: { address: '1 Oak St', minutes: 3 },
  };

  it('shows the driving it adds and its room', () => {
    expect(addedText(suggestion)).toBe('+4 min');
    expect(roomText(suggestion)).toBe('8 of 10');
    expect(roomText({ ...suggestion, members: 10, hasRoom: false })).toBe('full');
  });

  it('explains itself on hover, and says when it is only an estimate', () => {
    expect(suggestionTitle(suggestion)).toBe(
      'Adds about 4 min of driving to Group 3 (by road). Nearest in it: 1 Oak St, 3 min away. It has 8 of the 10 properties it is meant to hold.',
    );
    expect(suggestionTitle({ ...suggestion, timing: 'ESTIMATE' })).toContain('estimated in a straight line');
  });
});
