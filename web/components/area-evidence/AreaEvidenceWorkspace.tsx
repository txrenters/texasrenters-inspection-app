'use client';

import {
  inspectionIsWalkedAsOccupied,
  inspectionRequiresAreaRecording,
  type AreaEvidenceSummaryItem,
} from '@texasrenters/shared';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ImportReportDialog, useImportInProgress } from '@/components/inspection-report-import';
import { AddAreasDialog, MergeAreasDialog } from '@/components/inspection-workflow';
import { SelectFilter } from '@/components/list-toolbar';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import { usePermissions } from '@/lib/auth';
import { useAreaEvidenceSummary, useInspection, useInspectionAreas } from '@/lib/queries';
import { cn } from '@/lib/utils';

import { STATUS_META } from './area-status';
import { AreaDetailPanel } from './AreaDetailPanel';
import { AreaPhotoViewer } from './AreaPhotoViewer';
import { PhotoSheet } from './PhotoSheet';

/**
 * Area-first inspection evidence.
 *
 * Replaces four page-wide sections (recordings, photos, summaries, findings)
 * that each fetched the whole inspection and forced reviewers to correlate one
 * room's evidence across four scroll positions. The list carries counts and
 * status only; a single area's evidence loads when it is opened.
 */

/**
 * Radix Select throws on an empty-string item value, which silently left the
 * trigger blank — the filter looked broken because it *was*. ALL is a sentinel
 * mapped back to "no filter" at the call site.
 */
const ALL_STATUSES = 'ALL';

const STATUS_FILTERS = [
  { value: 'FINDINGS_NEED_REVIEW', label: 'Needs review' },
  { value: 'EVIDENCE_INCOMPLETE', label: 'Incomplete' },
  { value: 'SKIPPED', label: 'Skipped' },
  { value: 'NOT_STARTED', label: 'Not started' },
  { value: 'REVIEWED', label: 'Reviewed' },
] as const;

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Whether anybody has recorded anything against this inspection.
 *
 * This chooses what the import dialog *says*, not whether it is offered -- an
 * import is offered on every inspection, because it replaces what it finds.
 * Warning first is the whole difference between a replacement and an accident.
 *
 * Areas are deliberately not counted. An inspection is created with its
 * property's approved layout snapshotted onto it, so an area says a plan
 * exists -- not that somebody walked the property.
 */
function hasEvidence(item: {
  evidence?: { photos: number; findings: number; media?: number; responses?: number };
}) {
  const evidence = item.evidence;
  // Absent rather than zero: an older API that does not send this should not
  // be read as "nothing here", which would promise a clean import over a
  // walkthrough it is about to overwrite.
  if (!evidence) return true;
  return (
    evidence.photos > 0 ||
    evidence.findings > 0 ||
    (evidence.media ?? 0) > 0 ||
    (evidence.responses ?? 0) > 0
  );
}

/** Spoken description of an area, so the list is usable without the visuals. */
function areaAriaLabel(area: AreaEvidenceSummaryItem) {
  const parts = [
    area.name,
    area.floorName ?? '',
    countLabel(area.counts.recordings, 'recording'),
    countLabel(area.counts.photos, 'photo'),
    countLabel(area.counts.findings, 'finding'),
    // Said here now that it is part of the row rather than a button of its own.
    area.checklistItemCount
      ? `Checklist ${area.checklistAssessedCount} of ${area.checklistItemCount} assessed`
      : '',
  ].filter(Boolean);
  const review = area.counts.unreviewedFindings
    ? `${countLabel(area.counts.unreviewedFindings, 'finding')} require review.`
    : `${STATUS_META[area.reviewStatus].label}.`;
  // Announced as part of the status, so the reason is not sighted-only.
  const reason = area.skipReason ? ` Reason: ${area.skipReason}.` : '';
  return `${parts.join('. ')}. ${review}${reason}`;
}

export function AreaEvidenceWorkspace({ inspectionId }: { inspectionId: string }) {
  const summary = useAreaEvidenceSummary(inspectionId);
  // A second read of the same areas, in the shape the merge dialog needs. The
  // evidence summary carries review state the dialog does not use, and the
  // dialog needs floor/environment detail the summary does not carry.
  const manageableAreas = useInspectionAreas(inspectionId).data ?? [];
  const canMerge = usePermissions().has('inspections:manage');
  const [merging, setMerging] = useState(false);
  // The property and unit the add dialog chooses areas from, and the type it
  // warns about. Already cached by the page around this card, so this is a read
  // of the same query rather than a second request.
  const inspection = useInspection(inspectionId).data;
  const [addingAreas, setAddingAreas] = useState(false);
  // Opened from the "Manage areas" menu, so held here rather than in the
  // dialog's own button (console-development).
  const [importing, setImporting] = useState(false);
  const importRunning = useImportInProgress(canMerge ? inspectionId : null);
  const router = useRouter();
  const searchParams = useSearchParams();
  // The open area lives in the URL so refresh restores it, Back steps through
  // areas, and a reviewer can send a colleague straight to one room.
  const selectedFromUrl = searchParams.get('area');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);

  const areas = useMemo(() => summary.data?.areas ?? [], [summary.data?.areas]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return areas.filter((area) => {
      if (statusFilter !== ALL_STATUSES && area.reviewStatus !== statusFilter) return false;
      if (!term) return true;
      return (
        area.name.toLowerCase().includes(term) ||
        (area.floorName ?? '').toLowerCase().includes(term)
      );
    });
  }, [areas, search, statusFilter]);

  // Only fall back to a default once areas exist, and never override an explicit
  // choice that is still present in the list.
  const selectedId =
    selectedFromUrl && areas.some((area) => area.id === selectedFromUrl)
      ? selectedFromUrl
      : (filtered[0]?.id ?? null);

  const select = useCallback(
    (areaId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('area', areaId);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  /**
   * The list with one area open, or the photo sheet with every area at once.
   *
   * In the URL, like the open area, so a refresh or a shared link keeps it.
   * With none chosen, an occupied or back-to-market inspection opens on the
   * sheet: its areas are a photograph and two answers each, which the sheet
   * shows together and the list one area at a time.
   */
  const viewFromUrl = searchParams.get('view');
  const view: 'areas' | 'sheet' =
    viewFromUrl === 'areas' || viewFromUrl === 'sheet'
      ? viewFromUrl
      : inspectionIsWalkedAsOccupied(inspection?.inspectionType)
        ? 'sheet'
        : 'areas';
  const showView = useCallback(
    (next: 'areas' | 'sheet', areaId?: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('view', next);
      if (areaId) params.set('area', areaId);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  /**
   * The open tab, held here rather than inside the detail panel.
   *
   * That is what makes it survive switching area: a reviewer comparing the same
   * tab across rooms — recordings, or findings — should not be dropped back to
   * Overview on every click.
   *
   * Deliberately not in the URL like `area` is. The area matters in a shared
   * link and on refresh; which tab someone had open does not, and putting it
   * there means every tab click is a router write.
   */
  const [activeTab, selectTab] = useState('overview');

  /**
   * The photograph open in the viewer, if any.
   *
   * Held here rather than in the area panel because the viewer walks on past
   * the open area into the next one in this list, and only this component
   * knows the list's order and filter.
   */
  const [photoViewer, setPhotoViewer] = useState<{ areaId: string; photoId: string } | null>(
    null,
  );

  // Announce completion for screen readers, which otherwise get no signal that
  // the right-hand panel changed.
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const area = areas.find((item) => item.id === selectedId);
    if (area) setAnnouncement(`${area.name} evidence loaded.`);
  }, [areas, selectedId]);

  if (summary.isLoading) return <PageSkeleton cards={2} />;
  if (summary.isError)
    return <ErrorState error={summary.error} retry={() => void summary.refetch()} />;

  const totals = summary.data!.totals;
  const unassigned = summary.data!.unassigned;
  const requiresRecording = inspectionRequiresAreaRecording(inspection?.inspectionType);
  // The open area's neighbours in the list as filtered, for moving on from an
  // area once it is reviewed without going back to the list for the next one.
  const position = filtered.findIndex((area) => area.id === selectedId);
  const stepping = {
    previous: position > 0,
    next: position !== -1 && position < filtered.length - 1,
    onStep: (direction: 1 | -1) => {
      const target = filtered[position + direction];
      if (target) select(target.id);
    },
  };
  // One search and one status filter for both views, so switching view keeps
  // the reviewer's place: "Needs review" narrows the sheet as it does the list.
  const filters = (
    <div className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <SearchIcon
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        />
        <Input
          aria-label="Search areas"
          className="pl-9"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search areas"
          type="search"
          value={search}
        />
      </div>
      {/* The lists' own filter control (console-development). */}
      <SelectFilter
        allLabel="All areas"
        className="w-[140px]"
        label="Filter by review status"
        onChange={(next) => setStatusFilter(next || ALL_STATUSES)}
        options={[...STATUS_FILTERS]}
        value={statusFilter === ALL_STATUSES ? '' : statusFilter}
      />
    </div>
  );
  // What the menu offers. Adding an area is only possible while the inspection
  // can still change: finalization freezes the evidence, and a completed or
  // cancelled one is a record rather than work in hand. The server refuses
  // these too -- this just does not offer what it would.
  const canAddArea = Boolean(
    canMerge &&
      inspection?.propertywareBuilding?.id &&
      !inspection.finalizedAt &&
      inspection.status !== 'COMPLETED' &&
      inspection.status !== 'CANCELLED',
  );
  const canMergeAreas = canMerge && manageableAreas.length >= 2;
  const canImport = Boolean(canMerge && inspection);

  return (
    <Card aria-labelledby="area-evidence-heading" className="scroll-mt-20" id="evidence">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          {/* A section name, not a heading (console-development); the reviewed
              count sits beside it as a panel's count does, rather than as a
              badge restating the page's "Areas reviewed" figure. */}
          <div className="flex items-center gap-3">
            <CardTitle id="area-evidence-heading" tabIndex={-1} variant="label">
              Areas
            </CardTitle>
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {totals.areasReviewed} of {totals.areas} reviewed
            </span>
          </div>
          <CardDescription>
            {countLabel(totals.areas, 'area')} · {countLabel(totals.recordings, 'recording')} ·{' '}
            {countLabel(totals.photos, 'photo')} · {countLabel(totals.findings, 'finding')}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label="Show areas as"
            onChange={(next) => showView(next)}
            options={[
              { value: 'areas', label: 'Areas' },
              { value: 'sheet', label: 'Photo sheet' },
            ]}
            value={view}
          />
          {/* Area management belongs beside the area list a reviewer is looking
              at. This used to sit in a second "Inspection areas" card further
              down whose only unique capability was this button — the rest of it
              repeated the navigator below, so the page offered two lists and no
              way to tell which one to use.

              One menu rather than three outline buttons (console-development):
              each is taken rarely, and three of them out-weighed the area list
              they manage. The import still says when one is running, on the
              menu's own button. */}
          {canAddArea || canMergeAreas || canImport ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" type="button" variant="outline">
                  {importRunning ? <Spinner /> : null}
                  Manage areas
                  <ChevronDownIcon aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {canAddArea ? (
                  <DropdownMenuItem onSelect={() => setAddingAreas(true)}>Add area</DropdownMenuItem>
                ) : null}
                {canMergeAreas ? (
                  <DropdownMenuItem onSelect={() => setMerging(true)}>
                    Merge duplicates
                  </DropdownMenuItem>
                ) : null}
                {canImport ? (
                  <DropdownMenuItem onSelect={() => setImporting(true)}>
                    {importRunning ? 'Import in progress' : 'Import a report'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {/* Offered on every inspection, of every type, in every state: an
              import is what the office reaches for when the record here is
              wrong, so it replaces what it finds -- or, chosen once the report
              has been read, adds the rooms it covers. Opened from the menu
              rather than an amber paragraph above the areas on every
              inspection: the dialog says what an import will do to what is
              here before anything happens, in real numbers. Always mounted,
              so `?import=` still opens it from a link. */}
          {canImport && inspection ? (
            <ImportReportDialog
              evidence={
                inspection.evidence
                  ? { areas: inspection.evidence.areas, photos: inspection.evidence.photos }
                  : undefined
              }
              inspectionId={inspectionId}
              inspectionType={inspection.inspectionType}
              onOpenChange={setImporting}
              open={importing}
              replacing={hasEvidence(inspection)}
            />
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {unassigned.recordings || unassigned.photos ? (
          <Alert variant="destructive">
            <AlertDescription>
              Unassigned evidence: {countLabel(unassigned.recordings, 'recording')} and{' '}
              {countLabel(unassigned.photos, 'photo')} are not linked to an area and need
              reassignment.
            </AlertDescription>
          </Alert>
        ) : null}

        {view === 'sheet' ? (
          <div className="space-y-3">
            {filters}
            <PhotoSheet
              areas={filtered}
              inspectionId={inspectionId}
              onOpenArea={(areaId) => {
                selectTab('findings');
                showView('areas', areaId);
              }}
              onOpenPhoto={(areaId, photoId) => setPhotoViewer({ areaId, photoId })}
            />
          </div>
        ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-2">
            {filters}

            {filtered.length ? (
              <ul
                aria-orientation="vertical"
                className="max-h-[70vh] space-y-1 overflow-y-auto"
                role="tablist"
              >
                {filtered.map((area) => {
                  const active = area.id === selectedId;
                  const meta = STATUS_META[area.reviewStatus];
                  const checklistComplete =
                    area.checklistItemCount > 0 &&
                    area.checklistAssessedCount >= area.checklistItemCount;
                  /**
                   * Two lines a row where there were five or six -- name and
                   * status, then what is in the area -- so a twenty-area
                   * inspection reads in one screen rather than a scrolling box
                   * of four. "No video" is said only where a video is owed;
                   * on an occupied visit it was every row's noise.
                   */
                  const contents = [
                    area.counts.recordings
                      ? countLabel(area.counts.recordings, 'video')
                      : requiresRecording
                        ? 'No video'
                        : null,
                    countLabel(area.counts.photos, 'photo'),
                    area.counts.findings ? countLabel(area.counts.findings, 'finding') : null,
                    area.floorName,
                    area.isRequired ? null : 'Optional',
                  ].filter(Boolean);
                  return (
                    <li key={area.id}>
                      <button
                        aria-label={areaAriaLabel(area)}
                        aria-selected={active}
                        className={cn(
                          'grid w-full gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors',
                          'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
                          // The accent for "you are here"; primary is ink now
                          // (console-development).
                          active ? 'border-highlight bg-highlight/10' : 'hover:bg-accent/50',
                        )}
                        onClick={() => select(area.id)}
                        role="tab"
                        type="button"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{area.name}</span>
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                        </span>
                        <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
                          {contents.join(' · ')}
                          {/* Scoring progress, not a door into the property's
                              checklist template: that editor changes what every
                              future visit asks, and lives in the Condition tab
                              under its own name now. */}
                          {area.checklistItemCount ? (
                            <span className="inline-flex items-center gap-0.5">
                              · Checklist {area.checklistAssessedCount}/{area.checklistItemCount}
                              {checklistComplete ? (
                                <CheckIcon aria-hidden className="text-success size-3" />
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                        {area.counts.unreviewedFindings ? (
                          <span>
                            <Badge variant="warning">
                              {area.counts.unreviewedFindings} awaiting review
                            </Badge>
                          </span>
                        ) : null}
                        {/* The reason belongs next to the status, not a click
                            away. "Skipped" alone tells a reviewer nothing they
                            can act on; "Skipped — tenant refused access" closes
                            the question without opening the area. */}
                        {area.skipReason ? (
                          <span className="text-muted-foreground text-xs italic">
                            {area.skipReason}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              // A quiet line, not a dashed box inside the card (console-development).
              <p className="text-muted-foreground py-4 text-center text-sm">
                No areas match this filter.
              </p>
            )}
          </div>

          <div className="min-w-0">
            {/* No `key` on the panel below, deliberately. Keying it by area
                forced a full remount on every switch, so it tore down and
                rebuilt its whole tree — losing the open tab and re-running
                everything — when the only thing that actually changed was which
                area's data to fetch. The panel resets what genuinely belongs to
                one area. */}
            {selectedId ? (
              <AreaDetailPanel
                areaId={selectedId}
                inspectionId={inspectionId}
                onOpenPhoto={(photoId) => setPhotoViewer({ areaId: selectedId, photoId })}
                stepping={stepping}
                onTabChange={selectTab}
                tab={activeTab}
              />
            ) : (
              <p className="text-muted-foreground py-6 text-center text-sm">
                Select an area to review its evidence.
              </p>
            )}
          </div>
        </div>
        )}
      </CardContent>

      {addingAreas && inspection?.propertywareBuilding?.id ? (
        <AddAreasDialog
          existingPropertyAreaIds={manageableAreas.map((area) => area.propertyAreaId)}
          inspectionId={inspectionId}
          inspectionType={inspection.inspectionType}
          onClose={() => setAddingAreas(false)}
          propertyId={inspection.propertywareBuilding.id}
          unitId={inspection.propertywareUnit?.id ?? null}
        />
      ) : null}

      {merging && manageableAreas.length ? (
        <MergeAreasDialog
          areas={manageableAreas}
          inspectionId={inspectionId}
          onClose={() => setMerging(false)}
        />
      ) : null}

      {/* Walks the list as it is filtered, so "Needs review" walks only the
          areas that need review. An area opened from the URL that the filter
          hides walks the whole list instead of nothing. Each crossing selects
          the area underneath, so closing lands where the reviewer stopped. */}
      {photoViewer ? (
        <AreaPhotoViewer
          areas={filtered.some((area) => area.id === photoViewer.areaId) ? filtered : areas}
          inspectionId={inspectionId}
          onAreaChange={select}
          onClose={() => setPhotoViewer(null)}
          startAreaId={photoViewer.areaId}
          startPhotoId={photoViewer.photoId}
        />
      ) : null}

    </Card>
  );
}

export { STATUS_META };
