import type { InspectionRecordingSummaries } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectionSummaries } from './InspectionSummaries';

/**
 * "Summaries of all areas" (the maintenance team, 2026-10-07): every room's
 * summary on one page, with everything the property needs gathered first.
 */

const state = vi.hoisted(() => ({
  data: undefined as InspectionRecordingSummaries | undefined,
  canManage: true,
  summarizeEvery: vi.fn(),
  summarizeRoom: vi.fn(),
}));

vi.mock('@/lib/queries', () => ({
  useInspectionRecordingSummaries: () => ({ isError: false, data: state.data, refetch: () => {} }),
  useSummarizeInspectionRecordings: () => ({
    isPending: false,
    error: null,
    data: undefined,
    mutate: state.summarizeEvery,
  }),
  useSummarizeAreaRecordings: () => ({
    isPending: false,
    isSuccess: false,
    error: null,
    data: undefined,
    mutate: state.summarizeRoom,
  }),
}));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: () => state.canManage }),
}));

const summary = (current: boolean, repairs: string[]) => ({
  generatedAt: '2026-10-07T15:00:00.000Z',
  current,
  recordings: [{ mediaId: 'm', label: null, lines: [{ start: 58, text: 'Touch-up paint needed on the door frame.' }] }],
  actions: [{ group: 'REPAIRS' as const, items: repairs.map((text) => ({ text, details: [] })) }],
});

describe('the summaries of all areas', () => {
  beforeEach(() => {
    state.canManage = true;
    state.summarizeEvery.mockReset();
    state.data = {
      areas: [
        { inspectionAreaId: 'a1', name: 'Bedroom 1', floorName: 'Upstairs', recorded: true, summary: summary(true, ['Touch-up paint on the door frame.']) },
        { inspectionAreaId: 'a2', name: 'Kitchen', floorName: null, recorded: true, summary: summary(false, ['Replace the faucet.']) },
        { inspectionAreaId: 'a3', name: 'Laundry', floorName: null, recorded: true, summary: null },
        { inspectionAreaId: 'a4', name: 'Garage', floorName: null, recorded: false, summary: null },
      ],
    };
  });

  it('shows every recorded room with its points and its state', () => {
    render(<InspectionSummaries inspectionId="i" />);

    expect(screen.getByText('1 of 3 recorded areas summarized')).toBeInTheDocument();
    expect(screen.getAllByText('[0:58]').length).toBeGreaterThan(0);
    expect(screen.getByText('Summarized')).toBeInTheDocument();
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    expect(screen.getByText('Not summarized')).toBeInTheDocument();
    expect(screen.getByText('No recording: Garage.')).toBeInTheDocument();
  });

  it('gathers what the property needs from current summaries only, room by room', () => {
    render(<InspectionSummaries inspectionId="i" />);

    const needs = screen.getByText('Everything the property needs').closest('[data-slot="card"]') as HTMLElement;
    expect(within(needs).getByText('Touch-up paint on the door frame.')).toBeInTheDocument();
    expect(within(needs).getByText('Bedroom 1')).toBeInTheDocument();
    // The kitchen's summary is out of date: the report does not print it, so neither does this.
    expect(within(needs).queryByText('Replace the faucet.')).toBeNull();
  });

  it('summarizes every room for someone who can change the inspection, and no one else', () => {
    const { unmount } = render(<InspectionSummaries inspectionId="i" />);
    fireEvent.click(screen.getByRole('button', { name: /Summarize every room/ }));
    expect(state.summarizeEvery).toHaveBeenCalledTimes(1);
    unmount();

    state.canManage = false;
    render(<InspectionSummaries inspectionId="i" />);
    expect(screen.queryByRole('button', { name: /Summarize/ })).toBeNull();
  });

  it('says so when no room has a recording', () => {
    state.data = { areas: [{ inspectionAreaId: 'a4', name: 'Garage', floorName: null, recorded: false, summary: null }] };
    render(<InspectionSummaries inspectionId="i" />);

    expect(screen.getByText('No recordings to summarize')).toBeInTheDocument();
  });
});
