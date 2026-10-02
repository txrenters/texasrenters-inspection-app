'use client';

import type { AreaFinding, AreaPhoto, AreaRecording } from '@texasrenters/shared';
import { PlayIcon } from 'lucide-react';
import { useEffect } from 'react';

import { StatusBadge } from '@/components/status-badge';
import {
  comparisonLabel,
  findingMoment,
  formatMoment,
  responsibilityLabel,
} from '@/lib/finding-review';
import { formatDateTime, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

import { FindingFrames } from './FindingFrames';
import { FindingReviewControls } from './FindingReviewControls';
import { LazyPhoto } from './LazyPhoto';

/**
 * An area's findings, beside the recording they came from.
 *
 * The office described the old review as a loop: watch the video, read the
 * findings, go back to the video to find each one. Here, choosing a finding
 * plays the recording from the moment the technician talks about it, the
 * finding shows stills from that moment, and a decision moves on to the next
 * finding still awaiting one. J and K step through the list.
 *
 * The player itself belongs to the panel, which owns the seek; this list only
 * asks for one.
 */
export function FindingsReview({
  findings,
  recordings,
  photosByFinding,
  areaName,
  selectedId,
  onSelect,
  onSeek,
  onDecided,
  onOpenPhoto,
  inspectionId,
  areaId,
  canReview,
  canCapture,
}: {
  findings: AreaFinding[];
  recordings: AreaRecording[];
  /** Each finding's own photographs, from the area's photo groups. */
  photosByFinding: Map<string, AreaPhoto[]>;
  areaName: string;
  selectedId: string | null;
  /** Choosing a finding; the panel plays its moment. Null closes it. */
  onSelect: (findingId: string | null) => void;
  onSeek: (recordingId: string, seconds: number) => void;
  /** A decision was saved on this finding. */
  onDecided: (findingId: string) => void;
  onOpenPhoto?: (photoId: string) => void;
  inspectionId: string;
  areaId: string;
  /** Approve and reject: `findings:review`, before finalization. */
  canReview: boolean;
  /** Filing a frame as evidence: `inspections:manage`, before finalization. */
  canCapture: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== 'j' && event.key !== 'k') return;
      // Never while typing: a rejection reason is written in this list.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      const index = findings.findIndex((finding) => finding.id === selectedId);
      const next =
        event.key === 'j' ? Math.min(findings.length - 1, index + 1) : Math.max(0, index - 1);
      if (next === index || !findings[next]) return;
      event.preventDefault();
      onSelect(findings[next].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findings, onSelect, selectedId]);

  const pending = findings.filter((finding) => finding.reviewStatus === 'PENDING_REVIEW').length;
  const durations = new Map(recordings.map((recording) => [recording.id, recording.durationSeconds]));

  return (
    <div className="grid content-start gap-2">
      <p className="text-muted-foreground text-xs">
        {pending ? `${pending} awaiting a decision` : 'Every finding here has been decided'} · J and
        K move between findings
      </p>
      <ol className="grid gap-2">
        {findings.map((finding, index) => {
          const moment = findingMoment(finding);
          const selected = finding.id === selectedId;
          const photos = photosByFinding.get(finding.id) ?? [];
          const lean = responsibilityLabel(finding.possibleResponsibility);
          return (
            <li
              className={cn('rounded-lg border', selected && 'border-primary/60 ring-primary/30 ring-1')}
              key={finding.id}
            >
              <button
                aria-expanded={selected}
                className="hover:bg-accent/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                onClick={() => onSelect(selected ? null : finding.id)}
                type="button"
              >
                <span className="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded text-xs font-semibold tabular-nums">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-sm font-medium">{finding.title}</span>
                  <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
                    <span className="truncate">{humanize(finding.category).toLowerCase()}</span>
                    {moment ? (
                      <span className="text-foreground inline-flex shrink-0 items-center gap-1 tabular-nums">
                        · <PlayIcon aria-hidden className="size-3" />
                        {formatMoment(moment)}
                      </span>
                    ) : finding.recordingId ? (
                      <span className="shrink-0">· no time given</span>
                    ) : null}
                    {finding.photoCount ? (
                      <span className="shrink-0">
                        · {finding.photoCount} photo{finding.photoCount === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge showIcon={false} value={finding.severity} />
                  <StatusBadge showIcon={false} value={finding.reviewStatus} />
                </span>
              </button>

              {selected ? (
                <div className="grid gap-3 border-t p-3">
                  <p className="text-sm">{finding.description}</p>
                  {finding.recommendedReview ? (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Check: </span>
                      {finding.recommendedReview}
                    </p>
                  ) : null}
                  {finding.baselineCondition ? (
                    <p className="text-muted-foreground text-xs">
                      At move-in: {finding.baselineCondition}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground text-xs">
                    {[
                      comparisonLabel(finding.comparisonResult),
                      lean,
                      `confidence ${Math.round(finding.confidence * 100)}%`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>

                  {moment ? (
                    <FindingFrames
                      capture={canCapture ? { findingId: finding.id, inspectionId, areaId } : null}
                      durationSeconds={durations.get(moment.recordingId) ?? moment.end}
                      moment={moment}
                      onSeek={(seconds) => onSeek(moment.recordingId, seconds)}
                    />
                  ) : finding.recordingId ? (
                    <p className="text-muted-foreground text-xs">
                      The AI gave no time for this finding. Re-run the AI on the recording to
                      place it.
                    </p>
                  ) : null}

                  {photos.length ? (
                    <div className="grid grid-cols-4 gap-1.5">
                      {photos.map((photo) => (
                        <LazyPhoto
                          areaName={areaName}
                          compact
                          key={photo.id}
                          onOpen={onOpenPhoto ? () => onOpenPhoto(photo.id) : undefined}
                          photo={photo}
                        />
                      ))}
                    </div>
                  ) : null}

                  {canReview ? (
                    <FindingReviewControls
                      finding={finding}
                      inspectionId={inspectionId}
                      onDecided={() => onDecided(finding.id)}
                    />
                  ) : finding.lastReview ? (
                    <p className="text-muted-foreground text-xs">
                      {finding.lastReview.reviewerName} ·{' '}
                      {formatDateTime(finding.lastReview.createdAt)}
                      {finding.lastReview.reason ? ` · ${finding.lastReview.reason}` : ''}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
