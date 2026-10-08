import type { AdminAreaComparison, AdminComparisonItem } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { changeMeta, findingStatus, gradeText, itemTotals } from './comparison-items';

/** How a checklist item compared between move-in and move-out reads on screen. */

describe('one side’s grades in words', () => {
  it('says what was wrong, and dirt apart from damage', () => {
    expect(gradeText({ clean: false, undamaged: false, working: false, comment: null })).toBe(
      'Damaged, not working · dirty',
    );
    expect(gradeText({ clean: true, undamaged: false, working: true, comment: null })).toBe('Damaged');
    expect(gradeText({ clean: null, undamaged: null, working: false, comment: null })).toBe('Not working');
  });

  // "Good", the report's word (2026-10-09): "sound" is an inspector's.
  it('says good, or only clean or dirty when that is all that was graded', () => {
    expect(gradeText({ clean: true, undamaged: true, working: true, comment: null })).toBe('Good');
    expect(gradeText({ clean: true, undamaged: null, working: null, comment: null })).toBe('Clean');
    expect(gradeText({ clean: false, undamaged: null, working: null, comment: null })).toBe('Dirty');
  });

  it('says not graded rather than inventing a grade', () => {
    expect(gradeText(null)).toBe('Not graded');
    expect(gradeText({ clean: null, undamaged: null, working: null, comment: null })).toBe('Not graded');
  });
});

describe('totals across the rooms', () => {
  const item = (change: AdminComparisonItem['change'], cleaning: AdminComparisonItem['cleaning'] = null) =>
    ({ itemId: change, label: change, moveIn: null, moveOut: null, change, cleaning, findings: [] }) as AdminComparisonItem;
  const room = (items: AdminComparisonItem[]) => ({ items }) as AdminAreaComparison;

  it('counts new items and the rooms they are in, and what needs cleaning', () => {
    expect(
      itemTotals([
        room([item('NEW_DAMAGE'), item('NEW_DAMAGE', 'NEEDS_CLEANING'), item('ALREADY_DAMAGED')]),
        room([item('NO_BASELINE'), item('NO_CHANGE', 'NEEDS_CLEANING')]),
        room([]),
      ]),
    ).toEqual({ fresh: 2, freshRooms: 1, existing: 1, unknown: 1, cleaning: 2 });
  });
});

describe('a finding’s decision in a word', () => {
  it('reads as the review screen says it', () => {
    expect(findingStatus('PENDING_REVIEW')).toBe('Needs review');
    expect(findingStatus('APPROVED')).toBe('Approved');
  });
});

describe('the change, as the table names it', () => {
  it('never claims no change against a move-in that did not grade the item', () => {
    const sound = { clean: true, undamaged: true, working: true, comment: null };
    expect(changeMeta({ change: 'NO_CHANGE', moveIn: sound }).label).toBe('No change');
    expect(changeMeta({ change: 'NO_CHANGE', moveIn: null }).label).toBe('Sound at move-out');
    expect(
      changeMeta({ change: 'NO_CHANGE', moveIn: { clean: true, undamaged: null, working: null, comment: null } }).label,
    ).toBe('Sound at move-out');
    expect(changeMeta({ change: 'NEW_DAMAGE', moveIn: sound }).label).toBe('New since move-in');
  });
});
