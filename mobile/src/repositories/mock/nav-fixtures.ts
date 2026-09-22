import type { NavigationLeg, NavigationStep } from '@texasrenters/shared';

/**
 * One real drive through Houston, so the navigation screen can be walked end to
 * end with `EXPO_PUBLIC_ENABLE_DEMO_DATA=true` and no backend at all.
 *
 * Everything the screen decides -- which step, how far to the turn, has the
 * driver left the line, have they arrived, what should be spoken -- is pure
 * arithmetic over a polyline in `nav-progress.ts`. Given this fixture and a
 * simulated fix stream, the whole of it can be exercised on a desk. That is the
 * point of the file: the alternative is discovering that the countdown hands
 * over a step early while driving down the Southwest Freeway.
 *
 * ## The axis
 *
 * **`[latitude, longitude]`, latitude first**, like everything in `shared/` and
 * on the wire. In Houston that means the first number is about **+29.7** and
 * the second about **-95.4**. Written the other way round this fixture is a
 * point in the Indian Ocean, a mistake that does not throw and does not look
 * wrong until the map is drawn. The tests assert the sign of each number rather
 * than its index, which is the only check that catches it.
 *
 * Distances are the router's own road-network figures, so they do not exactly
 * match what `measurePath` computes off the polyline -- a simplification of the
 * same road. `buildLegPath` measures the boundaries off the geometry for
 * exactly that reason, and this fixture keeps the discrepancy rather than
 * hiding it, because the real ones have it.
 */

type LatLng = readonly [number, number];

/**
 * Free-flow step seconds deliberately sum to far less than the leg's duration
 * below. That gap is real: the Routes API's `staticDuration` ignores traffic
 * and the leg's duration does not, and it is why a step's seconds must never be
 * printed as "time to the next turn" beside the HUD's ETA.
 */
const STEPS: readonly NavigationStep[] = [
  {
    maneuver: 'DEPART',
    instruction: 'Head south on Kirby Drive',
    roadName: 'Kirby Drive',
    distanceMeters: 660,
    durationSeconds: 55,
    polyline: [
      [29.745, -95.4102],
      [29.7441, -95.4102],
      [29.7432, -95.4103],
      [29.7423, -95.4103],
      [29.7414, -95.4104],
      [29.7402, -95.4104],
      [29.7391, -95.4105],
    ],
  },
  {
    maneuver: 'TURN_LEFT',
    instruction: 'Turn left onto Westheimer Road',
    roadName: 'Westheimer Road',
    distanceMeters: 850,
    durationSeconds: 70,
    polyline: [
      [29.7391, -95.4105],
      [29.739, -95.4088],
      [29.7389, -95.407],
      [29.7388, -95.4052],
      [29.7387, -95.4035],
      [29.7386, -95.4018],
    ],
  },
  {
    maneuver: 'TURN_RIGHT',
    instruction: 'Turn right onto Greenbriar Drive',
    roadName: 'Greenbriar Drive',
    distanceMeters: 940,
    durationSeconds: 78,
    polyline: [
      [29.7386, -95.4018],
      [29.7372, -95.4017],
      [29.7358, -95.4016],
      [29.7344, -95.4016],
      [29.733, -95.4015],
      [29.7316, -95.4014],
      [29.7302, -95.4013],
    ],
  },
  {
    // The one step with no road name: a ramp is signed by where it goes, not by
    // what it is called, and the screen has to cope with the null.
    maneuver: 'RAMP_RIGHT',
    instruction: 'Take the ramp onto US-59 South',
    roadName: null,
    distanceMeters: 620,
    durationSeconds: 40,
    polyline: [
      [29.7302, -95.4013],
      [29.7292, -95.4006],
      [29.7283, -95.3999],
      [29.7274, -95.3992],
      [29.7265, -95.3985],
      [29.7256, -95.3978],
    ],
  },
  {
    maneuver: 'TURN_RIGHT',
    instruction: 'Turn right onto Richmond Avenue',
    roadName: 'Richmond Avenue',
    distanceMeters: 540,
    durationSeconds: 45,
    polyline: [
      [29.7256, -95.3978],
      [29.7246, -95.3973],
      [29.7236, -95.3969],
      [29.7226, -95.3965],
      [29.7216, -95.3962],
      [29.721, -95.3961],
    ],
  },
  {
    // Every leg ends in ARRIVE. Google sends no arrival maneuver at all -- its
    // enum stops short and the last step is bare text -- so `maneuverFromGoogle`
    // synthesises it from `isLast`, and a fixture without one would let the
    // screen's arrival handling go untested.
    maneuver: 'ARRIVE',
    instruction: 'The property is on the right',
    roadName: 'Richmond Avenue',
    distanceMeters: 60,
    durationSeconds: 10,
    polyline: [
      [29.721, -95.3961],
      [29.7208, -95.396],
      [29.7206, -95.396],
      [29.7205, -95.396],
    ],
  },
];

/**
 * The leg's own line, built from the steps rather than written out again.
 *
 * Steps share endpoints -- each begins where the last ended -- so the duplicate
 * is dropped, which is what `buildLegPath` does to the same geometry. Deriving
 * it means the two can never drift apart in the fixture, which is a class of
 * bug the real payload cannot have and a hand-written fixture easily can.
 */
function joinSteps(steps: readonly NavigationStep[]): LatLng[] {
  const path: LatLng[] = [];
  for (const step of steps) {
    for (const point of step.polyline) {
      const last = path[path.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      path.push(point);
    }
  }
  return path;
}

export const HOUSTON_NAV_POLYLINE: readonly LatLng[] = joinSteps(STEPS);

/**
 * A drive of about two and a quarter miles, nine minutes in traffic.
 *
 * `drawnAt` is fixed rather than `new Date()` so a snapshot of this fixture
 * does not change every time it is read. The mock repository stamps the current
 * time onto the copy it hands out, because the screen tells a fresh leg from a
 * held one by that field.
 */
export const houstonNavigationLeg: NavigationLeg = {
  toStopId: 'mock-inspection-1',
  from: [29.745, -95.4102],
  to: [29.7205, -95.396],
  distanceMeters: 3_670,
  durationSeconds: 540,
  steps: STEPS,
  polyline: HOUSTON_NAV_POLYLINE,
  source: 'GOOGLE_TRAFFIC',
  drawnAt: '2026-09-22T14:05:00.000Z',
};
