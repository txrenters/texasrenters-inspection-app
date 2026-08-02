import type { AdminPropertyArea } from '@texasrenters/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldError } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';
import { ListChecks } from 'lucide-react';
import { AreaChecklistDialog } from '@/components/area-checklist/AreaChecklistDialog';

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
    return { key: 'missing', label: 'Marker missing', announcement: 'marker is missing' };
  }
  if (area.marker.source === 'ADMIN_ADJUSTED') {
    return {
      key: 'verified',
      label: 'Admin adjusted',
      announcement: 'marker was adjusted by an administrator',
    };
  }
  if (area.marker.source === 'ADMIN_PLACED') {
    return {
      key: 'verified',
      label: 'Admin placed',
      announcement: 'marker was placed by an administrator',
    };
  }
  if (area.marker.source === 'AI_EXTRACTED') {
    return { key: 'suggested', label: 'AI suggested', announcement: 'marker is AI suggested' };
  }
  if (area.marker.source === 'DETERMINISTIC_EXTRACTED') {
    return {
      key: 'suggested',
      label: 'Extracted',
      announcement: 'marker was extracted and needs review',
    };
  }
  return { key: 'review', label: 'Needs review', announcement: 'marker needs review' };
}

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
    if (row && 'scrollIntoView' in row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedAreaId]);

  return (
    <div className="floor-plan-checklist">
      {selectedArea && selectedMarkerStatus ? (
        <section className="fp-selected-area" aria-labelledby="fp-selected-area-heading">
          <div className="fp-selected-area-heading">
            <div>
              <span>Selected area</span>
              <h3 id="fp-selected-area-heading">{selectedArea.name}</h3>
            </div>
            <span className="fp-selected-area-order">#{selectedArea.inspectionOrder}</span>
          </div>
          <div className="fp-selected-area-statuses">
            <div>
              <span>Area status</span>
              <strong className={`fp-status is-${selectedArea.status.toLowerCase()}`}>
                {selectedArea.status.replaceAll('_', ' ')}
              </strong>
            </div>
            <div>
              <span>Marker status</span>
              <strong className={`fp-status is-marker-${selectedMarkerStatus.key}`}>
                {selectedMarkerStatus.label}
              </strong>
            </div>
          </div>
          <dl className="fp-selected-area-facts">
            <div>
              <dt>Checklist</dt>
              <dd>{selectedArea.isRequired ? 'Required' : 'Optional'}</dd>
            </div>
            {selectedArea.environment ? (
              <div>
                <dt>Type</dt>
                <dd>{selectedArea.environment.replaceAll('_', ' ').toLowerCase()}</dd>
              </div>
            ) : null}
            {selectedArea.marker?.confidence != null ? (
              <div>
                <dt>Confidence</dt>
                <dd>{Math.round(selectedArea.marker.confidence * 100)}%</dd>
              </div>
            ) : null}
            {selectedArea.marker?.updatedAt ? (
              <div>
                <dt>Marker updated</dt>
                <dd>{new Date(selectedArea.marker.updatedAt).toLocaleDateString()}</dd>
              </div>
            ) : null}
          </dl>
          {supportsMarkers ? (
            <div className="fp-selected-area-actions">
              {selectedMarkerStatus.key !== 'missing' ? (
                <button
                  type="button"
                  className={buttonVariants({ variant: 'secondary', size: 'small' })}
                  disabled={Boolean(editingAreaId)}
                  onClick={() => onFocusArea(selectedArea.id)}
                >
                  Focus marker
                </button>
              ) : null}
              {canManage && !editingAreaId ? (
                <button
                  type="button"
                  className={buttonVariants({ variant: 'primary', size: 'small' })}
                  onClick={() => onStartEdit(selectedArea.id)}
                >
                  {selectedMarkerStatus.key === 'missing' ? 'Place marker' : 'Adjust marker'}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <div className="fp-selected-area-empty">
          <strong>Select an area to review</strong>
          <p>The checklist and floor-plan marker will stay synchronized.</p>
        </div>
      )}

      {showFiltering ? (
        <div className="fp-checklist-tools" aria-label="Filter extracted areas">
          <label>
            <span className="visually-hidden">Search extracted areas</span>
            <input
              type="search"
              value={query}
              placeholder="Search areas"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Select onValueChange={(next) => setFilter(next as AreaFilter)} value={filter}>
            <SelectTrigger aria-label="Area filter">
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

      <div className="floor-plan-comparison-list">
        {filteredGroups.length ? (
          filteredGroups.map((group) => (
            <section key={group.key} className="floor-plan-comparison-floor">
              <header>
                <h3>{group.label}</h3>
                <span>{group.areas.length}</span>
              </header>
              <ol>
                {group.areas.map((area) => {
                  const selected = area.id === selectedAreaId;
                  const markerStatus = getMarkerStatus(area, planId);
                  return (
                    <li key={area.id} className={selected ? 'is-selected' : undefined}>
                      <button
                        type="button"
                        id={`fp-row-${area.id}`}
                        className={`floor-plan-comparison-area-button${selected ? ' is-selected' : ''}`}
                        aria-pressed={selected}
                        aria-describedby={`fp-row-status-${area.id}`}
                        onClick={() => onSelectArea(area.id)}
                      >
                        <span className="floor-plan-comparison-order">
                          {area.inspectionOrder}
                        </span>
                        <span className="floor-plan-comparison-area-copy">
                          <strong>{area.name}</strong>
                          <small>
                            {area.category ? `${area.category} · ` : ''}
                            {area.isRequired ? 'Required' : 'Optional'}
                          </small>
                        </span>
                        <span
                          id={`fp-row-status-${area.id}`}
                          className="fp-row-statuses"
                          aria-label={`Area ${area.status.toLowerCase()}; ${markerStatus.announcement}`}
                        >
                          <span className={`fp-status is-${area.status.toLowerCase()}`}>
                            {area.status.replaceAll('_', ' ')}
                          </span>
                          {supportsMarkers ? (
                            <span className={`fp-status is-marker-${markerStatus.key}`}>
                              {markerStatus.label}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {/* Sibling of the row button, never nested inside it —
                          a button within a button is invalid markup and breaks
                          keyboard traversal. */}
                      <button
                        type="button"
                        aria-label={`Edit ${area.name} coverage checklist`}
                        className="floor-plan-comparison-area-checklist"
                        onClick={() => setChecklistArea({ id: area.id, name: area.name })}
                      >
                        <ListChecks aria-hidden className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))
        ) : (
          <div className="fp-checklist-empty">
            <strong>No matching areas</strong>
            <p>Clear the search or choose a different filter.</p>
          </div>
        )}
      </div>

      {editingAreaId && selectedArea?.id === editingAreaId ? (
        <div className="fp-edit-footer" role="region" aria-label="Marker adjustment controls">
          <div>
            <span>Adjusting marker</span>
            <strong>{selectedArea.name}</strong>
            <small>Drag the marker, click the plan, or use the arrow keys.</small>
          </div>
          <div>
            <button
              type="button"
              className={buttonVariants({ variant: 'secondary', size: 'small' })}
              disabled={saving}
              onClick={onCancelEdit}
            >
              Cancel
            </button>
            <button
              type="button"
              className={buttonVariants({ variant: 'primary', size: 'small' })}
              disabled={saving || !hasDraft}
              onClick={() => onSaveMarker(selectedArea.id)}
            >
              {saving ? 'Saving…' : 'Save position'}
            </button>
          </div>
          {saveError ? <FieldError>{saveError}</FieldError> : null}
        </div>
      ) : null}
      {saveMessage ? (
        <p className="fp-save-message" role="status">
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
