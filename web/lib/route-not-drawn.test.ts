import { describe, expect, it } from 'vitest';

import { routeNotDrawn, timingNote, withoutLocation } from './route-plan';

/**
 * A route that could not be drawn says so.
 *
 * On 2 October the map showed Moses at a property with three stops left, every
 * one with a coordinate, and no line to any of them -- and nothing anywhere to
 * say the routing services had not answered. These are what the panel now
 * reads to tell that apart from a day with nothing left to drive.
 */

const stop = (inspectionId: string) => ({
  inspectionId,
  propertyId: inspectionId,
  propertyName: inspectionId,
  addressLine1: '',
  city: '',
  latitude: 29.8,
  longitude: -95.4,
});

const route = (over: Record<string, unknown>) =>
  ({
    technicianId: 't',
    origin: { latitude: 29.9, longitude: -95.5, recordedAt: null },
    originKind: 'LIVE',
    stops: [stop('a'), stop('b')],
    legs: [],
    unroutable: [],
    originOutsideServiceArea: false,
    source: null,
    ...over,
  }) as never;

const leg = { fromStopId: null, toStopId: 'a', distanceMeters: 1000, durationSeconds: 120 };

describe('a route that could not be drawn', () => {
  it('is one with a start, stops to reach and no drive', () => {
    expect(routeNotDrawn(route({}))).toBe(true);
  });

  it('is not one that drew', () => {
    expect(routeNotDrawn(route({ legs: [leg], source: 'MAPBOX_FREE_FLOW' }))).toBe(false);
  });

  it('is not a day with nothing left to drive, or nowhere to start from', () => {
    expect(routeNotDrawn(route({ stops: [] }))).toBe(false);
    expect(routeNotDrawn(route({ origin: null }))).toBe(false);
    expect(routeNotDrawn(null)).toBe(false);
  });

  it('is not a refusal, which the panel already explains', () => {
    expect(routeNotDrawn(route({ originOutsideServiceArea: true }))).toBe(false);
  });
});

describe('stops with no location on file', () => {
  it('are the ones the route left out for having no coordinate', () => {
    const unplaced = withoutLocation(
      route({
        unroutable: [
          { inspectionId: 'x', propertyName: 'x', reason: 'NO_COORDINATES' },
          { inspectionId: 'y', propertyName: 'y', reason: 'OUTSIDE_SERVICE_AREA' },
        ],
      }),
    );
    expect([...unplaced]).toEqual(['x']);
  });
});

describe('what the drive times are', () => {
  it('calls a Mapbox route what it is: speed limits, no traffic', () => {
    expect(timingNote(route({ legs: [leg], source: 'MAPBOX_FREE_FLOW' }))).toBe(
      'Estimated from speed limits, without traffic.',
    );
  });
});
