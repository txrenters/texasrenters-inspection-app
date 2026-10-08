import type { RecordingTranscript as Transcript } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordingTranscript } from './RecordingTranscript';

/**
 * The narration word for word, beside the video (the office, 2026-10-06): the
 * whole of it, not the AI's summary, and every line a way into the recording.
 */

const state = vi.hoisted(() => ({
  query: { data: undefined, isLoading: false, isError: false } as {
    data: Transcript | undefined;
    isLoading: boolean;
    isError: boolean;
  },
  seek: vi.fn(),
}));

vi.mock('@/lib/queries', () => ({
  useRecordingTranscript: () => state.query,
}));

const NARRATION: Transcript = {
  mediaId: 'media-1',
  status: 'COMPLETED',
  lines: [
    { start: 0, end: 6, text: 'This is the kitchen.' },
    { start: 18, end: 22, text: 'The vinyl is lifting at the doorway.' },
    { start: 22, end: 26, text: 'And the transition strip is missing.' },
    { start: 95, end: 99, text: 'Cabinets are fine.' },
  ],
};

function show(props: Partial<Parameters<typeof RecordingTranscript>[0]> = {}) {
  render(<RecordingTranscript mediaId="media-1" onSeek={state.seek} {...props} />);
}

beforeEach(() => {
  state.seek.mockReset();
  state.query = { data: NARRATION, isLoading: false, isError: false };
});

describe('the transcript beside the video', () => {
  it('shows every line the technician said, with when they said it', () => {
    show();

    const lines = within(screen.getByRole('list')).getAllByRole('button');
    expect(lines.map((line) => line.textContent)).toEqual([
      '0:00This is the kitchen.',
      '0:18The vinyl is lifting at the doorway.',
      '0:22And the transition strip is missing.',
      '1:35Cabinets are fine.',
    ]);
  });

  // The maintenance team, 2026-10-08: "the transcript is cut" -- it scrolled
  // inside a box the video's height, and long finding titles ended in "...".
  it('is not a box of its own to scroll, and cuts no finding title short', () => {
    show({ findings: [{ id: 'f1', title: 'Vinyl lifting at the doorway, and the strip beside it missing', start: 18, end: 22 }] });

    expect(screen.getByRole('list').className).not.toMatch(/overflow|max-h/);
    expect(screen.getByText('Vinyl lifting at the doorway, and the strip beside it missing').className).not.toMatch(
      /truncate/,
    );
  });

  it('plays the recording from a line that is clicked', () => {
    show();

    fireEvent.click(screen.getByRole('button', { name: /lifting at the doorway/ }));

    expect(state.seek).toHaveBeenCalledWith(18);
  });

  it('marks the lines a finding was written from, its title once', () => {
    show({ findings: [{ id: 'finding-floor', title: 'Vinyl lifting at kitchen doorway', start: 18, end: 26 }] });

    expect(screen.getAllByText('Vinyl lifting at kitchen doorway')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /lifting at the doorway/ }).className).toContain('border-warning');
    expect(screen.getByRole('button', { name: /transition strip/ }).className).toContain('border-warning');
    expect(screen.getByRole('button', { name: /Cabinets are fine/ }).className).not.toContain('border-warning');
  });

  it('gives a line to the finding it belongs to when two findings were told back to back', () => {
    show({
      findings: [
        { id: 'finding-floor', title: 'Vinyl lifting at kitchen doorway', start: 18, end: 22 },
        { id: 'finding-strip', title: 'Transition strip missing', start: 22, end: 26 },
      ],
    });

    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    // Each title above its own line, not both above the first.
    expect(items[1].textContent).toContain('Vinyl lifting at kitchen doorway');
    expect(items[1].textContent).not.toContain('Transition strip missing');
    expect(items[2].textContent).toContain('Transition strip missing');
  });

  it('marks a finding of a single moment on the line spoken at it', () => {
    show({ findings: [{ id: 'finding-cabinet', title: 'Cabinet door loose', start: 96, end: 96 }] });

    expect(screen.getByRole('button', { name: /Cabinets are fine/ }).className).toContain('border-warning');
    expect(screen.getByText('Cabinet door loose')).toBeTruthy();
  });

  it('marks the line the player was sent to', () => {
    show({ playingSecond: 20 });

    expect(screen.getByRole('button', { name: /lifting at the doorway/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /This is the kitchen/ }).getAttribute('aria-current')).toBeNull();
  });

  it('copies the whole narration with its times', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    show();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith(
      [
        '[0:00] This is the kitchen.',
        '[0:18] The vinyl is lifting at the doorway.',
        '[0:22] And the transition strip is missing.',
        '[1:35] Cabinets are fine.',
      ].join('\n'),
    );
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});

describe('a transcript that is not there', () => {
  it.each([
    ['PENDING', 'Transcribing the narration. It appears here when it is done.'],
    ['RUNNING', 'Transcribing the narration. It appears here when it is done.'],
    ['FAILED', 'The narration could not be transcribed.'],
    ['COMPLETED', 'No narration was heard in this recording.'],
    ['NONE', 'This recording has not been transcribed.'],
  ] as const)('says why when it is %s', (status, message) => {
    state.query = { data: { mediaId: 'media-1', status, lines: [] }, isLoading: false, isError: false };
    show();

    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('says it could not be loaded rather than that there is none', () => {
    state.query = { data: undefined, isLoading: false, isError: true };
    show();

    expect(screen.getByText('The transcript could not be loaded.')).toBeTruthy();
  });
});
