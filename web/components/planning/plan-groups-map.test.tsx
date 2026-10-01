import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DayStop } from './plan-day-groups';
import type * as RoadRoutes from './road-routes';

/**
 * The quarter's Groups tab, drawn as the Group maker draws a template (the
 * office, 2026-10-01): the days on the maker's map, and the maker's list of
 * them beside it, which is both the legend and the filter.
 */

// No WebGL here: the map is a list of the days it was given, each badge a button as on the map.
vi.mock('./group-file-map', () => ({
  GroupFileMap: ({
    groups,
    onPickGroup,
    ungrouped,
  }: {
    groups: { key: string; label: string }[];
    onPickGroup?: (key: string) => void;
    ungrouped: unknown[];
  }) => (
    <div data-testid="map">
      {groups.map((group) => (
        <button key={group.key} onClick={() => onPickGroup?.(group.key)} type="button">
          badge {group.label}
        </button>
      ))}
      <span data-testid="no-day">{ungrouped.length}</span>
    </div>
  ),
}));
// No Mapbox either: the roads never arrive, and the list keeps its straight-line figures.
vi.mock('./road-routes', async (actual) => ({
  ...(await actual<typeof RoadRoutes>()),
  useRoadRoutes: () => new Map(),
}));
vi.mock('@/components/console-map', () => ({
  MapUnavailable: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

const { PlanGroupsMap } = await import('./plan-groups-map');

const MOSES = { id: 'tech-moses', displayName: 'Moses Rodriguez' };

const stop = (id: string, scheduledOn: string | null, positionInDay: number | null): DayStop => ({
  id,
  latitude: 29.76 + Number(id.replace(/\D/g, '')) / 1000,
  longitude: -95.37,
  scheduledOn,
  positionInDay,
  technician: scheduledOn ? MOSES : null,
  zone: '2',
  address: `${id} Main St`,
  unit: null,
  city: 'Houston',
  postalCode: '77044',
  lease: null,
  hvacPlan: null,
});

const QUARTER = [
  stop('s1', '2026-10-06', 1),
  stop('s2', '2026-10-06', 2),
  stop('s3', '2026-10-07', 1),
  stop('s4', null, null),
];

describe('the Groups tab', () => {
  it('draws every day, and lists them as days', () => {
    render(<PlanGroupsMap stops={QUARTER} />);

    expect(screen.getAllByRole('button', { name: /^badge/ })).toHaveLength(2);
    expect(screen.getByText('All 2 days')).toBeTruthy();
    expect(screen.getByText('Oct 6 · Moses Rodriguez')).toBeTruthy();
  });

  it('says how many visits have no day yet, and draws them', () => {
    render(<PlanGroupsMap stops={QUARTER} />);

    expect(screen.getByText(/3 visits over 2 days · 1 with no day yet/)).toBeTruthy();
    expect(screen.getByTestId('no-day').textContent).toBe('1');
  });

  it('shows only the day whose badge is clicked, until asked for all of them', () => {
    render(<PlanGroupsMap stops={QUARTER} />);

    fireEvent.click(screen.getByRole('button', { name: 'badge 2' }));
    expect(screen.getAllByRole('button', { name: /^badge/ })).toHaveLength(1);
    expect(screen.getByText('1 of 2 days')).toBeTruthy();
    // A day picked out is read on its own: the visits with no day step back.
    expect(screen.getByTestId('no-day').textContent).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByRole('button', { name: /^badge/ })).toHaveLength(2);
  });

  it('says so plainly when no visit has a day yet', () => {
    render(<PlanGroupsMap stops={[stop('s9', null, null)]} />);

    expect(screen.getByText('No visit in this quarter has a day yet, so there are no days to draw.')).toBeTruthy();
    expect(screen.queryByTestId('map')).toBeNull();
  });
});
