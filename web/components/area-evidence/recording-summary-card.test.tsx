import type { AreaRecordingSummaryView } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordingSummaryCard } from './RecordingSummaryCard';

/**
 * What the report prints under a room's photographs (2026-10-07), shown to the
 * office first: the points at their moments, what the room needs, and whether
 * the report is printing it or the narration word for word.
 */

const state = vi.hoisted(() => ({ summarizeRoom: vi.fn(), summarizeEvery: vi.fn() }));

vi.mock('@/lib/queries', () => ({
  useSummarizeAreaRecordings: () => ({
    isPending: false,
    isSuccess: false,
    error: null,
    data: undefined,
    mutate: state.summarizeRoom,
  }),
  useSummarizeInspectionRecordings: () => ({
    isPending: false,
    error: null,
    data: undefined,
    mutate: state.summarizeEvery,
  }),
}));

const SUMMARY: AreaRecordingSummaryView = {
  generatedAt: '2026-10-07T15:00:00.000Z',
  current: true,
  recordings: [
    {
      mediaId: 'media-1',
      label: null,
      lines: [
        { start: 0, text: 'Entering main bedroom; the door is functional but keyed.' },
        { start: 58, text: 'Touch-up paint needed on the bathroom door frame.' },
      ],
    },
  ],
  actions: [
    {
      group: 'REPAIRS',
      items: [{ text: 'Touch-up paint needed on:', details: ['Bathroom door frame'] }],
    },
  ],
};

describe('the summary for the report', () => {
  beforeEach(() => {
    state.summarizeRoom.mockReset();
    state.summarizeEvery.mockReset();
  });

  it('shows each point at its moment, and what the room needs under the office’s headings', () => {
    const onSeek = vi.fn();
    render(<RecordingSummaryCard areaId="a" canManage inspectionId="i" onSeek={onSeek} summary={SUMMARY} />);

    expect(screen.getByText('Repairs / Maintenance')).toBeInTheDocument();
    expect(screen.getByText('Bathroom door frame')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '[0:58]' }));
    expect(onSeek).toHaveBeenCalledWith(58);
  });

  it('says when the report lists nothing for the room: no summary yet, or a stale one', () => {
    const { unmount } = render(
      <RecordingSummaryCard areaId="a" canManage inspectionId="i" summary={null} />,
    );
    expect(screen.getByText(/Not summarized yet/)).toBeInTheDocument();
    unmount();

    render(
      <RecordingSummaryCard areaId="a" canManage inspectionId="i" summary={{ ...SUMMARY, current: false }} />,
    );
    expect(screen.getByText(/A recording arrived after this summary/)).toBeInTheDocument();
  });

  it('summarizes this room or every room, and only for someone who can change the inspection', () => {
    const { unmount } = render(
      <RecordingSummaryCard areaId="a" canManage inspectionId="i" summary={SUMMARY} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Summarize this room again/ }));
    fireEvent.click(screen.getByRole('button', { name: /Summarize every room/ }));
    expect(state.summarizeRoom).toHaveBeenCalledTimes(1);
    expect(state.summarizeEvery).toHaveBeenCalledTimes(1);
    unmount();

    render(<RecordingSummaryCard areaId="a" canManage={false} inspectionId="i" summary={SUMMARY} />);
    expect(screen.queryByRole('button', { name: /Summarize/ })).not.toBeInTheDocument();
  });
});
