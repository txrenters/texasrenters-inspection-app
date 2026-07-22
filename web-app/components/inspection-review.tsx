'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBlob } from '@/lib/api';
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
    <section className="panel section-gap">
      <div className="panel-header">
        <h2>Room recordings</h2>
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
        <p>No room videos have been uploaded for this inspection yet.</p>
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

export function InspectionFindingsSection({ inspectionId }: { inspectionId: string }) {
  const [page, setPage] = useState(1);
  const [reviewStatus, setReviewStatus] = useState('');
  const findings = useInspectionFindings(inspectionId, page, reviewStatus);
  return (
    <section className="panel section-gap">
      <div className="panel-header">
        <h2>AI findings review</h2>
        <select
          aria-label="Filter findings by review status"
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
      <p className="media-meta">
        AI findings stay pending until a person approves or rejects them. Approvals and rejections
        are recorded in the audit trail.
      </p>
      {findings.isLoading ? (
        <LoadingState label="Loading findings…" />
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
                <FindingReviewControls finding={finding} inspectionId={inspectionId} />
              </li>
            ))}
          </ul>
          <Pagination page={page} totalPages={findings.data.totalPages} onPage={setPage} />
        </>
      ) : (
        <p>
          {reviewStatus
            ? 'No findings match this filter.'
            : 'No AI findings have been generated for this inspection yet.'}
        </p>
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
            {pendingFindings} AI finding{pendingFindings === 1 ? '' : 's'} still await human
            review. Review them before completing.
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
