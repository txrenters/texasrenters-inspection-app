import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InspectionsPage from './page';

/**
 * The inspections list, for every type (the office, 2026-10-07): one day at a
 * time from today, a search that finds technicians and works across dates, the
 * inspection page's own words for where a visit stands, and only the filters
 * and columns that say something on the list in hand.
 */

const hooks = vi.hoisted(() => ({
  useInspections: vi.fn(),
  useTechnicians: vi.fn(),
}));
vi.mock('@/lib/queries', () => hooks);
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => false }) }));
vi.mock('@/lib/clock', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  businessToday: () => '2026-10-07',
}));
const url = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  set: vi.fn(),
}));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, vi.fn()] }));

const DEFAULTS = {
  asc: false,
  day: '',
  page: 1,
  q: '',
  quarter: '',
  status: '',
  tbp: false,
  tech: '',
  type: '',
  unassigned: false,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inspection-1',
  status: 'SCHEDULED',
  completionBlockedReason: null,
  inspectionType: 'MOVE_OUT',
  priority: 'STANDARD',
  scheduledAt: '2026-10-07T00:00:00.000Z',
  quarter: 'Q4 2026',
  propertywareBuilding: { id: 'b-1', name: '18919 Summer Farm Trl' },
  propertywareUnit: null,
  assignments: [],
  evidence: { areas: 0, findings: 0, photos: 0 },
  tbp: 'ENROLLED',
  ...over,
});

function mount(state: Record<string, unknown> = {}, items = [row()]) {
  url.state = { ...DEFAULTS, ...state };
  hooks.useInspections.mockReturnValue({
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
    data: { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 },
  });
  hooks.useTechnicians.mockReturnValue({
    data: {
      items: [
        { id: 'tech-amy', displayName: 'Amy Wilson' },
        { id: 'tech-ben', displayName: 'Ben Ortiz' },
      ],
    },
  });
  return render(<InspectionsPage />);
}

const asked = () => hooks.useInspections.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  hooks.useInspections.mockReset();
  url.set.mockReset();
});

describe('which day the list shows', () => {
  it('opens on today’s visits, asking for the day itself', () => {
    mount();

    expect(asked().scheduledOn).toBe('2026-10-07');
    expect(asked()).not.toHaveProperty('scheduledFrom');
    expect(screen.getByText('1 inspection on Wednesday, October 7')).toBeInTheDocument();
  });

  it('steps a day at a time, and goes back to today or to every date', () => {
    mount({ day: '2026-10-05' });

    fireEvent.click(screen.getByRole('button', { name: 'The day after' }));
    expect(url.set).toHaveBeenLastCalledWith({ day: '2026-10-06', page: 1 });
    // Today is the list's own default, so it leaves the URL clean.
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(url.set).toHaveBeenLastCalledWith({ day: '', page: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'All dates' }));
    expect(url.set).toHaveBeenLastCalledWith({ day: 'all', page: 1 });
  });

  it('shows every date when asked', () => {
    mount({ day: 'all' });

    expect(asked().scheduledOn).toBeUndefined();
  });

  it('searches every date, unless a day was picked', () => {
    mount({ q: 'Amy' });
    expect(asked().scheduledOn).toBeUndefined();

    mount({ q: 'Amy', day: '2026-10-05' });
    expect(asked().scheduledOn).toBe('2026-10-05');
  });
});

describe('the filters', () => {
  it('offers where a visit stands in the inspection page’s words', () => {
    mount({ status: 'DONE' });

    expect(asked().status).toBe('DONE');
    expect(screen.getByText('Status:').parentElement).toHaveTextContent('Done');
  });

  it('narrows to one technician, or to visits nobody is on', () => {
    mount({ tech: 'tech-amy' });
    expect(asked()).toMatchObject({ technicianId: 'tech-amy' });
    expect(asked().unassignedOnly).toBeUndefined();

    mount({ tech: 'unassigned' });
    expect(asked()).toMatchObject({ unassignedOnly: true });
    expect(asked().technicianId).toBeUndefined();
  });

  it('reads the dashboard’s older link as every unassigned visit, on every date', () => {
    mount({ unassigned: true });

    expect(asked()).toMatchObject({ unassignedOnly: true });
    expect(asked().scheduledOn).toBeUndefined();
  });

  it('keeps the benefit package to the lists where it means something', () => {
    mount({ type: 'MOVE_OUT', quarter: 'Q4 2026', tbp: true });
    expect(screen.queryByRole('combobox', { name: 'Quarter' })).toBeNull();
    expect(screen.queryByText('Benefit package')).toBeNull();
    // A quarter left in the URL from elsewhere does not narrow a move-out list.
    expect(asked().quarter).toBeUndefined();
    expect(asked().tbpOnly).toBeUndefined();

    mount({ type: 'HVAC' });
    expect(screen.getAllByRole('combobox', { name: 'Quarter' }).length).toBeGreaterThan(0);
  });
});

describe('the table', () => {
  it('says Done for a submitted visit, and Could not get in where the technician said so', () => {
    mount({}, [
      row({ id: 'a', status: 'REVIEW_REQUIRED' }),
      row({ id: 'b', status: 'TECHNICIAN_SUBMITTED', completionBlockedReason: 'Could not get in: gate locked' }),
    ]);

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Could not get in')).toBeInTheDocument();
    expect(screen.queryByText('Review required')).toBeNull();
  });

  it('flags a missing technician only where one is still needed', () => {
    mount({}, [
      row({ id: 'upcoming' }),
      row({ id: 'cancelled', status: 'CANCELLED', propertywareBuilding: { id: 'b-2', name: '7902 Avenue F' } }),
      row({
        id: 'assigned',
        assignments: [{ isCurrent: true, technician: { displayName: 'Amy Wilson' } }],
        propertywareBuilding: { id: 'b-3', name: '9905 Brookview Dr' },
      }),
    ]);

    expect(screen.getAllByText('Unassigned')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('1 upcoming visit here has no technician');
  });

  it('drops the columns that repeat on a type’s own list', () => {
    const { unmount } = mount({ type: 'MOVE_OUT' });
    const headers = () => screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers()).not.toContain('Type');
    expect(headers()).not.toContain('TBP');
    expect(headers()).not.toContain('Unit');
    expect(headers()).not.toContain('Priority');
    unmount();

    mount({ type: '' });
    expect(headers()).toEqual(expect.arrayContaining(['Type', 'TBP']));
  });

  it('shows a unit under its property, and a priority only when it is not Standard', () => {
    mount({}, [row({ propertywareUnit: { id: 'u-1', name: 'Unit 5' }, priority: 'URGENT' })]);

    const cell = screen.getByText('18919 Summer Farm Trl').closest('td, th')!;
    expect(within(cell as HTMLElement).getByText('Unit 5')).toBeInTheDocument();
    expect(within(cell as HTMLElement).getByText(/urgent/i)).toBeInTheDocument();
  });

  it('says a quiet day is a quiet day, and offers every date', () => {
    mount({ type: 'MOVE_OUT' }, []);

    // The type as the page's title spells it, not the enum humanized.
    expect(screen.getByText('No move-out inspections')).toBeInTheDocument();
    expect(screen.getByText(/Nothing of this type is scheduled on Wednesday, October 7/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show every date' }));
    expect(url.set).toHaveBeenLastCalledWith({ day: 'all', page: 1 });
  });
});
