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
