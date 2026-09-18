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
  layoutByMonth,
  layoutEveryDay,
  nearestNeighbourOrder,
} from '../src/contracts/quarter-assignment.js';
import { monthOfPlan, monthOfQuarter, plannedVisitDaysOfQuarter } from '../src/index.js';

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

/** The longest estimated drive between two stops next to each other in a day. */
const longestLeg = (stops: readonly PlannableStop[]) =>
  Math.max(0, ...stops.slice(1).map((stop, index) => estimatedDriveMinutes(stops[index]!, stop)));

/** `count` stops in a line north, `kilometres` apart. */
const line = (prefix: string, count: number, kilometres: number) =>
  Array.from({ length: count }, (_, index) => at(`${prefix}${index + 1}`, index + 1, 29.76 + (index * kilometres) / 111.2, -95.37));

/**
 * The office's rules (2026-09-19): "group the properties into 9 and make sure
 * those grouping is the least drive time, that way we can still add more
 * properties to the schedule", and never more than twenty minutes from one
 * property to the next.
 */
describe('days of nine, grouped for the least driving', () => {
  it('puts nine visits on a day, not twelve, so the office can add its own', () => {
    expect(layoutEveryDay(cluster('s', 24), days(5, ['t1'])).crews.map((day) => day.stops.length).sort()).toEqual([6, 9, 9]);
  });

  /** A leg of eighteen minutes by the estimate is inside the rule; one of twenty-one is not. */
  it('never drives more than twenty minutes from one property to the next', () => {
    const eighteen = layoutEveryDay(line('a', 9, 10), days(10, ['t1']));
    const twentyOne = layoutEveryDay(line('b', 3, 12), days(10, ['t1']));

    expect(eighteen.crews.map((day) => day.stops.length)).toEqual([9]);
    expect(twentyOne.crews.map((day) => day.stops.length)).toEqual([1, 1, 1]);
    expect(twentyOne.unplaced).toEqual([]);
  });

  it('keeps a far property off a day rather than make up the nine with it', () => {
    // Nine together, and one some fifteen kilometres north: twenty-five minutes by the estimate.
    const far = at('far', 10, 29.9, -95.37);

    const { crews } = layoutEveryDay([...cluster('s', 9), far], days(5, ['t1']));

    expect(crews.map((day) => stopIds(day))).toEqual([['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'], ['far']]);
  });

  /** The day the office found (2026-09-19): three visits on one side of town, six on the other. */
  it('never splits a day between two parts of town', () => {
    // Twelve in one neighbourhood and six in another fifteen kilometres south, a day's worth apart.
    const north = cluster('n', 12);
    const south = cluster('s', 6, 20, {}, 29.62);

    const { crews } = layoutEveryDay([...north, ...south], days(5, ['t1']));

    for (const day of crews) expect(new Set(day.stops.map((stop) => stop.stopId[0]))).toHaveProperty('size', 1);
    expect(crews.map((day) => day.stops.length).sort()).toEqual([3, 6, 9]);
  });

  it('gives one or two visits left over to the day beside them, up to twelve, rather than a day of their own', () => {
    expect(layoutEveryDay(cluster('s', 10), days(5, ['t1'])).crews.map((day) => day.stops.length)).toEqual([10]);
    expect(layoutEveryDay(cluster('s', 11), days(5, ['t1'])).crews.map((day) => day.stops.length)).toEqual([11]);
    // Three left over are a day of their own: nine and three, not twelve.
    expect(layoutEveryDay(cluster('s', 12), days(5, ['t1'])).crews.map((day) => day.stops.length).sort()).toEqual([3, 9]);
  });

  it('keeps every leg inside the rule, with the drive it says, when the properties are scattered', () => {
    // Scattered on a fixed pseudo-random pattern, so the test is the same every run.
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const scattered = Array.from({ length: 40 }, (_, index) => at(`p${index + 1}`, index + 1, 29.6 + next() * 0.3, -95.5 + next() * 0.3));

    const { crews, unplaced } = layoutEveryDay(scattered, days(40, ['t1']));

    expect(unplaced).toEqual([]);
    for (const day of crews) {
      expect(day.stops.length).toBeLessThanOrEqual(12);
      expect(longestLeg(day.stops)).toBeLessThanOrEqual(20);
      expect(day.driveMinutes).toBeCloseTo(drivenMinutes(day.stops), 6);
    }
    expect(crews.flatMap((day) => day.stops.map((stop) => stop.stopId)).sort()).toEqual(scattered.map((stop) => stop.stopId).sort());
  });

  it('holds a day to the longest drive the plan allows between properties', () => {
    // Ten kilometres apart is eighteen minutes: inside twenty, outside fifteen.
    const limits = { maxOnSiteMinutes: 360, minStopsPerDay: 9, maxStopsPerDay: 12, maxLegMinutes: 15 };

    expect(layoutEveryDay(line('a', 3, 10), days(5, ['t1']), { limits }).crews.map((day) => day.stops.length)).toEqual([1, 1, 1]);
  });

  /** Long visits: six hours on site is eight of them, so this is where a day holds fewer than nine. */
  it('holds a day to six hours on site', () => {
    const sameBuilding = Array.from({ length: 10 }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37, { onSiteMinutes: 45 }));

    const { crews } = layoutEveryDay(sameBuilding, days(5, ['t1']));

    expect(crews.map((day) => day.onSiteMinutes)).toEqual([360, 90]);
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
    // A day and a third of visits, and one day to put them on.
    const sameBuilding = Array.from({ length: 12 }, (_, index) => at(`b${index + 1}`, index + 1, 29.76, -95.37, { onSiteMinutes: 20 }));
    const { unplaced } = layoutEveryDay(sameBuilding, days(1, ['t1']));
    expect(unplaced).toHaveLength(3);
    expect(new Set(unplaced.map((entry) => entry.reason))).toEqual(new Set(['NO_CAPACITY']));
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
 * The office's rules (2026-09-18): the whole crew every planned day, from the
 * quarter's first, until every visit has a day -- a zone each a week.
 */
describe('the whole crew, every day, until the visits are done', () => {
  const zones = { '1': 'moses', '2': 'kevin', '3': 'emanuel' };
  const crew = ['moses', 'kevin', 'emanuel'];

  it('gives every crew member a day on each day from the first, until nothing is left', () => {
    const stops = [
      ...cluster('a', 18, 1, { zone: '1' }),
      ...cluster('b', 18, 30, { zone: '2' }, 29.96),
      ...cluster('c', 18, 60, { zone: '3' }, 29.56),
    ];

    const { crews, unplaced } = layoutEveryDay(stops, days(10, crew, { zoneTechnicians: zones }));

    expect(unplaced).toEqual([]);
    expect(crews.map((day) => `${day.date} ${day.technicianId} ${day.stops.length}`)).toEqual([
      '2026-10-01 emanuel 9',
      '2026-10-01 kevin 9',
      '2026-10-01 moses 9',
      '2026-10-02 emanuel 9',
      '2026-10-02 kevin 9',
      '2026-10-02 moses 9',
    ]);
  });

  it('gives each crew member a day in their zone of the week', () => {
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
  it('takes a zone’s visits first in last quarter’s order first', () => {
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
      ...cluster('kevins', 27, 20, { zone: '2' }, 29.96),
      ...cluster('nobodys', 9, 50, { zone: '3' }, 29.56),
    ];

    const { crews } = layoutEveryDay(stops, days(5, ['moses', 'kevin'], { zoneTechnicians: { '1': 'moses', '2': 'kevin' } }));

    const second = crews.find((day) => day.technicianId === 'moses' && day.date === '2026-10-02')!;
    expect(new Set(second.stops.map((stop) => stop.zone))).toEqual(new Set(['3']));
  });

  it('then to the zone nearest their home', () => {
    const stops = [
      ...cluster('own', 9, 1, { zone: '1' }),
      ...cluster('north', 27, 20, { zone: '2' }, 29.96),
      ...cluster('south', 36, 60, { zone: '3' }, 29.56),
    ];
    const homes = new Map([['moses', { latitude: 29.5, longitude: -95.37 }]]);

    const { crews } = layoutEveryDay(stops, days(5, crew, { zoneTechnicians: zones }), { homes });

    const second = crews.find((day) => day.technicianId === 'moses' && day.date === '2026-10-02')!;
    expect(new Set(second.stops.map((stop) => stop.zone))).toEqual(new Set(['3']));
  });

  it('gives a crew member with no zone that week a day all the same', () => {
    const { crews } = layoutEveryDay(
      cluster('a', 18, 1, { zone: '1' }),
      days(3, ['moses', 'kevin'], { zoneTechnicians: { '1': 'moses' } }),
    );

    expect(crews.filter((day) => day.date === '2026-10-01').map((day) => day.technicianId).sort()).toEqual(['kevin', 'moses']);
  });
});

/**
 * The office (2026-09-18): "we will still follow the zoning but if there's a
 * property that is near ... like 5 mins away then let's add it to the group also."
 */
describe('a property near another zone’s day', () => {
  const owners = { zoneTechnicians: { '1': 'moses', '2': 'kevin' } };
  const home = cluster('home', 8, 1, { zone: '1' });
  const kevins = cluster('k', 8, 20, { zone: '2' }, 29.96);

  it('joins the day within five minutes of it, whatever zone it is in', () => {
    // Half a kilometre north of Moses's visits, and in Kevin's zone.
    const neighbour = at('neighbour', 30, 29.7735, -95.37, { zone: '2' });

    const { crews } = layoutEveryDay([...home, ...kevins, neighbour], days(3, ['moses', 'kevin'], owners));

    expect(stopIds(crews.find((day) => day.technicianId === 'moses')!)).toContain('neighbour');
  });

  it('goes to its own zone’s day when that is within twenty minutes', () => {
    // Twelve kilometres north of Moses's visits and eight south of Kevin's.
    const between = at('between', 30, 29.88, -95.37, { zone: '2' });

    const { crews } = layoutEveryDay([...home, ...kevins, between], days(3, ['moses', 'kevin'], owners));

    expect(stopIds(crews.find((day) => day.technicianId === 'moses')!)).not.toContain('between');
    expect(stopIds(crews.find((day) => day.technicianId === 'kevin')!)).toContain('between');
  });

  it('joins the other zone’s day as one left over, when its own zone has none within twenty minutes', () => {
    // Five kilometres north of Moses's visits, and sixteen south of Kevin's: a day of its own otherwise.
    const alone = at('alone', 30, 29.81, -95.37, { zone: '2' });

    const { crews } = layoutEveryDay([...home, ...kevins, alone], days(3, ['moses', 'kevin'], owners));

    expect(crews).toHaveLength(2);
    expect(stopIds(crews.find((day) => day.technicianId === 'moses')!)).toContain('alone');
  });
});

/** Zone 5 is some 200 km from every home (2026-09-18): "a 3-day trip for one person". */
describe('a zone too far for a day’s drive', () => {
  /** Nacogdoches-ish, 27 visits: three days of nine. */
  const far = Array.from({ length: 27 }, (_, index) =>
    at(`far${index + 1}`, 100 + index, 31.6 + (index % 6) * 0.004, -94.65 + Math.floor(index / 6) * 0.004, { zone: '5' }),
  );
  const local = cluster('local', 9, 1, { zone: '1' });
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
      expect(day.stops).toHaveLength(9);
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

    expect(unplaced).toHaveLength(27);
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
  });

  it('counts the move-out’s hour on site, and three visits fewer (the office, 2026-09-18)', () => {
    const { crews } = layoutEveryDay([...north, ...south], zoned(10), { anchors: [moveOut('move-out-1', '2026-10-01', 29.56)] });

    const anchored = crews.find((day) => day.anchors?.length)!;
    expect(anchored.stops).toHaveLength(6);
    expect(anchored.onSiteMinutes).toBe(60 + 6 * 30);
    expect(anchored.stops.every((stop) => anchorIdOf(stop) === null)).toBe(true);
  });

  it('takes three visits fewer for each move-out or move-in on the day', () => {
    const on = (count: number) =>
      layoutEveryDay([...north, ...south], zoned(10), {
        anchors: Array.from({ length: count }, (_, index) =>
          moveOut(`booked-${index}`, '2026-10-01', 29.56, index % 2 ? { kind: 'MOVE_IN' } : {}),
        ),
      }).crews.find((day) => day.anchors?.length)!;

    expect(on(2).stops).toHaveLength(3);
    // Three or more take the whole day: Moses's move-outs and nothing else.
    expect(on(3).stops).toEqual([]);
    expect(on(4)).toMatchObject({ stops: [], onSiteMinutes: 240 });
  });

  it('puts nine visits on a day and allows twelve, three fewer at each end for each', () => {
    const limits = { maxOnSiteMinutes: 360, minStopsPerDay: 9, maxStopsPerDay: 12 };

    expect([0, 1, 2, 3, 4].map((anchors) => dayVisitRange(limits, anchors))).toEqual([
      { min: 9, max: 12 },
      { min: 6, max: 9 },
      { min: 3, max: 6 },
      { min: 0, max: 3 },
      { min: 0, max: 0 },
    ]);
  });

  it('takes no visit further than the office allows from the move-out', () => {
    // The move-out twenty kilometres south of every visit.
    const { crews } = layoutEveryDay(north, zoned(10), { anchors: [moveOut('move-out-1', '2026-10-01', 29.56)] });

    expect(crews.find((day) => day.anchors?.length)).toMatchObject({ date: '2026-10-01', stops: [], onSiteMinutes: 60 });
  });

  it('keeps a move-out’s day after the visits are done, with the move-out alone', () => {
    const { crews } = layoutEveryDay(north, zoned(10), { anchors: [moveOut('move-out-1', '2026-10-08', 29.76)] });

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

/**
 * The office (2026-09-18): "if on q3 this property is scheduled ... the first
 * month on q3 then on q4 it should be scheduled on the first month also".
 */
describe('each visit in its month of the quarter', () => {
  /** Every weekday of Q4 2026, for one technician. */
  const quarter = Array.from({ length: 92 }, (_, index) => new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10))
    .filter((date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()))
    .map((date) => ({ date, technicianIds: ['t1'] }));
  const monthOf = (result: ReturnType<typeof layoutByMonth>, stopId: string) =>
    monthOfQuarter(result.placed.find((placed) => placed.stopId === stopId)!.date);

  it('knows the month of the quarter a day is in', () => {
    expect(['2026-07-31', '2026-08-01', '2026-09-30', '2026-10-01', '2026-12-31'].map(monthOfQuarter)).toEqual([1, 2, 3, 1, 3]);
  });

  it('puts each visit in the month of the quarter it had last quarter, from that month’s first day', () => {
    const stops = [
      ...cluster('july', 9, 1, { month: 1 }),
      ...cluster('august', 9, 10, { month: 2 }, 29.86),
      ...cluster('september', 9, 20, { month: 3 }, 29.96),
    ];

    const result = layoutByMonth(stops, quarter);

    expect(result.unplaced).toEqual([]);
    expect(result.crews.map((day) => `${day.date} ${day.stops.length}`)).toEqual(['2026-10-01 9', '2026-11-02 9', '2026-12-01 9']);
    expect(stops.every((stop) => monthOf(result, stop.stopId) === stop.month)).toBe(true);
  });

  it('puts a visit new this quarter in the month with fewest visits, so the months come out even', () => {
    const stops = [
      ...cluster('october', 18, 1, { month: 1 }),
      ...cluster('december', 9, 30, { month: 3 }, 29.96),
      ...cluster('new', 9, 60, {}, 29.86),
    ];

    const result = layoutByMonth(stops, quarter);

    // November had none, so the nine new ones go there.
    expect(new Set(stops.filter((stop) => stop.stopId.startsWith('new')).map((stop) => monthOf(result, stop.stopId)))).toEqual(new Set([2]));
  });

  it('builds a month’s days around the move-outs on them, and no other month’s', () => {
    const anchor = (id: string, date: string): DayAnchor => ({ id, date, technicianId: 't1', latitude: 29.76, longitude: -95.37, onSiteMinutes: 60 });

    const result = layoutByMonth(cluster('july', 9, 1, { month: 1 }), quarter, {
      anchors: [anchor('october-move-out', '2026-10-01'), anchor('november-move-out', '2026-11-03')],
    });

    expect(result.crews.map((day) => [day.date, day.anchors?.map((one) => one.id) ?? [], day.stops.length])).toEqual([
      ['2026-10-01', ['october-move-out'], 6],
      ['2026-10-02', [], 3],
      ['2026-11-03', ['november-move-out'], 0],
    ]);
    expect(result.skippedAnchors).toEqual([]);
  });

  /** The office (2026-09-19): "for the q4 we can start as early as september". */
  it('lays the first month’s visits out from a start before the quarter', () => {
    const q4 = { year: 2026, quarter: 4 as const };
    const planned = plannedVisitDaysOfQuarter(q4, [], '2026-09-21').map((date) => ({ date, technicianIds: ['t1'] }));
    const stops = [...cluster('july', 18, 1, { month: 1 }), ...cluster('august', 9, 20, { month: 2 }, 29.86)];

    const result = layoutByMonth(stops, planned, { quarter: q4 });

    // November's from its first planned day: Monday 2 November is kept for rescheduled visits.
    expect(result.crews.map((day) => `${day.date} ${day.stops.length}`)).toEqual(['2026-09-21 9', '2026-09-22 9', '2026-11-03 9']);
    expect(monthOfPlan('2026-09-21', q4)).toBe(1);
    // Without the quarter, a September day would be read as a third month.
    expect(monthOfPlan('2026-09-21')).toBe(3);
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
