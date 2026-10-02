import type { AdminInspection, PropertyPosition } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "+ Add visit" in the technician map's roster (the office, 2026-10-02): the
 * day's unassigned visits, a search over every property, and the map shown what
 * the panel is showing as it is typed.
 */

const unassigned = vi.hoisted(() => ({ items: [] as Partial<AdminInspection>[] }));
vi.mock('@/lib/queries', () => ({
  useUnassignedOnDay: (_date: string, enabled: boolean) =>
    enabled
      ? { data: { items: unassigned.items }, isLoading: false, isError: false }
      : { data: undefined, isLoading: false, isError: false },
}));

const { AddVisitPanel, matchesSearch } = await import('./add-visit-panel');

const property = (id: string, name: string, city = 'Testville'): PropertyPosition => ({
  id,
  name,
  addressLine1: name,
  city,
  state: 'TX',
  postalCode: '00000',
  latitude: 29.8,
  longitude: -95.4,
  geocodePrecision: 'ROOFTOP',
  enterRadiusMeters: 40,
  exitRadiusMeters: 80,
  geofenceMoved: false,
  isDemo: false,
});

const PROPERTIES = [
  property('p1', '100 Example Way'),
  property('p2', '200 Sample Street', 'Elsewhere'),
  property('p3', '300 Example Court'),
];

function renderPanel(over: Partial<Parameters<typeof AddVisitPanel>[0]> = {}) {
  const props = {
    canAssign: true,
    canCreate: true,
    date: '2026-10-02',
    dateLabel: 'Fri, Oct 2',
    onAssign: vi.fn(async () => undefined),
    onClose: vi.fn(),
    onFocusProperty: vi.fn(),
    onSearchChange: vi.fn(),
    properties: PROPERTIES,
    technicianId: 'tech-1',
    technicianName: 'A Technician',
    ...over,
  };
  const view = render(<AddVisitPanel {...props} />);
  return { ...view, props };
}

beforeEach(() => {
  unassigned.items = [
    {
      id: 'visit-1',
      status: 'SCHEDULED',
      inspectionType: 'OCCUPIED',
      propertywareBuilding: { id: 'p2', name: '200 Sample Street', addressLine1: '200 Sample Street', city: 'Elsewhere', state: 'TX' },
    },
    {
      id: 'visit-2',
      status: 'TECHNICIAN_SUBMITTED',
      inspectionType: 'MOVE_OUT',
      propertywareBuilding: { id: 'p1', name: '100 Example Way', addressLine1: '100 Example Way', city: 'Testville', state: 'TX' },
    },
  ];
});

describe('matchesSearch', () => {
  it('finds every word typed, anywhere, ignoring case and punctuation', () => {
    expect(matchesSearch('12 Example Mill Rd, Testville', 'mill testville')).toBe(true);
    expect(matchesSearch('12 Example-Mill Rd.', 'example mill')).toBe(true);
    expect(matchesSearch('12 Example Mill Rd', 'example meadow')).toBe(false);
    expect(matchesSearch('anything', '  ')).toBe(false);
  });
});

describe('the day’s unassigned visits', () => {
  it('lists the ones still to do and assigns one with a click', async () => {
    const { props } = renderPanel();

    // The submitted one has no day left to be added to.
    expect(screen.queryByText('100 Example Way')).not.toBeInTheDocument();
    const row = screen.getByText('200 Sample Street').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Assign' }));

    await waitFor(() => expect(props.onAssign).toHaveBeenCalledWith('visit-1'));
  });

  it('are shown on the map as soon as the panel opens', () => {
    const { props } = renderPanel();

    expect(props.onSearchChange).toHaveBeenLastCalledWith(['p2']);
  });

  it('are not offered to somebody who may not assign', () => {
    renderPanel({ canAssign: false });

    expect(screen.queryByText(/unassigned that day/i)).not.toBeInTheDocument();
  });
});

describe('searching for a property', () => {
  it('lists the matches, shows them all on the map, and opens a prefilled form in a new tab', () => {
    const { props } = renderPanel({ canAssign: false });

    fireEvent.change(screen.getByPlaceholderText('Search a property or an address'), { target: { value: 'example' } });

    expect(props.onSearchChange).toHaveBeenLastCalledWith(['p1', 'p3']);
    const links = screen.getAllByRole('link', { name: /new visit/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('target', '_blank');
    const href = new URL(links[0]!.getAttribute('href')!, 'https://console.example');
    expect(href.pathname).toBe('/inspections/new');
    expect(Object.fromEntries(href.searchParams)).toEqual({
      propertyId: 'p1',
      technicianId: 'tech-1',
      date: '2026-10-02',
    });
  });

  it('takes the map to a property picked from the list', () => {
    const { props } = renderPanel({ canAssign: false });

    fireEvent.change(screen.getByPlaceholderText('Search a property or an address'), { target: { value: 'court' } });
    fireEvent.click(screen.getByRole('button', { name: /300 Example Court/ }));

    expect(props.onFocusProperty).toHaveBeenCalledWith('p3');
  });

  it('narrows the unassigned visits too', () => {
    const { props } = renderPanel();

    fireEvent.change(screen.getByPlaceholderText('Search a property or an address'), { target: { value: 'court' } });

    expect(screen.queryByText('200 Sample Street')).not.toBeInTheDocument();
    expect(props.onSearchChange).toHaveBeenLastCalledWith(['p3']);
  });

  it('offers no new visit to somebody who may not create one', () => {
    renderPanel({ canCreate: false });

    fireEvent.change(screen.getByPlaceholderText('Search a property or an address'), { target: { value: 'example' } });

    expect(screen.queryByRole('link', { name: /new visit/i })).not.toBeInTheDocument();
  });
});

it('lets go of the map when it closes', () => {
  const { props, unmount } = renderPanel();

  unmount();

  expect(props.onSearchChange).toHaveBeenLastCalledWith(null);
});

it('goes back to the technician list from its back button', () => {
  const { props } = renderPanel();

  fireEvent.click(screen.getByRole('button', { name: "Back to A Technician's day" }));

  expect(props.onClose).toHaveBeenCalled();
});
