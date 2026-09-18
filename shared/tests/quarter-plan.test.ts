import { describe, expect, it } from 'vitest';

import {
  type PriorRank,
  type RotationCandidate,
  carryForwardOrder,
  closedDaysOfQuarter,
  monthOfPlan,
  nextQuarter,
  planStartRange,
  planningOpensOn,
  previousQuarter,
  quarterDueForPlanning,
  quarterEnd,
  quarterLabel,
  quarterOf,
  quarterFirstDay,
  quarterStart,
  usFederalHolidays,
  workingDaysOfQuarter,
} from '../src/contracts/quarter-plan.js';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const tenant = (id: string, zone: string | null = null, addressKey: string | null = null): RotationCandidate => ({
  tenantExternalId: id,
  zone,
  addressKey,
});

const order = (...ids: string[]): PriorRank[] =>
  ids.map((tenantExternalId, index) => ({ tenantExternalId, sequence: index + 1 }));

const sequenceOf = (stops: ReturnType<typeof carryForwardOrder>) =>
  stops.map((stop) => stop.tenantExternalId);

describe('quarter arithmetic', () => {
  it('places every month in the right quarter', () => {
    expect(quarterOf(utc('2026-01-01'))).toEqual({ year: 2026, quarter: 1 });
    expect(quarterOf(utc('2026-03-31'))).toEqual({ year: 2026, quarter: 1 });
    expect(quarterOf(utc('2026-09-11'))).toEqual({ year: 2026, quarter: 3 });
    expect(quarterOf(utc('2026-10-01'))).toEqual({ year: 2026, quarter: 4 });
    expect(quarterOf(utc('2026-12-31'))).toEqual({ year: 2026, quarter: 4 });
  });

  it('rolls the year at the Q4/Q1 boundary in both directions', () => {
    expect(nextQuarter({ year: 2026, quarter: 4 })).toEqual({ year: 2027, quarter: 1 });
    expect(previousQuarter({ year: 2027, quarter: 1 })).toEqual({ year: 2026, quarter: 4 });
  });

  /**
   * Exclusive, so the quarter's last day is included whole. An inclusive end
   * at midnight would silently drop everything booked on 31 December.
   */
  it('ends a quarter at the first instant of the next', () => {
    expect(quarterEnd({ year: 2026, quarter: 4 })).toEqual(utc('2027-01-01'));
    expect(quarterStart({ year: 2026, quarter: 4 })).toEqual(utc('2026-10-01'));
  });

  it('labels a quarter the way the office already writes it in Jobber', () => {
    expect(quarterLabel({ year: 2026, quarter: 4 })).toBe('Q4 2026');
  });
});

describe('when a quarter becomes due for planning', () => {
  const Q4 = { year: 2026, quarter: 4 } as const;

  it('opens fourteen days before the quarter starts', () => {
    expect(planningOpensOn(Q4)).toEqual(utc('2026-09-17'));
  });

  it('is not due the day before the window opens', () => {
    expect(quarterDueForPlanning(utc('2026-09-16'))).toBeNull();
  });

  it('is due on the day the window opens', () => {
    expect(quarterDueForPlanning(utc('2026-09-17'))).toEqual(Q4);
  });

  /**
   * The reason this is a window rather than a single date. A cron firing only
   * on the exact day would skip the quarter outright if the container happened
   * to be restarting that morning, and nothing would report it — the next
   * anybody hears is that no inspections were booked.
   */
  it('stays due every day until the quarter actually starts', () => {
    expect(quarterDueForPlanning(utc('2026-09-24'))).toEqual(Q4);
    expect(quarterDueForPlanning(utc('2026-09-30'))).toEqual(Q4);
  });

  it('stops being due once the quarter has begun', () => {
    // On 1 October the *next* quarter is Q1 2027, whose window has not opened.
    expect(quarterDueForPlanning(utc('2026-10-01'))).toBeNull();
  });

  it('crosses the year boundary', () => {
    expect(quarterDueForPlanning(utc('2026-12-18'))).toEqual({ year: 2027, quarter: 1 });
  });
});

describe('the working days of a quarter', () => {
  it('covers the quarter and stops at its last day', () => {
    const days = workingDaysOfQuarter({ year: 2026, quarter: 4 });

    expect(days[0]).toBe('2026-10-01');
    expect(days.at(-1)).toBe('2026-12-31');
  });

  it('leaves out weekends', () => {
    // 3 and 4 October 2026 are a Saturday and a Sunday.
    const days = workingDaysOfQuarter({ year: 2026, quarter: 4 });

    expect(days).toContain('2026-10-02');
    expect(days).not.toContain('2026-10-03');
    expect(days).not.toContain('2026-10-04');
    expect(days).toContain('2026-10-05');
  });

  /** The office works weekdays and not US holidays (2026-09-16), and nobody has to type them in. */
  it('leaves out the US federal holidays that fall in it', () => {
    const days = workingDaysOfQuarter({ year: 2026, quarter: 4 });

    // Columbus Day, Veterans Day, Thanksgiving and Christmas: 66 weekdays, less four.
    expect(days).toHaveLength(62);
    for (const holiday of ['2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']) expect(days).not.toContain(holiday);
    expect(days).toContain('2026-11-27');
  });

  it('leaves out any other day the office names as closed', () => {
    const days = workingDaysOfQuarter({ year: 2026, quarter: 4 }, ['2026-11-27', '2026-12-24']);

    expect(days).toHaveLength(60);
    expect(days).not.toContain('2026-11-27');
    expect(days).not.toContain('2026-12-24');
  });

  it('ignores a holiday that falls outside the quarter', () => {
    const withStray = workingDaysOfQuarter({ year: 2026, quarter: 4 }, ['2026-07-04']);
    const without = workingDaysOfQuarter({ year: 2026, quarter: 4 });

    expect(withStray).toEqual(without);
  });
});

describe('the US federal holidays', () => {
  it('lists the eleven as they are observed', () => {
    expect(usFederalHolidays(2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-05-25',
      '2026-06-19',
      // 4 July 2026 is a Saturday, so it is observed on the Friday.
      '2026-07-03',
      '2026-09-07',
      '2026-10-12',
      '2026-11-11',
      '2026-11-26',
      '2026-12-25',
    ]);
  });

  it('moves a Sunday holiday to the Monday and a Saturday one to the Friday', () => {
    const holidays = usFederalHolidays(2027);

    expect(holidays).toContain('2027-07-05');
    expect(holidays).toContain('2027-12-24');
  });

  it('puts a Saturday New Year’s Day on the last day of the year before', () => {
    expect(usFederalHolidays(2027)).toContain('2027-12-31');
    expect(usFederalHolidays(2028)).not.toContain('2028-01-01');
    expect(usFederalHolidays(2028)).toHaveLength(10);
  });
});

describe('the days a quarter loses', () => {
  it('lists its holidays and named closed days, only on weekdays inside it', () => {
    // 26 November is Thanksgiving already, 4 July is in Q3 and 3 October is a Saturday.
    const closed = closedDaysOfQuarter({ year: 2026, quarter: 4 }, ['2026-11-27', '2026-11-26', '2026-07-04', '2026-10-03']);

    expect(closed).toEqual(['2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25']);
  });

  it('counts from a plan’s own start, the year before’s holidays too', () => {
    // Q1 2027 started on 17 December 2026: Christmas and New Year's Day are that plan's.
    expect(closedDaysOfQuarter({ year: 2027, quarter: 1 }, [], '2026-12-17').slice(0, 2)).toEqual(['2026-12-25', '2027-01-01']);
    // Q4 2026 started on 16 October: Columbus Day, on the 12th, is before it.
    expect(closedDaysOfQuarter({ year: 2026, quarter: 4 }, [], '2026-10-16')[0]).toBe('2026-11-11');
  });
});

/**
 * The office (2026-09-19): "there's a +-15 days rule ... to schedule 15 days
 * before the start of quarter ... for the q4 we can start as early as september".
 */
describe('a plan’s own start', () => {
  const q4 = { year: 2026, quarter: 4 as const };

  it('may be up to fifteen days either side of the quarter’s first day', () => {
    expect(planStartRange(q4)).toEqual({ earliest: '2026-09-16', latest: '2026-10-16' });
    expect(planStartRange({ year: 2027, quarter: 1 })).toEqual({ earliest: '2026-12-17', latest: '2027-01-16' });
  });

  it('gives the plan the working days from its own first', () => {
    const days = workingDaysOfQuarter(q4, [], '2026-09-21');

    expect(days.slice(0, 3)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    expect(days.at(-1)).toBe('2026-12-31');
    expect(days).toHaveLength(62 + 8);
    expect(workingDaysOfQuarter(q4, [], '2026-10-05')[0]).toBe('2026-10-05');
  });

  it('puts a day before the quarter in its first month', () => {
    expect(['2026-09-21', '2026-10-01', '2026-11-30', '2026-12-31'].map((date) => monthOfPlan(date, q4))).toEqual([1, 1, 2, 3]);
    expect(monthOfPlan('2027-01-04', q4)).toBe(3);
    expect(quarterFirstDay(q4)).toBe('2026-10-01');
  });
});

describe('carrying the tenant order forward', () => {
  /**
   * The office's rule, in one test. Whoever was first last quarter is first
   * again, so a tenant's visits stay about ninety days apart and the office
   * can tell them roughly when to expect the next one.
   */
  it('keeps last quarter’s order', () => {
    const stops = carryForwardOrder(
      [tenant('c'), tenant('a'), tenant('b')],
      [order('a', 'b', 'c')],
    );

    expect(sequenceOf(stops)).toEqual(['a', 'b', 'c']);
    expect(stops.map((stop) => stop.sequence)).toEqual([1, 2, 3]);
    expect(stops.every((stop) => stop.orderSource === 'PRIOR_QUARTER')).toBe(true);
  });

  it('puts a newly enrolled tenancy at the back rather than in the middle', () => {
    const stops = carryForwardOrder(
      [tenant('a'), tenant('b'), tenant('new')],
      [order('a', 'b')],
    );

    expect(sequenceOf(stops)).toEqual(['a', 'b', 'new']);
    expect(stops[2]).toEqual({
      tenantExternalId: 'new',
      sequence: 3,
      previousSequence: null,
      previousVisitOn: null,
      previousVisitMonth: null,
      orderSource: 'NEW_ENROLLMENT',
    });
  });

  /**
   * Densified, not left with a hole. A gap is not something a coordinator can
   * act on, and leaving one would push every later tenancy a place further
   * from its position every quarter a neighbour un-enrolled.
   */
  it('closes the gap left by a tenancy that un-enrolled', () => {
    const stops = carryForwardOrder([tenant('a'), tenant('c')], [order('a', 'b', 'c')]);

    expect(stops).toEqual([
      { tenantExternalId: 'a', sequence: 1, previousSequence: 1, previousVisitOn: null, previousVisitMonth: null, orderSource: 'PRIOR_QUARTER' },
      { tenantExternalId: 'c', sequence: 2, previousSequence: 3, previousVisitOn: null, previousVisitMonth: null, orderSource: 'PRIOR_QUARTER' },
    ]);
  });

  /**
   * A tenancy blocked last quarter — usually because its unit could not be
   * resolved — keeps the place it held before, rather than being sent to the
   * back for a data problem that was never the tenant's doing.
   */
  it('carries a skipped tenancy’s older position rather than treating it as new', () => {
    const stops = carryForwardOrder(
      [tenant('a'), tenant('skipped'), tenant('c')],
      [order('a', 'c'), order('a', 'skipped', 'c')],
    );

    expect(sequenceOf(stops)).toEqual(['a', 'skipped', 'c']);
    expect(stops[1]).toEqual({
      tenantExternalId: 'skipped',
      sequence: 2,
      previousSequence: 2,
      previousVisitOn: null,
      previousVisitMonth: null,
      orderSource: 'CARRIED_SKIP',
    });
  });

  /** A plan may start before its quarter (2026-09-19), so the day alone cannot say which month of it the visit was in. */
  it('carries the month of its quarter the visit a place came from was in', () => {
    const stops = carryForwardOrder(
      [tenant('early'), tenant('new')],
      [[{ tenantExternalId: 'early', sequence: 1, visitedOn: '2026-09-25', visitedMonth: 1 }]],
    );

    expect(stops.map((stop) => [stop.tenantExternalId, stop.previousVisitOn, stop.previousVisitMonth])).toEqual([
      ['early', '2026-09-25', 1],
      ['new', null, null],
    ]);
  });

  /** The office (2026-09-18): each visit keeps its month of the quarter, so the day is carried with the place. */
  it('carries the day of the visit a place came from', () => {
    const stops = carryForwardOrder(
      [tenant('a'), tenant('skipped'), tenant('new')],
      [
        [{ tenantExternalId: 'a', sequence: 1, visitedOn: '2026-08-12' }],
        [{ tenantExternalId: 'skipped', sequence: 1, visitedOn: '2026-05-04' }],
      ],
    );

    expect(stops.map((stop) => [stop.tenantExternalId, stop.previousVisitOn])).toEqual([
      ['skipped', '2026-05-04'],
      ['a', '2026-08-12'],
      ['new', null],
    ]);
  });

  it('stops looking back after four quarters', () => {
    const ancient = [order('a'), order('a'), order('a'), order('a'), order('a', 'ancient')];
    const stops = carryForwardOrder([tenant('a'), tenant('ancient')], ancient);

    expect(stops[1].orderSource).toBe('NEW_ENROLLMENT');
    expect(stops[1].previousSequence).toBeNull();
  });

  /**
   * `stale` and `recent` both carry position 2, but `stale` got it two
   * quarters ago and was missed in between — so its tenant has waited about a
   * hundred and eighty days where `recent`'s has waited ninety. The tie goes
   * to the longer wait, which is what stops a repeatedly-blocked tenancy from
   * drifting further back every time somebody fixes it.
   */
  it('gives a tied position to whoever has waited longer', () => {
    const stops = carryForwardOrder(
      [tenant('recent'), tenant('stale')],
      [order('x', 'recent'), order('y', 'stale')],
    );

    expect(sequenceOf(stops)).toEqual(['stale', 'recent']);
  });

  describe('the first quarter, with no history at all', () => {
    it('orders by zone, then address, then the tenancy key', () => {
      const stops = carryForwardOrder(
        [
          tenant('t3', 'Zone 2', '100-main-st'),
          tenant('t1', 'Zone 1', '900-oak-ave'),
          tenant('t2', 'Zone 1', '100-elm-st'),
        ],
        [],
      );

      expect(sequenceOf(stops)).toEqual(['t2', 't1', 't3']);
      expect(stops.every((stop) => stop.orderSource === 'NEW_ENROLLMENT')).toBe(true);
    });

    /**
     * A tenancy with no zone must not collide with one in "Zone 1" and land in
     * an order that depends on which the database returned first.
     */
    it('puts tenancies with no zone last, deterministically', () => {
      const stops = carryForwardOrder(
        [tenant('none', null, 'aaa'), tenant('zoned', 'Zone 9', 'zzz')],
        [],
      );

      expect(sequenceOf(stops)).toEqual(['zoned', 'none']);
    });
  });

  /**
   * What makes the fortnightly regeneration safe to re-run. If the order were
   * not total, two equal tenancies would come back in whatever order the
   * database happened to return, and every run would reshuffle stops nobody
   * asked to move — silently undoing a coordinator's reading of the plan.
   */
  it('is stable: the same inputs in a different order give the same answer', () => {
    const candidates = [
      tenant('t1', 'Zone 1', 'a'),
      tenant('t2', 'Zone 1', 'a'),
      tenant('t3', 'Zone 1', 'a'),
    ];
    const forwards = carryForwardOrder(candidates, []);
    const backwards = carryForwardOrder([...candidates].reverse(), []);

    expect(sequenceOf(backwards)).toEqual(sequenceOf(forwards));
  });

  it('returns nothing for a quarter with nobody enrolled', () => {
    expect(carryForwardOrder([], [order('a', 'b')])).toEqual([]);
  });
});
