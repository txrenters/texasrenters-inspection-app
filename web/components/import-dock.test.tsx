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
vi.mock('@/lib/queries', () => ({ useRunningImports: () => ({ data: imports }) }));

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
  window.localStorage.clear();
});

describe('getting the dock out of the way', () => {
  it('renders nothing but an anchor when no import is running', () => {
    // An empty dock is still a rectangle over the corner. There is nothing to
    // report, so there should be nothing there.
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('can be hidden, leaving only a way back', () => {
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

  it('remembers being hidden across a reload', () => {
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
    // One finishes on its own; the other needs somebody to look at it.
    imports = [job({ awaitingReview: true })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByText(/waiting for your review/i)).toBeTruthy();
  });
});
