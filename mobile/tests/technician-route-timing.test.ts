import { routeTimingNote } from '../src/lib/route-timing';
import { technicianRouteSchema } from '../src/repositories/api/technician-route-schema';

/**
 * The technician's own route, as the handset reads it.
 *
 * Two things went wrong here without anybody seeing either. A route drawn from
 * home carries no position time, and the schema demanded one -- so the whole
 * response was refused and the suggested order vanished until the phone had
 * reported. And the summary said "does not account for traffic" under every
 * route, long after the routes were being timed against it.
 */

const route = (over: Record<string, unknown> = {}) => ({
  technicianId: 'tech',
  origin: { latitude: 29.95, longitude: -95.55, recordedAt: '2026-09-14T14:56:00.000Z' },
  stops: [],
  legs: [],
  totalDistanceMeters: 0,
  totalDurationSeconds: 0,
  unroutable: [],
  ...over,
});

describe('reading a technician route', () => {
  it('accepts a route from home, which has no moment to date', () => {
    const parsed = technicianRouteSchema.safeParse(
      route({
        origin: { latitude: 29.95, longitude: -95.55, recordedAt: null },
        source: 'GOOGLE_TRAFFIC',
      }),
    );

    expect(parsed.success).toBe(true);
  });

  it('carries which router timed the drive', () => {
    expect(technicianRouteSchema.parse(route({ source: 'OSRM_FREE_FLOW' })).source).toBe(
      'OSRM_FREE_FLOW',
    );
  });

  it('still reads a route from a server too old to say which router it used', () => {
    expect(technicianRouteSchema.safeParse(route()).success).toBe(true);
  });
});

describe('what the summary says about the drive times', () => {
  it('says times Google drew include traffic', () => {
    expect(routeTimingNote('GOOGLE_TRAFFIC')).toBe('Includes traffic.');
  });

  it('says free-flow times do not', () => {
    expect(routeTimingNote('OSRM_FREE_FLOW')).toMatch(/does not account for traffic/i);
  });

  it('says nothing it does not know', () => {
    expect(routeTimingNote(null)).toBeNull();
    expect(routeTimingNote(undefined)).toBeNull();
  });
});
