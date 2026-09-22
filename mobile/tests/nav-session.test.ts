import {
  NAV_OFF_ROUTE_FIXES,
  normaliseNavFix,
  type NavFix,
  type NavigationLeg,
  type NavigationStep,
} from '@texasrenters/shared';

import {
  NAV_ADVANCE_COUNTDOWN_MS,
  advanceNavSession,
  chainFromLegs,
  startNavSession,
  type NavDayRoute,
  type NavEffect,
  type NavSessionStep,
} from '../src/navigation/engine/nav-session';

/**
 * A whole drive across Houston, simulated: depart, take three turns, wander off
 * onto the wrong street, come back, park at the property, and move on to the
 * next job -- with no device, no network and no map.
 *
 * **Every assertion about a coordinate checks its sign.** Texas is latitude
 * ~29.7 (positive) and longitude ~-95.4 (negative). An axis swap does not throw
 * and does not look wrong in a debugger: it draws a plausible route in the
 * Indian Ocean, where latitude -95 does not even exist. Asserting the sign
 * catches it; asserting `snapped[0]` against a number does not.
 */

/** Tanglewood, near Westheimer. Real ground, so the arithmetic is realistic. */
const ORIGIN: readonly [number, number] = [29.75, -95.4];
const METERS_PER_DEGREE_LATITUDE = 110_540;
const METERS_PER_DEGREE_LONGITUDE = 111_320 * Math.cos((29.75 * Math.PI) / 180);

const east = (from: readonly [number, number], meters: number): [number, number] => [
  from[0],
  from[1] + meters / METERS_PER_DEGREE_LONGITUDE,
];
const north = (from: readonly [number, number], meters: number): [number, number] => [
  from[0] + meters / METERS_PER_DEGREE_LATITUDE,
  from[1],
];

// Westheimer east, left onto Kirby, right onto Alabama, then the property.
const P0 = ORIGIN;
const P1 = east(P0, 1_000);
const P2 = north(P1, 800);
const P3 = east(P2, 600);
const P4 = east(P3, 100);

const WESTHEIMER_M = 1_000;
const KIRBY_M = 800;
const ALABAMA_M = 600;

/** A point this far along the drive, in `[latitude, longitude]`. */
function alongRoute(meters: number): [number, number] {
  if (meters <= WESTHEIMER_M) return east(P0, meters);
  if (meters <= WESTHEIMER_M + KIRBY_M) return north(P1, meters - WESTHEIMER_M);
  return east(P2, meters - WESTHEIMER_M - KIRBY_M);
}

const midpoint = (a: readonly [number, number], b: readonly [number, number]): [number, number] => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
];

const step = (
  over: Partial<NavigationStep> & Pick<NavigationStep, 'maneuver' | 'instruction'>,
  from: readonly [number, number],
  to: readonly [number, number],
  distanceMeters: number,
): NavigationStep => ({
  roadName: null,
  distanceMeters,
  durationSeconds: Math.round(distanceMeters / 12),
  polyline: [from, midpoint(from, to), to],
  ...over,
});

/**
 * A step's `maneuver` is what happens at its **end**.
 *
 * That is what the rest of the system assumes: `metersToManeuver` counts to the
 * end of the current step, the banner shows `steps[stepIndex]`, and
 * `maneuverFromGoogle` synthesises `ARRIVE` for the last step of a leg. Google's
 * own steps name the maneuver at their *start*, so whatever builds these from
 * the Routes API has to shift by one.
 */
const STEPS: NavigationStep[] = [
  step(
    {
      maneuver: 'TURN_LEFT',
      instruction: 'Turn left onto Kirby Drive',
      roadName: 'Kirby Drive',
    },
    P0,
    P1,
    WESTHEIMER_M,
  ),
  step(
    {
      maneuver: 'TURN_RIGHT',
      instruction: 'Turn right onto Alabama Street',
      roadName: 'Alabama Street',
    },
    P1,
    P2,
    KIRBY_M,
  ),
  step(
    {
      maneuver: 'CONTINUE',
      instruction: 'Continue on Alabama Street',
      roadName: 'Alabama Street',
    },
    P2,
    P3,
    ALABAMA_M,
  ),
  step({ maneuver: 'ARRIVE', instruction: 'Your destination is on the right' }, P3, P4, 100),
];

const TANGLEWOOD = {
  inspectionId: 'insp-tanglewood',
  propertyName: 'Tanglewood Court',
  latitude: P4[0],
  longitude: P4[1],
};
const BRIAR = {
  inspectionId: 'insp-briar',
  propertyName: 'Briar Hollow',
  latitude: 29.76,
  longitude: -95.37,
};
/** In `stops` and not in `legs` -- the planner could not route to it. */
const STRANDED = {
  inspectionId: 'insp-stranded',
  propertyName: 'Stranded House',
  latitude: 29.8,
  longitude: -95.5,
};

const DAY: NavDayRoute = {
  stops: [TANGLEWOOD, BRIAR, STRANDED],
  legs: [
    { fromStopId: null, toStopId: TANGLEWOOD.inspectionId },
    { fromStopId: TANGLEWOOD.inspectionId, toStopId: BRIAR.inspectionId },
  ],
  originOutsideServiceArea: false,
  unroutable: [{ inspectionId: STRANDED.inspectionId }],
};

const T0 = Date.parse('2026-09-22T14:00:00.000Z');

const LEG: NavigationLeg = {
  toStopId: TANGLEWOOD.inspectionId,
  from: P0,
  to: P4,
  distanceMeters: 2_500,
  durationSeconds: 300,
  steps: STEPS,
  polyline: [P0, P1, P2, P3, P4],
  source: 'GOOGLE_TRAFFIC',
  drawnAt: new Date(T0).toISOString(),
};

/** A platform fix, through the same normalisation the handset applies. */
function fixAt(
  point: readonly [number, number],
  at: number,
  over: { speed?: number; accuracy?: number } = {},
): NavFix {
  return normaliseNavFix(
    {
      latitude: point[0],
      longitude: point[1],
      speed: over.speed ?? 12,
      accuracy: over.accuracy ?? 8,
      heading: 90,
      timestamp: at,
    },
    at,
  );
}

/** Drives a session, keeping every effect it ever asked for. */
function journey(route: NavDayRoute = DAY, startFrom?: string) {
  let current: NavSessionStep = startNavSession(route, { now: T0, toStopId: startFrom ?? null });
  let leg: NavigationLeg | null = null;
  let clock = T0;
  const all: NavEffect[] = [...current.effects];

  const run = (fix: NavFix | null, now: number) => {
    current = advanceNavSession(current.state, { dayRoute: route, leg, fix, now });
    all.push(...current.effects);
    return current;
  };

  return {
    get phase() {
      return current.state.phase;
    },
    get view() {
      return current.view;
    },
    get last() {
      return current;
    },
    get effects() {
      return all;
    },
    deliver(next: NavigationLeg = LEG) {
      leg = next;
      return this;
    },
    /** A fix this far along the drive, three seconds after the last. */
    at(meters: number, over: { speed?: number; accuracy?: number; offsetMeters?: number } = {}) {
      clock += 3_000;
      const on = alongRoute(meters);
      const point: [number, number] = over.offsetMeters
        ? north(on, over.offsetMeters)
        : [on[0], on[1]];
      return run(fixAt(point, clock, over), clock);
    },
    /** A fix at a fixed point, for parking and for driving past. */
    park(point: readonly [number, number], over: { speed?: number } = {}) {
      clock += 3_000;
      return run(fixAt(point, clock, { speed: over.speed ?? 0 }), clock);
    },
    /** The clock alone, for a parked phone that earns no new fixes. */
    tick(afterMs: number) {
      clock += afterMs;
      return run(null, clock);
    },
  };
}

const sentences = (effects: readonly NavEffect[]) =>
  effects.flatMap((effect) => (effect.kind === 'ANNOUNCE' ? [effect.announcement.sentence] : []));
const fetches = (effects: readonly NavEffect[]) =>
  effects.flatMap((effect) => (effect.kind === 'FETCH_LEG' ? [effect] : []));

describe('which stops the day is made of', () => {
  it('takes the chain from the legs and never from the stops', () => {
    // The planner returns a stop it could not route to -- it is in `stops` and
    // in `unroutable` at once. A chain built from `stops` would give it an
    // ordinal and then ask for a drive that cannot be drawn.
    expect(chainFromLegs(DAY)).toEqual([TANGLEWOOD.inspectionId, BRIAR.inspectionId]);
    expect(chainFromLegs(DAY)).not.toContain(STRANDED.inspectionId);
  });

  it('refuses the whole day when the origin is outside the service area', () => {
    // OSRM does not refuse a coordinate it cannot place: a position in the
    // Philippines was snapped onto a road in east Texas and answered as a
    // plausible four-hour drive. Navigating that is worse than not navigating.
    const drive = journey({ ...DAY, originOutsideServiceArea: true });
    expect(drive.phase).toBe('NO_ROUTE');
    expect(drive.view.blocked).toBe('ORIGIN_OUTSIDE_SERVICE_AREA');
    expect(fetches(drive.effects)).toHaveLength(0);
  });

  it('refuses a day whose stops were never routed', () => {
    const drive = journey({ ...DAY, legs: [] });
    expect(drive.phase).toBe('NO_ROUTE');
    expect(drive.view.blocked).toBe('NO_ROUTED_STOPS');
  });
});

describe('setting off', () => {
  it('asks for the drive to the first stop', () => {
    const drive = journey();
    const asked = fetches(drive.effects);

    expect(drive.phase).toBe('DRIVING');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.toStopId).toBe(TANGLEWOOD.inspectionId);
    expect(asked[0]?.reason).toBe('START');
  });

  it('holds the technician on the line once the drive arrives', () => {
    const drive = journey();
    drive.deliver().at(200);

    expect(drive.phase).toBe('DRIVING');
    expect(drive.view.stepIndex).toBe(0);
    expect(drive.view.offsetMeters ?? 999).toBeLessThan(5);

    const snapped = drive.view.snapped;
    expect(snapped).not.toBeNull();
    // Houston: latitude positive, longitude negative. An axis swap passes every
    // other assertion in this file and fails this one.
    expect(snapped?.[0]).toBeGreaterThan(0);
    expect(snapped?.[1]).toBeLessThan(0);
  });
});

describe('what the driver is told, and how often', () => {
  it('announces each threshold once, and never one longer than the step', () => {
    const drive = journey().deliver();

    // A thousand metres of Westheimer: no "In one mile", because the whole step
    // is shorter than a mile and the announcement would be true from the start.
    drive.at(50);
    drive.at(400);
    expect(sentences(drive.effects)).toEqual([]);

    drive.at(700);
    drive.at(750);
    drive.at(800);
    expect(sentences(drive.effects)).toEqual([
      'In a quarter of a mile, turn left onto Kirby Drive',
    ]);

    drive.at(960);
    drive.at(980);
    expect(sentences(drive.effects)).toEqual([
      'In a quarter of a mile, turn left onto Kirby Drive',
      'Turn left onto Kirby Drive',
    ]);
  });

  it('starts the next step fresh, and names the property on arrival', () => {
    const drive = journey().deliver();
    for (const meters of [400, 700, 960, 1_040, 1_300, 1_500, 1_760, 1_840, 2_100, 2_360, 2_460]) {
      drive.at(meters);
    }

    expect(sentences(drive.effects)).toEqual([
      'In a quarter of a mile, turn left onto Kirby Drive',
      'Turn left onto Kirby Drive',
      'In a quarter of a mile, turn right onto Alabama Street',
      'Turn right onto Alabama Street',
      'In a quarter of a mile, continue on Alabama Street',
      'Continue on Alabama Street',
      'You arrive at Tanglewood Court',
    ]);
  });
});

describe('following the steps', () => {
  it('holds the instruction until the driver is properly past the turn', () => {
    // A phone at a red light on a step boundary lands either side of it on
    // consecutive fixes. Without the margin the banner would flip several times
    // a second, and re-announce on every flip.
    const drive = journey().deliver();
    drive.at(990);
    expect(drive.view.stepIndex).toBe(0);

    drive.at(1_010);
    expect(drive.view.stepIndex).toBe(0);

    drive.at(1_040);
    expect(drive.view.stepIndex).toBe(1);
    expect(drive.view.step?.instruction).toBe('Turn right onto Alabama Street');
  });
});

describe('leaving the route', () => {
  it('does not call one fix off the line a wrong turn', () => {
    // An overpass, a tunnel, or a signal bounced off a tower block.
    const drive = journey().deliver();
    drive.at(300);
    drive.at(400, { offsetMeters: 120 });

    expect(drive.phase).toBe('DRIVING');
    expect(fetches(drive.effects)).toHaveLength(1);
  });

  it('asks for a new route after three fixes off the line, and only once', () => {
    const drive = journey().deliver();
    drive.at(300);
    for (let index = 0; index < NAV_OFF_ROUTE_FIXES; index += 1) {
      drive.at(400 + index * 20, { offsetMeters: 120 });
    }

    expect(drive.phase).toBe('OFF_ROUTE');
    const asked = fetches(drive.effects);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.reason).toBe('REROUTE');
    // Drawn from where the driver actually is, in [latitude, longitude].
    expect(asked[1]?.from?.[0]).toBeGreaterThan(29);
    expect(asked[1]?.from?.[0]).toBeLessThan(30);
    expect(asked[1]?.from?.[1]).toBeLessThan(-95);
    expect(asked[1]?.from?.[1]).toBeGreaterThan(-96);

    // Still off the line, and still inside the throttle: the phone must not ask
    // again on every fix. The backend has no throttle of its own.
    drive.at(460, { offsetMeters: 120 });
    drive.at(480, { offsetMeters: 120 });
    expect(fetches(drive.effects)).toHaveLength(2);
    expect(drive.phase).toBe('REROUTING');
  });

  it('goes back to driving when the technician rejoins the line', () => {
    const drive = journey().deliver();
    drive.at(300);
    for (let index = 0; index < NAV_OFF_ROUTE_FIXES; index += 1) {
      drive.at(400 + index * 20, { offsetMeters: 120 });
    }
    expect(drive.phase).toBe('OFF_ROUTE');

    drive.at(500);
    expect(drive.phase).toBe('DRIVING');
    expect(drive.view.snapped).not.toBeNull();
  });
});

describe('arriving', () => {
  it('does not arrive by driving past the property at speed', () => {
    // Houston residential stops sit forty metres apart. On radius alone, a van
    // doing forty past the next house would arrive at it, reroute, and start
    // speaking the wrong instructions.
    const drive = journey().deliver();
    drive.at(2_400);
    drive.park(P4, { speed: 15 });
    drive.park(P4, { speed: 15 });
    drive.park(P4, { speed: 15 });

    expect(drive.phase).toBe('DRIVING');
    expect(drive.effects.some((effect) => effect.kind === 'ARRIVED')).toBe(false);
  });

  it('arrives once the van has stopped at the property for long enough', () => {
    const drive = journey().deliver();
    drive.at(2_400);
    drive.park(P4);
    drive.park(P4);
    expect(drive.phase).toBe('DRIVING');

    drive.park(P4);
    expect(drive.phase).toBe('ARRIVED');
    expect(
      drive.effects.flatMap((effect) => (effect.kind === 'ARRIVED' ? [effect.toStopId] : [])),
    ).toEqual([TANGLEWOOD.inspectionId]);
  });

  it('reports arriving somewhere that is not the target rather than advancing to it', () => {
    // A technician who stops at the wrong house, or takes a job out of order,
    // has done something the office may want to know. Rewriting the day from
    // the passenger seat is not this code's decision to make.
    const drive = journey().deliver();
    drive.park([BRIAR.latitude, BRIAR.longitude]);
    drive.park([BRIAR.latitude, BRIAR.longitude]);
    drive.park([BRIAR.latitude, BRIAR.longitude]);

    expect(drive.view.unplannedArrivalStopId).toBe(BRIAR.inspectionId);
    expect(drive.view.targetStopId).toBe(TANGLEWOOD.inspectionId);
    expect(drive.phase).not.toBe('ARRIVED');
    expect(
      drive.effects.some(
        (effect) =>
          effect.kind === 'ARRIVED_OFF_PLAN' && effect.toStopId === BRIAR.inspectionId,
      ),
    ).toBe(true);
  });
});

describe('moving on', () => {
  const arrive = () => {
    const drive = journey().deliver();
    drive.at(2_400);
    drive.park(P4);
    drive.park(P4);
    drive.park(P4);
    return drive;
  };

  it('counts down from the arrival timestamp, not from a timer', () => {
    // A parked phone earns no new fixes at all -- the recorder asks for one
    // every three seconds *or* every ten metres, and a stationary handset
    // satisfies neither. The clock alone has to be enough.
    const drive = arrive();
    expect(drive.view.advanceAtEpochMs).not.toBeNull();

    drive.tick(NAV_ADVANCE_COUNTDOWN_MS - 1_000);
    expect(drive.phase).toBe('ARRIVED');

    drive.tick(2_000);
    expect(drive.phase).toBe('ADVANCING');
  });

  it('asks for the drive to the next stop when it advances', () => {
    const drive = arrive();
    drive.tick(NAV_ADVANCE_COUNTDOWN_MS + 1_000);

    const asked = fetches(drive.effects);
    const last = asked[asked.length - 1];
    expect(last?.toStopId).toBe(BRIAR.inspectionId);
    expect(last?.reason).toBe('NEXT_STOP');
    expect(drive.view.targetStopId).toBe(BRIAR.inspectionId);
    expect(drive.view.stopsRemaining).toBe(1);
  });

  it('finishes the day after the last stop rather than looping', () => {
    const oneStop: NavDayRoute = {
      ...DAY,
      stops: [TANGLEWOOD],
      legs: [{ fromStopId: null, toStopId: TANGLEWOOD.inspectionId }],
      unroutable: [],
    };
    const drive = journey(oneStop).deliver();
    drive.at(2_400);
    drive.park(P4);
    drive.park(P4);
    drive.park(P4);
    drive.tick(NAV_ADVANCE_COUNTDOWN_MS + 1_000);

    expect(drive.phase).toBe('IDLE');
    expect(drive.view.dayComplete).toBe(true);
    expect(drive.effects.some((effect) => effect.kind === 'DAY_COMPLETE')).toBe(true);
  });
});

describe('a poor signal', () => {
  it('holds its position rather than steering by a fix that says it is lost', () => {
    // A 200-metre fix is worse than nothing: it snaps the marker to the wrong
    // street, advances the step, and speaks a turn that is not there.
    const drive = journey().deliver();
    drive.at(500);
    const before = drive.view.stepIndex;

    drive.at(1_400, { accuracy: 200 });
    expect(drive.view.signalPoor).toBe(true);
    expect(drive.view.stepIndex).toBe(before);
  });
});
