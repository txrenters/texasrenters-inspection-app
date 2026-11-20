'use client';

import {
  RECORDING_ACTION_HEADING,
  type AreaRecordingSummaryView,
  type RecordingActionRepairInput,
} from '@texasrenters/shared';
import { SparklesIcon } from 'lucide-react';

import { SECTION_LABEL } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatSeconds } from '@/lib/finding-review';
import { formatDateTime } from '@/lib/format';
import {
  useMarkRecordingActionRepaired,
  useSummarizeAreaRecordings,
  useSummarizeInspectionRecordings,
} from '@/lib/queries';
import { cn } from '@/lib/utils';

/** What a move-in summary says is in good order: the report prints it beside each item. */
export const OBSERVATIONS_HEADING = 'In good order';

/**
 * A summary's points at their moments, then -- on a move-in -- what is in good
 * order, then what the room needs under the office's headings. Shared by the
 * Recording tab's card and the "Summaries of all areas" page, so the two cannot
 * show a summary differently.
 */
export function RecordingSummaryBody({
  onRepairedChange,
  onSeek,
  repairing = false,
  summary,
}: {
  /**
   * Marks an action repaired after the walkthrough, or takes the mark back;
   * given only to someone who may (`inspections:manage`).
   */
  onRepairedChange?: (input: RecordingActionRepairInput) => void;
  /** Plays the room's walkthrough from a point's moment, when a player is mounted. */
  onSeek?: (seconds: number) => void;
  repairing?: boolean;
  summary: AreaRecordingSummaryView;
}) {
  return (
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
      {/* A move-in's: what the report prints as in good order, beside its item. */}
      {summary.observations?.length ? (
        <div className="space-y-1">
          <p className="font-semibold">{OBSERVATIONS_HEADING}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {summary.observations.map((observation, index) => (
              <li key={index}>
                {observation.text}
                {observation.itemLabel ? (
                  <span className="text-muted-foreground"> · {observation.itemLabel}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.actions.map((group) => (
        <div className="space-y-1" key={group.group}>
          <p className="font-semibold">{RECORDING_ACTION_HEADING[group.group]}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {group.items.map((item, index) => (
              <li key={index}>
                <span className={cn(item.repairedAt && 'text-muted-foreground line-through')}>{item.text}</span>
                {/* The checklist item it prints beside on the report. */}
                {item.itemLabel ? (
                  <span className="text-muted-foreground"> · {item.itemLabel}</span>
                ) : null}
                {/* Repaired after the walkthrough: the report says so, not "needed". */}
                {item.repairedAt ? (
                  <span className="text-muted-foreground">
                    {' '}
                    · Repaired after the walkthrough, {formatDateTime(item.repairedAt)}
                    {item.repairedBy ? ` by ${item.repairedBy}` : ''}
                  </span>
                ) : null}
                {onRepairedChange ? (
                  <Button
                    className="ml-2 h-6 px-2 text-xs"
                    disabled={repairing}
                    onClick={() =>
                      onRepairedChange({ group: group.group, text: item.text, repaired: !item.repairedAt })
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {item.repairedAt ? 'Undo' : 'Mark repaired'}
                  </Button>
                ) : null}
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
  );
}

/**
 * The summary of this room's recordings (2026-10-07): each point at the moment
 * it was said, then what the room needs as Repairs / Maintenance, Painting and
 * Cleaning. The shared report prints only that last part, under the room's
 * photographs; the timestamped points are for the office, here and on the
 * "Summaries of all areas" tab.
 *
 * Until a room is summarized -- or once a recording arrives after its summary
 * -- the report lists nothing under its photographs, and this says so.
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
  const repair = useMarkRecordingActionRepaired(inspectionId, areaId);
  const busy = room.isPending || every.isPending;
  const error = room.error ?? every.error ?? repair.error;
  const status = error
    ? error.message
    : every.data
      ? every.data.queued
        ? `Summarizing the recordings of ${every.data.areas} rooms. Each room's summary appears here as it finishes, within a couple of minutes.`
        : 'Every room is already being summarized.'
      : room.isSuccess && !room.data
        ? 'Nothing was said in this room’s recordings, so there is nothing to summarize.'
        : null;

  // A section under a hairline, not a card inside the Areas card
  // (console-development).
  return (
    <section aria-labelledby={`report-summary-${areaId}`} className="space-y-4 border-t pt-4">
      <header className="space-y-1">
        <h4 className={SECTION_LABEL} id={`report-summary-${areaId}`}>
          Summary for the report
        </h4>
        <p className="text-muted-foreground text-sm">
          {summary
            ? summary.current
              ? `Written by AI from the recordings ${formatDateTime(summary.generatedAt)}. The report prints each action in the Comments column, beside the item it is about.`
              : summary.staleReason === 'FORMAT'
                ? 'Written before actions were tied to checklist items. Summarize again: until then the report’s Comments come from the findings.'
                : 'A recording arrived after this summary was written. Summarize again: until then the report’s Comments come from the findings.'
            : 'Not summarized yet. The report’s Comments come from the findings until it is.'}
        </p>
      </header>
      {summary ? (
        <RecordingSummaryBody
          onRepairedChange={canManage && summary.current ? (input) => repair.mutate(input) : undefined}
          onSeek={onSeek}
          repairing={repair.isPending}
          summary={summary}
        />
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
    </section>
  );
}
