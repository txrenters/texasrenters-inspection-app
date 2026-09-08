import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ImportReportDialog, InspectionReportImport } from './inspection-report-import';
import type { ImportJob } from '@/lib/queries';

/**
 * Picking an import back up.
 *
 * Both halves of an import run detached on the server and finish whether or
 * not anybody is watching. The job id used to live only inside this dialog,
 * though, so closing it lost the handle — the import *looked* abandoned, and
 * the office ran them one at a time waiting for each to finish.
 *
 * Nothing about the work changed. What changed is that the inspection can now
 * be asked what is running against it, so the dialog is closable and a second
 * property can be started immediately.
 */

const startImport = vi.fn();
const commitImport = vi.fn();
let job: ImportJob | undefined;
let active: ImportJob | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  // The dialog reads `?import=<jobId>` so a drawer row can open the review
  // directly. Absent here, so these tests exercise the ordinary entry point.
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    startInspectionImport: { mutateAsync: startImport, isPending: false, error: null },
    commitInspectionImport: { mutateAsync: commitImport, isPending: false, error: null },
  }),
  useInspectionImportJob: () => ({ data: job }),
  useActiveInspectionImport: () => ({ data: active }),
}));

const importJob = (overrides: Partial<ImportJob> = {}) =>
  ({
    id: 'job-1',
    status: 'RUNNING',
    committedAt: null,
    errorCode: null,
    summary: null,
    ...overrides,
  }) as ImportJob;

const pdf = () =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'report.pdf', {
    type: 'application/pdf',
  });

function choose(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  startImport.mockReset().mockResolvedValue({ jobId: 'job-2', status: 'RUNNING' });
  commitImport.mockReset().mockResolvedValue({ jobId: 'job-2' });
  job = undefined;
  active = null;
});

describe('the button that opens the import', () => {
  it('says an import is in progress when one is running', () => {
    // The whole point: somebody arriving at this page can see that the work is
    // already happening, without having been the one who started it.
    active = importJob({ status: 'RUNNING' });
    render(<ImportReportDialog inspectionId="inspection-1" />);
    expect(screen.getByRole('button', { name: /import in progress/i })).toBeTruthy();
  });

  it('offers a fresh import when nothing is running', () => {
    active = null;
    render(<ImportReportDialog inspectionId="inspection-1" />);
    expect(screen.getByRole('button', { name: /import a report/i })).toBeTruthy();
  });

  it('does not call a committed import "in progress"', () => {
    // A finished job is history, not state. Saying otherwise would leave a
    // spinner on a page where nothing is happening.
    active = importJob({ status: 'COMPLETED', committedAt: '2026-09-05T00:00:00.000Z' });
    render(<ImportReportDialog inspectionId="inspection-1" />);
    expect(screen.getByRole('button', { name: /import a report/i })).toBeTruthy();
  });

  it('does not call a failed import "in progress" either', () => {
    active = importJob({ status: 'FAILED', errorCode: 'REPORT_NOT_READABLE' });
    render(<ImportReportDialog inspectionId="inspection-1" />);
    expect(screen.getByRole('button', { name: /import a report/i })).toBeTruthy();
  });
});

describe('resuming the import the inspection already has', () => {
  it('follows the running job instead of offering to upload again', () => {
    // Without this the reopened dialog would offer a second upload of a report
    // that is already being read, and the file-level guard would reject it.
    job = importJob({ status: 'RUNNING' });
    render(<InspectionReportImport inspectionId="inspection-1" resumeJobId="job-1" />);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('offers the upload when there is nothing to resume', () => {
    render(<InspectionReportImport inspectionId="inspection-1" resumeJobId={null} />);
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('lets a resumed job be discarded without it reappearing', () => {
    // Discarding used to clear only what this session started. With a job
    // arriving as a prop, that would fall straight back to the resumed one and
    // the panel would return — a Cancel button that does nothing.
    job = importJob({
      status: 'COMPLETED',
      summary: {
        inspector: null,
        template: null,
        reportDate: null,
        areas: [],
        totals: { areas: 1, items: 0, photos: 0, defects: 0 },
        needsReview: { lowConfidenceLabels: [], unrecognisedRows: [], photosWithoutSubject: 0 },
      },
    } as Partial<ImportJob>);
    render(<InspectionReportImport inspectionId="inspection-1" resumeJobId="job-1" />);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('accepts a new file after a resumed job was discarded', async () => {
    job = importJob({
      status: 'COMPLETED',
      summary: {
        inspector: null,
        template: null,
        reportDate: null,
        areas: [],
        totals: { areas: 1, items: 0, photos: 0, defects: 0 },
        needsReview: { lowConfidenceLabels: [], unrecognisedRows: [], photosWithoutSubject: 0 },
      },
    } as Partial<ImportJob>);
    render(<InspectionReportImport inspectionId="inspection-1" resumeJobId="job-1" />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    choose(pdf());

    await vi.waitFor(() => expect(startImport).toHaveBeenCalled());
  });
});
