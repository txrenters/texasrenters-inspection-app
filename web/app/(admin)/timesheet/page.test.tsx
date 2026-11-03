import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleShellProvider } from '@/components/console-shell-context';

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
  jobs: [{ inspectionId: 'insp-1', type: 'MOVE_OUT', benefitPackage: false, status: 'SCHEDULED' }],
};

const SHEET = {
  date: TODAY,
  totals: [
    {
      technicianId: 'tech-1',
      technician: 'Moses Rodriguez',
      onsiteSeconds: 18_000,
      generalSeconds: 7_200,
      stopSeconds: 0,
      totalSeconds: 25_200,
      quietSeconds: 0,
    },
  ],
  visits: [VISIT],
};

/** Half an hour at the hardware store, between 10:40 and 11:10 in Texas. */
const STOP = {
  key: 'seg-9',
  technicianId: 'tech-1',
  technician: 'Moses Rodriguez',
  arrivedAt: '2026-10-06T15:40:00.000Z',
  leftAt: '2026-10-06T16:10:00.000Z',
  durationSeconds: 1_800,
  quietSeconds: 0,
  place: { kind: 'BUSINESS', name: 'The Home Depot', address: '1 Supply Rd, Houston' },
  latitude: 29.9,
  longitude: -95.5,
};

/** The same day, as somebody who may see where a technician was reads it. */
const WITH_STOPS = {
  ...SHEET,
  totals: [{ ...SHEET.totals[0]!, stopSeconds: 1_800, generalSeconds: 5_400 }],
  stops: [STOP],
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
    expect(screen.getByText('Tuesday, October 6')).toBeInTheDocument();
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

  /** The office, 2026-10-17: a stop is its own figure, so general time is the drive. */
  it('counts stops as a figure of their own, in the day and by technician', () => {
    mount(WITH_STOPS);

    expect(screen.getByText('Stops', { selector: '*:not(th)' })).toBeInTheDocument();
    const row = within(table('Hours by technician')).getByText('Moses Rodriguez').closest('tr')!;
    expect(within(row).getByText('30m')).toBeInTheDocument();
    expect(within(row).getByText('1h 30m')).toBeInTheDocument();
  });
});

/**
 * Where a technician stopped that is not a property (the office, 2026-10-17:
 * "if he goes to the hardware store"), in the day's one list, in order.
 */
describe('stops away from the properties', () => {
  const dayTable = () => table('Time at each property and stop');

  it('lists the stop between the visits, in the order it happened', () => {
    mount({
      ...WITH_STOPS,
      visits: [
        VISIT,
        { ...VISIT, key: 'tech-1:b2', address: '9 Later Ave', arrivedAt: '2026-10-06T16:30:00.000Z' },
      ],
    });

    const places = within(dayTable())
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[1]!.textContent);
    expect(places).toEqual([
      expect.stringContaining('1902 Mockup Dr'),
      expect.stringContaining('The Home Depot'),
      expect.stringContaining('9 Later Ave'),
    ]);
  });

  it('says what the place was, when, and for how long', () => {
    mount(WITH_STOPS);

    const row = within(dayTable()).getByText('The Home Depot').closest('tr')!;
    expect(within(row).getByText('1 Supply Rd, Houston')).toBeInTheDocument();
    expect(within(row).getByText('Stop')).toBeInTheDocument();
    expect(within(row).getByText('10:40 AM')).toBeInTheDocument();
    expect(within(row).getByText('11:10 AM')).toBeInTheDocument();
    expect(within(row).getByText('30m')).toBeInTheDocument();
  });

  it('opens the technician’s day on the map, and offers no correction', () => {
    mount(WITH_STOPS);

    const row = within(dayTable()).getByText('The Home Depot').closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Show The Home Depot on the map' })).toHaveAttribute(
      'href',
      '/map?technician=tech-1&date=2026-10-06',
    );
    expect(within(row).queryByRole('button', { name: /Correct/ })).toBeNull();
  });

  it('calls a stop at home "Home", and never shows the address', () => {
    mount({ ...WITH_STOPS, stops: [{ ...STOP, place: { kind: 'HOME', name: 'Home', address: null } }] });

    expect(within(dayTable()).getByText('Home')).toBeInTheDocument();
  });

  /** The one the office will ask about. */
  it('says when a stop was at a property with no visit booked', () => {
    mount({
      ...WITH_STOPS,
      stops: [{ ...STOP, place: { kind: 'PROPERTY', name: '12 Elsewhere St', address: null } }],
    });

    const row = within(dayTable()).getByText('12 Elsewhere St').closest('tr')!;
    expect(within(row).getByText('No visit booked')).toBeInTheDocument();
    expect(within(row).getByText('A property with no visit booked')).toBeInTheDocument();
  });

  it('says a stop is still being looked up rather than leaving it blank', () => {
    mount({ ...WITH_STOPS, stops: [{ ...STOP, place: null }] });

    expect(within(dayTable()).getByText('Finding the place…')).toBeInTheDocument();
  });

  it('credits OpenStreetMap for the names it gave, and only then', () => {
    const { unmount } = mount(WITH_STOPS);
    expect(screen.getByRole('link', { name: 'OpenStreetMap' })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
    unmount();

    mount({ ...WITH_STOPS, stops: [{ ...STOP, place: { kind: 'HOME', name: 'Home', address: null } }] });
    expect(screen.queryByRole('link', { name: 'OpenStreetMap' })).toBeNull();
  });

  /** The server leaves the list out for somebody who may not see positions. */
  it('shows somebody who may not see where only the minutes, and no places', () => {
    mount({ ...SHEET, totals: WITH_STOPS.totals });

    expect(screen.queryByText('The Home Depot')).toBeNull();
    expect(table('Time at each property')).toBeInTheDocument();
    const row = within(table('Hours by technician')).getByText('Moses Rodriguez').closest('tr')!;
    expect(within(row).getByText('30m')).toBeInTheDocument();
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

/**
 * What the technician was there to do (the office, 2026-10-17): the kind of
 * visit, from the visits the app already has, and nothing invented when none
 * matches.
 */
describe('the job at each property', () => {
  it('names the kind of visit and links to it', () => {
    mount();

    const row = within(table('Time at each property')).getByText('1902 Mockup Dr').closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Move-out' })).toHaveAttribute('href', '/inspections/insp-1');
  });

  it('names both when the technician had two visits there, and says it was the benefit package', () => {
    mount({
      ...SHEET,
      visits: [
        {
          ...VISIT,
          jobs: [
            { inspectionId: 'insp-1', type: 'OCCUPIED', benefitPackage: true, status: 'SCHEDULED' },
            { inspectionId: 'insp-2', type: 'HVAC', benefitPackage: true, status: 'SCHEDULED' },
          ],
        },
      ],
    });

    const row = within(table('Time at each property')).getByText('1902 Mockup Dr').closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Occupied' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'HVAC' })).toHaveAttribute('href', '/inspections/insp-2');
    expect(within(row).getByText('Benefit package')).toBeInTheDocument();
  });

  it('says a visit was cancelled rather than passing it off as the job', () => {
    mount({
      ...SHEET,
      visits: [{ ...VISIT, jobs: [{ ...VISIT.jobs[0]!, status: 'CANCELLED' }] }],
    });

    expect(screen.getByRole('link', { name: 'Move-out (cancelled)' })).toBeInTheDocument();
  });

  it('says so plainly when no visit matches, rather than guessing', () => {
    mount({ ...SHEET, visits: [{ ...VISIT, jobs: [] }] });

    const row = within(table('Time at each property')).getByText('1902 Mockup Dr').closest('tr')!;
    expect(within(row).getByText('No visit booked')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
  });
});

describe('correcting the time at a property', () => {
  it('will not save a correction without a reason, and says how long one has to be', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Correct the time at 1902 Mockup Dr' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save the correction' })).toBeDisabled();
    expect(within(dialog).getByLabelText('Why')).toHaveAccessibleDescription(/At least 4 characters/);
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
 * Which technician the page is showing is said in the toolbar, not only
 * implied by a name somebody clicked in the table.
 */
describe('one technician at a time', () => {
  it('filters to a technician from their name in the table, and says so in the toolbar', () => {
    mount();

    fireEvent.click(within(table('Hours by technician')).getByRole('button', { name: 'Moses Rodriguez' }));

    expect(hooks.useTimesheet.mock.calls.at(-1)).toEqual([TODAY, 'tech-1']);
    expect(screen.getByRole('combobox', { name: 'Technician' })).toHaveTextContent('Moses Rodriguez');
  });

  it('starts on every technician', () => {
    mount();

    expect(screen.getByRole('combobox', { name: 'Technician' })).toHaveTextContent('All technicians');
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

  /** A result belongs to the day it was asked on, and is announced when it arrives. */
  it('lets go of the result once the day changes', async () => {
    mount();
    await choose('This day');
    const onSuccess = recalculate.mutate.mock.calls[0]![1].onSuccess as (result: unknown) => void;
    act(() => onSuccess({ days: 1, technicians: 1, changed: 0 }));

    const said = screen.getByText(/This day already says what the trail says/);
    expect(said).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(screen.getByRole('button', { name: 'The day before' }));
    expect(screen.queryByText(/This day already says what the trail says/)).not.toBeInTheDocument();
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

/**
 * The Jobber-style layout (the office, 2026-11-04): one row per technician
 * that opens into their day -- each property, each drive and each stop, with
 * the store's name and what kind of place it is.
 */
describe('in the Jobber-style layout', () => {
  /** 10:00 to 10:40 in Texas: from the house to the store. */
  const TO_STORE = {
    key: 'seg-5',
    technicianId: 'tech-1',
    technician: 'Moses Rodriguez',
    startedAt: '2026-10-06T15:00:00.000Z',
    endedAt: '2026-10-06T15:40:00.000Z',
    durationSeconds: 2_400,
    quietSeconds: 0,
    fromKey: VISIT.key,
    toKey: STOP.key,
  };
  const DAY_IN_FULL = {
    ...WITH_STOPS,
    stops: [{ ...STOP, place: { ...STOP.place, category: 'shop=doityourself' } }],
    drives: [TO_STORE],
  };

  function mountJobber(sheet: unknown = DAY_IN_FULL) {
    hooks.useTimesheet.mockReturnValue({ isLoading: false, isError: false, data: sheet, refetch: vi.fn() });
    hooks.useTimesheetActions.mockReturnValue({ correct, recalculate });
    return render(
      <ConsoleShellProvider shell="jobber">
        <TimesheetPage />
      </ConsoleShellProvider>,
    );
  }

  it('leads with the day’s on site, driving, stops and total', () => {
    mountJobber();

    const glance = screen.getByRole('region', { name: 'The day at a glance' });
    expect(within(glance).getByText('On site').parentElement).toHaveTextContent('5h');
    expect(within(glance).getByText('Driving').parentElement).toHaveTextContent('1h 30m');
    expect(within(glance).getByText('Stops').parentElement).toHaveTextContent('30m');
    expect(within(glance).getByText('Total').parentElement).toHaveTextContent('7h');
  });

  it('opens the day of a technician into each property, drive and stop, in order', () => {
    mountJobber();

    // One technician on the day: already open.
    const row = screen.getByRole('button', { name: /Moses Rodriguez/ });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const lines = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(lines.map((line) => line.textContent)).toEqual([
      expect.stringContaining('Move-out'),
      expect.stringContaining('From 1902 Mockup Dr to The Home Depot'),
      expect.stringContaining('The Home Depot'),
    ]);
    // The drive, how long it took, and when.
    expect(lines[1]).toHaveTextContent('40m');
    expect(lines[1]).toHaveTextContent('10:00 AM');
    expect(lines[1]).toHaveTextContent('10:40 AM');
  });

  it('names the store, what kind of place it is, and its address', () => {
    mountJobber();

    const store = within(screen.getByRole('table')).getAllByRole('row')[3]!;
    expect(store).toHaveTextContent('The Home Depot');
    expect(store).toHaveTextContent('Home improvement store');
    expect(store).toHaveTextContent('1 Supply Rd, Houston');
    expect(within(store).getByRole('link', { name: 'Show The Home Depot on the map' })).toHaveAttribute(
      'href',
      '/map?technician=tech-1&date=2026-10-06',
    );
  });

  it('links each visit to its inspection, and corrects it from the same row', () => {
    mountJobber();

    expect(screen.getByRole('link', { name: 'Move-out' })).toHaveAttribute('href', '/inspections/insp-1');
    fireEvent.click(screen.getByRole('button', { name: 'Correct the time at 1902 Mockup Dr' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Correct the time at 1902 Mockup Dr');
  });

  it('starts with several technicians closed, and opens them all at once', () => {
    const second = { ...SHEET.totals[0]!, technicianId: 'tech-2', technician: 'Jordan Hale' };
    mountJobber({ ...DAY_IN_FULL, totals: [...DAY_IN_FULL.totals, second] });

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  /** The minutes are everybody's; where a technician stopped is not. */
  it('tells somebody who may not see where only that the drive went to a stop', () => {
    mountJobber({ ...SHEET, drives: [TO_STORE] });

    expect(screen.getByText('From 1902 Mockup Dr to a stop')).toBeInTheDocument();
    expect(screen.queryByText('The Home Depot')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /on the map/ })).not.toBeInTheDocument();
  });

  it('credits OpenStreetMap for the names it gave', () => {
    mountJobber();

    expect(screen.getByRole('link', { name: 'OpenStreetMap' })).toBeInTheDocument();
  });
});

describe('the kind of place, in the classic layout too', () => {
  it('says a stop was a home improvement store beside its name', () => {
    mount({ ...WITH_STOPS, stops: [{ ...STOP, place: { ...STOP.place, category: 'shop=doityourself' } }] });

    expect(screen.getByText('Home improvement store')).toBeInTheDocument();
  });
});
