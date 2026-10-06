/**
 * @vitest-environment node
 *
 * Node, not jsdom, for the reason `render-report-pdf.test` gives: under jsdom
 * @react-pdf takes its browser build, which corrupts every embedded photograph
 * while the PDF still looks valid. The route handler runs on Node.
 */
import type { ComparisonReport } from '@texasrenters/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { comparisonFileName, renderComparisonPdf } from './render-comparison-pdf';

const photo = (id: string) => ({
  id,
  roomId: 'room-1',
  label: 'Walls and ceilings',
  notes: null,
  capturedAt: '2026-10-01T20:12:17.000Z',
  captureTimeSource: 'DEVICE_CLOCK' as const,
  width: 1600,
  height: 1200,
  contentPath: `/api/v1/reports/tok/photos/${id}`,
});

const REPORT: ComparisonReport = {
  brand: { name: 'TexasRenters.com', phone: '281-407-3815' },
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
    version: 3,
    overallCondition: 'NEW_DAMAGE',
    requiresReviewCount: 0,
    summary: '',
    generatedAt: '2026-10-06T15:00:00.000Z',
    reviewedByName: 'Ana Lopez',
    reviewedAt: '2026-10-06T16:00:00.000Z',
    reviewNote: 'Checked against the move-in photographs.',
  },
  moveIn: {
    inspectionId: 'move-in-1',
    type: 'MOVE_IN',
    status: 'COMPLETED',
    scheduledAt: '2025-06-12T00:00:00.000Z',
    completedAt: null,
    inspector: 'Moses',
    templateLabel: 'Entry Inspection',
  },
  moveOut: {
    inspectionId: 'move-out-1',
    type: 'MOVE_OUT',
    status: 'REVIEW_REQUIRED',
    scheduledAt: '2026-10-01T00:00:00.000Z',
    completedAt: '2026-10-01T21:00:00.000Z',
    inspector: 'Moses',
    templateLabel: 'Exit Inspection',
  },
  areas: [
    {
      id: 'area-1',
      areaName: 'Kitchen',
      floorName: 'Ground Floor',
      classification: 'NEW_DAMAGE',
      originalClassification: null,
      overrideReason: null,
      matchMethod: 'LOCAL_AREA_ID',
      matchConfidence: 1,
      requiresReview: false,
      summary: 'New since move-in: Walls and ceilings.',
      items: [
        {
          itemId: 'walls',
          label: 'Walls and ceilings',
          moveIn: { clean: true, undamaged: true, working: true, comment: null },
          moveOut: { clean: false, undamaged: false, working: true, comment: 'Two holes' },
          change: 'NEW_DAMAGE',
          cleaning: 'NEEDS_CLEANING',
        },
      ],
      moveIn: {
        roomId: 'room-in',
        name: 'Kitchen',
        completionStatus: 'COMPLETED',
        checklist: [],
        findings: [],
        photos: [photo('photo-in')],
      },
      moveOut: {
        roomId: 'room-out',
        name: 'Kitchen',
        completionStatus: 'COMPLETED',
        checklist: [],
        findings: [
          {
            id: 'finding-1',
            title: 'Wall: two holes beside the door',
            description: 'Two holes about an inch across, at handle height.',
            category: 'Walls',
            severity: 'MEDIUM',
          },
        ],
        photos: [photo('photo-out')],
      },
    },
    {
      id: 'area-2',
      areaName: 'Garage',
      floorName: null,
      classification: 'MISSING_MOVE_OUT_EVIDENCE',
      originalClassification: null,
      overrideReason: null,
      matchMethod: 'LOCAL_AREA_ID',
      matchConfidence: 1,
      requiresReview: true,
      summary: '',
      items: [],
      moveIn: {
        roomId: 'garage-in',
        name: 'Garage',
        completionStatus: 'COMPLETED',
        checklist: [
          { id: 'door', label: 'Garage door', isClean: true, isUndamaged: true, isWorking: null, comment: null },
        ],
        findings: [],
        photos: [],
      },
      moveOut: {
        roomId: 'garage-out',
        name: 'Garage',
        completionStatus: 'SKIPPED',
        skipReason: 'Locked',
        checklist: [],
        findings: [],
        photos: [],
      },
    },
  ],
  generatedAt: '2026-10-06T16:30:00.000Z',
};

// A 1x1 JPEG: enough for @react-pdf to decode and embed a real image.
const JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  ),
);

/** Photo requests only; @react-pdf fetches its own WebAssembly too. */
function mockPhotoFetch(handler?: () => Response) {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.includes('/api/v1/reports/')) return realFetch(input, init);
    return handler
      ? handler()
      : new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function embeddedJpegCount(pdf: Buffer) {
  const marker = Buffer.from([0xff, 0xd8, 0xff]);
  let count = 0;
  let index = 0;
  while ((index = pdf.indexOf(marker, index)) !== -1) {
    count += 1;
    index += 3;
  }
  return count;
}

describe('comparison report PDF', () => {
  it('renders both inspections’ photographs, bounded in width, into a real PDF', async () => {
    const fetchMock = mockPhotoFetch();

    const pdf = await renderComparisonPdf(REPORT, { apiOrigin: 'http://localhost:3000/' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Embedded intact, not merely declared. One image object: the two test
    // photographs are the same bytes, which @react-pdf stores once.
    expect(embeddedJpegCount(pdf)).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/reports/tok/photos/photo-in?w=1000',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/reports/tok/photos/photo-out?w=1000',
      expect.anything(),
    );
  }, 30_000);

  it('still renders when no photograph can be fetched', async () => {
    mockPhotoFetch(() => new Response('gone', { status: 404 }));

    const pdf = await renderComparisonPdf(REPORT, { apiOrigin: 'http://x' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(embeddedJpegCount(pdf)).toBe(0);
  }, 30_000);

  it('is named for the property', () => {
    expect(comparisonFileName(REPORT)).toBe('318-notional-harbor-ln-move-in-move-out-comparison.pdf');
  });
});
