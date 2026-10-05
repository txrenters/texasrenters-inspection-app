'use client';

import { CheckIcon, CopyIcon, FileTextIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatSeconds } from '@/lib/finding-review';
import { useRecordingTranscript } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** A finding's stretch of the recording, to mark in the transcript. */
export interface TranscriptFindingSpan {
  id: string;
  title: string;
  start: number;
  end: number;
}

/**
 * The narration word for word, beside the video.
 *
 * The office (2026-10-06): reviewing a move-out meant listening through the
 * walkthrough to hear what the technician said about each finding, and the
 * findings are only the AI's reading of it. The whole narration is here instead,
 * one line per thing said with its time: a line plays the recording from there,
 * and the lines a finding was written from are marked with it.
 *
 * Transcribed on the server from Cloudflare's copy of the video -- never on the
 * phone, whose upload it would slow.
 */
export function RecordingTranscript({
  mediaId,
  findings = [],
  playingSecond = null,
  onSeek,
  className,
}: {
  mediaId: string;
  findings?: TranscriptFindingSpan[];
  /** The second the player was last sent to, so its line reads as the one playing. */
  playingSecond?: number | null;
  onSeek: (seconds: number) => void;
  className?: string;
}) {
  const transcript = useRecordingTranscript(mediaId);
  const [copied, setCopied] = useState(false);
  const lines = transcript.data?.lines ?? [];
  const status = transcript.data?.status;

  /**
   * The finding a line belongs to: the one sharing the most of its seconds.
   *
   * Two findings told one after the other share the second between them
   * ("...two planks." 0:18-0:22, "And the strip is missing." 0:22-0:26), and
   * taking the first that touched gave the second finding's line to the first.
   * Touching counts only for a moment with no length, a line or a finding.
   */
  const findingOf = (line: { start: number; end: number }) => {
    let best: TranscriptFindingSpan | null = null;
    let most = -1;
    for (const finding of findings) {
      const shared = Math.min(line.end, finding.end) - Math.max(line.start, finding.start);
      const point = line.start === line.end || finding.start === finding.end;
      if ((shared > 0 || (shared === 0 && point)) && shared > most) {
        best = finding;
        most = shared;
      }
    }
    return best;
  };
  // Each finding's title once, on the first line of its stretch.
  const titled = new Set<string>();

  const copy = async () => {
    const text = lines.map((line) => `[${formatSeconds(line.start)}] ${line.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (an insecure origin, a denied permission): nothing to undo.
    }
  };

  return (
    <section
      aria-label="Transcript"
      className={cn('bg-card flex min-h-0 flex-col rounded-lg border', className)}
    >
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <FileTextIcon aria-hidden className="text-muted-foreground size-4" />
          Transcript
        </p>
        {lines.length ? (
          <Button className="h-7 text-xs" onClick={() => void copy()} size="sm" type="button" variant="ghost">
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        ) : null}
      </header>

      {transcript.isLoading ? (
        <div aria-busy="true" className="grid gap-2 p-3" role="status">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
          <span className="sr-only">Loading the transcript…</span>
        </div>
      ) : transcript.isError ? (
        <p className="text-muted-foreground p-3 text-sm">The transcript could not be loaded.</p>
      ) : !lines.length ? (
        <p className="text-muted-foreground p-3 text-sm">
          {status === 'PENDING' || status === 'RUNNING'
            ? 'Transcribing the narration. It appears here when it is done.'
            : status === 'FAILED'
              ? 'The narration could not be transcribed.'
              : status === 'COMPLETED'
                ? 'No narration was heard in this recording.'
                : 'This recording has not been transcribed.'}
        </p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {lines.map((line, index) => {
            const finding = findingOf(line);
            const showTitle = finding && !titled.has(finding.id);
            if (finding) titled.add(finding.id);
            const playing =
              playingSecond !== null && playingSecond >= line.start && playingSecond <= Math.max(line.end, line.start);
            return (
              <li key={`${line.start}-${index}`}>
                {showTitle ? (
                  <p className="text-warning truncate px-2 pt-2 text-xs font-medium">{finding.title}</p>
                ) : null}
                <button
                  aria-current={playing ? 'true' : undefined}
                  className={cn(
                    'hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full gap-2.5 rounded-md border-l-2 border-transparent px-2 py-1.5 text-left text-sm leading-relaxed focus-visible:ring-[3px] focus-visible:outline-none',
                    finding && 'border-warning/70',
                    playing && 'bg-accent',
                  )}
                  onClick={() => onSeek(line.start)}
                  title={`Play from ${formatSeconds(line.start)}`}
                  type="button"
                >
                  <span className="text-muted-foreground shrink-0 pt-px font-mono text-xs tabular-nums">
                    {formatSeconds(line.start)}
                  </span>
                  <span>{line.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
