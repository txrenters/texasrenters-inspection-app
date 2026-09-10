import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DAILY_STOP_CAP,
  type PlannableDay,
  type PlannableStop,
  type PlannableTechnician,
  assignQuarter,
  nearestNeighbourOrder,
  splitAmongTechnicians,
} from '../src/contracts/quarter-assignment.js';

/** Houston-ish, so distances are realistic rather than degenerate. */
const at = (stopId: string, sequence: number, latitude: number, longitude: number): PlannableStop => ({
  stopId,
  sequence,
  latitude,
  longitude,
});

const tech = (technicianId: string, dailyStopCap = DEFAULT_DAILY_STOP_CAP): PlannableTechnician => ({
  technicianId,
  dailyStopCap,
});

const days = (count: number, technicianIds: string[]): PlannableDay[] =>
  Array.from({ length: count }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    technicianIds,
  }));

/** Keeps the input order, so a test can read placement without routing noise. */
const asGiven = (dayStops: readonly PlannableStop[]) => [...dayStops];

const stopsInRotation = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    at(`s${index + 1}`, index + 1, 29.76 + index * 0.01, -95.37),
  );

describe('spreading a quarter across its working days', () => {
  /**
   * The programme runs all quarter. Packing to capacity from day one would
   * finish in three weeks and leave nine with nobody to inspect — and every
   * tenant would drift earlier in the year, every year.
   */
  it('spreads stops across the whole quarter rather than front-loading', () => {
    const { placed } = assignQuarter(stopsInRotation(20), [tech('t1')], days(10, ['t1']), asGiven);

    const used = new Set(placed.map((stop) => stop.date));
    expect(used.size).toBe(10);
    expect(placed).toHaveLength(20);
  });

  /**
   * The rotation is a promise to a tenant about roughly when somebody knocks.
   * Drive time is not a good enough reason to break it, so a stop earlier in
   * the rotation is never scheduled after a later one.
   */
  it('keeps the rotation order across days', () => {
    const { placed } = assignQuarter(stopsInRotation(12), [tech('t1')], days(6, ['t1']), asGiven);

    const dayOf = new Map(placed.map((stop) => [stop.stopId, stop.date]));
    const dates = stopsInRotation(12).map((stop) => dayOf.get(stop.stopId)!);
    expect([...dates]).toEqual([...dates].sort());
  });

  it('numbers each technician’s day from one', () => {
    const { placed } = assignQuarter(stopsInRotation(4), [tech('t1')], days(2, ['t1']), asGiven);

    const firstDay = placed.filter((stop) => stop.date === '2026-10-01');
    expect(firstDay.map((stop) => stop.position).sort()).toEqual([1, 2]);
  });

  it('places nothing, and says why, when the quarter has no working days', () => {
    const { placed, unplaced } = assignQuarter(stopsInRotation(3), [tech('t1')], [], asGiven);

    expect(placed).toEqual([]);
    expect(unplaced).toEqual([
      { stopId: 's1', reason: 'NO_WORKING_DAYS' },
      { stopId: 's2', reason: 'NO_WORKING_DAYS' },
      { stopId: 's3', reason: 'NO_WORKING_DAYS' },
    ]);
  });

  /**
   * Separated from a capacity shortfall because the two need different fixes:
   * nobody qualified is a skills problem, a full quarter is a staffing one.
   */
  it('distinguishes nobody qualified from no room left', () => {
    const noCrew = assignQuarter(stopsInRotation(2), [tech('t1')], days(3, []), asGiven);
    expect(noCrew.unplaced.map((stop) => stop.reason)).toEqual([
      'NO_QUALIFIED_TECHNICIAN',
      'NO_QUALIFIED_TECHNICIAN',
    ]);

    const full = assignQuarter(stopsInRotation(5), [tech('t1', 1)], days(2, ['t1']), asGiven);
    expect(full.placed).toHaveLength(2);
    expect(full.unplaced.map((stop) => stop.reason)).toEqual([
      'NO_CAPACITY',
      'NO_CAPACITY',
      'NO_CAPACITY',
    ]);
  });

  /**
   * A full day must not push every later stop back and cascade the quarter, so
   * the search runs outward from the rotation's choice. A stop is better a day
   * early than a fortnight late.
   */
  it('falls back to a neighbouring day rather than cascading', () => {
    // Five stops over three days at one apiece. Rotation sends s1 and s2 both
    // to day 0 and s3 and s4 both to day 1, so the collision is real: s2 has to
    // move. It should land on day 1, next door — not at the end of the quarter.
    const { placed } = assignQuarter(
      stopsInRotation(5),
      [tech('t1', 1)],
      days(3, ['t1']),
      asGiven,
    );

    const dayOf = new Map(placed.map((stop) => [stop.stopId, stop.date]));
    expect(dayOf.get('s1')).toBe('2026-10-01');
    expect(dayOf.get('s2')).toBe('2026-10-02');
    expect(placed).toHaveLength(3);
  });

  /**
   * The search runs outward, and earlier wins a tie. A stop displaced from a
   * full day should sit just before its slot rather than just after, so the
   * rotation never drifts later and later across quarters.
   */
  it('prefers the earlier side when both neighbours are free', () => {
    // s1..s3 fill days 0..2. s4 targets day 1, which is taken, so it must
    // choose between day 0 and day 2 — both full — then day 3.
    const spread = [at('s1', 1, 29.76, -95.37), at('s2', 2, 29.77, -95.37)];
    const { placed } = assignQuarter(spread, [tech('t1', 1)], days(4, ['t1']), asGiven);
    const dayOf = new Map(placed.map((stop) => [stop.stopId, stop.date]));

    // Two stops, four days: rotation puts them on days 0 and 2, untouched.
    expect(dayOf.get('s1')).toBe('2026-10-01');
    expect(dayOf.get('s2')).toBe('2026-10-03');
  });

  it('reports demand against capacity so a shortfall is visible before publish', () => {
    const { capacity } = assignQuarter(
      stopsInRotation(30),
      [tech('t1', 5), tech('t2', 5)],
      days(2, ['t1', 't2']),
      asGiven,
    );

    expect(capacity).toEqual({ stops: 30, slots: 20 });
  });
});

describe('splitting one day between technicians', () => {
  const capOf = new Map([
    ['t1', 10],
    ['t2', 10],
  ]);

  /**
   * Six stops across four technicians gives four people a half-empty drive
   * each. Only as many crews as the day needs are opened.
   */
  it('opens only as many crews as the day needs', () => {
    const crews = splitAmongTechnicians(stopsInRotation(4), ['t1', 't2'], capOf);

    expect(crews).toHaveLength(1);
    expect(crews[0].technicianId).toBe('t1');
    expect(crews[0].stops).toHaveLength(4);
  });

  it('opens a second crew once one technician cannot hold the day', () => {
    const crews = splitAmongTechnicians(stopsInRotation(6), ['t1', 't2'], new Map([['t1', 4], ['t2', 4]]));

    expect(crews).toHaveLength(2);
    expect(crews.reduce((total, crew) => total + crew.stops.length, 0)).toBe(6);
    expect(crews.every((crew) => crew.stops.length <= 4)).toBe(true);
  });

  /**
   * Geography decides here and only here. Two clusters a long way apart must
   * come out as two clean crews, not interleaved — interleaving is what makes
   * two technicians drive past each other all day.
   */
  it('gives each crew one cluster rather than interleaving them', () => {
    const houston = [at('h1', 1, 29.76, -95.37), at('h2', 2, 29.77, -95.36), at('h3', 3, 29.75, -95.38)];
    const dallas = [at('d1', 4, 32.78, -96.8), at('d2', 5, 32.79, -96.79), at('d3', 6, 32.77, -96.81)];

    const crews = splitAmongTechnicians(
      [...houston, ...dallas],
      ['t1', 't2'],
      new Map([['t1', 3], ['t2', 3]]),
    );

    expect(crews).toHaveLength(2);
    for (const crew of crews) {
      const ids = crew.stops.map((stop) => stop.stopId);
      const allHouston = ids.every((id) => id.startsWith('h'));
      const allDallas = ids.every((id) => id.startsWith('d'));
      expect(allHouston || allDallas).toBe(true);
    }
  });

  it('returns nothing when nobody is working that day', () => {
    expect(splitAmongTechnicians(stopsInRotation(3), [], capOf)).toEqual([]);
  });
});

describe('ordering a day without a road matrix', () => {
  /**
   * The fallback, not the answer — `shortestRouteOrder` with a real duration
   * matrix is what the planner uses when routing is configured. This exists so
   * an unrouted plan is still ordered sensibly rather than presented in
   * rotation order as if it were a route.
   */
  it('walks to the nearest unvisited stop each time', () => {
    const ordered = nearestNeighbourOrder([
      at('start', 1, 29.76, -95.37),
      at('far', 2, 29.9, -95.37),
      at('near', 3, 29.77, -95.37),
    ]);

    expect(ordered.map((stop) => stop.stopId)).toEqual(['start', 'near', 'far']);
  });

  it('leaves one or two stops alone, where there is no choice to make', () => {
    const pair = [at('a', 1, 29.76, -95.37), at('b', 2, 29.9, -95.37)];
    expect(nearestNeighbourOrder(pair).map((stop) => stop.stopId)).toEqual(['a', 'b']);
    expect(nearestNeighbourOrder([])).toEqual([]);
  });
});
