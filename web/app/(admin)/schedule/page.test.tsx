import type { JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SchedulePage from './page';

/**
 * The Schedule (console-development): every visit beside Jobber, the
 * differences under the grid with a way down to them from the top, and the
 * reason a Jobber action is off said where it can be read.
 */

const url = vi.hoisted(() => ({ state: { date: '2026-10-07', view: 'day' }, set: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set] }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));

const held = vi.hoisted(() => ({ comparison: null as unknown }));
vi.mock('@/lib/queries', () => ({
  jobberDayQuery: (date: string) => ({
    queryKey: ['jobber-day', date],
    queryFn: async () => ({ ...(held.comparison as object), date }),
  }),
  useJobberDayAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

function row(over: Partial<JobberDayRow> = {}): JobberDayRow {
  return {
    key: 'insp-1',
    inspectionId: 'insp-1',
    jobberVisitId: 'v-1',
    property: '1 Any St',
    inspectionType: 'OCCUPIED',
    status: 'SCHEDULED',
    technicianId: 't-1',
    here: { startAt: '2026-10-07T18:00:00.000Z', technician: 'Amy W.' },
    jobber: { startAt: '2026-10-07T19:30:00.000Z', technician: 'Amy W.', title: 'Occupied Inspection', completed: false },
    state: 'TIME_DIFFERS',
    differences: ['Here 1:00 PM, Jobber 2:30 PM'],
    waitingToSend: false,
    importNote: null,
    ...over,
  };
}

function comparison(over: Partial<JobberDayComparison> = {}): Omit<JobberDayComparison, 'date'> {
  return {
    syncedAt: null,
    pushesEnabled: true,
    actionsEnabled: true,
    connected: true,
    technicians: [{ technicianId: 't-1', name: 'Amy Wilson', here: 1, inJobber: 1, done: 0, differences: 1 }],
    rows: [row()],
    otherWork: [],
    ...over,
  };
}

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SchedulePage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  url.state = { date: '2026-10-07', view: 'day' };
  url.set.mockReset();
  held.comparison = comparison();
});

describe('the Schedule', () => {
  it('points down to the differences from the top of the page', async () => {
    mount();

    const link = await screen.findByRole('link', { name: /1 difference/ });
    expect(link.getAttribute('href')).toBe('#schedule-differences');
    expect(document.getElementById('schedule-differences')).toBeTruthy();
  });

  it('says once, in words, that Jobber actions are off while sending to Jobber is switched off', async () => {
    held.comparison = comparison({ pushesEnabled: false });
    mount();

    expect(await screen.findByText('Sending changes to Jobber is switched off — make the change in Jobber.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send ours to Jobber' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says nothing about it while sending is on', async () => {
    mount();

    await screen.findByRole('link', { name: /1 difference/ });
    expect(screen.queryByText(/Sending changes to Jobber is switched off/)).toBeNull();
    expect(screen.queryByText(/not switched on yet/)).toBeNull();
  });

  /** JOBBER_DAY_ACTIONS_ENABLED (2026-10-10): off until one has been tried on a demo visit. */
  it("hides the buttons that send to Jobber until the Schedule's switch is on, and says so once", async () => {
    held.comparison = comparison({ actionsEnabled: false });
    mount();

    expect(
      await screen.findByText('Sending changes to Jobber from this page is not switched on yet — make the change in Jobber.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send ours to Jobber' })).toBeNull();
    expect(screen.getByRole('button', { name: "Take Jobber's" })).toBeTruthy();
  });

  it('writes a difference’s day as every scheduled day is written, with its weekday', async () => {
    mount();

    expect(await screen.findByText(/· Wed, Oct 7, 2026/)).toBeTruthy();
  });

  it('chooses the day or the week with the console’s one toggle', () => {
    mount();

    const view = screen.getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'Day' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(view).getByRole('button', { name: 'Week' }));
    expect(url.set).toHaveBeenCalledWith({ view: 'week' });
  });

  it('keeps the technicians’ names in view while the week scrolls sideways', async () => {
    url.state = { date: '2026-10-07', view: 'week' };
    mount();

    const name = await screen.findByText('Amy Wilson');
    expect(name.parentElement!.className).toContain('sticky');
    expect(screen.getByText('Technician').parentElement!.className).toContain('sticky');
  });
});
