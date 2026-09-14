import { describe, expect, it } from 'vitest';

import {
  estimateArrivals,
  MAX_LIVE_ROUTE_AGE_MS,
  needsReroute,
  OFF_ROUTE_M,
  projectOntoPath,
  type DrawnRoute,
} from '../src/contracts/live-route.js';

/**
 * A route that follows the technician, and what it costs.
 *
 * Drawing a route is a billed Google request; timing an already-drawn one from
 * where somebody now stands is arithmetic. The console previously re-asked
 * Google every two minutes for as long as a technician was selected, whether or
 * not anything had changed. These rules are what decide when it is worth it.
 */

/** A straight road running due north, about 1.1 km, in [lat, lng]. */
const ROAD: [number, number][] = [
  [29.9, -95.5],
  [29.905, -95.5],
  [29.91, -95.5],
];

describe('projecting a position onto the drawn line', () => {
  it('finds how far along the line a point on it is', () => {
    const halfway = projectOntoPath({ latitude: 29.905, longitude: -95.5 }, ROAD);
    expect(halfway?.offsetMeters).toBeLessThan(1);
    expect(halfway!.alongMeters / halfway!.totalMeters).toBeCloseTo(0.5, 2);
  });

  it('measures how far off the line a point beside it is', () => {
    // ~290 m east of the road at its midpoint.
    const beside = projectOntoPath({ latitude: 29.905, longitude: -95.497 }, ROAD);
    expect(beside!.offsetMeters).toBeGreaterThan(250);
    expect(beside!.offsetMeters).toBeLessThan(330);
  });

  it('clamps a point before the start to the start rather than negative', () => {
    const before = projectOntoPath({ latitude: 29.899, longitude: -95.5 }, ROAD);
    expect(before!.alongMeters).toBe(0);
  });

  it('has nothing to say about a path too short to have length', () => {
    expect(projectOntoPath({ latitude: 29.9, longitude: -95.5 }, [[29.9, -95.5]])).toBeNull();
    expect(projectOntoPath({ latitude: 29.9, longitude: -95.5 }, [])).toBeNull();
  });
});

describe('deciding whether to ask Google again', () => {
  const NOW = 1_000_000_000_000;
  const drawn = (over: Partial<DrawnRoute> = {}): DrawnRoute => ({
    originKind: 'LIVE',
    stopIds: ['a', 'b'],
    geometry: ROAD,
    computedAt: NOW - 60_000,
    ...over,
  });
  const onRoad = { latitude: 29.905, longitude: -95.5 };

  it('draws when there is nothing drawn yet', () => {
    expect(
      needsReroute(null, { originKind: 'HOME', stopIds: ['a'], position: null }, NOW),
    ).toEqual({ reroute: true, reason: 'NO_ROUTE' });
  });

  it('does not redraw a live route that is still being followed', () => {
    /**
     * The saving. On the line, same stops, drawn a minute ago: nothing about
     * the day changed, and asking Google would buy the same answer.
     */
    expect(
      needsReroute(drawn(), { originKind: 'LIVE', stopIds: ['a', 'b'], position: onRoad }, NOW),
    ).toEqual({ reroute: false, reason: null });
  });

  it('redraws the moment somebody comes online', () => {
    // The route was from home; now there is a live position to start from.
    expect(
      needsReroute(
        drawn({ originKind: 'HOME' }),
        { originKind: 'LIVE', stopIds: ['a', 'b'], position: onRoad },
        NOW,
      ).reason,
    ).toBe('ORIGIN_CHANGED');
  });

  it('keeps the live route when the handset goes quiet', () => {
    /**
     * Routes are recalculated while somebody is online and sending. A phone
     * that stops reporting has told us nothing new about where they are going,
     * so the line drawn from their last live position stays.
     */
    expect(
      needsReroute(
        drawn({ originKind: 'LIVE', computedAt: NOW - 3 * MAX_LIVE_ROUTE_AGE_MS }),
        { originKind: 'LAST_KNOWN', stopIds: ['a', 'b'], position: null },
        NOW,
      ),
    ).toEqual({ reroute: false, reason: null });
  });

  it('still redraws a quiet route when the office changes the day', () => {
    expect(
      needsReroute(
        drawn({ originKind: 'LIVE' }),
        { originKind: 'LAST_KNOWN', stopIds: ['a', 'b', 'c'], position: null },
        NOW,
      ).reason,
    ).toBe('STOPS_CHANGED');
  });

  it('redraws a route from home once they are known to have left it', () => {
    // A position from today, even an old one, says the house is no longer
    // where the day starts.
    expect(
      needsReroute(
        drawn({ originKind: 'HOME' }),
        { originKind: 'LAST_KNOWN', stopIds: ['a', 'b'], position: null },
        NOW,
      ).reason,
    ).toBe('ORIGIN_CHANGED');
  });

  it('redraws when a stop is finished or added', () => {
    expect(
      needsReroute(drawn(), { originKind: 'LIVE', stopIds: ['b'], position: onRoad }, NOW).reason,
    ).toBe('STOPS_CHANGED');
  });

  it('treats the same stops in a different order as unchanged', () => {
    // The order is what a redraw decides, so it cannot be a reason for one.
    expect(
      needsReroute(drawn(), { originKind: 'LIVE', stopIds: ['b', 'a'], position: onRoad }, NOW)
        .reroute,
    ).toBe(false);
  });

  it('redraws when they leave the line', () => {
    const offRoad = { latitude: 29.905, longitude: -95.497 }; // ~290 m east
    expect(
      needsReroute(drawn(), { originKind: 'LIVE', stopIds: ['a', 'b'], position: offRoad }, NOW)
        .reason,
    ).toBe('OFF_ROUTE');
  });

  it('does not redraw for ordinary GPS wander beside the road', () => {
    // ~30 m off: parking, a driveway, the usual scatter. Well inside the slack.
    const wander = { latitude: 29.905, longitude: -95.4997 };
    expect(
      needsReroute(drawn(), { originKind: 'LIVE', stopIds: ['a', 'b'], position: wander }, NOW)
        .reroute,
    ).toBe(false);
    expect(OFF_ROUTE_M).toBeGreaterThan(30);
  });

  it('redraws a live route once traffic has had time to change', () => {
    expect(
      needsReroute(
        drawn({ computedAt: NOW - MAX_LIVE_ROUTE_AGE_MS - 1 }),
        { originKind: 'LIVE', stopIds: ['a', 'b'], position: onRoad },
        NOW,
      ).reason,
    ).toBe('STALE');
  });

  it('never redraws a home route for age or position', () => {
    /**
     * "Only recalculate once they are online and sending." Before the handset
     * reports, there is no drive in progress to follow, so a home route stays
     * put however old it gets.
     */
    expect(
      needsReroute(
        drawn({ originKind: 'HOME', computedAt: NOW - 3 * 60 * 60_000 }),
        { originKind: 'HOME', stopIds: ['a', 'b'], position: null },
        NOW,
      ),
    ).toEqual({ reroute: false, reason: null });
  });
});

describe('estimating arrivals from the drawn legs', () => {
  const NOW = Date.parse('2026-09-14T15:00:00.000Z');
  const route = {
    stops: [{ inspectionId: 'first' }, { inspectionId: 'second' }],
    legs: [
      { durationSeconds: 600, distanceMeters: 5000 }, // 10 min to the first stop
      { durationSeconds: 1200, distanceMeters: 5000 }, // 20 min between them
    ],
  };
  const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

  it('times every stop from the start before anybody has moved', () => {
    const arrivals = estimateArrivals(route, 0, 3600, NOW);
    expect(arrivals.map((a) => a.arriveAt)).toEqual([
      at(600),
      // Ten minutes driving, an hour inside the first stop, twenty more.
      at(600 + 3600 + 1200),
    ]);
  });

  it('pro-rates the leg they are part-way down', () => {
    // A quarter of the way along the whole route is halfway down the first leg.
    const [first] = estimateArrivals(route, 0.25, 3600, NOW);
    expect(first.driveSeconds).toBe(300);
    expect(first.arriveAt).toBe(at(300));
  });

  it('leaves out a stop they have already passed rather than dating it in the past', () => {
    // Three quarters along: past the first stop, halfway through the second leg.
    const arrivals = estimateArrivals(route, 0.75, 3600, NOW);
    expect(arrivals.map((a) => a.inspectionId)).toEqual(['second']);
    expect(arrivals[0].driveSeconds).toBe(600);
  });

  it('adds nothing for a stop already reached when timing the next', () => {
    // Once the first stop is behind them its visit is not waiting ahead any more.
    const [second] = estimateArrivals(route, 0.75, 3600, NOW);
    expect(second.arriveAt).toBe(at(600));
  });

  it('does not divide by zero for two stops at one address', () => {
    const sameAddress = {
      stops: [{ inspectionId: 'a' }, { inspectionId: 'b' }],
      legs: [
        { durationSeconds: 600, distanceMeters: 5000 },
        { durationSeconds: 0, distanceMeters: 0 },
      ],
    };
    const arrivals = estimateArrivals(sameAddress, 0.1, 1800, NOW);
    expect(arrivals.every((a) => Number.isFinite(Date.parse(a.arriveAt)))).toBe(true);
  });

  it('has nothing to estimate without legs', () => {
    expect(estimateArrivals({ stops: [{ inspectionId: 'a' }], legs: [] }, 0, 1800, NOW)).toEqual([]);
  });

  it('treats an unknown position as not yet started', () => {
    expect(estimateArrivals(route, null, 3600, NOW)[0].arriveAt).toBe(at(600));
  });
});
