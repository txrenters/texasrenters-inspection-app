'use client';

import { useEffect, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

import { api, apiBlob } from '@/lib/api';
import { usePermissions } from '@/lib/auth';
import {
  useAdminMutations,
  useInspectionFindings,
  useInspectionMedia,
  useInspectionPhotos,
} from '@/lib/queries';
import type { AdminInspectionFinding, AdminInspectionPhoto } from '@texasrenters/shared';

import { Badge, ErrorState, LoadingState, Pagination, formatDate } from './shared';

function formatSeconds(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatCategory(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function RoomVideoPlayer({
  mediaId,
  contentPath,
  label,
  thumbnailUrl,
}: {
  mediaId: string;
  contentPath: string;
  label: string;
  thumbnailUrl?: string | null;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
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
      // Prefer a signed URL straight from the storage CDN: it supports range
      // requests, so reviewers can seek without downloading the whole file.
      // Local-disk storage returns no URL, so fall back to proxied bytes.
      const playback = await api<{ url: string | null }>(
        `/api/v1/admin/media/${mediaId}/playback`,
      ).catch(() => ({ url: null }));
      if (playback.url) {
        setStreamUrl(playback.url);
        return;
      }
      const blob = await apiBlob(contentPath);
      setObjectUrl(URL.createObjectURL(blob));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The video could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  const source = streamUrl ?? objectUrl;
  if (source)
    return (
      <video
        className="room-video-player"
        controls
        preload="metadata"
        poster={thumbnailUrl ?? undefined}
        src={source}
      >
        Your browser cannot play this recording.
      </video>
    );
  return (
    <div className="room-video-placeholder">
      {thumbnailUrl ? (
        // Poster frame so the room is recognisable before loading the video.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="room-video-poster" src={thumbnailUrl} alt={`${label} preview`} />
      ) : null}
      <button
        type="button"
        className={buttonVariants({ variant: 'secondary' })}
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
                  <span
                    className={
                      item.recordingType === 'ADDITIONAL_ISSUE'
                        ? 'recording-type-chip recording-type-chip--extra'
                        : 'recording-type-chip'
                    }
                  >
                    {item.recordingType === 'ADDITIONAL_ISSUE' ? 'Additional' : 'Primary'}
                  </span>
                </div>
                <Badge value={item.uploadStatus} />
              </header>
              {item.recordingType === 'ADDITIONAL_ISSUE' && (item.label || item.category) ? (
                <p className="media-card-label">
                  {item.label}
                  {item.category ? (
                    <span className="media-meta"> · {formatCategory(item.category)}</span>
                  ) : null}
                </p>
              ) : null}
              <RoomVideoPlayer
                mediaId={item.id}
                contentPath={item.contentPath}
                label={item.roomName}
                thumbnailUrl={item.thumbnailUrl}
              />
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

const PHOTO_CAPTURE_LABELS: Record<string, string> = {
  AREA_OVERVIEW: 'Area overview',
  FINDING_DETAIL: 'Finding close-up',
  SUPPORTING_EVIDENCE: 'Supporting',
};

function PhotoThumb({ photo }: { photo: AdminInspectionPhoto }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    void apiBlob(photo.contentPath)
      .then((blob) => {
        if (revoked) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load photo.'));
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [photo.contentPath]);
  return (
    <figure className="inspection-photo">
      {objectUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={objectUrl} alt={photo.label ?? PHOTO_CAPTURE_LABELS[photo.captureType] ?? 'Inspection photo'} />
      ) : error ? (
        <div className="inspection-photo-status">{error}</div>
      ) : (
        <div className="inspection-photo-status">Loading…</div>
      )}
      <figcaption>
        <Badge value={photo.captureType} />
        {photo.label ? <span className="media-meta"> {photo.label}</span> : null}
      </figcaption>
    </figure>
  );
}

export function InspectionPhotosSection({ inspectionId }: { inspectionId: string }) {
  const photos = useInspectionPhotos(inspectionId);
  const byRoom = new Map<string, AdminInspectionPhoto[]>();
  for (const photo of photos.data ?? []) {
    const list = byRoom.get(photo.roomName) ?? [];
    list.push(photo);
    byRoom.set(photo.roomName, list);
  }
  return (
    <section className="panel section-gap inspection-section">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Inspection evidence</span>
          <h2>Area photos</h2>
          <p className="panel-description">
            Overview and close-up snapshots captured by the technician.
          </p>
        </div>
        {!photos.isLoading && !photos.isError ? (
          <span className="section-count">{photos.data?.length ?? 0} photos</span>
        ) : null}
      </div>
      {photos.isLoading ? (
        <LoadingState label="Loading photos…" />
      ) : photos.isError ? (
        <ErrorState error={photos.error} retry={() => void photos.refetch()} />
      ) : photos.data?.length ? (
        <div className="photo-room-groups">
          {[...byRoom.entries()].map(([roomName, roomPhotos]) => (
            <div key={roomName} className="photo-room-group">
              <h3>{roomName}</h3>
              <div className="photo-grid">
                {roomPhotos.map((photo) => (
                  <PhotoThumb key={photo.id} photo={photo} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="inspection-empty-state">
          <div>
            <strong>No photos yet</strong>
            <p>Photos appear here once the technician captures area or finding snapshots.</p>
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
            className={buttonVariants({ variant: 'secondary' })}
            onClick={() => setRejecting(false)}
            disabled={busy}
          >
            Back
          </button>
          <button
            type="button"
            className={buttonVariants({ variant: 'danger' })}
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
        className={buttonVariants({ variant: 'primary' })}
        disabled={busy}
        onClick={() => void approveFinding.mutateAsync({ id: finding.id, inspectionId })}
      >
        {approveFinding.isPending ? 'Approving…' : 'Approve'}
      </button>
      <button
        type="button"
        className={buttonVariants({ variant: 'secondary' })}
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
  const mutation = useAdminMutations().finalizeInspection;
  const [overrideReason, setOverrideReason] = useState('');
  // Finalization is a human-only decision (spec §11). Unresolved required review
  // items block it unless the administrator documents an override.
  const needsOverride = pendingFindings > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutation.mutateAsync({
      id: inspectionId,
      overrideReason: overrideReason.trim() || undefined,
    });
    onClose();
  }

  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize inspection</AlertDialogTitle>
            <AlertDialogDescription>
              Finalizing completes this inspection. It can no longer be edited, assigned, or
              cancelled afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
        {needsOverride ? (
          <p className="field-error">
            {pendingFindings} AI finding{pendingFindings === 1 ? '' : 's'} still await human review.
            Resolve them, or document an override reason to finalize anyway.
          </p>
        ) : null}
        <label className="field">
          <span>Override reason{needsOverride ? '' : ' (optional)'}</span>
          <textarea
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            rows={2}
            placeholder={
              needsOverride
                ? 'Required — explain why the inspection is being finalized with items outstanding'
                : 'Only needed to finalize while items are still outstanding'
            }
          />
        </label>
        {mutation.error ? <p className="field-error">{mutation.error.message}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel type="button" onClick={onClose}>
              Keep open
            </AlertDialogCancel>
            {/* Form submit, not AlertDialogAction: finalizing with outstanding
                findings requires a documented override, and Action would close
                before that validation ran. */}
            <button
              className={buttonVariants({ variant: 'danger' })}
              disabled={mutation.isPending || (needsOverride && !overrideReason.trim())}
            >
              {mutation.isPending ? 'Finalizing…' : 'Finalize inspection'}
            </button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
