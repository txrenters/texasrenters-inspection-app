import type {
  AreaChecklistEntry,
  AreaEvidenceBundle,
  AreaEvidenceSummaryItem,
} from '@texasrenters/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { conditionLines, PhotoSheet } from './PhotoSheet';

/**
 * Every area on one page.
 *
 * An occupied area is usually one photograph and two answers. Reviewing one
 * through the area list was open the area, its Photos tab, the photograph, its
 * Condition tab -- twenty times an inspection. The sheet shows them together.
 */

const bundles = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('@/lib/api', () => ({
  apiBlob: vi.fn().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' })),
}));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));
vi.mock('@/lib/queries', async () => {
  const { queryOptions } = await import('@tanstack/react-query');
  return {
    areaEvidenceQuery: (id: string, areaId: string) =>
      queryOptions({
        queryKey: ['area-evidence', id, areaId],
        queryFn: async () => bundles[areaId] as AreaEvidenceBundle,
      }),
    useInspection: () => ({ data: { finalizedAt: null } }),
    useSetAreaReviewed: () => ({ error: null, mutate: () => {} }),
  };
});

const choice = (label: string, textValue: string | null): AreaChecklistEntry => ({
  itemId: label,
  label,
  isClean: null,
  isUndamaged: null,
  isWorking: null,
  comment: null,
  responseType: 'CHOICE',
  textValue,
  numericValue: null,
  unit: null,
  section: null,
  recordedAt: null,
  videoTimestampSeconds: null,
});

const summary = (
  id: string,
  name: string,
  overrides: Partial<AreaEvidenceSummaryItem> = {},
): AreaEvidenceSummaryItem => ({
  id,
  propertyAreaId: `p-${id}`,
  name,
  environment: 'INDOOR',
  isRequired: true,
  checklistItemCount: 2,
  checklistAssessedCount: 2,
  completionStatus: 'COMPLETED',
  reviewStatus: 'EVIDENCE_READY',
  counts: { recordings: 0, photos: 1, findings: 0, unreviewedFindings: 0 },
  evidence: {
    primaryRecordingAvailable: false,
    overviewPhotoAvailable: true,
    conditionSummaryAvailable: false,
  },
  ...overrides,
});

const bundle = (
  id: string,
  name: string,
  photoIds: string[],
  checklist: AreaChecklistEntry[],
  overrides: { unreviewedFindings?: number; technicianNote?: string } = {},
): AreaEvidenceBundle => ({
  area: {
    id,
    propertyAreaId: `p-${id}`,
    name,
    floorName: null,
    environment: 'INDOOR',
    isRequired: true,
    completionStatus: 'COMPLETED',
    reviewStatus: 'EVIDENCE_READY',
    review: null,
    skipReason: null,
    technicianNote: overrides.technicianNote ?? null,
  },
  conditionSummary: null,
  recordings: [],
  findings: [],
  checklist,
  counts: {
    recordings: 0,
    photos: photoIds.length,
    findings: overrides.unreviewedFindings ?? 0,
    unreviewedFindings: overrides.unreviewedFindings ?? 0,
  },
  photoGroups: photoIds.length
    ? [
        {
          key: 'OVERVIEW',
          label: 'Area overview',
          photos: photoIds.map((photoId, sequenceNumber) => ({
            id: photoId,
            captureType: 'AREA_OVERVIEW',
            label: null,
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

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:thumb', revokeObjectURL: () => {} }),
  );
  Object.assign(bundles, {
    living: bundle('living', 'Living Room', ['l1'], [choice('Room condition', 'Clean'), choice('Overall condition', 'Good')], {
      technicianNote: 'Tenant has a dog',
    }),
    outside: bundle('outside', 'Outside Area 2', ['o1', 'o2', 'o3'], [choice('Room condition', 'Dirty'), choice('Overall condition', null)]),
    kitchen: bundle('kitchen', 'Kitchen', ['k1'], [], { unreviewedFindings: 2 }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(areas: AreaEvidenceSummaryItem[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const onOpenPhoto = vi.fn();
  const onOpenArea = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PhotoSheet areas={areas} inspectionId="inspection-1" onOpenArea={onOpenArea} onOpenPhoto={onOpenPhoto} />
    </QueryClientProvider>,
  );
  return { onOpenPhoto, onOpenArea };
}

describe('the photo sheet', () => {
  it("shows every area's photographs and answers together", async () => {
    open([summary('living', 'Living Room'), summary('outside', 'Outside Area 2', { counts: { recordings: 0, photos: 3, findings: 0, unreviewedFindings: 0 } })]);

    const living = screen.getByRole('listitem', { name: 'Living Room' });
    expect(await within(living).findByText('Clean')).toBeInTheDocument();
    expect(within(living).getByText('Good')).toBeInTheDocument();
    expect(within(living).getByText('Note: Tenant has a dog')).toBeInTheDocument();

    const outside = screen.getByRole('listitem', { name: 'Outside Area 2' });
    expect(await within(outside).findAllByRole('button', { name: /^Open Area overview/ })).toHaveLength(3);
    // An unanswered question is said to be unanswered, not left out.
    expect(within(outside).getByText('Not answered')).toBeInTheDocument();
  });

  it('opens a photograph in the viewer at that area', async () => {
    const { onOpenPhoto } = open([summary('living', 'Living Room')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Area overview of Living Room' }));

    expect(onOpenPhoto).toHaveBeenCalledWith('living', 'l1');
  });

  it('sends findings to the area view, where they are decided', async () => {
    const { onOpenArea } = open([summary('kitchen', 'Kitchen', { counts: { recordings: 0, photos: 1, findings: 2, unreviewedFindings: 2 } })]);

    fireEvent.click(await screen.findByRole('button', { name: '2 findings to review' }));

    expect(onOpenArea).toHaveBeenCalledWith('kitchen');
  });

  it('offers the review mark on each row', async () => {
    open([summary('living', 'Living Room')]);

    expect(await screen.findByRole('button', { name: 'Mark reviewed' })).toBeEnabled();
  });

  it('says so when the filter leaves nothing', () => {
    open([]);

    expect(screen.getByText('No areas match this filter.')).toBeInTheDocument();
  });
});

describe('what an area checklist says, in a line', () => {
  const status = (label: string, axes: Partial<AreaChecklistEntry>): AreaChecklistEntry => ({
    ...choice(label, null),
    responseType: 'STATUS',
    ...axes,
  });

  it('lists answers as given, with a reading in its unit', () => {
    expect(
      conditionLines([
        choice('Room condition', 'Clean'),
        { ...choice('Return air temperature', null), responseType: 'READING', numericValue: 72, unit: '°F' },
      ]),
    ).toEqual([
      { label: 'Room condition', value: 'Clean' },
      { label: 'Return air temperature', value: '72 °F' },
    ]);
  });

  it('summarises items scored on the axes, and names the ones that failed', () => {
    expect(
      conditionLines([
        status('Walls', { isClean: true, isUndamaged: false, isWorking: null }),
        status('Carpet', { isClean: false, isUndamaged: true, isWorking: null }),
        status('Blinds', {}),
      ]),
    ).toEqual([
      { label: 'Scored', value: '2 of 3 items' },
      { label: 'Walls', value: 'damaged', tone: 'flagged' },
      { label: 'Carpet', value: 'not clean', tone: 'flagged' },
    ]);
  });
});
