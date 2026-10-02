import type { AreaFinding } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingReviewControls } from './FindingReviewControls';

/**
 * A reviewer's decision on an AI finding, as the AI later learns from it: a
 * rejection says why, from a fixed list, and a nearly-right finding is
 * corrected and approved in one step.
 */

const state = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  edit: vi.fn(),
}));

const mutation = (mutateAsync: ReturnType<typeof vi.fn>) => ({
  mutateAsync,
  isPending: false,
  error: null,
});

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    approveFinding: mutation(state.approve),
    rejectFinding: mutation(state.reject),
    editFinding: mutation(state.edit),
  }),
}));

function finding(overrides: Partial<AreaFinding> = {}): AreaFinding {
  return {
    id: 'finding-wall',
    title: 'Damaged wall near the door',
    description: 'A large scuff on the wall.',
    category: 'Walls',
    findingType: 'POSSIBLE_NEW_DAMAGE',
    severity: 'HIGH',
    comparisonResult: 'POSSIBLE_NEW_DAMAGE',
    confidence: 0.8,
    reviewStatus: 'PENDING_REVIEW',
    createdAt: '2026-10-03T00:00:00.000Z',
    recordingId: 'media-1',
    videoTimestampStart: 18,
    videoTimestampEnd: 24,
    photoCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset().mockResolvedValue({});
});

describe('rejecting a finding', () => {
  it('takes a reason from the list, with no note needed', async () => {
    const onDecided = vi.fn();
    render(<FindingReviewControls finding={finding()} inspectionId="insp-1" onDecided={onDecided} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Confirm reject' });
    expect(confirm).toBeDisabled();

    const reasons = screen.getByRole('group', { name: 'Rejection reason from the list' });
    fireEvent.click(within(reasons).getByRole('button', { name: 'Normal wear' }));
    expect(within(reasons).getByRole('button', { name: 'Normal wear' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'Rejection reason' })).toHaveAttribute(
      'placeholder',
      'Add a note (optional)',
    );
    fireEvent.click(confirm);

    expect(state.reject).toHaveBeenCalledWith({
      id: 'finding-wall',
      inspectionId: 'insp-1',
      reasonCode: 'NORMAL_WEAR',
      reason: undefined,
    });
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
  });

  it('needs a note for Other, as it does with no reason chosen', () => {
    render(<FindingReviewControls finding={finding()} inspectionId="insp-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));

    const confirm = screen.getByRole('button', { name: 'Confirm reject' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Rejection reason' }), {
      target: { value: '  Tenant fixed it before the walk.  ' },
    });
    fireEvent.click(confirm);

    expect(state.reject).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'OTHER', reason: 'Tenant fixed it before the walk.' }),
    );
  });
});

describe('correcting a finding and approving it', () => {
  it('starts from what the AI wrote and sends every field, changed or not', async () => {
    const onDecided = vi.fn();
    render(<FindingReviewControls finding={finding()} inspectionId="insp-1" onDecided={onDecided} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit & approve' }));
    const title = screen.getByRole('textbox', { name: 'Finding title' });
    expect(title).toHaveValue('Damaged wall near the door');

    fireEvent.change(title, { target: { value: 'Scuffed paint near the door' } });
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Severity' })).getByRole('button', { name: 'Low' }),
    );
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Finding type' })).getByRole('button', {
        name: 'Maintenance',
      }),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on the correction' }), {
      target: { value: 'Paint, not drywall.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & approve' }));

    expect(state.edit).toHaveBeenCalledWith({
      id: 'finding-wall',
      inspectionId: 'insp-1',
      title: 'Scuffed paint near the door',
      description: 'A large scuff on the wall.',
      severity: 'LOW',
      findingType: 'MAINTENANCE',
      category: 'Walls',
      note: 'Paint, not drywall.',
    });
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
  });

  it('will not save a finding with no title', () => {
    render(<FindingReviewControls finding={finding()} inspectionId="insp-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit & approve' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Finding title' }), {
      target: { value: ' ' },
    });

    expect(screen.getByRole('button', { name: 'Save & approve' })).toBeDisabled();
  });
});

describe('a decided finding', () => {
  it('says it was approved with edits', () => {
    render(
      <FindingReviewControls
        finding={finding({
          reviewStatus: 'APPROVED',
          lastReview: {
            status: 'EDITED',
            reason: 'Paint, not drywall.',
            reviewerName: 'Ana',
            createdAt: '2026-10-03T15:00:00.000Z',
          },
        })}
        inspectionId="insp-1"
      />,
    );

    expect(
      screen.getByText(/^Approved with edits · Ana · .+ · Paint, not drywall\.$/),
    ).toBeInTheDocument();
  });

  it('says why it was rejected', () => {
    render(
      <FindingReviewControls
        finding={finding({
          reviewStatus: 'REJECTED',
          lastReview: {
            status: 'REJECTED',
            reason: null,
            reasonCode: 'ALREADY_AT_MOVE_IN',
            reviewerName: 'Ana',
            createdAt: '2026-10-03T15:00:00.000Z',
          },
        })}
        inspectionId="insp-1"
      />,
    );

    expect(screen.getByText(/^Rejected · Already at move-in · Ana · /)).toBeInTheDocument();
  });
});
