import type { PropertyPosition } from '@texasrenters/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Every property on the console's maps, as the Group maker draws it.
 *
 * The office (2026-10-01): the Group maker's map is the better one, its
 * property markers above all, and the technician map should draw every active
 * property that way -- not only the benefit-package ones the Group maker shows,
 * and with no count badges at any zoom.
 */

// No WebGL here: each marker is drawn as a plain element carrying what the map would be told.
vi.mock('react-map-gl/mapbox', () => ({
  Layer: () => null,
  Marker: ({
    children,
    offset,
    style,
  }: {
    children?: React.ReactNode;
    offset?: [number, number];
    style?: { zIndex?: number };
  }) => (
    <div data-offset={offset ? offset.join(',') : ''} data-testid="marker" data-z={style?.zIndex}>
      {children}
    </div>
  ),
  Popup: ({ children }: { children?: React.ReactNode }) => <div data-testid="popup">{children}</div>,
  Source: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useMap: () => ({ current: undefined }),
}));

const { PortfolioLayers } = await import('./map-portfolio');

const property = (id: string, facts: Partial<PropertyPosition> = {}): PropertyPosition => ({
  id,
  name: id,
  addressLine1: `${id} Street`,
  city: 'Houston',
  state: 'TX',
  postalCode: '77044',
  latitude: 29.86 + Number(id.length) / 1000,
  longitude: -95.2,
  geocodePrecision: 'ROOFTOP',
  enterRadiusMeters: 40,
  exitRadiusMeters: 80,
  geofenceMoved: false,
  isDemo: false,
  ...facts,
});

const GROUPED = property('grouped', {
  tbpEnrolled: true,
  tbpGroup: { position: 12, name: 'Katy North', color: '#7f77dd' },
});
const LOOSE = property('loose-one', { tbpEnrolled: true, tbpGroup: null });
const OTHER = property('other-property', { tbpEnrolled: false, tbpGroup: null });

/** The colour each property's disc is filled with, by the property's name. */
function fills() {
  return new Map(
    screen.getAllByTestId('marker').map((marker) => {
      const title = marker.querySelector('[title]')?.getAttribute('title') ?? '';
      const disc = [...marker.querySelectorAll('circle')].find((circle) => circle.getAttribute('fill') !== 'transparent');
      return [title.split(' · ')[0], disc?.getAttribute('fill')];
    }),
  );
}

describe('a property on the map', () => {
  it('is a disc of its own, with no count badge however close the others are', () => {
    render(<PortfolioLayers properties={[GROUPED, LOOSE, OTHER]} />);

    expect(screen.getAllByTestId('marker')).toHaveLength(3);
  });

  it('is drawn in its group’s colour, as in the Group maker', () => {
    render(<PortfolioLayers properties={[GROUPED, LOOSE, OTHER]} />);

    expect(fills().get('grouped')).toBe('#7f77dd');
  });

  it('is the Group maker’s green when it is on the package in no group, and grey when it is off it', () => {
    render(<PortfolioLayers properties={[GROUPED, LOOSE, OTHER]} />);

    expect(fills().get('loose-one')).toBe('#16a34a');
    expect(fills().get('other-property')).toBe('#78716c');
  });

  it('says its group when hovered', () => {
    render(<PortfolioLayers properties={[GROUPED]} />);

    expect(screen.getByTitle('grouped · Group 12 · Katy North')).toBeTruthy();
  });

  it('stands over the rest when it is work to plan', () => {
    render(<PortfolioLayers properties={[GROUPED, LOOSE, OTHER]} />);

    const z = screen.getAllByTestId('marker').map((marker) => Number(marker.dataset.z));
    expect(z).toEqual([100, 95, 90]);
  });
});

describe('two properties at one spot', () => {
  it('are fanned out, so the one underneath can still be clicked', () => {
    const twin = { ...LOOSE, id: 'twin', name: 'twin', latitude: GROUPED.latitude, longitude: GROUPED.longitude };

    render(<PortfolioLayers properties={[GROUPED, twin]} />);

    const offsets = screen.getAllByTestId('marker').map((marker) => marker.dataset.offset);
    expect(offsets.every(Boolean)).toBe(true);
    expect(new Set(offsets).size).toBe(2);
  });
});

describe('leaving the rest of the portfolio off', () => {
  it('draws only the benefit package', () => {
    render(<PortfolioLayers otherProperties={false} properties={[GROUPED, LOOSE, OTHER]} />);

    expect([...fills().keys()].sort()).toEqual(['grouped', 'loose-one']);
  });

  it('keeps a property the page is about, whatever it is', () => {
    render(
      <PortfolioLayers highlighted={new Set([OTHER.id])} otherProperties={false} properties={[GROUPED, OTHER]} />,
    );

    expect(fills().has('other-property')).toBe(true);
  });

  it('keeps a property nobody has said is off the package', () => {
    // A reader without `planning:read` is told nothing about the package, which
    // is not the same as being told no.
    const unknown = property('unknown');

    render(<PortfolioLayers otherProperties={false} properties={[unknown]} />);

    expect(screen.getAllByTestId('marker')).toHaveLength(1);
  });
});
