'use client';

import type { AdminPropertyArea } from '@texasrenters/shared';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { FloorPlanMarkerLayer, type MarkerAreaItem } from './FloorPlanMarkerLayer';
import { FloorPlanPageSelector } from './FloorPlanPageSelector';
import { FloorPlanZoomControls } from './FloorPlanZoomControls';
import {
  centerOnMarker,
  clamp01,
  clampZoom,
  clientToNormalized,
  fitBoundingBox,
  nudgeStep,
} from './floor-plan-geometry';
import { useImageRect } from './useImageRect';
import { usePdfPageImage } from './usePdfPageImage';

interface FloorPlanCanvasProps {
  previewUrl?: string;
  fileName: string;
  mimeType: string;
  planId: string;
  areas: AdminPropertyArea[];
  selectedAreaId: string | null;
  showAllMarkers: boolean;
  editingAreaId: string | null;
  draftMarker: { x: number; y: number } | null;
  focusNonce: number;
  onSelectArea: (id: string) => void;
  onDraftChange: (next: { x: number; y: number }) => void;
  /** Active PDF page (1-based); ignored for image plans. */
  pageNumber?: number;
  onPageChange?: (page: number) => void;
}

export function FloorPlanCanvas({
  previewUrl,
  fileName,
  mimeType,
  planId,
  areas,
  selectedAreaId,
  showAllMarkers,
  editingAreaId,
  draftMarker,
  focusNonce,
  onSelectArea,
  onDraftChange,
  pageNumber = 1,
  onPageChange,
}: FloorPlanCanvasProps) {
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  // A PDF page is rasterized to an image so it flows through exactly the same
  // geometry as an image plan; normalized coordinates stay page-relative.
  const pdfPage = usePdfPageImage(previewUrl, pageNumber, isPdf);
  const sourceUrl = isPdf ? pdfPage.imageUrl : previewUrl;
  const supportsMarkers = isImage || isPdf;
  const stageRef = useRef<HTMLDivElement | null>(null);
  // State-backed so measurement restarts when the stage mounts late (PDF plans
  // only render it once the page is rasterized).
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const attachStage = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    setStageEl(node);
  }, []);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const { rect, container, onImageLoad } = useImageRect(stageEl, imgRef, sourceUrl);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [smooth, setSmooth] = useState(true);
  const [imgError, setImgError] = useState(false);

  // Markers belonging to THIS plan version only (source-version safety), and for
  // PDFs only those on the page being viewed. A legacy marker with no recorded
  // page is treated as page 1 so it stays reachable.
  const markers: MarkerAreaItem[] = areas
    .filter((area) => area.marker && area.sourceFloorPlanId === planId)
    .filter((area) => !isPdf || (area.sourcePageNumber ?? 1) === pageNumber)
    .map((area) => ({
      id: area.id,
      name: area.name,
      x: area.marker!.x,
      y: area.marker!.y,
      orderLabel: area.inspectionOrder,
    }));
  const editingArea = editingAreaId ? areas.find((area) => area.id === editingAreaId) : undefined;
  const draft =
    editingAreaId && draftMarker
      ? { id: editingAreaId, name: editingArea?.name ?? 'Marker', x: draftMarker.x, y: draftMarker.y }
      : null;

  // Latest-values refs so the focus effect doesn't re-run on every zoom/pan tick.
  const refs = useRef({ rect, zoom, pan, container, markers, draft, selectedAreaId, editingAreaId });
  refs.current = { rect, zoom, pan, container, markers, draft, selectedAreaId, editingAreaId };

  const centerSelected = useCallback(() => {
    const state = refs.current;
    if (!state.rect) return;
    const point = state.draft
      ? { x: state.draft.x, y: state.draft.y }
      : (() => {
          const marker = state.markers.find((item) => item.id === state.selectedAreaId);
          return marker ? { x: marker.x, y: marker.y } : null;
        })();
    if (!point) return;
    setSmooth(true);
    setPan(centerOnMarker(state.rect, point, state.container.w, state.container.h, state.zoom));
  }, []);

  // Pan the selected area's marker into view on (re)selection or focus request.
  useEffect(() => {
    centerSelected();
    // Boolean(rect) so a selection made before the image loaded still centres once
    // the image is measured.
  }, [selectedAreaId, focusNonce, Boolean(rect), centerSelected]);

  const zoomAbout = useCallback((screenX: number, screenY: number, nextZoom: number, animate: boolean) => {
    const state = refs.current;
    const nz = clampZoom(nextZoom);
    const baseX = (screenX - state.pan.x) / state.zoom;
    const baseY = (screenY - state.pan.y) / state.zoom;
    setSmooth(animate);
    setZoom(nz);
    setPan(nz <= 1 ? { x: 0, y: 0 } : { x: screenX - nz * baseX, y: screenY - nz * baseY });
  }, []);

  const centreOfStage = () => ({ x: refs.current.container.w / 2, y: refs.current.container.h / 2 });

  const handleZoomIn = () => {
    const c = centreOfStage();
    zoomAbout(c.x, c.y, refs.current.zoom * 1.3, true);
  };
  const handleZoomOut = () => {
    const c = centreOfStage();
    zoomAbout(c.x, c.y, refs.current.zoom / 1.3, true);
  };
  const handleReset = () => {
    setSmooth(true);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const handleFocusSelected = () => {
    const state = refs.current;
    if (!state.rect) return;
    const area = areas.find((item) => item.id === state.selectedAreaId);
    if (area?.boundingBox) {
      const transform = fitBoundingBox(
        state.rect,
        area.boundingBox,
        state.container.w,
        state.container.h,
      );
      setSmooth(true);
      setZoom(transform.zoom);
      setPan(transform.pan);
      return;
    }
    const marker = state.markers.find((item) => item.id === state.selectedAreaId);
    const point = state.draft ?? (marker ? { x: marker.x, y: marker.y } : null);
    if (!point) return;
    const nextZoom = Math.max(state.zoom, 2);
    setSmooth(true);
    setZoom(nextZoom);
    setPan(centerOnMarker(state.rect, point, state.container.w, state.container.h, nextZoom));
  };

  // Wheel zoom about the cursor (native listener so preventDefault is allowed).
  useEffect(() => {
    const stage = stageEl;
    if (!stage || !supportsMarkers) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAbout(event.clientX - box.left, event.clientY - box.top, refs.current.zoom * factor, false);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [stageEl, supportsMarkers, zoomAbout]);

  // Background pan (pointer) when not editing; place-on-click when editing.
  const panState = useRef<{ startX: number; startY: number; startPan: { x: number; y: number }; moved: boolean } | null>(
    null,
  );
  const placeFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const stage = stageRef.current;
      const state = refs.current;
      if (!stage || !state.rect) return;
      const box = stage.getBoundingClientRect();
      const normalized = clientToNormalized(
        clientX,
        clientY,
        { left: box.left, top: box.top },
        { zoom: state.zoom, pan: state.pan },
        state.rect,
      );
      if (!normalized) return;
      onDraftChange({ x: clamp01(normalized.x), y: clamp01(normalized.y) });
    },
    [onDraftChange],
  );

  const handleStagePointerDown = (event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest('.fp-marker')) return; // markers self-handle
    panState.current = {
      startX: event.clientX,
      startY: event.clientY,
      startPan: refs.current.pan,
      moved: false,
    };
    if (!editingAreaId && refs.current.zoom > 1) {
      setSmooth(false);
      stageRef.current?.setPointerCapture(event.pointerId);
    }
  };
  const handleStagePointerMove = (event: ReactPointerEvent) => {
    const drag = panState.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!editingAreaId && refs.current.zoom > 1)
      setPan({ x: drag.startPan.x + dx, y: drag.startPan.y + dy });
  };
  const handleStagePointerUp = (event: ReactPointerEvent) => {
    const drag = panState.current;
    panState.current = null;
    stageRef.current?.releasePointerCapture?.(event.pointerId);
    if (editingAreaId && drag && !drag.moved) placeFromClient(event.clientX, event.clientY);
  };

  // Draft marker drag (window listeners so the drag survives leaving the stage).
  const handleDraftPointerDown = (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const move = (moveEvent: PointerEvent) => placeFromClient(moveEvent.clientX, moveEvent.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handleNudge = (dirX: number, dirY: number, large: boolean) => {
    const state = refs.current;
    if (!state.rect || !state.draft) return;
    const step = nudgeStep(state.rect, state.zoom, large ? 10 : 1);
    onDraftChange({
      x: clamp01(state.draft.x + dirX * step),
      y: clamp01(state.draft.y + dirY * step),
    });
  };

  // Formats we cannot rasterize keep the plain embed and no overlay.
  if (!supportsMarkers) {
    return (
      <div className="fp-canvas">
        <div className="floor-plan-comparison-image-stage">
          {previewUrl ? (
            <object data={previewUrl} type={mimeType} aria-label={fileName} />
          ) : (
            <p className="floor-plan-comparison-empty">Preview unavailable.</p>
          )}
        </div>
        <p className="fp-canvas-note">Markers are unavailable for this file type.</p>
      </div>
    );
  }

  if (isPdf && !sourceUrl) {
    return (
      <div className="fp-canvas">
        <div className="floor-plan-comparison-image-stage">
          <p className="floor-plan-comparison-empty">
            {pdfPage.error ?? 'Rendering the PDF page…'}
          </p>
        </div>
        {pdfPage.error && previewUrl ? (
          <p className="fp-canvas-note">
            <a href={previewUrl} target="_blank" rel="noreferrer">
              Open the original PDF
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  const transformStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: '0 0',
    transition: smooth ? 'transform 180ms ease' : 'none',
  };

  return (
    <div className="fp-canvas">
      <div
        ref={attachStage}
        className="floor-plan-comparison-image-stage fp-stage"
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        data-editing={editingAreaId ? 'true' : undefined}
      >
        {sourceUrl && !imgError ? (
          <div className="fp-transform" style={transformStyle}>
            {/* Blob URLs require the native element and cannot use next/image. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={sourceUrl}
              alt={fileName}
              draggable={false}
              onLoad={onImageLoad}
              onError={() => setImgError(true)}
            />
            {rect ? (
              <FloorPlanMarkerLayer
                rect={rect}
                zoom={zoom}
                markers={markers}
                selectedAreaId={selectedAreaId}
                showAllMarkers={showAllMarkers}
                editingAreaId={editingAreaId}
                draft={draft}
                focusNonce={focusNonce}
                onSelectArea={onSelectArea}
                onNudge={handleNudge}
                onDragPointerDown={handleDraftPointerDown}
              />
            ) : null}
          </div>
        ) : (
          <p className="floor-plan-comparison-empty">Preview unavailable.</p>
        )}
      </div>
      <div className="fp-canvas-toolbar">
        <FloorPlanZoomControls
          zoom={zoom}
          hasSelection={Boolean(selectedAreaId)}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onReset={handleReset}
          onFocusSelected={handleFocusSelected}
        />
        {isPdf && onPageChange ? (
          <FloorPlanPageSelector
            pageNumber={pageNumber}
            pageCount={pdfPage.pageCount}
            onChange={onPageChange}
          />
        ) : null}
      </div>
    </div>
  );
}
