'use client';

import { CheckIcon, ImagePlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { type FindingMoment, formatSeconds, frameTimes, frameUrl } from '@/lib/finding-review';
import { useAdminMutations, useVideoPlayback } from '@/lib/queries';

/**
 * Stills from across a finding's moment in the recording.
 *
 * The office's complaint was the loop: watch the video, read a finding, go
 * back to the video to find it. A finding the technician described shows up in
 * these frames, so most can be judged here without playing anything. Clicking a
 * frame plays the recording from it.
 *
 * "Add photo" files the frame under the finding as a photograph, which
 * the shared report prints once the finding is approved. Cloudflare renders the
 * frame from the signed thumbnail URL the player already has, so nothing is
 * downloaded to look at one.
 */
export function FindingFrames({
  moment,
  durationSeconds,
  onSeek,
  capture,
}: {
  moment: FindingMoment;
  durationSeconds: number;
  onSeek: (seconds: number) => void;
  /** Present when this reviewer may file evidence, and the inspection is open. */
  capture?: { findingId: string; inspectionId: string; areaId: string } | null;
}) {
  const playback = useVideoPlayback(moment.recordingId);
  const mutation = useAdminMutations().captureSnapshot;
  const [filed, setFiled] = useState<number[]>([]);
  const [filing, setFiling] = useState<number | null>(null);
  const thumbnailUrl = playback.data?.thumbnailUrl;

  // A recording from before Stream has no thumbnail service, and one still
  // encoding has nothing to render; the player beside this says which.
  if (!thumbnailUrl) return null;

  const file = (seconds: number) => {
    if (!capture) return;
    setFiling(seconds);
    mutation.mutate(
      {
        mediaId: moment.recordingId,
        inspectionId: capture.inspectionId,
        areaId: capture.areaId,
        atMs: seconds * 1000,
        findingId: capture.findingId,
      },
      {
        onSuccess: () => setFiled((current) => [...current, seconds]),
        onSettled: () => setFiling(null),
      },
    );
  };

  return (
    <div className="grid gap-1.5">
      <ul aria-label="Frames from this finding" className="grid grid-cols-4 gap-1.5">
        {frameTimes(moment, durationSeconds).map((seconds) => (
          <li className="grid gap-1" key={seconds}>
            <button
              aria-label={`Play from ${formatSeconds(seconds)}`}
              className="group bg-muted focus-visible:ring-ring/50 relative block aspect-[9/16] overflow-hidden rounded-md focus-visible:ring-[3px] focus-visible:outline-none"
              onClick={() => onSeek(seconds)}
              type="button"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                className="size-full object-cover transition-opacity group-hover:opacity-90"
                loading="lazy"
                src={frameUrl(thumbnailUrl, seconds)}
              />
              <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[11px] font-medium text-white tabular-nums">
                {formatSeconds(seconds)}
              </span>
            </button>
            {capture ? (
              filed.includes(seconds) ? (
                // The tick in the success tone, the word muted (console-development).
                <span className="text-muted-foreground flex items-center justify-center gap-1 text-xs">
                  <CheckIcon aria-hidden className="text-success size-3" />
                  Added
                </span>
              ) : (
                <Button
                  aria-label={`Add the ${formatSeconds(seconds)} frame as evidence`}
                  className="h-7 w-full px-1 text-xs"
                  disabled={filing !== null}
                  onClick={() => file(seconds)}
                  size="sm"
                  title="File this frame under the finding, as its evidence photo"
                  type="button"
                  variant="ghost"
                >
                  {filing === seconds ? <Spinner className="size-3" /> : <ImagePlusIcon aria-hidden />}
                  Add photo
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {mutation.isError ? (
        <p className="text-destructive text-xs">{mutation.error.message}</p>
      ) : null}
    </div>
  );
}
