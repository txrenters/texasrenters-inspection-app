import { describe, expect, it } from 'vitest';

import type { ComparisonReport, ComparisonReportArea } from '../src/contracts/admin.js';
import { buildComparisonView, comparisonGradeText } from '../src/report/comparison-view.js';

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
    originalClassification: null,
    overrideReason: null,
    matchMethod: 'LOCAL_AREA_ID',
    matchConfidence: 1,
    requiresReview: true,
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

function report(areas: ComparisonReportArea[], extra: Partial<ComparisonReport['comparison']> = {}): ComparisonReport {
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
      status: 'APPROVED',
      version: 3,
      overallCondition: 'NEW_DAMAGE',
      requiresReviewCount: 1,
      summary: 'Compared 1 area. 1 needs human review. Overall: NEW_DAMAGE.',
      // 9 PM in Houston on the 6th: already the 7th in UTC.
      generatedAt: '2026-10-07T02:00:00.000Z',
      reviewedByName: 'Ana Lopez',
      reviewedAt: '2026-10-07T02:00:00.000Z',
      reviewNote: null,
      ...extra,
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
  it('heads it with the property, both inspections, and who approved it, in Texas dates', () => {
    const view = buildComparisonView(report([area()]));

    expect(view.title).toBe('318 Notional Harbor Ln');
    expect(view.subtitle).toBe('Houston, TX, 77002');
    expect(view.moveIn).toEqual({ label: 'Entry Inspection', date: 'Scheduled June 12, 2025', inspector: 'Moses' });
    // Completed 8:30 PM on 1 October in Houston, not the 2nd.
    expect(view.moveOut.date).toBe('Completed October 1, 2026');
    expect(view.reviewedLabel).toBe('Reviewed by Ana Lopez on October 6, 2026');
    expect(view.generatedLabel).toBe('October 6, 2026');
    expect(view.draft).toBe(false);
  });

  it('counts only the new items in rooms whose verdict is new damage', () => {
    const view = buildComparisonView(
      report([
        area(),
        // The office found the bathroom's "new" item already there at move-in.
        area({
          id: 'area-bath',
          areaName: 'Bathroom',
          classification: 'UNCHANGED',
          originalClassification: 'NEW_DAMAGE',
          overrideReason: 'Same crack in the move-in photographs.',
        }),
      ]),
    );

    expect(view.stats.find((stat) => stat.label === 'Items new since move-in')?.value).toBe(1);
    expect(view.newDamage.map((room) => room.name)).toEqual(['Kitchen']);
  });

  it('says a skipped side once, by its reason', () => {
    const room = buildComparisonView(
      report([
        area({
          classification: 'MISSING_MOVE_OUT_EVIDENCE',
          items: [],
          moveOut: side('Kitchen', { completionStatus: 'SKIPPED', skipReason: 'Locked' }),
        }),
      ]),
    ).rooms[0];

    expect(room.moveOut).toMatchObject({ skipped: true, statusLabel: 'Skipped', skipReason: 'Locked' });
    expect(room.moveIn.skipped).toBe(false);
  });

  it('sums up what is new and what needs cleaning, room by room', () => {
    const view = buildComparisonView(
      report([area(), area({ id: 'area-bath', areaName: 'Bathroom', classification: 'UNCHANGED', items: [], summary: '' })]),
    );

    expect(view.headline).toBe('New damage recorded in 1 room');
    expect(view.newDamage).toEqual([{ id: 'area-kitchen', name: 'Kitchen', items: ['Walls and ceilings'] }]);
    expect(view.cleaning).toEqual([{ id: 'area-kitchen', name: 'Kitchen', items: ['Oven'] }]);
    expect(view.stats.map((stat) => [stat.label, stat.value])).toEqual([
      ['Rooms compared', 2],
      ['Rooms with new damage', 1],
      ['Items new since move-in', 1],
      ['Items needing cleaning', 1],
    ]);
  });

  it('says so plainly when nothing is new', () => {
    const view = buildComparisonView(report([area({ classification: 'UNCHANGED', items: [], summary: '' })]));

    expect(view.headline).toBe('No new damage recorded at move-out');
    expect(view.rooms[0].sentence).toBe('No new damage was recorded at move-out.');
  });

  it('prints each item at both inspections, what changed, and the technician’s words', () => {
    const [walls, oven, sink] = buildComparisonView(report([area()])).rooms[0].items;

    expect(walls).toMatchObject({
      label: 'Walls and ceilings',
      moveIn: 'Sound',
      moveOut: 'Damaged',
      moveOutComment: 'Two holes by the door',
      change: 'New since move-in',
      cleaning: null,
      quiet: false,
    });
    expect(oven).toMatchObject({ moveOut: 'Sound · dirty', change: 'No change', cleaning: 'Needs cleaning', quiet: false });
    // Nothing changed and nothing to do: printed, but quieter.
    expect(sink).toMatchObject({ change: 'No change', quiet: true });
  });

  it('never claims "no change" for an item the move-in did not grade', () => {
    const view = buildComparisonView(
      report([
        area({
          items: [{ itemId: 'blinds', label: 'Blinds', moveIn: null, moveOut: sound, change: 'NO_CHANGE', cleaning: null }],
        }),
      ]),
    );

    expect(view.rooms[0].items[0]).toMatchObject({ moveIn: 'Not checked', change: 'Sound at move-out' });
  });

  it('prints a reviewer’s changed verdict with the reason, beside the checklist it departs from', () => {
    const room = buildComparisonView(
      report([
        area({
          classification: 'UNCHANGED',
          originalClassification: 'NEW_DAMAGE',
          overrideReason: 'The move-in photographs show the same holes.',
        }),
      ]),
    ).rooms[0];

    expect(room.verdict).toBe('No new damage');
    expect(room.changedFrom).toBe('New damage');
    expect(room.officeNote).toBe('The move-in photographs show the same holes.');
    // The checklist's own words stay, so the reader sees what was set aside.
    expect(room.sentence).toBe('New since move-in: Walls and ceilings. Needs cleaning: Oven.');
    expect(room.newDamage).toBe(false);
  });

  it('never prints the machine’s note to the reviewer, nor match details', () => {
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

    expect(view.rooms[0].sentence).toBe('Damage was recorded at move-out that the move-in did not record.');
    expect(text).not.toContain('human review');
    expect(text).not.toContain('AREA_CATEGORY');
    expect(text).not.toContain('Overall: NEW_DAMAGE');
  });

  it('says why a room has nothing to compare, the skip reason included', () => {
    const view = buildComparisonView(
      report([
        area({ id: 'a1', classification: 'MISSING_BASELINE', items: [], moveIn: null }),
        area({
          id: 'a2',
          classification: 'MISSING_MOVE_OUT_EVIDENCE',
          items: [],
          moveOut: side('Garage', { completionStatus: 'SKIPPED', skipReason: 'Locked, no key left' }),
        }),
        area({ id: 'a3', classification: 'MISSING_MOVE_OUT_EVIDENCE', items: [], moveOut: null }),
      ]),
    );

    expect(view.rooms.map((room) => [room.verdict, room.sentence])).toEqual([
      ['Not recorded at move-in', 'The move-in inspection has no matching room, so there is nothing to compare it with.'],
      ['Not inspected at move-out', 'Not inspected at move-out: Locked, no key left.'],
      ['Not inspected at move-out', 'Recorded at move-in; this room was not part of the move-out inspection.'],
    ]);
    expect(view.rooms[0].moveIn).toMatchObject({ present: false, statusLabel: 'Not in the move-in inspection' });
  });

  it('shows each side’s name when a room was paired with a differently named one', () => {
    const room = buildComparisonView(report([area({ moveIn: side('Kitchen / Dining') })])).rooms[0];

    expect(room.moveIn).toMatchObject({ name: 'Kitchen / Dining', renamed: true });
    expect(room.moveOut.renamed).toBe(false);
  });

  it('is a preview, with no approval to print, until the comparison is approved', () => {
    const view = buildComparisonView(report([area()], { status: 'UNDER_REVIEW', reviewedByName: 'Ana Lopez' }));

    expect(view.draft).toBe(true);
    expect(view.reviewedLabel).toBeNull();
  });
});

describe('an item’s grades in words', () => {
  it('names damage before dirt, and says nothing it was not told', () => {
    expect(comparisonGradeText({ clean: false, undamaged: false, working: false, comment: null })).toBe(
      'Damaged, not working · dirty',
    );
    expect(comparisonGradeText({ clean: true, undamaged: null, working: null, comment: null })).toBe('Clean');
    expect(comparisonGradeText(null)).toBe('Not checked');
    expect(comparisonGradeText(null, 'Not graded')).toBe('Not graded');
  });
});
