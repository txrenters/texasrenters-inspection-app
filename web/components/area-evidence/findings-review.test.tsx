import type { AreaEvidenceBundle, AreaFinding, AreaRecording } from '@texasrenters/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaDetailPanel } from './AreaDetailPanel';

/**
 * Reviewing an area's findings against its recording.
 *
 * The office's complaint, 2026-10-02: watch the video, check the findings, go
 * back to the video to find each one. A finding's "video 1:05" was text inside
 * the button that expanded it, so nothing ever seeked. Choosing a finding now
 * plays the recording from its moment, shows stills from it, and a decision
 * moves on to the next finding still waiting.
 */

const state = vi.hoisted(() => ({
  bundle: null as unknown as AreaEvidenceBundle,
  finalizedAt: null as string | null,
  approve: vi.fn(async () => {}),
  capture: vi.fn(),
}));

vi.mock('@/lib/queries', () => ({
  useAreaEvidence: () => ({ isLoading: false, isError: false, refetch: () => {}, data: state.bundle }),
  useRecordChecklistItem: () => ({ isPending: false, variables: undefined, error: null, mutate: () => {} }),
  useAdminMutations: () => ({
    approveFinding: { isPending: false, error: null, mutateAsync: state.approve },
    rejectFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    editFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    addFinding: { isPending: false, error: null, mutateAsync: async () => ({ id: 'finding-new' }) },
    captureSnapshot: { isPending: false, isError: false, error: null, mutate: state.capture },
    reanalyzeRecording: { isPending: false, isError: false, error: null, mutate: () => {} },
  }),
  useInspection: () => ({ data: { finalizedAt: state.finalizedAt } }),
  useSetAreaReviewed: () => ({ error: null, mutate: () => {} }),
  // Each recording's narration, one line naming the recording it belongs to.
  useRecordingTranscript: (mediaId: string) => ({
    isLoading: false,
    isError: false,
    data: {
      mediaId,
      status: 'COMPLETED',
      lines: [{ start: 12, end: 16, text: `Narration of ${mediaId}.` }],
    },
  }),
  useVideoPlayback: (mediaId: string) => ({
    isLoading: false,
    isError: false,
    refetch: () => {},
    data: {
      videoId: mediaId,
      provider: 'cloudflare_stream',
      status: 'ready',
      iframeUrl: `https://customer-x.cloudflarestream.com/${mediaId}.tok/iframe`,
      thumbnailUrl: `https://customer-x.cloudflarestream.com/${mediaId}.tok/thumbnails/thumbnail.jpg`,
    },
  }),
}));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));

function recording(id: string, overrides: Partial<AreaRecording> = {}): AreaRecording {
  return {
    id,
    recordingType: 'PRIMARY_AREA',
    durationSeconds: 165,
    widthPx: 720,
    heightPx: 1280,
    uploadStatus: 'UPLOADED',
    processingStatus: 'READY',
    technicianName: 'Moses',
    createdAt: '2026-10-01T23:15:00.000Z',
    frameMarkersMs: [],
    analysisRun: null,
    contentPath: `/api/v1/admin/media/${id}/content`,
    ...overrides,
  };
}

function finding(id: string, title: string, start: number, end: number, overrides: Partial<AreaFinding> = {}): AreaFinding {
  return {
    id,
    title,
    description: `${title}, as narrated.`,
    category: 'Walls',
    findingType: 'POSSIBLE_NEW_DAMAGE',
    severity: 'MEDIUM',
    comparisonResult: 'MISSING_EVIDENCE',
    confidence: 0.9,
    reviewStatus: 'PENDING_REVIEW',
    createdAt: '2026-10-02T00:33:00.000Z',
    recordingId: 'walkthrough',
    videoTimestampStart: start,
    videoTimestampEnd: end,
    photoCount: 0,
    recommendedReview: 'Compare with the move-in photographs.',
    possibleResponsibility: 'TENANT_REVIEW_REQUIRED',
    ...overrides,
  };
}

function bundle(findings: AreaFinding[], recordings = [recording('walkthrough')]): AreaEvidenceBundle {
  return {
    area: {
      id: 'area-1',
      propertyAreaId: 'property-area-1',
      name: 'Entrance',
      floorName: null,
      environment: 'INDOOR',
      isRequired: true,
      completionStatus: 'COMPLETED',
      reviewStatus: 'FINDINGS_NEED_REVIEW',
      review: null,
      skipReason: null,
      technicianNote: null,
    },
    conditionSummary: null,
    recordings,
    photoGroups: [],
    findings,
    checklist: [],
    counts: {
      recordings: recordings.length,
      photos: 0,
      findings: findings.length,
      unreviewedFindings: findings.length,
    },
  };
}

function open(data: AreaEvidenceBundle, tab = 'findings') {
  state.bundle = data;
  render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab={tab} />);
}

const player = () => document.querySelector('iframe');

beforeEach(() => {
  state.finalizedAt = null;
  state.approve.mockClear();
  state.capture.mockReset();
});

describe('choosing a finding', () => {
  it('plays the recording from the moment the technician talks about it', () => {
    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]));
    expect(player()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Entrance floor damaged/ }));

    expect(player()?.getAttribute('src')).toBe(
      'https://customer-x.cloudflarestream.com/walkthrough.tok/iframe?startTime=61s&autoplay=true',
    );
  });

  it('shows stills from across the moment, each of which plays from there', () => {
    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]));
    fireEvent.click(screen.getByRole('button', { name: /Entrance floor damaged/ }));

    const list = screen.getByRole('list', { name: 'Frames from this finding' });
    const frames = within(list);
    // Decorative to assistive technology: each frame's button names its moment.
    const images = [...list.querySelectorAll('img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual(
      [60, 65, 69, 74].map(
        (second) =>
          `https://customer-x.cloudflarestream.com/walkthrough.tok/thumbnails/thumbnail.jpg?time=${second}s&height=360`,
      ),
    );

    fireEvent.click(frames.getByRole('button', { name: 'Play from 1:09' }));
    expect(player()?.getAttribute('src')).toContain('startTime=69s');
  });

  it('files a frame under the finding as its evidence', () => {
    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]));
    fireEvent.click(screen.getByRole('button', { name: /Entrance floor damaged/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Add the 1:05 frame as evidence' }));

    expect(state.capture).toHaveBeenCalledWith(
      {
        mediaId: 'walkthrough',
        inspectionId: 'inspection-1',
        areaId: 'area-1',
        atMs: 65_000,
        findingId: 'floor',
      },
      expect.anything(),
    );
  });

  it('says what the AI asks to check, and words its lean as a suggestion', () => {
    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]));
    fireEvent.click(screen.getByRole('button', { name: /Entrance floor damaged/ }));

    expect(screen.getByText('Compare with the move-in photographs.')).toBeInTheDocument();
    expect(
      screen.getByText(/No move-in record to compare · AI suggests checking tenant responsibility/),
    ).toBeInTheDocument();
  });

  it('does not pretend a finding with no time starts at 0:00', () => {
    open(bundle([finding('walls', 'Walls need paint', 0, 0)]));

    expect(screen.getByText(/no time given/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Walls need paint/ }));
    expect(screen.getByText(/Re-run the AI on the recording to place it/)).toBeInTheDocument();
    // The player waits to be asked rather than opening at the start.
    expect(player()).toBeNull();
  });
});

describe('deciding a finding', () => {
  it('moves on to the next one still waiting, and plays its moment', async () => {
    open(
      bundle([
        finding('floor', 'Entrance floor damaged', 61, 74),
        finding('door', 'Door hole', 18, 24, { reviewStatus: 'APPROVED' }),
        finding('trim', 'Transition piece', 76, 82),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: /Entrance floor damaged/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(state.approve).toHaveBeenCalledWith({ id: 'floor', inspectionId: 'inspection-1' });
    expect(
      await screen.findByRole('button', { name: /Transition piece/, expanded: true }),
    ).toBeInTheDocument();
    expect(player()?.getAttribute('src')).toContain('startTime=76s');
  });

  it('offers Re-run AI at the top of the recording, beside the findings and on the Recording tab', () => {
    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]));
    expect(screen.getByRole('button', { name: 'Re-run AI' }).closest('header')).not.toBeNull();
    cleanup();

    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]), 'recording');
    expect(screen.getByRole('button', { name: 'Re-run AI' }).closest('header')).not.toBeNull();
  });

  // 10830 Harston Dr, 2026-10-02: finalized with its findings still waiting, and
  // every room lost Approve, Reject and Re-run AI. The office reviews after the
  // visit is closed -- for the reports and the move-in comparison -- and
  // reopening would mark the Jobber visit incomplete and restart the
  // technician's paid time.
  it('offers Re-run AI on a finalized inspection too', () => {
    state.finalizedAt = '2026-10-02T15:00:00.000Z';
    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]), 'recording');

    fireEvent.click(screen.getByRole('button', { name: 'Re-run AI' }));
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeInTheDocument();
  });

  it('is still decided once the inspection is finalized', () => {
    state.finalizedAt = '2026-10-02T15:00:00.000Z';
    open(bundle([finding('floor', 'Entrance floor damaged', 61, 74)]));
    fireEvent.click(screen.getByRole('button', { name: /Entrance floor damaged/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(state.approve).toHaveBeenCalledWith({ id: 'floor', inspectionId: 'inspection-1' });
    // A still for the finding is part of deciding it, so it is offered too.
    expect(screen.getByRole('button', { name: 'Add the 1:05 frame as evidence' })).toBeInTheDocument();
  });

  it('steps through the list with J and K', () => {
    open(
      bundle([
        finding('floor', 'Entrance floor damaged', 61, 74),
        finding('trim', 'Transition piece', 76, 82),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: /Entrance floor damaged/ }));

    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByRole('button', { name: /Transition piece/, expanded: true })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k' });
    expect(
      screen.getByRole('button', { name: /Entrance floor damaged/, expanded: true }),
    ).toBeInTheDocument();
  });
});

describe('the recording tab', () => {
  it('lists the findings in each recording, and plays an additional clip from one', () => {
    open(
      bundle(
        [finding('seam', 'Carpet seam lifting', 12, 18, { recordingId: 'clip' })],
        [
          recording('walkthrough'),
          recording('clip', { recordingType: 'ADDITIONAL_ISSUE', label: 'Carpet seam' }),
        ],
      ),
      'recording',
    );

    fireEvent.click(screen.getByRole('button', { name: /0:12 Carpet seam lifting/ }));

    // Additional clips never seeked at all: they opened at 0:00.
    expect(player()?.getAttribute('src')).toBe(
      'https://customer-x.cloudflarestream.com/clip.tok/iframe?startTime=12s&autoplay=true',
    );
  });

  // The office (2026-10-06): the narration word for word, beside each video.
  it('puts each recording’s whole transcript beside it, and plays the recording from a line', () => {
    open(
      bundle(
        [finding('seam', 'Carpet seam lifting', 12, 18, { recordingId: 'clip' })],
        [
          recording('walkthrough'),
          recording('clip', { recordingType: 'ADDITIONAL_ISSUE', label: 'Carpet seam' }),
        ],
      ),
      'recording',
    );

    const transcripts = screen.getAllByRole('region', { name: 'Transcript' });
    expect(transcripts.map((transcript) => transcript.textContent)).toEqual([
      expect.stringContaining('Narration of walkthrough.'),
      expect.stringContaining('Narration of clip.'),
    ]);
    // The clip's finding is marked on the line it was written from.
    expect(within(transcripts[1]).getByText('Carpet seam lifting')).toBeInTheDocument();

    fireEvent.click(within(transcripts[1]).getByRole('button', { name: /Narration of clip/ }));

    expect(player()?.getAttribute('src')).toBe(
      'https://customer-x.cloudflarestream.com/clip.tok/iframe?startTime=12s&autoplay=true',
    );
  });
});

describe('adding what the AI missed', () => {
  it('is offered even in a room with no findings, starting at the moment on screen', () => {
    open(bundle([]));

    expect(screen.getByText(/No findings yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a finding the AI missed' }));

    const form = screen.getByRole('region', { name: 'Add a finding' });
    expect(within(form).getByRole('textbox', { name: 'Moment in the recording' })).toHaveValue('');
  });

  it('is offered on a finalized inspection too', () => {
    state.finalizedAt = '2026-10-03T15:00:00.000Z';
    open(bundle([finding('f1', 'Door hole', 18, 24)]));

    expect(screen.getByRole('button', { name: 'Add a finding the AI missed' })).toBeInTheDocument();
  });
});

describe('the technician’s photos the AI saw a finding in', () => {
  it('are shown beside the finding, with the label saying a photo showed it', () => {
    open(
      bundle([
        finding('door', 'Door hole and trim require repair', 0, 0, {
          visual: {
            status: 'VISIBLE',
            checkedAt: '2026-10-03T10:00:00.000Z',
            observation: 'Two holes below the handle.',
            photos: [{ id: 'photo-door', contentPath: '/api/v1/admin/photos/photo-door/content' }],
          },
        }),
      ]),
    );

    const row = screen.getByRole('button', { name: /Door hole and trim require repair/ });
    expect(within(row).getByText('Seen in a photo')).toBeInTheDocument();
    fireEvent.click(row);

    expect(screen.getByText(/Seen in the technician's photo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open .*Entrance/ })).toBeInTheDocument();
    // Seen in a photo, not the video: there is no moment to ask a re-run for.
    expect(screen.queryByText(/no time given/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Re-run the AI on the recording to place it/)).not.toBeInTheDocument();
  });
});
