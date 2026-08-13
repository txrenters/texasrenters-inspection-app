import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordingMarkers } from './RecordingMarkers';

const captureSnapshot = { mutate: vi.fn(), isPending: false, isError: false, error: null };

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({ captureSnapshot }),
}));

const checklist = [
  { itemId: 'item-1', label: 'Walls and ceilings' },
  { itemId: 'item-2', label: 'Lights and power points' },
] as never;

function setup(markers: number[], onSeek = vi.fn()) {
  render(
    <RecordingMarkers
      areaId="area-1"
      checklist={checklist}
      inspectionId="insp-1"
      markers={markers}
      mediaId="media-1"
      onSeek={onSeek}
    />,
  );
  return { onSeek };
}

describe('technician markers', () => {
  // The mutation double is module-level, so it has to be reset per test.
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when the technician marked nothing', () => {
    const { container } = render(
      <RecordingMarkers
        areaId="area-1"
        checklist={checklist}
        inspectionId="insp-1"
        markers={[]}
        mediaId="media-1"
        onSeek={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows each marker as a timestamp', () => {
    setup([5_000, 63_500, 125_000]);

    expect(screen.getByText('0:05')).toBeInTheDocument();
    expect(screen.getByText('1:04')).toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });

  /**
   * Seek and capture are separate controls on purpose: a reviewer should be
   * able to look at the moment before deciding it belongs in a report handed to
   * a tenant.
   */
  it('seeks without capturing', () => {
    const { onSeek } = setup([63_500]);

    fireEvent.click(screen.getByText('1:04'));

    expect(onSeek).toHaveBeenCalledWith(63.5);
    expect(captureSnapshot.mutate).not.toHaveBeenCalled();
  });

  it('captures the marked moment in milliseconds, not rounded seconds', () => {
    // The technician's marks are recorded in milliseconds, so a reviewer
    // clicking one must land on the frame that was marked rather than a second
    // nearby.
    setup([63_500]);

    fireEvent.click(screen.getByRole('button', { name: /Capture the frame at 1:04/ }));

    expect(captureSnapshot.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ atMs: 63_500, mediaId: 'media-1', areaId: 'area-1' }),
      expect.anything(),
    );
  });

  it('omits the checklist item when none is chosen', () => {
    // Sending the sentinel would be a uuid the server rejects; omitting it is
    // how "this documents the room, not one item" is expressed.
    setup([1_000]);

    fireEvent.click(screen.getByRole('button', { name: /Capture the frame/ }));

    const [[payload]] = captureSnapshot.mutate.mock.calls.slice(-1);
    expect(payload).not.toHaveProperty('checklistItemId');
  });
});
