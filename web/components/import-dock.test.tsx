import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ImportDockProvider, useImportDock } from './import-dock';
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

/** Stands in for the import dialog, which hands its file over and closes. */
function Hander() {
  const dock = useImportDock();
  return (
    <button
      onClick={() =>
        dock?.upload({
          inspectionId: 'inspection-2',
          address: '12009 Tambourine',
          file: new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }),
        })
      }
      type="button"
    >
      hand over
    </button>
  );
}

describe('what the drawer shows', () => {
  it('still offers its handle when nothing is happening', () => {
    /**
     * It used to render nothing at all when idle, which made the drawer
     * unfindable: the only way to see running imports was to already have one
     * running. Somebody who started an import, walked to the next property and
     * came back had no way left to ask what had happened to it.
     */
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByRole('button', { name: /show imports/i })).toBeTruthy();
    // Nothing is running, so nothing claims to be.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says so rather than opening onto a blank panel', () => {
    // Opening the drawer asks "is anything still going?", and an empty box
    // does not answer it — it reads as something that failed to load.
    render(<ImportDockProvider>page</ImportDockProvider>);
    fireEvent.click(screen.getByRole('button', { name: /show imports/i }));
    expect(screen.getByText(/no imports running/i)).toBeTruthy();
  });

  it('opens itself when a file is handed over here', async () => {
    // The dialog closes as soon as it has the file, so without this the whole
    // visible result of choosing a report is a dialog disappearing while the
    // bytes go up behind a closed drawer.
    render(
      <ImportDockProvider>
        <Hander />
      </ImportDockProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /hand over/i }));
    expect(await screen.findByText('12009 Tambourine')).toBeTruthy();
  });

  it('starts closed, so an idle drawer does not sit over the page', () => {
    // The old default was open-unless-closed, which was right while the dock
    // vanished when idle. Now that the handle is permanent, that default puts
    // a panel over the right-hand side of every page saying nothing is
    // happening.
    imports = [job()];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.queryByText('1547 Revolution Way')).toBeNull();
    expect(screen.getByRole('button', { name: /show 1 import in progress/i })).toBeTruthy();
  });

  it('shows a report being read', () => {
    imports = [job()];
    render(<ImportDockProvider>page</ImportDockProvider>);
    fireEvent.click(screen.getByRole('button', { name: /show 1 import in progress/i }));
    expect(screen.getByText('1547 Revolution Way')).toBeTruthy();
    expect(screen.getByText(/reading the report/i)).toBeTruthy();
  });

  it('does not count a finished import as work in progress', () => {
    // A finished job lingers briefly so it can be announced. Counting it would
    // claim two things are happening when one already stopped.
    imports = [job({ id: 'done', state: 'IMPORTED' }), job({ id: 'busy', state: 'READING' })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByRole('button', { name: /show 1 import in progress/i })).toBeTruthy();
  });

  it('opens to a list and closes back to a handle', () => {
    imports = [job()];
    render(<ImportDockProvider>page</ImportDockProvider>);

    fireEvent.click(screen.getByRole('button', { name: /show 1 import in progress/i }));
    expect(screen.getByText('1547 Revolution Way')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /hide running imports/i }));
    expect(screen.queryByText('1547 Revolution Way')).toBeNull();
  });

  it('remembers being opened across a reload', () => {
    // The preference is the whole reason storage is touched at all: somebody
    // watching a backlog land should not have to reopen this on every route.
    imports = [job()];
    const first = render(<ImportDockProvider>page</ImportDockProvider>);
    fireEvent.click(screen.getByRole('button', { name: /show 1 import in progress/i }));
    first.unmount();

    render(<ImportDockProvider>page</ImportDockProvider>);
    expect(screen.getByText('1547 Revolution Way')).toBeTruthy();
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
    expect(push).toHaveBeenCalledWith('/inspections/inspection-1?import=job-1');
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
    // The dock starts collapsed now — the button is always on screen and the
    // rows are behind it — so it has to be opened before there are any rows to
    // ask about. These three were written before that change.
    fireEvent.click(screen.getByRole('button', { name: /show .*import/i }));
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
    // The dock starts collapsed now — the button is always on screen and the
    // rows are behind it — so it has to be opened before there are any rows to
    // ask about. These three were written before that change.
    fireEvent.click(screen.getByRole('button', { name: /show .*import/i }));
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/inspections/same?import=first');
    expect(hrefs).toContain('/inspections/same?import=second');
  });

  it('does not invent a link for a job with no inspection', () => {
    imports = [job({ inspectionId: null, awaitingReview: true })];
    render(<ImportDockProvider>page</ImportDockProvider>);
    // The dock starts collapsed now — the button is always on screen and the
    // rows are behind it — so it has to be opened before there are any rows to
    // ask about. These three were written before that change.
    fireEvent.click(screen.getByRole('button', { name: /show .*import/i }));
    expect(screen.getByRole('link').getAttribute('href')).toBe('#');
  });
});
