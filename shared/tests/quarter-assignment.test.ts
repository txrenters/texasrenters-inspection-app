import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DAY_LIMITS,
  MAX_STOPS_PER_DAY,
  type PlannableDay,
  type PlannableStop,
  assignQuarter,
  crewKey,
  estimatedDriveMinutes,
  nearestNeighbourOrder,
} from '../src/contracts/quarter-assignment.js';

/** Houston-ish, so distances are realistic rather than degenerate. */
const at = (
  stopId: string,
  sequence: number,
  latitude: number,
  longitude: number,
  extra: Partial<PlannableStop> = {},
): PlannableStop => ({
  stopId,
  sequence,
  latitude,
  longitude,
  onSiteMinutes: 30,
  inspectionType: 'OCCUPIED',
  ...extra,
});

const days = (count: number, technicianIds: string[], qualified?: PlannableDay['qualified']): PlannableDay[] =>
  Array.from({ length: count }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    technicianIds,
    ...(qualified ? { qualified } : {}),
  }));

/** Stops a few hundred metres apart, in rotation order. */
const stopsInRotation = (count: number, extra: Partial<PlannableStop> = {}) =>
  Array.from({ length: count }, (_, index) => at(`s${index + 1}`, index + 1, 29.76 + index * 0.003, -95.37, extra));

/** Stops in one building: no drive between any of them, so only on-site time decides. */
const sameBuilding = (count: number, extra: Partial<PlannableStop> = {}) =>
  Array.from({ length: count }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37, extra));

const dayOf = (placed: { stopId: string; date: string }[]) => new Map(placed.map((stop) => [stop.stopId, stop.date]));

/**
 * The office's rule (2026-09-16): each technician on the crew has one zone a
 * week, and a stop goes only to whoever has its zone.
 */
describe('giving days out by zone', () => {
  const zoned = (technicians: string[], owners: Record<string, string>, count = 1): PlannableDay[] =>
    days(count, technicians).map((day) => ({ ...day, zoneTechnicians: owners }));

  it('sends each stop to whoever has its zone that day', () => {
    const { placed } = assignQuarter(
      [at('north', 1, 29.9, -95.37, { zone: '1' }), at('south', 2, 29.7, -95.37, { zone: '2' })],
      zoned(['moses', 'kevin'], { '1': 'moses', '2': 'kevin' }),
    );

    expect(Object.fromEntries(placed.map((stop) => [stop.stopId, stop.technicianId]))).toEqual({
      north: 'moses',
      south: 'kevin',
    });
  });

  it('never gives a stop to a technician who is out, but on another zone', () => {
    // Kevin is already out that day on zone 2; the zone 1 stop still waits for Moses.
    const { placed } = assignQuarter(
      [at('a', 1, 29.7, -95.37, { zone: '2' }), at('b', 2, 29.7001, -95.37, { zone: '1' })],
      zoned(['moses', 'kevin'], { '1': 'moses', '2': 'kevin' }),
    );

    expect(placed.find((stop) => stop.stopId === 'b')?.technicianId).toBe('moses');
  });

  it('moves a stop whose zone has nobody on its day to the nearest day that does', () => {
    const quarter: PlannableDay[] = [
      { date: '2026-10-01', technicianIds: ['moses'], zoneTechnicians: { '1': 'moses' } },
      { date: '2026-10-02', technicianIds: ['moses'], zoneTechnicians: { '2': 'moses' } },
      { date: '2026-10-05', technicianIds: ['moses'], zoneTechnicians: { '2': 'moses' } },
    ];

    // Aimed at the middle day, whose zone 3 has nobody; zone 3 is nobody's all quarter.
    const nowhere = assignQuarter([at('x', 1, 29.7, -95.37, { zone: '3' })], quarter, { rotation: { position: new Map([['x', 1]]), size: 3 } });
    expect(nowhere.unplaced).toEqual([{ stopId: 'x', reason: 'NO_QUALIFIED_TECHNICIAN' }]);

    const earlier = assignQuarter([at('y', 1, 29.7, -95.37, { zone: '1' })], quarter, { rotation: { position: new Map([['y', 1]]), size: 3 } });
    expect(earlier.placed[0]?.date).toBe('2026-10-01');
  });
});

/** The ninety minutes count the drive from home to the first property (2026-09-16). */
describe('a day’s drive counted from home', () => {
  const home = { latitude: 29.7, longitude: -95.37 };

  it('counts the drive from home to the first stop', () => {
    const { crews } = assignQuarter([at('only', 1, 29.8, -95.37)], days(1, ['t1']), { homes: new Map([['t1', home]]) });

    expect(crews[0]?.driveMinutes).toBeCloseTo(estimatedDriveMinutes(home, at('only', 1, 29.8, -95.37)), 5);
  });

  it('will not send a technician to a stop too far from home to reach inside the drive limit', () => {
    // About 110 km from home: some 170 minutes each way on the estimate.
    const { placed, unplaced } = assignQuarter([at('far', 1, 30.7, -95.37)], days(3, ['t1']), {
      homes: new Map([['t1', home]]),
    });

    expect(placed).toEqual([]);
    expect(unplaced).toEqual([{ stopId: 'far', reason: 'OUT_OF_REACH' }]);
  });

  it('keeps a day inside the limit with the drive from home in it', () => {
    // A is about 48 minutes from home and B another 61 beyond it: 109 minutes
    // in all, over ninety, though the drive between them alone is not.
    const stops = [at('a', 1, 29.97, -95.37), at('b', 2, 29.97, -94.97)];
    const { crews, unplaced } = assignQuarter(stops, days(1, ['t1']), { homes: new Map([['t1', home]]) });

    expect(crews.map((crew) => crew.stops.map((stop) => stop.stopId))).toEqual([['a']]);
    expect(unplaced).toEqual([{ stopId: 'b', reason: 'NO_CAPACITY' }]);
    for (const crew of crews) expect(crew.driveMinutes).toBeLessThanOrEqual(DEFAULT_DAY_LIMITS.maxDriveMinutes);
  });
});

describe('spreading a quarter across its working days', () => {
  /**
   * The programme runs all quarter. Packing to capacity from day one would
   * finish in three weeks and leave nine with nobody to inspect -- and every
   * tenant would drift earlier in the year, every year.
   */
  it('spreads stops across the whole quarter rather than front-loading', () => {
    const { placed } = assignQuarter(stopsInRotation(20), days(10, ['t1']));

    expect(new Set(placed.map((stop) => stop.date)).size).toBe(10);
    expect(placed).toHaveLength(20);
  });

  /**
   * Whoever was first last quarter is first again. With room on every day the
   * rotation decides the day outright, so an earlier stop is never later.
   */
  it('keeps the rotation order across days', () => {
    const { placed } = assignQuarter(stopsInRotation(12), days(6, ['t1']));

    const schedule = dayOf(placed);
    const dates = stopsInRotation(12).map((stop) => schedule.get(stop.stopId)!);
    expect([...dates]).toEqual([...dates].sort());
  });

  it('numbers each technician’s day from one', () => {
    const { placed } = assignQuarter(stopsInRotation(4), days(2, ['t1']));

    const firstDay = placed.filter((stop) => stop.date === '2026-10-01');
    expect(firstDay.map((stop) => stop.position).sort()).toEqual([1, 2]);
  });

  it('places nothing, and says why, when the quarter has no working days', () => {
    const { placed, unplaced } = assignQuarter(stopsInRotation(3), []);

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
    const noCrew = assignQuarter(stopsInRotation(2), days(3, []));
    expect(noCrew.unplaced.map((stop) => stop.reason)).toEqual(['NO_QUALIFIED_TECHNICIAN', 'NO_QUALIFIED_TECHNICIAN']);

    // Two days of six hours hold twenty-four half-hour visits, and no more.
    const full = assignQuarter(sameBuilding(26), days(2, ['t1']));
    expect(full.placed).toHaveLength(24);
    expect(full.unplaced.map((stop) => stop.reason)).toEqual(['NO_CAPACITY', 'NO_CAPACITY']);
  });

  it('reports demand against capacity in minutes', () => {
    const { capacity } = assignQuarter(sameBuilding(30), days(2, ['t1', 't2']));

    expect(capacity).toEqual({ stops: 30, onSiteMinutes: 900, availableMinutes: 4 * 360 });
  });
});

describe('the office’s limits on a technician’s day', () => {
  /** Eleven properties is a fine day, as long as it keeps inside six hours and ninety minutes. */
  it('puts eleven stops in one day when they fit, because stops are not the limit', () => {
    const { crews } = assignQuarter(sameBuilding(11), days(1, ['t1', 't2']));

    expect(crews).toHaveLength(1);
    expect(crews[0]!.stops).toHaveLength(11);
    expect(crews[0]!.onSiteMinutes).toBe(330);
  });

  it('holds a day to six hours on site, sending a second technician for the rest', () => {
    const { crews, unplaced } = assignQuarter(sameBuilding(14), days(1, ['t1', 't2']));

    expect(unplaced).toEqual([]);
    expect(crews.map((crew) => crew.onSiteMinutes).sort((a, b) => b - a)).toEqual([360, 60]);
    expect(crews.every((crew) => crew.onSiteMinutes <= DEFAULT_DAY_LIMITS.maxOnSiteMinutes)).toBe(true);
  });

  it('counts an HVAC visit by its own length', () => {
    const hvac = sameBuilding(5, { onSiteMinutes: 75, inspectionType: 'HVAC' });
    const { crews, unplaced } = assignQuarter(hvac, days(1, ['t1']));

    // Four at 75 minutes is 300; a fifth would make 375.
    expect(crews[0]!.stops).toHaveLength(4);
    expect(unplaced).toEqual([{ stopId: 'b5', reason: 'NO_CAPACITY' }]);
  });

  /**
   * Ninety minutes of driving. With no home on file the day starts at the
   * first job, so the ninety minutes are all between the properties.
   */
  it('holds a day to ninety minutes of driving between its stops', () => {
    // Six stops 10 km apart in a line: each leg is estimated at 18 minutes, so
    // five legs is 90 and a sixth leg would be 108.
    const line = Array.from({ length: 7 }, (_, index) => at(`l${index + 1}`, index + 1, 29.76 + index * 0.0899, -95.37));
    const { crews } = assignQuarter(line, days(1, ['t1', 't2']));

    expect(crews.every((crew) => crew.driveMinutes <= DEFAULT_DAY_LIMITS.maxDriveMinutes)).toBe(true);
    expect(crews.reduce((total, crew) => total + crew.stops.length, 0)).toBe(7);
    expect(crews).toHaveLength(2);
  });

  it('counts no drive for a day of one stop', () => {
    const { crews } = assignQuarter([at('only', 1, 29.76, -95.37)], days(1, ['t1']));

    expect(crews[0]!.driveMinutes).toBe(0);
  });

  it('refuses a visit longer than a whole day, rather than overrunning one', () => {
    const { unplaced } = assignQuarter([at('long', 1, 29.76, -95.37, { onSiteMinutes: 400 })], days(3, ['t1']));

    expect(unplaced).toEqual([{ stopId: 'long', reason: 'LONGER_THAN_A_DAY' }]);
  });

  it('never gives one day more stops than it can be routed with', () => {
    const quick = sameBuilding(30, { onSiteMinutes: 5 });
    const { crews } = assignQuarter(quick, days(1, ['t1', 't2']));

    expect(crews.every((crew) => crew.stops.length <= MAX_STOPS_PER_DAY)).toBe(true);
  });

  it('orders a day so each stop leads to its neighbour', () => {
    const scattered = [at('a', 1, 29.76, -95.37), at('c', 2, 29.78, -95.37), at('b', 3, 29.77, -95.37)];
    const { crews } = assignQuarter(scattered, days(1, ['t1']));

    const order = crews[0]!.stops.map((stop) => stop.stopId).join('');
    expect(['abc', 'cba']).toContain(order);
  });
});

describe('choosing who goes out', () => {
  it('sends only technicians qualified for the kind of visit', () => {
    const hvac = stopsInRotation(3, { inspectionType: 'HVAC' });
    const { placed } = assignQuarter(hvac, days(1, ['t1', 't2'], { HVAC: ['t2'] }));

    expect(new Set(placed.map((stop) => stop.technicianId))).toEqual(new Set(['t2']));
  });

  it('says nobody is qualified when no technician may take that kind of visit', () => {
    const { unplaced } = assignQuarter(stopsInRotation(1, { inspectionType: 'HVAC' }), days(2, ['t1'], { HVAC: [] }));

    expect(unplaced).toEqual([{ stopId: 's1', reason: 'NO_QUALIFIED_TECHNICIAN' }]);
  });

  /** The tenant sees the same technician as last quarter where that is possible. */
  it('prefers the technician who took the tenancy last quarter', () => {
    const { placed } = assignQuarter(stopsInRotation(2, { previousTechnicianId: 't2' }), days(1, ['t1', 't2']));

    expect(placed.every((stop) => stop.technicianId === 't2')).toBe(true);
  });

  it('then prefers the technician the office ranks first', () => {
    const { placed } = assignQuarter(stopsInRotation(2), days(1, ['t1', 't2', 't3']), {
      technicianRank: (technicianId) => (technicianId === 't3' ? 0 : 1),
    });

    expect(placed.every((stop) => stop.technicianId === 't3')).toBe(true);
  });

  it('ranks technicians by the kind of visit being sent', () => {
    const technicianRank = (technicianId: string, inspectionType: string) =>
      (inspectionType === 'HVAC') === (technicianId === 't2') ? 0 : 1;

    const occupied = assignQuarter(stopsInRotation(1), days(1, ['t1', 't2']), { technicianRank });
    const hvac = assignQuarter(stopsInRotation(1, { inspectionType: 'HVAC' }), days(1, ['t1', 't2']), { technicianRank });

    expect(occupied.placed[0]?.technicianId).toBe('t1');
    expect(hvac.placed[0]?.technicianId).toBe('t2');
  });

  /**
   * Sending a second person out for one stop is the expensive answer. A stop
   * that does not fit its own day's technician joins one out a day away first.
   */
  it('joins a technician out on a nearby day before sending a second one out', () => {
    // Six stops are aimed at day 1 and thirteen at day 2, which holds twelve.
    // The thirteenth fits beside the six on day 1, so nobody else is sent out.
    const building = sameBuilding(19);
    const { placed, crews } = assignQuarter(building, days(2, ['t1', 't2']), {
      rotation: { position: new Map(building.map((stop, index) => [stop.stopId, index < 6 ? 0 : 20])), size: 26 },
    });

    expect(dayOf(placed).get('b19')).toBe('2026-10-01');
    expect(crews.filter((crew) => crew.date === '2026-10-02')).toHaveLength(1);
    expect(crews.filter((crew) => crew.date === '2026-10-01')).toHaveLength(1);
  });
});

describe('where the rotation crosses from one zone to the next', () => {
  /**
   * Four stops across town aimed at day one would go out as a second
   * technician's day of four. The next day is empty, so they start it instead,
   * and the stops aimed at it join them.
   */
  it('starts the next day rather than sending a second technician out for a few stops', () => {
    const west = Array.from({ length: 6 }, (_, index) => at(`w${index + 1}`, index + 1, 29.78 + index * 0.002, -95.75));
    const east = Array.from({ length: 6 }, (_, index) => at(`e${index + 1}`, index + 7, 29.55 + index * 0.002, -95.15));
    // West and the first half of east are aimed at day one; the rest of east at day two.
    const position = new Map([...west, ...east].map((stop, index) => [stop.stopId, index < 9 ? 0 : 1]));
    const { crews } = assignQuarter([...west, ...east], days(2, ['t1', 't2']), { rotation: { position, size: 2 } });

    // One technician out each day, west on the first and east on the second.
    expect(crews.map((crew) => [crew.date, crew.stops.map((stop) => stop.stopId[0]).join('')])).toEqual([
      ['2026-10-01', 'wwwwww'],
      ['2026-10-02', 'eeeeee'],
    ]);
  });
});

describe('repairing a day that measured over the limits', () => {
  it('keeps the days already laid out and places the rest around them', () => {
    const [first, second, third] = stopsInRotation(3);
    const { crews, placed } = assignQuarter([third!], days(1, ['t1', 't2']), {
      existing: [{ date: '2026-10-01', technicianId: 't1', stops: [first!, second!], driveMinutes: 4 }],
      rotation: { position: new Map([['s3', 2]]), size: 3 },
    });

    expect(placed.map((stop) => stop.stopId).sort()).toEqual(['s1', 's2', 's3']);
    expect(crews).toHaveLength(1);
    expect(crews[0]!.changed).toBe(true);
  });

  it('never puts a stop back on the day it was measured not to fit', () => {
    const [first, second, third] = stopsInRotation(3);
    const { crews } = assignQuarter([third!], days(1, ['t1', 't2']), {
      existing: [{ date: '2026-10-01', technicianId: 't1', stops: [first!, second!], driveMinutes: 4 }],
      avoid: new Map([['s3', new Set([crewKey('2026-10-01', 't1')])]]),
    });

    const withThird = crews.find((crew) => crew.stops.some((stop) => stop.stopId === 's3'))!;
    expect(withThird.technicianId).toBe('t2');
    expect(crews.find((crew) => crew.technicianId === 't1')!.changed).toBe(false);
  });
});

describe('estimating a drive before it is measured', () => {
  it('is no drive at all within one building', () => {
    expect(estimatedDriveMinutes({ latitude: 29.76, longitude: -95.37 }, { latitude: 29.76, longitude: -95.37 })).toBe(0);
  });

  it('grows with the distance', () => {
    const near = estimatedDriveMinutes({ latitude: 29.76, longitude: -95.37 }, { latitude: 29.77, longitude: -95.37 });
    const far = estimatedDriveMinutes({ latitude: 29.76, longitude: -95.37 }, { latitude: 29.96, longitude: -95.37 });
    expect(near).toBeGreaterThan(3);
    expect(far).toBeGreaterThan(near * 5);
  });
});

describe('ordering a day without a road matrix', () => {
  /**
   * The fallback, not the answer -- `shortestOpenPathOrder` with a real duration
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
