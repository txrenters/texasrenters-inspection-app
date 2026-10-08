import { describe, expect, it } from 'vitest';

import type { ComparisonReport, ComparisonReportArea } from '../src/contracts/admin.js';
import { buildComparisonView, comparisonGradeText, comparisonMarks } from '../src/report/comparison-view.js';

/**
 * The move-in / move-out comparison as an owner or tenant reads it (the office,
 * 2026-10-06): the words a share link, its PDF and the console's preview all
 * print, decided once.
 */

const sound = { clean: true, undamaged: true, working: true, comment: null };
const damaged = { clean: true, undamaged: false, working: true, comment: 'Two holes by the door' };
const dirty = { clean: false, undamaged: true, working: true, comment: null };

function side(name: string, extra: Partial<ComparisonReportArea['moveIn'] & object> = {}) {
  return {
    roomId: `${name}-room`,
    name,
    floorName: null,
    completionStatus: 'COMPLETED',
    skipReason: null,
    checklist: [],
    findings: [],
    photos: [],
    ...extra,
  };
}

function area(extra: Partial<ComparisonReportArea> = {}): ComparisonReportArea {
  return {
    id: 'area-kitchen',
    areaName: 'Kitchen',
    floorName: null,
    classification: 'NEW_DAMAGE',
    matchMethod: 'LOCAL_AREA_ID',
    matchConfidence: 1,
    summary: 'New since move-in: Walls and ceilings. Needs cleaning: Oven.',
    items: [
      {
        itemId: 'walls',
        label: 'Walls and ceilings',
        moveIn: sound,
        moveOut: damaged,
        change: 'NEW_DAMAGE',
        cleaning: null,
      },
      { itemId: 'oven', label: 'Oven', moveIn: sound, moveOut: dirty, change: 'NO_CHANGE', cleaning: 'NEEDS_CLEANING' },
      { itemId: 'sink', label: 'Sink', moveIn: sound, moveOut: sound, change: 'NO_CHANGE', cleaning: null },
    ],
    moveIn: side('Kitchen'),
    moveOut: side('Kitchen'),
    ...extra,
  };
}

function report(areas: ComparisonReportArea[]): ComparisonReport {
  return {
    brand: { name: 'TexasRenters.com' },
    property: {
      name: 'Notional Harbor',
      addressLine1: '318 Notional Harbor Ln',
      unitName: null,
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
    },
    comparison: {
      id: 'comparison-1',
      version: 3,
      overallCondition: 'NEW_DAMAGE',
      summary: 'Compared 1 area. Overall: NEW_DAMAGE.',
      // 9 PM in Houston on the 6th: already the 7th in UTC.
      generatedAt: '2026-10-07T02:00:00.000Z',
    },
    moveIn: {
      inspectionId: 'move-in-1',
      type: 'MOVE_IN',
      status: 'COMPLETED',
      scheduledAt: '2025-06-12T00:00:00.000Z',
      completedAt: null,
      inspector: 'Moses',
      templateLabel: 'Entry Inspection',
    },
    moveOut: {
      inspectionId: 'move-out-1',
      type: 'MOVE_OUT',
      status: 'REVIEW_REQUIRED',
      scheduledAt: '2026-10-01T00:00:00.000Z',
      completedAt: '2026-10-02T01:30:00.000Z',
      inspector: 'Moses',
      templateLabel: 'Exit Inspection',
    },
    areas,
    generatedAt: '2026-10-07T02:00:00.000Z',
  };
}

describe('the comparison an owner or tenant reads', () => {
  it('heads it with the property and both inspections, in Texas dates', () => {
    const view = buildComparisonView(report([area()]));

    expect(view.title).toBe('318 Notional Harbor Ln');
    expect(view.subtitle).toBe('Houston, TX, 77002');
    expect(view.moveIn).toEqual({ label: 'Entry Inspection', date: 'Scheduled June 12, 2025', inspector: 'Moses' });
    // Completed 8:30 PM on 1 October in Houston, not the 2nd.
    expect(view.moveOut.date).toBe('Completed October 1, 2026');
    expect(view.generatedLabel).toBe('October 6, 2026');
  });

  it('says how it was drawn, and claims no review nobody made (2026-10-07)', () => {
    const view = buildComparisonView(report([area()]));

    expect(view.disclaimer).toContain('checklists the inspectors recorded');
    expect(view.disclaimer).toContain('confirmed from the move-out recordings');
    expect(view.disclaimer).not.toMatch(/reviewed by|reviewer approved/i);
    expect(JSON.stringify(view)).not.toMatch(/Reviewed by/);
  });

  /**
   * A tenant could not follow the report (2026-10-09). It now opens on what
   * was found, a line each, before any room.
   */
  it('opens on what was found: new damage, cleaning, and what cannot be dated or compared', () => {
    const view = buildComparisonView(
      report([
        area(),
        area({
          id: 'area-garage',
          areaName: 'Garage',
          classification: 'NOT_COMPARABLE',
          summary: '',
          items: [
            { itemId: 'shelves', label: 'Shelving', moveIn: null, moveOut: damaged, change: 'NO_BASELINE', cleaning: null },
            { itemId: 'door', label: 'Doors and locks', moveIn: sound, moveOut: sound, change: 'NO_CHANGE', cleaning: null },
          ],
        }),
        area({ id: 'area-stairs', areaName: 'Stairs', classification: 'MISSING_BASELINE', items: [], moveIn: null }),
      ]),
    );

    expect(view.headline).toBe('New damage in 1 room');
    expect(view.found).toEqual([
      {
        mark: 'damaged',
        lead: 'New damage in 1 room.',
        detail: '1 item was in good condition at move-in and is damaged now.',
      },
      { mark: 'dirty', lead: '1 item needs cleaning', detail: 'in 1 room.' },
      {
        mark: 'none',
        lead: "1 item can't be dated.",
        detail: 'It was damaged at move-out but not checked at move-in.',
      },
      {
        mark: 'none',
        lead: "1 room couldn't be compared.",
        detail: 'It was recorded at only one of the two inspections, and is listed at the end.',
      },
    ]);
    expect(view.key.map((mark) => mark.label)).toEqual(['Good', 'Damaged', 'Dirty', 'Not checked']);
  });

  it('counts only the new items in rooms whose verdict is new damage', () => {
    const view = buildComparisonView(
      report([area(), area({ id: 'area-bath', areaName: 'Bathroom', classification: 'UNCHANGED' })]),
    );

    expect(view.found[0].lead).toBe('New damage in 1 room.');
    expect(view.found[0].detail).toBe('1 item was in good condition at move-in and is damaged now.');
    expect(view.rooms.filter((room) => room.newDamage).map((room) => room.name)).toEqual(['Kitchen']);
  });

  it('lists what the office confirmed from the recording with what is new', () => {
    // No item says so: the office saw it on the move-out recording.
    const view = buildComparisonView(
      report([
        area({
          areaName: 'Bedroom 2',
          items: [],
          summary: 'Damage was recorded at move-out that the move-in did not record.',
          fromRecording: ['Door: hole beside the handle'],
        }),
      ]),
    );
    const room = view.rooms[0];

    expect(room.newItems).toEqual(['Door: hole beside the handle']);
    expect(room.digest).toBe('1 damaged');
    expect(room.sentence).toBe(
      'The move-out recorded damage here that the move-in did not. Our team confirmed from the move-out video: Door: hole beside the handle.',
    );
    expect(view.found[0].detail).toBe('Our team confirmed 1 issue from the move-out video.');
  });

  it('sums up each room in a line for the list of rooms', () => {
    const view = buildComparisonView(
      report([
        area(),
        area({
          id: 'area-yard',
          areaName: 'Outside Area 1',
          classification: 'UNCHANGED',
          items: [
            { itemId: 'lawn', label: 'Lawn and garden', moveIn: sound, moveOut: dirty, change: 'NO_CHANGE', cleaning: 'NEEDS_CLEANING' },
            { itemId: 'gate', label: 'Gates and fences', moveIn: sound, moveOut: dirty, change: 'NO_CHANGE', cleaning: 'NEEDS_CLEANING' },
          ],
        }),
      ]),
    );

    expect(view.rooms.map((room) => [room.name, room.mark, room.digest])).toEqual([
      ['Kitchen', 'damaged', '1 damaged · 1 to clean'],
      ['Outside Area 1', 'good', 'No new damage · 2 to clean'],
    ]);
  });

  it('says each room in plain words, counting what changed', () => {
    const view = buildComparisonView(
      report([
        area({
          items: [
            { itemId: 'a', label: 'Floor', moveIn: sound, moveOut: { ...damaged, clean: false }, change: 'NEW_DAMAGE', cleaning: 'NEEDS_CLEANING' },
            { itemId: 'b', label: 'Walls', moveIn: sound, moveOut: damaged, change: 'NEW_DAMAGE', cleaning: null },
            { itemId: 'c', label: 'Bath', moveIn: damaged, moveOut: sound, change: 'REPAIRED', cleaning: null },
            { itemId: 'd', label: 'Toilet', moveIn: damaged, moveOut: damaged, change: 'ALREADY_DAMAGED', cleaning: null },
          ],
        }),
      ]),
    );

    expect(view.rooms[0].sentence).toBe(
      '2 items were in good condition at move-in and are damaged now. 1 item was already damaged at move-in. 1 item damaged at move-in is in good condition now. 1 item needs cleaning.',
    );
  });

  it('says so plainly when nothing is new', () => {
    const view = buildComparisonView(report([area({ classification: 'UNCHANGED', items: [], summary: '' })]));

    expect(view.headline).toBe('No new damage recorded at move-out');
    expect(view.found[0]).toMatchObject({ mark: 'good', lead: 'No new damage.' });
    expect(view.rooms[0].sentence).toBe('No new damage was recorded at move-out.');
  });

  it('marks each grade with a sign and a word, and shows only the items that changed', () => {
    const room = buildComparisonView(report([area()])).rooms[0];
    const [walls, oven, sink] = room.items;

    expect(walls).toMatchObject({
      label: 'Walls and ceilings',
      moveIn: { marks: [{ kind: 'good', label: 'Good' }], comment: null },
      moveOut: { marks: [{ kind: 'damaged', label: 'Damaged' }], comment: 'Two holes by the door' },
      result: { label: 'New damage', toneName: 'damage' },
      needsCleaning: false,
      changed: true,
    });
    expect(oven).toMatchObject({
      moveOut: {
        marks: [
          { kind: 'good', label: 'Good' },
          { kind: 'dirty', label: 'Dirty' },
        ],
      },
      result: null,
      needsCleaning: true,
      changed: true,
    });
    // Nothing changed and nothing to do: folded into a line.
    expect(sink.changed).toBe(false);
    expect(room.folded).toBe('Sink unchanged.');
    expect(room.foldedCount).toBe(1);
  });

  it('never claims "unchanged" for an item the move-in did not grade', () => {
    const room = buildComparisonView(
      report([
        area({
          items: [
            { itemId: 'blinds', label: 'Blinds', moveIn: null, moveOut: sound, change: 'NO_CHANGE', cleaning: null },
            { itemId: 'alarm', label: 'Smoke alarms', moveIn: sound, moveOut: null, change: 'NOT_GRADED', cleaning: null },
          ],
        }),
      ]),
    ).rooms[0];

    expect(room.items[0].moveIn.marks).toEqual([{ kind: 'none', label: 'Not checked' }]);
    expect(room.folded).toBe('Blinds good at move-out, not checked at move-in. Smoke alarms not checked at move-out.');
  });

  it('says why damage cannot be dated, in plain words', () => {
    const [noCondition, notTheSame] = buildComparisonView(
      report([
        area({ id: 'a1', classification: 'NOT_COMPARABLE', items: [], summary: 'whatever the rules said' }),
        area({
          id: 'a2',
          classification: 'NOT_COMPARABLE',
          items: [],
          summary: '',
          moveIn: side('Kitchen', {
            checklist: [{ id: 'f', label: 'Floor', isClean: true, isUndamaged: false, isWorking: null, comment: null }],
          }),
        }),
      ]),
    ).rooms;

    expect(noCondition.verdict).toBe("Can't tell what's new");
    expect(noCondition.sentence).toBe(
      "Damage was recorded at move-out, but the move-in recorded no condition for this room, so we can't tell whether it is new.",
    );
    expect(notTheSame.sentence).toBe(
      "Damage was recorded at both inspections, but not on the same items, so we can't tell what is new.",
    );
    expect(notTheSame.newDamage).toBe(false);
  });

  it('never prints match details or a stale sentence written for a reviewer', () => {
    const view = buildComparisonView(
      report([
        area({
          classification: 'NEW_DAMAGE',
          items: [],
          summary: 'Automated comparison is uncertain — needs a human review.',
          matchMethod: 'AREA_CATEGORY',
          matchConfidence: 0.5,
        }),
      ]),
    );
    const text = JSON.stringify(view);

    expect(view.rooms[0].sentence).toBe('The move-out recorded damage here that the move-in did not.');
    expect(text).not.toContain('human review');
    expect(text).not.toContain('AREA_CATEGORY');
    expect(text).not.toContain('Overall: NEW_DAMAGE');
  });

  it('keeps the rooms the two inspections do not share for the end, saying why and what was recorded', () => {
    const view = buildComparisonView(
      report([
        area({
          id: 'a1',
          areaName: 'Formal Dining Room',
          classification: 'MISSING_BASELINE',
          items: [],
          moveIn: null,
          moveOut: side('Formal Dining Room', {
            checklist: [
              { id: 'f', label: 'Floor', isClean: false, isUndamaged: false, isWorking: false, comment: null },
              { id: 'b', label: 'Blinds', isClean: true, isUndamaged: true, isWorking: true, comment: null },
            ],
          }),
        }),
        area({
          id: 'a2',
          areaName: 'Garage',
          classification: 'MISSING_MOVE_OUT_EVIDENCE',
          items: [],
          moveOut: side('Garage', { completionStatus: 'SKIPPED', skipReason: 'Locked, no key left' }),
        }),
        area({
          id: 'a3',
          areaName: 'Dining Area',
          classification: 'MISSING_MOVE_OUT_EVIDENCE',
          items: [],
          moveIn: side('Dining Area', {
            checklist: [{ id: 'w', label: 'Walls', isClean: true, isUndamaged: true, isWorking: true, comment: null }],
          }),
          moveOut: null,
        }),
      ]),
    );

    expect(view.rooms).toEqual([]);
    expect(view.uncompared.map((room) => [room.name, room.reason, room.recordedAt, room.recorded, room.mark])).toEqual([
      ['Formal Dining Room', 'Only in the move-out inspection', 'Move-out', '1 of 2 items damaged, 1 dirty', 'damaged'],
      ['Garage', 'Skipped at move-out: Locked, no key left', 'Move-in', 'Nothing graded', 'none'],
      ['Dining Area', 'Only in the move-in inspection', 'Move-in', 'Its 1 item good', 'good'],
    ]);
    expect(view.found.at(-1)?.lead).toBe("3 rooms couldn't be compared.");
  });

  it('shows each side’s name when a room was paired with a differently named one', () => {
    const room = buildComparisonView(report([area({ moveIn: side('Kitchen / Dining') })])).rooms[0];

    expect(room.moveIn).toMatchObject({ name: 'Kitchen / Dining', renamed: true });
    expect(room.moveOut.renamed).toBe(false);
  });

  it('names a real floor, not the "Added areas" a technician’s own rooms are filed under', () => {
    const [upstairs, added] = buildComparisonView(
      report([area({ id: 'a1', floorName: 'Upstairs' }), area({ id: 'a2', floorName: 'Added areas' })]),
    ).rooms;

    expect(upstairs.floorName).toBe('Upstairs');
    expect(added.floorName).toBeNull();
  });
});

describe('an item’s grades in words', () => {
  it('names damage before dirt, and says nothing it was not told', () => {
    expect(comparisonGradeText({ clean: false, undamaged: false, working: false, comment: null })).toBe(
      'Damaged, not working · dirty',
    );
    expect(comparisonGradeText({ clean: false, undamaged: true, working: true, comment: null })).toBe('Good · dirty');
    expect(comparisonGradeText({ clean: true, undamaged: true, working: true, comment: null })).toBe('Good');
    expect(comparisonGradeText({ clean: true, undamaged: null, working: null, comment: null })).toBe('Clean');
    expect(comparisonGradeText(null)).toBe('Not checked');
    expect(comparisonGradeText(null, 'Not graded')).toBe('Not graded');
    expect(comparisonGradeText({ clean: null, undamaged: null, working: null, comment: null }, 'Not graded')).toBe(
      'Not graded',
    );
  });

  it('gives each grade its signs, condition first', () => {
    expect(comparisonMarks({ clean: false, undamaged: true, working: false })).toEqual([
      { kind: 'damaged', label: 'Not working' },
      { kind: 'dirty', label: 'Dirty' },
    ]);
    expect(comparisonMarks({ clean: false, undamaged: null, working: null })).toEqual([{ kind: 'dirty', label: 'Dirty' }]);
  });
});
