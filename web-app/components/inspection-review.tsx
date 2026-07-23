'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBlob } from '@/lib/api';
import { usePermissions } from '@/lib/auth';
import { useAdminMutations, useInspectionFindings, useInspectionMedia } from '@/lib/queries';
import type { AdminInspectionFinding } from '@texasrenters/shared';

import { Badge, ErrorState, LoadingState, Pagination, formatDate } from './ui';

function formatSeconds(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function RoomVideoPlayer({ contentPath, label }: { contentPath: string; label: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const blob = await apiBlob(contentPath);
      setObjectUrl(URL.createObjectURL(blob));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The video could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  if (objectUrl)
    return (
      <video className="room-video-player" controls preload="metadata" src={objectUrl}>
        Your browser cannot play this recording.
      </video>
    );
  return (
    <div className="room-video-placeholder">
      <button
        type="button"
        className="button button-secondary"
        onClick={() => void load()}
        disabled={loading}
      >
        {loading ? 'Loading video…' : `Load ${label} video`}
      </button>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

export function InspectionMediaSection({ inspectionId }: { inspectionId: string }) {
  const media = useInspectionMedia(inspectionId);
  return (
    <section className="panel section-gap inspection-section">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Inspection evidence</span>
          <h2>Room recordings</h2>
          <p className="panel-description">Video evidence uploaded by the assigned technician.</p>
        </div>
        {!media.isLoading && !media.isError ? (
          <span className="section-count">{media.data?.length ?? 0} recordings</span>
        ) : null}
      </div>
      {media.isLoading ? (
        <LoadingState label="Loading room recordings…" />
      ) : media.isError ? (
        <ErrorState error={media.error} retry={() => void media.refetch()} />
      ) : media.data?.length ? (
        <div className="media-grid">
          {media.data.map((item) => (
            <article key={item.id} className="media-card">
              <header className="media-card-header">
                <div>
                  <strong>{item.roomName}</strong>
                  {item.floorName ? <span className="media-meta"> · {item.floorName}</span> : null}
                </div>
                <Badge value={item.uploadStatus} />
              </header>
              <RoomVideoPlayer contentPath={item.contentPath} label={item.roomName} />
              <footer className="media-card-footer">
                <span className="media-meta">
                  {formatSeconds(item.durationSeconds)} · {item.technicianName} ·{' '}
                  {formatDate(item.createdAt)}
                </span>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="inspection-empty-state">
          <span className="inspection-empty-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path d="M4 6h11v12H4zM15 10l5-3v10l-5-3" />
            </svg>
          </span>
          <div>
            <strong>No room recordings yet</strong>
            <p>
              Videos will appear here after the technician records and uploads inspection areas.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function FindingReviewControls({
  finding,
  inspectionId,
}: {
  finding: AdminInspectionFinding;
  inspectionId: string;
}) {
  const { approveFinding, rejectFinding } = useAdminMutations();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const busy = approveFinding.isPending || rejectFinding.isPending;

  if (finding.reviewStatus !== 'PENDING_REVIEW')
    return finding.lastReview ? (
      <span className="media-meta">
        {finding.lastReview.reviewerName} · {formatDate(finding.lastReview.createdAt)}
        {finding.lastReview.reason ? ` · ${finding.lastReview.reason}` : ''}
      </span>
    ) : (
      <span className="media-meta">Reviewed</span>
    );

  if (rejecting)
    return (
      <div className="finding-reject-form">
        <textarea
          aria-label="Rejection reason"
          placeholder="Why is this finding rejected?"
          value={reason}
          minLength={2}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="action-row">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setRejecting(false)}
            disabled={busy}
          >
            Back
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={reason.trim().length < 2 || busy}
            onClick={() =>
              void rejectFinding
                .mutateAsync({ id: finding.id, inspectionId, reason: reason.trim() })
                .then(() => setRejecting(false))
            }
          >
            {rejectFinding.isPending ? 'Rejecting…' : 'Confirm reject'}
          </button>
        </div>
        {rejectFinding.error ? <p className="field-error">{rejectFinding.error.message}</p> : null}
      </div>
    );

  return (
    <div className="action-row">
      <button
        type="button"
        className="button button-primary"
        disabled={busy}
        onClick={() => void approveFinding.mutateAsync({ id: finding.id, inspectionId })}
      >
        {approveFinding.isPending ? 'Approving…' : 'Approve'}
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={busy}
        onClick={() => setRejecting(true)}
      >
        Reject
      </button>
      {approveFinding.error ? <p className="field-error">{approveFinding.error.message}</p> : null}
    </div>
  );
}

export function InspectionSummariesSection({ inspectionId }: { inspectionId: string }) {
  const canReadFindings = usePermissions().has('findings:read');
  const [page, setPage] = useState(1);
  const summaries = useInspectionFindings(inspectionId, page, '', 'SUMMARIES', canReadFindings);
  if (!canReadFindings) return null;
  return (
    <section className="panel section-gap inspection-section">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Informational</span>
          <h2>Room condition summaries</h2>
          <p className="panel-description">
            AI narration summaries per room. These are reference material only — they need no
            approval and never lead to tenant charges.
          </p>
        </div>
        {!summaries.isLoading && !summaries.isError ? (
          <span className="section-count">{summaries.data?.total ?? 0} rooms</span>
        ) : null}
      </div>
      {summaries.isLoading ? (
        <LoadingState label="Loading room summaries…" />
      ) : summaries.isError ? (
        <ErrorState error={summaries.error} retry={() => void summaries.refetch()} />
      ) : summaries.data?.items.length ? (
        <>
          <ul className="finding-list">
            {summaries.data.items.map((summary) => (
              <li key={summary.id} className="finding-card">
                <header className="finding-card-header">
                  <strong>{summary.roomName}</strong>
                  <Badge value="SUMMARY" />
                </header>
                <p>{summary.description}</p>
              </li>
            ))}
          </ul>
          <Pagination page={page} totalPages={summaries.data.totalPages} onPage={setPage} />
        </>
      ) : (
        <div className="inspection-empty-state">
          <span className="inspection-empty-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
            </svg>
          </span>
          <div>
            <strong>No room summaries yet</strong>
            <p>A condition summary appears for each room once its recording is processed.</p>
          </div>
        </div>
      )}
    </section>
  );
}

export function InspectionFindingsSection({ inspectionId }: { inspectionId: string }) {
  const canReadFindings = usePermissions().has('findings:read');
  const canReviewFindings = usePermissions().has('findings:review');
  const [page, setPage] = useState(1);
  const [reviewStatus, setReviewStatus] = useState('');
  const findings = useInspectionFindings(
    inspectionId,
    page,
    reviewStatus,
    'DEFECTS',
    canReadFindings,
  );
  const isFilterPending = findings.isPlaceholderData;
  if (!canReadFindings) return null;
  return (
    <section className="panel section-gap inspection-section">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Human oversight</span>
          <h2>Findings review</h2>
          <p className="panel-description">
            Review each finding to decide whether it should be charged to the tenant. Findings stay
            pending until an authorized person approves or rejects them — the AI never decides
            charges.
          </p>
        </div>
        <div className="finding-filter field">
          <label htmlFor="finding-review-status">Review status</label>
          <select
            id="finding-review-status"
            value={reviewStatus}
            onChange={(event) => {
              setPage(1);
              setReviewStatus(event.target.value);
            }}
          >
            <option value="">All statuses</option>
            <option value="PENDING_REVIEW">Pending review</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </div>
      </div>
      {findings.isLoading || isFilterPending ? (
        <LoadingState label={isFilterPending ? 'Filtering findings...' : 'Loading findings...'} />
      ) : findings.isError ? (
        <ErrorState error={findings.error} retry={() => void findings.refetch()} />
      ) : findings.data?.items.length ? (
        <>
          <ul className="finding-list">
            {findings.data.items.map((finding) => (
              <li key={finding.id} className="finding-card">
                <header className="finding-card-header">
                  <div>
                    <strong>{finding.title}</strong>
                    <span className="media-meta">
                      {' '}
                      · {finding.roomName} · {formatSeconds(finding.videoTimestampStart)}–
                      {formatSeconds(finding.videoTimestampEnd)}
                    </span>
                  </div>
                  <div className="action-row">
                    <Badge value={finding.severity} />
                    <Badge value={finding.reviewStatus} />
                  </div>
                </header>
                <p>{finding.description}</p>
                <p className="media-meta">
                  Baseline: {finding.baselineCondition || 'Not documented'} · Comparison:{' '}
                  {finding.comparisonResult.replaceAll('_', ' ').toLowerCase()} · Confidence:{' '}
                  {Math.round(finding.confidence * 100)}%
                </p>
                {canReviewFindings ? (
                  <FindingReviewControls finding={finding} inspectionId={inspectionId} />
                ) : finding.lastReview ? (
                  <span className="media-meta">
                    {finding.lastReview.reviewerName} · {formatDate(finding.lastReview.createdAt)}
                  </span>
                ) : (
                  <span className="media-meta">Awaiting an authorized reviewer</span>
                )}
              </li>
            ))}
          </ul>
          <Pagination page={page} totalPages={findings.data.totalPages} onPage={setPage} />
        </>
      ) : (
        <div className="inspection-empty-state">
          <span className="inspection-empty-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path d="M12 3 4 7v5c0 4.5 3 7.5 8 9 5-1.5 8-4.5 8-9V7l-8-4Zm-3 9 2 2 4-5" />
            </svg>
          </span>
          <div>
            <strong>
              {reviewStatus ? 'No findings match this filter' : 'No AI findings generated'}
            </strong>
            <p>
              {reviewStatus
                ? 'Choose another review status to see available findings.'
                : 'Findings will appear after uploaded room evidence has been processed.'}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

export function InspectionCompleteDialog({
  inspectionId,
  pendingFindings,
  onClose,
}: {
  inspectionId: string;
  pendingFindings: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const mutation = useAdminMutations().updateInspection;

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({ id: inspectionId, status: 'COMPLETED' });
    onClose();
  }

  return (
    <dialog ref={ref} className="dialog" onCancel={onClose} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <h2>Complete inspection</h2>
        <p>
          Completing finalizes this inspection. It can no longer be edited, assigned, or cancelled
          afterwards.
        </p>
        {pendingFindings > 0 ? (
          <p className="field-error">
            {pendingFindings} AI finding{pendingFindings === 1 ? '' : 's'} still await human review.
            Review them before completing.
          </p>
        ) : null}
        {mutation.error ? <p className="field-error">{mutation.error.message}</p> : null}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep open
          </button>
          <button
            className="button button-primary"
            disabled={mutation.isPending || pendingFindings > 0}
          >
            {mutation.isPending ? 'Completing…' : 'Complete inspection'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
