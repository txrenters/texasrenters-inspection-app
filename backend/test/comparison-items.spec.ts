import {
  compareItem,
  compareItems,
  confirmedNewDamage,
  itemVerdict,
  nameList,
  waitingNote,
  type ChecklistRow,
  type FindingSignal,
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

  /**
   * 20906 Greenfield Trl's entrance (2026-10-09): the rooms were paired by name,
   * so each inspection answered its own area's items and no id was shared. Paired
   * by id, all seven rows were listed -- each item twice, "not checked" on one
   * side -- and the damaged floor read "not recorded at move-in".
   */
  it('pairs by name where the two rooms are different areas', () => {
    const items = compareItems(
      [
        row('mi-doors', 'Doors and locks', [true, true, true]),
        row('mi-walls', 'Walls and ceilings', [true, true, true]),
        row('mi-floor', 'Floor and coverings', [true, true, true]),
      ],
      [
        row('mo-floor', 'Floor and coverings', [false, false, false]),
        row('mo-walls', 'Walls and ceilings', [true, true, true]),
        row('mo-doors', 'Doors and locks', [true, true, true]),
        row('mo-lights', 'Lights and power points', [true, true, true]),
      ],
    );

    expect(items.map((item) => [item.itemId, item.label, item.change, item.cleaning])).toEqual([
      ['mo-floor', 'Floor and coverings', 'NEW_DAMAGE', 'NEEDS_CLEANING'],
      ['mo-walls', 'Walls and ceilings', 'NO_CHANGE', null],
      ['mo-doors', 'Doors and locks', 'NO_CHANGE', null],
      ['mo-lights', 'Lights and power points', 'NO_CHANGE', null],
    ]);
    expect(items[3].moveIn).toBeNull();
    expect(itemVerdict(items, [])).toMatchObject({
      classification: 'NEW_DAMAGE',
      summary: 'New since move-in: Floor and coverings. Needs cleaning: Floor and coverings.',
    });
  });

  it('reads "&" as "and" and a plural as its singular', () => {
    const items = compareItems(
      [row('a', 'Walls & ceiling', [true, true, true]), row('b', 'Toilet & Roll Holders', [true, true, true])],
      [row('c', 'Walls and ceilings', [true, false, true]), row('d', 'Toilet and roll holder', [true, true, true])],
    );

    expect(items.map((item) => [item.label, item.change])).toEqual([
      ['Walls and ceilings', 'NEW_DAMAGE'],
      ['Toilet and roll holder', 'NO_CHANGE'],
    ]);
  });

  it('pairs the same item before the same name, each item once', () => {
    const items = compareItems(
      [
        row('front', 'Doors and locks', [true, false, true]),
        row('closet', 'Doors and locks', [true, true, true]),
      ],
      [
        row('closet', 'Doors and locks', [true, true, true]),
        row('patio', 'Doors and locks', [true, false, true]),
      ],
    );

    // The closet door is the same item at both; the patio door takes the one
    // left, rather than the closet's being counted twice.
    expect(items.map((item) => [item.itemId, item.change])).toEqual([
      ['closet', 'NO_CHANGE'],
      ['patio', 'ALREADY_DAMAGED'],
    ]);
  });

  it('leaves differently named items apart', () => {
    const items = compareItems(
      [row('a', 'Garage door and opener', [true, true, true])],
      [row('b', 'Doors and locks', [true, false, true])],
    );

    expect(items.map((item) => [item.label, item.change])).toEqual([
      ['Doors and locks', 'NO_BASELINE'],
      ['Garage door and opener', 'NOT_GRADED'],
    ]);
  });
});

/** A move-out finding as the verdict weighs it: unconfirmed unless said. */
function finding(title: string, extra: Partial<FindingSignal> = {}): FindingSignal {
  return {
    title,
    category: 'Walls',
    findingType: 'POSSIBLE_NEW_DAMAGE',
    comparisonResult: null,
    confirmed: false,
    ...extra,
  };
}

/**
 * Nobody decides a room any more (the office, 2026-10-07): the checklist and
 * the findings the office confirmed from the recording decide it, and where
 * the record cannot, the verdict says so.
 */
describe("a room's verdict from its items", () => {
  it('names what is new and what was already there, and what needs cleaning', () => {
    const verdict = itemVerdict(compareItems(ENTRANCE_MOVE_IN, ENTRANCE_MOVE_OUT), []);

    expect(verdict).toEqual({
      classification: 'NEW_DAMAGE',
      summary:
        'New since move-in: Doors and locks, Walls and ceilings, Windows and locks. Already damaged at move-in: Floor and coverings. Needs cleaning: Floor and coverings, Windows and locks.',
      fromRecording: [],
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
    );

    expect(verdict).toMatchObject({
      classification: 'UNCHANGED',
      summary: 'Already damaged at move-in: Floor and coverings.',
    });
  });

  it('lets an unconfirmed AI finding move nothing, and says it is waiting', () => {
    const verdict = itemVerdict(
      compareItems(
        [row('floor', 'Floor and coverings', [true, false, true], { keywords: ['floor'] })],
        [row('floor', 'Floor and coverings', [true, false, true], { keywords: ['floor'] })],
      ),
      [finding('Entrance floor tiles cracked', { category: 'Floor', comparisonResult: 'POSSIBLE_NEW_DAMAGE' })],
    );

    expect(verdict?.classification).toBe('UNCHANGED');
    expect(verdict?.aiNote).toBe(
      '1 AI finding of new damage here is waiting to be confirmed from the recording; it joins the report once confirmed.',
    );
    // The summary is printed on a report a tenant may see: nothing unconfirmed.
    expect(verdict?.summary).toBe('Already damaged at move-in: Floor and coverings.');
    expect(verdict?.summary).not.toContain('cracked');
  });

  it('calls damage the office confirmed on an already-damaged item worse than at move-in', () => {
    const verdict = itemVerdict(
      compareItems(
        [row('floor', 'Floor and coverings', [true, false, true], { keywords: ['floor'] })],
        [row('floor', 'Floor and coverings', [true, false, true], { keywords: ['floor'] })],
      ),
      [finding('Floor: tiles cracked through', { category: 'Floor', confirmed: true })],
    );

    expect(verdict).toMatchObject({
      classification: 'WORSENED',
      fromRecording: ['Floor: tiles cracked through'],
      aiNote: null,
    });
    expect(verdict?.summary).toContain(
      'Worse than at move-in, confirmed from the move-out recording: Floor: tiles cracked through.',
    );
  });

  it('calls damage the office confirmed new, where the checklist does not show it', () => {
    const verdict = itemVerdict(
      compareItems(
        [row('lights', 'Lights and power points', [true, true, true])],
        [row('lights', 'Lights and power points', [true, true, true])],
      ),
      [finding('Wall: hole beside the door', { confirmed: true })],
    );

    expect(verdict).toMatchObject({
      classification: 'NEW_DAMAGE',
      fromRecording: ['Wall: hole beside the door'],
      summary: 'Confirmed from the move-out recording: Wall: hole beside the door.',
    });
  });

  it('lets maintenance findings and decided-sound items pass', () => {
    const verdict = itemVerdict(
      compareItems([row('lights', 'Lights and power points', [true, true, true])], [row('lights', 'Lights and power points', [true, true, true])]),
      [finding('Replace HVAC filter', { category: 'HVAC', findingType: 'MAINTENANCE', comparisonResult: 'OWNER_MAINTENANCE', confirmed: true })],
    );

    expect(verdict).toMatchObject({ classification: 'UNCHANGED', aiNote: null, fromRecording: [] });
  });

  it('says it cannot be compared where the move-in did not grade a damaged item', () => {
    const verdict = itemVerdict(
      compareItems(
        [row('doors', 'Doors and locks', [true, true, true]), row('walls', 'Walls and ceilings', [null, null, null])],
        [row('doors', 'Doors and locks', [true, true, true]), row('walls', 'Walls and ceilings', [true, false, true])],
      ),
      [],
    );

    expect(verdict).toMatchObject({
      classification: 'NOT_COMPARABLE',
      summary: 'Damaged at move-out, but not graded at move-in: Walls and ceilings.',
    });
  });

  it('calls a room resolved when only repairs are recorded', () => {
    const verdict = itemVerdict(
      compareItems([row('walls', 'Walls and ceilings', [true, false, true])], [row('walls', 'Walls and ceilings', [true, true, true])]),
      [],
    );

    expect(verdict).toMatchObject({ classification: 'RESOLVED' });
  });

  it('never says "requires review"', () => {
    const cases = [
      itemVerdict(compareItems(ENTRANCE_MOVE_IN, ENTRANCE_MOVE_OUT), [finding('Door: scuffed')]),
      itemVerdict(
        compareItems([row('w', 'Walls', [null, null, null]), row('d', 'Doors', [true, true, true])], [row('w', 'Walls', [true, false, true]), row('d', 'Doors', [true, true, true])]),
        [finding('Walls: hole', { confirmed: true })],
      ),
    ];
    for (const verdict of cases) expect(verdict?.classification).not.toBe('REQUIRES_REVIEW');
  });

  it('has no verdict when no item was graded at both inspections', () => {
    expect(itemVerdict(compareItems([], [row('floor', 'Floor and coverings', [true, false, true])]), [])).toBeNull();
  });

  it('keeps a long list readable', () => {
    expect(nameList(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toBe('a, b, c, d, e, f and 2 more');
  });
});

describe('what the office has still to confirm, for the console', () => {
  it('counts only unconfirmed findings of new damage', () => {
    expect(
      waitingNote([
        finding('Wall: hole'),
        finding('Door: dent'),
        finding('Floor: crack', { confirmed: true }),
        finding('Filter', { findingType: 'MAINTENANCE' }),
      ]),
    ).toBe(
      '2 AI findings of new damage here are waiting to be confirmed from the recording; they join the report once confirmed.',
    );
    expect(waitingNote([finding('Floor: crack', { confirmed: true })])).toBeNull();
  });

  it('names what the office confirmed as new', () => {
    expect(
      confirmedNewDamage([finding('Wall: hole', { confirmed: true }), finding('Door: dent')]),
    ).toEqual(['Wall: hole']);
  });
});
