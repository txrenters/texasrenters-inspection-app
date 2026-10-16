import type { TechnicianTrail, TrailStop } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Stops away from the properties on the technician map (the office,
 * 2026-10-17: "if he goes to the hardware store ... show it on the map").
 *
 * What is pinned: every stop the timesheet counts is a pin on the trail, it
 * says what the place was and when in Texas time, Home is only ever "Home",
 * and a name OpenStreetMap gave is credited.
 */

// No WebGL here: a marker is a plain element, clicked as the map would click it.
vi.mock('react-map-gl/mapbox', () => ({
  Layer: () => null,
  Marker: ({
    children,
    onClick,
    style,
  }: {
    children?: React.ReactNode;
    onClick?: (event: { originalEvent: { stopPropagation: () => void } }) => void;
    style?: { zIndex?: number };
  }) => (
    <div
      data-testid="marker"
      data-z={style?.zIndex}
      onClick={() => onClick?.({ originalEvent: { stopPropagation: () => undefined } })}
    >
      {children}
    </div>
  ),
  Popup: ({ children }: { children?: React.ReactNode }) => <div data-testid="popup">{children}</div>,
  Source: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useMap: () => ({ current: undefined }),
}));

const { TrailStopsLayer } = await import('./technician-map');

const stop = (facts: Partial<TrailStop> = {}): TrailStop => ({
  id: 'stop-1',
  // 10:40 and 11:05 in Texas.
  startedAt: '2026-10-16T15:40:00.000Z',
  endedAt: '2026-10-16T16:05:00.000Z',
  durationSeconds: 1_500,
  latitude: 29.9,
  longitude: -95.5,
  kind: 'BUSINESS',
  name: 'The Home Depot',
  address: '1 Supply Rd, Houston',
  ...facts,
});

const trail = (technicianId: string, stops: TrailStop[]): TechnicianTrail => ({
  technicianId,
  segments: [],
  fixes: 0,
  stops,
});

const COLORS = new Map([
  ['tech-1', '#0f766e'],
  ['tech-2', '#7c3aed'],
]);

function mount(trails: TechnicianTrail[], selectedTechnicianId: string | null = null) {
  return render(<TrailStopsLayer colors={COLORS} selectedTechnicianId={selectedTechnicianId} trails={trails} />);
}

describe('stops on the map', () => {
  it('draws a pin for every stop, saying what and when in Texas time', () => {
    mount([trail('tech-1', [stop()]), trail('tech-2', [stop({ id: 'stop-2', name: "Lowe's" })])]);

    expect(screen.getAllByTestId('marker')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Stop: The Home Depot, 10:40 AM – 11:05 AM' })).toBeInTheDocument();
  });

  it('opens what the stop was, for how long, and credits the name', () => {
    mount([trail('tech-1', [stop()])]);

    fireEvent.click(screen.getByTestId('marker'));

    const popup = screen.getByTestId('popup');
    expect(popup).toHaveTextContent('The Home Depot');
    expect(popup).toHaveTextContent('1 Supply Rd, Houston');
    expect(popup).toHaveTextContent('10:40 AM – 11:05 AM · 25 min');
    expect(popup).toHaveTextContent('© OpenStreetMap contributors');
  });

  it('calls a stop at home "Home", with no address and nothing to credit', () => {
    mount([trail('tech-1', [stop({ kind: 'HOME', name: 'Home', address: null })])]);

    fireEvent.click(screen.getByTestId('marker'));

    const popup = screen.getByTestId('popup');
    expect(popup).toHaveTextContent('Home');
    expect(popup).not.toHaveTextContent('OpenStreetMap');
  });

  it('says a stop is still being looked up rather than showing nothing', () => {
    mount([trail('tech-1', [stop({ kind: null, name: null, address: null })])]);

    expect(screen.getByRole('img', { name: /Finding the place/ })).toBeInTheDocument();
  });

  /** Like the trails: somebody else's day steps back while one person is read. */
  it('recedes everybody else’s stops while one technician is picked', () => {
    mount([trail('tech-1', [stop()]), trail('tech-2', [stop({ id: 'stop-2' })])], 'tech-1');

    const [mine, theirs] = screen.getAllByTestId('marker');
    expect(mine!.querySelector('svg')).toHaveAttribute('opacity', '1');
    expect(theirs!.querySelector('svg')).toHaveAttribute('opacity', '0.45');
    expect(mine!.querySelector('rect')).toHaveAttribute('fill', '#0f766e');
  });

  it('draws nothing for a trail from before stops were counted', () => {
    mount([{ technicianId: 'tech-1', segments: [], fixes: 0 }]);

    expect(screen.queryByTestId('marker')).toBeNull();
  });
});
