import { type PointerEvent as ReactPointerEvent } from 'react';

import { AreaMarker } from './AreaMarker';
import { markerToBase } from './floor-plan-geometry';
import type { ContainRect } from './types';

export interface MarkerAreaItem {
  id: string;
  name: string;
  x: number;
  y: number;
  orderLabel?: number;
  source?: string | null;
}

interface FloorPlanMarkerLayerProps {
  rect: ContainRect;
  zoom: number;
  markers: MarkerAreaItem[];
  selectedAreaId: string | null;
  showAllMarkers: boolean;
  editingAreaId: string | null;
  draft: { id: string; name: string; x: number; y: number } | null;
  focusNonce: number;
  onSelectArea: (id: string) => void;
  onNudge: (dirX: number, dirY: number, large: boolean) => void;
  onDragPointerDown: (event: ReactPointerEvent) => void;
}

export function FloorPlanMarkerLayer({
  rect,
  zoom,
  markers,
  selectedAreaId,
  showAllMarkers,
  editingAreaId,
  draft,
  focusNonce,
  onSelectArea,
  onNudge,
  onDragPointerDown,
}: FloorPlanMarkerLayerProps) {
  const visible = showAllMarkers
    ? markers
    : markers.filter((marker) => marker.id === selectedAreaId);

  return (
    <div className="pointer-events-none absolute inset-0 [&>button]:pointer-events-auto">
      {visible.map((marker) => {
        // The area being edited is rendered as the draft below.
        if (marker.id === editingAreaId && draft) return null;
        const base = markerToBase(rect, marker.x, marker.y);
        return (
          <AreaMarker
            key={marker.id}
            id={marker.id}
            name={marker.name}
            left={base.left}
            top={base.top}
            zoom={zoom}
            selected={marker.id === selectedAreaId}
            quiet={showAllMarkers && marker.id !== selectedAreaId}
            orderLabel={marker.orderLabel}
            source={marker.source}
            normalizedX={marker.x}
            normalizedY={marker.y}
            pulseKey={marker.id === selectedAreaId ? focusNonce : undefined}
            onSelect={() => onSelectArea(marker.id)}
          />
        );
      })}
      {draft
        ? (() => {
            const base = markerToBase(rect, draft.x, draft.y);
            return (
              <AreaMarker
                key={`draft-${draft.id}`}
                id={draft.id}
                name={draft.name}
                left={base.left}
                top={base.top}
                zoom={zoom}
                selected
                editing
                source="ADMIN_ADJUSTED"
                normalizedX={draft.x}
                normalizedY={draft.y}
                pulseKey={focusNonce}
                onSelect={() => onSelectArea(draft.id)}
                onNudge={onNudge}
                onDragPointerDown={onDragPointerDown}
              />
            );
          })()
        : null}
    </div>
  );
}
