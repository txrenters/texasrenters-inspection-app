import { NAV_MANEUVERS } from '@texasrenters/shared';

import { navigationLegSchema } from '../src/repositories/api/navigation-schema';
import { technicianRouteSchema } from '../src/repositories/api/technician-route-schema';
import { houstonNavigationLeg } from '../src/repositories/mock/nav-fixtures';

/**
 * What the phone is allowed to refuse, and what it must not.
 *
 * Two failures are guarded here, both of which end with a technician holding a
 * phone that will not tell them where to go.
 *
 * The first is the day route's schema quietly stripping fields the server has
 * been sending for months, and refusing the whole object when one it does want
 * is missing. That has happened in production once already -- `recordedAt` was
 * required, a route from home carries none, and the suggested order vanished
 * for exactly the part of the morning it exists for. `route()` has no cache to
 * fall back on, so a rejected parse is not a stale route, it is no route.
 *
 * The second is the maneuver enum. A router adding a maneuver name must not
 * strand a driver mid-leg, so an unrecognised one reads as CONTINUE and the
 * step's own instruction text carries the meaning.
 *
 * Every coordinate assertion here is about the **sign** of the number, not its
 * position. Houston is latitude +29.7 and longitude -95.4; an axis swap puts
 * the fixture in the Indian Ocean without throwing anything, and comparing
 * `[0]` against `[1]` is the only check that catches it.
 */

/**
 * Indexing, under `noUncheckedIndexedAccess`.
 *
 * A missing element is a failed test either way; this reports which index was
 * missing instead of a bare "cannot read property of undefined".
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Expected an element at index ${index}.`);
  return item;
}

/** Parses a leg that is supposed to exist, so the tests below need no `?.`. */
function parseLeg(input: unknown) {
  const parsed = navigationLegSchema.parse(input);
  if (!parsed) throw new Error('Expected the router to have drawn a leg.');
  return parsed;
}

/** A route from a server that predates every field added since. */
const olderServerRoute = () => ({
  technicianId: 'tech-1',
  origin: { latitude: 29.95, longitude: -95.55, recordedAt: '2026-09-22T14:56:00.000Z' },
  stops: [],
  legs: [],
  totalDistanceMeters: 0,
  totalDurationSeconds: 0,
  unroutable: [{ inspectionId: 'insp-1', propertyName: '12 Kirby' }],
});

const leg = (over: Record<string, unknown> = {}) => ({
  toStopId: 'insp-1',
  from: [29.745, -95.4102],
  to: [29.7205, -95.396],
  distanceMeters: 3_670,
  durationSeconds: 540,
  steps: [
    {
      maneuver: 'DEPART',
      instruction: 'Head south on Kirby Drive',
      roadName: 'Kirby Drive',
      distanceMeters: 660,
      durationSeconds: 55,
      polyline: [
        [29.745, -95.4102],
        [29.7391, -95.4105],
      ],
    },
  ],
  polyline: [
    [29.745, -95.4102],
    [29.7391, -95.4105],
  ],
  source: 'GOOGLE_TRAFFIC',
  drawnAt: '2026-09-22T14:05:00.000Z',
  ...over,
});

const stepWithManeuver = (maneuver: unknown) =>
  leg({
    steps: [
      {
        maneuver,
        instruction: 'Bear left at the fork and stay on the service road',
        roadName: null,
        distanceMeters: 120,
        durationSeconds: 18,
        polyline: [[29.74, -95.41]],
      },
    ],
  });

describe('reading a day route from an older server', () => {
  it('still parses when geometry, history and originKind are all absent', () => {
    expect(technicianRouteSchema.safeParse(olderServerRoute()).success).toBe(true);
  });

  it('reads an absent line as no line rather than refusing the stops', () => {
    const parsed = technicianRouteSchema.parse(olderServerRoute());

    expect(parsed.geometry).toEqual([]);
    expect(parsed.history).toEqual({ stops: [], geometry: [] });
    expect(parsed.originOutsideServiceArea).toBe(false);
  });

  it('does not lose an inspection for want of a reason it could not be routed', () => {
    const parsed = technicianRouteSchema.parse(olderServerRoute());

    expect(parsed.unroutable).toHaveLength(1);
    expect(at(parsed.unroutable, 0).reason).toBeUndefined();
  });
});

describe('reading a day route from the server as it is today', () => {
  const parsed = technicianRouteSchema.parse({
    ...olderServerRoute(),
    geometry: [
      [29.95, -95.55],
      [29.9, -95.5],
    ],
    history: {
      stops: [
        {
          inspectionId: 'insp-0',
          propertyId: 'prop-0',
          propertyName: '8 Westheimer',
          addressLine1: '8 Westheimer Rd',
          city: 'Houston',
          latitude: 29.7386,
          longitude: -95.4018,
        },
      ],
      geometry: [[29.7386, -95.4018]],
    },
    originKind: 'LIVE',
    originOutsideServiceArea: false,
    unroutable: [
      { inspectionId: 'insp-1', propertyName: '12 Kirby', reason: 'OUTSIDE_SERVICE_AREA' },
    ],
    airTravel: { inspectionId: 'insp-1', distanceMeters: 11_400_000 },
  });

  it('keeps the drawn line instead of dropping it on the floor', () => {
    expect(parsed.geometry).toHaveLength(2);
  });

  it('keeps latitude first, so the drive stays in Texas', () => {
    for (const [latitude, longitude] of [...parsed.geometry, ...parsed.history.geometry]) {
      expect(latitude).toBeGreaterThan(0);
      expect(longitude).toBeLessThan(0);
    }
  });

  it('says where the route started and why a stop was left out', () => {
    expect(parsed.originKind).toBe('LIVE');
    expect(at(parsed.unroutable, 0).reason).toBe('OUTSIDE_SERVICE_AREA');
    expect(parsed.history.stops).toHaveLength(1);
  });
});

describe('reading a navigation leg', () => {
  it('accepts a leg the router drew', () => {
    const parsed = parseLeg(leg());

    expect(parsed.toStopId).toBe('insp-1');
    expect(at(parsed.steps, 0).maneuver).toBe('DEPART');
  });

  it('reads a maneuver nobody has drawn an icon for as CONTINUE', () => {
    // The failure this prevents: a router starts sending a name this build has
    // never seen, an enum refuses the field, the refusal takes the whole leg
    // with it, and somebody loses their next turn on the Southwest Freeway.
    const step = at(parseLeg(stepWithManeuver('SPLIT_LEFT_ONTO_SERVICE_ROAD')).steps, 0);

    expect(step.maneuver).toBe('CONTINUE');
    // The router's own words are untouched, and they are the ones that are
    // always right when the enum is not.
    expect(step.instruction).toMatch(/Bear left at the fork/);
  });

  it('reads a missing maneuver as CONTINUE rather than refusing the leg', () => {
    const payload = stepWithManeuver(undefined);
    delete at(payload.steps as Record<string, unknown>[], 0).maneuver;

    expect(at(parseLeg(payload).steps, 0).maneuver).toBe('CONTINUE');
  });

  it('keeps every maneuver it does recognise', () => {
    for (const maneuver of NAV_MANEUVERS) {
      expect(at(parseLeg(stepWithManeuver(maneuver)).steps, 0).maneuver).toBe(maneuver);
    }
  });

  it('treats a drive the router would not draw as an answer, not an error', () => {
    expect(navigationLegSchema.parse(null)).toBeNull();
  });

  it('carries no field called id, which reconcileMobileState would resurrect', () => {
    const parsed = parseLeg(leg());

    expect(parsed).not.toHaveProperty('id');
    expect(at(parsed.steps, 0)).not.toHaveProperty('id');
  });
});

describe('the Houston demo leg', () => {
  it('parses as a real one would', () => {
    expect(navigationLegSchema.safeParse(houstonNavigationLeg).success).toBe(true);
  });

  it('is in Texas: latitude positive, longitude negative, on every point', () => {
    const points = [
      houstonNavigationLeg.from,
      houstonNavigationLeg.to,
      ...houstonNavigationLeg.polyline,
      ...houstonNavigationLeg.steps.flatMap((step) => [...step.polyline]),
    ];

    for (const [latitude, longitude] of points) {
      expect(latitude).toBeGreaterThan(29);
      expect(latitude).toBeLessThan(30);
      expect(longitude).toBeGreaterThan(-96);
      expect(longitude).toBeLessThan(-95);
    }
  });

  it('has enough shape to drive a countdown', () => {
    expect(houstonNavigationLeg.polyline.length).toBeGreaterThanOrEqual(30);
    expect(houstonNavigationLeg.steps.length).toBeGreaterThanOrEqual(5);
  });

  it('ends in an arrival, which Google never sends and the screen must handle', () => {
    const last = at(houstonNavigationLeg.steps, houstonNavigationLeg.steps.length - 1);

    expect(last.maneuver).toBe('ARRIVE');
  });

  it('lays its steps end to end to make the leg', () => {
    // The redundancy is on purpose in the real payload, so the fixture has to
    // have it too: each step begins where the last ended, and the joined path
    // is the leg's own line.
    for (let index = 1; index < houstonNavigationLeg.steps.length; index += 1) {
      const previous = at(houstonNavigationLeg.steps, index - 1).polyline;
      const current = at(houstonNavigationLeg.steps, index).polyline;

      expect(at(current, 0)).toEqual(at(previous, previous.length - 1));
    }
    expect(at(houstonNavigationLeg.polyline, 0)).toEqual(
      at(at(houstonNavigationLeg.steps, 0).polyline, 0),
    );
  });

  it('does not pass free-flow step seconds off as the traffic-aware total', () => {
    // They must not be shown as "time to the next turn" beside the HUD's ETA,
    // and the fixture keeps the gap rather than tidying it away.
    const stepSeconds = houstonNavigationLeg.steps.reduce(
      (total, step) => total + step.durationSeconds,
      0,
    );

    expect(stepSeconds).toBeLessThan(houstonNavigationLeg.durationSeconds);
  });
});
