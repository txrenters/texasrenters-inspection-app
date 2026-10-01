import type { AreaEvidenceSummary, AreaEvidenceSummaryItem } from '@texasrenters/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { keys, useSetAreaReviewed } from './queries';

/**
 * Marking an area reviewed shows on the click.
 *
 * The console's standing rule is that it must feel instant, and a button that
 * waits on a round trip from the office is the usual way it does not. The
 * server still decides -- it refuses an area with a finding awaiting a decision
 * -- and a refusal must put the list back exactly as it was.
 */

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));

const INSPECTION = 'inspection-1';
const KEY = keys.areaEvidenceSummary(INSPECTION);

const area = (id: string): AreaEvidenceSummaryItem => ({
  id,
  propertyAreaId: `p-${id}`,
  name: id,
  environment: 'INDOOR',
  isRequired: true,
  checklistItemCount: 2,
  checklistAssessedCount: 2,
  completionStatus: 'COMPLETED',
  reviewStatus: 'EVIDENCE_READY',
  review: null,
  counts: { recordings: 0, photos: 1, findings: 0, unreviewedFindings: 0 },
  evidence: {
    primaryRecordingAvailable: false,
    overviewPhotoAvailable: true,
    conditionSummaryAvailable: false,
  },
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const summary: AreaEvidenceSummary = {
    inspectionId: INSPECTION,
    totals: { areas: 2, areasReviewed: 0, recordings: 0, photos: 2, findings: 0, unreviewedFindings: 0 },
    areas: [area('living'), area('kitchen')],
    unassigned: { recordings: 0, photos: 0 },
  };
  client.setQueryData(KEY, summary);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSetAreaReviewed(INSPECTION), { wrapper });
  const read = () => client.getQueryData<AreaEvidenceSummary>(KEY)!;
  return { result, read };
}

beforeEach(() => {
  api.mockReset();
});

describe('marking an area reviewed from the console', () => {
  it('moves the area and the count before the server answers', async () => {
    api.mockImplementation(() => new Promise(() => {}));
    const { result, read } = setup();

    act(() => result.current.mutate({ areaId: 'living', reviewed: true }));

    await waitFor(() => expect(read().areas[0].reviewStatus).toBe('REVIEWED'));
    expect(read().totals.areasReviewed).toBe(1);
    expect(read().areas[1].reviewStatus).toBe('EVIDENCE_READY');
  });

  it('puts everything back when the server refuses', async () => {
    api.mockRejectedValue(new Error('Decide the 1 finding awaiting review in this area first.'));
    const { result, read } = setup();

    act(() => result.current.mutate({ areaId: 'living', reviewed: true }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(read().areas[0].reviewStatus).toBe('EVIDENCE_READY');
    expect(read().totals.areasReviewed).toBe(0);
  });

  it('marks with PUT and takes the mark back with DELETE', async () => {
    api.mockResolvedValue({ areaId: 'living', review: null });
    const { result } = setup();

    await act(() => result.current.mutateAsync({ areaId: 'living', reviewed: true }));
    await act(() => result.current.mutateAsync({ areaId: 'living', reviewed: false }));

    expect(api.mock.calls.map(([path, init]) => [path, (init as RequestInit).method])).toEqual([
      [`/api/v1/admin/inspections/${INSPECTION}/areas/living/review`, 'PUT'],
      [`/api/v1/admin/inspections/${INSPECTION}/areas/living/review`, 'DELETE'],
    ]);
  });
});
