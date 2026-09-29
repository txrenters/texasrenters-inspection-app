import type { VisitServicesReport } from '@texasrenters/shared';

import {
  filterRows,
  filtersPhoto,
  jobChecklistProblems,
  withAddedFilters,
  withFilterAnswer,
  withFilterInPhoto,
  withFiltersPhoto,
} from '../src/utils/job-tasks';

/**
 * One photograph of every filter, stacked (the office, 2026-09-29), in place of
 * a photograph per register.
 */

// Three registers: two 20x25x1 upstairs and one 12x12x1 downstairs.
const DETAILS = 'Filter Change: 20x25x1 (2 pcs) upstairs hallway; 12x12x1 downstairs + Pest Control';

const empty = (): VisitServicesReport => ({ services: {}, filtersInstalled: [], notes: null });

describe('one photograph of every filter', () => {
  it('answers every register as changed, pointing at the one photograph', () => {
    const report = withFiltersPhoto(empty(), DETAILS, 'snapshot-1');
    const rows = filterRows(DETAILS, report);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.answer).toMatchObject({ changed: true, photoKey: 'snapshot-1', photoId: null });
    }
    expect(report.services.filterChange).toMatchObject({ done: true });
  });

  it('is enough for the filter change to be submitted', () => {
    const report = withFiltersPhoto(empty(), DETAILS, 'snapshot-1');
    const problems = jobChecklistProblems(DETAILS, report);
    expect(problems.some((problem) => /filter/i.test(problem))).toBe(false);
  });

  it('leaves a register somebody declined out of the photograph', () => {
    const declined = withFilterAnswer(
      empty(),
      { size: '12x12x1', location: 'downstairs', slot: 1 },
      { changed: false, reason: 'No access to the closet' },
    );
    const report = withFiltersPhoto(declined, DETAILS, 'snapshot-1');
    const downstairs = filterRows(DETAILS, report).find((row) => row.filter.size === '12x12x1');
    expect(downstairs?.answer).toMatchObject({ changed: false, reason: 'No access to the closet', photoKey: null });
  });

  it('includes filters added on site', () => {
    const added = withAddedFilters(empty(), DETAILS, [{ size: '16x20x1', quantity: 1 }]);
    const report = withFiltersPhoto(added, DETAILS, 'snapshot-1');
    const found = filterRows(DETAILS, report).find((row) => row.filter.size === '16x20x1');
    expect(found?.answer).toMatchObject({ changed: true, photoKey: 'snapshot-1', booked: false });
  });

  it('replaces the old photograph on a retake, id and all', () => {
    // The first photograph has landed: the server filled in its id.
    const first = withFiltersPhoto(empty(), DETAILS, 'snapshot-1');
    const landed = { ...first, filters: first.filters!.map((filter) => ({ ...filter, photoId: 'photo-1' })) };
    const retaken = withFiltersPhoto(landed, DETAILS, 'snapshot-2');
    for (const row of filterRows(DETAILS, retaken)) {
      // A kept photoId would win on the server and the retake would never show.
      expect(row.answer).toMatchObject({ photoKey: 'snapshot-2', photoId: null });
    }
  });

  it('is found again from the rows, sent or not', () => {
    expect(filtersPhoto(filterRows(DETAILS, empty()))).toBeNull();
    const report = withFiltersPhoto(empty(), DETAILS, 'snapshot-1');
    expect(filtersPhoto(filterRows(DETAILS, report))).toEqual({ photoKey: 'snapshot-1', photoId: null });
  });
});

describe('adding every filter found in one go', () => {
  it('adds each size as many times as asked, in slots of its own', () => {
    const report = withAddedFilters(empty(), null, [
      { size: '20x25x1', quantity: 2 },
      { size: '16X20X1', quantity: 1 },
    ]);
    expect(report.filters?.map((filter) => [filter.size, filter.slot, filter.booked, filter.changed])).toEqual([
      ['20x25x1', 1, false, false],
      ['20x25x1', 2, false, false],
      ['16x20x1', 1, false, false],
    ]);
  });

  it('does not collide with a size the visit already listed', () => {
    // The visit lists 12x12x1 "downstairs"; one with no place is its own register.
    const report = withAddedFilters(empty(), DETAILS, [{ size: '12x12x1', quantity: 1 }]);
    expect(filterRows(DETAILS, report)).toHaveLength(4);
  });

  it('stops at the most a job can carry', () => {
    const report = withAddedFilters(empty(), null, [{ size: '20x25x1', quantity: 40 }]);
    expect(report.filters).toHaveLength(12);
  });
});

describe('taking back a "not changed"', () => {
  const downstairs = { size: '12x12x1', location: 'downstairs', slot: 1 };

  it('puts the register back into the photograph that is already there', () => {
    const photographed = withFiltersPhoto(empty(), DETAILS, 'snapshot-1');
    const declined = withFilterAnswer(photographed, downstairs, { changed: false, reason: 'Wrong size brought' });
    const photo = filtersPhoto(filterRows(DETAILS, declined));
    const undone = withFilterInPhoto(declined, downstairs, photo);
    const row = filterRows(DETAILS, undone).find((entry) => entry.filter.size === '12x12x1');
    expect(row?.answer).toMatchObject({ changed: true, reason: null, photoKey: 'snapshot-1' });
  });

  it('leaves it unanswered when there is no photograph yet', () => {
    const declined = withFilterAnswer(empty(), downstairs, { changed: false, reason: 'Wrong size brought' });
    const undone = withFilterInPhoto(declined, downstairs, null);
    const row = filterRows(DETAILS, undone).find((entry) => entry.filter.size === '12x12x1');
    expect(row?.answer).toBeUndefined();
  });

  it('keeps a filter found on site, unanswered, rather than dropping it', () => {
    const added = withAddedFilters(empty(), DETAILS, [{ size: '16x20x1', quantity: 1 }]);
    const filter = { size: '16x20x1', location: null, slot: 1 };
    const declined = withFilterAnswer(added, filter, { changed: false, reason: 'Already clean' });
    const undone = withFilterInPhoto(declined, filter, null);
    const row = filterRows(DETAILS, undone).find((entry) => entry.filter.size === '16x20x1');
    expect(row?.answer).toMatchObject({ changed: false, reason: null, booked: false });
  });
});
