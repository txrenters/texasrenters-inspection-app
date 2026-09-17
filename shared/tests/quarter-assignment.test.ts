import { describe, expect, it } from 'vitest';

import {
  type AssignedCrew,
  type DayAnchor,
  type PlannableDay,
  type PlannableStop,
  anchorAsStop,
  anchorIdOf,
  crewKey,
  estimatedDriveMinutes,
  improveDays,
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

/** The estimated drive through a day's stops in the order given. */
const drivenMinutes = (stops: readonly PlannableStop[]) =>
  stops.slice(1).reduce((total, stop, index) => total + estimatedDriveMinutes(stops[index]!, stop), 0);

/**
 * The office's rules (2026-09-17): nine to twelve visits every day, and the
 * driving between the properties kept as short as that allows, never capped.
 */
describe('laying the quarter out in full days', () => {
  it('fills a day before starting another, and holds it to twelve', () => {
    expect(layoutFullDays(cluster('s', 12), days(5, ['t1'])).crews.map((crew) => crew.stops.length)).toEqual([12]);
    expect(layoutFullDays(cluster('s', 24), days(5, ['t1'])).crews.map((crew) => crew.stops.length)).toEqual([12, 12]);
  });

  it('starts the next day when a day is full, and makes it full too', () => {
    const { crews } = layoutFullDays(cluster('s', 21), days(10, ['t1']));

    expect(crews).toHaveLength(2);
    for (const crew of crews) expect(crew.stops.length).toBeGreaterThanOrEqual(9);
    expect(crews.reduce((total, crew) => total + crew.stops.length, 0)).toBe(21);
  });

  /** Long visits: six hours on site is eight of them, so this is where a day holds fewer than nine. */
  it('holds a day to six hours on site', () => {
    const sameBuilding = Array.from({ length: 10 }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37, { onSiteMinutes: 45 }));

    const { crews } = layoutFullDays(sameBuilding, days(5, ['t1']));

    expect(crews.map((crew) => crew.onSiteMinutes)).toEqual([360, 90]);
  });

  /**
   * Ten kilometres apart in a line, eighteen minutes a leg by the estimate. The
   * old ninety-minute limit made a day of six and a day of one of these; the
   * office would rather drive (2026-09-17).
   */
  it('keeps nine to a day however far apart the properties are', () => {
    const line = Array.from({ length: 18 }, (_, index) => at(`l${index + 1}`, index + 1, 29.76 + index * 0.0899, -95.37));

    const { crews, unplaced } = layoutFullDays(line, days(10, ['t1']));

    expect(unplaced).toEqual([]);
    expect(crews.map((crew) => crew.stops.length)).toEqual([9, 9]);
    for (const crew of crews) expect(crew.driveMinutes).toBeGreaterThan(90);
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

  /** A tenant's visits stay about ninety days apart: at most three weeks from last quarter's day. */
  it('keeps each visit near its day in the rotation, however close the properties are', () => {
    const early = cluster('e', 9);
    const late = cluster('l', 9, 10);
    const rotation = dueOn([...early.map((stop): [string, number] => [stop.stopId, 0]), ...late.map((stop): [string, number] => [stop.stopId, 40])], 50);

    const { crews } = layoutFullDays([...early, ...late], days(50, ['t1']), { rotation });

    expect(crews.map((crew) => crew.date)).toEqual(['2026-10-01', '2026-11-10']);
  });

  /** A day of nine comes first: the one visit due weeks after the rest joins their day rather than make a day of one. */
  it('moves a visit past three weeks only to keep a day from falling short of nine', () => {
    const early = cluster('e', 9);
    const late = at('late', 10, 29.765, -95.37);
    const rotation = dueOn([...early.map((stop): [string, number] => [stop.stopId, 0]), ['late', 40]], 50);

    const { crews, unplaced } = layoutFullDays([...early, late], days(50, ['t1']), { rotation });

    expect(unplaced).toEqual([]);
    expect(crews).toHaveLength(1);
    expect(crews[0]).toMatchObject({ date: '2026-10-01' });
    expect(stopIds(crews[0]!)).toContain('late');
  });

  /** Six weeks at most: a tenant visited months off their cycle is worse off than a short day. */
  it('never moves a visit more than six weeks from its week, even for a day of nine', () => {
    const early = cluster('e', 9);
    const late = at('late', 10, 29.765, -95.37);
    const rotation = dueOn([...early.map((stop): [string, number] => [stop.stopId, 0]), ['late', 70]], 80);

    const { crews } = layoutFullDays([...early, late], days(80, ['t1']), { rotation });

    const lateDay = crews.find((crew) => stopIds(crew).includes('late'))!;
    expect(lateDay.date).toBe('2026-12-10');
    expect(lateDay.stops).toHaveLength(1);
  });

  /**
   * A day left short gives its visits to another day that can take them: two
   * visits due just outside the first day's reach from its first visit, but
   * inside three weeks of the day as it came out.
   */
  it('folds a short day into another day of the zone', () => {
    const seed = at('seed', 1, 29.76, -95.37);
    const middle = cluster('m', 8, 2);
    const later = cluster('late', 2, 10);
    const rotation = dueOn(
      [
        ['seed', 0],
        ...middle.map((stop, index): [string, number] => [stop.stopId, 10 + index]),
        ['late1', 25],
        ['late2', 26],
      ],
      30,
    );

    const { crews } = layoutFullDays([seed, ...middle, ...later], days(30, ['t1']), { rotation });

    expect(crews).toHaveLength(1);
    expect(crews[0]!.stops).toHaveLength(11);
  });

  it('gives a zone’s visits only to whoever has the zone that day', () => {
    const zoned: PlannableDay[] = days(14, ['moses', 'kevin']).map((day, index) => ({
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
      const owners = zoned.find((day) => day.date === crew.date)!.zoneTechnicians!;
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

/** Days a planner already has, made better where they stand. */
describe('shortening the driving across days', () => {
  const crew = (date: string, technicianId: string, stops: PlannableStop[]): AssignedCrew => ({
    date,
    technicianId,
    stops,
    onSiteMinutes: stops.reduce((total, stop) => total + stop.onSiteMinutes, 0),
    driveMinutes: drivenMinutes(stops),
  });
  const north = (prefix: string, count: number, extra: Partial<PlannableStop> = {}) => cluster(prefix, count, 1, extra);
  /** Some twenty kilometres south of `north`. */
  const south = (prefix: string, count: number, extra: Partial<PlannableStop> = {}) =>
    cluster(prefix, count, 50, extra).map((stop) => ({ ...stop, latitude: stop.latitude - 0.2 }));

  it('trades visits between two days when each is on the other’s side of town', () => {
    const [strayNorth] = north('stray-n', 1);
    const [straySouth] = south('stray-s', 1);
    const crews = [
      crew('2026-10-01', 't1', [...north('n', 9), straySouth!]),
      crew('2026-10-02', 't1', [...south('s', 9), strayNorth!]),
    ];

    const improved = improveDays(crews, days(5, ['t1']));

    expect(improved).toHaveLength(2);
    for (const day of improved) expect(new Set(day.stops.map((stop) => stop.latitude > 29.7)).size).toBe(1);
    expect(improved.reduce((total, day) => total + day.driveMinutes, 0)).toBeLessThan(
      crews.reduce((total, day) => total + day.driveMinutes, 0) / 2,
    );
  });

  it('never takes a day under nine or over twelve, and never lengthens the driving', () => {
    // Scattered on a fixed pseudo-random pattern, so the test is the same every run.
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const scattered = Array.from({ length: 30 }, (_, index) => at(`p${index + 1}`, index + 1, 29.6 + next() * 0.3, -95.5 + next() * 0.3));
    const crews = [
      crew('2026-10-01', 't1', scattered.slice(0, 9)),
      crew('2026-10-02', 't1', scattered.slice(9, 18)),
      crew('2026-10-05', 't1', scattered.slice(18)),
    ];

    const improved = improveDays(crews, days(10, ['t1']));

    for (const day of improved) {
      expect(day.stops.length).toBeGreaterThanOrEqual(9);
      expect(day.stops.length).toBeLessThanOrEqual(12);
      expect(day.driveMinutes).toBeCloseTo(drivenMinutes(day.stops), 6);
    }
    expect(improved.flatMap((day) => day.stops.map((stop) => stop.stopId)).sort()).toEqual(scattered.map((stop) => stop.stopId).sort());
    expect(improved.reduce((total, day) => total + day.driveMinutes, 0)).toBeLessThanOrEqual(
      crews.reduce((total, day) => total + day.driveMinutes, 0),
    );
  });

  it('gives a visit only to whoever has its zone that day, however much driving it would save', () => {
    const zoned = days(2, ['moses', 'kevin']).map((day) => ({ ...day, zoneTechnicians: { '1': 'moses', '2': 'kevin' } }));
    const [outlier] = north('outlier', 1, { zone: '2' });
    const crews = [crew('2026-10-01', 'moses', north('n', 10, { zone: '1' })), crew('2026-10-01', 'kevin', [...south('s', 9, { zone: '2' }), outlier!])];

    const improved = improveDays(crews, zoned);

    expect(stopIds(improved.find((day) => day.technicianId === 'kevin')!)).toContain('outlier1');
    for (const day of improved) expect(new Set(day.stops.map((stop) => stop.zone))).toEqual(new Set([day.technicianId === 'moses' ? '1' : '2']));
  });
});

/**
 * The office (2026-09-17): move-outs are Moses's, and "we should be doing TBPs
 * around those". A move-out is the anchor of its day.
 */
describe('days built around a move-out', () => {
  const moveOut = (id: string, date: string, latitude: number, extra: Partial<DayAnchor> = {}): DayAnchor => ({
    id,
    date,
    technicianId: 'moses',
    latitude,
    longitude: -95.37,
    onSiteMinutes: 60,
    ...extra,
  });
  /** Moses has zone 1 every day, and Kevin zone 2. */
  const zoned = (count: number) => days(count, ['moses', 'kevin'], { zoneTechnicians: { '1': 'moses', '2': 'kevin' } });
  const north = cluster('n', 9, 1, { zone: '1' });
  /** Kevin's zone, some twenty kilometres south, where the move-out is. */
  const south = cluster('s', 12, 10, { zone: '2' }).map((stop) => ({ ...stop, latitude: stop.latitude - 0.2 }));

  it('gives the move-out’s day the visits nearest it, whatever zone they are in', () => {
    const { crews, skippedAnchors } = layoutFullDays([...north, ...south], zoned(10), {
      anchors: [moveOut('move-out-1', '2026-10-03', 29.56)],
    });

    const anchored = crews.find((crew) => crew.anchors?.length)!;
    expect(skippedAnchors).toEqual([]);
    expect(anchored).toMatchObject({ date: '2026-10-03', technicianId: 'moses' });
    expect(anchored.anchors!.map((anchor) => anchor.id)).toEqual(['move-out-1']);
    // Kevin's zone that day, because that is where the move-out is.
    expect(new Set(anchored.stops.map((stop) => stop.zone))).toEqual(new Set(['2']));
    expect(anchored.stops.length).toBeGreaterThanOrEqual(9);
    // Moses's own zone goes on another of his days.
    expect(crews.filter((crew) => crew.technicianId === 'moses' && crew.date === '2026-10-03')).toHaveLength(1);
  });

  it('counts the move-out’s hour on site, but not toward the nine visits', () => {
    const { crews } = layoutFullDays([...north, ...south], zoned(10), { anchors: [moveOut('move-out-1', '2026-10-03', 29.56)] });

    const anchored = crews.find((crew) => crew.anchors?.length)!;
    expect(anchored.onSiteMinutes).toBe(60 + anchored.stops.length * 30);
    expect(anchored.onSiteMinutes).toBeLessThanOrEqual(360);
    expect(anchored.stops.every((stop) => anchorIdOf(stop) === null)).toBe(true);
  });

  it('only takes visits due near the move-out’s date', () => {
    const early = cluster('early', 9, 1, { zone: '1' }).map((stop) => ({ ...stop, latitude: stop.latitude - 0.2 }));
    const due = cluster('due', 9, 10, { zone: '1' });
    const rotation = dueOn(
      [...early.map((stop): [string, number] => [stop.stopId, 0]), ...due.map((stop): [string, number] => [stop.stopId, 40])],
      50,
    );
    const quarter = days(50, ['moses'], { zoneTechnicians: { '1': 'moses' } });

    // Right beside the early visits, but six weeks after they are due.
    const { crews } = layoutFullDays([...early, ...due], quarter, {
      rotation,
      anchors: [moveOut('move-out-1', '2026-11-10', 29.56)],
    });

    const anchored = crews.find((crew) => crew.anchors?.length)!;
    expect(anchored.stops.map((stop) => stop.stopId).every((id) => id.startsWith('due'))).toBe(true);
  });

  it('says why a move-out has no day built around it', () => {
    const { crews, skippedAnchors } = layoutFullDays(north, zoned(3), {
      anchors: [
        moveOut('on-no-planned-day', '2026-11-30', 29.76),
        moveOut('not-working', '2026-10-01', 29.76, { technicianId: 'amy' }),
        moveOut('taken', '2026-10-02', 29.76),
      ],
      taken: new Set([crewKey('2026-10-02', 'moses')]),
    });

    expect(skippedAnchors).toEqual([
      { anchorId: 'not-working', reason: 'TECHNICIAN_NOT_WORKING' },
      { anchorId: 'taken', reason: 'DAY_TAKEN' },
      { anchorId: 'on-no-planned-day', reason: 'NOT_A_PLANNED_DAY' },
    ]);
    expect(crews.some((crew) => crew.anchors?.length)).toBe(false);
  });

  it('routes a move-out as a stop of its day, told apart from the visits', () => {
    const stop = anchorAsStop(moveOut('move-out-1', '2026-10-03', 29.56));

    expect(stop).toMatchObject({ latitude: 29.56, onSiteMinutes: 60, zone: null });
    expect(anchorIdOf(stop)).toBe('move-out-1');
    expect(anchorIdOf(north[0]!)).toBeNull();
  });

  it('is left as it is when days are improved', () => {
    const [stray] = cluster('stray', 1, 30).map((stop) => ({ ...stop, latitude: stop.latitude - 0.2 }));
    const anchoredDay: AssignedCrew = {
      date: '2026-10-01',
      technicianId: 't1',
      stops: [...cluster('a', 9), stray!],
      onSiteMinutes: 360,
      driveMinutes: 60,
      anchors: [moveOut('move-out-1', '2026-10-01', 29.76, { technicianId: 't1' })],
    };
    const other: AssignedCrew = {
      date: '2026-10-02',
      technicianId: 't1',
      stops: cluster('b', 9, 20).map((stop) => ({ ...stop, latitude: stop.latitude - 0.2 })),
      onSiteMinutes: 270,
      driveMinutes: 30,
    };

    const improved = improveDays([anchoredDay, other], days(5, ['t1']));

    expect(stopIds(improved.find((crew) => crew.anchors?.length)!)).toEqual(stopIds(anchoredDay));
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
