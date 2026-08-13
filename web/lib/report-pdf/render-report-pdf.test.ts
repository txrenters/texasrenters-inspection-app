/**
 * @vitest-environment node
 *
 * Must be node, not the project's default jsdom. Under jsdom, @react-pdf
 * resolves to its browser build, which pushes image bytes through a text
 * decoder — every embedded photo comes out corrupt while the PDF still looks
 * structurally valid. The route handler runs on the Node runtime, so this is
 * also the environment the code actually ships in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderReportPdf, reportFileName } from './render-report-pdf';
import { buildReportView } from '@texasrenters/shared';
import type { PublicInspectionReport } from '@texasrenters/shared';

const REPORT: PublicInspectionReport = {
  brand: {
    name: 'TexasRenters.com',
    addressLine1: '5225 Katy Fwy, Suite 545',
    addressLine2: 'Houston, TX 77007',
    phone: '281-407-3815',
    email: 'reports@texasrenters.com',
  },
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
    inspector: 'Lovely Mae / Beatriz',
    templateLabel: 'Routine Inspection',
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
      skipReason: 'Tenant vehicle blocking access',
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
      description: 'A new burn mark beside the stove, roughly four inches across.',
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
      contentPath: '/api/v1/reports/tok/photos/photo-1',
    },
  ],
  generatedAt: '2026-07-28T00:00:00.000Z',
};

// A 1x1 JPEG — enough for @react-pdf to decode and embed a real image.
const JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  ),
);

/**
 * Intercepts only report photo requests. Everything else must pass through:
 * @react-pdf's layout engine loads its own WebAssembly via fetch, and a blanket
 * stub feeds it a JPEG instead of the wasm module.
 */
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

/**
 * Counts intact JPEG start-of-image markers in the output. A PDF can declare
 * DCTDecode image objects whose bytes were corrupted in transit and still parse
 * as a valid document, so checking the %PDF- header alone proves nothing about
 * whether the photos survived.
 */
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

describe('inspection report PDF', () => {
  it('renders a real PDF and requests bounded-width photos', async () => {
    const fetchMock = mockPhotoFetch();

    const pdf = await renderReportPdf(REPORT, { apiOrigin: 'http://localhost:3000/' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    // The photo must survive embedding, not merely be declared.
    expect(embeddedJpegCount(pdf)).toBe(1);
    // Originals are multi-megabyte phone photos; the report must never ask for them.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/reports/tok/photos/photo-1?w=1000',
      expect.anything(),
    );
  }, 30_000);

  it('still produces a report when a photo cannot be fetched', async () => {
    mockPhotoFetch(() => new Response('nope', { status: 404 }));

    const pdf = await renderReportPdf(REPORT, { apiOrigin: 'http://localhost:3000' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 30_000);

  it('renders a report that has no photos at all', async () => {
    const fetchMock = mockPhotoFetch();

    const pdf = await renderReportPdf({ ...REPORT, photos: [] }, { apiOrigin: 'http://x' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it("heads the report with the office's template name and inspector", () => {
    // "Routine Inspection", not "Occupied inspection": the line names the form
    // the inspector worked from, which is the organisation's vocabulary and is
    // deployment-overridable.
    const view = buildReportView(REPORT);

    expect(view.templateLabel).toBe('Routine Inspection');
    expect(view.inspectorLabel).toBe('Lovely Mae / Beatriz');
  });

  it('falls back to the enum label when the deployment names no template', () => {
    // A report must never be headed by a blank.
    const view = buildReportView({
      ...REPORT,
      inspection: { ...REPORT.inspection, templateLabel: null, inspector: null },
    });

    expect(view.templateLabel).toBe('Occupied inspection');
    // Empty, so the renderer omits the line rather than printing "Inspector:"
    // over nothing.
    expect(view.inspectorLabel).toBe('');
  });

  it('carries only the closing notes that were actually written', () => {
    // Three headings over three blanks says less than nothing, so the view
    // model filters rather than leaving the renderers to guess.
    const view = buildReportView({
      ...REPORT,
      closing: {
        nextInspectionAlert: null,
        maintenanceComments: '  carpet needs replacing  ',
        generalComments: '   ',
      },
    });

    expect(view.closingNotes).toEqual([
      { label: 'Maintenance comments', body: 'carpet needs replacing' },
    ]);
  });

  it('has no closing block when the reviewer wrote nothing', () => {
    const view = buildReportView({ ...REPORT, closing: undefined });

    expect(view.closingNotes).toEqual([]);
  });

  describe('a failed axis borrows the finding that explains it', () => {
    // The office's report never prints a bare "N" — the comment column is where
    // a reader learns what was wrong. The AI already wrote that sentence from
    // the narration and filed it under the same name as the checklist item, so
    // this surfaces existing words rather than inventing any.
    const withFinding = (checklist: unknown) => ({
      ...REPORT,
      rooms: [{ ...REPORT.rooms[0]!, checklist }],
      findings: [
        {
          id: 'f-1',
          roomId: 'area-1',
          roomName: 'Kitchen',
          title: 'Doors and locks not clean',
          description: 'Grease around the handle, noted in the narration.',
          category: 'Doors and locks',
          severity: 'LOW',
          comparisonResult: 'EXISTING_CONDITION',
          baselineCondition: 'Clean at move-in.',
        },
      ],
    });

    it('fills an empty comment from the matching finding', () => {
      const view = buildReportView(
        withFinding([
          {
            id: 'i-1',
            label: 'Doors and locks',
            isClean: false,
            isUndamaged: true,
            isWorking: true,
            comment: null,
          },
        ]) as never,
      );

      expect(view.rooms[0]!.checklist[0]!.comment).toBe(
        'Grease around the handle, noted in the narration.',
      );
    });

    it('leaves a passing row alone', () => {
      // Attaching an explanation to an all-Y row would read as a defect.
      const view = buildReportView(
        withFinding([
          {
            id: 'i-1',
            label: 'Doors and locks',
            isClean: true,
            isUndamaged: true,
            isWorking: true,
            comment: null,
          },
        ]) as never,
      );

      expect(view.rooms[0]!.checklist[0]!.comment).toBe('');
    });

    it("never overwrites what a person wrote", () => {
      const view = buildReportView(
        withFinding([
          {
            id: 'i-1',
            label: 'Doors and locks',
            isClean: false,
            isUndamaged: true,
            isWorking: true,
            comment: 'Handle sticks.',
          },
        ]) as never,
      );

      expect(view.rooms[0]!.checklist[0]!.comment).toBe('Handle sticks.');
    });

    it('leaves the comment empty when no finding matches the item', () => {
      const view = buildReportView(
        withFinding([
          {
            id: 'i-2',
            label: 'Smoke alarms',
            isClean: false,
            isUndamaged: true,
            isWorking: true,
            comment: null,
          },
        ]) as never,
      );

      expect(view.rooms[0]!.checklist[0]!.comment).toBe('');
    });
  });

  it('names the download after the property', () => {
    expect(reportFileName(REPORT)).toBe('302-watercrest-harbor-ln-inspection-report.pdf');
  });
});
