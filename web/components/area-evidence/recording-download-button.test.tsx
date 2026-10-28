import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EvidenceViewer } from './EvidenceViewer';
import { DOWNLOAD_POLL_MS, RecordingDownloadButton } from './RecordingDownloadButton';

/**
 * "Download" on a recording (the office, 2026-10-28: "there's no option to
 * save the video, even if I click full screen"). The server hands back a link
 * signed for a few minutes; the button follows it, or says why it cannot.
 */

const state = vi.hoisted(() => ({
  request: vi.fn(),
  toast: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({ downloadRecording: { mutateAsync: state.request } }),
  // The full-screen viewer's player, left loading: these tests are about the button.
  useVideoPlayback: () => ({ isLoading: true }),
}));

vi.mock('sonner', () => ({ toast: state.toast }));

const SIGNED = 'https://customer-abc.cloudflarestream.com/signed.jwt/downloads/default.mp4?filename=x';

let followed: string[];

beforeEach(() => {
  state.request.mockReset();
  state.toast.info.mockReset();
  state.toast.error.mockReset();
  followed = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    followed.push(this.href);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function press() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Download recording' }));
  });
}

describe('saving a recording', () => {
  it('asks the server for this recording and follows the signed link', async () => {
    state.request.mockResolvedValue({ videoId: 'media-1', status: 'ready', url: SIGNED, expiresAt: '' });
    render(<RecordingDownloadButton mediaId="media-1" />);

    await press();

    expect(state.request).toHaveBeenCalledWith({ mediaId: 'media-1' });
    expect(followed).toEqual([SIGNED]);
    // Ready for another go once the browser has the file.
    expect(screen.getByRole('button', { name: 'Download recording' })).toBeEnabled();
  });

  it('shows how far along the file is while Cloudflare makes it, then saves it', async () => {
    vi.useFakeTimers();
    state.request
      .mockResolvedValueOnce({ videoId: 'media-1', status: 'preparing', percentComplete: 40 })
      .mockResolvedValueOnce({ videoId: 'media-1', status: 'ready', url: SIGNED, expiresAt: '' });
    render(<RecordingDownloadButton mediaId="media-1" />);

    await press();
    const waiting = screen.getByRole('button', { name: 'Preparing the recording to download' });
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveTextContent('Preparing 40%');
    expect(followed).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS);
    });
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(followed).toEqual([SIGNED]);
  });

  it('says why there is no file, and follows nothing', async () => {
    state.request.mockResolvedValue({
      videoId: 'media-1',
      status: 'unavailable',
      message: 'Cloudflare could not process this recording, so there is no file to save.',
    });
    render(<RecordingDownloadButton mediaId="media-1" />);

    await press();

    expect(state.toast.error).toHaveBeenCalledWith(
      'Cloudflare could not process this recording, so there is no file to save.',
    );
    expect(followed).toEqual([]);
  });

  it('tells the reviewer to come back while the recording is still encoding', async () => {
    state.request.mockResolvedValue({ videoId: 'media-1', status: 'processing' });
    render(<RecordingDownloadButton mediaId="media-1" />);

    await press();

    expect(state.toast.info).toHaveBeenCalledWith(expect.stringMatching(/still processing/));
    expect(followed).toEqual([]);
  });

  it('shows a refusal from the server, such as a recording outside their reach', async () => {
    state.request.mockRejectedValue(new Error('Room video not found.'));
    render(<RecordingDownloadButton mediaId="media-1" />);

    await press();

    expect(state.toast.error).toHaveBeenCalledWith('Room video not found.');
    expect(screen.getByRole('button', { name: 'Download recording' })).toBeEnabled();
  });

  it('stops asking once the card is gone', async () => {
    vi.useFakeTimers();
    state.request.mockResolvedValue({ videoId: 'media-1', status: 'preparing', percentComplete: 10 });
    const { unmount } = render(<RecordingDownloadButton mediaId="media-1" />);

    await press();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS * 3);
    });

    expect(state.request).toHaveBeenCalledTimes(1);
    expect(followed).toEqual([]);
  });
});

describe('in the full-screen viewer', () => {
  it('is in the header beside Close for a recording', async () => {
    state.request.mockResolvedValue({ videoId: 'media-1', status: 'ready', url: SIGNED, expiresAt: '' });
    render(
      <EvidenceViewer
        items={[
          {
            id: 'media-1',
            kind: 'recording',
            contentPath: '/api/v1/admin/media/media-1/content',
            title: 'Primary recording - Kitchen',
          },
        ]}
        onClose={() => {}}
        startIndex={0}
      />,
    );

    const button = screen.getByRole('button', { name: 'Download recording' });
    expect(button.closest('header')).toContainElement(
      screen.getByRole('button', { name: 'Close viewer' }),
    );
    await press();
    expect(state.request).toHaveBeenCalledWith({ mediaId: 'media-1' });
    expect(followed).toEqual([SIGNED]);
  });
});
