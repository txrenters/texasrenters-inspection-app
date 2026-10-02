import type { AreaRecording } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AddFindingForm } from './AddFindingForm';

/**
 * A reviewer adding what the AI missed: at a moment of the recording, with
 * the still at that moment shown, and the frame filed as its photograph.
 */

const state = vi.hoisted(() => ({ add: vi.fn(), capture: vi.fn() }));

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    addFinding: { mutateAsync: state.add, isPending: false, error: null },
    captureSnapshot: { mutateAsync: state.capture, isPending: false, error: null },
  }),
  useVideoPlayback: (mediaId: string) => ({
    data: { thumbnailUrl: `https://customer-x.cloudflarestream.com/${mediaId}.tok/thumbnails/thumbnail.jpg` },
  }),
}));

const RECORDINGS = [
  { id: 'media-1', durationSeconds: 165 },
  { id: 'media-2', durationSeconds: 40 },
] as AreaRecording[];

function renderForm(props: Partial<Parameters<typeof AddFindingForm>[0]> = {}) {
  const onAdded = vi.fn();
  render(
    <AddFindingForm
      areaId="area-1"
      canCapture
      inspectionId="insp-1"
      onAdded={onAdded}
      onCancel={vi.fn()}
      recordings={RECORDINGS}
      startSeconds={95}
      {...props}
    />,
  );
  return { onAdded };
}

function fill() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Finding title' }), {
    target: { value: 'Cracked outlet cover by the window' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Category' }), {
    target: { value: 'Electrical' },
  });
}

beforeEach(() => {
  state.add.mockReset().mockResolvedValue({ id: 'finding-new' });
  state.capture.mockReset().mockResolvedValue({ id: 'photo-1' });
});

describe('adding a finding the AI missed', () => {
  it('starts at the moment on screen and shows the still there', () => {
    renderForm();

    expect(screen.getByRole('textbox', { name: 'Moment in the recording' })).toHaveValue('1:35');
    expect(screen.getByRole('img', { name: 'The recording at 1:35' })).toHaveAttribute(
      'src',
      'https://customer-x.cloudflarestream.com/media-1.tok/thumbnails/thumbnail.jpg?time=95s&height=360',
    );
  });

  it('files the finding at the moment, then its frame as its photograph', async () => {
    const { onAdded } = renderForm();
    fill();
    expect(screen.getByRole('checkbox', { name: 'File the frame as its photograph' })).toBeChecked();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Severity' })).getByRole('button', { name: 'Low' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add finding' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('finding-new'));
    expect(state.add).toHaveBeenCalledWith({
      title: 'Cracked outlet cover by the window',
      description: '',
      severity: 'LOW',
      findingType: 'POSSIBLE_NEW_DAMAGE',
      category: 'Electrical',
      note: undefined,
      inspectionId: 'insp-1',
      areaId: 'area-1',
      recordingId: 'media-1',
      atSeconds: 95,
    });
    expect(state.capture).toHaveBeenCalledWith({
      mediaId: 'media-1',
      inspectionId: 'insp-1',
      areaId: 'area-1',
      atMs: 95_000,
      findingId: 'finding-new',
    });
  });

  it('never offers to add the same finding twice when only its photograph failed', async () => {
    state.capture.mockRejectedValue(new Error('The frame could not be captured from the recording.'));
    const { onAdded } = renderForm();
    fill();

    fireEvent.click(screen.getByRole('button', { name: 'Add finding' }));

    expect(
      await screen.findByText(/The finding was added, but its photograph was not/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add finding' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onAdded).toHaveBeenCalledWith('finding-new');
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it('refuses a moment it cannot read, or one past the end of the recording', () => {
    renderForm();
    fill();
    const moment = screen.getByRole('textbox', { name: 'Moment in the recording' });

    fireEvent.change(moment, { target: { value: 'soon' } });
    expect(screen.getByText('Write it as 1:35')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add finding' })).toBeDisabled();

    fireEvent.change(moment, { target: { value: '3:30' } });
    expect(screen.getByText('Past the end of the recording')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add finding' })).toBeDisabled();
  });

  it('may cite no moment, and then files no frame', async () => {
    const { onAdded } = renderForm({ startSeconds: null });
    fill();

    fireEvent.click(screen.getByRole('button', { name: 'Add finding' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(state.add.mock.calls[0][0].atSeconds).toBeUndefined();
    expect(state.capture).not.toHaveBeenCalled();
  });

  it('files no frame for someone who may not file evidence', async () => {
    const { onAdded } = renderForm({ canCapture: false });
    fill();

    expect(
      screen.queryByRole('checkbox', { name: 'File the frame as its photograph' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add finding' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(state.capture).not.toHaveBeenCalled();
  });

  it('chooses between the area’s recordings', async () => {
    renderForm();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Recording 2 · 0:40' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Moment in the recording' }), {
      target: { value: '0:30' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add finding' }));

    await waitFor(() => expect(state.add).toHaveBeenCalled());
    expect(state.add.mock.calls[0][0]).toMatchObject({ recordingId: 'media-2', atSeconds: 30 });
  });
});
