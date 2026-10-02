import {
  compareItem,
  compareItems,
  itemVerdict,
  nameList,
  type ChecklistRow,
  type ItemSide,
} from '../src/admin/comparison-items';

/**
 * Move-in against move-out, one checklist item at a time (2026-10-03). The
 * grades below are 5819 Flower Gate Dr's entrance and kitchen as the two
 * inspections recorded them, where counting defects per room called every room
 * "uncertain".
 */

const sound: ItemSide = { clean: true, undamaged: true, working: true, comment: null };
const damaged: ItemSide = { clean: true, undamaged: false, working: true, comment: null };
const ungraded: ItemSide = { clean: null, undamaged: null, working: null, comment: null };

function row(
  id: string,
  label: string,
  grades: [boolean | null, boolean | null, boolean | null],
  extra: { comment?: string; keywords?: string[]; responseType?: string } = {},
): ChecklistRow {
  return {
    isClean: grades[0],
    isUndamaged: grades[1],
    isWorking: grades[2],
    comment: extra.comment ?? null,
    checklistItem: {
      id,
      label,
      keywords: extra.keywords ?? [],
      responseType: extra.responseType ?? 'STATUS',
    },
  };
}

describe('one item, move-in against move-out', () => {
  it('is new damage only when the move-in graded it sound', () => {
    expect(compareItem(sound, damaged).change).toBe('NEW_DAMAGE');
    expect(compareItem(damaged, damaged).change).toBe('ALREADY_DAMAGED');
    expect(compareItem(damaged, sound).change).toBe('REPAIRED');
    expect(compareItem(sound, sound).change).toBe('NO_CHANGE');
  });

  it('cannot call damage new against a move-in that never graded the item', () => {
    expect(compareItem(ungraded, damaged).change).toBe('NO_BASELINE');
    expect(compareItem(null, damaged).change).toBe('NO_BASELINE');
    expect(compareItem(damaged, ungraded).change).toBe('NOT_GRADED');
  });

  it('counts not working as damage, and dirt as cleaning rather than damage', () => {
    expect(compareItem(sound, { ...sound, working: false }).change).toBe('NEW_DAMAGE');
    const dirty = { ...sound, clean: false };
    expect(compareItem(sound, dirty)).toEqual({ change: 'NO_CHANGE', cleaning: 'NEEDS_CLEANING' });
    expect(compareItem(dirty, dirty)).toEqual({ change: 'NO_CHANGE', cleaning: 'ALREADY_DIRTY' });
  });
});

/** Flower Gate's entrance: the move-in (2025-06-12, imported) and the move-out (2026-10-01). */
const ENTRANCE_MOVE_IN = [
  row('doors', 'Doors and locks', [false, true, true], { comment: 'Door need to be painting', keywords: ['door', 'lock'] }),
  row('walls', 'Walls and ceilings', [false, true, true], { keywords: ['wall', 'ceiling'] }),
  row('floor', 'Floor and coverings', [true, false, true], { keywords: ['floor', 'carpet'] }),
  row('windows', 'Windows and locks', [true, true, true], { keywords: ['window'] }),
  row('lights', 'Lights and power points', [true, true, true], { keywords: ['light'] }),
];
const ENTRANCE_MOVE_OUT = [
  row('doors', 'Doors and locks', [false, false, false], { keywords: ['door', 'lock'] }),
  row('walls', 'Walls and ceilings', [false, false, false], { keywords: ['wall', 'ceiling'] }),
  row('floor', 'Floor and coverings', [false, false, false], { keywords: ['floor', 'carpet'] }),
  row('windows', 'Windows and locks', [false, false, false], { keywords: ['window'] }),
  row('lights', 'Lights and power points', [true, true, true], { keywords: ['light'] }),
];

describe("a room's items, paired", () => {
  it('pairs by item, in the move-out’s order, keeping both grades and the comment', () => {
    const items = compareItems(ENTRANCE_MOVE_IN, ENTRANCE_MOVE_OUT);

    expect(items.map((item) => [item.label, item.change, item.cleaning])).toEqual([
      ['Doors and locks', 'NEW_DAMAGE', 'ALREADY_DIRTY'],
      ['Walls and ceilings', 'NEW_DAMAGE', 'ALREADY_DIRTY'],
      ['Floor and coverings', 'ALREADY_DAMAGED', 'NEEDS_CLEANING'],
      ['Windows and locks', 'NEW_DAMAGE', 'NEEDS_CLEANING'],
      ['Lights and power points', 'NO_CHANGE', null],
    ]);
    expect(items[0].moveIn?.comment).toBe('Door need to be painting');
  });

  it('adds what only the move-in graded, and leaves readings and text alone', () => {
    const items = compareItems(
      [...ENTRANCE_MOVE_IN, row('micro', 'Microwave', [false, false, false])],
      [...ENTRANCE_MOVE_OUT, row('temp', 'Supply air temperature', [null, null, null], { responseType: 'READING' })],
    );

    expect(items.at(-1)).toMatchObject({ label: 'Microwave', moveOut: null, change: 'NOT_GRADED' });
    expect(items.some((item) => item.label === 'Supply air temperature')).toBe(false);
  });
});

describe("a room's verdict from its items", () => {
  it('names what is new and what was already there, and what needs cleaning', () => {
    const verdict = itemVerdict(compareItems(ENTRANCE_MOVE_IN, ENTRANCE_MOVE_OUT), [], false);

    expect(verdict).toEqual({
      classification: 'NEW_DAMAGE',
      requiresReview: true,
      summary:
        'New since move-in: Doors and locks, Walls and ceilings, Windows and locks. Already damaged at move-in: Floor and coverings. Needs cleaning: Floor and coverings, Windows and locks.',
      aiNote: null,
    });
  });

  it('calls a room unchanged when its only damage was already recorded at move-in', () => {
    const verdict = itemVerdict(
      compareItems(
        [row('floor', 'Floor and coverings', [true, false, true])],
        [row('floor', 'Floor and coverings', [true, false, true])],
      ),
      [],
      false,
    );

    expect(verdict).toMatchObject({
      classification: 'UNCHANGED',
      requiresReview: false,
      summary: 'Already damaged at move-in: Floor and coverings.',
    });
  });

  it('sends a room to review when the AI calls already-recorded damage new, without naming the finding', () => {
    const verdict = itemVerdict(
      compareItems(
        [row('floor', 'Floor and coverings', [true, false, true], { keywords: ['floor'] })],
        [row('floor', 'Floor and coverings', [true, false, true], { keywords: ['floor'] })],
      ),
      [
        {
          title: 'Entrance floor tiles cracked',
          category: 'Floor',
          findingType: 'POSSIBLE_NEW_DAMAGE',
          comparisonResult: 'POSSIBLE_NEW_DAMAGE',
        },
      ],
      false,
    );

    expect(verdict?.classification).toBe('REQUIRES_REVIEW');
    expect(verdict?.aiNote).toBe(
      '1 AI finding calls damage new that the move-in already recorded; compare the photographs to see whether it got worse.',
    );
    // The summary is printed on a report a tenant may see: the checklist only.
    expect(verdict?.summary).toBe('Already damaged at move-in: Floor and coverings.');
    expect(verdict?.summary).not.toContain('cracked');
  });

  it('sends a room to review when the AI suggests damage the checklist does not show', () => {
    const verdict = itemVerdict(
      compareItems([row('lights', 'Lights and power points', [true, true, true])], [row('lights', 'Lights and power points', [true, true, true])]),
      [{ title: 'Hole in drywall', category: 'Walls', findingType: 'POSSIBLE_NEW_DAMAGE', comparisonResult: null }],
      false,
    );

    expect(verdict).toMatchObject({
      classification: 'REQUIRES_REVIEW',
      aiNote: '1 AI finding suggests new damage the checklist does not show.',
    });
  });

  it('lets maintenance findings and decided-sound items pass', () => {
    const verdict = itemVerdict(
      compareItems([row('lights', 'Lights and power points', [true, true, true])], [row('lights', 'Lights and power points', [true, true, true])]),
      [{ title: 'Replace HVAC filter', category: 'HVAC', findingType: 'MAINTENANCE', comparisonResult: 'OWNER_MAINTENANCE' }],
      false,
    );

    expect(verdict).toMatchObject({ classification: 'UNCHANGED', requiresReview: false, aiNote: null });
  });

  it('cannot say whether damage is new where the move-in did not grade the item', () => {
    const verdict = itemVerdict(
      compareItems(
        [row('doors', 'Doors and locks', [true, true, true]), row('walls', 'Walls and ceilings', [null, null, null])],
        [row('doors', 'Doors and locks', [true, true, true]), row('walls', 'Walls and ceilings', [true, false, true])],
      ),
      [],
      false,
    );

    expect(verdict).toMatchObject({
      classification: 'REQUIRES_REVIEW',
      summary: 'Damaged at move-out, but not graded at move-in: Walls and ceilings.',
    });
  });

  it('calls a room resolved when only repairs are recorded', () => {
    const verdict = itemVerdict(
      compareItems([row('walls', 'Walls and ceilings', [true, false, true])], [row('walls', 'Walls and ceilings', [true, true, true])]),
      [],
      false,
    );

    expect(verdict).toMatchObject({ classification: 'RESOLVED', requiresReview: false });
  });

  it('still asks for a look at a room paired only by its category', () => {
    const items = compareItems([row('lights', 'Lights', [true, true, true])], [row('lights', 'Lights', [true, true, true])]);
    expect(itemVerdict(items, [], true)).toMatchObject({ classification: 'REQUIRES_REVIEW' });
  });

  it('has no verdict when no item was graded at both inspections', () => {
    expect(
      itemVerdict(compareItems([], [row('floor', 'Floor and coverings', [true, false, true])]), [], false),
    ).toBeNull();
  });

  it('keeps a long list readable', () => {
    expect(nameList(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toBe('a, b, c, d, e, f and 2 more');
  });
});
