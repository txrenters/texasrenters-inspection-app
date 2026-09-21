import { quarterFilter, visitQuarter } from '../src/admin/admin.service';

/**
 * Which quarter of the benefit-package programme a visit belongs to.
 *
 * Not the quarter its day falls in. A quarter's plan may be built and
 * published up to fifteen days before the quarter starts, so Q4's first visits
 * are scheduled in September. Reading the calendar filed 36 HVAC and 19
 * occupied visits of the Q4 plan under Q3 2026 — and Q3 has no HVAC in it at
 * all, because `HVAC_QUARTERS` is Q2 and Q4 (the office, 2026-09-21: "why
 * there's an HVAC on Q3 ... forgot about the rule?").
 */
describe('the quarter a visit belongs to', () => {
  const september = new Date('2026-09-25T15:00:00.000Z');

  it('is the plan that made it, not the quarter its day lands in', () => {
    expect(
      visitQuarter({
        scheduledAt: september,
        tbpPlanStop: { plan: { quarterYear: 2026, quarterNumber: 4 } },
      }),
    ).toBe('Q4 2026');
  });

  it('falls back to the title the office booked it under in Jobber', () => {
    expect(
      visitQuarter({
        scheduledAt: september,
        jobberVisitTitle: '1234 Elm St - Q3 2026 Tenant Benefit Package',
        tbpPlanStop: null,
      }),
    ).toBe('Q3 2026');
  });

  /**
   * Only a programme title counts. Jobber holds every other kind of job too,
   * and a quarter written into one of their titles is not this programme's.
   */
  it('ignores a quarter in a title that is not the programme', () => {
    expect(
      visitQuarter({
        scheduledAt: september,
        jobberVisitTitle: '1234 Elm St - Q1 2026 gutter clean',
        tbpPlanStop: null,
      }),
    ).toBe('Q3 2026');
  });

  /**
   * A move-out has nothing to do with the programme, so its day is the only
   * thing that can mean a quarter — and it must not be read as the quarter of
   * whichever plan happens to be running.
   */
  it('is the quarter of its day when it is not a programme visit at all', () => {
    expect(visitQuarter({ scheduledAt: september })).toBe('Q3 2026');
  });

  it('reads the day in UTC, so a boundary does not move with the reader', () => {
    expect(visitQuarter({ scheduledAt: new Date('2026-09-30T23:30:00.000Z') })).toBe('Q3 2026');
    expect(visitQuarter({ scheduledAt: new Date('2026-10-01T00:30:00.000Z') })).toBe('Q4 2026');
  });
});

describe('asking the list for one quarter', () => {
  it('gives the days that quarter covers, ends included', () => {
    expect(quarterFilter('Q4 2026')).toMatchObject({
      year: 2026,
      quarter: 4,
      label: 'Q4 2026',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
    });
  });

  /** Nothing asked for is not the same as an empty quarter: the list is unfiltered. */
  it('is null for no quarter and for anything that is not one', () => {
    expect(quarterFilter(undefined)).toBeNull();
    expect(quarterFilter('last quarter')).toBeNull();
    expect(quarterFilter('Q5 2026')).toBeNull();
  });
});
