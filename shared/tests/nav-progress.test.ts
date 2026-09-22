import { describe, expect, it } from 'vitest';

import {
  advanceNavProgress,
  announcementFor,
  buildLegPath,
  checkArrival,
  decimatePath,
  INITIAL_ARRIVAL,
  INITIAL_NAV_PROGRESS,
  isUsableNavFix,
  measurePath,
  normaliseNavFix,
  projectOntoMeasuredPath,
  type NavFix,
  type NavProgressState,
} from '../src/contracts/nav-progress.js';
import {
  NAV_ARRIVAL_RADIUS_M,
  NAV_OFF_ROUTE_FIXES,
  NAV_STEP_ADVANCE_M,
  type NavManeuver,
  type NavigationStep,
} from '../src/contracts/navigation.js';
import { haversineMeters } from '../src/contracts/route-plan.js';

/**
 * Everything navigation decides, decided without a device.
 *
 * All of these coordinates are real north-west Houston, and every one of them
 * is `[latitude, longitude]`: latitude around 29.70 and **positive**, longitude
 * around -95.40 and **negative**. That is asserted rather than assumed wherever
 * a coordinate comes back out of a function, because an axis swap does not
 * fail -- it produces a route of exactly the right shape and length a thousand
 * miles off the Somali coast, and every component involved looks correct on its
 * own. Asserting the sign catches it; asserting a position does not.
 *
 * Distances below were measured against `haversineMeters`, which is what the
 * code under test uses. At this latitude 0.001 deg of longitude is about 96.6 m
 * and 0.0001 deg of latitude about 11.1 m.
 */

/** A straight run due east along one road, about 966 m, in [lat, lng]. */
const EAST_ROAD: readonly (readonly [number, number])[] = [
  [29.7, -95.4],
  [29.7, -95.395],
  [29.7, -95.39],
];

/** Where each point of EAST_ROAD falls, in metres from its start. */
const EAST_ROAD_CUMULATIVE = [0, 482.9, 965.9];

const step = (
  polyline: readonly (readonly [number, number])[],
  over: Partial<NavigationStep> = {},
): NavigationStep => ({
  maneuver: 'CONTINUE' as NavManeuver,
  instruction: 'Continue on Clay Rd',
  roadName: 'Clay Rd',
  // Deliberately disagreeing with the polyline. The router's own distance is a
  // road-network figure and the polyline is a simplification of it; buildLegPath
  // must measure the geometry rather than believe this number.
  distanceMeters: 1,
  durationSeconds: 1,
  polyline,
  ...over,
});

/** A two-step leg along EAST_ROAD, with the maneuver at the halfway point. */
const twoStepLeg = () =>
  buildLegPath([
    step([EAST_ROAD[0], EAST_ROAD[1]], { maneuver: 'DEPART', instruction: 'Head east on Clay Rd' }),
    step([EAST_ROAD[1], EAST_ROAD[2]], { maneuver: 'TURN_RIGHT', instruction: 'Turn right' }),
  ]);

const fixAt = (
  latitude: number,
  longitude: number,
  over: Partial<NavFix> = {},
): NavFix => ({
  latitude,
  longitude,
  accuracyMeters: 8,
  speedMetersPerSecond: 12,
  headingDegrees: 90,
  at: 1_700_000_000_000,
  ...over,
});

describe('cleaning a platform fix', () => {
  const NOW = 1_700_000_000_000;

  it('drops the -1 both platforms use for "no speed" and "no course"', () => {
    // Stored literally, -1 is a heading of one degree west of north: every
    // parked technician would point the same wrong way, and a -1 speed reads as
    // stationary while the vehicle is doing seventy.
    const fix = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, speed: -1, heading: -1 },
      NOW,
    );
    expect(fix.speedMetersPerSecond).toBeNull();
    expect(fix.headingDegrees).toBeNull();
  });

  it('drops a course of exactly zero when nothing is moving', () => {
    // Android reports heading 0 rather than -1 when it has none. It is
    // indistinguishable from due north except by the speed beside it, so a
    // course-up map would snap north every time the vehicle stopped.
    const noSpeed = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, heading: 0 },
      NOW,
    );
    expect(noSpeed.headingDegrees).toBeNull();

    const crawling = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, heading: 0, speed: 0.2 },
      NOW,
    );
    expect(crawling.headingDegrees).toBeNull();
  });

  it('drops a course at any value while stationary, not only zero', () => {
    // Jitter alone gives a parked phone a low speed in a random direction.
    const jitter = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, heading: 217, speed: 0.1 },
      NOW,
    );
    expect(jitter.headingDegrees).toBeNull();
  });

  it('keeps the course once the vehicle is actually moving', () => {
    const driving = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, heading: 271.5, speed: 20 },
      NOW,
    );
    expect(driving.headingDegrees).toBe(271.5);
    expect(driving.speedMetersPerSecond).toBe(20);

    // Due north from a moving vehicle is a real course and must survive.
    const north = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, heading: 0, speed: 20 },
      NOW,
    );
    expect(north.headingDegrees).toBe(0);
  });

  it('wraps a course of 360 onto 0 rather than leaving two names for north', () => {
    const wrapped = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, heading: 360, speed: 20 },
      NOW,
    );
    expect(wrapped.headingDegrees).toBe(0);
  });

  it('drops a course outside the compass entirely', () => {
    const overRun = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, heading: 450, speed: 20 },
      NOW,
    );
    expect(overRun.headingDegrees).toBeNull();
  });

  it('drops a negative accuracy, which some Android devices use for "unknown"', () => {
    const fix = normaliseNavFix(
      { latitude: 29.7604, longitude: -95.3698, accuracy: -1 },
      NOW,
    );
    expect(fix.accuracyMeters).toBeNull();
  });

  it('keeps a real accuracy, and refuses a non-finite one', () => {
    expect(
      normaliseNavFix({ latitude: 29.7604, longitude: -95.3698, accuracy: 8 }, NOW)
        .accuracyMeters,
    ).toBe(8);
    expect(
      normaliseNavFix(
        { latitude: 29.7604, longitude: -95.3698, accuracy: Number.NaN, speed: Number.NaN },
        NOW,
      ),
    ).toMatchObject({ accuracyMeters: null, speedMetersPerSecond: null });
  });

  it('falls back to now when the platform gave no usable timestamp', () => {
    expect(normaliseNavFix({ latitude: 29.7604, longitude: -95.3698 }, NOW).at).toBe(NOW);
    expect(
      normaliseNavFix({ latitude: 29.7604, longitude: -95.3698, timestamp: 0 }, NOW).at,
    ).toBe(NOW);
    expect(
      normaliseNavFix({ latitude: 29.7604, longitude: -95.3698, timestamp: NOW - 5_000 }, NOW).at,
    ).toBe(NOW - 5_000);
  });

  it('carries the position through untouched, on the axes it was given', () => {
    // Downtown Houston: latitude positive, longitude negative. If either sign
    // flips here the whole drive happens in the Indian Ocean.
    const fix = normaliseNavFix({ latitude: 29.7604, longitude: -95.3698 }, NOW);
    expect(fix.latitude).toBeGreaterThan(0);
    expect(fix.longitude).toBeLessThan(0);
    expect(fix.latitude).toBeCloseTo(29.7604, 6);
    expect(fix.longitude).toBeCloseTo(-95.3698, 6);
  });
});

describe('deciding whether a fix is precise enough to steer by', () => {
  it('trusts a fix that reported no accuracy at all', () => {
    // Some Android handsets simply omit it. Refusing those would leave them
    // unable to navigate rather than merely unable to navigate well.
    expect(isUsableNavFix(fixAt(29.7, -95.4, { accuracyMeters: null }))).toBe(true);
  });

  it('refuses a fix that has told us it does not know where it is', () => {
    expect(isUsableNavFix(fixAt(29.7, -95.4, { accuracyMeters: 50 }))).toBe(true);
    expect(isUsableNavFix(fixAt(29.7, -95.4, { accuracyMeters: 51 }))).toBe(false);
    expect(isUsableNavFix(fixAt(29.7, -95.4, { accuracyMeters: 200 }))).toBe(false);
  });
});

describe('measuring a path', () => {
  it('accumulates metres to each point and reports the total', () => {
    const measured = measurePath(EAST_ROAD);
    expect(measured.cumulative[0]).toBe(0);
    expect(measured.cumulative[1]).toBeCloseTo(EAST_ROAD_CUMULATIVE[1], 0);
    expect(measured.cumulative[2]).toBeCloseTo(EAST_ROAD_CUMULATIVE[2], 0);
    expect(measured.totalMeters).toBeCloseTo(EAST_ROAD_CUMULATIVE[2], 0);
  });

  it('has a total of zero for a path too short to have length', () => {
    expect(measurePath([[29.7, -95.4]]).totalMeters).toBe(0);
    expect(measurePath([]).totalMeters).toBe(0);
  });
});

describe('projecting forward along a leg that doubles back on itself', () => {
  /**
   * Out east along a street and back 30 m to the north of it -- a frontage road
   * beside the motorway it feeds, a cul-de-sac driven in and out, a cloverleaf.
   * The two passes are within 30 m of each other for nearly a kilometre.
   *
   * Points 0-4 are the outbound pass (segments 1-4), point 5 is the 30 m hop
   * across, points 5-7 are the return (segments 6-7).
   */
  const DOUBLE_BACK: readonly (readonly [number, number])[] = [
    [29.7, -95.4],
    [29.7, -95.3975],
    [29.7, -95.395],
    [29.7, -95.3925],
    [29.7, -95.39],
    [29.70027, -95.39],
    [29.70027, -95.395],
    [29.70027, -95.4],
  ];

  /**
   * Between the two passes, and nearer the outbound one: 11 m north of the way
   * out, 19 m south of the way back. The globally nearest segment is the
   * outbound pass, which is exactly the trap.
   */
  const BETWEEN_THE_PASSES = { latitude: 29.7001, longitude: -95.397 };

  const measured = measurePath(DOUBLE_BACK);

  it('measures the doubling-back path as nearly two kilometres', () => {
    expect(measured.totalMeters).toBeCloseTo(1_961.8, 0);
  });

  it('takes the nearest pass when the driver has not got anywhere yet', () => {
    const early = projectOntoMeasuredPath(BETWEEN_THE_PASSES, measured);
    expect(early!.segment).toBe(2);
    expect(early!.offsetMeters).toBeCloseTo(11.1, 0);
    // Still on the way out: under 400 m into a 1,960 m leg.
    expect(early!.alongMeters).toBeGreaterThan(200);
    expect(early!.alongMeters).toBeLessThan(400);
  });

  it('refuses to snap back to the early pass once the driver is on the late one', () => {
    // This is the entire reason projectOntoMeasuredPath exists rather than
    // live-route's projectOntoPath. Globally, the nearest point on this leg is
    // 11 m away on the outbound pass; searching forward from the return pass
    // deliberately accepts the *worse* 19 m match, because the driver has
    // already driven the first one.
    //
    // Take the global answer instead and the step index jumps back four steps,
    // the countdown resets to a turn two kilometres behind, and the voice reads
    // out an instruction the technician followed a minute ago.
    const late = projectOntoMeasuredPath(BETWEEN_THE_PASSES, measured, 6);
    expect(late!.segment).toBe(7);
    expect(late!.offsetMeters).toBeCloseTo(18.8, 0);
    expect(late!.offsetMeters).toBeGreaterThan(
      projectOntoMeasuredPath(BETWEEN_THE_PASSES, measured)!.offsetMeters,
    );
    // Past the whole outbound pass and the crossing: over 1,400 m in.
    expect(late!.alongMeters).toBeGreaterThan(1_400);
    expect(late!.alongMeters).toBeLessThan(measured.totalMeters);
  });

  it('snaps onto the line, on the axes it was given', () => {
    const late = projectOntoMeasuredPath(BETWEEN_THE_PASSES, measured, 6);
    const [latitude, longitude] = late!.snapped;
    // North-west Houston: positive latitude, negative longitude.
    expect(latitude).toBeGreaterThan(0);
    expect(longitude).toBeLessThan(0);
    expect(latitude).toBeCloseTo(29.70027, 5);
    expect(longitude).toBeCloseTo(-95.397, 4);
  });

  it('still finds a fix that has wandered slightly behind the current segment', () => {
    // Ordinary GPS wander puts a fix a few metres back on every other reading.
    // Without the look-back the projection would fall off the start of the
    // search window and the driver would appear to stop dead.
    const justBehind = { latitude: 29.7, longitude: -95.3955 };
    const found = projectOntoMeasuredPath(justBehind, measured, 3);
    expect(found!.offsetMeters).toBeLessThan(5);
    expect(found!.segment).toBe(2);
  });

  it('has nothing to say about a path too short to have a segment', () => {
    expect(projectOntoMeasuredPath(BETWEEN_THE_PASSES, measurePath([[29.7, -95.4]]))).toBeNull();
    expect(projectOntoMeasuredPath(BETWEEN_THE_PASSES, measurePath([]))).toBeNull();
  });
});

describe('laying a leg out of its steps', () => {
  it('drops the endpoint each step shares with the last', () => {
    // Steps overlap by one point by definition. Kept, every boundary would sit
    // on a zero-length segment and the step-advance margin would be measured
    // from the wrong place.
    const leg = buildLegPath([
      step([EAST_ROAD[0], EAST_ROAD[1]]),
      step([EAST_ROAD[1], EAST_ROAD[2]]),
    ]);
    expect(leg.measured.path).toHaveLength(3);
    expect(leg.measured.totalMeters).toBeCloseTo(EAST_ROAD_CUMULATIVE[2], 0);
  });

  it('measures the boundaries off the geometry, not off the reported distances', () => {
    // Both steps above claim distanceMeters: 1. If those were believed the leg
    // would be 2 m long and every boundary would be metres from the start.
    const leg = buildLegPath([
      step([EAST_ROAD[0], EAST_ROAD[1]]),
      step([EAST_ROAD[1], EAST_ROAD[2]]),
    ]);
    expect(leg.bounds[0].startMeters).toBe(0);
    expect(leg.bounds[0].endMeters).toBeCloseTo(EAST_ROAD_CUMULATIVE[1], 0);
    expect(leg.bounds[1].endMeters).toBeCloseTo(EAST_ROAD_CUMULATIVE[2], 0);
  });

  it('leaves no gap between one step and the next', () => {
    const leg = buildLegPath([
      step([
        [29.7, -95.4],
        [29.7, -95.395],
      ]),
      step([
        [29.7, -95.395],
        [29.7028, -95.395],
      ]),
      step([
        [29.7028, -95.395],
        [29.7028, -95.39],
      ]),
    ]);
    expect(leg.bounds).toHaveLength(3);
    for (let index = 1; index < leg.bounds.length; index += 1) {
      expect(leg.bounds[index].startMeters).toBeCloseTo(leg.bounds[index - 1].endMeters, 6);
    }
    expect(leg.bounds[leg.bounds.length - 1].endMeters).toBeCloseTo(
      leg.measured.totalMeters,
      6,
    );
    // The cumulative measure and the bounds have to be the same numbers, or the
    // countdown and the line disagree by the difference.
    expect(leg.measured.cumulative).toContain(leg.bounds[1].startMeters);
  });

  it('starts each step on the segment its first point begins', () => {
    const leg = twoStepLeg();
    expect(leg.bounds[0].startSegment).toBe(1);
    expect(leg.bounds[1].startSegment).toBe(2);
  });

  it('handles a leg that is a single step', () => {
    const leg = buildLegPath([step(EAST_ROAD, { maneuver: 'ARRIVE' })]);
    expect(leg.bounds).toHaveLength(1);
    expect(leg.bounds[0].startMeters).toBe(0);
    expect(leg.bounds[0].endMeters).toBeCloseTo(leg.measured.totalMeters, 6);
    expect(leg.bounds[0].startSegment).toBe(1);
  });

  it('keeps the coordinates on their own axes', () => {
    const leg = twoStepLeg();
    for (const [latitude, longitude] of leg.measured.path) {
      expect(latitude).toBeGreaterThan(0);
      expect(longitude).toBeLessThan(0);
    }
  });
});

describe('folding a fix into the running progress', () => {
  const advance = (leg: ReturnType<typeof twoStepLeg>, fixes: NavFix[]) => {
    let state: NavProgressState = INITIAL_NAV_PROGRESS;
    const seen = [];
    for (const fix of fixes) {
      const result = advanceNavProgress(leg, fix, state);
      state = result.state;
      seen.push(result.progress);
    }
    return seen;
  };

  /** On EAST_ROAD, the longitude that is `metres` east of the halfway maneuver. */
  const pastTheManeuver = (metres: number) => -95.395 + metres / 96_696;

  it('counts down to the maneuver as the driver approaches it', () => {
    const [quarter] = advance(twoStepLeg(), [fixAt(29.7, -95.3975)]);
    expect(quarter.stepIndex).toBe(0);
    expect(quarter.alongMeters).toBeCloseTo(241.5, 0);
    expect(quarter.metersToManeuver).toBeCloseTo(241.5, 0);
    expect(quarter.metersRemaining).toBeCloseTo(724.4, 0);
    expect(quarter.offRoute).toBe(false);
    expect(quarter.offRouteFixes).toBe(0);
  });

  it('holds the step until the driver is well past the boundary', () => {
    // A phone stopped at the lights *on* a boundary puts consecutive fixes
    // either side of it. Without the margin the banner flips between two
    // instructions several times a second, re-speaking each one.
    const [, justPast] = advance(twoStepLeg(), [
      fixAt(29.7, -95.3975),
      fixAt(29.7, pastTheManeuver(NAV_STEP_ADVANCE_M - 5)),
    ]);
    expect(justPast.stepIndex).toBe(0);
    expect(justPast.alongMeters).toBeGreaterThan(EAST_ROAD_CUMULATIVE[1]);
    // The countdown floors at zero rather than going negative while it waits.
    expect(justPast.metersToManeuver).toBe(0);
  });

  it('advances the step once the margin is cleared', () => {
    const [, , clear] = advance(twoStepLeg(), [
      fixAt(29.7, -95.3975),
      fixAt(29.7, pastTheManeuver(NAV_STEP_ADVANCE_M - 5)),
      fixAt(29.7, pastTheManeuver(NAV_STEP_ADVANCE_M + 15)),
    ]);
    expect(clear.stepIndex).toBe(1);
    expect(clear.metersToManeuver).toBeCloseTo(443, 0);
  });

  it('does not rewind the step when a fix wanders back', () => {
    // A fix behind the last one is wander, not reversing. Rewinding would
    // re-show the instruction the technician has already followed and speak it
    // again.
    const progress = advance(twoStepLeg(), [
      fixAt(29.7, pastTheManeuver(NAV_STEP_ADVANCE_M + 15)),
      fixAt(29.7, -95.396),
    ]);
    const [forward, back] = progress;
    expect(forward.stepIndex).toBe(1);
    expect(back.stepIndex).toBe(1);
    expect(back.alongMeters).toBeCloseTo(forward.alongMeters, 6);
    expect(back.metersToManeuver).toBeCloseTo(forward.metersToManeuver, 6);
    expect(back.metersRemaining).toBeCloseTo(forward.metersRemaining, 6);
  });

  it('counts down along the line rather than straight to the turn', () => {
    // An L-shaped step: 483 m east, then 311 m north to the maneuver. Along the
    // road that is 794 m; as the crow flies it is 575 m. Printing the crow-flies
    // figure tells the technician to turn 200 m before the junction exists.
    const CORNER: readonly [number, number] = [29.7028, -95.395];
    const leg = buildLegPath([
      step([[29.7, -95.4], [29.7, -95.395], CORNER], { maneuver: 'TURN_RIGHT' }),
      step([CORNER, [29.7028, -95.39]], { maneuver: 'ARRIVE' }),
    ]);

    const [atTheStart] = advance(leg, [fixAt(29.7, -95.4)]);
    const crowFlies = haversineMeters(
      { latitude: 29.7, longitude: -95.4 },
      { latitude: CORNER[0], longitude: CORNER[1] },
    );

    expect(crowFlies).toBeCloseTo(574.6, 0);
    expect(atTheStart.metersToManeuver).toBeCloseTo(794.3, 0);
    expect(atTheStart.metersToManeuver).toBeGreaterThan(crowFlies + 150);
  });

  it('counts fixes off the line without acting on the first of them', () => {
    // One fix 100 m off is an overpass, an urban canyon, or a signal bounced
    // off a tower block. Rerouting on it costs a billed Google request and a
    // spoken instruction for a turn the driver never missed.
    const leg = twoStepLeg();
    let state: NavProgressState = INITIAL_NAV_PROGRESS;
    const offTheRoad = fixAt(29.7009, -95.3975);

    for (let count = 1; count < NAV_OFF_ROUTE_FIXES; count += 1) {
      const result = advanceNavProgress(leg, offTheRoad, state);
      state = result.state;
      expect(result.progress.offsetMeters).toBeGreaterThan(90);
      expect(result.progress.offRouteFixes).toBe(count);
      expect(result.progress.offRoute).toBe(false);
      // Nothing is drawn on the line while the fix disagrees with it.
      expect(result.progress.snapped).toBeNull();
    }

    const third = advanceNavProgress(leg, offTheRoad, state);
    expect(third.progress.offRouteFixes).toBe(NAV_OFF_ROUTE_FIXES);
    expect(third.progress.offRoute).toBe(true);
    expect(third.progress.snapped).toBeNull();
  });

  it('holds its place along the leg while it is off the line', () => {
    // Recomputing progress against a line the driver is not on makes the
    // remaining distance leap, which reads as a bug rather than as information.
    const leg = twoStepLeg();
    const onRoad = advanceNavProgress(leg, fixAt(29.7, -95.3975), INITIAL_NAV_PROGRESS);
    const wandered = advanceNavProgress(leg, fixAt(29.7009, -95.39), onRoad.state);
    expect(wandered.progress.alongMeters).toBeCloseTo(onRoad.progress.alongMeters, 6);
    expect(wandered.progress.metersRemaining).toBeCloseTo(onRoad.progress.metersRemaining, 6);
  });

  it('forgets the whole off-route count on a single fix back on the line', () => {
    const leg = twoStepLeg();
    let state: NavProgressState = INITIAL_NAV_PROGRESS;
    for (let count = 0; count < NAV_OFF_ROUTE_FIXES; count += 1) {
      state = advanceNavProgress(leg, fixAt(29.7009, -95.3975), state).state;
    }
    expect(state.offRouteFixes).toBe(NAV_OFF_ROUTE_FIXES);

    const recovered = advanceNavProgress(leg, fixAt(29.7, -95.3975), state);
    expect(recovered.progress.offRouteFixes).toBe(0);
    expect(recovered.progress.offRoute).toBe(false);
    expect(recovered.progress.snapped).not.toBeNull();
    expect(recovered.progress.snapped![0]).toBeGreaterThan(0);
    expect(recovered.progress.snapped![1]).toBeLessThan(0);
  });

  it('says nothing rather than guessing when the leg has no geometry', () => {
    const empty = advanceNavProgress(buildLegPath([]), fixAt(29.7, -95.4), INITIAL_NAV_PROGRESS);
    expect(empty.progress.snapped).toBeNull();
    expect(empty.progress.offsetMeters).toBe(Number.POSITIVE_INFINITY);
    expect(empty.progress.stepIndex).toBe(0);
    expect(empty.state).toEqual(INITIAL_NAV_PROGRESS);
  });
});

describe('deciding the driver has arrived rather than driven past', () => {
  /** A property on Clay Rd. */
  const STOP = { latitude: 29.7, longitude: -95.4 };
  /** About 30 m north of it -- inside the 60 m radius. */
  const OUTSIDE_THE_HOUSE: readonly [number, number] = [29.70027, -95.4];
  const T0 = 1_700_000_000_000;

  const atTheStop = (over: Partial<NavFix>) =>
    fixAt(OUTSIDE_THE_HOUSE[0], OUTSIDE_THE_HOUSE[1], over);

  it('does not arrive at a stop it is driving past at speed', () => {
    // Residential stops sit about 40 m apart. On radius alone, passing the next
    // house at 34 mph on the way to this one would advance the day's chain to a
    // stop the technician is driving away from and reroute to it.
    const passing = checkArrival(
      atTheStop({ speedMetersPerSecond: 15, at: T0 }),
      STOP,
      INITIAL_ARRIVAL,
    );
    expect(passing.arrived).toBe(false);
    expect(passing.state.since).toBeNull();
  });

  it('does not arrive on a couple of slow seconds', () => {
    // A single fix meeting both tests is still a GPS spike, and traffic lights
    // outside a property produce one on every drive.
    const first = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 }),
      STOP,
      INITIAL_ARRIVAL,
    );
    expect(first.arrived).toBe(false);
    expect(first.state.since).toBe(T0);

    const twoSeconds = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 + 2_000 }),
      STOP,
      first.state,
    );
    expect(twoSeconds.arrived).toBe(false);
    expect(twoSeconds.state.since).toBe(T0);
  });

  it('arrives once the driver has stayed close and slow for the dwell', () => {
    const first = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 }),
      STOP,
      INITIAL_ARRIVAL,
    );
    const sevenSeconds = checkArrival(
      atTheStop({ speedMetersPerSecond: 0, at: T0 + 7_000 }),
      STOP,
      first.state,
    );
    expect(sevenSeconds.arrived).toBe(true);
    expect(sevenSeconds.state.since).toBe(T0);
  });

  it('arrives when the platform reported no speed at all', () => {
    // A null speed is not evidence of movement, and refusing it would leave
    // handsets that omit speed unable to ever finish a drive.
    const first = checkArrival(
      atTheStop({ speedMetersPerSecond: null, at: T0 }),
      STOP,
      INITIAL_ARRIVAL,
    );
    const later = checkArrival(
      atTheStop({ speedMetersPerSecond: null, at: T0 + 7_000 }),
      STOP,
      first.state,
    );
    expect(later.arrived).toBe(true);
  });

  it('restarts the clock when the driver leaves the radius', () => {
    const first = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 }),
      STOP,
      INITIAL_ARRIVAL,
    );
    // 100 m north: outside the 60 m radius.
    const awayAgain = checkArrival(
      fixAt(29.7009, -95.4, { speedMetersPerSecond: 1, at: T0 + 3_000 }),
      STOP,
      first.state,
    );
    expect(awayAgain.arrived).toBe(false);
    expect(awayAgain.state.since).toBeNull();

    const backAgain = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 + 4_000 }),
      STOP,
      awayAgain.state,
    );
    expect(backAgain.arrived).toBe(false);
    expect(backAgain.state.since).toBe(T0 + 4_000);
  });

  it('restarts the clock when the driver speeds up again', () => {
    const first = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 }),
      STOP,
      INITIAL_ARRIVAL,
    );
    const drivingOn = checkArrival(
      atTheStop({ speedMetersPerSecond: 15, at: T0 + 5_000 }),
      STOP,
      first.state,
    );
    expect(drivingOn.state.since).toBeNull();

    // Seven seconds after the original fix, but only two of them spent stopped.
    const stoppedAgain = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 + 7_000 }),
      STOP,
      drivingOn.state,
    );
    expect(stoppedAgain.arrived).toBe(false);
  });

  it('lets an unusable fix neither confirm nor cancel', () => {
    // A single 200 m spike beside the right house must not cancel an arrival
    // that is already several seconds old, and must not complete one either.
    const first = checkArrival(
      atTheStop({ speedMetersPerSecond: 1, at: T0 }),
      STOP,
      INITIAL_ARRIVAL,
    );
    const spike = checkArrival(
      atTheStop({ accuracyMeters: 200, speedMetersPerSecond: 0, at: T0 + 9_000 }),
      STOP,
      first.state,
    );
    expect(spike.arrived).toBe(false);
    expect(spike.state.since).toBe(T0);

    const good = checkArrival(
      atTheStop({ speedMetersPerSecond: 0, at: T0 + 10_000 }),
      STOP,
      spike.state,
    );
    expect(good.arrived).toBe(true);
  });

  it('measures the radius from the real distance, on the real axes', () => {
    // A latitude/longitude swap here would put the fix at [-95.4, 29.70027] --
    // in the South Atlantic, 12,000 km away, and nothing would ever arrive.
    expect(
      haversineMeters({ latitude: OUTSIDE_THE_HOUSE[0], longitude: OUTSIDE_THE_HOUSE[1] }, STOP),
    ).toBeLessThan(NAV_ARRIVAL_RADIUS_M);
    expect(haversineMeters({ latitude: 29.7009, longitude: -95.4 }, STOP)).toBeGreaterThan(
      NAV_ARRIVAL_RADIUS_M,
    );
  });
});

describe('choosing what to speak', () => {
  const nothingSaid = new Set<number>();

  it('speaks each threshold as it is crossed, and only once', () => {
    expect(announcementFor(1_500, nothingSaid)).toBe(1_600);
    const afterFar = new Set([1_600]);
    // Still inside 1,600 m on the next fix a second later, but it has been said.
    expect(announcementFor(1_450, afterFar)).toBeNull();
    expect(announcementFor(350, afterFar)).toBe(400);
    const afterMid = new Set([1_600, 400]);
    expect(announcementFor(300, afterMid)).toBeNull();
    expect(announcementFor(50, afterMid)).toBe(60);
    expect(announcementFor(20, new Set([1_600, 400, 60]))).toBeNull();
  });

  it('says nothing at all while the turn is still far off', () => {
    expect(announcementFor(2_000, nothingSaid)).toBeNull();
  });

  it('speaks only the nearer when a signal gap crosses two at once', () => {
    // A tunnel or a dead spot delivers the next fix half a mile on. "In one
    // mile, turn right" is no longer true by the time it is spoken.
    expect(announcementFor(50, nothingSaid)).toBe(60);
    expect(announcementFor(300, nothingSaid)).toBe(400);
  });

  it('fires on the threshold itself, not only below it', () => {
    expect(announcementFor(400, nothingSaid)).toBe(400);
    expect(announcementFor(60, new Set([1_600, 400]))).toBe(60);
  });

  it('does not mutate the set it was given', () => {
    const spoken = new Set([1_600]);
    announcementFor(350, spoken);
    expect([...spoken]).toEqual([1_600]);
  });
});

describe('thinning a path for drawing', () => {
  it('always keeps both ends', () => {
    const corner: readonly (readonly [number, number])[] = [
      [29.7, -95.4],
      [29.7, -95.395],
      [29.7028, -95.395],
    ];
    const thinned = decimatePath(corner, 10_000);
    expect(thinned).toHaveLength(2);
    expect(thinned[0]).toEqual(corner[0]);
    expect(thinned[thinned.length - 1]).toEqual(corner[corner.length - 1]);
  });

  it('collapses a straight run to its two ends', () => {
    // A motorway stretch arrives from the router as dozens of collinear points.
    // Rebuilding SVG path data for all of them on every fix is what drops the
    // frame rate approaching a turn.
    const straight: readonly (readonly [number, number])[] = [
      [29.7, -95.4],
      [29.7, -95.399],
      [29.7, -95.398],
      [29.7, -95.397],
      [29.7, -95.396],
    ];
    expect(decimatePath(straight, 5)).toHaveLength(2);
  });

  it('keeps a corner, because a corner is the point of the drawing', () => {
    const corner: readonly (readonly [number, number])[] = [
      [29.7, -95.4],
      [29.7, -95.395],
      [29.7028, -95.395],
    ];
    // The corner sits 261 m off the chord between the ends.
    const thinned = decimatePath(corner, 5);
    expect(thinned).toHaveLength(3);
    expect(thinned[1]).toEqual(corner[1]);
  });

  it('keeps a corner that a coarse tolerance would still notice', () => {
    const slightBend: readonly (readonly [number, number])[] = [
      [29.7, -95.4],
      [29.7002, -95.395],
      [29.7, -95.39],
    ];
    // The bend is about 22 m off the chord.
    expect(decimatePath(slightBend, 5)).toHaveLength(3);
    expect(decimatePath(slightBend, 40)).toHaveLength(2);
  });

  it('leaves a path alone when there is nothing to thin', () => {
    const pair: readonly (readonly [number, number])[] = [
      [29.7, -95.4],
      [29.7, -95.39],
    ];
    expect(decimatePath(pair, 5)).toBe(pair);
    expect(decimatePath([], 5)).toHaveLength(0);
  });

  it('leaves a path alone when the tolerance is meaningless', () => {
    const corner: readonly (readonly [number, number])[] = [
      [29.7, -95.4],
      [29.7, -95.395],
      [29.7028, -95.395],
    ];
    expect(decimatePath(corner, 0)).toBe(corner);
    expect(decimatePath(corner, -1)).toBe(corner);
  });

  it('keeps the points it keeps on their own axes and in order', () => {
    const leg = twoStepLeg();
    const thinned = decimatePath(leg.measured.path, 5);
    expect(thinned.length).toBeGreaterThanOrEqual(2);
    for (const [latitude, longitude] of thinned) {
      expect(latitude).toBeGreaterThan(29);
      expect(latitude).toBeLessThan(31);
      expect(longitude).toBeGreaterThan(-96);
      expect(longitude).toBeLessThan(-95);
    }
    // Drawing only: the thinned line must never be measured against, so its
    // length is allowed to differ from the measured path's.
    expect(thinned[0]).toEqual(leg.measured.path[0]);
    expect(thinned[thinned.length - 1]).toEqual(
      leg.measured.path[leg.measured.path.length - 1],
    );
  });
});
