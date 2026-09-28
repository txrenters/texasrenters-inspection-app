import { parseNavigationLeg } from '../src/routing/google-routes.client';
import { RouteService } from '../src/routing/route.service';

/**
 * The drive to one stop, turn by turn.
 *
 * Three things are worth pinning here, and each of them fails silently rather
 * than loudly:
 *
 * - **The arrival.** Google's maneuver enum has no arrival in it. The last step
 *   of a leg carries prose -- "Destination will be on the right" -- and leaves
 *   `maneuver` unset, so mapped naively the final instruction of every drive,
 *   the one the technician most needs drawn, becomes an unknown one.
 * - **The axis.** Everything downstream of `toLatLngPath` is `[latitude,
 *   longitude]`, and `decodePolyline` deliberately emits `[lon, lat]`. A swap
 *   draws a perfectly plausible route in the Indian Ocean while every component
 *   looks individually correct, so these assert the *sign* of each value rather
 *   than its position: Texas is latitude ~29 positive, longitude ~-95 negative.
 * - **Whose inspection it is.** The endpoint behind this takes an id from a
 *   handset, which the technician route endpoint's own comment says is a thing
 *   a technician must never be handed. It is safe only because the id is
 *   resolved *inside* the technician's own day rather than fetched.
 */

const dec = (value: number) => ({ toNumber: () => value }) as never;

/** One stop on this technician's day, and one they finished this morning. */
const rows = [
  {
    inspection: {
      id: 'inspection-ahead',
      status: 'SCHEDULED',
      propertywareBuilding: {
        id: 'building-ahead',
        name: 'Kirby Drive',
        addressLine1: '1 Kirby Drive',
        city: 'Houston',
        latitude: dec(29.78),
        longitude: dec(-95.35),
      },
      property: null,
    },
  },
  {
    inspection: {
      id: 'inspection-done',
      status: 'TECHNICIAN_SUBMITTED',
      propertywareBuilding: {
        id: 'building-done',
        name: 'Westheimer Road',
        addressLine1: '2 Westheimer Road',
        city: 'Houston',
        latitude: dec(29.74),
        longitude: dec(-95.41),
      },
      property: null,
    },
  },
];

/** Google's leg as the client parses it: still `[lon, lat]`, still Google's enum. */
const googleLeg = {
  distanceMeters: 4_200,
  durationSeconds: 620,
  geometry: [
    [-95.4, 29.75],
    [-95.35, 29.78],
  ] as [number, number][],
  steps: [
    {
      maneuver: 'DEPART',
      instruction: 'Head north on Main Street',
      distanceMeters: 300,
      durationSeconds: 40,
      geometry: [
        [-95.4, 29.75],
        [-95.4, 29.76],
      ] as [number, number][],
    },
    {
      maneuver: 'TURN_SLIGHT_RIGHT',
      instruction: 'Slight right onto Kirby Drive',
      distanceMeters: 3_400,
      durationSeconds: 480,
      geometry: [
        [-95.4, 29.76],
        [-95.36, 29.78],
      ] as [number, number][],
    },
    {
      // Unset, exactly as Google leaves it on the final step of a leg.
      maneuver: null,
      instruction: 'Your destination will be on the right',
      distanceMeters: 500,
      durationSeconds: 100,
      geometry: [
        [-95.36, 29.78],
        [-95.35, 29.78],
      ] as [number, number][],
    },
  ],
};

function service(options: { leg?: typeof googleLeg | null; configured?: boolean } = {}) {
  const asked: { where: unknown }[] = [];
  const calls = { routeWithSteps: 0 };

  const prisma = {
    inspectionAssignment: {
      findMany: async (args: { where: unknown }) => {
        asked.push(args);
        return rows;
      },
    },
  };
  const google = {
    configured: options.configured ?? true,
    routeWithSteps: async () => {
      calls.routeWithSteps += 1;
      return options.leg === undefined ? googleLeg : options.leg;
    },
  };
  const osrm = { configured: false };

  return {
    service: new RouteService(prisma as never, osrm as never, google as never, {} as never),
    asked,
    calls,
  };
}

const HERE = { latitude: 29.75, longitude: -95.4 };

describe('the instructions for driving a leg', () => {
  it('normalises Google’s maneuvers onto the ones the app has arrows for', async () => {
    const { service: routes } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);

    expect(leg?.steps.map((step) => step.maneuver)).toEqual([
      'DEPART',
      'TURN_SLIGHT_RIGHT',
      'ARRIVE',
    ]);
  });

  it('makes the last step an arrival although Google sends no such maneuver', async () => {
    const { service: routes } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);
    const last = leg?.steps[leg.steps.length - 1];

    expect(last?.maneuver).toBe('ARRIVE');
    // The router's own words survive alongside it. They are always right even
    // when the enum is not, which is why an unknown maneuver is still readable.
    expect(last?.instruction).toBe('Your destination will be on the right');
  });

  it('keeps the router’s instruction text rather than writing its own', async () => {
    const { service: routes } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);

    expect(leg?.steps[1].instruction).toBe('Slight right onto Kirby Drive');
    // Google does not name the road separately; pulling it out of the sentence
    // with a pattern would invent a field on every sentence that did not match.
    expect(leg?.steps[1].roadName).toBeNull();
  });

  it('says Google timed it, so the ETA can be presented as traffic-aware', async () => {
    const { service: routes } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);

    expect(leg?.source).toBe('GOOGLE_TRAFFIC');
    expect(leg?.durationSeconds).toBe(620);
    expect(leg?.distanceMeters).toBe(4_200);
  });
});

describe('which way round the coordinates are', () => {
  /**
   * Asserted by sign, never by position. Latitude in Texas is around 29 and
   * positive; longitude is around -95 and negative. A test that checked
   * `polyline[0][0] === 29.75` would pass just as happily on a swapped pair of
   * numbers if the fixture happened to be symmetrical.
   */
  it('draws the leg in [latitude, longitude]', async () => {
    const { service: routes } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);
    const [latitude, longitude] = leg!.polyline[0];

    expect(latitude).toBeGreaterThan(0);
    expect(latitude).toBeCloseTo(29.75, 5);
    expect(longitude).toBeLessThan(0);
    expect(longitude).toBeCloseTo(-95.4, 5);
  });

  it('draws every step the same way round as the leg', async () => {
    const { service: routes } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);

    for (const step of leg!.steps)
      for (const [latitude, longitude] of step.polyline) {
        expect(latitude).toBeGreaterThan(0);
        expect(longitude).toBeLessThan(0);
      }
  });

  it('reports where it was drawn from and to the same way round', async () => {
    const { service: routes } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);

    expect(leg?.from[0]).toBeGreaterThan(0);
    expect(leg?.from[1]).toBeLessThan(0);
    expect(leg?.to[0]).toBeGreaterThan(0);
    expect(leg?.to[1]).toBeLessThan(0);
  });
});

describe('whose inspection may be navigated to', () => {
  /**
   * The security property. The id comes from the handset, and the only thing
   * that makes accepting one safe is that it is looked for inside the
   * technician's own day rather than used to fetch anything.
   */
  it('refuses an inspection that is not on this technician’s day', async () => {
    const { service: routes, calls } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'somebody-elses-inspection', HERE);

    expect(leg).toBeNull();
    // And never asks a router about it. A refusal that still bought a route
    // would be a refusal that told the caller the property exists.
    expect(calls.routeWithSteps).toBe(0);
  });

  it('refuses work the technician has already handed in', async () => {
    const { service: routes, calls } = service();

    const leg = await routes.navigateLeg('org', 'tech', 'inspection-done', HERE);

    expect(leg).toBeNull();
    expect(calls.routeWithSteps).toBe(0);
  });

  it('looks only at this technician’s own current assignments', async () => {
    const { service: routes, asked } = service();

    await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE);

    expect(asked).toHaveLength(1);
    expect(asked[0].where).toMatchObject({
      technicianId: 'tech',
      isCurrent: true,
      inspection: { organizationId: 'org' },
    });
  });

  it('refuses a position that is not a position', async () => {
    const { service: routes, calls } = service();

    // The query string arrives as text and becomes NaN when it is absent or
    // mistyped. NaN routes: Google would be asked about a point that is not one.
    const leg = await routes.navigateLeg('org', 'tech', 'inspection-ahead', {
      latitude: Number.NaN,
      longitude: Number.NaN,
    });

    expect(leg).toBeNull();
    expect(calls.routeWithSteps).toBe(0);
  });
});

describe('when no route can be drawn', () => {
  it('answers with nothing rather than an empty leg', async () => {
    const { service: routes } = service({ leg: null });

    expect(await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE)).toBeNull();
  });

  it('does not ask a router it has no key for', async () => {
    const { service: routes, calls } = service({ configured: false });

    expect(await routes.navigateLeg('org', 'tech', 'inspection-ahead', HERE)).toBeNull();
    expect(calls.routeWithSteps).toBe(0);
  });
});

describe('reading a steps response from Google', () => {
  /** Three points down the Houston side of the Gulf Freeway. */
  const encoded = '_ostDn}aeQo}@o}@o}@o}@';

  const body = {
    routes: [
      {
        duration: '620s',
        distanceMeters: 4200,
        legs: [
          {
            duration: '620s',
            distanceMeters: 4200,
            polyline: { encodedPolyline: encoded },
            steps: [
              {
                navigationInstruction: { maneuver: 'TURN_LEFT', instructions: 'Turn left' },
                distanceMeters: 300,
                staticDuration: '40s',
                polyline: { encodedPolyline: encoded },
              },
              {
                navigationInstruction: { instructions: 'Destination on the right' },
                staticDuration: '30s',
                polyline: { encodedPolyline: encoded },
              },
            ],
          },
        ],
      },
    ],
  };

  it('keeps Google’s own enum for the service to normalise', () => {
    const leg = parseNavigationLeg(body);

    expect(leg?.steps[0].maneuver).toBe('TURN_LEFT');
    // Unset, not guessed at. Whether it is an arrival depends on its position
    // in the list, which is a fact about the leg and not about the step.
    expect(leg?.steps[1].maneuver).toBeNull();
  });

  it('decodes step geometry longitude-first, matching every other router', () => {
    const leg = parseNavigationLeg(body);
    const [longitude, latitude] = leg!.steps[0].geometry[0];

    expect(longitude).toBeLessThan(0);
    expect(longitude).toBeCloseTo(-95.37, 4);
    expect(latitude).toBeGreaterThan(0);
    expect(latitude).toBeCloseTo(29.76, 4);
  });

  it('does not invent a distance Google omitted', () => {
    // Google leaves `distanceMeters` off entirely when it is zero, which is
    // legal and happens on a departure step that starts on the line.
    expect(parseNavigationLeg(body)?.steps[1].distanceMeters).toBe(0);
  });

  it('refuses a leg with no steps at all', () => {
    /**
     * A leg with no instructions cannot be navigated: `buildLegPath` would
     * measure an empty path and every distance on the screen would read zero.
     * Saying so lets the phone show "no route to draw" instead of a HUD that
     * counts down from nothing.
     */
    expect(
      parseNavigationLeg({ routes: [{ duration: '60s', legs: [{ duration: '60s', steps: [] }] }] }),
    ).toBeNull();
    expect(parseNavigationLeg({ routes: [] })).toBeNull();
    expect(parseNavigationLeg(null)).toBeNull();
  });
});
