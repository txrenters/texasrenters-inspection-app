import type { AreaChecklistEntry } from '@texasrenters/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  useFillAreaFromNarration: () => ({ isPending: false, error: null, data: undefined, mutate: () => {} }),
  useFillInspectionFromNarration: () => ({ isPending: false, error: null, data: undefined, mutate: () => {} }),
  useRecordChecklistItem: () => ({ isPending: false, variables: undefined, error: null, mutate: () => {} }),
  useAdminMutations: () => ({
    approveFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    rejectFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    editFinding: { isPending: false, error: null, mutateAsync: async () => {} },
  }),
  useInspection: () => ({ data: { finalizedAt: null } }),
  useSetAreaReviewed: () => ({ error: null, mutate: () => {} }),
}));
let canManage = true;
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (permission: string) => permission !== 'inspections:manage' || canManage }),
}));
vi.mock('@/components/area-checklist/AreaChecklistDialog', () => ({
  AreaChecklistDialog: ({ areaId, areaName }: { areaId: string; areaName: string }) => (
    <div aria-label={`Checklist template for ${areaName}`} role="dialog">
      {areaId}
    </div>
  ),
}));

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

afterEach(() => {
  cleanup();
  canManage = true;
});

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

  it("opens the property's checklist template under its own name, for those who manage inspections", () => {
    // It used to open from the "Checklist · 2/7" progress in the area list, so
    // a reviewer clicking their scoring progress landed in an editor that
    // changes what every later visit to the property asks.
    checklist = occupiedPair;
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="condition" />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit checklist template' }));
    expect(screen.getByRole('dialog', { name: 'Checklist template for Entrance' }).textContent).toBe(
      'property-area-1',
    );
  });

  it('offers no template editor to a reviewer who cannot manage inspections', () => {
    checklist = occupiedPair;
    canManage = false;
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="condition" />);

    expect(screen.queryByRole('button', { name: 'Edit checklist template' })).toBeNull();
  });
});

describe('the overview of a room that was photographed, not filmed', () => {
  it('says there is no recording to summarise, rather than promising a summary', () => {
    checklist = occupiedPair;
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="overview" />);

    expect(screen.getByText('No recording to summarise')).toBeTruthy();
    expect(screen.queryByText('No condition summary yet')).toBeNull();
  });

  it('names the floor only when there is one', () => {
    checklist = occupiedPair;
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="overview" />);

    expect(screen.getByText('Optional · Completed')).toBeTruthy();
    expect(screen.queryByText(/No floor recorded/)).toBeNull();
  });
});
