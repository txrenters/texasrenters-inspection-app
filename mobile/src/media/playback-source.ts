/**
 * Turning a playback response into an expo-video source.
 *
 * Pure, so the decision a technician depends on — HLS from Cloudflare's edge
 * rather than a whole file dragged down a cellular link — is testable without a
 * player or a network.
 */

export interface VideoPlaybackResponse {
  videoId: string;
  provider: 'cloudflare_stream' | 'legacy';
  status: 'ready' | 'processing' | 'failed';
  hlsUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  expiresAt?: string;
  failureMessage?: string | null;
  contentPath?: string | null;
}

/** Matches expo-video's source shape; `contentType` tells it not to sniff. */
export interface PlayerSource {
  uri: string;
  contentType: 'hls' | 'progressive';
}

export type MobilePlaybackState =
  | { kind: 'play'; source: PlayerSource; poster?: string }
  | { kind: 'processing'; message: string }
  | { kind: 'failed'; message: string; retryable: boolean };

export function resolveMobilePlayback(
  playback: VideoPlaybackResponse | undefined,
  options: { apiBaseUrl?: string | null } = {},
): MobilePlaybackState {
  if (!playback)
    return { kind: 'failed', message: 'This recording could not be loaded.', retryable: true };

  if (playback.status === 'processing')
    return { kind: 'processing', message: 'Still preparing this recording for playback.' };

  if (playback.status === 'failed')
    return {
      kind: 'failed',
      message: playback.failureMessage ?? 'This recording could not be prepared for playback.',
      // An encoding failure is settled; retrying will not change the answer.
      retryable: false,
    };

  if (playback.provider === 'cloudflare_stream') {
    if (!playback.hlsUrl)
      return { kind: 'failed', message: 'No playback URL was returned.', retryable: true };
    return {
      kind: 'play',
      // HLS, so the player fetches the ladder rung that suits the connection.
      // A technician on cellular in a vacant unit cannot wait for a whole file.
      source: { uri: playback.hlsUrl, contentType: 'hls' },
      poster: playback.thumbnailUrl,
    };
  }

  // Pre-Stream recordings still play, through the authenticated path they have
  // always used. Absolute, because a player is given a URL rather than a route.
  if (!playback.contentPath || !options.apiBaseUrl)
    return {
      kind: 'failed',
      message: 'This recording predates video streaming and cannot be played here.',
      retryable: false,
    };
  return {
    kind: 'play',
    source: {
      uri: `${options.apiBaseUrl.replace(/\/$/, '')}${playback.contentPath}`,
      contentType: 'progressive',
    },
  };
}

/**
 * Whether the signed URL should be replaced before it lapses.
 *
 * An HLS player keeps requesting segments for the whole recording, so a token
 * that expires halfway through stops playback in a way that looks like a
 * corrupt video rather than an expired credential.
 */
export function playbackExpiringSoon(
  playback: VideoPlaybackResponse | undefined,
  now = Date.now(),
) {
  if (!playback?.expiresAt) return false;
  return new Date(playback.expiresAt).getTime() - 60_000 <= now;
}
