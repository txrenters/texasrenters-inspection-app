import { describe, expect, it } from 'vitest';

import {
  type PriorRank,
  type RotationCandidate,
  carryForwardOrder,
  nextQuarter,
  planningOpensOn,
  previousQuarter,
  quarterDueForPlanning,
  quarterEnd,
  quarterLabel,
  quarterOf,
  quarterStart,
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
      { tenantExternalId: 'a', sequence: 1, previousSequence: 1, orderSource: 'PRIOR_QUARTER' },
      { tenantExternalId: 'c', sequence: 2, previousSequence: 3, orderSource: 'PRIOR_QUARTER' },
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
      orderSource: 'CARRIED_SKIP',
    });
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
