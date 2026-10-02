import type { AreaRecording } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReanalyzeControl, ReanalyzeStatus, canReanalyze } from './ReanalyzeControl';

/**
 * "Re-run AI" on a recording.
 *
 * A recording analysed under an older prompt kept its findings for good. The
 * office can now run it again; it replaces only the findings still awaiting a
 * decision, so it says how many before it does.
 */

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    reanalyzeRecording: {
      mutate: state.mutate,
      isPending: state.isPending,
      isError: false,
      error: null,
    },
  }),
}));

function recording(overrides: Partial<AreaRecording> = {}): AreaRecording {
  return {
    id: 'media-1',
    recordingType: 'PRIMARY_AREA',
    durationSeconds: 165,
    uploadStatus: 'UPLOADED',
    processingStatus: 'READY',
    technicianName: 'Moses',
    createdAt: '2026-10-01T23:15:00.000Z',
    frameMarkersMs: [],
    analysisRun: null,
    contentPath: '/api/v1/admin/media/media-1/content',
    ...overrides,
  };
}

function show(data: AreaRecording, pendingFindings = 5, lockedReason: string | null = null) {
  render(
    <>
      <ReanalyzeControl
        areaId="area-1"
        inspectionId="inspection-1"
        lockedReason={lockedReason}
        pendingFindings={pendingFindings}
        recording={data}
      />
      <ReanalyzeStatus recording={data} />
    </>,
  );
}

beforeEach(() => {
  state.mutate.mockReset();
  state.isPending = false;
});

describe('re-running the AI on a recording', () => {
  it('says what it replaces before it does anything', () => {
    show(recording());

    fireEvent.click(screen.getByRole('button', { name: 'Re-run AI' }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByText('Replaces the 5 findings still awaiting a decision. Decided ones stay.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    expect(state.mutate).toHaveBeenCalledWith(
      { mediaId: 'media-1', inspectionId: 'inspection-1', areaId: 'area-1' },
      expect.anything(),
    );
  });

  it('can be called off', () => {
    show(recording());
    fireEvent.click(screen.getByRole('button', { name: 'Re-run AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Re-run' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Re-run AI' })).toBeTruthy();
  });

  it('offers nothing to press while a run is going', () => {
    show(recording({ analysisRun: { status: 'RUNNING', at: '2026-10-02T16:00:00.000Z' } }));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Re-running the AI/)).toBeTruthy();
  });

  it('says why the last run failed, and offers another', () => {
    show(
      recording({
        analysisRun: {
          status: 'FAILED',
          at: '2026-10-02T16:00:00.000Z',
          message: 'The AI provider account has no remaining credits.',
        },
      }),
    );
    expect(screen.getByText(/no remaining credits/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-run AI' })).toBeTruthy();
  });

  // Once finalized it used to disappear, which read as the button having been
  // removed. It stays, and says why it cannot run.
  it('is shown locked on a finalized inspection, and says why instead of running', () => {
    show(recording(), 5, 'This inspection was finalized Oct 2, 2026 by Kimson.');

    fireEvent.click(screen.getByRole('button', { name: 'Re-run AI' }));
    expect(screen.getByText('This inspection was finalized Oct 2, 2026 by Kimson.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Re-run' })).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
});

describe('which recordings can be re-run', () => {
  it('is one whose first pass is done, or whose analysis failed', () => {
    expect(canReanalyze(recording({ processingStatus: 'READY' }))).toBe(true);
    expect(canReanalyze(recording({ processingStatus: 'ANALYSIS_FAILED' }))).toBe(true);
  });

  it('is not one still in its first pass, nor one Cloudflare could not encode', () => {
    for (const processingStatus of ['PENDING', 'PROCESSING', 'FAILED'])
      expect(canReanalyze(recording({ processingStatus }))).toBe(false);
  });
});
