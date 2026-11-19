import type { AdminJob } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The job page (2026-11-20, phase 5 of the jobs plan): each inspection in a
 * job with where it stands, the lead's services, and the two changes a job
 * takes. Everything invented.
 */

const state = vi.hoisted(() => ({ granted: new Set<string>(), job: null as unknown }));
const work = vi.hoisted(() => ({ add: vi.fn(), takeOff: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ jobId: 'job-1' }) }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => state.granted.has(key) }) }));
vi.mock('@/lib/queries', () => ({
  useJob: () => ({ isLoading: false, isError: false, data: state.job, refetch: vi.fn() }),
  useJobWork: () => ({
    add: { mutate: work.add, isPending: false, error: null },
    takeOff: { mutate: work.takeOff, isPending: false, error: null },
  }),
}));

const { default: JobPage } = await import('./page');

const job = (over: Partial<AdminJob> = {}): AdminJob => ({
  id: 'job-1',
  number: 'J-00042',
  title: 'Occupied + HVAC, filters and pest control',
  source: 'CONSOLE',
  scheduledAt: '2026-11-23',
  property: { id: 'p1', name: '2210 Example Bend', addressLine1: '2210 Example Bend' },
  unit: null,
  createdAt: '2026-11-20T15:00:00.000Z',
  state: 'PARTIALLY_COMPLETE',
  technician: { id: 't1', displayName: 'D. Sample' },
  services: [
    { key: 'filterChange', label: 'AC filter change', outcome: 'DONE', reason: null },
    { key: 'pestControl', label: 'Pest control', outcome: 'NOT_DONE', reason: 'Tenant asked to come back' },
  ],
  canAddWork: true,
  inspections: [
    { id: 'occ-1', inspectionType: 'OCCUPIED', status: 'TECHNICIAN_SUBMITTED', state: 'DONE', lead: true, technician: { id: 't1', displayName: 'D. Sample' }, canTakeOff: false },
    { id: 'hvac-1', inspectionType: 'HVAC', status: 'SCHEDULED', state: 'SCHEDULED', lead: false, technician: { id: 't1', displayName: 'D. Sample' }, canTakeOff: true },
  ],
  ...over,
});

beforeEach(() => {
  state.granted = new Set(['inspections:read', 'inspections:manage']);
  state.job = job();
  work.add.mockReset();
  work.takeOff.mockReset();
});

describe('the job page', () => {
  it('names the job, says where it stands, and lists each inspection with its own state and a way to it', () => {
    render(<JobPage />);

    expect(screen.getByRole('heading', { name: 'Occupied + HVAC, filters and pest control' })).toBeTruthy();
    expect(screen.getByText('J-00042')).toBeTruthy();
    expect(screen.getByText('Monday, November 23')).toBeTruthy();
    expect(screen.getAllByText('Partially complete').length).toBeGreaterThan(0);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
      'Occupied inspectionLeads the job: the services and the Jobber visit are on it',
      'HVAC inspection',
    ]);
    expect(within(rows[1]!).getByRole('link', { name: 'Open inspection' })).toHaveAttribute('href', '/inspections/hvac-1');
  });

  it("shows the lead's services with what the technician answered", () => {
    render(<JobPage />);

    expect(screen.getByText('Services on the Occupied inspection')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Not done')).toBeTruthy();
    expect(screen.getByText('Tenant asked to come back')).toBeTruthy();
  });

  it('adds only the kinds the job does not have yet', () => {
    render(<JobPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add work' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('checkbox', { name: 'Occupied' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: 'HVAC' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Move-out' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to the job' }));
    expect(work.add).toHaveBeenCalledWith({ inspectionTypes: ['MOVE_OUT'] }, expect.anything());
  });

  it('takes off only work nobody has started, after asking', () => {
    render(<JobPage />);

    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).queryByRole('button', { name: 'Take off' })).toBeNull();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Take off' }));
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText('Take the HVAC inspection off J-00042?')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Take it off' }));
    expect(work.takeOff).toHaveBeenCalledWith('hvac-1', expect.anything());
  });

  it('offers no changes to somebody who may only read, nor more work on a job that is done', () => {
    state.granted = new Set(['inspections:read']);
    const { unmount } = render(<JobPage />);
    expect(screen.queryByRole('button', { name: 'Add work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take off' })).toBeNull();
    unmount();

    state.granted = new Set(['inspections:read', 'inspections:manage']);
    state.job = job({ canAddWork: false });
    render(<JobPage />);
    expect(screen.queryByRole('button', { name: 'Add work' })).toBeNull();
  });
});
