import type { ComparisonReport } from '@texasrenters/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ComparisonReportPage from './page';

/**
 * The move-in / move-out comparison an owner or tenant opens from a link (the
 * office, 2026-10-06). Nobody approves it (2026-10-07): it is drawn from the
 * two checklists and the findings the office confirmed from the recordings.
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

const emptySide = (roomId: string, name: string) => ({
  roomId,
  name,
  completionStatus: 'COMPLETED',
  checklist: [],
  findings: [],
  photos: [],
});

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
    version: 4,
    overallCondition: 'NEW_DAMAGE',
    summary: 'Compared 2 areas. Overall: NEW_DAMAGE.',
    generatedAt: '2026-10-06T15:00:00.000Z',
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
      classification: 'NEW_DAMAGE',
      matchMethod: 'AREA_CATEGORY',
      matchConfidence: 0.5,
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
        ...emptySide('room-in', 'Kitchen'),
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
      moveOut: emptySide('room-out', 'Kitchen'),
    },
    {
      // New damage the office confirmed from the recording, on no item.
      id: 'area-2',
      areaName: 'Bedroom 2',
      floorName: null,
      classification: 'NEW_DAMAGE',
      matchMethod: 'LOCAL_AREA_ID',
      matchConfidence: 1,
      summary: 'Damage was recorded at move-out that the move-in did not record.',
      fromRecording: ['Door: hole beside the handle'],
      moveIn: emptySide('room-in-2', 'Bedroom 2'),
      moveOut: emptySide('room-out-2', 'Bedroom 2'),
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
  it('shows each room’s verdict and the items beneath it', async () => {
    state.respond = () => Promise.resolve(REPORT);
    render(<ComparisonReportPage />);

    expect(await screen.findByRole('heading', { name: '318 Notional Harbor Ln' })).toBeTruthy();
    const room = screen.getByRole('region', { name: 'Kitchen' });
    const table = within(room).getByRole('table', { name: /Kitchen: each item/ });
    expect(within(table).getByText('New damage')).toBeTruthy();
    expect(within(table).getByText('Good')).toBeTruthy();
    expect(within(table).getByText('Damaged')).toBeTruthy();
    expect(within(table).getByText('Two holes')).toBeTruthy();
  });

  it('opens on what was found, and keeps the rooms the inspections do not share for the end', async () => {
    state.respond = () =>
      Promise.resolve({
        ...REPORT,
        areas: [
          ...REPORT.areas,
          {
            id: 'area-3',
            areaName: 'Formal Dining Room',
            floorName: 'Added areas',
            classification: 'MISSING_BASELINE',
            matchMethod: 'UNMATCHED',
            matchConfidence: 0,
            summary: '',
            moveIn: null,
            moveOut: emptySide('room-out-3', 'Formal Dining Room'),
          },
        ],
      });
    render(<ComparisonReportPage />);

    const found = await screen.findByRole('region', { name: 'What we found' });
    expect(within(found).getByText('New damage in 2 rooms.')).toBeTruthy();
    expect(within(found).getByText("1 room couldn't be compared.")).toBeTruthy();
    const rest = screen.getByRole('region', { name: "Rooms we couldn't compare" });
    expect(within(rest).getByText('Formal Dining Room')).toBeTruthy();
    expect(within(rest).getByText('Only in the move-out inspection')).toBeTruthy();
    // Not a room of its own among the compared ones, and no "Added areas" floor.
    expect(screen.queryByRole('region', { name: 'Formal Dining Room' })).toBeNull();
    expect(screen.queryByText('Added areas')).toBeNull();
  });

  it('lists what the office confirmed from the recording with what is new', async () => {
    state.respond = () => Promise.resolve(REPORT);
    render(<ComparisonReportPage />);

    await screen.findByRole('heading', { name: '318 Notional Harbor Ln' });
    expect(screen.getAllByText(/Door: hole beside the handle/).length).toBeGreaterThan(0);
  });

  it('says how it was drawn, and claims no review nobody made', async () => {
    state.respond = () => Promise.resolve(REPORT);
    const { container } = render(<ComparisonReportPage />);
    await screen.findByRole('heading', { name: '318 Notional Harbor Ln' });

    const text = container.textContent ?? '';
    expect(text).toMatch(/confirmed from the move-out recordings/);
    expect(text).not.toMatch(/Reviewed by|reviewed by the TexasRenters team|Office review/);
  });

  it('never shows the office’s working: match method, confidence, versions', async () => {
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

  it('says a dead link is dead', async () => {
    const { ApiError } = await import('@/lib/api');
    state.respond = () => Promise.reject(new ApiError(404, 'REPORT_NOT_AVAILABLE', 'gone'));
    render(<ComparisonReportPage />);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid, expired, or has been revoked');
  });
});
