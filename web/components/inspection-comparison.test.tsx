import type { AdminAreaComparison, AdminInspectionComparison } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectionComparisonPanel } from './inspection-comparison';

/**
 * The move-in comparison, room by room and item by item (2026-10-03). On 5819
 * Flower Gate Dr it read "uncertain" for nearly every room; the items are what
 * the verdict is drawn from.
 */

const state = vi.hoisted(() => ({
  data: null as AdminInspectionComparison | null,
}));

vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: () => true }),
}));
vi.mock('@/lib/queries', () => ({
  useInspectionComparison: () => ({
    data: state.data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const sound = { clean: true, undamaged: true, working: true, comment: null };

function entrance(fields: Partial<AdminAreaComparison> = {}): AdminAreaComparison {
  return {
    id: 'cmp-entrance',
    areaName: 'Entrance',
    classification: 'NEW_DAMAGE',
    matchMethod: 'LOCAL_AREA_ID',
    matchConfidence: 1,
    summary: 'New since move-in: Windows and locks. Already damaged at move-in: Floor and coverings.',
    moveOutAreaId: 'inspection-area-entrance',
    aiNote:
      '1 AI finding of new damage here is waiting to be confirmed from the recording; it joins the report once confirmed.',
    items: [
      {
        itemId: 'floor',
        label: 'Floor and coverings',
        moveIn: { clean: true, undamaged: false, working: true, comment: 'Tiles chipped at the door' },
        moveOut: { clean: false, undamaged: false, working: true, comment: null },
        change: 'ALREADY_DAMAGED',
        cleaning: 'NEEDS_CLEANING',
        findings: [
          {
            id: 'finding-floor',
            title: 'Cracked floor tiles at the door',
            severity: 'MEDIUM',
            findingType: 'POSSIBLE_NEW_DAMAGE',
            reviewStatus: 'PENDING_REVIEW',
            source: 'NARRATION',
          },
        ],
      },
      {
        itemId: 'windows',
        label: 'Windows and locks',
        moveIn: sound,
        moveOut: { clean: true, undamaged: false, working: true, comment: null },
        change: 'NEW_DAMAGE',
        cleaning: null,
        findings: [],
      },
      {
        itemId: 'lights',
        label: 'Lights and power points',
        moveIn: sound,
        moveOut: sound,
        change: 'NO_CHANGE',
        cleaning: null,
        findings: [],
      },
    ],
    otherFindings: [],
    ...fields,
  };
}

function comparison(
  areas: AdminAreaComparison[],
  fields: Partial<AdminInspectionComparison> = {},
): AdminInspectionComparison {
  return {
    id: 'comparison-1',
    moveOutInspectionId: 'move-out-1',
    moveInInspectionId: 'move-in-1',
    overallCondition: 'NEW_DAMAGE',
    version: 10,
    generator: 'DETERMINISTIC',
    generatedAt: '2026-10-03T15:00:00.000Z',
    recordingsProcessing: 0,
    findingsToConfirm: 0,
    areas,
    ...fields,
  };
}

beforeEach(() => {
  state.data = comparison([
    entrance(),
    entrance({
      id: 'cmp-laundry',
      areaName: 'Laundry',
      classification: 'UNCHANGED',
      summary: 'No change in condition on any item graded at both inspections.',
      moveOutAreaId: 'inspection-area-laundry',
      aiNote: null,
    }),
  ]);
});

describe('the move-in comparison', () => {
  it('opens a room with a finding waiting on its items, side by side', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    const tables = screen.getAllByRole('table', {
      name: 'Checklist items, move-in against move-out',
    });
    // The entrance has a finding to confirm and opens; the laundry does not.
    expect(tables).toHaveLength(1);
    const floor = within(tables[0]).getByRole('row', { name: /Floor and coverings/ });
    expect(within(floor).getByText('Damaged')).toBeInTheDocument();
    expect(within(floor).getByText('Damaged · dirty')).toBeInTheDocument();
    expect(within(floor).getByText('Tiles chipped at the door')).toBeInTheDocument();
    expect(within(floor).getByText('Already at move-in')).toBeInTheDocument();
    expect(within(floor).getByText('Needs cleaning')).toBeInTheDocument();
    // The finding about the floor sits under it, with where it stands.
    expect(within(floor).getByText('Cracked floor tiles at the door')).toBeInTheDocument();
    expect(
      within(within(tables[0]).getByRole('row', { name: /Windows and locks/ })).getByText(
        'New since move-in',
      ),
    ).toBeInTheDocument();
  });

  it('says which findings are still to confirm, and links to the room’s evidence', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getAllByText(/waiting to be confirmed from the recording/)).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: "Open the room's evidence" })[0]).toHaveAttribute(
      'href',
      '/inspections/move-out-1?area=inspection-area-entrance',
    );
  });

  it('opens and closes a room’s items on request', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Show 3 items' }));
    expect(screen.getAllByRole('table')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Hide items' })[0]);
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('totals the items across the rooms', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByText('2 new since move-in (2 rooms)')).toBeInTheDocument();
    expect(screen.getByText('2 already at move-in · 2 need cleaning')).toBeInTheDocument();
  });

  it('names a room the record cannot settle for what it is', () => {
    state.data = comparison([
      entrance({
        classification: 'NOT_COMPARABLE',
        summary: 'Damaged at move-out, but not graded at move-in: Walls and ceilings.',
      }),
    ]);
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByText('Cannot be compared')).toBeInTheDocument();
  });
});

/**
 * Nothing to approve (the office, 2026-10-07): the comparison is drawn from the
 * checklists and the confirmed findings, kept current, and sent when wanted.
 */
describe('a comparison going out', () => {
  it('can be shared as soon as it is here, with nothing to decide first', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled();
    for (const gone of ['Approve comparison', 'Reject', 'Override', 'Regenerate'])
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    // No room waits on a verdict. (A finding still says it waits for the office.)
    expect(screen.queryByText(/Requires review/)).toBeNull();
  });

  it('says what has not reached it yet, without holding it back', () => {
    state.data = comparison([entrance()], { recordingsProcessing: 2, findingsToConfirm: 1 });
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(
      screen.getByText('2 move-out recordings are still being processed; their findings will follow.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '1 finding is waiting to be confirmed on the inspection page; it joins the report once confirmed.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled();
  });

  it('says how a comparison comes to exist when there is none yet', () => {
    state.data = null;
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByText(/made by itself once the move-out is submitted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate/ })).toBeNull();
  });
});
