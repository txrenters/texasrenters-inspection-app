import { render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { InspectionReportImport } from './inspection-report-import';
import type { ImportJob } from '@/lib/queries';

/**
 * Announcing what became of an import.
 *
 * Upload progress used to be tested here too. It moved to the drawer with the
 * upload itself — the dialog hands the file over and closes now, so it has no
 * progress of its own to report. Those assertions live in
 * `import-dock.test.tsx` beside the code that owns them.
 *
 * What remains is the outcome. Whoever starts an import is usually on another
 * property when it lands, so the only signal that anything happened is what is
 * said about it.
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

beforeEach(() => {
  startImport.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'RUNNING' });
  commitImport.mockReset();
  success.mockReset();
  failure.mockReset();
  job = undefined;
  uploading = false;
});

describe('announcing the outcome', () => {
  it('says so when the report has been written in', () => {
    job = committedJob();
    render(<InspectionReportImport />);

    expect(success).toHaveBeenCalledWith(
      'Report imported',
      expect.objectContaining({ description: expect.stringContaining('376 photographs') }),
    );
  });

  it('still says it arrives under review rather than finalized', () => {
    // The import is evidence somebody else recorded, and nobody has confirmed
    // the matches. A success notice that omitted that would imply otherwise.
    job = committedJob();
    render(<InspectionReportImport />);
    expect(success.mock.calls[0][1].description).toContain('under review');
  });

  it('announces once, not on every poll', () => {
    // The job keeps being polled after it commits. Without a guard every answer
    // would raise the same notification again.
    job = committedJob();
    const view = render(<InspectionReportImport />);
    view.rerender(<InspectionReportImport />);
    view.rerender(<InspectionReportImport />);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('announces a failure too', () => {
    job = committedJob({ committedAt: null, status: 'FAILED', errorCode: 'REPORT_NOT_READABLE' });
    render(<InspectionReportImport />);
    expect(failure).toHaveBeenCalledWith(
      'The report could not be imported',
      expect.objectContaining({ description: 'REPORT_NOT_READABLE' }),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it('says nothing while the import is still running', () => {
    job = committedJob({ committedAt: null, status: 'RUNNING' });
    render(<InspectionReportImport />);
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });
});
