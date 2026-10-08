import type { AdminAreaComparison, AdminInspectionComparison } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectionComparisonPanel } from './inspection-comparison';

/**
 * The move-in comparison, room by room and item by item (2026-10-03). On 5819
 * Flower Gate Dr it read "uncertain" for nearly every room; the items are what
 * the verdict is drawn from. Laid out to be scanned (2026-10-09): four figures,
 * filters, a line a room, and inside a room only what changed.
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
    moveInAreaName: 'Entrance',
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
        findings: [
          {
            id: 'finding-window',
            title: 'Window pane cracked',
            severity: 'MEDIUM',
            findingType: 'POSSIBLE_NEW_DAMAGE',
            reviewStatus: 'APPROVED',
            source: 'AI_VISION',
          },
        ],
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

const laundry: AdminAreaComparison = {
  id: 'cmp-laundry',
  areaName: 'Laundry',
  classification: 'UNCHANGED',
  matchMethod: 'LOCAL_AREA_ID',
  matchConfidence: 1,
  summary: 'No change in condition on any item graded at both inspections.',
  moveOutAreaId: 'inspection-area-laundry',
  moveInAreaName: 'Laundry',
  items: [
    { itemId: 'walls', label: 'Walls and ceilings', moveIn: sound, moveOut: sound, change: 'NO_CHANGE', cleaning: null, findings: [] },
  ],
  otherFindings: [],
};

const stairs: AdminAreaComparison = {
  id: 'cmp-stairs',
  areaName: 'Stairs',
  classification: 'MISSING_BASELINE',
  matchMethod: 'UNMATCHED',
  matchConfidence: 0,
  summary: 'The move-in inspection has no matching room, so there is nothing to compare it with.',
  moveOutAreaId: 'inspection-area-stairs',
  moveInAreaName: null,
  items: [],
  otherFindings: [],
};

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
    findingsToConfirm: 1,
    areas,
    ...fields,
  };
}

beforeEach(() => {
  state.data = comparison([entrance(), laundry, stairs]);
});

function rowFor(name: RegExp) {
  return screen.getByRole('button', { name });
}

describe('the move-in comparison', () => {
  it('opens on the rooms that need something, a line each', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByRole('button', { name: /Needs attention/ })).toHaveAttribute('aria-pressed', 'true');
    const entranceRow = rowFor(/^Entrance/);
    expect(entranceRow).toHaveTextContent('1 new · 1 already at move-in · 1 to clean');
    expect(entranceRow).toHaveTextContent('1 to confirm');
    // Nothing to act on, or nothing to compare: under their own filters.
    expect(screen.queryByRole('button', { name: /^Laundry/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Stairs/ })).toBeNull();
    // No room opens by itself, and the office's matching words are gone.
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/local area id|100%/i)).toBeNull();
  });

  it('shows a room only what changed, and the rest on request', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);
    fireEvent.click(rowFor(/^Entrance/));

    const table = screen.getByRole('table', { name: 'Checklist items, move-in against move-out' });
    const floor = within(table).getByRole('row', { name: /Floor and coverings/ });
    expect(within(floor).getByText('Damaged')).toBeInTheDocument();
    expect(within(floor).getByText('Damaged · dirty')).toBeInTheDocument();
    expect(within(floor).getByText('Tiles chipped at the door')).toBeInTheDocument();
    expect(within(floor).getByText('Already at move-in')).toBeInTheDocument();
    expect(within(floor).getByText('Needs cleaning')).toBeInTheDocument();
    expect(
      within(within(table).getByRole('row', { name: /Windows and locks/ })).getByText('New since move-in'),
    ).toBeInTheDocument();
    expect(within(table).queryByRole('row', { name: /Lights and power points/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more item' }));
    expect(screen.getByRole('row', { name: /Lights and power points/ })).toBeInTheDocument();
  });

  it('lists what the office confirmed, and counts what is still to confirm with a way to it', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);
    fireEvent.click(rowFor(/^Entrance/));

    expect(screen.getByText('Window pane cracked')).toBeInTheDocument();
    // Waiting: counted, not listed -- it cannot be confirmed from here.
    expect(screen.queryByText('Cracked floor tiles at the door')).toBeNull();
    expect(
      screen.getByText('1 finding here waiting to be confirmed; not on the report until confirmed.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review in the inspection' })).toHaveAttribute(
      'href',
      '/inspections/move-out-1?area=inspection-area-entrance',
    );
  });

  it('sums up the comparison in four figures, the findings to confirm linking to them', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByText('Rooms with new damage').parentElement?.parentElement).toHaveTextContent('1');
    expect(screen.getByText('Items damaged since move-in').parentElement?.parentElement).toHaveTextContent('1');
    expect(screen.getByText('Items to clean').parentElement?.parentElement).toHaveTextContent('1');
    expect(screen.getByRole('link', { name: 'Review on the inspection page' })).toHaveAttribute(
      'href',
      '/inspections/move-out-1',
    );
  });

  it('filters the rooms', () => {
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Only in one inspection/ }));
    expect(rowFor(/^Stairs/)).toHaveTextContent('Move-out only');
    expect(rowFor(/^Stairs/)).toHaveTextContent('Not at move-in');
    expect(screen.queryByRole('button', { name: /^Entrance/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /All rooms/ }));
    expect(rowFor(/^Laundry/)).toHaveTextContent('Nothing changed');
    fireEvent.click(rowFor(/^Laundry/));
    expect(screen.getByText('Nothing changed on the 1 item checked.')).toBeInTheDocument();
  });

  it('says which move-in room a differently named one was compared with', () => {
    state.data = comparison([
      entrance({ areaName: 'Downstairs living room', moveInAreaName: 'Living Room', matchMethod: 'AI_SUGGESTED' }),
    ]);
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(rowFor(/Downstairs living room/)).toHaveTextContent('Compared with the move-in’s “Living Room”');
    fireEvent.click(rowFor(/Downstairs living room/));
    expect(screen.getByText(/Paired by AI: check that/)).toBeInTheDocument();
  });

  it('names a room the record cannot settle for what it is', () => {
    state.data = comparison([
      entrance({
        classification: 'NOT_COMPARABLE',
        summary: 'Damaged at move-out, but not graded at move-in: Walls and ceilings.',
      }),
    ]);
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByText("Can't tell what's new")).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: 'Open report' })).toHaveAttribute(
      'href',
      '/inspections/move-out-1/comparison-report',
    );
    for (const gone of ['Approve comparison', 'Reject', 'Override', 'Regenerate'])
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    expect(screen.queryByText(/Requires review/)).toBeNull();
  });

  it('says what has not reached it yet, without holding it back', () => {
    state.data = comparison([entrance()], { recordingsProcessing: 2, findingsToConfirm: 1 });
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(
      screen.getByText('2 move-out recordings are still being processed; their findings will follow.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Findings to confirm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled();
  });

  it('says how a comparison comes to exist when there is none yet', () => {
    state.data = null;
    render(<InspectionComparisonPanel inspectionId="move-out-1" />);

    expect(screen.getByText(/made by itself once the move-out is submitted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate/ })).toBeNull();
  });
});
