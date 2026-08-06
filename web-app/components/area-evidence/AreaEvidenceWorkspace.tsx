'use client';

import type { AreaEvidenceSummaryItem, AreaReviewStatus } from '@texasrenters/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListChecks } from 'lucide-react';

import { AreaChecklistDialog } from '@/components/area-checklist/AreaChecklistDialog';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { buttonVariants } from '@/components/ui/button';
import { useAreaEvidenceSummary, useInspectionAreas } from '@/lib/queries';
import { usePermissions } from '@/lib/auth';
import { MergeAreasDialog } from '@/components/inspection-workflow';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '../shared';

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
const STATUS_META: Record<AreaReviewStatus, { label: string; tone: string }> = {
  NOT_STARTED: { label: 'Not started', tone: 'neutral' },
  EVIDENCE_INCOMPLETE: { label: 'Evidence incomplete', tone: 'warning' },
  EVIDENCE_READY: { label: 'Evidence ready', tone: 'ok' },
  ANALYSIS_PROCESSING: { label: 'Analysing', tone: 'info' },
  FINDINGS_NEED_REVIEW: { label: 'Findings need review', tone: 'warning' },
  REVIEWED: { label: 'Reviewed', tone: 'ok' },
  FOLLOW_UP_REQUIRED: { label: 'Follow-up required', tone: 'danger' },
  FAILED: { label: 'Failed', tone: 'danger' },
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
    : STATUS_META[area.reviewStatus].label + '.';
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

  const areas = summary.data?.areas ?? [];
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

  // Only fall back to a default once areas exist, and never override an
  // explicit choice that is still present in the list.
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

  // Announce completion for screen readers, which otherwise get no signal that
  // the right-hand panel changed.
  const [checklistArea, setChecklistArea] = useState<{ id: string; name: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const area = areas.find((item) => item.id === selectedId);
    if (area) setAnnouncement(`${area.name} evidence loaded.`);
  }, [areas, selectedId]);

  if (summary.isLoading) return <LoadingState label="Loading inspection evidence…" />;
  if (summary.isError)
    return <ErrorState error={summary.error} retry={() => void summary.refetch()} />;

  const totals = summary.data!.totals;
  const unassigned = summary.data!.unassigned;

  return (
    <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section className="section-gap inspection-section" aria-labelledby="area-evidence-heading">
      <CardHeader className="p-0 pb-4">
        <div>
          <span className="block text-xs font-semibold text-muted-foreground">Inspection evidence</span>
          <CardTitle id="area-evidence-heading" className="text-[17px]" tabIndex={-1}>
            Areas
          </CardTitle>
          <CardDescription>
            {countLabel(totals.areas, 'area')} · {countLabel(totals.recordings, 'recording')} ·{' '}
            {countLabel(totals.photos, 'photo')} · {countLabel(totals.findings, 'finding')}
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <span className="section-count">
            {totals.areasReviewed} of {totals.areas} reviewed
          </span>
          {/* Area management belongs beside the area list a reviewer is looking
              at. This used to sit in a second "Inspection areas" card further
              down whose only unique capability was this button — the rest of it
              repeated the navigator below, so the page offered two lists and no
              way to tell which one to use. */}
          {canMerge && manageableAreas.length >= 2 ? (
            <button
              className={buttonVariants({ variant: 'secondary', size: 'small' })}
              onClick={() => setMerging(true)}
              type="button"
            >
              Merge duplicates
            </button>
          ) : null}
        </div>
      </CardHeader>

      {merging && manageableAreas.length ? (
        <MergeAreasDialog
          areas={manageableAreas}
          inspectionId={inspectionId}
          onClose={() => setMerging(false)}
        />
      ) : null}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {unassigned.recordings || unassigned.photos ? (
        <Alert variant="destructive" role="alert">
          Unassigned evidence: {countLabel(unassigned.recordings, 'recording')} and{' '}
          {countLabel(unassigned.photos, 'photo')} are not linked to an area and need
          reassignment.
        </Alert>
      ) : null}

      <div className="area-evidence-layout">
        <div className="area-evidence-list-pane">
          <div className="area-evidence-filters">
            <div className="relative flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search areas"
                className="pl-8"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search areas"
                type="search"
                value={search}
              />
            </div>
            <Select onValueChange={setStatusFilter} value={statusFilter}>
              <SelectTrigger aria-label="Filter by review status" className="w-[150px]">
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
            <ul className="area-evidence-list" role="tablist" aria-orientation="vertical">
              {filtered.map((area) => {
                const active = area.id === selectedId;
                const meta = STATUS_META[area.reviewStatus];
                return (
                  <li key={area.id}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-label={areaAriaLabel(area)}
                      className={`area-evidence-card${active ? ' is-active' : ''}`}
                      onClick={() => select(area.id)}
                    >
                      <span className="area-evidence-card-head">
                        <strong>{area.name}</strong>
                        {!area.isRequired ? (
                          <span className="area-evidence-optional">Optional</span>
                        ) : null}
                      </span>
                      {area.floorName ? (
                        <span className="area-evidence-floor">{area.floorName}</span>
                      ) : null}
                      <span className="area-evidence-counts">
                        {area.counts.recordings ? `${area.counts.recordings} video` : 'No video'} ·{' '}
                        {countLabel(area.counts.photos, 'photo')} ·{' '}
                        {area.counts.findings
                          ? countLabel(area.counts.findings, 'finding')
                          : 'No findings'}
                      </span>
                      <span className={`area-evidence-status is-${meta.tone}`}>
                        {meta.label}
                        {area.counts.unreviewedFindings ? (
                          <em> · {area.counts.unreviewedFindings} awaiting review</em>
                        ) : null}
                      </span>
                    </button>
                    {/* Sibling of the row button, never nested inside it — a
                        button within a button is invalid markup and breaks
                        keyboard traversal. */}
                    <button
                      type="button"
                      aria-label={`Edit ${area.name} coverage checklist, ${area.checklistItemCount || 'no'} item${area.checklistItemCount === 1 ? '' : 's'}`}
                      className="area-evidence-checklist-button"
                      onClick={() =>
                        setChecklistArea({ id: area.propertyAreaId, name: area.name })
                      }
                    >
                      <ListChecks aria-hidden className="size-4" />
                      {/* "Not set" rather than "0": an unconfigured area still
                          shows the technician a generated fallback, so this is
                          a prompt to configure, not a fault. */}
                      <span>
                        {area.checklistItemCount
                          ? `Checklist · ${area.checklistItemCount}`
                          : 'Checklist · not set'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No areas match this filter.</p>
          )}
        </div>

        <div className="area-evidence-detail-pane">
          {selectedId ? (
            <AreaDetailPanel key={selectedId} inspectionId={inspectionId} areaId={selectedId} />
          ) : (
            <p className="text-xs text-muted-foreground">Select an area to review its evidence.</p>
          )}
        </div>
      </div>
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
      </section>
    </Card>
  );
}

export { STATUS_META };
