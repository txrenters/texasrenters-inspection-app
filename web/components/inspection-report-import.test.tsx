import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { InspectionReportImport } from './inspection-report-import';
import type { ImportJob } from '@/lib/queries';

/**
 * Importing a report somebody else's system produced.
 *
 * The two things worth pinning are both about honesty. The reading happens on
 * the server, so the page must not claim it will be lost — and the reader will
 * not guess, so what it could not resolve has to be visible before anybody
 * presses import.
 */

const startImport = vi.fn();
const commitImport = vi.fn();
let job: ImportJob | undefined;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    startInspectionImport: { mutateAsync: startImport, isPending: false, error: null },
    commitInspectionImport: { mutateAsync: commitImport, isPending: false, error: null },
  }),
  useInspectionImportJob: () => ({ data: job }),
  usePropertyOptions: () => ({
    data: { pages: [{ items: [{ id: 'property-1', name: '17307 Nordway' }] }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));

const summary = (overrides: Partial<NonNullable<ImportJob['summary']>> = {}) => ({
  inspector: 'Amy Wilson',
  template: 'Ingoing Inspection',
  reportDate: 'SEP-02-2026',
  areas: [
    {
      name: 'BATHROOM',
      items: 9,
      assessed: 8,
      photos: 43,
      defects: [{ item: 'Bath, shower and taps', comment: 'Drain not working', failed: ['not working'] }],
    },
  ],
  totals: { areas: 12, items: 88, photos: 376, defects: 5 },
  needsReview: { lowConfidenceLabels: [], unrecognisedRows: [], photosWithoutSubject: 0 },
  ...overrides,
});

const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'report.pdf', {
  type: 'application/pdf',
});

/** Picks the one property the mocked options offer. */
function pickProperty() {
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(screen.getByText('17307 Nordway'));
}

function choose(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  startImport.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'RUNNING' });
  commitImport.mockReset().mockResolvedValue({ inspectionId: 'inspection-1', areas: 12, photos: 376 });
  job = undefined;
});

describe('importing an inspection report', () => {
  it('says the reading survives the page, because it does', async () => {
    // The opposite of what people expect of an upload, so it is said plainly.
    // Warning about work that is not at risk is how people learn to ignore
    // warnings that matter.
    job = { id: 'job-1', status: 'RUNNING', method: 'DETERMINISTIC', provider: null, errorCode: null, inspectionId: null, summary: null };
    render(<InspectionReportImport />);
    pickProperty();
    choose(pdf());

    expect(await screen.findByText(/keeps running if you close the page/i)).toBeTruthy();
  });

  it('will not send a file that is not a PDF', async () => {
    render(<InspectionReportImport />);
    pickProperty();
    choose(new File(['x'], 'notes.txt', { type: 'text/plain' }));

    expect(await screen.findByText(/not a PDF/i)).toBeTruthy();
    expect(startImport).not.toHaveBeenCalled();
  });

  it('will not send a report before a property is chosen', async () => {
    // Reached from the move-in list now, so the destination is not implied by
    // the page. A report read with nowhere to land fails minutes later as a
    // server error, long after the person has moved on.
    render(<InspectionReportImport />);
    choose(pdf());

    expect(await screen.findByText(/choose the property this report covers first/i)).toBeTruthy();
    expect(startImport).not.toHaveBeenCalled();
  });

  it('sends the chosen property with the report', async () => {
    render(<InspectionReportImport />);
    pickProperty();
    choose(pdf());

    await waitFor(() =>
      expect(startImport).toHaveBeenCalledWith(
        expect.objectContaining({ propertyId: 'property-1' }),
      ),
    );
  });

  it('shows what the reader could not resolve before anything is written', async () => {
    // This is the whole reason the import is two steps. A confirmation screen
    // that hid these would be a formality.
    job = {
      id: 'job-1',
      status: 'COMPLETED',
      method: 'DETERMINISTIC',
      provider: null,
      errorCode: null,
      inspectionId: null,
      summary: summary({
        needsReview: {
          lowConfidenceLabels: [
            { area: 'BATHROOM', sourceLabel: 'BASIN, CABINET VANITY & MIRROR', matched: 'Basin, vanity and mirror', score: 0.75 },
          ],
          unrecognisedRows: [{ area: 'HALLWAY', page: 45, text: 'SMOKE DETECTOR EXPIRED' }],
          photosWithoutSubject: 2,
        },
      }),
    };
    render(<InspectionReportImport />);
    pickProperty();
    choose(pdf());

    // JSX splits "{n} things to check" into two text nodes, so the heading is
    // found by its static half and the count read off the element around it.
    const heading = await screen.findByText(/things to check before importing/i);
    // Three entries, not four: two unmatched photographs are one line.
    expect(heading.textContent).toMatch(/^3 things/);
    expect(screen.getByText(/BASIN, CABINET VANITY & MIRROR/)).toBeTruthy();
    expect(screen.getByText(/will not be imported/i)).toBeTruthy();
  });

  it('says when a model did the reading rather than the parser', async () => {
    // An imported inspection is evidence, and whether it was measured or
    // inferred is part of it.
    job = { id: 'job-1', status: 'COMPLETED', method: 'AI', provider: 'ANTHROPIC', errorCode: null, inspectionId: null, summary: summary() };
    render(<InspectionReportImport />);
    pickProperty();
    choose(pdf());

    expect(await screen.findByText(/read by AI/i)).toBeTruthy();
  });

  it('does not import until somebody presses the button', async () => {
    job = { id: 'job-1', status: 'COMPLETED', method: 'DETERMINISTIC', provider: null, errorCode: null, inspectionId: null, summary: summary() };
    render(<InspectionReportImport />);
    pickProperty();
    choose(pdf());

    await screen.findByRole('button', { name: /import as a move-in inspection/i });
    expect(commitImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /import as a move-in inspection/i }));
    await waitFor(() => expect(commitImport).toHaveBeenCalledWith('job-1'));
  });

  it('explains a failure in terms somebody can act on', async () => {
    job = {
      id: 'job-1',
      status: 'FAILED',
      method: 'DETERMINISTIC',
      provider: null,
      errorCode: 'REPORT_NOT_RECOGNISED_NO_AI',
      inspectionId: null,
      summary: null,
    };
    render(<InspectionReportImport />);
    pickProperty();
    choose(pdf());

    expect(await screen.findByText(/no AI provider is configured/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try another file/i })).toBeTruthy();
  });
});
