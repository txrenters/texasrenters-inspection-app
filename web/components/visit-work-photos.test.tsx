import type { AdminInspection, VisitServicesReport } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetPhotos } from '@/components/area-evidence/photo-cache';
import { apiBlob } from '@/lib/api';

import { VisitWork, visitPhotos } from './visit-work';

/**
 * A visit's job photographs in the console's one viewer (approved on the
 * canvas, 2026-11-26). The address, technician and photographs are invented.
 */

vi.mock('@/lib/api', () => ({ apiBlob: vi.fn() }));

const report: VisitServicesReport = {
  services: {
    filterChange: { done: true, reason: null, reschedule: false },
    pestControl: { done: true, reason: null, reschedule: false, photoId: 'pest-1' },
    fleaTreatment: { done: true, reason: null, reschedule: false, photoId: 'flea-1' },
  },
  filters: [
    { size: '20x25x1', location: 'upstairs hallway', slot: 1, changed: true, reason: null, photoId: 'filters-1', booked: true },
    { size: '16x25x1', location: 'living room', slot: 1, changed: true, reason: null, photoId: 'filters-1', booked: true },
  ],
  filtersInstalled: [],
  notes: null,
} as VisitServicesReport;

const inspection = {
  id: 'insp-1',
  status: 'COMPLETED',
  inspectionType: 'HVAC',
  priority: 'STANDARD',
  scheduledAt: '2026-11-23T00:00:00.000Z',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
  assignments: [],
  submittedAt: '2026-11-23T16:41:00.000Z',
  servicesReportedAt: '2026-11-23T16:41:00.000Z',
  servicesReport: report,
  propertywareBuilding: { addressLine1: '2210 Cedar Bend Dr' },
  propertywareUnit: { id: 'u-1', name: 'Unit B' },
} as unknown as AdminInspection;

beforeEach(() => {
  vi.mocked(apiBlob).mockReset().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:photo', revokeObjectURL: () => {} }));
});

afterEach(() => {
  forgetPhotos();
  vi.unstubAllGlobals();
});

describe('the visit’s job photographs', () => {
  it('are walked in the order of the cards: the filters, pest control, flea treatment', () => {
    expect(visitPhotos(report).map((photo) => [photo.id, photo.title, photo.label, photo.detail])).toEqual([
      ['filters-1', 'AC filter change', '20x25x1 · upstairs hallway, 16x25x1 · living room', undefined],
      ['pest-1', 'Pest control', 'Pest control', 'Done'],
      ['flea-1', 'Flea treatment', 'Flea treatment', 'Done'],
    ]);
  });

  it('open in the viewer on the one clicked, with every one of them to step through', async () => {
    render(
      <VisitWork
        inspection={inspection}
        report={report}
        showInspection={false}
        status={{ label: 'Complete', variant: 'success' }}
        technicianName="D. Ramos"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Pest control$/ }));

    const viewer = await screen.findByRole('dialog');
    expect(within(viewer).getByText('Pest control')).toBeTruthy();
    expect(within(viewer).getAllByText('Done').length).toBeGreaterThan(0);
    // Beside Download, and under the dots on a phone.
    expect(within(viewer).getAllByText('2 of 3').length).toBeGreaterThan(0);
    expect(
      within(viewer).getByText(/^2210 Cedar Bend Dr Unit B · Work done reported .+ · D\. Ramos$/),
    ).toBeTruthy();
    for (const name of ['1 of 3: AC filter change', '2 of 3: Pest control', '3 of 3: Flea treatment'])
      expect(within(viewer).getByRole('button', { name })).toBeTruthy();

    // The 1,600-pixel copy first; the original waits for a close look or Download.
    const paths = vi.mocked(apiBlob).mock.calls.map(([path]) => path);
    expect(paths).toContain('/api/v1/admin/photos/pest-1/content?w=1600');
    expect(paths).not.toContain('/api/v1/admin/photos/pest-1/content');

    fireEvent.click(within(viewer).getByRole('button', { name: 'Previous evidence' }));
    expect(await within(viewer).findByText('AC filter change')).toBeTruthy();
    expect(within(viewer).getAllByText('20x25x1 · upstairs hallway, 16x25x1 · living room').length).toBeGreaterThan(0);
  });
});
