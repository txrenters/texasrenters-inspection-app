import type { AreaChecklistEntry } from '@texasrenters/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AreaDetailPanel } from './AreaDetailPanel';

/**
 * An occupied room's two questions, as the console shows them.
 *
 * The answers are stored as chosen options -- "Clean", "Good" -- with the
 * clean / undamaged / working axes null. The tab counted only axes and read
 * "Condition (0/2)" above a panel saying "2 of 2 assessed", and the answers sat
 * centred under a Clean | Undamaged | Working header, so "Clean" read as the
 * Undamaged verdict.
 */

let checklist: AreaChecklistEntry[] = [];

vi.mock('@/lib/queries', () => ({
  useAreaEvidence: () => ({
    isLoading: false,
    isError: false,
    refetch: () => {},
    data: {
      area: {
        id: 'area-1',
        propertyAreaId: 'property-area-1',
        name: 'Entrance',
        floorName: null,
        environment: 'INDOOR',
        isRequired: false,
        completionStatus: 'COMPLETED',
        reviewStatus: 'EVIDENCE_READY',
        skipReason: null,
        technicianNote: null,
      },
      conditionSummary: null,
      recordings: [],
      photoGroups: [],
      findings: [],
      counts: { recordings: 0, photos: 0, findings: 0, unreviewedFindings: 0 },
      checklist,
    },
  }),
  useRecordChecklistItem: () => ({ isPending: false, variables: undefined, error: null, mutate: () => {} }),
  useAdminMutations: () => ({
    approveFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    rejectFinding: { isPending: false, error: null, mutateAsync: async () => {} },
  }),
}));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));

const entry = (overrides: Partial<AreaChecklistEntry>): AreaChecklistEntry =>
  ({
    itemId: 'item',
    label: 'Item',
    isClean: null,
    isUndamaged: null,
    isWorking: null,
    comment: null,
    section: null,
    responseType: 'STATUS',
    unit: null,
    numericValue: null,
    textValue: null,
    recordedAt: '2026-09-14T17:00:00.000Z',
    videoTimestampSeconds: null,
    ...overrides,
  }) as AreaChecklistEntry;

const occupiedPair = [
  entry({ itemId: 'occ-1', label: 'Room condition', responseType: 'CHOICE', textValue: 'Clean' }),
  entry({ itemId: 'occ-2', label: 'Overall condition', responseType: 'CHOICE', textValue: 'Good' }),
];

afterEach(cleanup);

describe('the condition tab of an occupied room', () => {
  it('counts answered questions the way the panel does', () => {
    checklist = occupiedPair;
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="condition" />);

    expect(screen.getByRole('tab', { name: /condition/i }).textContent).toContain('(2/2)');
    expect(screen.getByText(/2 of 2 assessed/i)).toBeTruthy();
  });

  it('heads the answers as answers, not as three verdict columns', () => {
    checklist = occupiedPair;
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="condition" />);

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Answer' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Undamaged' })).toBeNull();
    expect(within(table).getByText('Clean')).toBeTruthy();
    expect(within(table).getByText('Good')).toBeTruthy();
  });

  it('keeps the three verdict columns for a room scored on them', () => {
    checklist = [entry({ itemId: 'walls', label: 'Walls', isClean: true, isUndamaged: false })];
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="condition" />);

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Undamaged' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Answer' })).toBeNull();
    expect(screen.getByRole('tab', { name: /condition/i }).textContent).toContain('(1/1)');
  });
});
