import type { PublicInspectionReport, PublicReportChecklistItem } from '@texasrenters/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ReportPage from './page';

/**
 * An occupied room's answers on the shared report page.
 *
 * They printed as two rows with every cell empty: the report carried only the
 * clean / undamaged / working axes, and an occupied room's answers are none of
 * those.
 */

let report: PublicInspectionReport;

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  publicApi: async () => report,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'token' }) }));
vi.mock('next/image', () => ({
  // A stand-in for the optimised component, which needs Next's image server.
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { alt: string }) => <img alt={props.alt} />,
}));

const reportWith = (checklist: PublicReportChecklistItem[]): PublicInspectionReport => ({
  brand: { name: 'TexasRenters.com' },
  property: {
    name: '12414 Montebello Manor Lane',
    addressLine1: '12414 Montebello Manor Lane',
    unitName: null,
    city: 'Houston',
    state: 'TX',
    postalCode: '77000',
  },
  inspection: {
    type: 'OCCUPIED',
    status: 'COMPLETED',
    scheduledAt: '2026-09-14T00:00:00.000Z',
    completedAt: '2026-09-14T18:00:00.000Z',
  },
  rooms: [
    {
      id: 'area-1',
      name: 'Entrance',
      floorName: null,
      completionStatus: 'COMPLETED',
      skipReason: null,
      completedAt: '2026-09-14T17:00:00.000Z',
      checklist,
    },
  ],
  findings: [],
  photos: [],
  generatedAt: '2026-09-14T20:00:00.000Z',
});

const answered = (id: string, label: string, textValue: string): PublicReportChecklistItem => ({
  id,
  label,
  isClean: null,
  isUndamaged: null,
  isWorking: null,
  comment: null,
  responseType: 'CHOICE',
  textValue,
});

afterEach(cleanup);

describe('a photograph on the shared report', () => {
  it('carries its capture time, in Texas time with the zone', async () => {
    report = {
      ...reportWith([]),
      photos: [
        {
          id: 'photo-1',
          roomId: 'area-1',
          label: 'Front door',
          capturedAt: '2026-09-14T18:22:07.000Z',
          captureTimeSource: 'DEVICE_CLOCK',
          contentPath: '/api/v1/reports/token/photos/photo-1',
        },
      ],
    };
    render(<ReportPage />);

    expect(await screen.findByText('Sep 14, 2026, 1:22:07 PM CDT')).toBeTruthy();
  });
});

describe("an occupied room on the shared report", () => {
  it('shows each answer under a Condition heading', async () => {
    report = reportWith([
      answered('occ-1', 'Room condition', 'Clean'),
      answered('occ-2', 'Overall condition', 'Good'),
    ]);
    render(<ReportPage />);

    const table = (await screen.findAllByRole('table'))[0]!;
    expect(within(table).getByRole('columnheader', { name: 'Condition' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Undamaged' })).toBeNull();
    const clean = within(table).getByRole('cell', { name: 'Clean' }) as HTMLTableCellElement;
    expect(clean.colSpan).toBe(3);
    expect(within(table).getByRole('cell', { name: 'Good' })).toBeTruthy();
  });

  it('keeps the verdict columns for a table that also has scored rows', async () => {
    report = reportWith([
      answered('occ-1', 'Room condition', 'Clean'),
      { id: 'walls', label: 'Walls', isClean: false, isUndamaged: true, isWorking: null, comment: 'Marks' },
    ]);
    render(<ReportPage />);

    const table = (await screen.findAllByRole('table'))[0]!;
    expect(within(table).getByRole('columnheader', { name: 'Undamaged' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: 'Clean' })).toBeTruthy();
  });
});
