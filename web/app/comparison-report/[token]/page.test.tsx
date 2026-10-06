import type { ComparisonReport } from '@texasrenters/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ComparisonReportPage from './page';

/**
 * The move-in / move-out comparison an owner or tenant opens from a link (the
 * office, 2026-10-06).
 */

const state = vi.hoisted(() => ({
  respond: (() => Promise.resolve(null)) as () => Promise<unknown>,
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, publicApi: () => state.respond() };
});
vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'token-1' }) }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { alt: string }) => <img alt={props.alt} />,
}));

const REPORT: ComparisonReport = {
  brand: { name: 'TexasRenters.com' },
  property: {
    name: 'Notional',
    addressLine1: '318 Notional Harbor Ln',
    unitName: null,
    city: 'League City',
    state: 'TX',
    postalCode: '77573',
  },
  comparison: {
    id: 'comparison-1',
    status: 'APPROVED',
    version: 4,
    overallCondition: 'NEW_DAMAGE',
    requiresReviewCount: 1,
    summary: 'Compared 1 area. 1 needs human review. Overall: NEW_DAMAGE.',
    generatedAt: '2026-10-06T15:00:00.000Z',
    reviewedByName: 'Ana Lopez',
    reviewedAt: '2026-10-06T16:00:00.000Z',
    reviewNote: null,
  },
  moveIn: {
    inspectionId: 'move-in-1',
    type: 'MOVE_IN',
    status: 'COMPLETED',
    scheduledAt: '2025-06-12T00:00:00.000Z',
    templateLabel: 'Entry Inspection',
    inspector: 'Moses',
  },
  moveOut: {
    inspectionId: 'move-out-1',
    type: 'MOVE_OUT',
    status: 'REVIEW_REQUIRED',
    scheduledAt: '2026-10-01T00:00:00.000Z',
    completedAt: '2026-10-01T21:00:00.000Z',
    templateLabel: 'Exit Inspection',
    inspector: 'Moses',
  },
  areas: [
    {
      id: 'area-1',
      areaName: 'Kitchen',
      floorName: null,
      classification: 'UNCHANGED',
      originalClassification: 'NEW_DAMAGE',
      overrideReason: 'The move-in photographs show the same holes.',
      matchMethod: 'AREA_CATEGORY',
      matchConfidence: 0.5,
      requiresReview: false,
      summary: 'New since move-in: Walls and ceilings.',
      items: [
        {
          itemId: 'walls',
          label: 'Walls and ceilings',
          moveIn: { clean: true, undamaged: true, working: true, comment: null },
          moveOut: { clean: true, undamaged: false, working: true, comment: 'Two holes' },
          change: 'NEW_DAMAGE',
          cleaning: null,
        },
      ],
      moveIn: {
        roomId: 'room-in',
        name: 'Kitchen',
        completionStatus: 'COMPLETED',
        checklist: [],
        findings: [],
        photos: [
          {
            id: 'photo-in',
            roomId: 'room-in',
            label: 'Walls and ceilings',
            capturedAt: '2025-06-12T15:00:00.000Z',
            captureTimeSource: 'REPORT_STAMP',
            contentPath: '/api/v1/reports/token-1/photos/photo-in',
          },
        ],
      },
      moveOut: {
        roomId: 'room-out',
        name: 'Kitchen',
        completionStatus: 'COMPLETED',
        checklist: [],
        findings: [],
        photos: [],
      },
    },
  ],
  generatedAt: '2026-10-06T16:30:00.000Z',
};

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('the comparison report from a share link', () => {
  it('shows each room’s verdict, the office’s reason for changing it, and the items beneath', async () => {
    state.respond = () => Promise.resolve(REPORT);
    render(<ComparisonReportPage />);

    expect(await screen.findByRole('heading', { name: '318 Notional Harbor Ln' })).toBeTruthy();
    const room = screen.getByRole('region', { name: 'Kitchen' });
    expect(within(room).getByText('No new damage')).toBeTruthy();
    expect(within(room).getByText(/changed from “New damage”/)).toBeTruthy();
    expect(within(room).getByText(/The move-in photographs show the same holes\./)).toBeTruthy();
    const table = within(room).getByRole('table', { name: /Kitchen: each item/ });
    expect(within(table).getByText('New since move-in')).toBeTruthy();
    expect(within(table).getByText('Two holes')).toBeTruthy();
    expect(screen.getByText('Reviewed by Ana Lopez on October 6, 2026')).toBeTruthy();
  });

  it('never shows the reviewer’s working: match method, confidence, versions, "needs human review"', async () => {
    state.respond = () => Promise.resolve(REPORT);
    const { container } = render(<ComparisonReportPage />);
    await screen.findByRole('heading', { name: '318 Notional Harbor Ln' });

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/area category|50%|human review|NEW_DAMAGE|v4/i);
  });

  it('points photographs at the token’s route, and offers the PDF', async () => {
    state.respond = () => Promise.resolve(REPORT);
    render(<ComparisonReportPage />);

    const image = (await screen.findByRole('img', { name: 'Walls and ceilings' })) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://api.example/api/v1/reports/token-1/photos/photo-in?w=320');
    expect(screen.getByRole('link', { name: /Download PDF/ }).getAttribute('href')).toBe(
      '/comparison-report/token-1/pdf',
    );
  });

  it('says the report is being updated while it is back in review', async () => {
    const { ApiError } = await import('@/lib/api');
    state.respond = () =>
      Promise.reject(
        new ApiError(
          409,
          'COMPARISON_REPORT_UPDATING',
          'This comparison report is being updated. Please check back later, or contact your property manager.',
        ),
      );
    render(<ComparisonReportPage />);

    expect((await screen.findByRole('alert')).textContent).toContain('being updated');
  });

  it('says a dead link is dead', async () => {
    const { ApiError } = await import('@/lib/api');
    state.respond = () => Promise.reject(new ApiError(404, 'REPORT_NOT_AVAILABLE', 'gone'));
    render(<ComparisonReportPage />);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid, expired, or has been revoked');
  });
});
