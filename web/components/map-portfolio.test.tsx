import type { PropertyPosition } from '@texasrenters/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OTHER_PROPERTY_YELLOW } from '@/components/map-discs';
import { calmColor } from '@/components/planning/group-file';
import type { PropertyVisit } from '@/lib/day-visits';

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

/** What the reader may do, set by each test that cares. */
const granted = new Set<string>(['inspections:read']);
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (permission: string) => granted.has(permission) }),
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

    // Painted calmed (console-development): the group's own colour, softened.
    expect(fills().get('grouped')).toBe(calmColor('#7f77dd'));
  });

  it('is the Group maker’s green when it is on the package in no group, and yellow when it is off it', () => {
    render(<PortfolioLayers properties={[GROUPED, LOOSE, OTHER]} />);

    expect(fills().get('loose-one')).toBe('#16a34a');
    // The office, 2026-10-02: grey was hard to find on the map.
    expect(fills().get('other-property')).toBe(OTHER_PROPERTY_YELLOW);
  });

  it('gives the yellow disc a dark edge, which a white one would lose on the light map', () => {
    render(<PortfolioLayers properties={[LOOSE, OTHER]} />);

    const edges = screen
      .getAllByTestId('marker')
      .map((marker) => [...marker.querySelectorAll('circle')].find((circle) => circle.getAttribute('fill') !== 'transparent')?.getAttribute('stroke'));
    expect(edges).toEqual(['#fff', '#854d0e']);
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

describe('a property whose inspection is in (the office, 2026-10-02)', () => {
  const visit = (inspectionId: string, finished: boolean): PropertyVisit => ({
    inspectionId,
    inspectionType: 'MOVE_OUT',
    status: finished ? 'TECHNICIAN_SUBMITTED' : 'SCHEDULED',
    finished,
    finishedAt: finished ? '2026-10-02T19:14:00.000Z' : null,
    technicianName: 'A Technician',
  });
  /** The tick is the badge's green check. */
  const ticked = () =>
    new Map(
      screen.getAllByTestId('marker').map((marker) => [
        marker.querySelector('[title]')?.getAttribute('title')?.split(' · ')[0],
        Boolean(marker.querySelector('path[stroke="#15803d"]')),
      ]),
    );

  it('wears a tick once every inspection it had that day is submitted', () => {
    render(
      <PortfolioLayers
        properties={[GROUPED, LOOSE, OTHER]}
        visits={new Map([
          [GROUPED.id, [visit('inspection-1', true)]],
          [OTHER.id, [visit('inspection-2', true)]],
        ])}
      />,
    );

    expect(ticked()).toEqual(
      new Map([
        ['grouped', true],
        ['loose-one', false],
        ['other-property', true],
      ]),
    );
    expect(screen.getByTitle('grouped · Group 12 · Katy North · inspection submitted')).toBeTruthy();
  });

  it('wears none while one of its inspections that day is still to do', () => {
    render(
      <PortfolioLayers
        properties={[LOOSE]}
        visits={new Map([[LOOSE.id, [visit('inspection-1', true), visit('inspection-2', false)]]])}
      />,
    );

    expect(ticked().get('loose-one')).toBe(false);
  });

  it('lists the day’s inspections in its window, each with a button to its details', () => {
    granted.add('inspections:read');
    render(
      <PortfolioLayers
        properties={[LOOSE]}
        selectedPropertyId={LOOSE.id}
        visits={new Map([[LOOSE.id, [visit('inspection-1', true), visit('inspection-2', false)]]])}
      />,
    );

    const links = screen.getAllByRole('link', { name: 'Show inspection details' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/inspections/inspection-1',
      '/inspections/inspection-2',
    ]);
    // A new tab: the map is a live view, and leaving it would lose the day being watched.
    expect(links.every((link) => link.getAttribute('target') === '_blank')).toBe(true);
    expect(screen.getByTestId('popup').textContent).toContain('Move out');
    expect(screen.getByTestId('popup').textContent).toContain('A Technician');
  });

  it('offers no button to somebody who may not read inspections', () => {
    granted.delete('inspections:read');
    render(
      <PortfolioLayers
        properties={[LOOSE]}
        selectedPropertyId={LOOSE.id}
        visits={new Map([[LOOSE.id, [visit('inspection-1', true)]]])}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Show inspection details' })).toBeNull();
    granted.add('inspections:read');
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

describe('what a search is showing (the office, 2026-10-02)', () => {
  /** Whether a disc wears the search ring, and whether it is dimmed, by name. */
  const states = () =>
    new Map(
      screen.getAllByTestId('marker').map((marker) => {
        const holder = marker.querySelector('[title]') as HTMLElement | null;
        return [
          holder?.getAttribute('title')?.split(' · ')[0],
          {
            ringed: Boolean(marker.querySelector('circle[stroke="#0ea5e9"]')),
            dimmed: holder?.style.opacity === '0.25',
          },
        ];
      }),
    );

  it('rings the matches and lets the rest recede', () => {
    render(<PortfolioLayers properties={[GROUPED, LOOSE, OTHER]} searched={new Set([LOOSE.id])} />);

    expect(states()).toEqual(
      new Map([
        ['grouped', { ringed: false, dimmed: true }],
        ['loose-one', { ringed: true, dimmed: false }],
        ['other-property', { ringed: false, dimmed: true }],
      ]),
    );
  });

  it('keeps the selected technician’s stops at full strength beside the matches', () => {
    render(
      <PortfolioLayers
        highlighted={new Set([GROUPED.id])}
        properties={[GROUPED, LOOSE, OTHER]}
        searched={new Set([LOOSE.id])}
      />,
    );

    expect(states().get('grouped')).toEqual({ ringed: false, dimmed: false });
  });

  it('dims nothing when the search shows nothing', () => {
    render(<PortfolioLayers properties={[GROUPED, LOOSE]} searched={new Set()} />);

    expect([...states().values()].every((state) => !state.dimmed && !state.ringed)).toBe(true);
  });

  it('draws a searched property even with the rest of the portfolio turned off', () => {
    render(<PortfolioLayers otherProperties={false} properties={[GROUPED, OTHER]} searched={new Set([OTHER.id])} />);

    expect(states().has('other-property')).toBe(true);
  });
});
