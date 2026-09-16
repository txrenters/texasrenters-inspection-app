import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DAY_LIMITS,
  type AssignedCrew,
  type PlannableDay,
  type PlannableStop,
  crewKey,
  estimatedDriveMinutes,
  foldIntoDays,
  layoutFullDays,
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

/** Consecutive days from October 1, 2026. */
const days = (count: number, technicianIds: string[], extra: Partial<PlannableDay> = {}): PlannableDay[] =>
  Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10),
    technicianIds,
    ...extra,
  }));

/** Stops a hundred metres or so apart around one corner of town. */
const cluster = (prefix: string, count: number, from = 1, extra: Partial<PlannableStop> = {}) =>
  Array.from({ length: count }, (_, index) =>
    at(`${prefix}${index + 1}`, from + index, 29.76 + index * 0.001, -95.37 + (index % 3) * 0.001, extra),
  );

/** A rotation where the stop at position p is due on day p of `days(size)`. */
const dueOn = (entries: [string, number][], size: number) => ({ position: new Map(entries), size });

const stopIds = (crew: AssignedCrew) => crew.stops.map((stop) => stop.stopId).sort();

/**
 * The office's rule (2026-09-16): at least nine visits a day, inside six hours
 * on site and ninety minutes between the properties.
 */
describe('laying the quarter out in full days', () => {
  it('fills a day before starting another', () => {
    const { crews } = layoutFullDays(cluster('s', 12), days(5, ['t1']));

    expect(crews).toHaveLength(1);
    expect(crews[0]!.stops).toHaveLength(12);
  });

  it('starts the next day when a day is full, and makes it full too', () => {
    const { crews } = layoutFullDays(cluster('s', 21), days(10, ['t1']));

    expect(crews.map((crew) => crew.stops.length)).toEqual([12, 9]);
  });

  it('holds a day to six hours on site', () => {
    const sameBuilding = Array.from({ length: 13 }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37));

    const { crews } = layoutFullDays(sameBuilding, days(5, ['t1']));

    expect(crews.map((crew) => crew.onSiteMinutes)).toEqual([360, 30]);
  });

  /** Ten kilometres apart in a line: eighteen minutes a leg by the estimate, so five legs is ninety. */
  it('holds a day to ninety minutes of driving between its properties', () => {
    const line = Array.from({ length: 7 }, (_, index) => at(`l${index + 1}`, index + 1, 29.76 + index * 0.0899, -95.37));

    const { crews } = layoutFullDays(line, days(5, ['t1']));

    expect(crews.map((crew) => crew.stops.length)).toEqual([6, 1]);
    for (const crew of crews) expect(crew.driveMinutes).toBeLessThanOrEqual(DEFAULT_DAY_LIMITS.maxDriveMinutes);
  });

  it('builds a day from the visits that add least driving, not the next in the rotation', () => {
    // Alternating between two corners of town 30 km apart, all due the same fortnight.
    const stops = Array.from({ length: 18 }, (_, index) =>
      at(`x${index + 1}`, index + 1, index % 2 ? 30.03 : 29.76, -95.37 + index * 0.0005),
    );

    const { crews } = layoutFullDays(stops, days(10, ['t1']));

    expect(crews).toHaveLength(2);
    for (const crew of crews) expect(new Set(crew.stops.map((stop) => stop.latitude)).size).toBe(1);
  });

  /** A tenant's visits stay about ninety days apart: at most two weeks from last quarter's day. */
  it('keeps each visit near its day in the rotation, however close the properties are', () => {
    const early = cluster('e', 9);
    const late = cluster('l', 9, 10);
    const rotation = dueOn([...early.map((stop): [string, number] => [stop.stopId, 0]), ...late.map((stop): [string, number] => [stop.stopId, 40])], 50);

    const { crews } = layoutFullDays([...early, ...late], days(50, ['t1']), { rotation });

    expect(crews.map((crew) => crew.date)).toEqual(['2026-10-01', '2026-11-10']);
  });

  /**
   * A day left short gives its visits to another day that can take them: two
   * visits due just outside the first day's reach from its first visit, but
   * inside two weeks of the day as it came out.
   */
  it('folds a short day into another day of the zone', () => {
    const seed = at('seed', 1, 29.76, -95.37);
    const middle = cluster('m', 8, 2);
    const later = cluster('late', 2, 10);
    const rotation = dueOn(
      [
        ['seed', 0],
        ...middle.map((stop, index): [string, number] => [stop.stopId, 10 + index]),
        ['late1', 20],
        ['late2', 21],
      ],
      30,
    );

    const { crews } = layoutFullDays([seed, ...middle, ...later], days(30, ['t1']), { rotation });

    expect(crews).toHaveLength(1);
    expect(crews[0]!.stops).toHaveLength(11);
  });

  it('gives a zone’s visits only to whoever has the zone that day', () => {
    const zoned = days(14, ['moses', 'kevin']).map((day, index) => ({
      ...day,
      zoneTechnicians: index < 7 ? { '1': 'moses', '2': 'kevin' } : { '1': 'kevin', '2': 'moses' },
    }));
    const north = cluster('n', 9, 1, { zone: '1' });
    const south = cluster('s', 9, 10, { zone: '2' }).map((stop) => ({ ...stop, latitude: stop.latitude - 0.2 }));

    const { crews } = layoutFullDays([...north, ...south], zoned);

    expect(crews).toHaveLength(2);
    for (const crew of crews) {
      const zones = new Set(crew.stops.map((stop) => stop.zone));
      expect(zones.size).toBe(1);
      const owners = zoned.find((day) => day.date === crew.date)!.zoneTechnicians;
      expect(crew.technicianId).toBe(owners[crew.stops[0]!.zone!]);
    }
  });

  it('never lays a day on a technician-day a coordinator already took', () => {
    const { crews } = layoutFullDays(cluster('s', 9), days(3, ['t1']), { taken: new Set([crewKey('2026-10-01', 't1')]) });

    expect(crews.map((crew) => crew.date)).toEqual(['2026-10-02']);
  });

  it('numbers each day’s stops from one, in driving order', () => {
    const { crews, placed } = layoutFullDays(cluster('s', 9), days(3, ['t1']));

    expect(placed.map((stop) => stop.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(placed.map((stop) => stop.stopId)).toEqual(crews[0]!.stops.map((stop) => stop.stopId));
  });

  it('says why a stop has no day', () => {
    expect(layoutFullDays(cluster('s', 2), []).unplaced).toEqual([
      { stopId: 's1', reason: 'NO_WORKING_DAYS' },
      { stopId: 's2', reason: 'NO_WORKING_DAYS' },
    ]);
    expect(layoutFullDays([at('long', 1, 29.76, -95.37, { onSiteMinutes: 400 })], days(3, ['t1'])).unplaced).toEqual([
      { stopId: 'long', reason: 'LONGER_THAN_A_DAY' },
    ]);
    expect(
      layoutFullDays([at('hvac', 1, 29.76, -95.37, { inspectionType: 'HVAC' })], days(3, ['t1'], { qualified: { HVAC: [] } })).unplaced,
    ).toEqual([{ stopId: 'hvac', reason: 'NO_QUALIFIED_TECHNICIAN' }]);
    // Two full days of stops, and one day to put them on.
    const sameBuilding = Array.from({ length: 13 }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37));
    expect(layoutFullDays(sameBuilding, days(1, ['t1'])).unplaced).toEqual([{ stopId: expect.any(String), reason: 'NO_CAPACITY' }]);
  });

  it('reports demand against capacity in minutes', () => {
    expect(layoutFullDays(cluster('s', 4), days(2, ['t1', 't2'])).capacity).toEqual({
      stops: 4,
      onSiteMinutes: 120,
      availableMinutes: 4 * 360,
    });
  });
});

/** After Google measures a day over the limit: the stops it could not keep. */
describe('folding the visits a measured day could not keep into other days', () => {
  const crew = (date: string, technicianId: string, stops: PlannableStop[]): AssignedCrew => ({
    date,
    technicianId,
    stops,
    onSiteMinutes: stops.reduce((total, stop) => total + stop.onSiteMinutes, 0),
    driveMinutes: 10,
    changed: false,
  });

  it('gives a stop to the day that adds least driving, never the day it came off', () => {
    const quarter = days(5, ['t1']);
    const crews = [
      crew('2026-10-01', 't1', cluster('a', 4)),
      crew('2026-10-02', 't1', cluster('b', 4).map((stop) => ({ ...stop, latitude: stop.latitude + 0.05 }))),
    ];
    const moved = at('moved', 20, 29.761, -95.37);

    const result = foldIntoDays([moved], crews, quarter, { avoid: new Map([['moved', new Set([crewKey('2026-10-01', 't1')])]]) });

    expect(result.unplaced).toEqual([]);
    expect(stopIds(result.crews[1]!)).toContain('moved');
    expect(result.crews[1]!.changed).toBe(true);
    expect(result.crews[0]!.changed).toBe(false);
  });

  it('opens a day of its own only when no day near its week can take the stop', () => {
    const quarter = days(5, ['t1']);
    const full = crew('2026-10-01', 't1', Array.from({ length: 12 }, (_, index) => at(`f${index + 1}`, index + 1, 29.76, -95.37)));

    const result = foldIntoDays([at('extra', 20, 29.76, -95.37)], [full], quarter, {
      rotation: { position: new Map([['extra', 1]]), size: 5 },
    });

    expect(result.unplaced).toEqual([]);
    expect(result.crews).toHaveLength(2);
    expect(result.crews[1]).toMatchObject({ date: '2026-10-02', technicianId: 't1', changed: true });
    expect(stopIds(result.crews[1]!)).toEqual(['extra']);
  });

  it('returns a stop for a person when there is no free day near its week either', () => {
    const quarter = days(1, ['t1']);
    const full = crew('2026-10-01', 't1', Array.from({ length: 12 }, (_, index) => at(`f${index + 1}`, index + 1, 29.76, -95.37)));

    const result = foldIntoDays([at('extra', 20, 29.76, -95.37)], [full], quarter);

    expect(result.crews).toHaveLength(1);
    expect(result.unplaced).toEqual([{ stopId: 'extra', reason: 'NO_CAPACITY' }]);
  });

  it('gives a stop only to whoever has its zone that day', () => {
    const quarter = days(1, ['moses', 'kevin']).map((day) => ({ ...day, zoneTechnicians: { '1': 'moses', '2': 'kevin' } }));
    const crews = [crew('2026-10-01', 'kevin', cluster('k', 3, 1, { zone: '2' }))];

    const result = foldIntoDays([at('north', 9, 29.76, -95.37, { zone: '1' })], crews, quarter);

    expect(stopIds(result.crews[0]!)).not.toContain('north');
    expect(result.crews[1]).toMatchObject({ date: '2026-10-01', technicianId: 'moses' });
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
