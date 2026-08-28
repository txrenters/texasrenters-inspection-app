import type { TechnicianRoute } from '@texasrenters/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TechnicianRouteCard } from './technician-route-card';

/**
 * What the card is allowed to claim.
 *
 * This is the same defect the map roster had, in a component that was missed
 * when the roster was fixed: it gated on `route.stops.length`, which is present
 * whether or not anything was routed. Production showed "1 min driving · 0.0 mi
 * · 1 stops" for a route the planner had correctly refused -- and unlike the
 * roster, offered no explanation at all.
 *
 * The fixtures carry populated stops with empty legs, because that pairing is
 * the bug. A fixture with no stops passes against the broken code.
 */

const STOP = {
  inspectionId: 'inspection-1',
  propertyId: 'building-1',
  propertyName: '1006 Melford Ave',
  addressLine1: '1006 Melford Ave',
  city: 'Pearland',
  latitude: 29.5638,
  longitude: -95.2861,
};

const REFUSED: TechnicianRoute = {
  technicianId: 'tech-1',
  origin: { latitude: 8.48164, longitude: 123.806345, recordedAt: new Date().toISOString() },
  stops: [STOP],
  legs: [],
  totalDistanceMeters: 0,
  totalDurationSeconds: 0,
  unroutable: [],
  geometry: [],
  originOutsideServiceArea: true,
  airTravel: null,
  estimated: true,
};

describe('a route the planner refused', () => {
  it('claims no drive time or distance', () => {
    const { container } = render(<TechnicianRouteCard displayName="Ernie" route={REFUSED} />);
    const text = container.textContent ?? '';

    // The exact strings from the production screenshot.
    expect(text).not.toMatch(/1 min/);
    expect(text).not.toMatch(/0\.0 mi/);
    expect(text).not.toMatch(/driving/);
    expect(text).not.toMatch(/free-flow/);
  });

  it('says why instead', () => {
    render(<TechnicianRouteCard displayName="Ernie" route={REFUSED} />);
    expect(screen.getByText(/not near any road we can route on/i)).toBeInTheDocument();
  });

  it('still lists the day, unnumbered', () => {
    const { container } = render(<TechnicianRouteCard displayName="Ernie" route={REFUSED} />);

    expect(screen.getByText('1006 Melford Ave')).toBeInTheDocument();
    // A numeral beside an unordered stop reads as a sequence somebody chose.
    expect(container.textContent).not.toMatch(/^\s*1\s/m);
  });
});

describe('a route the planner produced', () => {
  const PLANNED: TechnicianRoute = {
    ...REFUSED,
    origin: { latitude: 29.75, longitude: -95.37, recordedAt: new Date().toISOString() },
    legs: [
      { fromStopId: null, toStopId: 'inspection-1', distanceMeters: 20000, durationSeconds: 1200 },
    ],
    totalDistanceMeters: 20000,
    totalDurationSeconds: 1200,
    originOutsideServiceArea: false,
  };

  it('shows the drive, and says one stop is one stop', () => {
    const { container } = render(<TechnicianRouteCard displayName="Ernie" route={PLANNED} />);
    const text = container.textContent ?? '';

    expect(text).toMatch(/20 min/);
    // "1 stops" was in production. Plural agreement is not decoration when the
    // number beside it is the whole content of the sentence.
    // No word boundary after "stop": textContent runs the nodes together, so
    // the real string is "1 stopEstimated from...". The pair of assertions is
    // what pins the plural.
    expect(text).toMatch(/1 stop/);
    expect(text).not.toMatch(/1 stops/);
    expect(text).toMatch(/free-flow/);
  });
});

describe('stops that could not be routed', () => {
  it('distinguishes a missing location from one no road reaches', () => {
    const route: TechnicianRoute = {
      ...REFUSED,
      originOutsideServiceArea: false,
      stops: [],
      unroutable: [
        { inspectionId: 'a', propertyName: 'No Geocode Ln', reason: 'NO_COORDINATES' },
        { inspectionId: 'b', propertyName: 'Gulf Of Mexico Dr', reason: 'OUTSIDE_SERVICE_AREA' },
      ],
    };

    const text = render(<TechnicianRouteCard displayName="Ernie" route={route} />).container
      .textContent;

    // The old copy called both "could not be placed on the map", which is false
    // of an address that placed fine and simply landed in open water.
    expect(text).toMatch(/No Geocode Ln has no location on file/);
    expect(text).toMatch(/Gulf Of Mexico Dr is not near a road/);
  });
});
