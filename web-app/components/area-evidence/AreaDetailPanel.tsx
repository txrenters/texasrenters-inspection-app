'use client';

import type { AreaFinding, AreaRecording } from '@texasrenters/shared';
import { useMemo, useState } from 'react';

import { FieldError } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, apiBlob } from '@/lib/api';
import { useAdminMutations, useAreaEvidence } from '@/lib/queries';
import { usePermissions } from '@/lib/auth';
import { buttonVariants } from '@/components/ui/button';
import { Maximize2 } from 'lucide-react';

import { Badge, ErrorState, formatDate } from '../shared';

import { EvidenceViewer, type EvidenceViewerItem } from './EvidenceViewer';
import { LazyPhoto, captureLabel } from './LazyPhoto';

/**
 * A section heading with an optional count.
 *
 * The old markup used bare <h4>/<h5> with a hairline rule, which Preflight's
 * absence left at browser-default sizing — "Recordings" and the area title
 * rendered at nearly the same weight, so the panel read as one flat list.
 */
function SectionHeading({ children, count }: { children: string; count?: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h4 className="m-0 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </h4>
      {count ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A designed absence rather than a stray grey sentence.
 *
 * "No photos were captured for this area." reads like something went wrong.
 * Most of these states are normal — an area completed on the walkthrough alone,
 * or analysis that has not run yet — so each says what happened and why it is
 * expected, and stays compact instead of leaving a tab looking broken.
 */
function EmptyTab({ title, body }: { title: string; body: string }) {
  return (
    <div className="area-empty-tab">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

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
  onExpand,
}: {
  recording: AreaRecording;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onExpand: () => void;
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
        <div className="relative">
          <video
            controls
            autoPlay
            className="area-recording-player"
            poster={recording.thumbnailUrl ?? undefined}
            src={source ?? objectUrl ?? undefined}
          />
          <button
            aria-label="View recording full screen"
            className={`${buttonVariants({ variant: 'secondary', size: 'small' })} absolute right-2 top-2`}
            onClick={onExpand}
            type="button"
          >
            <Maximize2 aria-hidden className="size-3.5" />
            Full screen
          </button>
        </div>
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
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // One flat list across recordings and photos, so the arrow keys walk the
  // whole area's evidence rather than stopping at a section boundary.
  const viewerItems = useMemo<EvidenceViewerItem[]>(() => {
    const bundle = evidence.data;
    if (!bundle) return [];
    return [
      ...bundle.recordings.map((recording) => ({
        id: recording.id,
        kind: 'recording' as const,
        contentPath: recording.contentPath,
        title:
          recording.recordingType === 'PRIMARY_AREA'
            ? `Primary recording — ${bundle.area.name}`
            : recording.label || `Additional recording — ${bundle.area.name}`,
        caption: `${formatSeconds(recording.durationSeconds)} · ${recording.technicianName} · ${formatDate(recording.createdAt)}`,
        posterUrl: recording.thumbnailUrl,
      })),
      ...bundle.photoGroups.flatMap((group) =>
        group.photos.map((photo) => ({
          id: photo.id,
          kind: 'photo' as const,
          contentPath: photo.contentPath,
          title: photo.label || captureLabel(photo.captureType),
          caption: `${bundle.area.name} · ${group.label}`,
        })),
      ),
    ];
  }, [evidence.data]);

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
  const photoCount = photoGroups.reduce((sum, group) => sum + group.photos.length, 0);
  // The required walkthrough, separated so it can be shown at full width. An
  // area should only ever have one; `find` takes the first if data says
  // otherwise rather than rendering two full-width players.
  const primaryRecording = recordings.find(
    (recording) => recording.recordingType === 'PRIMARY_AREA',
  );
  const additionalRecordings = recordings.filter(
    (recording) => recording.id !== primaryRecording?.id,
  );

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

      {/* Tabs rather than four stacked sections.
          Everything used to render at once, so a reviewer scrolled past photos
          and findings to reach the walkthrough and lost their place moving
          between areas. Each tab carries its own count, so what is behind it is
          visible without opening it.

          Checklist and Activity are absent deliberately: the evidence bundle
          carries neither, and a tab that opens onto nothing is worse than no
          tab. Checklist currently lives in a dialog on the area list. */}
      <Tabs className="mt-4" defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="recording">Recording{recordings.length ? ` (${recordings.length})` : ''}</TabsTrigger>
          <TabsTrigger value="photos">Photos{photoCount ? ` (${photoCount})` : ''}</TabsTrigger>
          <TabsTrigger value="findings">Findings{findings.length ? ` (${findings.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          {conditionSummary ? (
            <section>
              <SectionHeading>Condition summary</SectionHeading>
              <p>{conditionSummary.description}</p>
              <span className="text-[13px] text-muted-foreground">
                Overall context — the Findings tab lists the specific work.
              </span>
            </section>
          ) : (
            <EmptyTab
              title="No condition summary yet"
              body="A summary is written once the recording has been transcribed and analysed."
            />
          )}
          {/* The counts a reviewer would otherwise have to open each tab to
              learn. */}
          <dl className="area-evidence-counts">
            <div>
              <dt>Recordings</dt>
              <dd>{recordings.length}</dd>
            </div>
            <div>
              <dt>Photos</dt>
              <dd>{photoCount}</dd>
            </div>
            <div>
              <dt>Findings</dt>
              <dd>{findings.length}</dd>
            </div>
          </dl>
        </TabsContent>

        <TabsContent value="recording">
        {recordings.length ? (
          <>
            {/* The primary walkthrough gets the full panel width. Every
                recording used to share one auto-fill grid, so the single video
                most areas have rendered as a 260px card marooned in a wide
                panel — the evidence a reviewer came to watch, shown smaller
                than the photos beside it. Additional clips keep the grid. */}
            {primaryRecording ? (
              <div className="area-recording-primary">
                <RecordingCard
                  activeId={activeRecording}
                  onActivate={setActiveRecording}
                  onExpand={() =>
                    setViewerIndex(
                      viewerItems.findIndex((entry) => entry.id === primaryRecording.id),
                    )
                  }
                  recording={primaryRecording}
                />
              </div>
            ) : null}
            {additionalRecordings.length ? (
              <>
                {primaryRecording ? (
                  <SectionHeading count={additionalRecordings.length}>
                    Additional clips
                  </SectionHeading>
                ) : null}
                <div className="area-recording-list">
                  {additionalRecordings.map((recording) => (
                    <RecordingCard
                      key={recording.id}
                      activeId={activeRecording}
                      onActivate={setActiveRecording}
                      onExpand={() =>
                        setViewerIndex(viewerItems.findIndex((entry) => entry.id === recording.id))
                      }
                      recording={recording}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <EmptyTab
            title="No walkthrough recorded"
            body="This area was completed without a video walkthrough."
          />
        )}
        </TabsContent>

        <TabsContent value="photos">
        {photoGroups.length ? (
          photoGroups.map((group) => (
            <div key={`${group.key}-${group.findingId ?? 'area'}`} className="area-photo-group">
              <h5 className="mb-2 mt-0 text-xs font-semibold text-foreground">
                {group.label}
                {group.findingId ? <span className="text-[13px] text-muted-foreground"> · finding evidence</span> : null}
              </h5>
              <div className="area-photo-grid">
                {group.photos.map((photo) => (
                  <LazyPhoto
                    key={photo.id}
                    areaName={area.name}
                    onOpen={() =>
                      setViewerIndex(viewerItems.findIndex((entry) => entry.id === photo.id))
                    }
                    photo={photo}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          <EmptyTab
            title="No supporting photos"
            body="The technician completed this area using the primary walkthrough only."
          />
        )}
        </TabsContent>

        <TabsContent value="findings">
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
          <EmptyTab
            title={
              recordings.length || photoGroups.length
                ? 'No findings reported'
                : 'Analysis has not run yet'
            }
            body={
              recordings.length || photoGroups.length
                ? 'No damage or maintenance issues were identified for this area.'
                : 'Findings appear once the walkthrough has been transcribed and analysed.'
            }
          />
        )}
        </TabsContent>
      </Tabs>

      {viewerIndex !== null && viewerIndex >= 0 ? (
        <EvidenceViewer
          items={viewerItems}
          onClose={() => setViewerIndex(null)}
          startIndex={viewerIndex}
        />
      ) : null}
    </div>
  );
}

export { captureLabel };
