/**
 * Turning a playback response into something a player can use.
 *
 * Pure and separate from the component so the URL construction — which decides
 * whether a reviewer lands on the right second of a recording — is testable
 * without a browser.
 */

export interface VideoPlayback {
  videoId: string;
  provider: 'cloudflare_stream' | 'legacy';
  status: 'ready' | 'processing' | 'failed';
  streamUid?: string;
  hlsUrl?: string;
  iframeUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  expiresAt?: string;
  failureMessage?: string | null;
  /** Legacy R2 recordings only: the authenticated path to fetch as a blob. */
  contentPath?: string | null;
}

export type PlaybackState =
  | { kind: 'stream'; src: string; poster?: string }
  | { kind: 'legacy'; contentPath: string }
  | { kind: 'processing'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'unavailable'; message: string };

/**
 * Add a start offset to a Stream player URL.
 *
 * The whole point of storing per-utterance transcript timings: a reviewer
 * opening a finding should land on the moment it describes, not at 0:00 with a
 * timestamp written beside the player that they have to seek to by hand.
 */
export function withStartTime(iframeUrl: string, startSeconds?: number | null) {
  if (!startSeconds || startSeconds <= 0) return iframeUrl;
  const separator = iframeUrl.includes('?') ? '&' : '?';
  // Whole seconds: Cloudflare accepts a `<n>s` form, and a fractional offset
  // buys nothing a viewer can perceive.
  return `${iframeUrl}${separator}startTime=${Math.floor(startSeconds)}s`;
}

/**
 * What the player should actually show.
 *
 * Processing and failure are first-class results rather than errors: a reviewer
 * opening an area minutes after the technician left should be told the video is
 * still encoding, not shown a broken player.
 */
export function resolvePlayback(
  playback: VideoPlayback | undefined,
  options: { startSeconds?: number | null } = {},
): PlaybackState {
  if (!playback) return { kind: 'unavailable', message: 'This recording could not be loaded.' };

  if (playback.provider === 'legacy') {
    return playback.contentPath
      ? { kind: 'legacy', contentPath: playback.contentPath }
      : {
          kind: 'unavailable',
          message: 'This recording predates video streaming and its file is missing.',
        };
  }

  if (playback.status === 'processing')
    return {
      kind: 'processing',
      message: 'Cloudflare is still preparing this recording for playback.',
    };

  if (playback.status === 'failed')
    return {
      kind: 'failed',
      // The provider's own reason where there is one: "unsupported codec" tells
      // a reviewer this will never work, where a generic failure invites them
      // to keep retrying.
      message: playback.failureMessage ?? 'This recording could not be processed for playback.',
    };

  if (!playback.iframeUrl)
    return { kind: 'unavailable', message: 'No playback URL was returned for this recording.' };

  return {
    kind: 'stream',
    src: withStartTime(playback.iframeUrl, options.startSeconds),
    poster: playback.thumbnailUrl,
  };
}

/**
 * Whether the signed URL is close enough to expiry to be worth refreshing.
 *
 * A token that lapses mid-playback looks to a reviewer like a broken recording,
 * so the page re-requests before that rather than after.
 */
export function playbackNeedsRefresh(playback: VideoPlayback | undefined, now = Date.now()) {
  if (!playback?.expiresAt) return false;
  return new Date(playback.expiresAt).getTime() - 60_000 <= now;
}
