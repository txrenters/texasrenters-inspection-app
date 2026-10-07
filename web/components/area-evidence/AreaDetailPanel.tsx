'use client';

import type { AreaChecklistEntry, AreaPhoto, AreaRecording } from '@texasrenters/shared';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ListChecksIcon,
  Maximize2Icon,
  PlayIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AreaChecklistDialog } from '@/components/area-checklist/AreaChecklistDialog';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { findingMoment, formatSeconds, nextPending } from '@/lib/finding-review';
import { formatDateTime, humanize } from '@/lib/format';
import { useAreaEvidence } from '@/lib/queries';
import { cn } from '@/lib/utils';

import { areaPhotoItems } from './area-photos';
import { AreaConditionChecklist, isChecklistItemAssessed } from './AreaConditionChecklist';
import { AreaReviewControl } from './AreaReviewControl';
import { EvidenceViewer, type EvidenceViewerItem } from './EvidenceViewer';
import { FindingsReview } from './FindingsReview';
import { LazyPhoto, captureLabel } from './LazyPhoto';
import { ReanalyzeControl, ReanalyzeStatus, canReanalyze } from './ReanalyzeControl';
import { RecordingSummaryCard } from './RecordingSummaryCard';
import { RecordingTranscript } from './RecordingTranscript';
import { RecordingMarkers } from './RecordingMarkers';
import { RecordingSurface, recordingFrame } from './RecordingSurface';

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
  reanalyze,
  findingMarks = [],
}: {
  recording: AreaRecording;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onExpand: () => void;
  /**
   * Opens the player at a moment: a finding, a checklist answer, a marker. It
   * then plays at once, since the reviewer asked for that moment.
   */
  startSeconds?: number | null;
  inspectionId: string;
  areaId: string;
  /** Items a captured still can be filed against. */
  checklist: AreaChecklistEntry[];
  onSeek: (seconds: number) => void;
  /** Offered to a reviewer: see `ReanalyzeControl`. */
  reanalyze?: { pendingFindings: number } | null;
  /** This recording's findings that have a moment, to jump to from under it. */
  findingMarks?: Array<{ id: string; title: string; start: number }>;
}) {
  const active = activeId === recording.id;
  const portrait = isPortrait(recording);

  return (
    <article className="space-y-2 rounded-lg border p-3">
      {/* Wraps rather than truncating the name: beside the findings the card
          is narrow, and "Primary …" told the reviewer nothing. */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">
          {recording.recordingType === 'PRIMARY_AREA'
            ? 'Primary recording'
            : recording.label || 'Additional recording'}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {reanalyze && canReanalyze(recording) ? (
            <ReanalyzeControl
              areaId={areaId}
              inspectionId={inspectionId}
              pendingFindings={reanalyze.pendingFindings}
              recording={recording}
            />
          ) : null}
          <StatusBadge value={recording.processingStatus} />
        </div>
      </header>
      {reanalyze ? <ReanalyzeStatus recording={recording} /> : null}

      {active ? (
        <div className="relative">
          <RecordingSurface
            autoplay={startSeconds != null}
            mediaId={recording.id}
            portrait={portrait}
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
          className={cn(
            'group bg-muted focus-visible:ring-ring/50 relative block overflow-hidden rounded-lg focus-visible:ring-[3px] focus-visible:outline-none',
            recordingFrame(portrait),
          )}
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

      {/* Where the AI placed each finding in this recording. Shown whether or
          not the player is open: choosing one opens it there. */}
      {findingMarks.length ? (
        <div className="grid gap-1.5">
          <p className="text-muted-foreground text-xs">Findings in this recording</p>
          <ul className="flex flex-wrap gap-1.5">
            {findingMarks.map((mark) => (
              <li key={mark.id}>
                <Button
                  className="h-7 max-w-64 text-xs"
                  onClick={() => onSeek(mark.start)}
                  size="sm"
                  title={mark.title}
                  type="button"
                  variant="outline"
                >
                  <PlayIcon aria-hidden />
                  <span className="tabular-nums">{formatSeconds(mark.start)}</span>
                  <span className="truncate">{mark.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="text-muted-foreground text-xs">
        {formatSeconds(recording.durationSeconds)} · {recording.technicianName} ·{' '}
        {formatDateTime(recording.createdAt)}
      </footer>
    </article>
  );
}

/** Filmed upright, by Cloudflare's measure. Unknown sizes are treated as landscape. */
function isPortrait(recording: AreaRecording) {
  return Boolean(recording.widthPx && recording.heightPx && recording.heightPx > recording.widthPx);
}

export function AreaDetailPanel({
  inspectionId,
  areaId,
  tab,
  onTabChange,
  onOpenPhoto,
  stepping,
}: {
  inspectionId: string;
  areaId: string;
  /** Controlled by the workspace so it survives switching area. */
  tab: string;
  onTabChange: (tab: string) => void;
  /**
   * Opens a photograph in the viewer that walks on into the next area. The
   * workspace supplies it because it holds the area order; without it the
   * photograph opens in this area's own viewer.
   */
  onOpenPhoto?: (photoId: string) => void;
  /**
   * The neighbouring areas in the list, so a reviewer can move on from the one
   * they have just marked without going back to the list.
   */
  stepping?: { previous: boolean; next: boolean; onStep: (direction: 1 | -1) => void };
}) {
  const evidence = useAreaEvidence(inspectionId, areaId);
  /**
   * Finalized or not, the findings stay the office's to decide (2026-10-03).
   * Finalizing -- like the technician ending the job -- closes the visit: its
   * Jobber completion and the technician's paid time. Reviewing the AI's
   * findings for the reports and the move-in comparison comes after, and
   * reopening to get at it would undo both. What finalization still freezes is
   * what was captured: the checklist answers (the Condition tab) and the rooms.
   */
  const [activeRecording, setActiveRecording] = useState<string | null>(null);
  /**
   * Where a recording should open, when the reviewer arrives from a finding,
   * a checklist answer or a marker rather than pressing Play.
   *
   * Held as an object rather than a bare number so that asking for the same
   * second twice still re-seeks: the value is part of the iframe's src, and an
   * unchanged src would leave the player exactly where the reviewer had
   * scrubbed to. It names its recording: as a bare second it applied to the
   * walkthrough only, so a marker on an additional clip opened that clip at
   * 0:00.
   */
  const [seek, setSeek] = useState<{ recordingId: string; seconds: number; nonce: number } | null>(
    null,
  );
  /** The finding open in the Findings tab, whose moment the player shows. */
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  // Belongs to one area, so it resets when the area does. The panel used to be
  // remounted for this, which threw away the open tab and every other piece of
  // state along with it.
  useEffect(() => {
    setActiveRecording(null);
    setSeek(null);
    setSelectedFinding(null);
  }, [areaId]);
  /** Open a recording at a moment, and play it from there. */
  const seekTo = (recordingId: string, seconds: number) => {
    setActiveRecording(recordingId);
    setSeek((current) => ({ recordingId, seconds, nonce: (current?.nonce ?? 0) + 1 }));
  };
  // Reviewing is a privileged decision; reading evidence is not.
  const permissions = usePermissions();
  const canReview = permissions.has('findings:review');
  // Scoring the checklist writes to what the report prints, so it follows the
  // same permission as editing the inspection rather than reviewing findings.
  const canManage = permissions.has('inspections:manage');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [editingTemplate, setEditingTemplate] = useState(false);

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
        // Full screen opens at the moment the reviewer was watching, not 0:00.
        startSeconds: seek?.recordingId === recording.id ? seek.seconds : null,
      })),
      ...areaPhotoItems(bundle).map((photo) => ({
        ...photo,
        caption: `${bundle.area.name} · ${photo.caption}`,
      })),
    ];
  }, [evidence.data, seek]);

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
  // The panel's own rule, so the tab cannot disagree with it: an occupied
  // room's answers are not axes, and counting only axes read "0/2" over "2 of 2".
  const checklistAssessed = checklist.filter(isChecklistItemAssessed).length;
  // The required walkthrough, separated so it can be shown at full width. An
  // area should only ever have one; `find` takes the first if data says
  // otherwise rather than rendering two full-width players.
  const primaryRecording = recordings.find(
    (recording) => recording.recordingType === 'PRIMARY_AREA',
  );
  const additionalRecordings = recordings.filter(
    (recording) => recording.id !== primaryRecording?.id,
  );
  // Where the AI placed each finding, per recording, for the chips under it.
  const findingMarksFor = (recording: AreaRecording) =>
    findings.flatMap((finding) => {
      const moment = findingMoment(finding);
      return moment?.recordingId === recording.id
        ? [{ id: finding.id, title: finding.title, start: moment.start }]
        : [];
    }).sort((left, right) => left.start - right.start);
  // Each finding's own photographs, shown with it in the review.
  const photosByFinding = new Map<string, AreaPhoto[]>(
    photoGroups.flatMap((group) => (group.findingId ? [[group.findingId, group.photos]] : [])),
  );
  /** Choosing a finding plays its moment; see `FindingsReview`. */
  const selectFinding = (findingId: string | null) => {
    setSelectedFinding(findingId);
    const finding = findings.find((entry) => entry.id === findingId);
    const moment = finding ? findingMoment(finding) : null;
    if (moment) seekTo(moment.recordingId, moment.start);
  };
  // The recording the Findings tab plays: the one asked for, else the open
  // finding's, else the walkthrough.
  const selected = findings.find((finding) => finding.id === selectedFinding);
  const reviewRecording =
    recordings.find((recording) => recording.id === seek?.recordingId) ??
    recordings.find((recording) => recording.id === selected?.recordingId) ??
    primaryRecording ??
    recordings[0];
  // A reviewer's, finalized or not: a re-run writes findings, never the
  // inspection's status.
  const reanalyzeFor = (recording: AreaRecording) =>
    canReview
      ? {
          pendingFindings: findings.filter(
            (finding) =>
              finding.recordingId === recording.id && finding.reviewStatus === 'PENDING_REVIEW',
          ).length,
        }
      : null;
  // Each finding's stretch of a recording, to mark the lines it was written from.
  const findingSpansFor = (recording: AreaRecording) =>
    findings.flatMap((finding) => {
      const moment = findingMoment(finding);
      return moment?.recordingId === recording.id
        ? [{ id: finding.id, title: finding.title, start: moment.start, end: moment.end }]
        : [];
    });
  /** One recording on the Recording tab: the video, and its transcript beside it. */
  const renderRecording = (recording: AreaRecording) => (
    <div
      className="grid gap-4 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @3xl:items-start"
      key={recording.id}
    >
      <RecordingCard
        activeId={activeRecording}
        areaId={bundle.area.id}
        checklist={bundle.checklist}
        findingMarks={findingMarksFor(recording)}
        inspectionId={inspectionId}
        key={`${recording.id}-${seek?.recordingId === recording.id ? seek.nonce : 0}`}
        onActivate={setActiveRecording}
        onExpand={() => setViewerIndex(viewerItems.findIndex((entry) => entry.id === recording.id))}
        onSeek={(seconds) => seekTo(recording.id, seconds)}
        reanalyze={reanalyzeFor(recording)}
        recording={recording}
        startSeconds={seek?.recordingId === recording.id ? seek.seconds : null}
      />
      <RecordingTranscript
        className="max-h-96 @3xl:sticky @3xl:top-[calc(var(--app-header-height)+0.75rem)] @3xl:max-h-[min(75vh,44rem)]"
        findings={findingSpansFor(recording)}
        mediaId={recording.id}
        onSeek={(seconds) => seekTo(recording.id, seconds)}
        playingSecond={seek?.recordingId === recording.id ? seek.seconds : null}
      />
    </div>
  );

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{area.name}</h3>
          <p className="text-muted-foreground text-xs">
            {/* The floor when there is one. "No floor recorded" on every
                single-storey house said nothing a reviewer could act on. */}
            {[area.floorName, area.isRequired ? 'Required' : 'Optional', humanize(area.completionStatus)]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex items-start gap-2">
          <AreaReviewControl
            bundle={bundle}
            canReview={canReview}
            inspectionId={inspectionId}
          />
          {stepping ? (
            <div className="flex gap-1">
              <Button
                aria-label="Previous area"
                disabled={!stepping.previous}
                onClick={() => stepping.onStep(-1)}
                size="icon"
                type="button"
                variant="outline"
              >
                <ChevronLeftIcon aria-hidden />
              </Button>
              <Button
                aria-label="Next area"
                disabled={!stepping.next}
                onClick={() => stepping.onStep(1)}
                size="icon"
                type="button"
                variant="outline"
              >
                <ChevronRightIcon aria-hidden />
              </Button>
            </div>
          ) : null}
        </div>
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
          ) : recordings.length ? (
            <EmptyTab
              body="A summary is written once the recording has been transcribed and analysed."
              title="No condition summary yet"
            />
          ) : (
            // Not "yet": with no recording there is nothing to transcribe, and
            // an occupied visit -- photographed, not filmed -- never has one.
            // Promising a summary that will not come read as a stalled job.
            <EmptyTab
              body="Condition summaries are written from the walkthrough video, and this area has none. Its photographs and the Condition tab are the record."
              title="No recording to summarise"
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

        <TabsContent className="@container space-y-6" value="recording">
          {recordings.length ? (
            <>
              {/* The video on the left and the narration word for word on the
                  right (the office, 2026-10-06): reviewing meant listening
                  through the walkthrough to hear what was said about each
                  finding. A line plays the recording from there; the lines a
                  finding was written from carry its title. Side by side once the
                  panel is wide enough, the transcript under the video otherwise.
                  The primary walkthrough first; each additional clip the same. */}
              {primaryRecording ? renderRecording(primaryRecording) : null}
              {additionalRecordings.length ? (
                <div className="space-y-4">
                  {primaryRecording ? (
                    <SectionHeading count={additionalRecordings.length}>
                      Additional clips
                    </SectionHeading>
                  ) : null}
                  {additionalRecordings.map(renderRecording)}
                </div>
              ) : null}
              {/* What the report prints under the room's photographs. */}
              <RecordingSummaryCard
                areaId={areaId}
                canManage={canManage}
                inspectionId={inspectionId}
                onSeek={
                  primaryRecording
                    ? (seconds) => seekTo(primaryRecording.id, seconds)
                    : undefined
                }
                summary={bundle.recordingSummary}
              />
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
                        onOpenPhoto
                          ? onOpenPhoto(photo.id)
                          : setViewerIndex(viewerItems.findIndex((entry) => entry.id === photo.id))
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

        <TabsContent className="@container" value="findings">
          {/* With no findings yet, still shown to someone who can add one the
              AI missed: that is exactly the room it missed something in. */}
          {findings.length || (canReview && recordings.length) ? (
            // Side by side once the panel is wide enough for both, the player
            // held in view while the list scrolls; stacked, player first,
            // otherwise -- and kept to about half the window there, since a
            // portrait walkthrough at full size pushed every finding below it.
            <div className="grid gap-4 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div className="@max-2xl:mx-auto @max-2xl:w-full @max-2xl:max-w-[30vh] @2xl:sticky @2xl:top-[calc(var(--app-header-height)+0.75rem)] @2xl:self-start">
                {reviewRecording ? (
                  <RecordingCard
                    activeId={activeRecording}
                    areaId={bundle.area.id}
                    checklist={bundle.checklist}
                    inspectionId={inspectionId}
                    key={`review-${reviewRecording.id}-${seek?.recordingId === reviewRecording.id ? seek.nonce : 0}`}
                    onActivate={setActiveRecording}
                    onExpand={() =>
                      setViewerIndex(
                        viewerItems.findIndex((entry) => entry.id === reviewRecording.id),
                      )
                    }
                    onSeek={(seconds) => seekTo(reviewRecording.id, seconds)}
                    // Here too: the findings it replaces are the ones beside it.
                    reanalyze={reanalyzeFor(reviewRecording)}
                    recording={reviewRecording}
                    startSeconds={seek?.recordingId === reviewRecording.id ? seek.seconds : null}
                  />
                ) : (
                  <EmptyTab
                    body="These findings came without a recording to play."
                    title="No walkthrough recorded"
                  />
                )}
              </div>
              <FindingsReview
                areaId={bundle.area.id}
                areaName={area.name}
                // Open after finalization too: the stills filed here are the
                // findings' own, and the server allows exactly those.
                canCapture={canManage}
                canReview={canReview}
                findings={findings}
                inspectionId={inspectionId}
                onDecided={(findingId) => selectFinding(nextPending(findings, findingId)?.id ?? null)}
                onOpenPhoto={
                  onOpenPhoto ??
                  ((photoId) =>
                    setViewerIndex(viewerItems.findIndex((entry) => entry.id === photoId)))
                }
                onSeek={seekTo}
                onSelect={selectFinding}
                photosByFinding={photosByFinding}
                playing={
                  reviewRecording
                    ? {
                        recordingId: reviewRecording.id,
                        seconds: seek?.recordingId === reviewRecording.id ? seek.seconds : null,
                      }
                    : null
                }
                recordings={recordings}
                selectedId={selectedFinding}
              />
            </div>
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

        <TabsContent className="space-y-2" value="condition">
          {/* The property's checklist template, under its own name. It used to
              open from the "Checklist · 2/7" progress under each area in the
              list -- a reviewer clicking their scoring progress landed in an
              editor that changes what every future visit to this property asks. */}
          {canManage ? (
            <div className="flex justify-end">
              <Button
                onClick={() => setEditingTemplate(true)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <ListChecksIcon aria-hidden />
                Edit checklist template
              </Button>
            </div>
          ) : null}
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
                    seekTo(primaryRecording.id, seconds);
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

      {editingTemplate ? (
        <AreaChecklistDialog
          areaId={area.propertyAreaId}
          areaName={area.name}
          onOpenChange={(open) => {
            if (!open) setEditingTemplate(false);
          }}
          open
        />
      ) : null}

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
