'use client';

import type { AdminPropertyArea } from '@texasrenters/shared';
import { ListChecksIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AreaChecklistDialog } from '@/components/area-checklist/AreaChecklistDialog';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface AreaFloorGroup {
  key: string;
  label: string;
  areas: AdminPropertyArea[];
}

type AreaFilter = 'ALL' | 'REQUIRED' | 'OPTIONAL' | 'DRAFT' | 'APPROVED' | 'MISSING';

interface FloorPlanChecklistProps {
  groups: AreaFloorGroup[];
  planId: string;
  selectedAreaId: string | null;
  editingAreaId: string | null;
  hasDraft: boolean;
  canManage: boolean;
  supportsMarkers: boolean;
  saving: boolean;
  saveError: string | null;
  saveMessage: string | null;
  onSelectArea: (id: string) => void;
  onFocusArea: (id: string) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveMarker: (id: string) => void;
}

export function getMarkerStatus(area: AdminPropertyArea, planId: string) {
  if (!area.marker || area.sourceFloorPlanId !== planId) {
    return { key: 'missing', label: 'Marker missing', announcement: 'marker is missing' } as const;
  }
  if (area.marker.source === 'ADMIN_ADJUSTED') {
    return {
      key: 'verified',
      label: 'Admin adjusted',
      announcement: 'marker was adjusted by an administrator',
    } as const;
  }
  if (area.marker.source === 'ADMIN_PLACED') {
    return {
      key: 'verified',
      label: 'Admin placed',
      announcement: 'marker was placed by an administrator',
    } as const;
  }
  if (area.marker.source === 'AI_EXTRACTED') {
    return {
      key: 'suggested',
      label: 'AI suggested',
      announcement: 'marker is AI suggested',
    } as const;
  }
  if (area.marker.source === 'DETERMINISTIC_EXTRACTED') {
    return {
      key: 'suggested',
      label: 'Extracted',
      announcement: 'marker was extracted and needs review',
    } as const;
  }
  return { key: 'review', label: 'Needs review', announcement: 'marker needs review' } as const;
}

/** Marker provenance, on the same tint discipline as every other status here. */
const MARKER_VARIANT = {
  verified: 'success',
  suggested: 'warning',
  review: 'warning',
  missing: 'destructive',
} as const;

export function FloorPlanChecklist({
  groups,
  planId,
  selectedAreaId,
  editingAreaId,
  hasDraft,
  canManage,
  supportsMarkers,
  saving,
  saveError,
  saveMessage,
  onSelectArea,
  onFocusArea,
  onStartEdit,
  onCancelEdit,
  onSaveMarker,
}: FloorPlanChecklistProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AreaFilter>('ALL');
  const allAreas = useMemo(() => groups.flatMap((group) => group.areas), [groups]);
  // Held as the area itself rather than an id so the dialog can show the name
  // without looking it back up.
  const [checklistArea, setChecklistArea] = useState<{ id: string; name: string } | null>(null);
  const selectedArea = allAreas.find((area) => area.id === selectedAreaId) ?? null;
  const selectedMarkerStatus = selectedArea ? getMarkerStatus(selectedArea, planId) : null;
  const showFiltering = allAreas.length >= 6;

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return groups
      .map((group) => ({
        ...group,
        areas: group.areas.filter((area) => {
          const matchesQuery =
            !normalizedQuery ||
            area.name.toLocaleLowerCase().includes(normalizedQuery) ||
            area.category?.toLocaleLowerCase().includes(normalizedQuery);
          if (!matchesQuery) return false;
          if (filter === 'REQUIRED') return area.isRequired;
          if (filter === 'OPTIONAL') return !area.isRequired;
          if (filter === 'DRAFT') return area.status === 'DRAFT';
          if (filter === 'APPROVED') return area.status === 'APPROVED';
          if (filter === 'MISSING') return getMarkerStatus(area, planId).key === 'missing';
          return true;
        }),
      }))
      .filter((group) => group.areas.length > 0);
  }, [filter, groups, planId, query]);

  useEffect(() => {
    if (!selectedAreaId) return;
    const row = document.getElementById(`fp-row-${selectedAreaId}`);
    if (row && 'scrollIntoView' in row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedAreaId]);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {selectedArea && selectedMarkerStatus ? (
        <section aria-labelledby="fp-selected-area-heading" className="bg-muted/40 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs font-medium">Selected area</p>
              <h3 className="truncate font-semibold" id="fp-selected-area-heading">
                {selectedArea.name}
              </h3>
            </div>
            <Badge variant="outline">#{selectedArea.inspectionOrder}</Badge>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge value={selectedArea.status} />
            {supportsMarkers ? (
              <Badge variant={MARKER_VARIANT[selectedMarkerStatus.key]}>
                {selectedMarkerStatus.label}
              </Badge>
            ) : null}
            <Badge variant="secondary">
              {selectedArea.isRequired ? 'Required' : 'Optional'}
            </Badge>
            {selectedArea.environment ? (
              <Badge variant="secondary">{humanize(selectedArea.environment)}</Badge>
            ) : null}
            {selectedArea.marker?.confidence != null ? (
              <Badge variant="secondary">
                {Math.round(selectedArea.marker.confidence * 100)}% confidence
              </Badge>
            ) : null}
          </div>

          {supportsMarkers ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedMarkerStatus.key !== 'missing' ? (
                <Button
                  disabled={Boolean(editingAreaId)}
                  onClick={() => onFocusArea(selectedArea.id)}
                  size="sm"
                  variant="outline"
                >
                  Focus marker
                </Button>
              ) : null}
              {canManage && !editingAreaId ? (
                <Button onClick={() => onStartEdit(selectedArea.id)} size="sm">
                  {selectedMarkerStatus.key === 'missing' ? 'Place marker' : 'Adjust marker'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <div className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
          <p className="text-foreground font-medium">Select an area to review</p>
          <p>The checklist and floor-plan marker stay synchronized.</p>
        </div>
      )}

      {showFiltering ? (
        <div aria-label="Filter extracted areas" className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              aria-label="Search extracted areas"
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search areas"
              type="search"
              value={query}
            />
          </div>
          <Select onValueChange={(next) => setFilter(next as AreaFilter)} value={filter}>
            <SelectTrigger aria-label="Area filter" className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All areas</SelectItem>
              <SelectItem value="REQUIRED">Required</SelectItem>
              <SelectItem value="OPTIONAL">Optional</SelectItem>
              <SelectItem value="DRAFT">Draft areas</SelectItem>
              <SelectItem value="APPROVED">Approved areas</SelectItem>
              <SelectItem value="MISSING">Missing marker</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {filteredGroups.length ? (
          filteredGroups.map((group) => (
            <section key={group.key}>
              <header className="bg-background sticky top-0 z-10 flex items-center justify-between gap-2 pb-1.5">
                <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  {group.label}
                </h3>
                <Badge variant="secondary">{group.areas.length}</Badge>
              </header>
              <ol className="grid gap-1">
                {group.areas.map((area) => {
                  const selected = area.id === selectedAreaId;
                  const markerStatus = getMarkerStatus(area, planId);
                  return (
                    <li className="flex items-stretch gap-1" key={area.id}>
                      <button
                        aria-describedby={`fp-row-status-${area.id}`}
                        aria-pressed={selected}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border p-2 text-left transition-colors',
                          'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
                          selected ? 'border-primary bg-primary/5' : 'hover:bg-accent/50',
                        )}
                        id={`fp-row-${area.id}`}
                        onClick={() => onSelectArea(area.id)}
                        type="button"
                      >
                        <span className="bg-muted grid size-6 shrink-0 place-items-center rounded text-xs font-semibold tabular-nums">
                          {area.inspectionOrder}
                        </span>
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="truncate text-sm font-medium">{area.name}</span>
                          <span className="text-muted-foreground truncate text-xs">
                            {area.category ? `${area.category} · ` : ''}
                            {area.isRequired ? 'Required' : 'Optional'}
                          </span>
                        </span>
                        <span
                          aria-label={`Area ${area.status.toLowerCase()}; ${markerStatus.announcement}`}
                          className="flex shrink-0 flex-col items-end gap-1"
                          id={`fp-row-status-${area.id}`}
                        >
                          <StatusBadge showIcon={false} value={area.status} />
                          {supportsMarkers ? (
                            <Badge variant={MARKER_VARIANT[markerStatus.key]}>
                              {markerStatus.label}
                            </Badge>
                          ) : null}
                        </span>
                      </button>
                      {/* Sibling of the row button, never nested inside it — a
                          button within a button is invalid markup and breaks
                          keyboard traversal. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            aria-label={`Edit ${area.name} coverage checklist`}
                            className="h-auto self-stretch"
                            onClick={() => setChecklistArea({ id: area.id, name: area.name })}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <ListChecksIcon />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Coverage checklist</TooltipContent>
                      </Tooltip>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))
        ) : (
          <div className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
            <p className="text-foreground font-medium">No matching areas</p>
            <p>Clear the search or choose a different filter.</p>
          </div>
        )}
      </div>

      {editingAreaId && selectedArea?.id === editingAreaId ? (
        <div
          aria-label="Marker adjustment controls"
          className="bg-primary/5 border-primary space-y-2 rounded-lg border p-3"
          role="region"
        >
          <div>
            <p className="text-muted-foreground text-xs">Adjusting marker</p>
            <p className="font-medium">{selectedArea.name}</p>
            <p className="text-muted-foreground text-xs">
              Drag the marker, click the plan, or use the arrow keys.
            </p>
          </div>
          <div className="flex gap-2">
            <Button disabled={saving} onClick={onCancelEdit} size="sm" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={saving || !hasDraft}
              onClick={() => onSaveMarker(selectedArea.id)}
              size="sm"
            >
              {saving ? <Spinner /> : null}
              {saving ? 'Saving…' : 'Save position'}
            </Button>
          </div>
          {saveError ? (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {saveMessage ? (
        <p className="text-success text-sm" role="status">
          {saveMessage}
        </p>
      ) : null}

      {/* Rendered once at the root rather than per row: one dialog driven by
          which area is selected, not one mounted for every area in the list. */}
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
    </div>
  );
}
