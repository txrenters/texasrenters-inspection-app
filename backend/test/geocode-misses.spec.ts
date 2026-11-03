import {
  GEOCODE_MISS_BACKOFF_MS,
  PropertyGeocodingService,
} from '../src/admin/property-geocoding.service';

/**
 * An address nothing can place is asked about once, not every hour.
 *
 * The hourly pass (`23 * * * *`) picks every row without a coordinate, and used
 * to write nothing down when the answer was "no match" -- so each address
 * Google could not place was a billed lookup every hour, for ever, up to 250 a
 * pass. These count the lookups across a day of passes.
 */

const NOW = Date.parse('2026-11-04T12:23:00.000Z');
const HOUR = 60 * 60_000;

interface Row {
  id: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  latitude: { toNumber: () => number } | null;
  longitude: { toNumber: () => number } | null;
  geocodedFor: string | null;
  geocodeSource: string | null;
  geocodePrecision: string | null;
  geocodeMissFor: string | null;
  geocodeMissAt: Date | null;
}

function row(id: string, street: string): Row {
  return {
    id,
    addressLine1: street,
    city: 'Houston',
    state: 'TX',
    postalCode: '77044',
    latitude: null,
    longitude: null,
    geocodedFor: null,
    geocodeSource: null,
    geocodePrecision: null,
    geocodeMissFor: null,
    geocodeMissAt: null,
  };
}

/** A table that answers the pass's query as Postgres would, and keeps what it is told. */
function table(rows: Row[]) {
  return {
    rows,
    findMany: async (args: { take: number }) =>
      rows
        .filter((r) => r.latitude === null || r.longitude === null || r.geocodedFor === null)
        .sort(
          (a, b) =>
            (a.geocodeMissAt?.getTime() ?? -Infinity) - (b.geocodeMissAt?.getTime() ?? -Infinity) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, args.take),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const target = rows.find((r) => r.id === where.id)!;
      for (const [key, value] of Object.entries(data))
        (target as unknown as Record<string, unknown>)[key] =
          key === 'latitude' || key === 'longitude' ? { toNumber: () => value as number } : value;
      return target;
    },
  };
}

/** Streets neither geocoder can place. Everything else is found on the roof. */
const NOWHERE = /Nowhere|Unknown/;

function geocoders(census: 'answers' | 'down' = 'answers') {
  const calls = { google: 0, census: 0 };
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const address = url.searchParams.get('address') ?? '';
    if (url.hostname === 'maps.googleapis.com') {
      calls.google += 1;
      return new Response(
        JSON.stringify(
          NOWHERE.test(address)
            ? { status: 'ZERO_RESULTS', results: [] }
            : {
                status: 'OK',
                results: [{ geometry: { location: { lat: 29.87, lng: -95.18 }, location_type: 'ROOFTOP' } }],
              },
        ),
      );
    }
    calls.census += 1;
    if (census === 'down') return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({ result: { addressMatches: [] } }));
  });
  return { calls, fetchMock };
}

function serviceFor(buildings: Row[], properties: Row[] = []) {
  const prisma = { propertywareBuilding: table(buildings), property: table(properties) };
  return { service: new PropertyGeocodingService(prisma as never), prisma };
}

/** The scheduler's run: buildings, then properties, as `PropertyGeocodeScheduler` does. */
async function hourlyPass(service: PropertyGeocodingService) {
  await service.geocodePendingBuildings(250);
  await service.geocodePending(250);
}

const key = process.env.GOOGLE_SERVER_API_KEY;

beforeEach(() => {
  process.env.GOOGLE_SERVER_API_KEY = 'test-key';
  // Only the clock is faked; the pause between lookups is skipped outright.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation(((resolve: () => void) => {
    resolve();
    return 0;
  }) as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (key === undefined) delete process.env.GOOGLE_SERVER_API_KEY;
  else process.env.GOOGLE_SERVER_API_KEY = key;
});

describe('an address no geocoder can place', () => {
  it('is asked about once in a day of hourly passes, not 24 times', async () => {
    const { calls } = geocoders();
    const buildings = [row('b1', '1 Nowhere Rd'), row('b2', '2 Nowhere Rd'), row('b3', '3 Unknown St')];
    const properties = [row('p1', '9 Nowhere Rd')];
    const { service } = serviceFor(buildings, properties);

    for (let hour = 0; hour < 24; hour += 1) {
      jest.setSystemTime(NOW + hour * HOUR);
      await hourlyPass(service);
    }

    // Four addresses, one lookup each: 4 Google calls, where there were 96.
    expect(calls.google).toBe(4);
    expect(calls.census).toBe(4);
    expect(buildings[0]).toMatchObject({
      geocodeMissFor: '1 Nowhere Rd, Houston, TX 77044',
      geocodeMissAt: new Date(NOW),
      latitude: null,
    });
  });

  it('is asked about again at once when its address is corrected', async () => {
    const { calls } = geocoders();
    const buildings = [row('b1', '1 Nowhere Rd'), row('b2', '2 Nowhere Rd')];
    const { service, prisma } = serviceFor(buildings);

    await hourlyPass(service);
    expect(calls.google).toBe(2);

    // The office fixes the street in Propertyware, and the sync writes it.
    buildings[0].addressLine1 = '1 Real Rd';
    jest.setSystemTime(NOW + HOUR);
    await hourlyPass(service);

    expect(calls.google).toBe(3);
    expect(prisma.propertywareBuilding.rows[0]).toMatchObject({
      geocodedFor: '1 Real Rd, Houston, TX 77044',
      geocodeMissFor: null,
      geocodeMissAt: null,
    });
  });

  it('is asked about again once the back-off has passed', async () => {
    const { calls } = geocoders();
    const { service } = serviceFor([row('b1', '1 Nowhere Rd')]);

    await hourlyPass(service);
    jest.setSystemTime(NOW + GEOCODE_MISS_BACKOFF_MS - 1);
    await hourlyPass(service);
    expect(calls.google).toBe(1);

    jest.setSystemTime(NOW + GEOCODE_MISS_BACKOFF_MS);
    await hourlyPass(service);
    expect(calls.google).toBe(2);
  });

  it('does not keep a new property waiting behind a pile of misses', async () => {
    // More unplaceable rows than one batch holds: the new property still gets
    // its lookup on the next pass, rather than never being reached.
    const { calls } = geocoders();
    const misses = Array.from({ length: 5 }, (_, i) => row(`a${i}`, `${i} Nowhere Rd`));
    const { service, prisma } = serviceFor(misses);

    await service.geocodePendingBuildings(5);
    prisma.propertywareBuilding.rows.push(row('z-new', '10 Real Rd'));
    jest.setSystemTime(NOW + HOUR);
    await service.geocodePendingBuildings(5);

    expect(calls.google).toBe(6);
    expect(prisma.propertywareBuilding.rows.find((r) => r.id === 'z-new')?.latitude).not.toBeNull();
  });
});

describe('a geocoder that cannot be reached', () => {
  it('is not a miss: the row is asked about again on the next pass', async () => {
    const { calls } = geocoders('down');
    const buildings = [row('b1', '1 Nowhere Rd')];
    const { service } = serviceFor(buildings);

    await hourlyPass(service);
    jest.setSystemTime(NOW + HOUR);
    await hourlyPass(service);

    expect(calls.census).toBe(2);
    expect(buildings[0].geocodeMissAt).toBeNull();
  });
});
