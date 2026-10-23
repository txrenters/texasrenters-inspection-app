import type { PrismaService } from '../src/common/prisma.service';
import {
  OpenStreetMapPlacesClient,
  formatNominatimAddress,
  parseNominatimReverse,
} from '../src/time-tracking/openstreetmap-places.client';
import { StopNamingService } from '../src/time-tracking/stop-naming.service';

/**
 * Naming a stop away from the properties (the office, 2026-10-17: "if he goes
 * to the hardware store").
 *
 * What is pinned is the order of asking -- our own data before anybody
 * else's -- and the privacy that order buys: a stop at a technician's home is
 * called "Home" and never leaves the building, and nothing about who stood
 * there is sent with a position.
 */

const METRE = 1 / 111_320;
const STORE = { latitude: 29.9, longitude: -95.5 };
const north = (metres: number) => ({ latitude: STORE.latitude + metres * METRE, longitude: STORE.longitude });

type Rows = { home?: unknown; buildings?: unknown[]; known?: unknown[] };

function harness(rows: Rows = {}, answer: unknown = null, enabled = true) {
  const prisma = {
    technicianPlanningProfile: { findFirst: jest.fn().mockResolvedValue(rows.home ?? null) },
    propertywareBuilding: { findMany: jest.fn().mockResolvedValue(rows.buildings ?? []) },
    timeSegment: { findMany: jest.fn().mockResolvedValue(rows.known ?? []), updateMany: jest.fn() },
  };
  const openStreetMap = { enabled, placeAt: jest.fn().mockResolvedValue(answer) };
  const service = new StopNamingService(
    prisma as unknown as PrismaService,
    openStreetMap as unknown as OpenStreetMapPlacesClient,
  );
  return { service, prisma, openStreetMap };
}

const home = (at: { latitude: number; longitude: number }) => ({
  homeLatitude: at.latitude,
  homeLongitude: at.longitude,
});

describe('what a stop was', () => {
  it('is "Home" at the technician’s own home, and the position is never sent anywhere', async () => {
    const { service, openStreetMap } = harness({ home: home(north(40)) }, { kind: 'BUSINESS', name: 'Shop' });

    await expect(service.placeFor('org-1', 'tech-1', STORE)).resolves.toEqual({
      kind: 'HOME',
      name: 'Home',
      address: null,
    });
    expect(openStreetMap.placeAt).not.toHaveBeenCalled();
  });

  it('is a property the office manages, by its address, when it had no visit that day', async () => {
    const { service, openStreetMap } = harness({
      buildings: [
        { addressLine1: '7 Far Rd', ...north(35) },
        { addressLine1: '5 Near Ln', ...north(10) },
      ].map(({ addressLine1, latitude, longitude }) => ({ addressLine1, latitude, longitude })),
    });

    await expect(service.placeFor('org-1', 'tech-1', STORE)).resolves.toEqual({
      kind: 'PROPERTY',
      name: '5 Near Ln',
      address: null,
    });
    expect(openStreetMap.placeAt).not.toHaveBeenCalled();
  });

  it('looks for the property in the stop’s own organization only', async () => {
    const { service, prisma } = harness();

    await service.placeFor('org-1', 'tech-1', STORE);

    expect(prisma.propertywareBuilding.findMany.mock.calls[0]![0].where.organizationId).toBe('org-1');
    expect(prisma.timeSegment.findMany.mock.calls[0]![0].where.organizationId).toBe('org-1');
    expect(prisma.technicianPlanningProfile.findFirst.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-1',
      technicianId: 'tech-1',
    });
  });

  /** The same store every week is asked about once. */
  it('borrows the name of a stop already named at the same place', async () => {
    const { service, openStreetMap } = harness({
      known: [
        {
          placeKind: 'BUSINESS',
          placeName: 'The Home Depot',
          placeAddress: '1 Supply Rd, Houston',
          placeLatitude: north(20).latitude,
          placeLongitude: north(20).longitude,
        },
      ],
    });

    await expect(service.placeFor('org-1', 'tech-1', STORE)).resolves.toEqual({
      kind: 'BUSINESS',
      name: 'The Home Depot',
      address: '1 Supply Rd, Houston',
    });
    expect(openStreetMap.placeAt).not.toHaveBeenCalled();
  });

  it('asks OpenStreetMap for anything our own data cannot name', async () => {
    const { service, openStreetMap } = harness({}, { kind: 'BUSINESS', name: "Lowe's", address: '2 Lumber Ln' });

    await expect(service.placeFor('org-1', 'tech-1', STORE)).resolves.toEqual({
      kind: 'BUSINESS',
      name: "Lowe's",
      address: '2 Lumber Ln',
    });
    // The position and nothing else: no technician, no organization.
    expect(openStreetMap.placeAt).toHaveBeenCalledWith(STORE);
  });

  it('says it found nothing when nothing is near enough', async () => {
    const { service } = harness({}, null);

    await expect(service.placeFor('org-1', 'tech-1', STORE)).resolves.toEqual({
      kind: 'UNKNOWN',
      name: null,
      address: null,
    });
  });

  /** Unreachable is not the same as nothing there, and is asked again later. */
  it('leaves the stop to be asked about again when OpenStreetMap cannot be reached', async () => {
    const { service, openStreetMap } = harness();
    openStreetMap.placeAt.mockResolvedValue(undefined);

    await expect(service.placeFor('org-1', 'tech-1', STORE)).resolves.toBeUndefined();
  });

  it('does not ask outside at all once the lookup is switched off', async () => {
    const { service, openStreetMap } = harness({}, { kind: 'BUSINESS', name: 'Shop' }, false);

    await expect(service.placeFor('org-1', 'tech-1', STORE)).resolves.toMatchObject({ kind: 'UNKNOWN' });
    expect(openStreetMap.placeAt).not.toHaveBeenCalled();
  });
});

describe('naming the stops waiting for one', () => {
  const waiting = (id: string) => ({
    id,
    organizationId: 'org-1',
    technicianId: 'tech-1',
    placeLatitude: STORE.latitude,
    placeLongitude: STORE.longitude,
  });

  it('writes the name once, and only on a stop that still has none', async () => {
    const { service, prisma } = harness({}, { kind: 'BUSINESS', name: 'The Home Depot', address: null });
    prisma.timeSegment.findMany
      .mockResolvedValueOnce([waiting('stop-1')]) // the stops waiting
      .mockResolvedValue([]); // nothing named near it yet

    await expect(service.nameWaiting()).resolves.toEqual({ named: 1, waiting: 1 });

    expect(prisma.timeSegment.updateMany).toHaveBeenCalledWith({
      where: { id: 'stop-1', organizationId: 'org-1', placeNamedAt: null },
      data: expect.objectContaining({ placeKind: 'BUSINESS', placeName: 'The Home Depot', placeNamedAt: expect.any(Date) }),
    });
  });

  it('leaves a stop it could not ask about for the next sweep', async () => {
    const { service, prisma, openStreetMap } = harness();
    openStreetMap.placeAt.mockResolvedValue(undefined);
    prisma.timeSegment.findMany.mockResolvedValueOnce([waiting('stop-1')]).mockResolvedValue([]);

    await expect(service.nameWaiting()).resolves.toEqual({ named: 0, waiting: 1 });
    expect(prisma.timeSegment.updateMany).not.toHaveBeenCalled();
  });

  it('asks only for stops with a position and no name, a few at a time', async () => {
    const { service, prisma } = harness();
    prisma.timeSegment.findMany.mockResolvedValueOnce([]);

    await service.nameWaiting();

    expect(prisma.timeSegment.findMany.mock.calls[0]![0]).toMatchObject({
      where: { category: 'STOP', placeNamedAt: null, placeLatitude: { not: null } },
      take: StopNamingService.BATCH,
    });
  });

  /** It runs from the sweep's cron callback, which must never throw. */
  it('survives the database being unreachable', async () => {
    const { service, prisma } = harness();
    prisma.timeSegment.findMany.mockRejectedValue(new Error('database unreachable'));

    await expect(service.nameWaiting()).resolves.toEqual({ named: 0, waiting: 0 });
  });
});

describe('reading what OpenStreetMap says', () => {
  const answer = (at: { latitude: number; longitude: number }, extra: Record<string, unknown> = {}) => ({
    lat: String(at.latitude),
    lon: String(at.longitude),
    name: 'The Home Depot',
    address: { house_number: '1234', road: 'FM 1960 Road West', city: 'Houston' },
    ...extra,
  });

  it('takes a business near the stop, with its address', () => {
    expect(parseNominatimReverse(answer(north(90)), STORE, 'poi')).toEqual({
      kind: 'BUSINESS',
      name: 'The Home Depot',
      address: '1234 FM 1960 Road West, Houston',
    });
  });

  /** Nominatim always answers with its nearest thing, however far. */
  it('refuses a business too far away to be where they stopped', () => {
    expect(parseNominatimReverse(answer(north(400)), STORE, 'poi')).toBeNull();
  });

  it('refuses a place with no name as a business, and keeps it as an address', () => {
    const unnamed = answer(north(20), { name: '' });

    expect(parseNominatimReverse(unnamed, STORE, 'poi')).toBeNull();
    expect(parseNominatimReverse(unnamed, STORE, 'address')).toEqual({
      kind: 'ADDRESS',
      name: null,
      address: '1234 FM 1960 Road West, Houston',
    });
  });

  it('reads "Unable to geocode" as nothing found', () => {
    expect(parseNominatimReverse({ error: 'Unable to geocode' }, STORE, 'poi')).toBeNull();
  });

  it('formats an address with what it has', () => {
    expect(formatNominatimAddress({ road: 'Main St', town: 'Katy' })).toBe('Main St, Katy');
    expect(formatNominatimAddress({})).toBeNull();
    expect(formatNominatimAddress(null)).toBeNull();
  });
});

describe('asking OpenStreetMap', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.STOP_PLACE_LOOKUP_ENABLED;
  });

  it('sends the position rounded to about ten metres, and says who is asking', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ error: 'Unable to geocode' }) });
    global.fetch = fetch as unknown as typeof global.fetch;

    await new OpenStreetMapPlacesClient().placeAt({ latitude: 29.912345678, longitude: -95.498765432 });

    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    const query = new URL(url).searchParams;
    expect(query.get('lat')).toBe('29.9123');
    expect(query.get('lon')).toBe('-95.4988');
    expect(query.get('layer')).toBe('poi');
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/TexasRentersInspection/);
  }, 10_000);

  it('says it could not ask, rather than that nothing is there, when the service refuses', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 }) as unknown as typeof global.fetch;

    await expect(new OpenStreetMapPlacesClient().placeAt(STORE)).resolves.toBeUndefined();
  });

  it('can be switched off', () => {
    process.env.STOP_PLACE_LOOKUP_ENABLED = 'false';

    expect(new OpenStreetMapPlacesClient().enabled).toBe(false);
  });
});
