import type { AdminAreaComparison, AdminComparisonItem } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import {
  changeMeta,
  findingStatus,
  gradeText,
  itemChanged,
  itemTotals,
  pairingNote,
  roomDigest,
  roomInFilter,
  waitingCount,
} from './comparison-items';

/** How a checklist item compared between move-in and move-out reads on screen. */

describe('one side’s grades in words', () => {
  it('says what was wrong, and dirt apart from damage', () => {
    expect(gradeText({ clean: false, undamaged: false, working: false, comment: null })).toBe(
      'Damaged, not working · dirty',
    );
    expect(gradeText({ clean: true, undamaged: false, working: true, comment: null })).toBe('Damaged');
    expect(gradeText({ clean: null, undamaged: null, working: false, comment: null })).toBe('Not working');
  });

  it('says sound, or only clean or dirty when that is all that was graded', () => {
    expect(gradeText({ clean: true, undamaged: true, working: true, comment: null })).toBe('Sound');
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
  const room = (classification: string, items: AdminComparisonItem[], fromRecording: string[] = []) =>
    ({ classification, items, fromRecording }) as AdminAreaComparison;

  it('counts new items in the rooms whose verdict is new damage, as the report does', () => {
    expect(
      itemTotals([
        room('NEW_DAMAGE', [item('NEW_DAMAGE'), item('NEW_DAMAGE', 'NEEDS_CLEANING'), item('ALREADY_DAMAGED')], [
          'Door: hole beside the handle',
        ]),
        room('NOT_COMPARABLE', [item('NO_BASELINE'), item('NO_CHANGE', 'NEEDS_CLEANING')]),
        room('UNCHANGED', []),
      ]),
    ).toEqual({ fresh: 3, freshRooms: 1, existing: 1, unknown: 1, cleaning: 2 });
  });
});

describe('a room, for the list', () => {
  const finding = (reviewStatus: string) => ({
    id: reviewStatus,
    title: 'x',
    severity: 'LOW',
    findingType: 'POSSIBLE_NEW_DAMAGE',
    reviewStatus,
    source: 'AI_VISION',
  });
  const item = (change: AdminComparisonItem['change'], extra: Partial<AdminComparisonItem> = {}) =>
    ({ itemId: change, label: change, moveIn: null, moveOut: null, change, cleaning: null, findings: [], ...extra }) as AdminComparisonItem;
  const area = (fields: Partial<AdminAreaComparison>) =>
    ({
      id: 'a',
      areaName: 'Kitchen',
      classification: 'NEW_DAMAGE',
      matchMethod: 'LOCAL_AREA_ID',
      matchConfidence: 1,
      items: [],
      ...fields,
    }) as AdminAreaComparison;

  it('sorts rooms into the filters, the one-side rooms apart', () => {
    const damaged = area({ items: [item('NEW_DAMAGE')] });
    const cleaningOnly = area({ classification: 'UNCHANGED', items: [item('NO_CHANGE', { cleaning: 'NEEDS_CLEANING' })] });
    const quiet = area({ classification: 'UNCHANGED', items: [item('NO_CHANGE')] });
    const oneSide = area({ classification: 'MISSING_BASELINE' });
    const undated = area({ classification: 'NOT_COMPARABLE' });
    const inFilter = (filter: Parameters<typeof roomInFilter>[1]) =>
      [damaged, cleaningOnly, quiet, oneSide, undated].map((room) => roomInFilter(room, filter));

    expect(inFilter('attention')).toEqual([true, true, false, false, true]);
    expect(inFilter('damage')).toEqual([true, false, false, false, false]);
    expect(inFilter('cleaning')).toEqual([false, true, false, false, false]);
    expect(inFilter('oneSide')).toEqual([false, false, false, true, false]);
    expect(inFilter('all')).toEqual([true, true, true, true, true]);
  });

  it('says what changed in a few words', () => {
    expect(
      roomDigest(
        area({
          fromRecording: ['Carpet very dirty'],
          items: [
            item('NEW_DAMAGE', { cleaning: 'NEEDS_CLEANING' }),
            item('NEW_DAMAGE'),
            item('ALREADY_DAMAGED'),
            item('REPAIRED'),
          ],
        }),
      ),
    ).toEqual(['2 new', '1 confirmed from video', '1 already at move-in', '1 repaired', '1 to clean']);
    expect(roomDigest(area({ classification: 'UNCHANGED', items: [item('NO_CHANGE')] }))).toEqual(['Nothing changed']);
    expect(roomDigest(area({ classification: 'MISSING_BASELINE' }))).toEqual(['Move-out only']);
    expect(roomDigest(area({ classification: 'MISSING_MOVE_OUT_EVIDENCE', moveOutAreaId: null }))).toEqual([
      'Move-in only',
    ]);
  });

  it('shows a room only what changed, and counts what is still to confirm', () => {
    const quietButConfirmed = item('NO_CHANGE', { findings: [finding('APPROVED')] });
    expect(itemChanged(item('NO_CHANGE'))).toBe(false);
    expect(itemChanged(item('NOT_GRADED'))).toBe(false);
    expect(itemChanged(item('NO_CHANGE', { cleaning: 'NEEDS_CLEANING' }))).toBe(true);
    expect(itemChanged(quietButConfirmed)).toBe(true);
    expect(itemChanged(item('NO_CHANGE', { findings: [finding('PENDING_REVIEW')] }))).toBe(false);
    expect(
      waitingCount(
        area({
          items: [quietButConfirmed, item('NEW_DAMAGE', { findings: [finding('PENDING_REVIEW')] })],
          otherFindings: [finding('PENDING_REVIEW'), finding('APPROVED')],
        }),
      ),
    ).toBe(2);
  });

  it('names the move-in room only when it is not plainly the same one', () => {
    expect(
      pairingNote(area({ areaName: 'Gameroom', moveInAreaName: 'Game Room', matchMethod: 'NORMALIZED_NAME' })),
    ).toBeNull();
    expect(
      pairingNote(area({ areaName: 'Downstairs living room', moveInAreaName: 'Living Room', matchMethod: 'AI_SUGGESTED' })),
    ).toEqual({ name: 'Living Room', check: 'by AI' });
    expect(
      pairingNote(area({ areaName: 'Office. Front Of The Home.', moveInAreaName: 'Office', matchMethod: 'APPROVED_ALIAS' })),
    ).toEqual({ name: 'Office', check: null });
    expect(pairingNote(area({ moveInAreaName: null }))).toBeNull();
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
    expect(changeMeta({ change: 'NO_CHANGE', moveIn: null }).label).toBe('Good at move-out');
    expect(
      changeMeta({ change: 'NO_CHANGE', moveIn: { clean: true, undamaged: null, working: null, comment: null } }).label,
    ).toBe('Good at move-out');
    expect(changeMeta({ change: 'NEW_DAMAGE', moveIn: sound }).label).toBe('New since move-in');
  });
});
