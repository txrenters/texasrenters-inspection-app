import type { AreaEvidenceBundle, AreaEvidenceSummary, AreaEvidenceSummaryItem } from '@texasrenters/shared';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaDetailPanel } from './AreaDetailPanel';
import { AreaEvidenceWorkspace } from './AreaEvidenceWorkspace';

/**
 * Videos still on their way from the technician's phone, or that never came
 * (2026-11-14). A move-in or move-out may be submitted with videos still
 * sending; the office is told what is still arriving and when review goes
 * ahead without it, each room says where its video is, and a recording that is
 * not here offers nothing to play. Everything invented.
 */

const state = vi.hoisted(() => ({
  summary: null as unknown as AreaEvidenceSummary,
  bundle: null as unknown as AreaEvidenceBundle,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => false }) }));
vi.mock('@/lib/queries', () => ({
  useAreaEvidenceSummary: () => ({ isLoading: false, isError: false, data: state.summary }),
  useInspection: () => ({ data: { id: 'inspection-1', inspectionType: 'MOVE_OUT', finalizedAt: null } }),
  useInspectionAreas: () => ({ data: [] }),
  useActiveInspectionImport: () => ({ data: null }),
  useInspectionImportJob: () => ({ data: undefined }),
  useAreaEvidence: () => ({ isLoading: false, isError: false, refetch: () => {}, data: state.bundle }),
  useSummarizeAreaRecordings: () => ({ isPending: false, isSuccess: false, error: null, data: undefined, mutate: () => {} }),
  useSummarizeInspectionRecordings: () => ({ isPending: false, error: null, data: undefined, mutate: () => {} }),
  useFillAreaFromNarration: () => ({ isPending: false, error: null, data: undefined, mutate: () => {} }),
  useFillInspectionFromNarration: () => ({ isPending: false, error: null, data: undefined, mutate: () => {} }),
  useRecordChecklistItem: () => ({ isPending: false, variables: undefined, error: null, mutate: () => {} }),
  useSetAreaReviewed: () => ({ error: null, mutate: () => {} }),
  useAdminMutations: () => ({
    startInspectionImport: { mutateAsync: vi.fn(), isPending: false, error: null },
    commitInspectionImport: { mutateAsync: vi.fn(), isPending: false, error: null },
    approveFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    rejectFinding: { isPending: false, error: null, mutateAsync: async () => {} },
    editFinding: { isPending: false, error: null, mutateAsync: async () => {} },
  }),
}));
vi.mock('@/components/inspection-workflow', () => ({ AddAreasDialog: () => null, MergeAreasDialog: () => null }));
vi.mock('./AreaPhotoViewer', () => ({ AreaPhotoViewer: () => null }));
vi.mock('./PhotoSheet', () => ({ PhotoSheet: () => null }));
vi.mock('./RecordingTranscript', () => ({ RecordingTranscript: () => null }));

const area = (name: string, reviewStatus: AreaEvidenceSummaryItem['reviewStatus'], recordings = 0): AreaEvidenceSummaryItem => ({
  id: `area-${name}`,
  propertyAreaId: `pa-${name}`,
  name,
  floorName: null,
  environment: 'INDOOR',
  isRequired: true,
  checklistItemCount: 0,
  checklistAssessedCount: 0,
  completionStatus: 'RECORDED',
  reviewStatus,
  review: null,
  skipReason: null,
  counts: { recordings, photos: 0, findings: 0, unreviewedFindings: 0 },
  evidence: { primaryRecordingAvailable: recordings > 0, overviewPhotoAvailable: false, conditionSummaryAvailable: false },
  lastEvidenceAt: null,
});

function summary(over: Partial<AreaEvidenceSummary['totals']> = {}, lateVideosUntil: string | null = null): AreaEvidenceSummary {
  return {
    inspectionId: 'inspection-1',
    totals: { areas: 3, areasReviewed: 0, recordings: 1, photos: 0, findings: 0, unreviewedFindings: 0, ...over },
    lateVideosUntil,
    areas: [area('Entrance', 'EVIDENCE_READY', 1), area('Kitchen', 'VIDEO_ARRIVING'), area('Garage', 'VIDEO_NEVER_ARRIVED')],
    unassigned: { recordings: 0, photos: 0 },
  };
}

/** A room whose one recording is in the given state. */
function recordingBundle(processingStatus: string): AreaEvidenceBundle {
  return {
    area: {
      id: 'area-1',
      propertyAreaId: 'pa-1',
      name: 'Kitchen',
      floorName: null,
      environment: 'INDOOR',
      isRequired: true,
      completionStatus: 'RECORDED',
      reviewStatus: 'VIDEO_ARRIVING',
      review: null,
      skipReason: null,
      technicianNote: null,
    },
    conditionSummary: null,
    recordings: [
      {
        id: 'media-1',
        recordingType: 'PRIMARY_AREA',
        label: null,
        category: null,
        durationSeconds: 77,
        uploadStatus: 'SESSION_CREATED',
        processingStatus,
        technicianName: 'Field Tech',
        createdAt: '2026-11-14T15:00:00.000Z',
        thumbnailUrl: null,
        frameMarkersMs: [],
        analysisRun: null,
        contentPath: '/api/v1/admin/media/media-1/content',
      },
    ],
    photoGroups: [],
    findings: [],
    checklist: [],
    counts: { recordings: 0, photos: 0, findings: 0, unreviewedFindings: 0 },
  } as unknown as AreaEvidenceBundle;
}

beforeEach(() => {
  state.summary = summary();
  // The Areas card opens its first room's panel too.
  state.bundle = recordingBundle('READY');
});

describe('the Areas card while videos are still arriving', () => {
  it('says how many are on their way, and when the job goes to review without them', () => {
    state.summary = summary({ videosArriving: 2 }, '2026-11-15T19:21:00.000Z');
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);

    expect(screen.getByText(/2 videos are still arriving from the technician’s phone/)).toBeInTheDocument();
    expect(screen.getByText(/goes to review when they land, or on Nov 15, 2026/)).toBeInTheDocument();
  });

  it('says how many never arrived, and what the office can do', () => {
    state.summary = summary({ videosNeverArrived: 1 });
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);

    expect(screen.getByText(/1 video never arrived from the technician’s phone\. Reopen the job/)).toBeInTheDocument();
  });

  it('says nothing of either from an older server, or when every video is here', () => {
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);
    expect(screen.queryByText(/still arriving/)).toBeNull();
    expect(screen.queryByText(/never arrived from/)).toBeNull();
  });

  it('names where each room’s video is, and never calls it missing', () => {
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);

    const kitchen = screen.getByRole('tab', { name: /Kitchen/ });
    expect(within(kitchen).getByText('Video arriving')).toBeInTheDocument();
    expect(within(kitchen).queryByText('No video')).toBeNull();
    const garage = screen.getByRole('tab', { name: /Garage/ });
    expect(within(garage).getByText('Video never arrived')).toBeInTheDocument();
  });
});

describe('a recording not here yet', () => {

  it.each([
    ['ARRIVING', 'This video is still on its way from the technician’s phone.'],
    ['NEVER_ARRIVED', 'This video never arrived from the technician’s phone. It is added if the phone sends it later.'],
  ])('says so for %s, with nothing to play or save', (processingStatus, message) => {
    state.bundle = recordingBundle(processingStatus);
    render(<AreaDetailPanel areaId="area-1" inspectionId="inspection-1" onTabChange={() => {}} tab="recording" />);

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play recording/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });
});
