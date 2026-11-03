import type { GroupSuggestion, GroupTemplateChanges, GroupTemplateOp } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import {
  addedText,
  changesSince,
  changesSummary,
  leftReasonText,
  newcomerSince,
  NOTHING_REMOVED,
  removedBy,
  roomText,
  suggestionTitle,
} from './package-changes';

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

  it('dates a report that stopped saying Yes by the history, which saw it', () => {
    expect(leftReasonText({ code: 'NOT_ENROLLED', since: '2026-10-13T08:00:00.000Z', by: null, detail: 'No' })).toBe(
      'Not enrolled on the tenant report since Oct 13, 2026: it says No',
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

describe('when a newcomer came into the package', () => {
  it('says the day it joined, where the history saw it', () => {
    expect(newcomerSince({ joinedAt: '2026-10-14T15:00:00.000Z', firstOnReport: '2026-07-01T15:00:00.000Z' })).toBe(
      'joined the package on Oct 14, 2026',
    );
  });

  it('falls back to how long it has been on the tenant report, and to nothing', () => {
    expect(newcomerSince({ joinedAt: null, firstOnReport: '2026-07-01T15:00:00.000Z' })).toBe('on the tenant report since Jul 1, 2026');
    expect(newcomerSince({ joinedAt: null, firstOnReport: null })).toBeNull();
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

/**
 * Read once, then kept true on the page (the Mapbox invoice for October 2026):
 * every read is timed on the road and billed, and the Group maker used to read
 * it again after every click.
 */
describe('the package changes, since they were read', () => {
  const NORTH = { id: 'g-north', position: 1, name: 'North', color: '#e6194b' };
  const SOUTH = { id: 'g-south', position: 2, name: 'South', color: '#3cb44b' };
  const fits = (group: typeof NORTH) =>
    ({ group, members: 2, target: 9, hasRoom: true, addedMinutes: 4, timing: 'ROAD', nearest: null }) as const;
  const READ: GroupTemplateChanges = {
    templateId: 't-1',
    revision: 4,
    leavers: [
      { buildingId: 'gone-n', address: '1 Gone Ave', group: NORTH, reasons: [] },
      { buildingId: 'gone-s', address: '2 Gone Ave', group: SOUTH, reasons: [] },
    ],
    unplaced: [{ buildingId: 'lost', address: '3 Lost Ln', group: SOUTH }],
    newcomers: [
      { buildingId: 'new-1', address: '4 New St', city: null, zone: null, firstOnReport: null, joinedAt: null, suggestions: [fits(NORTH), fits(SOUTH)] },
      { buildingId: 'new-2', address: '5 New St', city: null, zone: null, firstOnReport: null, joinedAt: null, suggestions: [fits(NORTH)] },
    ],
  };

  it('is the read itself when nothing has happened since', () => {
    expect(changesSince(READ, new Set(), NOTHING_REMOVED)).toEqual(READ);
  });

  it('takes a newcomer put in a group off the list', () => {
    const now = changesSince(READ, new Set(['new-1', 'somewhere-else']), NOTHING_REMOVED);
    expect(now.newcomers.map((newcomer) => newcomer.buildingId)).toEqual(['new-2']);
  });

  it('takes off a leaver taken out of its group', () => {
    const removed = removedBy(NOTHING_REMOVED, [{ type: 'stop.remove', stop: 'gone-n' }]);
    expect(changesSince(READ, new Set(), removed).leavers.map((leaver) => leaver.buildingId)).toEqual(['gone-s']);
  });

  it('takes off whatever was in a deleted group, and stops offering that group', () => {
    const removed = removedBy(NOTHING_REMOVED, [{ type: 'group.delete', groupId: SOUTH.id }]);
    const now = changesSince(READ, new Set(), removed);

    expect(now.leavers.map((leaver) => leaver.buildingId)).toEqual(['gone-n']);
    expect(now.unplaced).toEqual([]);
    expect(now.newcomers[0]!.suggestions.map((suggestion) => suggestion.group.id)).toEqual([NORTH.id]);
  });

  it('forgets a removal that was put back', () => {
    const out = removedBy(NOTHING_REMOVED, [{ type: 'stop.remove', stop: 'gone-n' }]);
    const back = removedBy(out, [{ type: 'stop.add', groupId: NORTH.id, stop: 'gone-n' }]);
    expect(back.stops.has('gone-n')).toBe(false);
  });

  /** A reorder takes nothing out, so the panel has no reason to draw again. */
  it('is the same object after edits that removed nothing', () => {
    const ops: GroupTemplateOp<string>[] = [
      { type: 'stops.order', groupId: NORTH.id, stops: ['a', 'b'] },
      { type: 'stop.add', groupId: NORTH.id, stop: 'c' },
    ];
    expect(removedBy(NOTHING_REMOVED, ops)).toBe(NOTHING_REMOVED);
  });
});
