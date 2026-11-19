import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ReschedulesPage from './page';

const hooks = vi.hoisted(() => ({
  useRescheduleRequests: vi.fn(),
  useMoveRescheduleRequest: vi.fn(),
  useBookAgainRescheduleRequest: vi.fn(),
  useDismissRescheduleRequest: vi.fn(),
}));
vi.mock('@/lib/reschedule-queries', () => hooks);
vi.mock('@/lib/queries', () => ({
  useTechnicians: () => ({ data: { items: [{ id: 'moses', displayName: 'Moses Rodriguez' }] } }),
}));
const permissions = vi.hoisted(() => ({ granted: ['inspections:manage'] as string[] }));
const url = vi.hoisted(() => ({ state: { filter: 'open', q: '' }, set: vi.fn(), reset: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, url.reset] }));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (permission: string) => permissions.granted.includes(permission) }),
}));

const request = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'SERVICES_NOT_DONE',
  status: 'OPEN',
  outcome: null,
  resolvedInJobber: false,
  services: ['pestControl'],
  jobType: 'Pest control',
  reason: 'Pest control: Tenant refused',
  preferredOn: null,
  requestedAt: '2026-10-20T15:00:00.000Z',
  requestedBy: { id: 'moses', displayName: 'Moses Rodriguez' },
  inspection: {
    id: `inspection-${id}`,
    inspectionType: 'OCCUPIED',
    scheduledOn: '2026-10-20',
    status: 'TECHNICIAN_SUBMITTED',
    address: `${id} Example St`,
    city: 'Houston',
    technician: { id: 'moses', displayName: 'Moses Rodriguez' },
    inJobber: true,
  },
  rebook: null,
  action: 'BOOK_AGAIN',
  suggestedDay: '2099-11-02',
  dismissReason: null,
  jobberError: null,
  resolvedAt: null,
  resolvedBy: null,
  ...over,
});

const LIST = {
  items: [
    request('1'),
    request('2', {
      kind: 'BEFORE_VISIT',
      services: [],
      jobType: 'AC filter change + Pest control + Occupied inspection',
      reason: 'Tenant asked for Thursday',
      preferredOn: '2099-10-29',
      action: 'MOVE',
      inspection: { ...request('2').inspection, status: 'SCHEDULED' },
    }),
    request('3', {
      status: 'OPEN',
      outcome: 'MOVED',
      jobberError: 'The visit was not found in Jobber.',
      action: 'MOVE',
      kind: 'BEFORE_VISIT',
      jobType: 'Move-out inspection',
    }),
  ],
  counts: { open: 3, sending: 0, closed: 12 },
  jobberEditsPushed: true,
  jobberBookingEnabled: true,
};

const answer = () => ({ mutate: vi.fn(), isPending: false });
let book = answer();

function mount(list = LIST) {
  hooks.useRescheduleRequests.mockReturnValue({ isLoading: false, isError: false, data: list });
  hooks.useMoveRescheduleRequest.mockReturnValue(answer());
  hooks.useBookAgainRescheduleRequest.mockReturnValue(book);
  hooks.useDismissRescheduleRequest.mockReturnValue(answer());
  return render(<ReschedulesPage />);
}

beforeEach(() => {
  permissions.granted = ['inspections:manage'];
  url.state = { filter: 'open', q: '' };
  url.set.mockReset();
  book = answer();
});

/** The visits to book again (2026-10-21): what technicians asked, and the office's answers. */
describe('the reschedule queue', () => {
  it('lists what each technician asked, and offers the answer that fits the visit', () => {
    mount();

    expect(screen.getByRole('tab', { name: /^Open\s*3$/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Answered\s*12$/ })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Open reschedule requests' });
    expect(within(table).getAllByText('Asked before the visit')).toHaveLength(2);
    // In the Why column, and again under the job type for a phone, which has no Why column.
    expect(within(table).getAllByText('Tenant asked for Thursday')).toHaveLength(2);
    expect(within(table).getByText('Suggests Oct 29, 2099')).toBeTruthy();
    expect(within(table).getAllByRole('button', { name: 'Book again…' })).toHaveLength(1);
    expect(within(table).getAllByRole('button', { name: 'Move…' })).toHaveLength(2);
  });

  // 2026-11-19: "if the reschedule is only for the pest control or just the
  // filter change it should show the job type".
  it('names the job that goes again: only the service left, or the whole visit', () => {
    mount();

    const table = screen.getByRole('table', { name: 'Open reschedule requests' });
    expect(within(table).getByRole('columnheader', { name: 'Job type' })).toBeTruthy();
    expect(within(table).getByText('Pest control')).toBeTruthy();
    expect(within(table).getByText('The rest of the occupied visit was done')).toBeTruthy();
    expect(within(table).getByText('AC filter change + Pest control + Occupied inspection')).toBeTruthy();
    expect(within(table).getAllByText('The whole visit')).toHaveLength(2);
  });

  // 2026-11-19: "there's no search for the reschedule".
  it('searches the queue, and the search reaches the server', () => {
    url.state = { filter: 'open', q: '12 Example' };
    mount();

    expect(hooks.useRescheduleRequests).toHaveBeenCalledWith('open', true, '12 Example');
    expect(screen.getAllByRole('searchbox', { name: 'Search address, technician, reason or job type' }).length).toBeGreaterThan(0);
  });

  it('says when a search finds the request on the other list, and goes there', () => {
    url.state = { filter: 'open', q: '9 Example' };
    mount({ ...LIST, items: [], counts: { open: 0, sending: 0, closed: 1 } });

    expect(screen.getByText('Nothing open matches "9 Example". 1 answered request does.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show answered' }));
    expect(url.set).toHaveBeenCalledWith({ filter: 'closed' });
  });

  it("says when Jobber refused an answer, so the office answers again", () => {
    mount();

    expect(screen.getByText('Jobber refused')).toBeTruthy();
    expect(screen.getByText('The visit was not found in Jobber.')).toBeTruthy();
  });

  it('books a visit again on the suggested day with the same technician', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Book again…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/A new occupied visit for pest control, booked in Jobber too/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Book again' }));

    expect(book.mutate).toHaveBeenCalledWith(
      { id: '1', input: { scheduledOn: '2099-11-02', technicianId: 'moses' } },
      expect.anything(),
    );
  });

  // 2026-10-22: a day picked in the calendar still read "The next Monday kept
  // for rescheduled visits", as though the queue had offered it.
  it('names the day it offers, so a day picked instead is not taken for it', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Book again…' }));
    expect(
      within(screen.getByRole('dialog')).getByText('The next Monday kept for rescheduled visits is Nov 2, 2099.'),
    ).toBeTruthy();
  });

  it("names the technician's day when that is the one offered", () => {
    mount({ ...LIST, items: [request('2', { kind: 'BEFORE_VISIT', action: 'MOVE', preferredOn: '2099-11-02' })] });

    fireEvent.click(screen.getByRole('button', { name: 'Move…' }));
    expect(within(screen.getByRole('dialog')).getByText('The technician suggested Nov 2, 2099.')).toBeTruthy();
  });

  it('lets a planner without the inspections grant dismiss, but not move or book', () => {
    permissions.granted = ['planning:publish'];
    mount();

    const table = screen.getByRole('table', { name: 'Open reschedule requests' });
    for (const button of within(table).getAllByRole('button', { name: /Move…|Book again…/ }))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    for (const button of within(table).getAllByRole('button', { name: 'Dismiss…' }))
      expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends a coordinator to Jobber when this server does not book there', () => {
    mount({ ...LIST, jobberBookingEnabled: false });

    const button = screen.getByRole('button', { name: 'Book again…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/book it in Jobber, and this closes when the sync sees it/);
  });
});
