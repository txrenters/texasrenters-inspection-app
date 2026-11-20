import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorkOrdersPage from './page';

/**
 * The work orders the maintenance app handed over for the in-house crews, by
 * work order (the office, 2026-11-20: "i just want to see them inside work
 * order page in inspection app"). Each is a visit whose source is the work
 * order; the page lists those and nothing else.
 */

const hooks = vi.hoisted(() => ({
  useInspections: vi.fn(),
  useInspection: vi.fn(),
}));
vi.mock('@/lib/queries', () => hooks);
const url = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  set: vi.fn(),
}));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, vi.fn()] }));

const DEFAULTS = { page: 1, q: '' };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inspection-1',
  status: 'SCHEDULED',
  completionBlockedReason: null,
  inspectionType: 'MAINTENANCE',
  workOrderNumber: 44781,
  priority: 'STANDARD',
  scheduledAt: '2026-11-20T00:00:00.000Z',
  createdAt: '2026-11-19T18:50:00.000Z',
  propertywareBuilding: { id: 'b-1', name: '123 Demo St.', addressLine1: '123 Demo Street', city: 'Houston', state: 'TX' },
  propertywareUnit: null,
  assignments: [{ isCurrent: true, technician: { id: 'tech-1', displayName: 'Moses Rodriguez' } }],
  ...over,
});

function mount(state: Record<string, unknown> = {}, items = [row()], query: Record<string, unknown> = {}) {
  url.state = { ...DEFAULTS, ...state };
  hooks.useInspections.mockReturnValue({
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
    data: { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 },
    ...query,
  });
  return render(<WorkOrdersPage />);
}

const asked = () => hooks.useInspections.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  hooks.useInspections.mockReset();
  url.set.mockReset();
});

describe('what the page asks for', () => {
  it('asks only for the visits the maintenance app handed over, newest first', () => {
    mount();

    expect(asked().source).toBe('WORK_ORDER');
    expect(asked()).not.toHaveProperty('scheduledOn');
    expect(asked().page).toBe(1);
  });

  it('searches by work order number or address, from page one', () => {
    mount({ q: '44781' });

    expect(asked().search).toBe('44781');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Demo' } });
    expect(url.set).toHaveBeenLastCalledWith({ q: 'Demo', page: 1 });
  });
});

describe('each row', () => {
  it('says the work order, the property, the kind of visit, the technician and the day', () => {
    mount();

    expect(screen.getByText('#44781')).toBeInTheDocument();
    expect(screen.getByText('123 Demo St.')).toBeInTheDocument();
    expect(screen.getByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByText('Moses Rodriguez')).toBeInTheDocument();
  });

  it('says Pest control for the pest crew, and Unassigned while nobody is on it', () => {
    mount({}, [row({ inspectionType: 'PEST_CONTROL', assignments: [] })]);

    expect(screen.getByText('Pest control')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });
});

describe('when nothing has arrived', () => {
  it('says so, and where the work orders come from', () => {
    mount({}, []);

    expect(screen.getByText('No work orders yet')).toBeInTheDocument();
    expect(screen.getByText(/None has arrived yet/)).toBeInTheDocument();
  });

  it('tells a search apart from an empty list', () => {
    mount({ q: 'nothing' }, []);

    expect(screen.getByText('No work orders match')).toBeInTheDocument();
  });
});

describe('opening a work order', () => {
  it('opens it in a dialog, not on the inspection page', () => {
    hooks.useInspection.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ...row(),
        internalNotes: 'Work order #44781\nPlumbing · Leak\n\nKitchen sink drips under the cabinet',
      },
    });
    mount();

    expect(screen.queryByRole('link', { name: /44781/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /44781/ }));

    const dialog = screen.getByRole('dialog');
    expect(hooks.useInspection).toHaveBeenLastCalledWith('inspection-1');
    expect(within(dialog).getByText('Work order #44781')).toBeInTheDocument();
    expect(within(dialog).getByText(/Kitchen sink drips under the cabinet/)).toBeInTheDocument();
    expect(within(dialog).getByText('Moses Rodriguez')).toBeInTheDocument();
  });
});
