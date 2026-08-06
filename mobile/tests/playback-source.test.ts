import {
  playbackExpiringSoon,
  resolveMobilePlayback,
  type VideoPlaybackResponse,
} from '../src/media/playback-source';

const ready: VideoPlaybackResponse = {
  videoId: 'v-1',
  provider: 'cloudflare_stream',
  status: 'ready',
  hlsUrl: 'https://customer-abc.cloudflarestream.com/signed.token/manifest/video.m3u8',
  thumbnailUrl: 'https://customer-abc.cloudflarestream.com/signed.token/thumbnails/thumbnail.jpg',
  expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
};

describe('Stream playback', () => {
  it('plays HLS so the stream adapts to the connection', () => {
    // A technician on cellular in a vacant unit cannot wait for a whole file to
    // download before the first frame.
    const state = resolveMobilePlayback(ready);
    expect(state).toMatchObject({
      kind: 'play',
      source: { uri: ready.hlsUrl, contentType: 'hls' },
    });
  });

  it('never routes playback back through the API', () => {
    // Proxying is the round trip this migration removes.
    const state = resolveMobilePlayback(ready, { apiBaseUrl: 'https://api.example.com' });
    expect(JSON.stringify(state)).not.toContain('/api/v1/');
  });

  it('passes the poster frame through', () => {
    expect(resolveMobilePlayback(ready)).toMatchObject({ poster: ready.thumbnailUrl });
  });

  it('reports a missing URL as retryable rather than crashing the screen', () => {
    const state = resolveMobilePlayback({ ...ready, hlsUrl: undefined });
    expect(state).toMatchObject({ kind: 'failed', retryable: true });
  });
});

describe('states that are answers, not errors', () => {
  it('says the recording is still encoding', () => {
    // The common case: a technician finishes a room and opens it immediately.
    expect(resolveMobilePlayback({ ...ready, status: 'processing' }).kind).toBe('processing');
  });

  it('does not invite a retry for an encoding failure', () => {
    // Settled: retrying will not change the answer.
    const state = resolveMobilePlayback({
      ...ready,
      status: 'failed',
      failureMessage: 'Unsupported codec',
    });
    expect(state).toMatchObject({ kind: 'failed', message: 'Unsupported codec', retryable: false });
  });

  it('treats a missing response as worth retrying', () => {
    expect(resolveMobilePlayback(undefined)).toMatchObject({ kind: 'failed', retryable: true });
  });
});

describe('pre-Stream recordings', () => {
  const legacy: VideoPlaybackResponse = {
    videoId: 'v-old',
    provider: 'legacy',
    status: 'ready',
    contentPath: '/api/v1/admin/media/v-old/content',
  };

  it('still plays through the path it has always used', () => {
    // Existing evidence must not become unviewable because the upload path
    // changed.
    const state = resolveMobilePlayback(legacy, { apiBaseUrl: 'https://api.example.com/' });
    expect(state).toMatchObject({
      kind: 'play',
      source: {
        uri: 'https://api.example.com/api/v1/admin/media/v-old/content',
        contentType: 'progressive',
      },
    });
  });

  it('does not build a half-formed URL when the API host is unknown', () => {
    expect(resolveMobilePlayback(legacy, { apiBaseUrl: null }).kind).toBe('failed');
  });
});

describe('signed URL expiry', () => {
  it('refreshes before the token lapses mid-recording', () => {
    // An HLS player keeps requesting segments; a token that dies halfway
    // through looks like a corrupt video rather than an expired credential.
    const now = 1_000_000_000;
    expect(playbackExpiringSoon({ ...ready, expiresAt: new Date(now + 30_000).toISOString() }, now)).toBe(
      true,
    );
    expect(
      playbackExpiringSoon({ ...ready, expiresAt: new Date(now + 900_000).toISOString() }, now),
    ).toBe(false);
  });

  it('never asks to refresh a legacy recording', () => {
    expect(playbackExpiringSoon({ videoId: 'v', provider: 'legacy', status: 'ready' })).toBe(false);
  });
});
