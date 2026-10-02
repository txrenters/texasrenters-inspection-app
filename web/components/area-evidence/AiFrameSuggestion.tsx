'use client';

import type { AreaFinding } from '@texasrenters/shared';
import { CheckIcon, ImagePlusIcon, PlayIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  baselineVisualLabel,
  formatSeconds,
  frameUrl,
  suggestionToOffer,
} from '@/lib/finding-review';
import { useAdminMutations, useVideoPlayback } from '@/lib/queries';

import { LazyPhoto } from './LazyPhoto';

/**
 * The AI's suggested photograph for a finding, and what the move-in showed.
 *
 * The AI picked the frame that shows the finding best and boxed where it is.
 * The box is its estimate, drawn as one; in a trial it was right when it was
 * drawn on a sharp frame and could be beside the damage on a blurred one, which
 * is why only the close look's boxes reach here. "Use this photo" files the
 * frame under the finding, like a capture by hand; "Not this one" sets it aside
 * and offers the AI's next frame, if it had one.
 */
export function AiFrameSuggestion({
  finding,
  areaName,
  inspectionId,
  areaId,
  canDecide,
  onSeek,
}: {
  finding: AreaFinding;
  areaName: string;
  inspectionId: string;
  areaId: string;
  /** `inspections:manage`, before finalization: filing report evidence. */
  canDecide: boolean;
  onSeek: (recordingId: string, seconds: number) => void;
}) {
  const suggestion = suggestionToOffer(finding);
  const playback = useVideoPlayback(suggestion?.recordingId ?? '', Boolean(suggestion));
  const decide = useAdminMutations().decideFrameSuggestion;
  const thumbnailUrl = playback.data?.thumbnailUrl;
  const baseline = finding.baselineVisual;

  if (!suggestion && !baseline) return null;

  const seconds = suggestion ? suggestion.atMs / 1000 : 0;
  const accepted = suggestion?.status === 'ACCEPTED';
  const send = (decision: 'accept' | 'dismiss') =>
    suggestion && decide.mutate({ suggestionId: suggestion.id, decision, inspectionId, areaId });

  return (
    <section aria-label="AI suggestion" className="grid gap-2 rounded-lg border border-dashed p-2.5">
      {suggestion && thumbnailUrl ? (
        <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3">
          <figure className="relative aspect-[9/16] overflow-hidden rounded-md bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={`Frame at ${formatSeconds(seconds)} suggested for ${finding.title}`}
              className="size-full object-cover"
              src={frameUrl(thumbnailUrl, seconds, 720)}
            />
            {suggestion.box ? (
              <span
                aria-hidden
                className="border-warning absolute rounded-sm border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{
                  left: `${suggestion.box.x * 100}%`,
                  top: `${suggestion.box.y * 100}%`,
                  width: `${suggestion.box.width * 100}%`,
                  height: `${suggestion.box.height * 100}%`,
                }}
              />
            ) : null}
            <figcaption className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[11px] font-medium text-white tabular-nums">
              {formatSeconds(seconds)}
            </figcaption>
          </figure>
          <div className="grid content-start gap-2">
            <p className="text-muted-foreground text-xs font-medium">
              {accepted ? 'Added as this finding’s photo' : 'Suggested photo'}
              {suggestion.box ? ' · outlined where the AI sees it' : ''}
            </p>
            {suggestion.observation ? (
              <p className="text-sm">
                <span className="text-muted-foreground">The AI sees: </span>
                {suggestion.observation}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {accepted ? (
                <span className="text-success flex items-center gap-1 text-xs">
                  <CheckIcon aria-hidden className="size-3.5" />
                  Filed under the finding
                </span>
              ) : canDecide ? (
                <>
                  <Button disabled={decide.isPending} onClick={() => send('accept')} size="sm" type="button">
                    {decide.isPending && decide.variables?.decision === 'accept' ? (
                      <Spinner />
                    ) : (
                      <ImagePlusIcon aria-hidden />
                    )}
                    Use this photo
                  </Button>
                  <Button
                    disabled={decide.isPending}
                    onClick={() => send('dismiss')}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {decide.isPending && decide.variables?.decision === 'dismiss' ? (
                      <Spinner />
                    ) : (
                      <XIcon aria-hidden />
                    )}
                    Not this one
                  </Button>
                </>
              ) : null}
              <Button
                onClick={() => onSeek(suggestion.recordingId, Math.floor(seconds))}
                size="sm"
                type="button"
                variant="ghost"
              >
                <PlayIcon aria-hidden />
                Play here
              </Button>
            </div>
            {decide.isError ? <p className="text-destructive text-xs">{decide.error.message}</p> : null}
          </div>
        </div>
      ) : null}

      {baseline ? (
        <div className="grid gap-1.5">
          <p className="text-sm">
            <span className="font-medium">{baselineVisualLabel(baseline.status)}</span>
            {baseline.note ? <span className="text-muted-foreground"> — {baseline.note}</span> : null}
          </p>
          {baseline.photos.length ? (
            <div className="grid max-w-60 grid-cols-2 gap-1.5">
              {baseline.photos.map((photo) => (
                <LazyPhoto areaName={`${areaName} at move-in`} compact key={photo.id} photo={photo} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
