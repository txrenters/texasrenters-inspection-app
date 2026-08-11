'use client';

import { useEffect, useState } from 'react';
import { AlertTriangleIcon, Loader2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiBlob } from '@/lib/api';
import { resolvePlayback } from '@/lib/playback';
import { useVideoPlayback } from '@/lib/queries';

/**
 * Plays one inspection recording.
 *
 * Replaces the whole-file download this viewer used to do for video: it fetched
 * the entire recording through the API as a blob and played it from an object
 * URL, so a 50 MB walkthrough had to transfer completely before the first
 * frame, with no seeking and no adaptive quality.
 *
 * Cloudflare's player is embedded rather than driven through `hls.js`. Chrome
 * and Firefox cannot play HLS natively, so a custom player would mean shipping
 * a media library and rebuilding fullscreen, seeking and quality selection for
 * no gain — and the embed's `startTime` parameter is the finding deep-link.
 *
 * The blob path survives only for recordings made before the Stream migration,
 * which have no Cloudflare video to point at.
 */
export function RecordingSurface({
  mediaId,
  title,
  posterUrl,
  startSeconds,
}: {
  mediaId: string;
  title: string;
  posterUrl?: string | null;
  /** Seek target, for opening a recording at the finding that references it. */
  startSeconds?: number | null;
}) {
  const playback = useVideoPlayback(mediaId);
  const state = resolvePlayback(playback.data, { startSeconds });

  if (playback.isLoading)
    return <Notice icon={<Loader2Icon aria-hidden className="size-5 animate-spin" />} message="Loading recording…" />;

  if (playback.isError)
    return (
      <Notice
        icon={<AlertTriangleIcon aria-hidden className="size-5" />}
        message={playback.error.message}
        action={
          <Button onClick={() => void playback.refetch()} variant="outline">
            Try again
          </Button>
        }
      />
    );

  if (state.kind === 'processing')
    return (
      <Notice
        icon={<Loader2Icon aria-hidden className="size-5 animate-spin" />}
        message={state.message}
        // Not an error state: the recording arrived safely and simply is not
        // encoded yet, so the reviewer is told to check back rather than shown
        // a failure they might act on.
        action={
          <Button onClick={() => void playback.refetch()} variant="outline">
            Check again
          </Button>
        }
      />
    );

  if (state.kind === 'failed' || state.kind === 'unavailable')
    return <Notice icon={<AlertTriangleIcon aria-hidden className="size-5" />} message={state.message} />;

  if (state.kind === 'legacy') return <LegacyRecording contentPath={state.contentPath} title={title} poster={posterUrl} />;

  return (
    <div className="relative aspect-video w-full max-w-full overflow-hidden rounded-lg bg-black">
      <iframe
        allow="accelerometer; gyroscope; encrypted-media; picture-in-picture;"
        allowFullScreen
        className="absolute inset-0 size-full border-0"
        src={state.src}
        title={title}
      />
    </div>
  );
}

/**
 * The pre-Stream path, unchanged: fetched as a blob because those endpoints
 * require a bearer token and a bare `<video src>` pointing at the API would 401.
 */
function LegacyRecording({
  contentPath,
  title,
  poster,
}: {
  contentPath: string;
  title: string;
  poster?: string | null;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null);
    setError(null);
    void apiBlob(contentPath)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'This recording could not be loaded.');
      });
    return () => {
      cancelled = true;
      // Revoked on unmount: a reviewer paging through recordings would
      // otherwise hold every one of them in memory.
      if (created) URL.revokeObjectURL(created);
    };
  }, [contentPath]);

  if (error) return <Notice icon={<AlertTriangleIcon aria-hidden className="size-5" />} message={error} />;
  if (!objectUrl)
    return <Notice icon={<Loader2Icon aria-hidden className="size-5 animate-spin" />} message="Downloading recording…" />;
  return (
    <video autoPlay className="max-h-full max-w-full rounded-lg" controls poster={poster ?? undefined} src={objectUrl}>
      <track kind="captions" label={title} />
    </video>
  );
}

function Notice({
  icon,
  message,
  action,
}: {
  icon: React.ReactNode;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 text-center text-sm text-white/80">
      {icon}
      <p className="max-w-md">{message}</p>
      {action}
    </div>
  );
}
