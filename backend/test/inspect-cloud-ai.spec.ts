import { AiProvider } from '@prisma/client';

import { InspectCloudAiService } from '../src/admin/inspection-import/inspect-cloud-ai.service';
import { summarise } from '../src/admin/inspection-import/inspection-import.service';
import type { ImportedReport } from '../src/admin/inspection-import/inspect-cloud-report';

/**
 * Reading a report the deterministic parser cannot.
 *
 * This runs only when the layout is unrecognised — the known template is
 * measured exactly and paying a model to re-read it would be slower, cost per
 * page, and answer differently next time. So what matters here is the failure
 * behaviour: an unreadable answer must come back as an answer, never as an
 * exception, and never as a guess written into evidence.
 */

const settings = (configuration: unknown) =>
  ({ resolve: jest.fn().mockResolvedValue(configuration) }) as never;

const CONFIGURED = {
  provider: AiProvider.ANTHROPIC,
  modelId: 'claude-test',
  apiKey: 'key',
};

const tablePage = {
  number: 1,
  text: 'KITCHEN ROOM/ITEM COMMENTS DOORS & LOCKS Y Y N Handle loose',
};
const photoPage = { number: 2, text: 'DOORS & LOCKS Sep 02 2026 01:15:39 PM' };

const reply = (text: string) => ({
  ok: true,
  json: async () => ({ content: [{ text }] }),
});

const GOOD = JSON.stringify({
  areas: [
    {
      name: 'KITCHEN',
      items: [
        {
          label: 'DOORS & LOCKS',
          isClean: true,
          isUndamaged: true,
          isWorking: false,
          comment: 'Handle loose',
        },
        {
          label: 'WINDOWS & LOCKS',
          isClean: null,
          isUndamaged: null,
          isWorking: null,
          comment: null,
        },
      ],
    },
  ],
});

describe('reading an unrecognised report with a model', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('does not call a provider when the organization has no credential', async () => {
    const service = new InspectCloudAiService(settings(null));
    await expect(service.read('org', [tablePage])).resolves.toMatchObject({
      report: null,
      reason: 'NO_CREDENTIAL',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the pages carrying a table', async () => {
    // A report is mostly photographs — 40 of 48 pages on the one this was
    // built against — and their pages hold captions and capture times only.
    // Sending them multiplies the cost and adds nothing.
    fetchMock.mockResolvedValue(reply(GOOD));
    const service = new InspectCloudAiService(settings(CONFIGURED));

    await service.read('org', [tablePage, photoPage]);

    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(body).toContain('KITCHEN');
    expect(body).not.toContain('01:15:39');
  });

  it('keeps an ungraded row ungraded rather than letting a model pick', async () => {
    // The one thing a model must not do here. `null` means the inspector did
    // not assess it; `false` would invent damage nobody observed, and a
    // move-out would be compared against it.
    fetchMock.mockResolvedValue(reply(GOOD));
    const service = new InspectCloudAiService(settings(CONFIGURED));

    const { report } = await service.read('org', [tablePage]);

    expect(report?.areas[0]?.items[1]).toMatchObject({
      sourceLabel: 'WINDOWS & LOCKS',
      isClean: null,
      isUndamaged: null,
      isWorking: null,
      assessed: false,
    });
  });

  it('resolves labels through the same matcher the parser uses', async () => {
    // Not by asking the model to pick from our vocabulary, which would let it
    // name an item no template carries.
    fetchMock.mockResolvedValue(reply(GOOD));
    const service = new InspectCloudAiService(settings(CONFIGURED));

    const { report } = await service.read('org', [tablePage]);

    expect(report?.areas[0]?.items[0]).toMatchObject({
      matchedLabel: 'Doors and locks',
      matchScore: 1,
      isWorking: false,
      comment: 'Handle loose',
    });
  });

  it('reads an answer the model wrapped in a fence or a sentence', async () => {
    fetchMock.mockResolvedValue(reply('Here you go:\n```json\n' + GOOD + '\n```'));
    const service = new InspectCloudAiService(settings(CONFIGURED));
    const { report, reason } = await service.read('org', [tablePage]);
    expect(reason).toBe('OK');
    expect(report?.areas).toHaveLength(1);
  });

  it('reports prose as unreadable instead of throwing', async () => {
    fetchMock.mockResolvedValue(reply('I could not find a table in this document.'));
    const service = new InspectCloudAiService(settings(CONFIGURED));
    await expect(service.read('org', [tablePage])).resolves.toMatchObject({
      report: null,
      reason: 'INVALID_OUTPUT',
    });
  });

  it('reports a provider outage as unreadable instead of throwing', async () => {
    // A thrown provider error reads to an administrator as though their file
    // were at fault.
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const service = new InspectCloudAiService(settings(CONFIGURED));
    await expect(service.read('org', [tablePage])).resolves.toMatchObject({
      report: null,
      reason: 'REFUSED',
    });
  });

  it('refuses output that does not match the shape, rather than importing it', async () => {
    // A grade arriving as a string is the kind of thing that would otherwise
    // reach the database as a truthy value and read as a pass.
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ areas: [{ name: 'KITCHEN', items: [{ label: 'X', isClean: 'yes' }] }] })),
    );
    const service = new InspectCloudAiService(settings(CONFIGURED));
    await expect(service.read('org', [tablePage])).resolves.toMatchObject({
      reason: 'INVALID_OUTPUT',
    });
  });
});

describe('what the console is shown before anything is written', () => {
  const report: ImportedReport = {
    inspector: 'Amy Wilson',
    template: 'Ingoing Inspection',
    reportDate: 'SEP-02-2026',
    pages: 48,
    unrecognised: [{ area: 'HALLWAY', page: 45, text: 'SMOKE DETECTOR EXPIRED' }],
    areas: [
      {
        name: 'BATHROOM',
        startedOnPage: 26,
        photos: [
          { caption: 'DOORS & LOCKS', matchedLabel: 'Doors and locks', takenAt: null, page: 26, index: 0 },
          { caption: 'MYSTERY', matchedLabel: null, takenAt: null, page: 26, index: 1 },
        ],
        items: [
          {
            sourceLabel: 'BASIN, CABINET VANITY & MIRROR',
            matchedLabel: 'Basin, vanity and mirror',
            matchScore: 0.75,
            isClean: true,
            isUndamaged: true,
            isWorking: true,
            comment: null,
            assessed: true,
            page: 26,
          },
          {
            sourceLabel: 'BATH/SHOWER & TAPS',
            matchedLabel: 'Bath, shower and taps',
            matchScore: 1,
            isClean: true,
            isUndamaged: true,
            isWorking: false,
            comment: 'Drain not working',
            assessed: true,
            page: 26,
          },
        ],
      },
    ],
  };

  it('surfaces everything the parser would not resolve on its own', () => {
    // These are the reason the import is two steps. A summary that hid them
    // would make the confirmation screen a formality.
    const summary = summarise(report);

    expect(summary.needsReview.lowConfidenceLabels).toEqual([
      expect.objectContaining({ sourceLabel: 'BASIN, CABINET VANITY & MIRROR', score: 0.75 }),
    ]);
    expect(summary.needsReview.unrecognisedRows).toHaveLength(1);
    expect(summary.needsReview.photosWithoutSubject).toBe(1);
  });

  it('counts a defect from a failed grade as well as from a comment', () => {
    const summary = summarise(report);
    expect(summary.totals.defects).toBe(1);
    expect(summary.areas[0]?.defects[0]).toMatchObject({
      item: 'Bath, shower and taps',
      comment: 'Drain not working',
      failed: ['not working'],
    });
  });
});
