import { describe, expect, it } from 'vitest';

import { buildReportView } from '../src/index.js';
import type { PublicInspectionReport } from '../src/index.js';

function report(overrides: Partial<PublicInspectionReport> = {}): PublicInspectionReport {
  return {
    brand: { name: 'TexasRenters.com' },
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
    expect(view.rooms[0].photos[0].stamp).toBe('Jul 23, 2026, 4:12 PM');
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
    expect(view.title).toBe('302 Watercrest Harbor Ln');
    expect(view.dateLabel).toBe('Completed July 23, 2026');
    expect(view.inspectionLabel).toBe('Occupied inspection');
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
 */
describe('explaining a failed checklist row', () => {
  function rowFor(
    item: { label: string; keywords?: string[]; isClean?: boolean | null },
    findings: { category: string; description: string }[],
  ) {
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
                isClean: item.isClean ?? false,
                isUndamaged: true,
                isWorking: true,
              },
            ],
          },
        ],
        findings: findings.map((finding, index) => ({
          ...FINDING,
          id: `finding-${index}`,
          ...finding,
        })),
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
    expect(rowFor({ label, keywords }, [{ category, description: 'The recorded defect.' }]).comment)
      .toBe('The recorded defect.');
  });

  it('carries every finding that explains the row, not just the first', () => {
    // A room can have two things wrong with its walls. Printing one of them
    // silently drops the other from the only column a reader checks.
    const row = rowFor({ label: 'Walls and ceilings', keywords: ['wall', 'ceiling'] }, [
      { category: 'WALLS', description: 'Multiple wall cracks.' },
      { category: 'WALLS', description: 'Water staining near the ceiling.' },
    ]);

    expect(row.comment).toBe('Multiple wall cracks. Water staining near the ceiling.');
  });

  it('leads with the reviewer note and keeps the findings after it', () => {
    const view = buildReportView(
      report({
        rooms: [
          {
            ...ROOM,
            checklist: [
              {
                id: 'item-1',
                label: 'Walls and ceilings',
                keywords: ['wall', 'ceiling'],
                comment: 'Tenant reported this on move-in day.',
                isClean: false,
                isUndamaged: true,
                isWorking: true,
              },
            ],
          },
        ],
        findings: [{ ...FINDING, category: 'WALLS', description: 'Multiple wall cracks.' }],
      }),
    );

    expect(view.rooms[0].checklist[0].comment).toBe(
      'Tenant reported this on move-in day. Multiple wall cracks.',
    );
  });

  it('says nothing about a row that passed', () => {
    // A comment against an all-Y row reads as a defect that was never found.
    const row = rowFor({ label: 'Walls and ceilings', keywords: ['wall'], isClean: true }, [
      { category: 'WALLS', description: 'Multiple wall cracks.' },
    ]);

    expect(row.comment).toBe('');
  });

  it('does not attach a finding about something else in the room', () => {
    const row = rowFor({ label: 'Smoke alarms', keywords: ['smoke', 'alarm'] }, [
      { category: 'Flooring', description: 'Floor stained and unclean.' },
    ]);

    expect(row.comment).toBe('');
  });

  it('still matches on the label when the item carries no keywords', () => {
    // Reports generated against a backend that predates `keywords` still have
    // to explain their failed rows.
    const row = rowFor({ label: 'Smoke alarms' }, [
      { category: 'Smoke alarm', description: 'No smoke alarm observed.' },
    ]);

    expect(row.comment).toBe('No smoke alarm observed.');
  });
});
