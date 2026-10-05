import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TimesheetPage from './page';

/**
 * The hours a technician worked.
 *
 * What is pinned here is what the office asked the page to say on 2026-10-06:
 * two figures and their total -- on site, and general time -- with nothing
 * left in a third pile to be settled by hand, and with the hours a person
 * changed, or the phone was quiet for, still told apart from the rest.
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

const adjust = { mutate: vi.fn(), isPending: false };
const recalculate = { mutate: vi.fn(), isPending: false };

const ONSITE = {
  id: 'seg-1',
  technicianId: 'tech-1',
  technician: 'Moses Rodriguez',
  inspectionId: 'insp-1',
  address: '6782 Mockup St',
  category: 'ONSITE' as const,
  startedAt: '2026-09-23T14:00:00.000Z',
  endedAt: '2026-09-23T19:00:00.000Z',
  durationSeconds: 18_000,
  quietSeconds: 0,
  source: 'AUTOMATIC' as const,
  adjusted: false,
  flag: null,
};

const GENERAL = {
  ...ONSITE,
  id: 'seg-2',
  inspectionId: null,
  address: null,
  category: 'GENERAL' as const,
  startedAt: '2026-09-23T19:00:00.000Z',
  endedAt: '2026-09-23T21:00:00.000Z',
  durationSeconds: 7_200,
};

const SHEET = {
  from: '2026-09-10',
  to: '2026-09-23',
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
  segments: [ONSITE, GENERAL],
};

function mount(sheet: unknown = SHEET) {
  hooks.useTimesheet.mockReturnValue({ isLoading: false, isError: false, data: sheet, refetch: vi.fn() });
  hooks.useTimesheetActions.mockReturnValue({ adjust, recalculate });
  return render(<TimesheetPage />);
}

const table = (name: string) => screen.getByRole('table', { name });

beforeEach(() => {
  vi.clearAllMocks();
  permissions.allowed = true;
  /**
   * A fixed today, because the page opens on the last fortnight.
   *
   * `defaultRange()` is today minus thirteen days, and the fixture above was
   * written on 2026-09-23 — so "the range the office is looking at" matched it
   * exactly on the day this was written and stopped matching five days later,
   * failing on main for a reason that had nothing to do with the page. The
   * assertion is about the form sending the range it is showing, which is a
   * claim about the page rather than about the date, so the date is held still.
   *
   * `shouldAdvanceTime` so React's own scheduling still runs; a fully frozen
   * clock hangs the renderer.
   */
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${SHEET.to}T12:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
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

  /** Nothing is left over for somebody to settle before the period is paid. */
  it('has nothing to settle', () => {
    mount();

    expect(screen.queryByRole('button', { name: /Settle/ })).not.toBeInTheDocument();
  });

  it('says where a general stretch was: between properties', () => {
    mount();

    const stretches = within(table('Every stretch of time'));
    expect(stretches.getByText('6782 Mockup St')).toBeInTheDocument();
    expect(stretches.getByText('Between properties')).toBeInTheDocument();
  });
});

/**
 * A quiet phone does not stop the clock, so its minutes are inside the hours.
 * They are still not the same kind of minutes, and the page says which.
 */
describe('hours the phone was quiet for', () => {
  it('marks a stretch that was carried through a silence, and for how long', () => {
    mount({ ...SHEET, segments: [{ ...ONSITE, quietSeconds: 2_400 }] });

    expect(screen.getByText('Phone quiet 40m')).toBeInTheDocument();
  });

  it('says nothing about a stretch that was measured the whole way', () => {
    mount();

    expect(screen.queryByText(/^Phone quiet \d/)).not.toBeInTheDocument();
  });
});

describe('what a person changed', () => {
  /**
   * A technician paid from this is entitled to know which numbers came from
   * the trail and which from somebody's decision.
   */
  it('marks a segment a person corrected', () => {
    mount({ ...SHEET, segments: [{ ...ONSITE, adjusted: true }] });

    expect(screen.getByText('Corrected')).toBeInTheDocument();
  });

  it('marks time added by hand rather than read from the trail', () => {
    mount({ ...SHEET, segments: [{ ...ONSITE, source: 'MANUAL' as const }] });

    expect(screen.getByText('Added by hand')).toBeInTheDocument();
  });

  it('will not save a correction without a reason', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Correct this On site time' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save the correction' })).toBeDisabled();
  });

  it('sends a correction with both ends and the reason', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Correct this General time time' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText(/phone was in the van/), {
      target: { value: 'Was at the supplier for the Mockup St job.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the correction' }));

    expect(adjust.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ segmentId: 'seg-2', reason: 'Was at the supplier for the Mockup St job.' }),
      expect.anything(),
    );
  });

  /** Correcting is the office's job; reading it is everybody's. */
  it('offers no correction to somebody who may only read', () => {
    permissions.allowed = false;
    mount();

    expect(screen.queryByRole('button', { name: /Correct this/ })).not.toBeInTheDocument();
  });
});

/**
 * Today and yesterday are read without anybody asking. This is how a change
 * of rule, or a corrected pin, reaches the days behind them.
 */
describe('recalculating', () => {
  it('reads the range the office is looking at, not some other one', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate these days' }));

    expect(recalculate.mutate).toHaveBeenCalledWith({ from: SHEET.from, to: SHEET.to }, expect.anything());
  });

  it('says what changed, and that corrections were left alone', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate these days' }));
    // The page renders what the server reported, so drive its callback.
    const onSuccess = recalculate.mutate.mock.calls[0]![1].onSuccess as (result: unknown) => void;
    act(() => onSuccess({ days: 14, technicians: 2, changed: 9 }));

    expect(screen.getByText(/Read 14 days again. 9 technician-days changed/)).toBeInTheDocument();
    expect(screen.getByText(/corrected by hand were left as they are/)).toBeInTheDocument();
  });

  it('says so plainly when nothing changed', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate these days' }));
    const onSuccess = recalculate.mutate.mock.calls[0]![1].onSuccess as (result: unknown) => void;
    act(() => onSuccess({ days: 14, technicians: 2, changed: 0 }));

    expect(screen.getByText(/Nothing changed/)).toBeInTheDocument();
  });

  /** It writes, so it is the office's to press. */
  it('is not offered to somebody who may only read', () => {
    permissions.allowed = false;
    mount();

    expect(screen.queryByRole('button', { name: 'Recalculate these days' })).not.toBeInTheDocument();
  });
});
