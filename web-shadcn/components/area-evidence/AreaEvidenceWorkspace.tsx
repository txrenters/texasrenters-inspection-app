'use client';

import type { AreaEvidenceSummaryItem, AreaReviewStatus } from '@texasrenters/shared';
import { CheckIcon, ListChecksIcon, SearchIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AreaChecklistDialog } from '@/components/area-checklist/AreaChecklistDialog';
import { MergeAreasDialog } from '@/components/inspection-workflow';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePermissions } from '@/lib/auth';
import { useAreaEvidenceSummary, useInspectionAreas } from '@/lib/queries';
import { cn } from '@/lib/utils';

import { AreaDetailPanel } from './AreaDetailPanel';

/**
 * Area-first inspection evidence.
 *
 * Replaces four page-wide sections (recordings, photos, summaries, findings)
 * that each fetched the whole inspection and forced reviewers to correlate one
 * room's evidence across four scroll positions. The list carries counts and
 * status only; a single area's evidence loads when it is opened.
 */

/** Wording and tone per status. Never colour alone — each carries a label. */
const STATUS_META: Record<
  AreaReviewStatus,
  { label: string; variant: 'secondary' | 'warning' | 'success' | 'info' | 'destructive' }
> = {
  NOT_STARTED: { label: 'Not started', variant: 'secondary' },
  EVIDENCE_INCOMPLETE: { label: 'Evidence incomplete', variant: 'warning' },
  EVIDENCE_READY: { label: 'Evidence ready', variant: 'success' },
  ANALYSIS_PROCESSING: { label: 'Analysing', variant: 'info' },
  FINDINGS_NEED_REVIEW: { label: 'Findings need review', variant: 'warning' },
  REVIEWED: { label: 'Reviewed', variant: 'success' },
  FOLLOW_UP_REQUIRED: { label: 'Follow-up required', variant: 'destructive' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

/**
 * Radix Select throws on an empty-string item value, which silently left the
 * trigger blank — the filter looked broken because it *was*. ALL is a sentinel
 * mapped back to "no filter" at the call site.
 */
const ALL_STATUSES = 'ALL';

const STATUS_FILTERS = [
  { value: ALL_STATUSES, label: 'All areas' },
  { value: 'FINDINGS_NEED_REVIEW', label: 'Needs review' },
  { value: 'EVIDENCE_INCOMPLETE', label: 'Incomplete' },
  { value: 'NOT_STARTED', label: 'Not started' },
  { value: 'REVIEWED', label: 'Reviewed' },
] as const;

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Spoken description of an area, so the list is usable without the visuals. */
function areaAriaLabel(area: AreaEvidenceSummaryItem) {
  const parts = [
    area.name,
    area.floorName ?? '',
    countLabel(area.counts.recordings, 'recording'),
    countLabel(area.counts.photos, 'photo'),
    countLabel(area.counts.findings, 'finding'),
  ].filter(Boolean);
  const review = area.counts.unreviewedFindings
    ? `${countLabel(area.counts.unreviewedFindings, 'finding')} require review.`
    : `${STATUS_META[area.reviewStatus].label}.`;
  return `${parts.join('. ')}. ${review}`;
}

export function AreaEvidenceWorkspace({ inspectionId }: { inspectionId: string }) {
  const summary = useAreaEvidenceSummary(inspectionId);
  // A second read of the same areas, in the shape the merge dialog needs. The
  // evidence summary carries review state the dialog does not use, and the
  // dialog needs floor/environment detail the summary does not carry.
  const manageableAreas = useInspectionAreas(inspectionId).data ?? [];
  const canMerge = usePermissions().has('inspections:manage');
  const [merging, setMerging] = useState(false);
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

  const [checklistArea, setChecklistArea] = useState<{ id: string; name: string } | null>(null);
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

  return (
    <Card aria-labelledby="area-evidence-heading" className="scroll-mt-20" id="evidence">
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle id="area-evidence-heading" tabIndex={-1}>
            Areas
          </CardTitle>
          <CardDescription>
            {countLabel(totals.areas, 'area')} · {countLabel(totals.recordings, 'recording')} ·{' '}
            {countLabel(totals.photos, 'photo')} · {countLabel(totals.findings, 'finding')}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={totals.areasReviewed >= totals.areas ? 'success' : 'secondary'}>
            {totals.areasReviewed} of {totals.areas} reviewed
          </Badge>
          {/* Area management belongs beside the area list a reviewer is looking
              at. This used to sit in a second "Inspection areas" card further
              down whose only unique capability was this button — the rest of it
              repeated the navigator below, so the page offered two lists and no
              way to tell which one to use. */}
          {canMerge && manageableAreas.length >= 2 ? (
            <Button onClick={() => setMerging(true)} size="sm" type="button" variant="outline">
              Merge duplicates
            </Button>
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

        <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-2">
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
              <Select onValueChange={setStatusFilter} value={statusFilter}>
                <SelectTrigger aria-label="Filter by review status" className="w-[140px]">
                  <SelectValue placeholder="All areas" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
                  return (
                    <li className="grid gap-1" key={area.id}>
                      <button
                        aria-label={areaAriaLabel(area)}
                        aria-selected={active}
                        className={cn(
                          'grid w-full gap-1 rounded-lg border p-2.5 text-left transition-colors',
                          'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
                          active ? 'border-primary bg-primary/5' : 'hover:bg-accent/50',
                        )}
                        onClick={() => select(area.id)}
                        role="tab"
                        type="button"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{area.name}</span>
                          {!area.isRequired ? (
                            <Badge variant="outline">Optional</Badge>
                          ) : null}
                        </span>
                        {area.floorName ? (
                          <span className="text-muted-foreground text-xs">{area.floorName}</span>
                        ) : null}
                        <span className="text-muted-foreground text-xs">
                          {area.counts.recordings ? `${area.counts.recordings} video` : 'No video'} ·{' '}
                          {countLabel(area.counts.photos, 'photo')} ·{' '}
                          {area.counts.findings
                            ? countLabel(area.counts.findings, 'finding')
                            : 'No findings'}
                        </span>
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                          {area.counts.unreviewedFindings ? (
                            <Badge variant="warning">
                              {area.counts.unreviewedFindings} awaiting review
                            </Badge>
                          ) : null}
                        </span>
                      </button>

                      {/* Sibling of the row button, never nested inside it — a
                          button within a button is invalid markup and breaks
                          keyboard traversal. */}
                      <button
                        aria-label={
                          area.checklistItemCount
                            ? `Edit ${area.name} checklist, ${area.checklistAssessedCount} of ${area.checklistItemCount} items assessed`
                            : `Edit ${area.name} coverage checklist, no items`
                        }
                        className="text-muted-foreground hover:bg-accent focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                        onClick={() => setChecklistArea({ id: area.propertyAreaId, name: area.name })}
                        type="button"
                      >
                        <ListChecksIcon aria-hidden className="size-3.5" />
                        {/* "Not set" rather than "0": an unconfigured area still
                            shows the technician a generated fallback, so this is
                            a prompt to configure, not a fault.

                            Once configured this reads as progress — assessed of
                            total — because the question a reviewer actually has
                            is whether the technician scored the room, not how
                            many rows the checklist happens to contain. */}
                        {area.checklistItemCount
                          ? `Checklist · ${area.checklistAssessedCount}/${area.checklistItemCount}`
                          : 'Checklist · not set'}
                        {checklistComplete ? (
                          <CheckIcon aria-hidden className="text-success size-3.5" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
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
                onTabChange={selectTab}
                tab={activeTab}
              />
            ) : (
              <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                Select an area to review its evidence.
              </p>
            )}
          </div>
        </div>
      </CardContent>

      {merging && manageableAreas.length ? (
        <MergeAreasDialog
          areas={manageableAreas}
          inspectionId={inspectionId}
          onClose={() => setMerging(false)}
        />
      ) : null}

      {/* One dialog at the root driven by the chosen area, rather than one
          mounted per row. */}
      {checklistArea ? (
        <AreaChecklistDialog
          areaId={checklistArea.id}
          areaName={checklistArea.name}
          onOpenChange={(open) => {
            if (!open) setChecklistArea(null);
          }}
          open
        />
      ) : null}
    </Card>
  );
}

export { STATUS_META };
