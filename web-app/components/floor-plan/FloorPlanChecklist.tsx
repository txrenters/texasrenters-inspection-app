import type { AdminPropertyArea } from '@texasrenters/shared';

export interface AreaFloorGroup {
  key: string;
  label: string;
  areas: AdminPropertyArea[];
}

interface FloorPlanChecklistProps {
  groups: AreaFloorGroup[];
  planId: string;
  selectedAreaId: string | null;
  editingAreaId: string | null;
  hasDraft: boolean;
  canManage: boolean;
  showAllMarkers: boolean;
  supportsMarkers: boolean;
  saving: boolean;
  saveError: string | null;
  onSelectArea: (id: string) => void;
  onToggleShowAll: () => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveMarker: (id: string) => void;
}

export function FloorPlanChecklist({
  groups,
  planId,
  selectedAreaId,
  editingAreaId,
  hasDraft,
  canManage,
  showAllMarkers,
  supportsMarkers,
  saving,
  saveError,
  onSelectArea,
  onToggleShowAll,
  onStartEdit,
  onCancelEdit,
  onSaveMarker,
}: FloorPlanChecklistProps) {
  return (
    <div className="floor-plan-comparison-list">
      {supportsMarkers ? (
        <label className="fp-showall-toggle">
          <input type="checkbox" checked={showAllMarkers} onChange={onToggleShowAll} />
          <span>Show all markers</span>
        </label>
      ) : null}
      {groups.map((group) => (
        <section key={group.key} className="floor-plan-comparison-floor">
          <header>
            <h3>{group.label}</h3>
            <span>{group.areas.length}</span>
          </header>
          <ol>
            {group.areas.map((area) => {
              const selected = area.id === selectedAreaId;
              const editing = area.id === editingAreaId;
              const markerAvailable =
                Boolean(area.marker) && area.sourceFloorPlanId === planId;
              return (
                <li key={area.id}>
                  <button
                    type="button"
                    id={`fp-row-${area.id}`}
                    className={`floor-plan-comparison-area-button${selected ? ' is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => onSelectArea(area.id)}
                  >
                    <span className="floor-plan-comparison-order">{area.inspectionOrder}</span>
                    <span className="floor-plan-comparison-area-copy">
                      <strong>{area.name}</strong>
                      <small>
                        {area.isRequired ? 'Required' : 'Optional'}
                        {supportsMarkers
                          ? markerAvailable
                            ? ' · marker set'
                            : ' · marker not available'
                          : ''}
                      </small>
                    </span>
                    <span
                      className={`floor-plan-comparison-status is-${area.status.toLowerCase()}`}
                    >
                      {area.status.replaceAll('_', ' ')}
                    </span>
                  </button>
                  {selected && canManage && supportsMarkers ? (
                    <div className="fp-row-actions">
                      {editing ? (
                        <>
                          <button
                            type="button"
                            className="button button-primary button-small"
                            disabled={saving || !hasDraft}
                            onClick={() => onSaveMarker(area.id)}
                          >
                            {saving ? 'Saving…' : 'Save position'}
                          </button>
                          <button
                            type="button"
                            className="button button-secondary button-small"
                            onClick={onCancelEdit}
                          >
                            Cancel
                          </button>
                          <span className="fp-row-hint">Drag the marker, click the plan, or use arrow keys.</span>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          onClick={() => onStartEdit(area.id)}
                        >
                          {markerAvailable ? 'Adjust marker' : 'Place marker'}
                        </button>
                      )}
                    </div>
                  ) : null}
                  {editing && saveError ? <p className="field-error">{saveError}</p> : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
