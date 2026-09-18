import { describe, expect, it } from 'vitest';

import {
  type AssignedCrew,
  type DayAnchor,
  type PlannableDay,
  type PlannableStop,
  anchorAsStop,
  anchorIdOf,
  crewKey,
  dayVisitRange,
  estimatedDriveMinutes,
  layoutEveryDay,
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

/** Stops a hundred metres or so apart around one corner of town, `latitude` north. */
const cluster = (prefix: string, count: number, from = 1, extra: Partial<PlannableStop> = {}, latitude = 29.76) =>
  Array.from({ length: count }, (_, index) =>
    at(`${prefix}${index + 1}`, from + index, latitude + index * 0.001, -95.37 + (index % 3) * 0.001, extra),
  );

const stopIds = (crew: AssignedCrew) => crew.stops.map((stop) => stop.stopId).sort();

/** The estimated drive through a day's stops in the order given. */
const drivenMinutes = (stops: readonly PlannableStop[]) =>
  stops.slice(1).reduce((total, stop, index) => total + estimatedDriveMinutes(stops[index]!, stop), 0);

/**
 * The office's rules (2026-09-18): the whole crew every planned day, from the
 * quarter's first, until every visit has a day -- nine to twelve each, a zone
 * each a week.
 */
describe('the whole crew, every day, until the visits are done', () => {
  const zones = { '1': 'moses', '2': 'kevin', '3': 'emanuel' };
  const crew = ['moses', 'kevin', 'emanuel'];

  it('gives every crew member a full day on each day from the first, until nothing is left', () => {
    const stops = [
      ...cluster('a', 24, 1, { zone: '1' }),
      ...cluster('b', 24, 30, { zone: '2' }, 29.96),
      ...cluster('c', 24, 60, { zone: '3' }, 29.56),
    ];

    const { crews, unplaced } = layoutEveryDay(stops, days(10, crew, { zoneTechnicians: zones }));

    expect(unplaced).toEqual([]);
    expect(crews.map((day) => `${day.date} ${day.technicianId} ${day.stops.length}`)).toEqual([
      '2026-10-01 emanuel 12',
      '2026-10-01 kevin 12',
      '2026-10-01 moses 12',
      '2026-10-02 emanuel 12',
      '2026-10-02 kevin 12',
      '2026-10-02 moses 12',
    ]);
  });

  it('starts each crew member in their zone of the week', () => {
    const stops = [
      ...cluster('a', 12, 1, { zone: '1' }),
      ...cluster('b', 12, 30, { zone: '2' }, 29.96),
      ...cluster('c', 12, 60, { zone: '3' }, 29.56),
    ];

    const { crews } = layoutEveryDay(stops, days(3, crew, { zoneTechnicians: zones }));

    for (const day of crews) {
      const owned = Object.keys(zones).find((zone) => zones[zone as keyof typeof zones] === day.technicianId);
      expect(new Set(day.stops.map((stop) => stop.zone))).toEqual(new Set([owned]));
    }
  });

  /** Whoever was first last quarter is first again. */
  it('starts a zone’s first day from the visit first in last quarter’s order', () => {
    const later = cluster('later', 9, 1, { zone: '1' });
    const first = cluster('first', 9, 10, { zone: '1' }, 29.96);
    const rotation = {
      position: new Map([
        ...first.map((stop, index): [string, number] => [stop.stopId, index]),
        ...later.map((stop, index): [string, number] => [stop.stopId, 9 + index]),
      ]),
    };

    const { crews } = layoutEveryDay([...later, ...first], days(5, ['moses'], { zoneTechnicians: { '1': 'moses' } }), {
      rotation,
    });

    expect(crews.map((day) => day.date)).toEqual(['2026-10-01', '2026-10-02']);
    expect(stopIds(crews[0]!).every((id) => id.startsWith('first'))).toBe(true);
  });

  it('sends a crew member whose zone is done to the zone nobody has that week', () => {
    const stops = [
      ...cluster('own', 9, 1, { zone: '1' }),
      ...cluster('kevins', 24, 20, { zone: '2' }, 29.96),
      ...cluster('nobodys', 9, 50, { zone: '3' }, 29.56),
    ];

    const { crews } = layoutEveryDay(stops, days(5, ['moses', 'kevin'], { zoneTechnicians: { '1': 'moses', '2': 'kevin' } }));

    const second = crews.find((day) => day.technicianId === 'moses' && day.date === '2026-10-02')!;
    expect(new Set(second.stops.map((stop) => stop.zone))).toEqual(new Set(['3']));
  });

  it('then to the zone nearest their home', () => {
    const stops = [
      ...cluster('own', 9, 1, { zone: '1' }),
      ...cluster('north', 30, 20, { zone: '2' }, 29.96),
      ...cluster('south', 40, 60, { zone: '3' }, 29.56),
    ];
    const homes = new Map([['moses', { latitude: 29.5, longitude: -95.37 }]]);

    const { crews } = layoutEveryDay(stops, days(5, crew, { zoneTechnicians: zones }), { homes });

    const second = crews.find((day) => day.technicianId === 'moses' && day.date === '2026-10-02')!;
    expect(new Set(second.stops.map((stop) => stop.zone))).toEqual(new Set(['3']));
  });

  it('gives a crew member with no zone that week a day all the same', () => {
    const { crews } = layoutEveryDay(
      cluster('a', 24, 1, { zone: '1' }),
      days(3, ['moses', 'kevin'], { zoneTechnicians: { '1': 'moses' } }),
    );

    expect(crews.filter((day) => day.date === '2026-10-01').map((day) => day.technicianId).sort()).toEqual(['kevin', 'moses']);
  });

  it('holds a day to twelve', () => {
    expect(layoutEveryDay(cluster('s', 24), days(5, ['t1'])).crews.map((day) => day.stops.length)).toEqual([12, 12]);
  });

  /** Long visits: six hours on site is eight of them, so this is where a day holds fewer than nine. */
  it('holds a day to six hours on site', () => {
    const sameBuilding = Array.from({ length: 10 }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37, { onSiteMinutes: 45 }));

    const { crews } = layoutEveryDay(sameBuilding, days(5, ['t1']));

    expect(crews.map((day) => day.onSiteMinutes)).toEqual([360, 90]);
  });

  it('brings a short last day up to nine from a fuller one', () => {
    const { crews } = layoutEveryDay(cluster('s', 20), days(5, ['t1']));

    expect(crews.map((day) => day.stops.length)).toEqual([11, 9]);
  });

  /** Ten kilometres apart in a line, eighteen minutes a leg by the estimate: the office would rather drive (2026-09-17). */
  it('keeps nine to a day however far apart the properties are', () => {
    const line = Array.from({ length: 18 }, (_, index) => at(`l${index + 1}`, index + 1, 29.76 + index * 0.0899, -95.37));

    const { crews, unplaced } = layoutEveryDay(line, days(10, ['t1']));

    expect(unplaced).toEqual([]);
    expect(crews.map((day) => day.stops.length)).toEqual([9, 9]);
    for (const day of crews) expect(day.driveMinutes).toBeGreaterThan(90);
  });

  it('keeps every day to nine to twelve, with the drive it says, when the properties are scattered', () => {
    // Scattered on a fixed pseudo-random pattern, so the test is the same every run.
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const scattered = Array.from({ length: 30 }, (_, index) => at(`p${index + 1}`, index + 1, 29.6 + next() * 0.3, -95.5 + next() * 0.3));

    const { crews, unplaced } = layoutEveryDay(scattered, days(10, ['t1']));

    expect(unplaced).toEqual([]);
    for (const day of crews) {
      expect(day.stops.length).toBeGreaterThanOrEqual(9);
      expect(day.stops.length).toBeLessThanOrEqual(12);
      expect(day.driveMinutes).toBeCloseTo(drivenMinutes(day.stops), 6);
    }
    expect(crews.flatMap((day) => day.stops.map((stop) => stop.stopId)).sort()).toEqual(scattered.map((stop) => stop.stopId).sort());
  });

  it('never lays a day on a technician-day a coordinator already took', () => {
    const { crews } = layoutEveryDay(cluster('s', 9), days(3, ['t1']), { taken: new Set([crewKey('2026-10-01', 't1')]) });

    expect(crews.map((day) => day.date)).toEqual(['2026-10-02']);
  });

  it('numbers each day’s stops from one, in driving order', () => {
    const { crews, placed } = layoutEveryDay(cluster('s', 9), days(3, ['t1']));

    expect(placed.map((stop) => stop.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(placed.map((stop) => stop.stopId)).toEqual(crews[0]!.stops.map((stop) => stop.stopId));
  });

  it('says why a stop has no day', () => {
    expect(layoutEveryDay(cluster('s', 2), []).unplaced).toEqual([
      { stopId: 's1', reason: 'NO_WORKING_DAYS' },
      { stopId: 's2', reason: 'NO_WORKING_DAYS' },
    ]);
    expect(layoutEveryDay([at('long', 1, 29.76, -95.37, { onSiteMinutes: 400 })], days(3, ['t1'])).unplaced).toEqual([
      { stopId: 'long', reason: 'LONGER_THAN_A_DAY' },
    ]);
    expect(
      layoutEveryDay([at('hvac', 1, 29.76, -95.37, { inspectionType: 'HVAC' })], days(3, ['t1'], { qualified: { HVAC: [] } })).unplaced,
    ).toEqual([{ stopId: 'hvac', reason: 'NO_QUALIFIED_TECHNICIAN' }]);
    // Two full days of stops, and one day to put them on.
    const sameBuilding = Array.from({ length: 13 }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37));
    expect(layoutEveryDay(sameBuilding, days(1, ['t1'])).unplaced).toEqual([{ stopId: expect.any(String), reason: 'NO_CAPACITY' }]);
  });

  it('reports demand against capacity in minutes', () => {
    expect(layoutEveryDay(cluster('s', 4), days(2, ['t1', 't2'])).capacity).toEqual({
      stops: 4,
      onSiteMinutes: 120,
      availableMinutes: 4 * 360,
    });
  });
});

/**
 * The office (2026-09-18): "we will still follow the zoning but if there's a
 * property that is near ... like 5 mins away then let's add it to the group also."
 */
describe('a property within five minutes of a day', () => {
  const owners = { zoneTechnicians: { '1': 'moses', '2': 'kevin' } };
  const home = cluster('home', 9, 1, { zone: '1' });
  const kevins = cluster('k', 9, 20, { zone: '2' }, 29.96);

  it('joins the day, whatever zone it is in', () => {
    // Half a kilometre north of Moses's visits, and in Kevin's zone.
    const neighbour = at('neighbour', 30, 29.7735, -95.37, { zone: '2' });

    const { crews } = layoutEveryDay([...home, ...kevins, neighbour], days(3, ['moses', 'kevin'], owners));

    expect(stopIds(crews.find((day) => day.technicianId === 'moses')!)).toContain('neighbour');
  });

  it('does not when it is further than that', () => {
    // Five kilometres north: ten minutes by the estimate, and Kevin's to visit.
    const further = at('further', 30, 29.81, -95.37, { zone: '2' });

    const { crews } = layoutEveryDay([...home, ...kevins, further], days(3, ['moses', 'kevin'], owners));

    expect(stopIds(crews.find((day) => day.technicianId === 'moses')!)).not.toContain('further');
    expect(stopIds(crews.find((day) => day.technicianId === 'kevin')!)).toContain('further');
  });
});

/** Zone 5 is some 200 km from every home (2026-09-18): "a 3-day trip for one person". */
describe('a zone too far for a day’s drive', () => {
  /** Nacogdoches-ish, 34 visits: three days of twelve at most. */
  const far = Array.from({ length: 34 }, (_, index) =>
    at(`far${index + 1}`, 100 + index, 31.6 + (index % 6) * 0.004, -94.65 + Math.floor(index / 6) * 0.004, { zone: '5' }),
  );
  const local = cluster('local', 12, 1, { zone: '1' });
  const homes = new Map([
    ['moses', { latitude: 29.76, longitude: -95.37 }],
    ['kevin', { latitude: 30.3, longitude: -95.0 }],
  ]);
  const owners = { zoneTechnicians: { '1': 'moses' } };

  it('is a trip of back-to-back days for the crew member living nearest it', () => {
    const { crews, unplaced } = layoutEveryDay([...local, ...far], days(10, ['moses', 'kevin'], owners), {
      homes,
      tripZones: ['5'],
    });

    expect(unplaced).toEqual([]);
    const trip = crews.filter((day) => day.trip);
    expect(trip.map((day) => `${day.date} ${day.technicianId} day ${day.trip!.day} of ${day.trip!.days}`)).toEqual([
      '2026-10-01 kevin day 1 of 3',
      '2026-10-02 kevin day 2 of 3',
      '2026-10-03 kevin day 3 of 3',
    ]);
    for (const day of trip) {
      expect(day.stops.length).toBeGreaterThanOrEqual(9);
      expect(day.stops.every((stop) => stop.zone === '5')).toBe(true);
    }
    // Nobody else's days go near it.
    expect(crews.filter((day) => !day.trip).flatMap((day) => day.stops).some((stop) => stop.zone === '5')).toBe(false);
  });

  it('goes on days in a row, never across a weekend or a closed day', () => {
    const planned = ['2026-10-01', '2026-10-02', '2026-10-06', '2026-10-07', '2026-10-08'].map((date) => ({
      date,
      technicianIds: ['moses', 'kevin'],
      ...owners,
    }));

    const { crews } = layoutEveryDay([...local, ...far], planned, { homes, tripZones: ['5'] });

    expect(crews.filter((day) => day.trip).map((day) => day.date)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
  });

  it('says so when no run of days in a row is free for anyone', () => {
    const { unplaced } = layoutEveryDay(far, days(2, ['moses', 'kevin'], owners), { homes, tripZones: ['5'] });

    expect(unplaced).toHaveLength(34);
    expect(new Set(unplaced.map((entry) => entry.reason))).toEqual(new Set(['NO_TRIP_DAYS']));
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
  const south = cluster('s', 12, 10, { zone: '2' }, 29.56);

  it('gives the move-out’s day the visits nearest it, whatever zone they are in', () => {
    const { crews, skippedAnchors, unplaced } = layoutEveryDay([...north, ...south], zoned(10), {
      anchors: [moveOut('move-out-1', '2026-10-01', 29.56)],
    });

    const anchored = crews.find((day) => day.anchors?.length)!;
    expect(skippedAnchors).toEqual([]);
    expect(unplaced).toEqual([]);
    expect(anchored).toMatchObject({ date: '2026-10-01', technicianId: 'moses' });
    expect(anchored.anchors!.map((anchor) => anchor.id)).toEqual(['move-out-1']);
    // Kevin's zone that day, because that is where the move-out is.
    expect(new Set(anchored.stops.map((stop) => stop.zone))).toEqual(new Set(['2']));
    expect(anchored.stops.length).toBeGreaterThanOrEqual(6);
  });

  it('counts the move-out’s hour on site, and three visits fewer (the office, 2026-09-18)', () => {
    const { crews } = layoutEveryDay([...north, ...south], zoned(10), { anchors: [moveOut('move-out-1', '2026-10-01', 29.56)] });

    const anchored = crews.find((day) => day.anchors?.length)!;
    expect(anchored.stops.length).toBeLessThanOrEqual(9);
    expect(anchored.onSiteMinutes).toBe(60 + anchored.stops.length * 30);
    expect(anchored.stops.every((stop) => anchorIdOf(stop) === null)).toBe(true);
  });

  it('takes three visits fewer for each move-out or move-in on the day', () => {
    const on = (count: number) =>
      layoutEveryDay([...north, ...south], zoned(10), {
        anchors: Array.from({ length: count }, (_, index) =>
          moveOut(`booked-${index}`, '2026-10-01', 29.56, index % 2 ? { kind: 'MOVE_IN' } : {}),
        ),
      }).crews.find((day) => day.anchors?.length)!;

    expect(on(2).stops.length).toBeLessThanOrEqual(6);
    expect(on(2).stops.length).toBeGreaterThanOrEqual(3);
    expect(on(3).stops.length).toBeLessThanOrEqual(3);
    // Four take the whole day: Moses's move-outs and nothing else.
    expect(on(4)).toMatchObject({ stops: [], onSiteMinutes: 240 });
  });

  it('holds nine to twelve visits besides none, three fewer at each end for each', () => {
    const limits = { maxOnSiteMinutes: 360, minStopsPerDay: 9, maxStopsPerDay: 12 };

    expect([0, 1, 2, 3, 4].map((anchors) => dayVisitRange(limits, anchors))).toEqual([
      { min: 9, max: 12 },
      { min: 6, max: 9 },
      { min: 3, max: 6 },
      { min: 0, max: 3 },
      { min: 0, max: 0 },
    ]);
  });

  it('keeps a move-out’s day after the visits are done, with the move-out alone', () => {
    const { crews } = layoutEveryDay(north, zoned(10), { anchors: [moveOut('move-out-1', '2026-10-08', 29.56)] });

    expect(crews.find((day) => day.anchors?.length)).toMatchObject({ date: '2026-10-08', stops: [], onSiteMinutes: 60 });
  });

  it('says why a move-out has no day built around it', () => {
    const { crews, skippedAnchors } = layoutEveryDay(north, zoned(3), {
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
    expect(crews.some((day) => day.anchors?.length)).toBe(false);
  });

  it('routes a move-out or move-in as a stop of its day, told apart from the visits', () => {
    const stop = anchorAsStop(moveOut('move-out-1', '2026-10-03', 29.56));

    expect(stop).toMatchObject({ latitude: 29.56, onSiteMinutes: 60, zone: null, inspectionType: 'MOVE_OUT' });
    expect(anchorIdOf(stop)).toBe('move-out-1');
    expect(anchorIdOf(north[0]!)).toBeNull();
    expect(anchorAsStop(moveOut('move-in-1', '2026-10-03', 29.56, { kind: 'MOVE_IN' })).inspectionType).toBe('MOVE_IN');
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
