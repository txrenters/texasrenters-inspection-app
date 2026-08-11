import type { PublicInspectionReport } from '@texasrenters/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicApi = vi.fn();

vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'share-token' }) }));
vi.mock('@/lib/api', () => ({
  publicApi: (...args: unknown[]) => publicApi(...args),
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

const { default: PublicReportPage } = await import('./page');

const REPORT: PublicInspectionReport = {
  brand: { name: 'TexasRenters.com', phone: '281-407-3815' },
  property: {
    name: 'Watercrest',
    addressLine1: '302 Watercrest Harbor Ln',
    unitName: null,
    city: 'League City',
    state: 'TX',
    postalCode: '77573',
  },
  inspection: {
    type: 'OCCUPIED',
    status: 'COMPLETED',
    scheduledAt: '2026-07-23T16:00:00.000Z',
    completedAt: '2026-07-23T18:00:00.000Z',
  },
  rooms: [
    {
      id: 'area-1',
      name: 'Kitchen',
      floorName: 'Ground Floor',
      completionStatus: 'COMPLETED',
      skipReason: null,
      completedAt: '2026-07-23T17:00:00.000Z',
      // Deliberately mixed: a fully scored row, a partial one, and a comment.
      // The partial row is what proves an unassessed axis prints blank rather
      // than as "N", which would claim a defect nobody observed.
      checklist: [
        {
          id: 'item-1',
          label: 'Doors and locks',
          isClean: false,
          isUndamaged: false,
          isWorking: true,
          comment: 'scratches on door need to be painted',
        },
        {
          id: 'item-2',
          label: 'Smoke alarms',
          isClean: true,
          isUndamaged: null,
          isWorking: null,
          comment: null,
        },
      ],
    },
    {
      id: 'area-2',
      name: 'Garage',
      floorName: null,
      completionStatus: 'SKIPPED',
      skipReason: 'Vehicle blocking access',
      completedAt: null,
      // A skipped room was never assessed.
      checklist: [],
    },
  ],
  findings: [
    {
      id: 'finding-1',
      roomId: 'area-1',
      roomName: 'Kitchen',
      title: 'Countertop burn mark',
      description: 'A new burn mark beside the stove.',
      category: 'DAMAGE',
      severity: 'HIGH',
      comparisonResult: 'POSSIBLE_NEW_DAMAGE',
      baselineCondition: 'No damage documented at move-in.',
    },
  ],
  photos: [
    {
      id: 'photo-1',
      roomId: 'area-1',
      label: 'Countertop',
      notes: null,
      capturedAt: '2026-07-23T16:12:17.000Z',
      width: 1600,
      height: 1200,
      contentPath: '/api/v1/reports/share-token/photos/photo-1',
    },
  ],
  generatedAt: '2026-07-28T00:00:00.000Z',
};

beforeEach(() => {
  publicApi.mockReset();
  publicApi.mockResolvedValue(REPORT);
});

describe('public inspection report', () => {
  it('renders the summary, room evidence, and a PDF download for the same token', async () => {
    render(<PublicReportPage />);

    expect(await screen.findByText('302 Watercrest Harbor Ln')).toBeInTheDocument();
    expect(screen.getByText('Occupied inspection')).toBeInTheDocument();
    // 1 of 2 rooms completed.
    expect(screen.getByText('1/2')).toBeInTheDocument();
    // Wording comes from the shared view model, not the raw enum.
    expect(screen.getAllByText(/Possible new damage/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('High priority').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Download PDF' })).toHaveAttribute(
      'href',
      '/report/share-token/pdf',
    );
  });

  it('requests bounded-width photos rather than multi-megabyte originals', async () => {
    render(<PublicReportPage />);

    const photo = await screen.findByAltText('Countertop');
    expect(photo.getAttribute('src')).toContain('/api/v1/reports/share-token/photos/photo-1?w=320');
  });

  it('explains a skipped room instead of showing it as inspected', async () => {
    render(<PublicReportPage />);

    expect(await screen.findByText(/Vehicle blocking access/)).toBeInTheDocument();
  });

  it('prints the condition checklist as Y, N and blank', async () => {
    render(<PublicReportPage />);

    const row = (await screen.findByText('Doors and locks')).closest('tr')!;
    const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent);
    // Clean=N, Undamaged=N, Working=Y, then the comment.
    expect(cells).toEqual(['N', 'N', 'Y', 'scratches on door need to be painted']);
  });

  /**
   * The rule the whole checklist rests on. The office's printed reports leave
   * unassessed rows blank, and "not assessed" is a different claim from "No" —
   * printing N here would publish a defect nobody observed.
   */
  it('leaves an unassessed axis blank rather than printing N', async () => {
    render(<PublicReportPage />);

    const row = (await screen.findByText('Smoke alarms')).closest('tr')!;
    const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent);
    expect(cells).toEqual(['Y', '', '', '']);
  });

  it('shows no checklist table for a room that was never assessed', async () => {
    const { container } = render(<PublicReportPage />);
    await screen.findByText('Doors and locks');

    // Two rooms in the fixture, one of them skipped with an empty checklist.
    // An empty table would read as "assessed and found nothing" rather than
    // "not assessed", so the skipped room must render none at all.
    expect(container.querySelectorAll('.report-checklist')).toHaveLength(1);
  });

  it('shows a recoverable message when the link is expired or revoked', async () => {
    const { ApiError } = await import('@/lib/api');
    publicApi.mockRejectedValue(new ApiError(404, 'REPORT_NOT_AVAILABLE', 'gone'));

    render(<PublicReportPage />);

    await waitFor(() => expect(screen.getByText('Report unavailable')).toBeInTheDocument());
    expect(screen.getByText(/invalid, expired, or has been revoked/)).toBeInTheDocument();
  });
});
