import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TimesheetPage from './page';

/**
 * The hours a technician is paid for.
 *
 * What is pinned here is what the office must not be able to miss. The page
 * replaces a button somebody could forget to press, and the way it fails a
 * technician is not by crashing -- it is by quietly showing a number that is
 * short and looks complete.
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

const idle = { mutate: vi.fn(), isPending: false };
const fill = { mutate: vi.fn(), isPending: false };

const SHEET = {
  from: '2026-09-10',
  to: '2026-09-23',
  totals: [
    {
      technicianId: 'tech-1',
      technician: 'Moses Rodriguez',
      onsiteSeconds: 18_000,
      drivingSeconds: 3_600,
      generalSeconds: 900,
      unsettledGapSeconds: 14_400,
    },
  ],
  segments: [
    {
      id: 'seg-1',
      technicianId: 'tech-1',
      technician: 'Moses Rodriguez',
      inspectionId: 'insp-1',
      address: '6741 Feldspar St',
      inspectionType: 'OCCUPIED',
      category: 'ONSITE' as const,
      startedAt: '2026-09-23T14:00:00.000Z',
      endedAt: '2026-09-23T19:00:00.000Z',
      durationSeconds: 18_000,
      source: 'AUTOMATIC' as const,
      adjusted: false,
      flag: null,
    },
  ],
  gaps: [
    {
      id: 'gap-1',
      technicianId: 'tech-1',
      technician: 'Moses Rodriguez',
      inspectionId: 'insp-1',
      startedAt: '2026-09-23T19:00:00.000Z',
      endedAt: '2026-09-23T23:00:00.000Z',
      durationSeconds: 14_400,
      resolved: false,
      resolution: null,
    },
  ],
};

function mount(sheet: unknown = SHEET) {
  hooks.useTimesheet.mockReturnValue({ isLoading: false, isError: false, data: sheet, refetch: vi.fn() });
  hooks.useTimesheetActions.mockReturnValue({
    recompute: idle,
    adjust: idle,
    resolveGap: idle,
    fillHours: fill,
  });
  return render(<TimesheetPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions.allowed = true;
  /**
   * A fixed today, because the page opens on the last fortnight.
   *
   * `defaultRange()` is today minus thirteen days, and the fixture below was
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
  it('shows what each technician was on site for', () => {
    mount();

    expect(screen.getAllByText('5h').length).toBeGreaterThan(0);
  });

  /**
   * The failure this page exists to prevent.
   *
   * Four hours nobody can account for must never be folded into the hours, and
   * must never be silently dropped either. Shown as its own figure, in its own
   * words, beside the total it is not part of.
   */
  it('shows unaccounted-for time apart from the hours, and says so', () => {
    mount();

    // The on-site total is the on-site total, not on-site plus the gap.
    expect(screen.queryByText('9h')).not.toBeInTheDocument();
    expect(screen.getAllByText('4h').length).toBeGreaterThan(0);
    expect(screen.getByText(/One stretch of time is unaccounted for/)).toBeInTheDocument();
  });

  it('tells the office the hours are missing until the stretch is settled', () => {
    mount();

    expect(screen.getByText(/missing from the totals above until you do/)).toBeInTheDocument();
  });

  it('says so plainly when every minute is accounted for', () => {
    mount({ ...SHEET, gaps: [], totals: [{ ...SHEET.totals[0], unsettledGapSeconds: 0 }] });

    expect(screen.getByText('Every minute is accounted for')).toBeInTheDocument();
  });
});

describe('what a person changed', () => {
  /**
   * A technician paid from this is entitled to know which numbers came from
   * the trail and which from somebody's decision.
   */
  it('marks a segment a person corrected', () => {
    mount({
      ...SHEET,
      segments: [{ ...SHEET.segments[0], adjusted: true }],
    });

    expect(screen.getByText('Corrected')).toBeInTheDocument();
  });

  it('marks time added by hand rather than read from the trail', () => {
    mount({
      ...SHEET,
      segments: [{ ...SHEET.segments[0], source: 'MANUAL' as const }],
    });

    expect(screen.getByText('Added by hand')).toBeInTheDocument();
  });

  /** Correcting is the office's job; reading it is everybody's. */
  it('offers no correction to somebody who may only read', () => {
    permissions.allowed = false;
    mount();

    expect(screen.queryByRole('button', { name: /Correct this/ })).not.toBeInTheDocument();
  });
});

describe('settling a stretch', () => {
  it('will not settle without an account of what happened', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Settle with no time/ })).toBeDisabled();
  });

  /** Both answers are offered without steering: the work happened, or it did not. */
  it('credits the hours when the office says the work happened', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText(/Phone died/), {
      target: { value: 'Phone died at the Feldspar job.' },
    });
    fireEvent.change(within(dialog).getByPlaceholderText('240'), { target: { value: '240' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Credit 4h/ }));

    expect(idle.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ gapId: 'gap-1', creditedMinutes: 240 }),
      expect.anything(),
    );
  });

  it('settles with nothing credited when none are owed', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText(/Phone died/), {
      target: { value: 'Lunch, off the clock.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Settle with no time' }));

    expect(idle.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ gapId: 'gap-1', creditedMinutes: undefined }),
      expect.anything(),
    );
  });
});

/**
 * The jobs that finished before their hours were being read.
 *
 * Nothing else goes back for them — a submission reads its own job, the sweep
 * looks a few hours back — so if this control is missing the page opens empty
 * on its first day with nothing anybody can press about it.
 */
describe('filling in missing hours', () => {
  it('reads the range the office is looking at, not some other one', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Fill in missing hours/ }));

    expect(fill.mutate).toHaveBeenCalledWith(
      { from: SHEET.from, to: SHEET.to },
      expect.anything(),
    );
  });

  it('says plainly what it could not measure', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Fill in missing hours/ }));
    // The page renders what the server reported, so drive its callback.
    const onSuccess = fill.mutate.mock.calls[0]![1].onSuccess as (r: unknown) => void;
    act(() => onSuccess({ considered: 5, measured: 3, unmeasurable: 2, more: false }));

    expect(screen.getByText(/2 could not be measured/)).toBeInTheDocument();
  });

  it('says when there is more of the range left to do', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Fill in missing hours/ }));
    const onSuccess = fill.mutate.mock.calls[0]![1].onSuccess as (r: unknown) => void;
    act(() => onSuccess({ considered: 100, measured: 100, unmeasurable: 0, more: true }));

    expect(screen.getByText(/press again/)).toBeInTheDocument();
  });

  /** It writes, so it is the office's to press. */
  it('is not offered to somebody who may only read', () => {
    permissions.allowed = false;
    mount();

    expect(screen.queryByRole('button', { name: /Fill in missing hours/ })).not.toBeInTheDocument();
  });
});
