import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { InspectionReportImport } from './inspection-report-import';
import type { ImportJob } from '@/lib/queries';

/**
 * Saying how far along an import is.
 *
 * A report PDF is tens of megabytes. One recent upload spent **165 seconds** in
 * transit — the server logged the request as slow having run no queries at all,
 * because it was purely receiving bytes. Three minutes of a spinner reading
 * "Uploading…" that never moves is indistinguishable from a hang, and was
 * reported as one.
 *
 * The other half is the opposite problem: the dialog can now be closed while an
 * import runs, so whoever started it is usually somewhere else when it lands.
 * Without an announcement the only signal is a page they are no longer looking
 * at quietly gaining areas.
 */

const startImport = vi.fn();
const commitImport = vi.fn();
let job: ImportJob | undefined;
let uploading = false;

const success = vi.fn();
const failure = vi.fn();

vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => success(...a), error: (...a: unknown[]) => failure(...a) } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    startInspectionImport: { mutateAsync: startImport, isPending: uploading, error: null },
    commitInspectionImport: { mutateAsync: commitImport, isPending: false, error: null },
  }),
  useInspectionImportJob: () => ({ data: job }),
  useActiveInspectionImport: () => ({ data: null }),
}));

const totals = { areas: 12, items: 88, photos: 376, defects: 5 };

const committedJob = (overrides: Partial<ImportJob> = {}) =>
  ({
    id: 'job-1',
    status: 'COMPLETED',
    committedAt: '2026-09-05T00:00:00.000Z',
    errorCode: null,
    summary: {
      inspector: null,
      template: null,
      reportDate: null,
      areas: [],
      totals,
      needsReview: { lowConfidenceLabels: [], unrecognisedRows: [], photosWithoutSubject: 0 },
    },
    ...overrides,
  }) as ImportJob;

const pdf = () =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'report.pdf', { type: 'application/pdf' });

function choose(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  startImport.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'RUNNING' });
  commitImport.mockReset();
  success.mockReset();
  failure.mockReset();
  job = undefined;
  uploading = false;
});

describe('reporting how much of the file has gone', () => {
  it('hands the mutation somewhere to report progress', async () => {
    render(<InspectionReportImport inspectionId="inspection-1" />);
    choose(pdf());

    await vi.waitFor(() => expect(startImport).toHaveBeenCalled());
    expect(typeof startImport.mock.calls[0][0].onProgress).toBe('function');
  });

  it('shows the percentage as it arrives', async () => {
    // The whole point: a number that moves, rather than a spinner that does
    // not. `fetch` cannot do this, which is why the upload uses XHR.
    //
    // The upload is left in flight deliberately — a promise that never settles.
    // Letting it resolve would move the component on to the next phase, and the
    // percentage only exists while bytes are actually moving.
    uploading = true;
    startImport.mockImplementation(({ onProgress }: { onProgress: (n: number) => void }) => {
      onProgress(0.42);
      return new Promise(() => {});
    });

    const view = render(<InspectionReportImport inspectionId="inspection-1" />);
    choose(pdf());

    await vi.waitFor(() => expect(startImport).toHaveBeenCalled());
    view.rerender(<InspectionReportImport inspectionId="inspection-1" />);
    await vi.waitFor(() => expect(screen.getByText(/42%/)).toBeTruthy());
  });

  it('falls back to a plain spinner before any progress is known', () => {
    // `lengthComputable` is false when the size is unknown. Reporting 0% for
    // ever would be worse than the spinner it replaces.
    uploading = true;
    render(<InspectionReportImport inspectionId="inspection-1" />);
    expect(screen.getByRole('button', { name: /uploading…$/i })).toBeTruthy();
  });
});

describe('announcing the outcome', () => {
  it('says so when the report has been written in', () => {
    job = committedJob();
    render(<InspectionReportImport inspectionId="inspection-1" />);

    expect(success).toHaveBeenCalledWith(
      'Report imported',
      expect.objectContaining({ description: expect.stringContaining('376 photographs') }),
    );
  });

  it('still says it arrives under review rather than finalized', () => {
    // The import is evidence somebody else recorded, and nobody has confirmed
    // the matches. A success notice that omitted that would imply otherwise.
    job = committedJob();
    render(<InspectionReportImport inspectionId="inspection-1" />);
    expect(success.mock.calls[0][1].description).toContain('under review');
  });

  it('announces once, not on every poll', () => {
    // The job keeps being polled after it commits. Without a guard every answer
    // would raise the same notification again.
    job = committedJob();
    const view = render(<InspectionReportImport inspectionId="inspection-1" />);
    view.rerender(<InspectionReportImport inspectionId="inspection-1" />);
    view.rerender(<InspectionReportImport inspectionId="inspection-1" />);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('announces a failure too', () => {
    job = committedJob({ committedAt: null, status: 'FAILED', errorCode: 'REPORT_NOT_READABLE' });
    render(<InspectionReportImport inspectionId="inspection-1" />);
    expect(failure).toHaveBeenCalledWith(
      'The report could not be imported',
      expect.objectContaining({ description: 'REPORT_NOT_READABLE' }),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it('says nothing while the import is still running', () => {
    job = committedJob({ committedAt: null, status: 'RUNNING' });
    render(<InspectionReportImport inspectionId="inspection-1" />);
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });
});
