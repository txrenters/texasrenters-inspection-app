import { describe, expect, it } from 'vitest';

import { playbackNeedsRefresh, resolvePlayback, withStartTime, type VideoPlayback } from './playback';

const ready: VideoPlayback = {
  videoId: 'v-1',
  provider: 'cloudflare_stream',
  status: 'ready',
  streamUid: 'uid-1',
  iframeUrl: 'https://customer-abc.cloudflarestream.com/signed.token/iframe',
  thumbnailUrl: 'https://customer-abc.cloudflarestream.com/signed.token/thumbnails/thumbnail.jpg',
  expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
};

describe('timestamp deep links', () => {
  it('seeks to the moment a finding describes', () => {
    // Why per-utterance transcript timings are stored at all: opening a finding
    // should land on the second it refers to, not at 0:00 with the timestamp
    // printed beside the player for the reviewer to find by hand.
    expect(withStartTime(ready.iframeUrl!, 92)).toBe(
      'https://customer-abc.cloudflarestream.com/signed.token/iframe?startTime=92s',
    );
  });

  it('appends rather than replacing an existing query', () => {
    expect(withStartTime('https://host/iframe?muted=true', 30)).toBe(
      'https://host/iframe?muted=true&startTime=30s',
    );
  });

  it('leaves the start of a recording alone', () => {
    for (const value of [0, null, undefined, -5])
      expect(withStartTime(ready.iframeUrl!, value)).toBe(ready.iframeUrl);
  });

  it('rounds to whole seconds', () => {
    expect(withStartTime('https://host/iframe', 12.7)).toContain('startTime=12s');
  });
});

describe('resolving what to render', () => {
  it('plays a ready Stream video from the edge', () => {
    const state = resolvePlayback(ready);
    expect(state.kind).toBe('stream');
    // Never a path back through our own API — proxying is the round trip this
    // whole migration removes.
    expect(state.kind === 'stream' && state.src).toContain('cloudflarestream.com');
    expect(JSON.stringify(state)).not.toContain('/api/v1/admin/media');
  });

  it('carries a start offset into the player source', () => {
    const state = resolvePlayback(ready, { startSeconds: 45 });
    expect(state.kind === 'stream' && state.src).toContain('startTime=45s');
  });

  it('reports processing rather than showing a broken player', () => {
    // A reviewer opening an area minutes after the technician left should be
    // told to wait, not shown a failure.
    const state = resolvePlayback({ ...ready, status: 'processing', iframeUrl: undefined });
    expect(state.kind).toBe('processing');
  });

  it('gives the provider reason when encoding failed', () => {
    // "Unsupported codec" says this will never work; a generic failure invites
    // endless retrying.
    const state = resolvePlayback({
      ...ready,
      status: 'failed',
      failureMessage: 'Unsupported codec',
    });
    expect(state.kind === 'failed' && state.message).toBe('Unsupported codec');
  });

  it('still plays a pre-Stream recording through its original path', () => {
    // Compatibility is the point of keeping the legacy branch: existing
    // evidence must not become unviewable because the upload path changed.
    const state = resolvePlayback({
      videoId: 'v-old',
      provider: 'legacy',
      status: 'ready',
      contentPath: '/api/v1/admin/media/v-old/content',
    });
    expect(state).toEqual({ kind: 'legacy', contentPath: '/api/v1/admin/media/v-old/content' });
  });

  it('says so plainly when a legacy file is missing', () => {
    const state = resolvePlayback({
      videoId: 'v-old',
      provider: 'legacy',
      status: 'ready',
      contentPath: null,
    });
    expect(state.kind).toBe('unavailable');
  });

  it('does not render a player without a URL', () => {
    expect(resolvePlayback({ ...ready, iframeUrl: undefined }).kind).toBe('unavailable');
    expect(resolvePlayback(undefined).kind).toBe('unavailable');
  });
});

describe('signed URL refresh', () => {
  it('refreshes before the token lapses, not after', () => {
    // A token dying mid-playback looks like a broken recording.
    const now = 1_000_000_000;
    expect(
      playbackNeedsRefresh({ ...ready, expiresAt: new Date(now + 30_000).toISOString() }, now),
    ).toBe(true);
    expect(
      playbackNeedsRefresh({ ...ready, expiresAt: new Date(now + 600_000).toISOString() }, now),
    ).toBe(false);
  });

  it('never asks to refresh a legacy recording', () => {
    expect(playbackNeedsRefresh({ videoId: 'v', provider: 'legacy', status: 'ready' })).toBe(false);
  });
});
