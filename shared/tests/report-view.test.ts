import { describe, expect, it } from 'vitest';

import { buildReportView, narrationText, restatesChecklist } from '../src/index.js';
import type { PublicInspectionReport } from '../src/index.js';

function report(overrides: Partial<PublicInspectionReport> = {}): PublicInspectionReport {
  return {
    brand: { name: 'TexasRenters.com' },
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
    },
    rooms: [],
    findings: [],
    photos: [],
    generatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

const ROOM = {
  id: 'area-1',
  name: 'Kitchen',
  floorName: 'Ground Floor',
  completionStatus: 'COMPLETED',
  skipReason: null,
  completedAt: '2026-07-23T17:00:00.000Z',
  // Required on the room, and empty here on purpose: these cases are about how
  // findings and photos group under a room, not about how a scored row prints.
  // The checklist has its own describe block below, which supplies its own rows.
  checklist: [],
};

const FINDING = {
  id: 'finding-1',
  roomId: 'area-1',
  roomName: 'Kitchen',
  title: 'Scuffed wall',
  description: 'Long scuff beside the window.',
  category: 'WALLS',
  severity: 'MEDIUM',
  comparisonResult: 'POSSIBLE_NEW_DAMAGE',
  baselineCondition: 'No damage at move-in.',
};

describe('inspection report view model', () => {
  it('groups photos and findings under their room and ranks findings by severity', () => {
    const view = buildReportView(
      report({
        rooms: [ROOM],
        findings: [
          { ...FINDING, id: 'low', severity: 'LOW' },
          { ...FINDING, id: 'high', severity: 'HIGH' },
          { ...FINDING, id: 'medium', severity: 'MEDIUM' },
        ],
        photos: [
          {
            id: 'photo-1',
            roomId: 'area-1',
            label: 'Wall',
            notes: null,
            capturedAt: '2026-07-23T16:12:17.000Z',
            captureTimeSource: 'DEVICE_CLOCK',
            width: 1200,
            height: 900,
            contentPath: '/api/v1/reports/tok/photos/photo-1',
          },
        ],
      }),
    );

    expect(view.rooms).toHaveLength(1);
    expect(view.rooms[0].findings.map((finding) => finding.id)).toEqual(['high', 'medium', 'low']);
    expect(view.rooms[0].photos[0].caption).toBe('Wall');
    // Texas time, to the second, with its zone -- not the UTC it used to print.
    expect(view.rooms[0].photos[0].stamp).toBe('Jul 23, 2026, 11:12:17 AM CDT');
    expect(view.rooms[0].hasEvidence).toBe(true);
    expect(view.summary.headline).toBe('3 findings across 1 room');
    expect(view.summary.severityCounts.map((entry) => entry.count)).toEqual([1, 1, 1]);
  });

  it('falls back to the room name when a finding points at a merged or renamed area', () => {
    const view = buildReportView(
      report({
        rooms: [ROOM],
        // roomId refers to an area that no longer exists after a merge.
        findings: [{ ...FINDING, roomId: 'area-removed' }],
      }),
    );

    expect(view.rooms[0].findings).toHaveLength(1);
    expect(view.otherFindings).toHaveLength(0);
  });

  it('surfaces rather than drops a finding whose room cannot be resolved at all', () => {
    const view = buildReportView(
      report({ rooms: [ROOM], findings: [{ ...FINDING, roomId: null, roomName: 'Demolished' }] }),
    );

    expect(view.rooms[0].findings).toHaveLength(0);
    expect(view.otherFindings.map((finding) => finding.roomName)).toEqual(['Demolished']);
    expect(view.allFindings).toHaveLength(1);
  });

  it('reads cleanly when nothing was found', () => {
    const view = buildReportView(report({ rooms: [ROOM] }));

    expect(view.summary.headline).toBe('No findings were confirmed during review');
    expect(view.rooms[0].hasEvidence).toBe(false);
    expect(view.title).toBe('318 Notional Harbor Ln');
    expect(view.dateLabel).toBe('Completed July 23, 2026');
    expect(view.inspectionLabel).toBe('Occupied inspection');
  });

  it('dates a visit finished in the evening by its Texas day, not the next', () => {
    // 8:30 PM on 23 July in Houston: the 24th in UTC.
    const view = buildReportView(
      report({
        inspection: {
          type: 'OCCUPIED',
          status: 'COMPLETED',
          scheduledAt: '2026-07-23T00:00:00.000Z',
          completedAt: '2026-07-24T01:30:00.000Z',
        },
        generatedAt: '2026-07-24T01:30:00.000Z',
      }),
    );

    expect(view.dateLabel).toBe('Completed July 23, 2026');
    expect(view.generatedLabel).toBe('July 23, 2026');
  });

  it('words comparison verdicts for a homeowner instead of echoing the enum', () => {
    const view = buildReportView(report({ rooms: [ROOM], findings: [FINDING] }));

    expect(view.allFindings[0].comparisonLabel).toBe('Possible new damage');
    expect(view.allFindings[0].severityLabel).toBe('Moderate');
  });
});

/**
 * The comment column of the condition table.
 *
 * The vocabularies on the two sides never match: an administrator writes the
 * checklist ("Floor and coverings", "Smoke alarms") and the AI categorises its
 * findings from the technician's narration ("Flooring", "Smoke alarm"). These
 * cover the pairings a real two-room report produced, where matching the two
 * labels for equality left five of six failed rows printing a bare N.
 *
 * Since 2026-10-07 a comment is a finding's title -- short, as the office asked
 * -- and it comes from every finding the office has not rejected, confirmed or
 * not (`checklistNotes`): 10830 Harston Dr printed no comment at all while its
 * 227 findings waited to be confirmed.
 */
describe("the inspector's narration under a room", () => {
  const LINES = [
    { start: 1, end: 4, text: 'We are now in the dining room.' },
    { start: 5, end: 9, text: ' Dining room has part pantry. ' },
    { start: 70, end: 75, text: 'Windows are in good shape.' },
  ];

  it('prints each recording as one run of text, each line opening with its minute and second', () => {
    const view = buildReportView(
      report({
        rooms: [
          {
            ...ROOM,
            narration: [
              { label: null, lines: LINES },
              { label: 'Pantry shelf', lines: [{ start: 0, end: 3, text: 'Shelf is loose.' }] },
            ],
          },
        ],
      }),
    );

    expect(view.rooms[0].narration).toEqual([
      {
        label: null,
        text:
          '[0:01] We are now in the dining room. [0:05] Dining room has part pantry. ' +
          '[1:10] Windows are in good shape.',
      },
      { label: 'Pantry shelf', text: '[0:00] Shelf is loose.' },
    ]);
    // A room with nothing but its recording still prints, rather than being
    // filed under "Other areas" as if nothing had been said about it.
    expect(view.rooms[0].hasEvidence).toBe(true);
  });

  it('prints nothing for a recording that said nothing, and for a report from an older backend', () => {
    const silent = buildReportView(
      report({ rooms: [{ ...ROOM, narration: [{ label: null, lines: [{ start: 0, end: 1, text: '  ' }] }] }] }),
    );
    const older = buildReportView(report({ rooms: [ROOM] }));

    expect(silent.rooms[0].narration).toEqual([]);
    expect(silent.rooms[0].hasEvidence).toBe(false);
    expect(older.rooms[0].narration).toEqual([]);
  });

  it('keeps the words as they were spoken', () => {
    // Verbatim is the point: nothing is cut, reworded or capitalised.
    expect(narrationText([{ start: 754, text: 'need to full repaint the door' }])).toBe(
      '[12:34] need to full repaint the door',
    );
  });
});

describe('explaining a failed checklist row', () => {
  type Note = { category: string; title: string };

  function rowFor(
    item: { label: string; keywords?: string[]; isClean?: boolean | null; comment?: string },
    notes: Note[],
    via: 'notes' | 'findings' = 'notes',
  ) {
    const sources = notes.map((note, index) => ({ ...FINDING, id: `finding-${index}`, ...note }));
    const view = buildReportView(
      report({
        rooms: [
          {
            ...ROOM,
            checklist: [
              {
                id: 'item-1',
                label: item.label,
                keywords: item.keywords,
                comment: item.comment,
                isClean: item.isClean ?? false,
                isUndamaged: true,
                isWorking: true,
              },
            ],
          },
        ],
        ...(via === 'notes'
          ? {
              checklistNotes: sources.map(({ roomId, roomName, category, title }) => ({
                roomId,
                roomName,
                category,
                title,
              })),
            }
          : { findings: sources }),
      }),
    );
    return view.rooms[0].checklist[0];
  }

  it.each([
    ['Floor and coverings', ['floor', 'covering'], 'Flooring'],
    ['Walls and ceilings', ['wall', 'ceiling'], 'Walls'],
    ['Smoke alarms', ['smoke', 'alarm'], 'Smoke alarm'],
    ['Doors and locks', ['door', 'lock'], 'Doors'],
    ['Lights and power points', ['light', 'power', 'point'], 'Lighting'],
  ])('explains %s from a finding filed under %s', (label, keywords, category) => {
    expect(rowFor({ label, keywords }, [{ category, title: 'Corner: chipped' }]).comment).toBe(
      'Corner: chipped',
    );
  });

  it('prints the title, short, never the description', () => {
    const row = rowFor({ label: 'Walls and ceilings', keywords: ['wall'] }, [
      { category: 'Walls', title: 'Entrance wall: several screw holes' },
    ]);

    expect(row.comment).toBe('Entrance wall: several screw holes');
    expect(row.comment).not.toContain(FINDING.description);
  });

  it('prints what the walkthrough found before anyone confirmed it', () => {
    // The findings section is the office's confirmed findings; the comments
    // are not held for them (2026-10-07).
    const view = buildReportView(
      report({
        rooms: [
          {
            ...ROOM,
            checklist: [
              { id: 'item-1', label: 'Walls and ceilings', keywords: ['wall'], isClean: true, isUndamaged: false, isWorking: true },
            ],
          },
        ],
        findings: [],
        checklistNotes: [{ roomId: 'area-1', roomName: 'Kitchen', category: 'Walls', title: 'Wall: two nail holes' }],
      }),
    );

    expect(view.rooms[0].checklist[0].comment).toBe('Wall: two nail holes');
    expect(view.rooms[0].findings).toHaveLength(0);
    expect(view.disclaimer).toContain('comments beside the checklist are drawn automatically');
  });

  it('leaves out a finding that only says the row’s N back', () => {
    // 10830 Harston Dr: "Walls and ceilings: not clean", "Lights and power
    // points: recorded damage" -- most of its 227 findings.
    const row = rowFor({ label: 'Walls and ceilings', keywords: ['wall', 'ceiling'] }, [
      { category: 'Walls', title: 'Walls and ceilings: not clean' },
      { category: 'Walls', title: 'Walls and ceilings: failed working check' },
      { category: 'Walls', title: 'Walls and ceilings: recorded damage, not working' },
      { category: 'Walls', title: 'Entrance wall: several screw holes' },
    ]);

    expect(row.comment).toBe('Entrance wall: several screw holes');
  });

  it.each([
    // The ways 10830 Harston Dr's findings said a row's N back (2026-10-07).
    ['Doors and locks', ['door', 'lock'], 'Kitchen door recorded as unclean', true],
    ['Dishwasher', ['dishwasher'], 'Dishwasher is damaged', true],
    ['Lawn and garden', ['lawn', 'garden'], 'Lawn and garden: damage recorded without details', true],
    ['Lights and power points', ['light', 'power'], 'Kitchen lights or power points not working', true],
    ['Floor and coverings', ['floor'], 'Kitchen-room floor recorded as not clean', true],
    ['Walls and ceilings', ['wall', 'ceiling'], 'Walls or ceiling: unspecified functional issue recorded', true],
    // And ones that say what is wrong.
    ['Doors and locks', ['door', 'lock'], 'Sliding door locking mechanism damaged', false],
    ['Walls and ceilings', ['wall', 'ceiling'], 'Kitchen wall has widespread grease stains', false],
    ['Smoke alarms', ['smoke', 'alarm'], 'Smoke alarm missing from office', false],
    ['Lights and power points', ['light', 'bulb'], 'Two bathroom light bulbs are not working', false],
  ])('on %s, "%s" says the row back: %s', (label, keywords, title, echo) => {
    expect(restatesChecklist(title, { label, keywords }, 'Kitchen')).toBe(echo);
  });

  it('carries what explains the row, up to three, not just the first', () => {
    const row = rowFor({ label: 'Walls and ceilings', keywords: ['wall', 'ceiling'] }, [
      { category: 'WALLS', title: 'Wall: multiple cracks' },
      { category: 'WALLS', title: 'Ceiling: water stain by the vent' },
      { category: 'WALLS', title: 'Wall: scuff by the door' },
      { category: 'WALLS', title: 'Wall: crayon marks' },
      // The same title twice is said once.
      { category: 'WALLS', title: 'Wall: multiple cracks' },
    ]);

    expect(row.comment).toBe('Wall: multiple cracks; Ceiling: water stain by the vent; Wall: scuff by the door');
  });

  it('cuts a long title at a word', () => {
    const row = rowFor({ label: 'Walls and ceilings', keywords: ['wall'] }, [
      {
        category: 'Walls',
        title:
          'Wall: long horizontal scrape running along the hallway from the bedroom door to the bathroom',
      },
    ]);

    expect(row.comment.length).toBeLessThanOrEqual(80);
    expect(row.comment).toMatch(/^Wall: long horizontal scrape .*…$/);
  });

  it('matches on the thing a title names, whatever its category', () => {
    const row = rowFor({ label: 'Lights and power points', keywords: ['light', 'outlet'] }, [
      { category: 'Electrical', title: 'Outlet cover: missing by the sink' },
    ]);

    expect(row.comment).toBe('Outlet cover: missing by the sink');
  });

  it('leads with the technician’s note and keeps the findings after it', () => {
    const row = rowFor(
      { label: 'Walls and ceilings', keywords: ['wall', 'ceiling'], comment: 'Tenant reported this on move-in day.' },
      [{ category: 'WALLS', title: 'Wall: multiple cracks' }],
    );

    expect(row.comment).toBe('Tenant reported this on move-in day. Wall: multiple cracks');
  });

  it('says nothing about a row that passed', () => {
    // A comment against an all-Y row reads as a defect that was never found.
    const row = rowFor({ label: 'Walls and ceilings', keywords: ['wall'], isClean: true }, [
      { category: 'WALLS', title: 'Wall: multiple cracks' },
    ]);

    expect(row.comment).toBe('');
  });

  it('does not attach a finding about something else in the room', () => {
    const row = rowFor({ label: 'Smoke alarms', keywords: ['smoke', 'alarm'] }, [
      { category: 'Flooring', title: 'Floor: stained by the sink' },
    ]);

    expect(row.comment).toBe('');
  });

  it('still matches on the label when the item carries no keywords', () => {
    const row = rowFor({ label: 'Smoke alarms' }, [{ category: 'Smoke alarm', title: 'Smoke alarm: missing' }]);

    expect(row.comment).toBe('Smoke alarm: missing');
  });

  it('reads the confirmed findings when a report carries no notes (an older backend)', () => {
    const row = rowFor(
      { label: 'Walls and ceilings', keywords: ['wall'] },
      [{ category: 'Walls', title: 'Wall: multiple cracks' }],
      'findings',
    );

    expect(row.comment).toBe('Wall: multiple cracks');
  });
});

/**
 * An occupied room answers two questions -- "Room condition", "Overall
 * condition" -- with one chosen option each, and all three axes null.
 *
 * The report used to print both rows with every cell empty, which read as a
 * room nobody assessed.
 */
describe('a checklist row answered with one choice', () => {
  const rowsFor = (checklist: PublicInspectionReport['rooms'][number]['checklist']) =>
    buildReportView(report({ rooms: [{ ...ROOM, checklist }] })).rooms[0].checklist;

  const answered = (textValue: string | null) => ({
    id: 'occ-1',
    label: 'Room condition',
    isClean: null,
    isUndamaged: null,
    isWorking: null,
    comment: null,
    responseType: 'CHOICE' as const,
    textValue,
  });

  it('prints the answer in place of the three verdicts', () => {
    expect(rowsFor([answered('Clean')])[0]).toMatchObject({
      kind: 'ANSWER',
      answer: 'Clean',
      clean: '',
      undamaged: '',
      working: '',
    });
  });

  it('prints nothing for a question left unanswered, rather than a guess', () => {
    expect(rowsFor([answered(null)])[0]).toMatchObject({ kind: 'ANSWER', answer: '' });
  });

  it('keeps a three-axis row as it was, including one from a report with no response type', () => {
    const [row] = rowsFor([
      { id: 'item-1', label: 'Walls', isClean: true, isUndamaged: false, isWorking: null },
    ]);
    expect(row).toMatchObject({ kind: 'AXES', answer: '' });
    expect(row.clean).not.toBe('');
  });
});

