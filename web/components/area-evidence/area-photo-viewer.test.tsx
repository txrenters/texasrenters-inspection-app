import type { AreaEvidenceBundle, AreaEvidenceSummaryItem } from '@texasrenters/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaPhotoViewer } from './AreaPhotoViewer';
import { EvidenceViewer, type EvidenceViewerItem } from './EvidenceViewer';
import { forgetPhotos } from './photo-cache';

/**
 * Reviewing photographs across areas without closing the viewer.
 *
 * Asked for by the office on 2026-10-02. Next on an area's last photograph went
 * back to the start of the same area, and an area with one photograph showed
 * "1 / 1" and no arrows -- which on an occupied inspection is most of them. So
 * every area meant close, choose the next area, open its photograph again.
 */

const bundles = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('@/lib/api', () => ({
  apiBlob: vi.fn().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' })),
}));
vi.mock('@/lib/queries', async () => {
  const { queryOptions, useQuery } = await import('@tanstack/react-query');
  const areaEvidenceQuery = (id: string, areaId: string) =>
    queryOptions({
      queryKey: ['area-evidence', id, areaId],
      queryFn: async () => bundles[areaId] as AreaEvidenceBundle,
    });
  return {
    areaEvidenceQuery,
    useAreaEvidence: (id: string, areaId: string | null) =>
      useQuery({ ...areaEvidenceQuery(id, areaId ?? ''), enabled: Boolean(areaId) }),
  };
});

const INSPECTION = 'inspection-1';

const summary = (id: string, name: string, photos: number): AreaEvidenceSummaryItem => ({
  id,
  propertyAreaId: `p-${id}`,
  name,
  floorName: null,
  environment: 'INDOOR',
  isRequired: true,
  checklistItemCount: 0,
  checklistAssessedCount: 0,
  completionStatus: 'COMPLETED',
  reviewStatus: 'EVIDENCE_READY',
  skipReason: null,
  counts: { recordings: 0, photos, findings: 0, unreviewedFindings: 0 },
  evidence: {
    primaryRecordingAvailable: false,
    overviewPhotoAvailable: photos > 0,
    conditionSummaryAvailable: false,
  },
  lastEvidenceAt: null,
});

const bundle = (id: string, name: string, photoIds: string[]): AreaEvidenceBundle => ({
  area: {
    id,
    propertyAreaId: `p-${id}`,
    name,
    floorName: null,
    environment: 'INDOOR',
    isRequired: true,
    completionStatus: 'COMPLETED',
    reviewStatus: 'EVIDENCE_READY',
    skipReason: null,
    technicianNote: null,
  },
  conditionSummary: null,
  recordings: [],
  findings: [],
  checklist: [],
  counts: { recordings: 0, photos: photoIds.length, findings: 0, unreviewedFindings: 0 },
  photoGroups: photoIds.length
    ? [
        {
          key: 'OVERVIEW',
          label: 'Area overview',
          photos: photoIds.map((photoId, sequenceNumber) => ({
            id: photoId,
            captureType: 'AREA_OVERVIEW',
            label: `Photo ${photoId}`,
            sequenceNumber,
            capturedAt: '2026-10-01T17:51:30.000Z',
            captureTimeSource: 'SERVER_RECEIPT',
            capturedByName: 'Moses Rodriguez',
            contentPath: `/api/v1/admin/photos/${photoId}/content`,
          })),
        },
      ]
    : [],
});

// The list beside the viewer, in walking order. The hallway was skipped; the
// closet is counted as having a photograph its bundle cannot show -- one filed
// against the area's condition summary, which no photo group holds.
const areas = [
  summary('entrance', 'Entrance', 2),
  summary('hallway', 'Entry Hallway', 0),
  summary('living', 'Living Room', 1),
  summary('closet', 'Closet', 1),
  summary('kitchen', 'Kitchen', 1),
];

beforeEach(() => {
  Object.assign(bundles, {
    entrance: bundle('entrance', 'Entrance', ['e1', 'e2']),
    hallway: bundle('hallway', 'Entry Hallway', []),
    living: bundle('living', 'Living Room', ['l1']),
    closet: bundle('closet', 'Closet', []),
    kitchen: bundle('kitchen', 'Kitchen', ['k1']),
  });
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:photo', revokeObjectURL: () => {} }),
  );
});

afterEach(() => {
  forgetPhotos();
  vi.unstubAllGlobals();
});

function open(startAreaId: string, startPhotoId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // The area the reviewer clicked in is already loaded; the panel showed it.
  client.setQueryData(['area-evidence', INSPECTION, startAreaId], bundles[startAreaId]);
  const onAreaChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <AreaPhotoViewer
        areas={areas}
        inspectionId={INSPECTION}
        onAreaChange={onAreaChange}
        onClose={() => {}}
        startAreaId={startAreaId}
        startPhotoId={startPhotoId}
      />
    </QueryClientProvider>,
  );
  return { onAreaChange };
}

const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(window, { key });
  });

describe('walking photographs across areas', () => {
  it("carries on from an area's last photograph into the next area that has any", async () => {
    const { onAreaChange } = open('entrance', 'e2');
    await screen.findByText('Entrance · Photo e2');

    press('ArrowRight');

    // The skipped hallway is passed over.
    expect(await screen.findByText('Living Room · Photo l1')).toBeInTheDocument();
    expect(screen.getByText('Photo 1 of 1 · Area 3 of 5')).toBeInTheDocument();
    expect(screen.getAllByText('Now in Living Room · 1 photo').length).toBeGreaterThan(0);
    // The page underneath follows, so closing lands on the living room.
    expect(onAreaChange).toHaveBeenLastCalledWith('living');
  });

  it('walks back into the previous area at its last photograph', async () => {
    open('living', 'l1');
    await screen.findByText('Living Room · Photo l1');

    press('ArrowLeft');

    expect(await screen.findByText('Entrance · Photo e2')).toBeInTheDocument();
  });

  it('passes over an area whose photographs cannot be shown', async () => {
    open('living', 'l1');
    await screen.findByText('Living Room · Photo l1');

    press('ArrowRight');

    expect(await screen.findByText('Kitchen · Photo k1')).toBeInTheDocument();
  });

  it('jumps a whole area with the up and down arrows', async () => {
    open('entrance', 'e1');
    await screen.findByText('Entrance · Photo e1');

    press('ArrowDown');
    expect(await screen.findByText('Living Room · Photo l1')).toBeInTheDocument();

    // Into the previous area at its first photograph, not its last.
    press('ArrowUp');
    expect(await screen.findByText('Entrance · Photo e1')).toBeInTheDocument();
  });

  it('offers a way out of an area with a single photograph', async () => {
    open('living', 'l1');
    await screen.findByText('Living Room · Photo l1');

    expect(screen.getByRole('button', { name: 'Previous evidence' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next evidence' })).toBeInTheDocument();
  });

  it('stops at the very last photograph and says so, rather than going round again', async () => {
    open('kitchen', 'k1');
    await screen.findByText('Kitchen · Photo k1');
    expect(screen.queryByRole('button', { name: 'Next evidence' })).toBeNull();

    press('ArrowRight');

    expect((await screen.findAllByText('That was the last photo')).length).toBeGreaterThan(0);
    expect(screen.getByText('Kitchen · Photo k1')).toBeInTheDocument();
  });
});

describe('one area on its own', () => {
  const item = (id: string): EvidenceViewerItem => ({
    id,
    kind: 'photo',
    contentPath: `/api/v1/admin/photos/${id}/content`,
    title: `Photo ${id}`,
  });

  it('still wraps round when nothing lies beyond it', async () => {
    render(<EvidenceViewer items={[item('a'), item('b')]} onClose={() => {}} startIndex={1} />);
    await screen.findByText('Photo b');

    press('ArrowRight');

    expect(await screen.findByText('Photo a')).toBeInTheDocument();
  });
});
