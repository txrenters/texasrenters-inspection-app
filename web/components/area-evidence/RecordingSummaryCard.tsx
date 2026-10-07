'use client';

import {
  RECORDING_ACTION_HEADING,
  type AreaRecordingSummaryView,
} from '@texasrenters/shared';
import { SparklesIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { formatSeconds } from '@/lib/finding-review';
import { formatDateTime } from '@/lib/format';
import {
  useSummarizeAreaRecordings,
  useSummarizeInspectionRecordings,
} from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * What the shared report prints under this room's photographs (2026-10-07):
 * each point of the recordings at the moment it was said, then what the room
 * needs as Repairs / Maintenance, Painting and Cleaning. Shown here so the
 * office reads it before an owner or tenant does, and can write it again.
 *
 * Until a room is summarized -- or once a recording arrives after its summary
 * -- the report prints the narration word for word instead, and this says so.
 */
export function RecordingSummaryCard({
  areaId,
  canManage,
  inspectionId,
  onSeek,
  summary,
}: {
  areaId: string;
  canManage: boolean;
  inspectionId: string;
  /** Plays the room's walkthrough from a point's moment, when it has one. */
  onSeek?: (seconds: number) => void;
  summary: AreaRecordingSummaryView | null | undefined;
}) {
  const room = useSummarizeAreaRecordings(inspectionId, areaId);
  const every = useSummarizeInspectionRecordings(inspectionId);
  const busy = room.isPending || every.isPending;
  const error = room.error ?? every.error;
  const status = error
    ? error.message
    : every.data
      ? every.data.queued
        ? `Summarizing the recordings of ${every.data.areas} rooms. Each room's summary appears here as it finishes, within a couple of minutes.`
        : 'Every room is already being summarized.'
      : room.isSuccess && !room.data
        ? 'Nothing was said in this room’s recordings, so there is nothing to summarize.'
        : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Summary for the report</CardTitle>
        <CardDescription>
          {summary
            ? summary.current
              ? `Written by AI from the recordings ${formatDateTime(summary.generatedAt)}. The report prints this under the room’s photographs.`
              : 'A recording arrived after this summary was written, so the report prints the narration word for word until it is summarized again.'
            : 'Not summarized yet. The report prints the narration word for word.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary ? (
          <div className={cn('space-y-3 text-sm', !summary.current && 'opacity-60')}>
            {summary.recordings.map((recording) => (
              <p className="leading-relaxed" key={recording.mediaId}>
                {recording.label ? <span className="font-medium">{recording.label}: </span> : null}
                {recording.lines.map((line, index) => (
                  <span key={index}>
                    {index ? ' ' : ''}
                    {onSeek && !recording.label ? (
                      <button
                        className="text-muted-foreground hover:text-foreground tabular-nums underline underline-offset-2"
                        onClick={() => onSeek(line.start)}
                        type="button"
                      >
                        [{formatSeconds(line.start)}]
                      </button>
                    ) : (
                      <span className="text-muted-foreground tabular-nums">
                        [{formatSeconds(line.start)}]
                      </span>
                    )}{' '}
                    {line.text}
                  </span>
                ))}
              </p>
            ))}
            {summary.actions.map((group) => (
              <div className="space-y-1" key={group.group}>
                <p className="font-semibold">{RECORDING_ACTION_HEADING[group.group]}</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {group.items.map((item, index) => (
                    <li key={index}>
                      {item.text}
                      {item.details.length ? (
                        <ul className="list-[circle] pl-5">
                          {item.details.map((detail, detailIndex) => (
                            <li key={detailIndex}>{detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}

        {canManage ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy} onClick={() => room.mutate()} size="sm" type="button" variant="outline">
                {room.isPending ? <Spinner className="size-3" /> : <SparklesIcon />}
                {summary ? 'Summarize this room again' : 'Summarize this room'}
              </Button>
              <Button disabled={busy} onClick={() => every.mutate()} size="sm" type="button" variant="ghost">
                {every.isPending ? <Spinner className="size-3" /> : null}
                Summarize every room
              </Button>
            </div>
            {status ? (
              <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
                {status}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
