import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TimesheetPage from './page';

/**
 * The hours a technician worked.
 *
 * What is pinned here is what the office asked the page to be on 2026-10-06:
 * one Texas day at a time, picked from a single calendar; two figures and
 * their total -- on site, and general time -- with nothing left in a third
 * pile to settle; and one row per property however often the technician went
 * in and out, with the hours a person changed, or the phone was quiet for,
 * still told apart from the rest.
 */

const hooks = vi.hoisted(() => ({ useTimesheet: vi.fn(), useTimesheetActions: vi.fn() }));
// The real module otherwise, so `asHours` formats here exactly as it does on
// the page -- a second copy of it in the test would agree with itself and not
// with what the office reads.
vi.mock('@/lib/timesheet-queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...hooks };
});
const permissions = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => permissions.allowed }) }));

const correct = { mutate: vi.fn(), isPending: false };
const recalculate = { mutate: vi.fn(), isPending: false };

/** Three in the afternoon in Texas; already the next morning in Manila. */
const NOW = new Date('2026-10-06T20:07:00.000Z');
const TODAY = '2026-10-06';

const VISIT = {
  key: 'tech-1:b1:2026-10-06',
  technicianId: 'tech-1',
  technician: 'Moses Rodriguez',
  buildingId: 'b1',
  inspectionId: 'insp-1',
  address: '1902 Mockup Dr',
  // 9:00 and 10:00 in Texas.
  arrivedAt: '2026-10-06T14:00:00.000Z',
  leftAt: '2026-10-06T15:00:00.000Z',
  onsiteSeconds: 3_000,
  quietSeconds: 0,
  stays: 1,
  segmentIds: ['seg-1'],
  adjusted: false,
  addedByHand: false,
};

const SHEET = {
  date: TODAY,
  totals: [
    {
      technicianId: 'tech-1',
      technician: 'Moses Rodriguez',
      onsiteSeconds: 18_000,
      generalSeconds: 7_200,
      totalSeconds: 25_200,
      quietSeconds: 0,
    },
  ],
  visits: [VISIT],
};

function mount(sheet: unknown = SHEET) {
  hooks.useTimesheet.mockReturnValue({ isLoading: false, isError: false, data: sheet, refetch: vi.fn() });
  hooks.useTimesheetActions.mockReturnValue({ correct, recalculate });
  return render(<TimesheetPage />);
}

const table = (name: string) => screen.getByRole('table', { name });
/** The day the page last asked the server for. */
const askedFor = () => hooks.useTimesheet.mock.calls.at(-1)![0] as string;

beforeEach(() => {
  vi.clearAllMocks();
  permissions.allowed = true;
  // `shouldAdvanceTime` so React's own scheduling still runs; a fully frozen
  // clock hangs the renderer.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('one day at a time', () => {
  /**
   * The first morning this was live, from Manila: "today" there was already
   * the 7th, Texas was still on the 6th, and the range came out backwards.
   */
  it('opens on today in Texas, whatever day it is where the office is', () => {
    mount();

    expect(askedFor()).toBe(TODAY);
    expect(screen.getByText(/Tuesday, October 6/)).toBeInTheDocument();
  });

  it('has one calendar, not a range', () => {
    mount();

    expect(screen.getAllByRole('button', { name: 'The day to show' })).toHaveLength(1);
    expect(screen.queryByText('From')).not.toBeInTheDocument();
    expect(screen.queryByText('To')).not.toBeInTheDocument();
  });

  it('steps back a day, and forward again, and back to today', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'The day before' }));
    expect(askedFor()).toBe('2026-10-05');

    fireEvent.click(screen.getByRole('button', { name: 'The day before' }));
    fireEvent.click(screen.getByRole('button', { name: 'The day after' }));
    expect(askedFor()).toBe('2026-10-05');

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(askedFor()).toBe(TODAY);
  });

  /** Tomorrow has no hours yet, and an empty page would only look like a fault. */
  it('does not step past today', () => {
    mount();

    expect(screen.getByRole('button', { name: 'The day after' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
  });

  /** The day can still be changed when it failed to load, or nobody could get off it. */
  it('keeps the calendar on the page when the day could not be loaded', () => {
    hooks.useTimesheet.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error('Network down'),
      refetch: vi.fn(),
    });
    hooks.useTimesheetActions.mockReturnValue({ correct, recalculate });
    render(<TimesheetPage />);

    expect(screen.getByRole('button', { name: 'The day before' })).toBeInTheDocument();
  });
});

describe('the hours', () => {
  it('shows each technician on site, in general time, and the two together', () => {
    mount();

    const row = within(table('Hours by technician')).getByText('Moses Rodriguez').closest('tr')!;
    expect(within(row).getByText('5h')).toBeInTheDocument();
    expect(within(row).getByText('2h')).toBeInTheDocument();
    expect(within(row).getByText('7h')).toBeInTheDocument();
  });

  /**
   * The office's words. The column used to be "Unaccounted for", and what it
   * held was not time away from a property at all.
   */
  it('calls time away from a property general time, and nothing else', () => {
    mount();

    expect(within(table('Hours by technician')).getByText('General time')).toBeInTheDocument();
    expect(screen.queryByText(/unaccounted/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Driving')).not.toBeInTheDocument();
  });

  it('says so plainly when nobody was at a property that day', () => {
    mount({ date: TODAY, totals: [], visits: [] });

    expect(screen.getByText('Nothing recorded on this day')).toBeInTheDocument();
  });
});

/**
 * The office, 2026-10-06, about one address with four rows on one day: "we
 * only need the total time record of the time he has with the property".
 */
describe('one row per property', () => {
  it('shows when the technician arrived, when they left, and how long they were inside', () => {
    mount();

    const row = within(table('Time at each property')).getByText('1902 Mockup Dr').closest('tr')!;
    expect(within(row).getByText('9:00 AM')).toBeInTheDocument();
    expect(within(row).getByText('10:00 AM')).toBeInTheDocument();
    expect(within(row).getByText('50m')).toBeInTheDocument();
  });

  /** Said, so ten minutes missing from an hour's span is not a mystery. */
  it('says how often they stepped out of the circle', () => {
    mount({ ...SHEET, visits: [{ ...VISIT, stays: 4, segmentIds: ['a', 'b', 'c', 'd'] }] });

    expect(within(table('Time at each property')).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('Stepped out 3 times')).toBeInTheDocument();
  });

  it('marks a visit that was carried through a silence, and for how long', () => {
    mount({ ...SHEET, visits: [{ ...VISIT, quietSeconds: 2_400 }] });

    expect(screen.getByText('Phone quiet 40m')).toBeInTheDocument();
  });

  /** A technician paid from this is entitled to know which hours a person decided. */
  it('marks a visit a person corrected, or added to by hand', () => {
    mount({ ...SHEET, visits: [{ ...VISIT, adjusted: true, addedByHand: true }] });

    expect(screen.getByText('Corrected')).toBeInTheDocument();
    expect(screen.getByText('Added by hand')).toBeInTheDocument();
  });
});

describe('correcting the time at a property', () => {
  it('will not save a correction without a reason', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Correct the time at 1902 Mockup Dr' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save the correction' })).toBeDisabled();
  });

  /** The whole visit, in Texas time, and every stretch behind the row. */
  it('starts from the visit as the trail saw it, and sends every stretch behind the row', () => {
    mount({ ...SHEET, visits: [{ ...VISIT, stays: 2, segmentIds: ['seg-1', 'seg-2'] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Correct the time at 1902 Mockup Dr' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByLabelText('Arrived (Texas time)')).toHaveValue('2026-10-06T09:00');
    expect(within(dialog).getByLabelText('Left (Texas time)')).toHaveValue('2026-10-06T10:00');

    fireEvent.change(within(dialog).getByPlaceholderText(/phone was in the van/), {
      target: { value: 'Was in the garage the whole time.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the correction' }));

    expect(correct.mutate).toHaveBeenCalledWith(
      {
        segmentIds: ['seg-1', 'seg-2'],
        startedAt: VISIT.arrivedAt,
        endedAt: VISIT.leftAt,
        reason: 'Was in the garage the whole time.',
      },
      expect.anything(),
    );
  });

  /** Correcting is the office's job; reading it is everybody's. */
  it('offers no correction to somebody who may only read', () => {
    permissions.allowed = false;
    mount();

    expect(screen.queryByRole('button', { name: /Correct the time/ })).not.toBeInTheDocument();
  });
});

/**
 * Today and yesterday are read without anybody asking. This is how a change
 * of rule, or a corrected pin, reaches the days behind them.
 */
describe('recalculating', () => {
  const choose = async (item: string) => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Recalculate' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  };

  it('reads the day on the page again', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'The day before' }));

    await choose('This day');

    expect(recalculate.mutate).toHaveBeenCalledWith({ from: '2026-10-05', to: '2026-10-05' }, expect.anything());
  });

  /** The trail is kept for thirty days, so that is as far back as it can reach. */
  it('reads the last thirty days again in one go', async () => {
    mount();

    await choose('The last 30 days');

    expect(recalculate.mutate).toHaveBeenCalledWith({ from: '2026-09-07', to: TODAY }, expect.anything());
  });

  it('says what changed, and that corrections were left alone', async () => {
    mount();
    await choose('The last 30 days');
    // The page renders what the server reported, so drive its callback.
    const onSuccess = recalculate.mutate.mock.calls[0]![1].onSuccess as (result: unknown) => void;
    act(() => onSuccess({ days: 30, technicians: 2, changed: 9 }));

    expect(screen.getByText(/Read 30 days again. 9 technician-days changed/)).toBeInTheDocument();
    expect(screen.getByText(/corrected by hand were left as they are/)).toBeInTheDocument();
  });

  /** It writes, so it is the office's to press. */
  it('is not offered to somebody who may only read', () => {
    permissions.allowed = false;
    mount();

    expect(screen.queryByRole('button', { name: 'Recalculate' })).not.toBeInTheDocument();
  });
});
