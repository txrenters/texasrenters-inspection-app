'use client';

import type { AreaFinding, AreaRecording } from '@texasrenters/shared';
import { useState } from 'react';

import { FieldError } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { api, apiBlob } from '@/lib/api';
import { useAdminMutations, useAreaEvidence } from '@/lib/queries';
import { usePermissions } from '@/lib/auth';
import { buttonVariants } from '@/components/ui/button';
import { Badge, ErrorState, formatDate } from '../shared';

import { LazyPhoto, captureLabel } from './LazyPhoto';

function formatSeconds(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * One recording. Nothing is fetched until Play: the card shows the poster,
 * duration and status, and the playback URL is minted on demand. Mounting a
 * player per recording was what made the old page expensive.
 */
function RecordingCard({
  recording,
  activeId,
  onActivate,
}: {
  recording: AreaRecording;
  activeId: string | null;
  onActivate: (id: string | null) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = activeId === recording.id;

  async function play() {
    // Only one player is live at a time, so opening another disposes this one.
    onActivate(recording.id);
    if (source || objectUrl) return;
    setLoading(true);
    setError(null);
    try {
      const playback = await api<{ url: string | null }>(
        `/api/v1/admin/media/${recording.id}/playback`,
      ).catch(() => ({ url: null }));
      if (playback.url) {
        setSource(playback.url);
        return;
      }
      const blob = await apiBlob(recording.contentPath);
      setObjectUrl(URL.createObjectURL(blob));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This recording could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="area-recording">
      <header>
        <strong>
          {recording.recordingType === 'PRIMARY_AREA'
            ? 'Primary recording'
            : recording.label || 'Additional recording'}
        </strong>
        <Badge value={recording.processingStatus} />
      </header>
      {active && (source || objectUrl) ? (
        <video
          controls
          autoPlay
          className="area-recording-player"
          poster={recording.thumbnailUrl ?? undefined}
          src={source ?? objectUrl ?? undefined}
        />
      ) : (
        <button type="button" className="area-recording-poster" onClick={() => void play()}>
          {recording.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={recording.thumbnailUrl} alt={`Poster frame for ${recording.label ?? 'recording'}`} />
          ) : (
            <span className="area-photo-placeholder" aria-hidden />
          )}
          <span className="area-recording-play">{loading ? 'Loading…' : 'Play recording'}</span>
        </button>
      )}
      {error ? (
        <Alert variant="destructive" role="alert">
          {error} <button type="button" onClick={() => void play()}>Retry</button>
        </Alert>
      ) : null}
      <footer className="text-[13px] text-muted-foreground">
        {formatSeconds(recording.durationSeconds)} · {recording.technicianName} ·{' '}
        {formatDate(recording.createdAt)}
      </footer>
    </article>
  );
}

/**
 * Approve or reject a finding, inline in the area workspace.
 *
 * Findings review is the one decision this screen exists to support, so it must
 * live beside the evidence rather than on a separate page-wide list.
 */
function FindingReviewControls({
  finding,
  inspectionId,
}: {
  finding: AreaFinding;
  inspectionId: string;
}) {
  const { approveFinding, rejectFinding } = useAdminMutations();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const busy = approveFinding.isPending || rejectFinding.isPending;

  if (finding.reviewStatus !== 'PENDING_REVIEW')
    return finding.lastReview ? (
      <span className="text-[13px] text-muted-foreground">
        {finding.lastReview.reviewerName} · {formatDate(finding.lastReview.createdAt)}
        {finding.lastReview.reason ? ` · ${finding.lastReview.reason}` : ''}
      </span>
    ) : (
      <span className="text-[13px] text-muted-foreground">Reviewed</span>
    );

  if (rejecting)
    return (
      <div className="grid gap-2">
        <textarea
          aria-label="Rejection reason"
          placeholder="Why is this finding rejected?"
          value={reason}
          minLength={2}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonVariants({ variant: 'secondary', size: 'small' })}
            onClick={() => setRejecting(false)}
            disabled={busy}
          >
            Back
          </button>
          <button
            type="button"
            className={buttonVariants({ variant: 'danger', size: 'small' })}
            // A reason is mandatory: a rejected finding without one leaves no
            // record of why the AI output was overruled.
            disabled={reason.trim().length < 2 || busy}
            onClick={() =>
              void rejectFinding
                .mutateAsync({ id: finding.id, inspectionId, reason: reason.trim() })
                .then(() => setRejecting(false))
                .catch(() => undefined)
            }
          >
            {rejectFinding.isPending ? 'Rejecting…' : 'Confirm reject'}
          </button>
        </div>
        {rejectFinding.error ? (
          <FieldError>{rejectFinding.error.message}</FieldError>
        ) : null}
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={buttonVariants({ variant: 'primary', size: 'small' })}
        disabled={busy}
        onClick={() =>
          void approveFinding
            .mutateAsync({ id: finding.id, inspectionId })
            .catch(() => undefined)
        }
      >
        {approveFinding.isPending ? 'Approving…' : 'Approve'}
      </button>
      <button
        type="button"
        className={buttonVariants({ variant: 'secondary', size: 'small' })}
        disabled={busy}
        onClick={() => setRejecting(true)}
      >
        Reject
      </button>
      {approveFinding.error ? (
        <FieldError>{approveFinding.error.message}</FieldError>
      ) : null}
    </div>
  );
}

/** One itemized finding. The paragraph is supporting detail, not the item. */
function FindingRow({
  finding,
  index,
  inspectionId,
  canReview,
}: {
  finding: AreaFinding;
  index: number;
  inspectionId: string;
  canReview: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="area-finding">
      <button
        type="button"
        className="area-finding-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="area-finding-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="grid min-w-0 flex-1 gap-px">
          <strong>{finding.title}</strong>
          <span className="text-[13px] text-muted-foreground">
            {finding.category.replaceAll('_', ' ').toLowerCase()}
            {finding.photoCount ? ` · ${finding.photoCount} photo${finding.photoCount === 1 ? '' : 's'}` : ''}
            {finding.recordingId
              ? ` · video ${formatSeconds(finding.videoTimestampStart)}`
              : ''}
          </span>
        </span>
        <span className="flex shrink-0 gap-1.5">
          <Badge value={finding.severity} />
          <Badge value={finding.reviewStatus} />
        </span>
      </button>
      {expanded ? (
        <div className="area-finding-body">
          <p>{finding.description}</p>
          {finding.baselineCondition ? (
            <p className="text-[13px] text-muted-foreground">At move-in: {finding.baselineCondition}</p>
          ) : null}
          <p className="text-[13px] text-muted-foreground">
            {finding.comparisonResult.replaceAll('_', ' ').toLowerCase()} · confidence{' '}
            {Math.round(finding.confidence * 100)}%
          </p>
          {canReview ? (
            <FindingReviewControls finding={finding} inspectionId={inspectionId} />
          ) : finding.lastReview ? (
            <p className="text-[13px] text-muted-foreground">
              {finding.lastReview.reviewerName} · {formatDate(finding.lastReview.createdAt)}
              {finding.lastReview.reason ? ` · ${finding.lastReview.reason}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function AreaDetailPanel({
  inspectionId,
  areaId,
}: {
  inspectionId: string;
  areaId: string;
}) {
  const evidence = useAreaEvidence(inspectionId, areaId);
  const [activeRecording, setActiveRecording] = useState<string | null>(null);
  // Reviewing is a privileged decision; reading evidence is not.
  const canReview = usePermissions().has('findings:review');

  // An area-level skeleton, never a whole-page loader, and keyed by area so a
  // slow response can never paint over the area the reviewer is looking at.
  if (evidence.isLoading)
    return (
      <div className="area-detail-skeleton" role="status" aria-live="polite">
        Loading area evidence…
      </div>
    );
  if (evidence.isError)
    return <ErrorState error={evidence.error} retry={() => void evidence.refetch()} />;

  const bundle = evidence.data!;
  const { area, recordings, photoGroups, findings, conditionSummary } = bundle;

  return (
    <div className="area-detail">
      <header className="area-detail-header">
        <div>
          <h3>{area.name}</h3>
          <span className="text-[13px] text-muted-foreground">
            {area.floorName ?? 'No floor recorded'} ·{' '}
            {area.isRequired ? 'Required' : 'Optional'} · {area.completionStatus}
          </span>
        </div>
      </header>

      {area.skipReason ? (
        <Alert variant="destructive" role="alert">
          Skipped — {area.skipReason}
        </Alert>
      ) : null}

      {conditionSummary ? (
        <section className="mt-5 border-t border-border pt-4">
          <h4>Condition summary</h4>
          <p>{conditionSummary.description}</p>
          <span className="text-[13px] text-muted-foreground">
            Overall context — itemized findings below list the specific work.
          </span>
        </section>
      ) : null}

      <section className="mt-5 border-t border-border pt-4">
        <h4>Recordings</h4>
        {recordings.length ? (
          <div className="area-recording-list">
            {recordings.map((recording) => (
              <RecordingCard
                key={recording.id}
                recording={recording}
                activeId={activeRecording}
                onActivate={setActiveRecording}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No recordings were uploaded for this area.</p>
        )}
      </section>

      <section className="mt-5 border-t border-border pt-4">
        <h4>Photos</h4>
        {photoGroups.length ? (
          photoGroups.map((group) => (
            <div key={`${group.key}-${group.findingId ?? 'area'}`} className="area-photo-group">
              <h5>
                {group.label}
                {group.findingId ? <span className="text-[13px] text-muted-foreground"> · finding evidence</span> : null}
              </h5>
              <div className="area-photo-grid">
                {group.photos.map((photo) => (
                  <LazyPhoto key={photo.id} photo={photo} areaName={area.name} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">No photos were captured for this area.</p>
        )}
      </section>

      <section className="mt-5 border-t border-border pt-4">
        <h4>
          Findings{' '}
          {findings.length ? <span className="section-count">{findings.length}</span> : null}
        </h4>
        {findings.length ? (
          <ol className="area-finding-list">
            {findings.map((finding, index) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                index={index}
                inspectionId={inspectionId}
                canReview={canReview}
              />
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            {recordings.length || photoGroups.length
              ? 'No issues were reported for this area.'
              : 'Analysis has not run for this area yet.'}
          </p>
        )}
      </section>
    </div>
  );
}

export { captureLabel };
