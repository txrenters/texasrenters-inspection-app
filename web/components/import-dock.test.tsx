import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ImportDockProvider } from './import-dock';
import type { RunningImport } from '@/lib/queries';

/**
 * The drawer an import lives in from beginning to end.
 *
 * Importing used to be three acts with the reader present for all of them: a
 * dialog that could not be closed while the file went up, a wait, and then a
 * review step that had to be found and pressed. The middle act was invisible
 * and the last one was skipped — eleven reports sat parsed and never written
 * in, every one an inspection showing zero areas.
 *
 * Now the dialog hands the file over and closes. The drawer carries the upload,
 * the server reads and applies the report, and the only thing asked of anybody
 * is to read a notification saying it landed.
 */

let imports: RunningImport[] = [];
const startImport = vi.fn();
const success = vi.fn();
const failure = vi.fn();
const push = vi.fn();

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => failure(...a),
  },
}));
vi.mock('@/lib/queries', () => ({
  useRunningImports: () => ({ data: imports }),
  useAdminMutations: () => ({ startInspectionImport: { mutateAsync: startImport } }),
}));

const job = (overrides: Partial<RunningImport> = {}): RunningImport => ({
  id: 'job-1',
  inspectionId: 'inspection-1',
  status: 'RUNNING',
  state: 'READING',
  errorCode: null,
  awaitingReview: false,
  address: '1547 Revolution Way',
  inspectionType: 'MOVE_IN',
  ...overrides,
});

beforeEach(() => {
  imports = [];
  // Never settles, so an upload under test stays in flight and visible.
  startImport.mockReset().mockReturnValue(new Promise(() => {}));
  success.mockReset();
  failure.mockReset();
  push.mockReset();
  window.localStorage.clear();
});

describe('what the drawer shows', () => {
  it('renders nothing but an anchor when nothing is happening', () => {
    // An empty drawer is still a rectangle over the corner where this console
    // puts its form buttons. There is nothing to report, so there is nothing
    // there — only the invisible target the minimise animation flies into.
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a report being read', () => {
    imports = [job()];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByText('1547 Revolution Way')).toBeTruthy();
    expect(screen.getByText(/reading the report/i)).toBeTruthy();
  });

  it('does not count a finished import as work in progress', () => {
    // A finished job lingers briefly so it can be announced. Counting it would
    // claim two things are happening when one already stopped.
    imports = [job({ id: 'done', state: 'IMPORTED' }), job({ id: 'busy', state: 'READING' })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByText(/1 import in progress/i)).toBeTruthy();
  });

  it('closes to a handle and comes back', () => {
    imports = [job()];
    render(<ImportDockProvider>page</ImportDockProvider>);

    fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));
    expect(screen.queryByText('1547 Revolution Way')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show 1 import in progress/i }));
    expect(screen.getByText('1547 Revolution Way')).toBeTruthy();
  });

  it('remembers being closed across a reload', () => {
    imports = [job()];
    const first = render(<ImportDockProvider>page</ImportDockProvider>);
    fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));
    first.unmount();

    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByRole('button', { name: /show 1 import in progress/i })).toBeTruthy();
  });

  it('survives storage being unavailable', () => {
    // Private windows throw on access rather than returning null. Losing the
    // preference is fine; taking the shell down with it is not.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    imports = [job()];
    expect(() => render(<ImportDockProvider>page</ImportDockProvider>)).not.toThrow();
    getItem.mockRestore();
  });
});

describe('announcing what happened', () => {
  it('says when a report has been written in', () => {
    imports = [job({ state: 'IMPORTED' })];
    render(<ImportDockProvider>page</ImportDockProvider>);

    expect(success).toHaveBeenCalledWith(
      '1547 Revolution Way imported',
      expect.objectContaining({ description: expect.stringContaining('on the inspection now') }),
    );
  });

  it('says when one failed, rather than dropping it quietly', () => {
    // A row leaving the list is ambiguous on its own — it means written in, or
    // it means failed. Announcing success on a disappearance would be a
    // cheerful lie, and believing an import happened when it did not is the
    // exact failure this whole feature has been fixing.
    imports = [job({ state: 'FAILED', errorCode: 'REPORT_NOT_READABLE' })];
    render(<ImportDockProvider>page</ImportDockProvider>);

    expect(failure).toHaveBeenCalledWith(
      '1547 Revolution Way could not be imported',
      expect.objectContaining({ description: 'REPORT_NOT_READABLE' }),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it('says nothing while a report is still being read', () => {
    imports = [job({ state: 'READING' })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it('announces once, not on every poll', () => {
    // A finished job stays in the list for a window so it can be announced.
    // Without the guard, every poll in that window would repeat itself.
    imports = [job({ state: 'IMPORTED' })];
    const view = render(<ImportDockProvider>page</ImportDockProvider>);
    view.rerender(<ImportDockProvider>page</ImportDockProvider>);
    view.rerender(<ImportDockProvider>page</ImportDockProvider>);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('offers a way to the inspection that just filled in', () => {
    imports = [job({ state: 'IMPORTED' })];
    render(<ImportDockProvider>page</ImportDockProvider>);

    const action = success.mock.calls[0][1].action as { label: string; onClick: () => void };
    expect(action.label).toBe('Open');
    action.onClick();
    expect(push).toHaveBeenCalledWith('/inspections/inspection-1');
  });
});
