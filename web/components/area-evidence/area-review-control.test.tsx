import type { AreaEvidenceBundle, AreaReviewMark } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaDetailPanel } from './AreaDetailPanel';

/**
 * Marking an area reviewed.
 *
 * "X of Y reviewed" only moved when an area's findings were all decided, so an
 * area with nothing wrong in it -- most of an occupied inspection -- could never
 * count. The reviewer can now say so directly, but never in place of deciding
 * a finding.
 */

const state = vi.hoisted(() => ({
  bundle: null as unknown as AreaEvidenceBundle,
  finalizedAt: null as string | null,
  canReview: true,
  mutate: vi.fn(),
}));

vi.mock('@/lib/queries', () => ({
  useAreaEvidence: () => ({ isLoading: false, isError: false, refetch: () => {}, data: state.bundle }),
  useFillAreaFromNarration: () => ({ isPending: false, error: null, data: undefined, mutate: () => {} }),
  useFillInspectionFromNarration: () => ({ isPending: false, error: null, data: undefined, mutate: () => {} }),
  useRecordChecklistItem: () => ({ isPending: false, variables: undefined, error: null, mutate: () => {} }),
  useAdminMutations: () => ({
    approveFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    rejectFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    editFinding: { isPending: false, error: null, mutateAsync: async () => {} },
  }),
  useInspection: () => ({ data: { finalizedAt: state.finalizedAt } }),
  useSetAreaReviewed: () => ({ error: null, mutate: state.mutate }),
}));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({
    has: (permission: string) => permission !== 'findings:review' || state.canReview,
  }),
}));

function bundle(
  overrides: {
    photos?: number;
    unreviewedFindings?: number;
    completionStatus?: string;
    reviewStatus?: AreaEvidenceBundle['area']['reviewStatus'];
    review?: AreaReviewMark | null;
  } = {},
): AreaEvidenceBundle {
  const photos = overrides.photos ?? 1;
  return {
    area: {
      id: 'area-1',
      propertyAreaId: 'property-area-1',
      name: 'Living Room',
      floorName: null,
      environment: 'INDOOR',
      isRequired: true,
      completionStatus: overrides.completionStatus ?? 'COMPLETED',
      reviewStatus: overrides.reviewStatus ?? 'EVIDENCE_READY',
      review: overrides.review ?? null,
      skipReason: null,
      technicianNote: null,
    },
    conditionSummary: null,
    recordings: [],
    photoGroups: [],
    findings: [],
    checklist: [],
    counts: {
      recordings: 0,
      photos,
      findings: overrides.unreviewedFindings ?? 0,
      unreviewedFindings: overrides.unreviewedFindings ?? 0,
    },
  };
}

function open(data: AreaEvidenceBundle) {
  state.bundle = data;
  render(
    <AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="overview" />,
  );
}

beforeEach(() => {
  state.finalizedAt = null;
  state.canReview = true;
  state.mutate.mockReset();
});

describe('marking an area reviewed', () => {
  it('offers the mark on an area with nothing left to decide', () => {
    open(bundle());

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));

    expect(state.mutate).toHaveBeenCalledWith({ areaId: 'area-1', reviewed: true });
  });

  it('will not stand in for a finding still awaiting a decision', () => {
    open(bundle({ unreviewedFindings: 2 }));

    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();
    expect(screen.getByText('Decide the 2 findings awaiting review first')).toBeInTheDocument();
  });

  it('will not mark an area nobody recorded anything in', () => {
    open(bundle({ photos: 0 }));

    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();
    expect(screen.getByText('Nothing was recorded in this area')).toBeInTheDocument();
  });

  it('accepts a skipped area, which has nothing in it by definition', () => {
    open(bundle({ photos: 0, completionStatus: 'SKIPPED', reviewStatus: 'SKIPPED' }));

    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeEnabled();
  });

  it('shows who reviewed the area, and lets them take it back', () => {
    open(
      bundle({
        reviewStatus: 'REVIEWED',
        review: { at: '2026-10-02T09:00:00.000Z', byName: 'Ernie', current: true },
      }),
    );

    expect(screen.getByText('Reviewed by Ernie')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(state.mutate).toHaveBeenCalledWith({ areaId: 'area-1', reviewed: false });
  });

  it('asks again once evidence has arrived since the mark', () => {
    open(
      bundle({
        review: { at: '2026-10-01T09:00:00.000Z', byName: 'Ernie', current: false },
      }),
    );

    expect(screen.getByRole('button', { name: 'Review again' })).toBeEnabled();
    expect(screen.getByText('New evidence since it was reviewed by Ernie')).toBeInTheDocument();
  });

  // The office reviews after the visit is closed; reopening to do it would mark
  // the Jobber visit incomplete and restart the technician's paid time.
  it('offers the mark on a finalized inspection too', () => {
    state.finalizedAt = '2026-10-02T10:00:00.000Z';
    open(bundle());

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(state.mutate).toHaveBeenCalledWith({ areaId: 'area-1', reviewed: true });
  });

  it('offers nothing to someone who may not decide findings', () => {
    state.canReview = false;
    open(bundle());

    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
  });
});
