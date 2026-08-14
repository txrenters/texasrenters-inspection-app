'use client';

import type { AreaChecklistEntry, AreaFinding, AreaRecording } from '@texasrenters/shared';
import { Maximize2Icon, PlayIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { usePermissions } from '@/lib/auth';
import { formatDateTime, humanize } from '@/lib/format';
import { useAdminMutations, useAreaEvidence } from '@/lib/queries';

import { AreaConditionChecklist } from './AreaConditionChecklist';
import { EvidenceViewer, type EvidenceViewerItem } from './EvidenceViewer';
import { LazyPhoto, captureLabel } from './LazyPhoto';
import { RecordingMarkers } from './RecordingMarkers';
import { RecordingSurface } from './RecordingSurface';

/** A section heading with an optional count. */
function SectionHeading({ children, count }: { children: string; count?: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h4 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
        {children}
      </h4>
      {count ? <Badge variant="secondary">{count}</Badge> : null}
    </div>
  );
}

/**
 * A designed absence rather than a stray grey sentence.
 *
 * "No photos were captured for this area." reads like something went wrong. Most
 * of these states are normal — an area completed on the walkthrough alone, or
 * analysis that has not run yet — so each says what happened and why it is
 * expected, and stays compact instead of leaving a tab looking broken.
 */
function EmptyTab({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{body}</p>
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
 *
 * Playback is delegated to RecordingSurface rather than fetched here. This card
 * used to mint its own URL from `/admin/media/:id/playback` and fall back to
 * downloading `contentPath` as a blob. Both are R2-only: a Stream-backed
 * recording has no bucket object, so the backend answers 409
 * `MEDIA_NOT_PROXYABLE` to each in turn, and the reviewer got that sentence
 * instead of a video. Two implementations of one job is what let this drift.
 */
function RecordingCard({
  recording,
  activeId,
  onActivate,
  onExpand,
  startSeconds,
  inspectionId,
  areaId,
  checklist,
  onSeek,
}: {
  recording: AreaRecording;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onExpand: () => void;
  /** Opens the player at a moment, when arriving from a checklist answer. */
  startSeconds?: number | null;
  inspectionId: string;
  areaId: string;
  /** Items a captured still can be filed against. */
  checklist: AreaChecklistEntry[];
  onSeek: (seconds: number) => void;
}) {
  const active = activeId === recording.id;

  return (
    <article className="space-y-2 rounded-lg border p-3">
      <header className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">
          {recording.recordingType === 'PRIMARY_AREA'
            ? 'Primary recording'
            : recording.label || 'Additional recording'}
        </p>
        <StatusBadge value={recording.processingStatus} />
      </header>

      {active ? (
        <div className="relative">
          <RecordingSurface
            mediaId={recording.id}
            posterUrl={recording.thumbnailUrl}
            startSeconds={startSeconds}
            title={recording.label ?? 'Room recording'}
          />
          <Button
            aria-label="View recording full screen"
            className="absolute top-2 right-2"
            onClick={onExpand}
            size="sm"
            type="button"
            variant="outline"
          >
            <Maximize2Icon />
            Full screen
          </Button>
        </div>
      ) : (
        // Nothing is requested until Play. Mounting a player per recording is
        // what made this page expensive, and that is still true of an iframe.
        <button
          className="group bg-muted focus-visible:ring-ring/50 relative block aspect-video w-full overflow-hidden rounded-lg focus-visible:ring-[3px] focus-visible:outline-none"
          onClick={() => onActivate(recording.id)}
          type="button"
        >
          {recording.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={`Poster frame for ${recording.label ?? 'recording'}`}
              className="size-full object-cover"
              src={recording.thumbnailUrl}
            />
          ) : null}
          <span className="absolute inset-0 grid place-content-center bg-black/40 transition-colors group-hover:bg-black/30">
            <span className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-sm font-medium text-black">
              <PlayIcon className="size-4" />
              Play recording
            </span>
          </span>
        </button>
      )}

      {/* Only while the player is open: the markers are for looking at the
          moment before capturing it, which needs a player to look in. */}
      {active ? (
        <RecordingMarkers
          areaId={areaId}
          checklist={checklist}
          inspectionId={inspectionId}
          markers={recording.frameMarkersMs}
          mediaId={recording.id}
          onSeek={onSeek}
        />
      ) : null}

      <footer className="text-muted-foreground text-xs">
        {formatSeconds(recording.durationSeconds)} · {recording.technicianName} ·{' '}
        {formatDateTime(recording.createdAt)}
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
      <p className="text-muted-foreground text-xs">
        {finding.lastReview.reviewerName} · {formatDateTime(finding.lastReview.createdAt)}
        {finding.lastReview.reason ? ` · ${finding.lastReview.reason}` : ''}
      </p>
    ) : (
      <p className="text-muted-foreground text-xs">Reviewed</p>
    );

  if (rejecting)
    return (
      <div className="grid gap-2">
        <Textarea
          aria-label="Rejection reason"
          maxLength={1000}
          minLength={2}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why is this finding rejected?"
          value={reason}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => setRejecting(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Back
          </Button>
          <Button
            // A reason is mandatory: a rejected finding without one leaves no
            // record of why the AI output was overruled.
            disabled={reason.trim().length < 2 || busy}
            onClick={() =>
              void rejectFinding
                .mutateAsync({ id: finding.id, inspectionId, reason: reason.trim() })
                .then(() => setRejecting(false))
                .catch(() => undefined)
            }
            size="sm"
            type="button"
            variant="destructive"
          >
            {rejectFinding.isPending ? <Spinner /> : null}
            {rejectFinding.isPending ? 'Rejecting…' : 'Confirm reject'}
          </Button>
        </div>
        {rejectFinding.error ? (
          <Alert variant="destructive">
            <AlertDescription>{rejectFinding.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    );

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            void approveFinding.mutateAsync({ id: finding.id, inspectionId }).catch(() => undefined)
          }
          size="sm"
          type="button"
        >
          {approveFinding.isPending ? <Spinner /> : null}
          {approveFinding.isPending ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          disabled={busy}
          onClick={() => setRejecting(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
      {approveFinding.error ? (
        <Alert variant="destructive">
          <AlertDescription>{approveFinding.error.message}</AlertDescription>
        </Alert>
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
    <li className="rounded-lg border">
      <button
        aria-expanded={expanded}
        className="hover:bg-accent/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded text-xs font-semibold tabular-nums">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-medium">{finding.title}</span>
          <span className="text-muted-foreground truncate text-xs">
            {humanize(finding.category).toLowerCase()}
            {finding.photoCount
              ? ` · ${finding.photoCount} photo${finding.photoCount === 1 ? '' : 's'}`
              : ''}
            {finding.recordingId ? ` · video ${formatSeconds(finding.videoTimestampStart)}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge showIcon={false} value={finding.severity} />
          <StatusBadge showIcon={false} value={finding.reviewStatus} />
        </span>
      </button>

      {expanded ? (
        <div className="grid gap-2 border-t p-3">
          <p className="text-sm">{finding.description}</p>
          {finding.baselineCondition ? (
            <p className="text-muted-foreground text-xs">
              At move-in: {finding.baselineCondition}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {humanize(finding.comparisonResult).toLowerCase()} · confidence{' '}
            {Math.round(finding.confidence * 100)}%
          </p>
          {canReview ? (
            <FindingReviewControls finding={finding} inspectionId={inspectionId} />
          ) : finding.lastReview ? (
            <p className="text-muted-foreground text-xs">
              {finding.lastReview.reviewerName} · {formatDateTime(finding.lastReview.createdAt)}
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
  tab,
  onTabChange,
}: {
  inspectionId: string;
  areaId: string;
  /** Controlled by the workspace so it survives switching area. */
  tab: string;
  onTabChange: (tab: string) => void;
}) {
  const evidence = useAreaEvidence(inspectionId, areaId);
  const [activeRecording, setActiveRecording] = useState<string | null>(null);
  /**
   * Where the walkthrough should open, when the reviewer arrives from a
   * checklist answer rather than pressing Play.
   *
   * Held as an object rather than a bare number so that asking for the same
   * second twice still re-seeks: the value is part of the iframe's src, and an
   * unchanged src would leave the player exactly where the reviewer had
   * scrubbed to.
   */
  const [seek, setSeek] = useState<{ seconds: number; nonce: number } | null>(null);
  // Belongs to one area, so it resets when the area does. The panel used to be
  // remounted for this, which threw away the open tab and every other piece of
  // state along with it.
  useEffect(() => {
    setActiveRecording(null);
    setSeek(null);
  }, [areaId]);
  // Reviewing is a privileged decision; reading evidence is not.
  const permissions = usePermissions();
  const canReview = permissions.has('findings:review');
  // Scoring the checklist writes to what the report prints, so it follows the
  // same permission as editing the inspection rather than reviewing findings.
  const canManage = permissions.has('inspections:manage');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // One flat list across recordings and photos, so the arrow keys walk the whole
  // area's evidence rather than stopping at a section boundary.
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
            ? `Primary recording - ${bundle.area.name}`
            : recording.label || `Additional recording - ${bundle.area.name}`,
        caption: `${formatSeconds(recording.durationSeconds)} · ${recording.technicianName} · ${formatDateTime(recording.createdAt)}`,
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

  // An area-level skeleton, never a whole-page loader, so a slow response can
  // never paint over the area the reviewer is looking at.
  if (evidence.isLoading)
    return (
      <div aria-busy="true" aria-live="polite" className="space-y-3" role="status">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-9 w-full max-w-md" />
        <Skeleton className="h-64 rounded-lg" />
        <span className="sr-only">Loading area evidence…</span>
      </div>
    );
  if (evidence.isError)
    return <ErrorState error={evidence.error} retry={() => void evidence.refetch()} />;

  const bundle = evidence.data!;
  const { area, recordings, photoGroups, findings, conditionSummary, checklist } = bundle;
  const photoCount = photoGroups.reduce((sum, group) => sum + group.photos.length, 0);
  // An item counts as assessed once any one axis is answered. Requiring all
  // three would report real work as missing — the printed reports the office
  // issues contain exactly such partial rows.
  const checklistAssessed = checklist.filter(
    (item) => item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null,
  ).length;
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
    <div className="space-y-3">
      <header>
        <h3 className="font-semibold">{area.name}</h3>
        <p className="text-muted-foreground text-xs">
          {area.floorName ?? 'No floor recorded'} · {area.isRequired ? 'Required' : 'Optional'} ·{' '}
          {humanize(area.completionStatus)}
        </p>
      </header>

      {area.skipReason ? (
        <Alert variant="warning">
          <AlertDescription>Skipped - {area.skipReason}</AlertDescription>
        </Alert>
      ) : null}

      {/* Tabs rather than four stacked sections. Everything used to render at
          once, so a reviewer scrolled past photos and findings to reach the
          walkthrough and lost their place moving between areas. Each tab carries
          its own count, so what is behind it is visible without opening it.

          Checklist and Activity are absent deliberately: the evidence bundle
          carries neither, and a tab that opens onto nothing is worse than no
          tab. Checklist lives in a dialog on the area list. */}
      <Tabs onValueChange={onTabChange} value={tab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="recording">
            Recording{recordings.length ? ` (${recordings.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="photos">Photos{photoCount ? ` (${photoCount})` : ''}</TabsTrigger>
          <TabsTrigger value="findings">
            Findings{findings.length ? ` (${findings.length})` : ''}
          </TabsTrigger>
          {/* Its own tab rather than a section under Overview: scoring is a task
              the reviewer works through item by item, and it needs the width. */}
          <TabsTrigger value="condition">
            Condition{checklist.length ? ` (${checklistAssessed}/${checklist.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent className="space-y-4" value="overview">
          {conditionSummary ? (
            <section>
              <SectionHeading>Condition summary</SectionHeading>
              <p className="text-sm">{conditionSummary.description}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Overall context - the Findings tab lists the specific work.
              </p>
            </section>
          ) : (
            <EmptyTab
              body="A summary is written once the recording has been transcribed and analysed."
              title="No condition summary yet"
            />
          )}

          {/* The counts a reviewer would otherwise have to open each tab to
              learn. */}
          <dl className="grid grid-cols-3 gap-2">
            {[
              { label: 'Recordings', value: recordings.length },
              { label: 'Photos', value: photoCount },
              { label: 'Findings', value: findings.length },
            ].map((item) => (
              <div className="bg-muted/50 rounded-lg p-3" key={item.label}>
                <dt className="text-muted-foreground text-xs">{item.label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
        </TabsContent>

        <TabsContent className="space-y-4" value="recording">
          {recordings.length ? (
            <>
              {/* The primary walkthrough gets the full panel width. Every
                  recording used to share one auto-fill grid, so the single video
                  most areas have rendered as a 260px card marooned in a wide
                  panel — the evidence a reviewer came to watch, shown smaller
                  than the photos beside it. Additional clips keep the grid. */}
              {primaryRecording ? (
                <RecordingCard
                  activeId={activeRecording}
                  key={`${primaryRecording.id}-${seek?.nonce ?? 0}`}
                  onActivate={setActiveRecording}
                  onExpand={() =>
                    setViewerIndex(
                      viewerItems.findIndex((entry) => entry.id === primaryRecording.id),
                    )
                  }
                  areaId={bundle.area.id}
                  checklist={bundle.checklist}
                  inspectionId={inspectionId}
                  onSeek={(seconds) => {
                    setActiveRecording(primaryRecording.id);
                    setSeek((current) => ({ seconds, nonce: (current?.nonce ?? 0) + 1 }));
                  }}
                  recording={primaryRecording}
                  startSeconds={seek?.seconds ?? null}
                />
              ) : null}
              {additionalRecordings.length ? (
                <div>
                  {primaryRecording ? (
                    <SectionHeading count={additionalRecordings.length}>
                      Additional clips
                    </SectionHeading>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    {additionalRecordings.map((recording) => (
                      <RecordingCard
                        activeId={activeRecording}
                        key={recording.id}
                        onActivate={setActiveRecording}
                        onExpand={() =>
                          setViewerIndex(
                            viewerItems.findIndex((entry) => entry.id === recording.id),
                          )
                        }
                        areaId={bundle.area.id}
                        checklist={bundle.checklist}
                        inspectionId={inspectionId}
                        onSeek={(seconds) => {
                          setActiveRecording(recording.id);
                          setSeek((current) => ({ seconds, nonce: (current?.nonce ?? 0) + 1 }));
                        }}
                        recording={recording}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyTab
              body="This area was completed without a video walkthrough."
              title="No walkthrough recorded"
            />
          )}
        </TabsContent>

        <TabsContent className="space-y-4" value="photos">
          {photoGroups.length ? (
            photoGroups.map((group) => (
              <div key={`${group.key}-${group.findingId ?? 'area'}`}>
                <SectionHeading count={group.photos.length}>
                  {group.findingId ? `${group.label} · finding evidence` : group.label}
                </SectionHeading>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {group.photos.map((photo) => (
                    <LazyPhoto
                      areaName={area.name}
                      key={photo.id}
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
              body="The technician completed this area using the primary walkthrough only."
              title="No supporting photos"
            />
          )}
        </TabsContent>

        <TabsContent value="findings">
          {findings.length ? (
            <ol className="grid gap-2">
              {findings.map((finding, index) => (
                <FindingRow
                  canReview={canReview}
                  finding={finding}
                  index={index}
                  inspectionId={inspectionId}
                  key={finding.id}
                />
              ))}
            </ol>
          ) : (
            <EmptyTab
              body={
                recordings.length || photoGroups.length
                  ? 'No damage or maintenance issues were identified for this area.'
                  : 'Findings appear once the walkthrough has been transcribed and analysed.'
              }
              title={
                recordings.length || photoGroups.length
                  ? 'No findings reported'
                  : 'Analysis has not run yet'
              }
            />
          )}
        </TabsContent>

        <TabsContent value="condition">
          <AreaConditionChecklist
            areaId={areaId}
            canReview={canManage}
            checklist={checklist}
            inspectionId={inspectionId}
            onSeek={
              // Only offered when there is a walkthrough to seek: without one
              // the link would switch tabs to a player that never appears.
              primaryRecording
                ? (seconds) => {
                    setActiveRecording(primaryRecording.id);
                    setSeek((current) => ({ seconds, nonce: (current?.nonce ?? 0) + 1 }));
                    onTabChange('recording');
                  }
                : undefined
            }
            readOnlyReason={
              !canManage ? 'Read-only - you cannot change this inspection' : undefined
            }
          />
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
