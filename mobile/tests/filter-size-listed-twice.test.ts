import { filterRows, withFilterAnswer } from '../src/utils/job-tasks';

/**
 * A size the visit lists twice, as the console writes it: one entry per
 * register.
 *
 * 5706 Micah Ln, 2026-10-02: "Filter Change: 12x24x1;16x25x1;16x25x1". Both
 * 16x25x1 entries were slot 1, so the phone drew two rows that ticked together,
 * sent one answer, and the Jobber note the office invoices from listed one
 * 16x25x1 where two went in.
 */

const DETAILS = 'Filter Change: 12x24x1;16x25x1;16x25x1 + Pest Control + HVAC Inspection';

describe('a filter size listed twice', () => {
  it('is two rows, each saying which of the two it is', () => {
    const rows = filterRows(DETAILS, null);

    expect(rows.map((row) => row.label)).toEqual(['12x24x1', '16x25x1 (1 of 2)', '16x25x1 (2 of 2)']);
  });

  it('answers one row without answering the other', () => {
    const [, first, second] = filterRows(DETAILS, null);
    const report = withFilterAnswer(null, first!.filter, { changed: true, photoKey: 'snap-1' });

    const rows = filterRows(DETAILS, report);
    expect(rows[1]!.answer).toMatchObject({ slot: 1, changed: true });
    expect(rows[2]!.answer).toBeUndefined();
    expect(second!.filter.slot).toBe(2);
    expect(report.filters).toHaveLength(1);
  });
});
