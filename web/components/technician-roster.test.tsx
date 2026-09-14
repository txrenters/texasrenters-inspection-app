import type {
  AssignedStop,
  RemainderProjection,
  TechnicianDayTimeline,
  TechnicianRoute,
} from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TechnicianRoster, type RosterEntry } from './technician-roster';

/**
 * What the panel is allowed to claim.
 *
 * The bug these exist for: the planner correctly refused to route a technician
 * whose position was off the road network, and the panel printed the refusal
 * *and* "1 min driving - 0.0 km - suggested order" directly beneath it, with
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
  finishedAt: null,
};

const SECOND_STOP: AssignedStop = {
  inspectionId: 'inspection-2',
  buildingId: 'building-2',
  propertyName: '10103 Mariposa Green Ct',
  inspectionType: 'MOVE_OUT',
  status: 'SCHEDULED',
  finishedAt: null,
};

/** A day's timeline around a projection, with nothing else in it but what a test sets. */
const timelineOf = (
  projectionValue: RemainderProjection,
  stops: TechnicianDayTimeline['stops'] = [],
): TechnicianDayTimeline => ({
  technicianId: 'tech-1',
  segments: [],
  totals: { onSiteSeconds: 0, travellingSeconds: 0, shiftSeconds: 0, visits: 0 },
  projection: projectionValue,
  stops,
  untimedInspectionIds: [],
});

/** A day's projection with nothing in it but what a test sets. */
const projection = (over: Partial<RemainderProjection>): RemainderProjection => ({
  projectedFinishAt: null,
  remainingSeconds: 0,
  stopsRemaining: 0,
  perVisitSeconds: 40 * 60,
  basis: 'ESTIMATED',
  current: null,
  arrivals: [],
  ...over,
});

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
  originKind: 'LIVE',
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
  history: { stops: [], geometry: [] },
  originOutsideServiceArea: true,
  airTravel: null,
  source: null,
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
    expect(text).not.toMatch(/0\.0 km/);
  });
});

describe('a route the planner produced', () => {
  const PLANNED: TechnicianRoute = {
    technicianId: 'tech-1',
    origin: { latitude: 29.75, longitude: -95.37, recordedAt: new Date().toISOString() },
    originKind: 'LIVE',
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
    history: { stops: [], geometry: [] },
    originOutsideServiceArea: false,
    airTravel: null,
    // The free-flow fallback: the one kind of route the caveat is true of.
    source: 'OSRM_FREE_FLOW',
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

  it('keeps a finished stop on the list, greyed, with when it was done and how long it took', () => {
    const DONE: AssignedStop = {
      inspectionId: 'inspection-done',
      buildingId: 'building-done',
      propertyName: '3925 Tulane Oak Drive',
      inspectionType: 'OCCUPIED',
      status: 'TECHNICIAN_SUBMITTED',
      // 16:40 UTC is 11:40 AM in Texas.
      finishedAt: '2026-09-14T16:40:00.000Z',
    };
    const { container } = render(
      <TechnicianRoster
        entries={entries([DONE, STOP, SECOND_STOP])}
        onSelect={() => {}}
        route={PLANNED}
        selectedId="tech-1"
        timeline={timelineOf(projection({}), [
          {
            buildingId: 'building-done',
            propertyName: '3925 Tulane Oak Drive',
            inspectionIds: ['inspection-done'],
            onSiteSeconds: 42 * 60,
            driveToSeconds: 12 * 60,
          },
        ])}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toMatch(/Done 11:40 AM/);
    expect(text).toMatch(/12 min drive · 42 min on site · 54 min total/);
    // The day's history, added up.
    expect(text).toMatch(/1 done · 54 min total · 12 min driving · 42 min on site/);
    // The person's row counts what is done out of the whole day.
    expect(text).toMatch(/1\/3 done/);
    // Listed first, before anything still to do.
    expect(text.indexOf('Tulane Oak')).toBeLessThan(text.indexOf('Mariposa'));
  });

  it('shows each visit as the app recorded it: Start to Submit, and the drive between', () => {
    // 14:55Z is 9:55 AM in Texas. The trail would have estimated these; the
    // office asked for the inspections' own times.
    const OAK: AssignedStop = {
      inspectionId: 'inspection-oak',
      buildingId: 'building-oak',
      propertyName: '4226 Oak Shadows',
      inspectionType: 'OCCUPIED',
      status: 'TECHNICIAN_SUBMITTED',
      finishedAt: '2026-09-14T15:24:00.000Z',
      startedAt: '2026-09-14T14:55:00.000Z',
      submittedAt: '2026-09-14T15:24:00.000Z',
    };
    const CHAMBOARD: AssignedStop = {
      ...OAK,
      inspectionId: 'inspection-chamboard',
      buildingId: 'building-chamboard',
      propertyName: '1150 chamboard',
      finishedAt: '2026-09-14T15:42:00.000Z',
      startedAt: '2026-09-14T15:32:00.000Z',
      submittedAt: '2026-09-14T15:42:00.000Z',
    };
    const { container } = render(
      <TechnicianRoster
        entries={entries([OAK, CHAMBOARD, STOP])}
        onSelect={() => {}}
        route={PLANNED}
        selectedId="tech-1"
        timeline={timelineOf(projection({}))}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toMatch(/Done 10:24 AMStarted 9:55 AM/);
    expect(text).toMatch(/8 min drive from 4226 Oak Shadows · 10 min on site/);
    expect(text).toMatch(/2 done · 39 min on site · 8 min driving · 47 min total/);
    expect(text).toMatch(/Start to Submit in the app/);
    expect(text).toMatch(/Texas time/);
  });

  it('marks the next stop, and says where the technician is', () => {
    render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        route={PLANNED}
        selectedId="tech-1"
        timeline={timelineOf(
          projection({
            current: {
              placeId: 'building-2',
              inspectionIds: ['inspection-2'],
              arrivedAt: '2026-09-14T14:38:00.000Z',
              onSiteSeconds: 600,
              remainingSeconds: 1800,
            },
          }),
        )}
      />,
    );

    // At the first stop in the route, so the second is next.
    expect(screen.getByText(/At 10103 Mariposa Green Ct/)).toBeInTheDocument();
    expect(screen.getByText('Next')).toBeInTheDocument();
    expect(screen.getByText('10342 Mist Ln').parentElement?.className).toMatch(/text-map-technician/);
  });

  it('says the times include traffic when Google drew the route', () => {
    // The caveat sat under every route, including every one Google had timed
    // against traffic -- which in production was all of them.
    const { container } = render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        route={{ ...PLANNED, source: 'GOOGLE_TRAFFIC' }}
        selectedId="tech-1"
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toMatch(/drive times include traffic/i);
    expect(text).not.toMatch(/speed limits/i);
    expect(text).not.toMatch(/without traffic/i);
  });

  it('says nothing about the times when it cannot tell which router drew them', () => {
    const { container } = render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        route={{ ...PLANNED, source: null }}
        selectedId="tech-1"
      />,
    );

    expect(container.textContent).not.toMatch(/traffic/i);
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

  it('shows how long they have been at the stop under way, not a drive to it', () => {
    /**
     * The live map, 14 September: the stop Moses was twenty-nine minutes into
     * showed a drive and an arrival time, as though he had yet to get there.
     */
    const { container } = render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        timeline={timelineOf(projection({
          current: {
            placeId: 'building-2',
            inspectionIds: ['inspection-2'],
            arrivedAt: '2026-09-14T14:38:00.000Z',
            onSiteSeconds: 29 * 60,
            remainingSeconds: 11 * 60,
          },
        }))}
        route={PLANNED}
        selectedId="tech-1"
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toMatch(/on site 29 min/);
    // Not the twenty minutes of driving the route drew to it.
    expect(text).not.toMatch(/20 min/);
  });

  it('gives a stop ahead its arrival in Texas time', () => {
    const { container } = render(
      <TechnicianRoster
        entries={entries([STOP, SECOND_STOP])}
        onSelect={() => {}}
        timeline={timelineOf(projection({
          arrivals: [
            { inspectionId: 'inspection-2', arriveAt: '2026-09-14T15:25:00.000Z', driveSeconds: 1200 },
          ],
        }))}
        route={PLANNED}
        selectedId="tech-1"
      />,
    );

    // 15:25 UTC is 10:25 AM in Texas in September, whatever zone this runs in.
    expect(container.textContent).toMatch(/10:25 AM/);
  });
});

/**
 * Taking the map to one stop.
 *
 * The panel listed the day as plain text, so a dispatcher reading "21538 Duke
 * Alexander" had no way to find it among five hundred and forty-eight property
 * pins. Selecting a stop moves the map to it -- while leaving the technician
 * selected, which is what keeps their round highlighted and their route drawn.
 */
describe('choosing a stop', () => {
  it('reports the building, so the map can move to it', () => {
    const onSelectStop = vi.fn();
    render(
      <TechnicianRoster
        entries={entries([STOP])}
        onSelect={() => {}}
        onSelectStop={onSelectStop}
        selectedId="tech-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /10342 Mist Ln/ }));
    expect(onSelectStop).toHaveBeenCalledWith('building-1');
  });

  it('clears the focus when the shown stop is chosen again', () => {
    // The way out is the same control as the way in, matching how selecting a
    // technician already works.
    const onSelectStop = vi.fn();
    render(
      <TechnicianRoster
        entries={entries([STOP])}
        onSelect={() => {}}
        onSelectStop={onSelectStop}
        selectedId="tech-1"
        selectedStopBuildingId="building-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /10342 Mist Ln/ }));
    expect(onSelectStop).toHaveBeenCalledWith(null);
  });

  it('leaves a stop with no building unpressable', () => {
    // It says "not on the map" already. Making it look like a control and then
    // doing nothing is worse than leaving it plain.
    const onSelectStop = vi.fn();
    render(
      <TechnicianRoster
        entries={entries([{ ...STOP, buildingId: null }])}
        onSelect={() => {}}
        onSelectStop={onSelectStop}
        selectedId="tech-1"
      />,
    );

    expect(screen.queryByRole('button', { name: /10342 Mist Ln/ })).toBeNull();
    expect(screen.getByText(/not on the map/)).toBeTruthy();
  });

  it('still lists the stops when no handler is supplied', () => {
    // The prop is optional; the panel is used without it in tests and could be
    // elsewhere, and losing the day's work would be the worse failure.
    render(<TechnicianRoster entries={entries([STOP])} onSelect={() => {}} selectedId="tech-1" />);
    expect(screen.getByText('10342 Mist Ln')).toBeTruthy();
  });

  it('shows the inspection type for each stop', () => {
    render(<TechnicianRoster entries={entries([STOP])} onSelect={() => {}} selectedId="tech-1" />);
    expect(screen.getByText(/Move in/)).toBeTruthy();
  });
});

describe('a technician working with a stalled location', () => {
  it('reads as the app open with the location paused, not as a last report hours ago', () => {
    // 16:02 UTC is 11:02 AM in Texas. Two and a half hours of submitted
    // inspections later, the row used to say only "2 hours ago".
    const working: RosterEntry = {
      ...entries([STOP])[0],
      position: {
        technicianId: 'tech-1',
        latitude: 29.9,
        longitude: -95.5,
        recordedAt: '2026-09-14T16:02:19.000Z',
        app: { connected: true, lastSeenAt: new Date().toISOString() },
      } as RosterEntry['position'],
    };

    render(<TechnicianRoster entries={[working]} onSelect={() => {}} selectedId={null} />);

    expect(screen.getByText(/App open · location paused since 11:02 AM/)).toBeInTheDocument();
  });
});
