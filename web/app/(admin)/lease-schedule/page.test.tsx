import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LeaseSchedulePage from './page';

const hooks = vi.hoisted(() => ({ useLeaseSchedule: vi.fn(), useLeaseScheduleRun: vi.fn() }));
vi.mock('@/lib/lease-schedule-queries', () => hooks);
const permissions = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => permissions.allowed }) }));

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'MOVE_OUT',
  dueOn: '2026-10-21',
  scheduledOn: '2026-10-21',
  outcome: 'SCHEDULED',
  detail: null,
  updatedAt: '2026-09-18T07:15:00.000Z',
  property: { id: `building-${id}`, name: `${id} Main St`, address: `${id} Main St`, city: 'Houston' },
  lease: { id: `lease-${id}`, status: 'Active', endsOn: '2026-12-20' },
  inspection: { id: `inspection-${id}`, status: 'SCHEDULED', scheduledOn: '2026-10-21', technician: { id: 'moses', displayName: 'Moses Rodriguez' } },
  ...over,
});

const OVERVIEW = {
  schedule: { enabled: false, cron: '15 2 * * *', nextRunAt: null, running: false, lastRun: null },
  items: [
    item('1'),
    item('2', { kind: 'MOVE_IN', dueOn: '2026-11-22', scheduledOn: '2026-11-23', inspection: { id: 'inspection-2', status: 'SCHEDULED', scheduledOn: '2026-11-23', technician: { id: 'amy', displayName: 'Amy Wilson' } } }),
    item('3', { outcome: 'NEEDS_UNIT', inspection: null, detail: 'The building has several units.' }),
    item('4', { outcome: 'CALLED_OFF', detail: 'The tenant is no longer leaving.' }),
  ],
};

const PREVIEW = {
  today: '2026-09-18',
  dryRun: true,
  leases: 455,
  counts: { BOOK: 2, ALREADY_BOOKED: 1, NEEDS_UNIT: 0, NOT_BOOKABLE: 0, MOVE: 0, CALL_OFF: 0 },
  changes: [
    { leaseId: 'lease-9', kind: 'MOVE_OUT', action: 'BOOK', scheduledOn: '2026-10-21', property: { id: 'b-9', address: '9 Oak Ln', city: 'Katy' }, inspectionId: null, detail: null },
  ],
};

const run = { mutate: vi.fn(), isPending: false, variables: undefined as boolean | undefined };

function mount(overview = OVERVIEW) {
  hooks.useLeaseSchedule.mockReturnValue({ isLoading: false, isError: false, data: overview });
  hooks.useLeaseScheduleRun.mockReturnValue(run);
  return render(<LeaseSchedulePage />);
}

beforeEach(() => {
  run.mutate.mockReset();
  permissions.allowed = true;
});

/** The office (2026-09-18): move-outs and move-ins booked from the leases, not in Jobber. */
describe('the move-ins and move-outs page', () => {
  it('lists what is coming up, with who takes each, apart from what needs attention', () => {
    mount();

    expect(screen.getByRole('tab', { name: 'Coming up (2)' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Needs attention (1)' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Called off (1)' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Move-ins and move-outs coming up' });
    expect(within(table).getByText('Moses Rodriguez')).toBeTruthy();
    expect(within(table).getByText('Amy Wilson')).toBeTruthy();
    expect(within(table).getByText('Due Nov 22, 2026')).toBeTruthy();
  });

  it('says the daily run is off until it is switched on', () => {
    mount();

    expect(screen.getByText('off until it is switched on on the server')).toBeTruthy();
  });

  it('previews a run, writing nothing', () => {
    run.mutate.mockImplementation((dryRun: boolean, options: { onSuccess: (result: unknown) => void }) => {
      if (dryRun) options.onSuccess(PREVIEW);
    });
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(run.mutate.mock.calls[0]![0]).toBe(true);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('455 leases read: 2 book · 1 already booked. Nothing has been booked.')).toBeTruthy();
    expect(within(dialog).getByText('9 Oak Ln, Katy')).toBeTruthy();
  });

  it('books only once the office confirms', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Book now' }));
    expect(run.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Book now' }));

    expect(run.mutate.mock.calls[0]![0]).toBe(false);
  });

  it('offers no run to someone who may only read inspections', () => {
    permissions.allowed = false;
    mount();

    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book now' })).toBeNull();
  });
});
