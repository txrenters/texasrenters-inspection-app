import type { AdminAreaComparison, AdminInspectionComparison } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectionComparisonPanel } from './inspection-comparison';

/**
 * The move-in comparison, room by room and item by item (2026-10-03). On 5819
 * Flower Gate Dr it read "uncertain" for nearly every room; the items are what
 * the reviewer decides from.
 */

const state = vi.hoisted(() => ({
  data: null as AdminInspectionComparison | null,
  generateError: null as Error | null,
}));

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null };

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
  useAdminMutations: () => ({
    generateComparison: { ...idle, error: state.generateError },
    reviewComparison: idle,
    overrideAreaComparison: idle,
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
    requiresReview: true,
    summary: 'New since move-in: Windows and locks. Already damaged at move-in: Floor and coverings.',
    moveOutAreaId: 'inspection-area-entrance',
    aiNote: '1 AI finding calls damage new that the move-in already recorded; compare the photographs to see whether it got worse.',
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

function comparison(areas: AdminAreaComparison[]): AdminInspectionComparison {
  return {
    id: 'comparison-1',
    moveOutInspectionId: 'move-out-1',
    moveInInspectionId: 'move-in-1',
    status: 'DRAFT',
    overallCondition: 'NEW_DAMAGE',
    version: 10,
    generator: 'DETERMINISTIC',
    requiresReviewCount: 1,
    generatedAt: '2026-10-03T15:00:00.000Z',
    areas,
  };
}

beforeEach(() => {
  state.generateError = null;
  state.data = comparison([
    entrance(),
    entrance({
      id: 'cmp-laundry',
      areaName: 'Laundry',
      classification: 'UNCHANGED',
      requiresReview: false,
      summary: 'No change in condition on any item graded at both inspections.',
      moveOutAreaId: 'inspection-area-laundry',
      aiNote: null,
    }),
  ]);
});

describe('the move-in comparison', () => {
  it('opens a room that needs a decision on its items, side by side', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    const tables = screen.getAllByRole('table', {
      name: 'Checklist items, move-in against move-out',
    });
    // The entrance needs a decision and opens; the laundry does not.
    expect(tables).toHaveLength(1);
    const floor = within(tables[0]).getByRole('row', { name: /Floor and coverings/ });
    expect(within(floor).getByText('Damaged')).toBeInTheDocument();
    expect(within(floor).getByText('Damaged · dirty')).toBeInTheDocument();
    expect(within(floor).getByText('Tiles chipped at the door')).toBeInTheDocument();
    expect(within(floor).getByText('Already at move-in')).toBeInTheDocument();
    expect(within(floor).getByText('Needs cleaning')).toBeInTheDocument();
    // The finding about the floor sits under it, with where it stands.
    expect(within(floor).getByText('Cracked floor tiles at the door')).toBeInTheDocument();
    expect(within(floor).getByText(/Needs review/)).toBeInTheDocument();
    expect(
      within(within(tables[0]).getByRole('row', { name: /Windows and locks/ })).getByText(
        'New since move-in',
      ),
    ).toBeInTheDocument();
  });

  it('says why the AI sends a room to review, and links to the room’s evidence', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getAllByText(/1 AI finding calls damage new/)).toHaveLength(1);
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

  it('asks for a regeneration when the comparison predates items', () => {
    state.data = comparison([entrance({ items: [], aiNote: null })]);
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(
      screen.getByText(/generated before rooms were compared item by item\. Regenerate it/),
    ).toBeInTheDocument();
  });

  it('says so when regenerating fails', () => {
    state.generateError = new Error('No matching move-in baseline inspection was found.');
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(
      screen.getByText('No matching move-in baseline inspection was found.'),
    ).toBeInTheDocument();
  });
});

/**
 * Before it goes to an owner or tenant (the office, 2026-10-06): every room
 * decided, the evidence unchanged since it was drawn, and approved.
 */
describe('a comparison going out', () => {
  it('holds the approval until every room is decided, and says why', () => {
    state.data = { ...comparison([entrance()]), undecidedRooms: 2 };
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByRole('button', { name: 'Approve comparison' })).toBeDisabled();
    expect(
      screen.getByText('Decide the 2 rooms marked Requires review first (Override).'),
    ).toBeInTheDocument();
  });

  it('says when the comparison is out of date, and holds the approval for a regenerate', () => {
    state.data = {
      ...comparison([entrance()]),
      undecidedRooms: 0,
      outOfDate: ['CHECKLIST_CHANGED'],
      outOfDateText: 'A checklist answer changed after it was generated.',
    };
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByText(/Out of date\. A checklist answer changed after it was generated\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve comparison' })).toBeDisabled();
  });

  it('offers to share only an approved comparison with nothing left to decide', () => {
    state.data = { ...comparison([entrance()]), undecidedRooms: 0 };
    const { unmount } = render(<InspectionComparisonPanel inspectionId="move-out-1" />);
    const draft = screen.getByRole('button', { name: 'Share' });
    expect(draft).toBeDisabled();
    expect(draft).toHaveAttribute('title', expect.stringContaining('Not approved yet'));
    unmount();

    state.data = { ...comparison([entrance()]), status: 'APPROVED', undecidedRooms: 0, outOfDate: [] };
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);
    expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled();
  });

  it('asks why a room was changed, since the report prints the reason', () => {
    state.data = { ...comparison([entrance()]), status: 'APPROVED', undecidedRooms: 0 };
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Override' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/sends it back for approval/)).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Save override' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason, printed on the report'), {
      target: { value: 'The move-in photographs show the same marks.' },
    });
    expect(save).toBeEnabled();
  });
});
