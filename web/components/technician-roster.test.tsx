import type { AssignedStop, TechnicianRoute } from '@texasrenters/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TechnicianRoster, type RosterEntry } from './technician-roster';

/**
 * What the panel is allowed to claim.
 *
 * The bug these exist for: the planner correctly refused to route a technician
 * whose position was off the road network, and the panel printed the refusal
 * *and* "1 min driving - 0.0 mi - suggested order" directly beneath it, with
 * the stop numbered. Two contradictory statements, one of them invented.
 *
 * The cause was reading `route.stops` as "a route exists". Stops are the day's
 * work and are returned whether or not anything was planned. So these assert on
 * the pairing -- what must be absent when the refusal is shown -- rather than
 * only that the refusal appears, which the broken version would also have
 * passed.
 */

const STOP: AssignedStop = {
  inspectionId: 'inspection-1',
  buildingId: 'building-1',
  propertyName: '10342 Mist Ln',
  inspectionType: 'MOVE_IN',
  status: 'SCHEDULED',
};

const SECOND_STOP: AssignedStop = {
  inspectionId: 'inspection-2',
  buildingId: 'building-2',
  propertyName: '10103 Mariposa Green Ct',
  inspectionType: 'MOVE_OUT',
  status: 'SCHEDULED',
};

function entries(stops: AssignedStop[]): RosterEntry[] {
  return [
    {
      technicianId: 'tech-1',
      displayName: 'Ernie Saavedra',
      stops,
      position: {
        technicianId: 'tech-1',
        latitude: 8.48164,
        longitude: 123.806345,
        recordedAt: new Date().toISOString(),
      } as RosterEntry['position'],
    },
  ];
}

/**
 * Exactly what the planner returns when it refuses.
 *
 * `stops` is **populated** and `legs` is empty. That pairing is the whole point
 * of the fixture: the planner hands back the day's work even when it will not
 * order it, so a fixture with `stops: []` would pass against the broken code
 * and prove nothing.
 */
const REFUSED: TechnicianRoute = {
  technicianId: 'tech-1',
  origin: { latitude: 8.48164, longitude: 123.806345, recordedAt: new Date().toISOString() },
  stops: [
    {
      inspectionId: 'inspection-1',
      propertyId: 'building-1',
      propertyName: '10342 Mist Ln',
      addressLine1: '10342 Mist Ln',
      city: 'Houston',
      latitude: 29.958784,
      longitude: -95.574255,
    },
  ],
  legs: [],
  totalDistanceMeters: 0,
  totalDurationSeconds: 0,
  unroutable: [],
  geometry: [],
  originOutsideServiceArea: true,
  estimated: true,
};

describe('a route the planner refused', () => {
  it('says why, and claims nothing else', () => {
    render(
      <TechnicianRoster
        entries={entries([STOP])}
        onSelect={() => {}}
        route={REFUSED}
        selectedId="tech-1"
      />,
    );

    expect(screen.getByText(/no suggested order/i)).toBeInTheDocument();

    // The three things that must not appear beside it. Each of these rendered
    // in the broken version, because each was gated on `stops.length`.
    expect(screen.queryByText(/suggested order$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/driving/)).not.toBeInTheDocument();
    expect(screen.queryByText(/estimated from speed limits/i)).not.toBeInTheDocument();

    // The work is still listed -- refusing to order a day is not refusing to
    // show it.
    expect(screen.getByText('10342 Mist Ln')).toBeInTheDocument();
  });

  it('does not number stops it has not put in an order', () => {
    render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        route={REFUSED}
        selectedId="tech-1"
      />,
    );

    // A numeral beside a stop reads as a position in a recommended sequence.
    // With nothing planned there is no sequence, so there must be no numeral.
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it('never shows a refusal and a drive time together', () => {
    // The specific contradiction from the screenshot: a zero total formatted
    // as "1 min", because `formatDuration` floors at one minute.
    const { container } = render(
      <TechnicianRoster
        entries={entries([STOP])}
        onSelect={() => {}}
        route={REFUSED}
        selectedId="tech-1"
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toMatch(/no suggested order/i);
    expect(text).not.toMatch(/1 min/);
    expect(text).not.toMatch(/0\.0 mi/);
  });
});

describe('a route the planner produced', () => {
  const PLANNED: TechnicianRoute = {
    technicianId: 'tech-1',
    origin: { latitude: 29.75, longitude: -95.37, recordedAt: new Date().toISOString() },
    stops: [
      {
        inspectionId: 'inspection-2',
        propertyId: 'building-2',
        propertyName: '10103 Mariposa Green Ct',
        addressLine1: '10103 Mariposa Green Ct',
        city: 'Houston',
        latitude: 29.866277,
        longitude: -95.200871,
      },
      {
        inspectionId: 'inspection-1',
        propertyId: 'building-1',
        propertyName: '10342 Mist Ln',
        addressLine1: '10342 Mist Ln',
        city: 'Houston',
        latitude: 29.958784,
        longitude: -95.574255,
      },
    ],
    legs: [
      { fromStopId: null, toStopId: 'inspection-2', distanceMeters: 20000, durationSeconds: 1200 },
      {
        fromStopId: 'inspection-2',
        toStopId: 'inspection-1',
        distanceMeters: 46068,
        durationSeconds: 2471,
      },
    ],
    totalDistanceMeters: 66068,
    totalDurationSeconds: 3671,
    unroutable: [],
    geometry: [[29.75, -95.37]],
    originOutsideServiceArea: false,
    estimated: true,
  };

  it('shows the order, the total and the estimate caveat', () => {
    const { container } = render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        route={PLANNED}
        selectedId="tech-1"
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toMatch(/1 hr 1 min/);
    expect(text).toMatch(/suggested order/);
    expect(text).toMatch(/estimated from speed limits/i);
    expect(text).not.toMatch(/no suggested order/i);
  });

  it('lists the stops in the order the route recommends, not alphabetically', () => {
    // `entries` is given Mist Ln first; the route puts Mariposa first. The
    // panel must follow the route, or the numerals label the wrong properties.
    const { container } = render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        route={PLANNED}
        selectedId="tech-1"
      />,
    );

    const text = container.textContent ?? '';
    expect(text.indexOf('Mariposa')).toBeLessThan(text.indexOf('Mist Ln'));
  });
});
