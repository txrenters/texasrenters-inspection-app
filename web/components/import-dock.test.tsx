import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ImportDockProvider } from './import-dock';
import type { RunningImport } from '@/lib/queries';

/**
 * The dock has to be dismissible.
 *
 * It sits over the bottom-right corner, which is where this console puts the
 * buttons on almost every form — so an import running in the background made
 * those buttons unclickable. A progress indicator that blocks the work it
 * reports on is worse than no indicator.
 */

let imports: RunningImport[] = [];

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { info: (...a: unknown[]) => notify(...a) } }));
vi.mock('@/lib/queries', () => ({ useRunningImports: () => ({ data: imports }) }));

const notify = vi.fn();

const job = (overrides: Partial<RunningImport> = {}): RunningImport => ({
  id: 'job-1',
  inspectionId: 'inspection-1',
  status: 'RUNNING',
  awaitingReview: false,
  address: '1547 Revolution Way',
  inspectionType: 'MOVE_IN',
  ...overrides,
});

beforeEach(() => {
  imports = [];
  notify.mockReset();
  window.localStorage.clear();
});

describe('the import drawer', () => {
  it('renders nothing but an anchor when no import is running', () => {
    // An empty dock is still a rectangle over the corner. There is nothing to
    // report, so there should be nothing there.
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('closes to a handle, leaving only a way back', () => {
    imports = [job()];
    render(<ImportDockProvider>page</ImportDockProvider>);

    fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: /show 1 running import$/i })).toBeTruthy();
  });

  it('comes back when asked', () => {
    imports = [job()];
    render(<ImportDockProvider>page</ImportDockProvider>);
    fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));

    fireEvent.click(screen.getByRole('button', { name: /show 1 running import/i }));

    expect(screen.getByText('1547 Revolution Way')).toBeTruthy();
  });

  it('remembers being closed across a reload', () => {
    // The whole point. Re-collapsing it on every page would make the fix
    // useless to somebody working through a queue of imports.
    imports = [job()];
    const first = render(<ImportDockProvider>page</ImportDockProvider>);
    fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));
    first.unmount();

    render(<ImportDockProvider>page</ImportDockProvider>);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: /show 1 running import/i })).toBeTruthy();
  });

  it('counts what is hidden, so it is not silence', () => {
    imports = [job(), job({ id: 'job-2', address: '12009 Tambourine Dr' })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));

    expect(screen.getByRole('button', { name: /show 2 running imports/i })).toBeTruthy();
  });

  it('survives storage being unavailable', () => {
    // Private windows and some embedded contexts throw on access rather than
    // returning null. Losing the preference is fine; taking the shell down
    // with it is not.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    imports = [job()];

    expect(() => {
      render(<ImportDockProvider>page</ImportDockProvider>);
      fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));
    }).not.toThrow();

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('still distinguishes the two kinds of waiting while expanded', () => {
    // One finishes on its own; the other needs somebody to act. The wording
    // moved from describing the state to naming the action, because describing
    // it left eleven reports parsed and never written in.
    imports = [job({ awaitingReview: true })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByText(/open and press import to finish/i)).toBeTruthy();
  });
});

/**
 * Telling somebody a report needs them.
 *
 * The dialog minimises itself when the upload finishes, which is right — the
 * file is safe and the reading takes minutes. But the reading ends at a
 * decision only a person can make, and nothing said so: eleven reports sat
 * parsed and uncommitted in production, each one an inspection still showing
 * zero areas, because everybody believed the import had happened.
 */
describe('asking the reader back', () => {
  it('says when a report is ready to import', () => {
    imports = [job({ awaitingReview: true })];
    render(<ImportDockProvider>page</ImportDockProvider>);

    expect(notify).toHaveBeenCalledWith(
      '1547 Revolution Way is ready to import',
      expect.objectContaining({ description: expect.stringContaining('press Import') }),
    );
  });

  it('says nothing while a report is still being read', () => {
    // That one finishes on its own. Announcing it would train people to ignore
    // the notice that actually asks for something.
    imports = [job({ awaitingReview: false })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces each report once, not on every poll', () => {
    // The list is polled every few seconds. Without the guard, a queue of
    // waiting reports would re-announce itself continuously.
    imports = [job({ awaitingReview: true })];
    const view = render(<ImportDockProvider>page</ImportDockProvider>);
    view.rerender(<ImportDockProvider>page</ImportDockProvider>);
    view.rerender(<ImportDockProvider>page</ImportDockProvider>);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('counts the two states apart instead of calling both running', () => {
    // "11 imports running" while nothing was running is what made the drawer
    // unreadable — the number that mattered was how many needed a person.
    imports = [
      job({ awaitingReview: true }),
      job({ id: 'job-2', awaitingReview: true, address: '323 Lakeview Dr' }),
      job({ id: 'job-3', awaitingReview: false, address: '12009 Tambourine Dr' }),
    ];
    render(<ImportDockProvider>page</ImportDockProvider>);

    expect(screen.getByText(/2 need your review/i)).toBeTruthy();
    expect(screen.getByText(/1 reading/i)).toBeTruthy();
  });

  it('tells a row what to do rather than what it is', () => {
    imports = [job({ awaitingReview: true })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByText(/open and press import to finish/i)).toBeTruthy();
  });

  it('puts the ones needing a person first', () => {
    imports = [
      job({ id: 'reading', awaitingReview: false, address: 'Still reading' }),
      job({ id: 'ready', awaitingReview: true, address: 'Needs you' }),
    ];
    render(<ImportDockProvider>page</ImportDockProvider>);

    const rows = screen.getAllByRole('link').map((link) => link.textContent ?? '');
    expect(rows[0]).toContain('Needs you');
  });
});

/**
 * A row has to land on the decision, not near it.
 *
 * It used to link at the inspection and stop there, leaving the reader to find
 * the button that opens the review. On the page they were already on, clicking
 * navigated to the same URL and nothing visibly happened at all — which is what
 * eleven un-imported reports looked like from the outside.
 */
describe('where a row takes you', () => {
  it('links to the review, not just the inspection', () => {
    imports = [job({ id: 'job-7', inspectionId: 'inspection-9', awaitingReview: true })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      '/inspections/inspection-9?import=job-7',
    );
  });

  it('carries the job id, so the right report is opened', () => {
    // Two reports can be waiting on one inspection — two of the eleven were.
    // Linking at the inspection alone could not say which.
    imports = [
      job({ id: 'first', inspectionId: 'same', awaitingReview: true, address: 'A' }),
      job({ id: 'second', inspectionId: 'same', awaitingReview: true, address: 'B' }),
    ];
    render(<ImportDockProvider>page</ImportDockProvider>);
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/inspections/same?import=first');
    expect(hrefs).toContain('/inspections/same?import=second');
  });

  it('does not invent a link for a job with no inspection', () => {
    imports = [job({ inspectionId: null, awaitingReview: true })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByRole('link').getAttribute('href')).toBe('#');
  });
});
