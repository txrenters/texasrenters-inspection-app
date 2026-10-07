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
import { actionColumns } from './report-document';
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
    name: 'Notional',
    addressLine1: '318 Notional Harbor Ln',
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
    // a reader learns what was wrong. The AI already wrote it from the
    // narration and filed it under the checklist item, so this surfaces
    // existing words -- the finding's title, kept short -- rather than
    // inventing any (2026-10-07).
    const withFinding = (checklist: unknown) => ({
      ...REPORT,
      rooms: [{ ...REPORT.rooms[0]!, checklist }],
      findings: [
        {
          id: 'f-1',
          roomId: 'area-1',
          roomName: 'Kitchen',
          title: 'Door handle: grease around it',
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

      expect(view.rooms[0]!.checklist[0]!.comment).toBe('Door handle: grease around it');
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

    it('leads with what a person wrote and keeps the finding after it', () => {
      // The person's words are never overwritten, but they no longer suppress
      // the finding either: a reviewer adding a note to one row used to delete
      // the AI's explanation of that same row from the printed report, which
      // is the one column a reader checks to learn what the N meant.
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

      expect(view.rooms[0]!.checklist[0]!.comment).toBe(
        'Handle sticks. Door handle: grease around it',
      );
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
    expect(reportFileName(REPORT)).toBe('318-notional-harbor-ln-inspection-report.pdf');
  });
});

/** Every page's text, in order, as a reader of the PDF would see it. */
async function pageTexts(pdf: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const pages: string[][] = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const content = await (await document.getPage(number)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')));
  }
  return pages;
}

describe('a long report', () => {
  /**
   * Every report past ten pages failed to download.
   *
   * The page-number footer inherited the page's unitless line height, which
   * @react-pdf multiplied again on each relayout until its position passed
   * pdfkit's 1e21 limit: `unsupported number: -1.9064433873226668e+21`, and
   * "This page isn't working" in the browser. Shorter reports rendered, with
   * the footer pushed off every page.
   */
  it('renders past ten pages and numbers every one of them', async () => {
    mockPhotoFetch();
    const rooms = Array.from({ length: 60 }, (_, index) => ({
      ...REPORT.rooms[0]!,
      id: `area-${index}`,
      name: `Room ${index + 1}`,
    }));

    const pdf = await renderReportPdf(
      { ...REPORT, rooms, findings: [], photos: [] },
      { apiOrigin: 'http://x' },
    );

    const pages = await pageTexts(pdf);
    expect(pages.length).toBeGreaterThan(11);
    pages.forEach((text, index) => {
      expect(text).toContain(`Page ${index + 1} of ${pages.length}`);
    });
  }, 120_000);
});

describe('the capture time on a photograph', () => {
  it('prints it on the photo in Texas time, and not for a time nobody has confirmed', async () => {
    mockPhotoFetch();
    const confirmed = { ...REPORT.photos[0]!, id: 'photo-1', captureTimeSource: 'DEVICE_CLOCK' as const };
    const unconfirmed = { ...REPORT.photos[0]!, id: 'photo-2', captureTimeSource: null };

    const pdf = await renderReportPdf(
      { ...REPORT, findings: [], photos: [confirmed, unconfirmed] },
      { apiOrigin: 'http://x' },
    );

    const text = (await pageTexts(pdf)).flat();
    // 16:12:17 UTC in July is 11:12:17 AM in Houston; it used to print 4:12 PM.
    expect(text.filter((line) => line === 'Jul 23, 2026, 11:12:17 AM CDT')).toHaveLength(1);
  }, 60_000);
});

describe('what each room needs, under its photographs', () => {
  it('prints the groups under the office’s headings, with no transcript and no findings list', async () => {
    mockPhotoFetch();

    const pdf = await renderReportPdf(
      {
        ...REPORT,
        rooms: [
          {
            ...REPORT.rooms[0]!,
            actions: [
              {
                heading: 'Repairs / Maintenance',
                items: [{ text: 'Touch-up paint needed on:', details: ['Bathroom door frame', 'Bedroom entry door frame'] }],
              },
              { heading: 'Cleaning', items: [{ text: 'Clean windows inside and out.', details: [] }] },
            ],
          },
        ],
      },
      { apiOrigin: 'http://x' },
    );

    const text = (await pageTexts(pdf)).flat().join(' ');
    const at = (needle: string) => text.indexOf(needle);
    expect(at('Summary based on the recordings:')).toBeGreaterThan(-1);
    expect(at('Repairs / Maintenance')).toBeGreaterThan(at('Summary based on the recordings:'));
    expect(at('Bedroom entry door frame')).toBeGreaterThan(at('Touch-up paint needed on:'));
    expect(at('Cleaning')).toBeGreaterThan(at('Bedroom entry door frame'));
    expect(text).toContain('Clean windows inside and out.');
    // No timestamped point is printed any more (2026-10-07).
    expect(text).not.toMatch(/\[\d+:\d{2}\]/);
    // The findings' own wording used to print twice -- in a summary of
    // findings and under the room. Neither is printed any more (2026-10-07).
    expect(text).not.toContain('Summary of findings');
    expect(text).not.toContain('A new burn mark beside the stove');
    expect(text).not.toContain('At a glance');
    // The one count kept, on the cover: the room this case keeps was completed.
    expect(text).toContain('1 of 1');
  }, 60_000);

  it('prints a long list in two columns, the second picking up where the first stops', async () => {
    mockPhotoFetch();
    const many = Array.from({ length: 12 }, (_, index) => ({
      text: `Repair item number ${index + 1} on the wall beside the window.`,
      details: [],
    }));

    const pdf = await renderReportPdf(
      { ...REPORT, rooms: [{ ...REPORT.rooms[0]!, actions: [{ heading: 'Repairs / Maintenance', items: many }] }] },
      { apiOrigin: 'http://x' },
    );

    const text = (await pageTexts(pdf)).flat().join(' ');
    for (const item of many) expect(text).toContain(item.text);
    expect(text).toContain('Repairs / Maintenance (continued)');
  }, 60_000);

  it('prints no heading for a room with nothing listed', async () => {
    mockPhotoFetch();

    const pdf = await renderReportPdf(REPORT, { apiOrigin: 'http://x' });

    expect((await pageTexts(pdf)).flat().join(' ')).not.toContain('Summary based on the recordings');
  }, 60_000);
});

describe("an occupied room's answers", () => {
  it('prints them under a Condition heading instead of three empty verdict columns', async () => {
    mockPhotoFetch();
    const answered = (id: string, label: string, textValue: string) => ({
      id,
      label,
      isClean: null,
      isUndamaged: null,
      isWorking: null,
      comment: null,
      responseType: 'CHOICE' as const,
      textValue,
    });

    const pdf = await renderReportPdf(
      {
        ...REPORT,
        rooms: [
          {
            ...REPORT.rooms[0]!,
            name: 'Entrance',
            checklist: [
              answered('occ-1', 'Room condition', 'Clean'),
              answered('occ-2', 'Overall condition', 'Good'),
            ],
          },
        ],
        findings: [],
        photos: [],
      },
      { apiOrigin: 'http://x' },
    );

    const text = (await pageTexts(pdf)).flat();
    expect(text).toContain('Condition');
    expect(text).toContain('Clean');
    expect(text).toContain('Good');
    // No verdict columns over rows that have no verdicts.
    expect(text).not.toContain('Undam.');
  }, 60_000);
});

describe('splitting what a room needs into two columns', () => {
  const item = (text: string, details: string[] = []) => ({ text, details });

  it('cuts where the two halves are about equal, keeping every bullet in order', () => {
    const groups = [
      { heading: 'Repairs / Maintenance', items: [item('a'), item('b'), item('c'), item('d')] },
      { heading: 'Cleaning', items: [item('e'), item('f')] },
    ];

    const [left, right] = actionColumns(groups);

    const order = [...left, ...right].flatMap((group) => group.items.map((entry) => entry.text));
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(left.flatMap((group) => group.items)).toHaveLength(3);
    // The repairs carry on in the second column under their heading, marked.
    expect(right[0]).toMatchObject({ heading: 'Repairs / Maintenance', continued: true });
    expect(right[1]).toMatchObject({ heading: 'Cleaning', continued: false });
  });

  it('weighs a bullet by the places listed beneath it', () => {
    const [left, right] = actionColumns([
      {
        heading: 'Repairs / Maintenance',
        items: [item('Touch-up paint needed on:', ['Door frame', 'Trim', 'Closet door', 'Window sill']), item('b'), item('c')],
      },
    ]);

    expect(left.flatMap((group) => group.items.map((entry) => entry.text))).toEqual(['Touch-up paint needed on:']);
    expect(right[0].items.map((entry) => entry.text)).toEqual(['b', 'c']);
  });

  it('keeps a single bullet in the first column, and a group that starts a column unmarked', () => {
    expect(actionColumns([{ heading: 'Cleaning', items: [item('only')] }])).toEqual([
      [{ heading: 'Cleaning', continued: false, items: [item('only')] }],
      [],
    ]);
    const [, right] = actionColumns([
      { heading: 'Painting', items: [item('a')] },
      { heading: 'Cleaning', items: [item('b')] },
    ]);
    expect(right).toEqual([{ heading: 'Cleaning', continued: false, items: [item('b')] }]);
  });
});

