'use client';

import type { AdminPropertyArea } from '@texasrenters/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { apiBlob } from '@/lib/api';
import { useAdminMutations, useFloorPlans, usePropertyAreas, useUnits } from '@/lib/queries';

import { FloorPlanCanvas } from './floor-plan/FloorPlanCanvas';
import { FloorPlanChecklist } from './floor-plan/FloorPlanChecklist';
import { Badge, ErrorState, LoadingState, formatDate } from './ui';

const BUILDING_SCOPE = 'building-wide';
const EXTRACTION_STAGES = [
  'Reading labels across the full plan',
  'Separating floors and stories',
  'Building the room checklist',
  'Validating draft areas for review',
] as const;

export function FloorPlanManager({
  propertyId,
  canManage = false,
}: {
  propertyId: string;
  canManage?: boolean;
}) {
  const plans = useFloorPlans(propertyId);
  const areas = usePropertyAreas(propertyId);
  const units = useUnits(propertyId);
  const actions = useAdminMutations();
  const [scope, setScope] = useState(BUILDING_SCOPE);
  const [file, setFile] = useState<File>();
  const [fileInputVersion, setFileInputVersion] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [extractionSeconds, setExtractionSeconds] = useState(0);
  const [isComparisonOpen, setIsComparisonOpen] = useState(false);
  const activeUnits = useMemo(
    () => units.data?.items.filter((unit) => unit.isActive) ?? [],
    [units.data?.items],
  );
  const selectedUnitId = scope === BUILDING_SCOPE ? null : scope;
  const scopedPlans = useMemo(
    () => plans.data?.filter((plan) => (plan.unitId ?? null) === selectedUnitId) ?? [],
    [plans.data, selectedUnitId],
  );
  const scopedAreas = useMemo(
    () => areas.data?.filter((area) => (area.unitId ?? null) === selectedUnitId) ?? [],
    [areas.data, selectedUnitId],
  );
  const latest = scopedPlans[0];
  const drafts = useMemo(
    () => scopedAreas.filter((area) => area.status === 'DRAFT'),
    [scopedAreas],
  );
  const approved = useMemo(
    () => scopedAreas.filter((area) => area.status === 'APPROVED'),
    [scopedAreas],
  );
  const floorNames = useMemo(
    () =>
      [...new Set(scopedAreas.map((area) => area.floor?.name).filter(Boolean) as string[])].sort(
        (left, right) => left.localeCompare(right),
      ),
    [scopedAreas],
  );
  const draftGroups = useMemo(() => groupAreasByFloor(drafts), [drafts]);
  const approvedGroups = useMemo(() => groupAreasByFloor(approved), [approved]);
  const comparisonGroups = useMemo(() => groupAreasByFloor(scopedAreas), [scopedAreas]);
  const nextOrder =
    scopedAreas.reduce((highest, area) => Math.max(highest, area.inspectionOrder), 0) + 1;
  const scopeLabel =
    selectedUnitId === null
      ? 'Building-wide'
      : (activeUnits.find((unit) => unit.id === selectedUnitId)?.name ?? 'Selected unit');
  const closeComparison = useCallback(() => setIsComparisonOpen(false), []);

  useEffect(() => {
    if (scope !== BUILDING_SCOPE && !activeUnits.some((unit) => unit.id === scope)) {
      setScope(BUILDING_SCOPE);
    }
  }, [activeUnits, scope]);

  useEffect(() => {
    setFile(undefined);
    setMessage(undefined);
    setIsComparisonOpen(false);
  }, [scope]);

  useEffect(() => {
    if (!actions.extractFloorPlan.isPending) {
      setExtractionSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const updateElapsed = () =>
      setExtractionSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [actions.extractFloorPlan.isPending]);

  useEffect(() => {
    if (!latest) {
      setPreviewUrl(undefined);
      return;
    }
    setPreviewUrl(undefined);
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void apiBlob(`/api/v1/admin/floor-plans/${latest.id}/content`, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => setPreviewUrl(undefined));
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [latest]);

  if (plans.isLoading || areas.isLoading || units.isLoading) {
    return <LoadingState label="Loading floor plan…" />;
  }
  if (plans.isError) return <ErrorState error={plans.error} retry={() => void plans.refetch()} />;
  if (areas.isError) return <ErrorState error={areas.error} retry={() => void areas.refetch()} />;
  if (units.isError) return <ErrorState error={units.error} retry={() => void units.refetch()} />;

  const actionError = [
    actions.uploadFloorPlan.error,
    actions.extractFloorPlan.error,
    actions.createPropertyArea.error,
    actions.updatePropertyArea.error,
    actions.deletePropertyArea.error,
    actions.approvePropertyAreas.error,
  ].find(Boolean);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setMessage(undefined);
    try {
      await actions.uploadFloorPlan.mutateAsync({
        propertyId,
        file,
        unitId: selectedUnitId ?? undefined,
      });
      setFile(undefined);
      setFileInputVersion((version) => version + 1);
      setMessage(`${scopeLabel} floor plan uploaded securely. Extract areas or add them manually.`);
    } catch {
      // The mutation error is rendered in the workspace alert.
    }
  }

  async function extract() {
    if (!latest) return;
    setMessage(undefined);
    try {
      const result = await actions.extractFloorPlan.mutateAsync({
        propertyId,
        floorPlanId: latest.id,
      });
      const { detectedCount, createdCount, alreadyPresentCount } = result.summary;
      setMessage(
        `AI detected ${detectedCount} area${detectedCount === 1 ? '' : 's'}: ` +
          `${createdCount} added as new draft${createdCount === 1 ? '' : 's'} and ` +
          `${alreadyPresentCount} already present in this scope.`,
      );
    } catch {
      // The mutation error is rendered in the workspace alert.
    }
  }

  return (
    <section className="floor-plan-workspace section-gap" aria-labelledby="floor-plan-heading">
      <div className="floor-plan-scope" aria-label="Floor plan scope">
        <div>
          <strong>Plan and area scope</strong>
          <span>Manage a shared building layout or a plan specific to one unit.</span>
        </div>
        <div className="floor-plan-scope-options" role="group" aria-label="Select plan scope">
          <ScopeButton
            label="Building-wide"
            selected={scope === BUILDING_SCOPE}
            onSelect={() => setScope(BUILDING_SCOPE)}
          />
          {activeUnits.map((unit) => (
            <ScopeButton
              key={unit.id}
              label={unit.name}
              selected={scope === unit.id}
              onSelect={() => setScope(unit.id)}
            />
          ))}
        </div>
      </div>

      <div className="panel floor-plan-source">
        <div className="panel-header floor-plan-source-heading">
          <div>
            <span className="section-eyebrow">Inspection area source</span>
            <h2 id="floor-plan-heading">{scopeLabel} floor plan</h2>
            <p>
              Maintain the visual reference used to verify and approve this scope&apos;s inspection
              areas.
            </p>
          </div>
          {latest ? <Badge value={latest.status} /> : null}
        </div>
        <div className="floor-plan-grid">
          <div className="floor-plan-preview-shell">
            <div className="floor-plan-preview-toolbar">
              <div>
                <span className="floor-plan-preview-indicator" aria-hidden />
                <strong>Plan preview</strong>
              </div>
              {previewUrl && latest ? (
                <a href={previewUrl} target="_blank" rel="noreferrer">
                  Open original
                  <span aria-hidden>↗</span>
                </a>
              ) : null}
            </div>
            <div className="floor-plan-preview">
              {previewUrl && latest ? (
                <object data={previewUrl} type={latest.mimeType} aria-label={latest.fileName}>
                  <a href={previewUrl} target="_blank" rel="noreferrer">
                    Open {latest.fileName}
                  </a>
                </object>
              ) : (
                <div className="floor-plan-empty">
                  <span aria-hidden>⌗</span>
                  <strong>No {scopeLabel.toLowerCase()} floor plan uploaded</strong>
                  <p>Upload a PDF, PNG, or JPEG up to 20 MB.</p>
                </div>
              )}
            </div>
          </div>
          <div className="floor-plan-controls">
            {latest ? (
              <div className="floor-plan-file-card">
                <div className="floor-plan-file-card-heading">
                  <span className="floor-plan-file-icon" aria-hidden>
                    <svg viewBox="0 0 24 24">
                      <path d="M7 3.75h6.4L18 8.35v11.9H7z" />
                      <path d="M13.25 3.75v4.8H18M9.75 12h5.5M9.75 15.5h4" />
                    </svg>
                  </span>
                  <div>
                    <span>Current source file</span>
                    <strong>{latest.fileName}</strong>
                  </div>
                </div>
                <dl className="floor-plan-file-facts">
                  <div>
                    <dt>File size</dt>
                    <dd>{formatBytes(latest.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>Uploaded</dt>
                    <dd>{formatDate(latest.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Extraction</dt>
                    <dd>
                      {latest.extractionJobs?.[0]?.status.replaceAll('_', ' ') ?? 'Not started'}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}
            {canManage ? (
              <form onSubmit={(event) => void upload(event)} className="floor-plan-upload-section">
                <div className="floor-plan-control-heading">
                  <div>
                    <strong>{latest ? 'Replace source plan' : 'Upload source plan'}</strong>
                    <span>
                      {latest
                        ? 'A replacement becomes the new visual source after upload.'
                        : 'Add the visual source before defining inspection areas.'}
                    </span>
                  </div>
                </div>
                <label className="floor-plan-file-picker" htmlFor="floor-plan-file">
                  <input
                    key={`${scope}-${fileInputVersion}`}
                    id="floor-plan-file"
                    type="file"
                    accept="application/pdf,image/png,image/jpeg"
                    onChange={(event) => setFile(event.target.files?.[0])}
                  />
                  <span className="floor-plan-file-picker-icon" aria-hidden>
                    +
                  </span>
                  <span className="floor-plan-file-picker-copy">
                    <strong>{file ? file.name : 'Choose a PDF, PNG, or JPEG'}</strong>
                    <small>
                      {file
                        ? `${formatBytes(file.size)} selected`
                        : 'Secure upload · 20 MB maximum'}
                    </small>
                  </span>
                  <span className="floor-plan-file-picker-action">
                    {file ? 'Change file' : 'Browse'}
                  </span>
                </label>
                {file ? (
                  <button
                    className="button button-secondary floor-plan-upload-button"
                    type="submit"
                    disabled={actions.uploadFloorPlan.isPending}
                  >
                    {actions.uploadFloorPlan.isPending ? 'Uploading…' : 'Upload securely'}
                  </button>
                ) : null}
              </form>
            ) : null}

            {latest ? (
              <div className="floor-plan-review-section">
                <div className="floor-plan-control-heading">
                  <div>
                    <strong>Area review workflow</strong>
                    <span>
                      Extract suggestions, compare them, then approve the final checklist.
                    </span>
                  </div>
                  <span className="floor-plan-area-count">
                    {scopedAreas.length} area{scopedAreas.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="floor-plan-action-grid">
                  {canManage ? (
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => void extract()}
                      disabled={actions.extractFloorPlan.isPending}
                    >
                      {actions.extractFloorPlan.isPending ? (
                        <>
                          <span className="button-spinner" aria-hidden />
                          Extracting…
                        </>
                      ) : (
                        <>
                          <span aria-hidden>✦</span>
                          Extract areas with AI
                        </>
                      )}
                    </button>
                  ) : null}
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={() => setIsComparisonOpen(true)}
                    disabled={!scopedAreas.length || actions.extractFloorPlan.isPending}
                    title={
                      scopedAreas.length
                        ? 'Compare the source plan with extracted areas'
                        : 'Extract or define areas before comparing'
                    }
                  >
                    Compare plan &amp; areas
                    <span aria-hidden>→</span>
                  </button>
                </div>
                <div className="floor-plan-review-note">
                  <span aria-hidden>!</span>
                  <p>
                    AI suggestions remain drafts until an authorized administrator reviews and
                    approves every area in this scope.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {actionError ? (
          <div className="alert alert-danger" role="alert">
            {actionError instanceof Error
              ? actionError.message
              : 'The request could not be completed.'}
          </div>
        ) : null}
        {message ? <div className="alert alert-success">{message}</div> : null}
      </div>

      <div className="panel section-gap">
        <div className="panel-header">
          <div>
            <h2>{scopeLabel} draft area review</h2>
            <p>Edit AI suggestions or add missing rooms before approval.</p>
          </div>
          {canManage ? (
            <button
              className="button button-primary"
              disabled={!drafts.length || actions.approvePropertyAreas.isPending}
              onClick={() =>
                actions.approvePropertyAreas.mutate({
                  propertyId,
                  areaIds: drafts.map((area) => area.id),
                })
              }
            >
              {actions.approvePropertyAreas.isPending
                ? 'Approving…'
                : `Approve ${drafts.length || ''} draft${drafts.length === 1 ? '' : 's'}`}
            </button>
          ) : null}
        </div>
        {canManage ? (
          <ManualAreaForm
            key={scope}
            floorNames={floorNames}
            nextOrder={nextOrder}
            submitting={actions.createPropertyArea.isPending}
            onCreate={(input) =>
              actions.createPropertyArea.mutateAsync({
                propertyId,
                unitId: selectedUnitId ?? undefined,
                ...input,
              })
            }
          />
        ) : null}
        {draftGroups.length ? (
          <div className="floor-area-groups">
            {draftGroups.map((group) => (
              <section key={group.key} className="floor-area-group">
                <FloorGroupHeading label={group.label} count={group.areas.length} />
                <div className="area-review-list">
                  {group.areas.map((area) => (
                    <AreaReviewRow
                      key={area.id}
                      area={area}
                      floorNames={floorNames}
                      saving={actions.updatePropertyArea.isPending}
                      deleting={actions.deletePropertyArea.isPending}
                      readOnly={!canManage}
                      onReject={() =>
                        actions.rejectPropertyArea.mutateAsync({ propertyId, areaId: area.id })
                      }
                      onArchive={() =>
                        actions.archivePropertyArea.mutateAsync({ propertyId, areaId: area.id })
                      }
                      onSave={(input) =>
                        actions.updatePropertyArea.mutateAsync({
                          propertyId,
                          areaId: area.id,
                          ...input,
                        })
                      }
                      onDelete={() =>
                        actions.deletePropertyArea.mutateAsync({ propertyId, areaId: area.id })
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="floor-plan-muted">No draft areas are waiting for review in this scope.</p>
        )}
      </div>

      <div className="panel section-gap">
        <div className="panel-header">
          <div>
            <h2>{scopeLabel} approved master areas</h2>
            <p>Only these areas are copied into newly created inspections for this scope.</p>
          </div>
          <Badge value={`${approved.length} APPROVED`} />
        </div>
        {approvedGroups.length ? (
          <div className="floor-area-groups">
            {approvedGroups.map((group) => (
              <section key={group.key} className="floor-area-group">
                <FloorGroupHeading label={group.label} count={group.areas.length} />
                <div className="approved-area-grid">
                  {group.areas.map((area) => (
                    <article key={area.id}>
                      <strong>{area.name}</strong>
                      <small>
                        #{area.inspectionOrder} · {area.isRequired ? 'Required' : 'Optional'}
                      </small>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="floor-plan-muted">
            No areas are approved in this scope. Inspections require an approved master area list.
          </p>
        )}
      </div>
      {actions.extractFloorPlan.isPending ? (
        <ExtractionProgressModal elapsedSeconds={extractionSeconds} />
      ) : null}
      {isComparisonOpen && latest ? (
        <FloorPlanComparisonModal
          scopeLabel={scopeLabel}
          previewUrl={previewUrl}
          fileName={latest.fileName}
          mimeType={latest.mimeType}
          planId={latest.id}
          propertyId={propertyId}
          canManage={canManage}
          groups={comparisonGroups}
          onClose={closeComparison}
        />
      ) : null}
    </section>
  );
}

function ExtractionProgressModal({ elapsedSeconds }: { elapsedSeconds: number }) {
  const stageIndex = Math.min(Math.floor(elapsedSeconds / 8), EXTRACTION_STAGES.length - 1);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusDialog = () => dialogRef.current?.focus();
    const keepFocusInDialog = (event: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) {
        focusDialog();
      }
    };
    const lockKeyboardNavigation = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        focusDialog();
      }
    };

    document.body.style.overflow = 'hidden';
    focusDialog();
    document.addEventListener('focusin', keepFocusInDialog);
    document.addEventListener('keydown', lockKeyboardNavigation);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('focusin', keepFocusInDialog);
      document.removeEventListener('keydown', lockKeyboardNavigation);
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div className="floor-plan-extraction-backdrop">
      <div
        ref={dialogRef}
        className="floor-plan-extraction-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="floor-plan-extraction-title"
        aria-describedby="floor-plan-extraction-guidance"
        tabIndex={-1}
      >
        <div
          className="floor-plan-extraction-progress"
          role="status"
          aria-live="polite"
          aria-label={`Floor-plan extraction in progress. ${EXTRACTION_STAGES[stageIndex]}.`}
        >
          <div className="floor-plan-extraction-orbit" aria-hidden>
            <span />
            <strong>AI</strong>
          </div>
          <div className="floor-plan-extraction-copy">
            <div>
              <strong id="floor-plan-extraction-title">Analyzing the complete floor plan</strong>
              <span>{elapsedSeconds}s</span>
            </div>
            <p>{EXTRACTION_STAGES[stageIndex]}…</p>
            <div className="floor-plan-extraction-track" aria-hidden>
              <span />
            </div>
            <small id="floor-plan-extraction-guidance">
              Multi-story plans can take up to a minute. Keep this page open.
            </small>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FloorPlanComparisonModal({
  scopeLabel,
  previewUrl,
  fileName,
  mimeType,
  planId,
  propertyId,
  canManage,
  groups,
  onClose,
}: {
  scopeLabel: string;
  previewUrl?: string;
  fileName: string;
  mimeType: string;
  planId: string;
  propertyId: string;
  canManage: boolean;
  groups: ReturnType<typeof groupAreasByFloor>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const allAreas = groups.flatMap((group) => group.areas);
  const draftCount = allAreas.filter((area) => area.status === 'DRAFT').length;
  const approvedCount = allAreas.filter((area) => area.status === 'APPROVED').length;
  // Image plans and (rasterized) PDF pages both support the marker overlay.
  const supportsMarkers = mimeType.startsWith('image/') || mimeType === 'application/pdf';
  const isPdfPlan = mimeType === 'application/pdf';

  // Cross-pane marker state (single source of truth). Selection and marker
  // adjustment are separate from area approval — neither changes area status.
  const markerMutation = useAdminMutations().updateAreaMarker;
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [showAllMarkers, setShowAllMarkers] = useState(false);
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null);
  const [draftMarker, setDraftMarker] = useState<{ x: number; y: number } | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const backfill = useAdminMutations().retryMissingMarkers;
  const selectedArea = allAreas.find((area) => area.id === selectedAreaId) ?? null;
  // Areas with no usable marker for the plan currently displayed.
  const missingMarkerCount = allAreas.filter(
    (area) => !area.marker || area.sourceFloorPlanId !== planId,
  ).length;

  const selectArea = (id: string) => {
    setSelectedAreaId(id);
    setFocusNonce((nonce) => nonce + 1);
    if (editingAreaId && editingAreaId !== id) {
      setEditingAreaId(null);
      setDraftMarker(null);
      setSaveError(null);
    }
  };
  const startEdit = (id: string) => {
    const area = allAreas.find((item) => item.id === id);
    setSelectedAreaId(id);
    setEditingAreaId(id);
    setSaveError(null);
    setDraftMarker(
      area?.marker && area.sourceFloorPlanId === planId
        ? { x: area.marker.x, y: area.marker.y }
        : null,
    );
    setFocusNonce((nonce) => nonce + 1);
  };
  const cancelEdit = () => {
    setEditingAreaId(null);
    setDraftMarker(null);
    setSaveError(null);
  };
  const saveMarker = (id: string) => {
    if (!draftMarker) return;
    setSaveError(null);
    markerMutation.mutate(
      {
        propertyId,
        areaId: id,
        x: draftMarker.x,
        y: draftMarker.y,
        // PDF coordinates are relative to the page being viewed.
        ...(isPdfPlan ? { pageNumber } : {}),
      },
      {
        onSuccess: () => {
          setEditingAreaId(null);
          setDraftMarker(null);
        },
        onError: (error) =>
          setSaveError(
            error instanceof Error && error.message
              ? error.message
              : 'Unable to save marker position. Your previous position has not been changed.',
          ),
      },
    );
  };

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusDialog = () => closeButtonRef.current?.focus();
    const keepFocusInDialog = (event: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) {
        focusDialog();
      }
    };
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button, a[href]')];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = 'hidden';
    focusDialog();
    document.addEventListener('focusin', keepFocusInDialog);
    document.addEventListener('keydown', handleKeyboard);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('focusin', keepFocusInDialog);
      document.removeEventListener('keydown', handleKeyboard);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="floor-plan-comparison-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="floor-plan-comparison-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="floor-plan-comparison-title"
        tabIndex={-1}
      >
        <header className="floor-plan-comparison-header">
          <div>
            <span>Floor-plan review</span>
            <h2 id="floor-plan-comparison-title">Compare plan and extracted areas</h2>
            <p>{scopeLabel} · Verify every room before approving the area list.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="floor-plan-comparison-close"
            onClick={onClose}
            aria-label="Close floor-plan comparison"
          >
            ×
          </button>
        </header>

        <div className="floor-plan-comparison-content">
          <section className="floor-plan-comparison-pane floor-plan-comparison-plan">
            <div className="floor-plan-comparison-pane-header">
              <div>
                <span>Source floor plan</span>
                <strong>{fileName}</strong>
              </div>
              {previewUrl ? (
                <a href={previewUrl} target="_blank" rel="noreferrer">
                  Open original
                </a>
              ) : null}
            </div>
            <div className="floor-plan-comparison-canvas">
              {previewUrl ? (
                <FloorPlanCanvas
                  previewUrl={previewUrl}
                  fileName={fileName}
                  mimeType={mimeType}
                  planId={planId}
                  areas={allAreas}
                  selectedAreaId={selectedAreaId}
                  showAllMarkers={showAllMarkers}
                  editingAreaId={editingAreaId}
                  draftMarker={draftMarker}
                  focusNonce={focusNonce}
                  onSelectArea={selectArea}
                  onDraftChange={setDraftMarker}
                  pageNumber={pageNumber}
                  onPageChange={(page) => {
                    setPageNumber(page);
                    // A selection on another page is no longer meaningful.
                    setSelectedAreaId(null);
                    cancelEdit();
                  }}
                />
              ) : (
                <div className="floor-plan-comparison-unavailable">
                  <strong>Preview unavailable</strong>
                  <p>The floor plan could not be displayed in the comparison view.</p>
                </div>
              )}
            </div>
          </section>

          <aside className="floor-plan-comparison-pane floor-plan-comparison-areas">
            <div className="floor-plan-comparison-pane-header">
              <div>
                <span>Extracted checklist</span>
                <strong>
                  {allAreas.length} area{allAreas.length === 1 ? '' : 's'} across {groups.length}{' '}
                  floor{groups.length === 1 ? '' : 's'}
                </strong>
                <small>Review each extracted area against the source plan.</small>
              </div>
              <div className="floor-plan-comparison-counts" aria-label="Area review status">
                <span>{draftCount} drafts</span>
                <span>{approvedCount} approved</span>
              </div>
            </div>

            {canManage && supportsMarkers && missingMarkerCount > 0 ? (
              <div className="fp-backfill">
                <span>
                  {missingMarkerCount} area{missingMarkerCount === 1 ? '' : 's'} without a marker.
                </span>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={backfill.isPending}
                  onClick={() => {
                    setBackfillMessage(null);
                    backfill.mutate(
                      { propertyId, floorPlanId: planId },
                      {
                        onSuccess: (result) =>
                          setBackfillMessage(
                            `Added ${result.updated} marker${result.updated === 1 ? '' : 's'}` +
                              (result.unmatched
                                ? `; ${result.unmatched} still need manual placement.`
                                : '.'),
                          ),
                        onError: () =>
                          setBackfillMessage(
                            'Unable to backfill markers. Existing areas were not changed.',
                          ),
                      },
                    );
                  }}
                >
                  {backfill.isPending ? 'Backfilling…' : 'Backfill missing markers'}
                </button>
              </div>
            ) : null}
            {backfillMessage ? (
              <p className="fp-backfill-result" aria-live="polite">
                {backfillMessage}
              </p>
            ) : null}

            <p className="visually-hidden" aria-live="polite">
              {selectedArea ? `${selectedArea.name} selected` : ''}
            </p>
            <FloorPlanChecklist
              groups={groups}
              planId={planId}
              selectedAreaId={selectedAreaId}
              editingAreaId={editingAreaId}
              hasDraft={draftMarker !== null}
              canManage={canManage}
              showAllMarkers={showAllMarkers}
              supportsMarkers={supportsMarkers}
              saving={markerMutation.isPending}
              saveError={saveError}
              onSelectArea={selectArea}
              onToggleShowAll={() => setShowAllMarkers((value) => !value)}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSaveMarker={saveMarker}
            />
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}


function ScopeButton({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`floor-plan-scope-button${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

function FloorGroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="floor-area-heading">
      <h3>{label}</h3>
      <span>
        {count} area{count === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function ManualAreaForm({
  floorNames,
  nextOrder,
  submitting,
  onCreate,
}: {
  floorNames: string[];
  nextOrder: number;
  submitting: boolean;
  onCreate: (input: AreaInput) => Promise<unknown>;
}) {
  const [floorName, setFloorName] = useState('Ground Floor');
  const [name, setName] = useState('');
  const [isRequired, setIsRequired] = useState(true);
  return (
    <form
      className="manual-area-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({ floorName, name, inspectionOrder: nextOrder, isRequired })
          .then(() => setName(''))
          .catch(() => undefined);
      }}
    >
      <div className="field">
        <label htmlFor="manual-floor">Floor</label>
        <input
          id="manual-floor"
          list="manual-floor-options"
          value={floorName}
          onChange={(event) => setFloorName(event.target.value)}
        />
        <FloorOptions id="manual-floor-options" floorNames={floorNames} />
      </div>
      <div className="field field-grow">
        <label htmlFor="manual-area">Area name</label>
        <input
          id="manual-area"
          value={name}
          placeholder="e.g. Bedroom 1"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={isRequired}
          onChange={(event) => setIsRequired(event.target.checked)}
        />
        Required
      </label>
      <button
        className="button button-secondary"
        disabled={!floorName.trim() || !name.trim() || submitting}
      >
        Add draft area
      </button>
    </form>
  );
}

interface AreaInput {
  floorName: string;
  name: string;
  inspectionOrder: number;
  isRequired: boolean;
}

function AreaReviewRow({
  area,
  floorNames,
  saving,
  deleting,
  readOnly,
  onSave,
  onDelete,
  onReject,
  onArchive,
}: {
  area: AdminPropertyArea;
  floorNames: string[];
  saving: boolean;
  deleting: boolean;
  readOnly: boolean;
  onSave: (input: AreaInput) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onReject: () => Promise<unknown>;
  onArchive: () => Promise<unknown>;
}) {
  const environmentLabel = area.environment
    ? area.environment.replace('_', '-').toLowerCase()
    : null;
  const [floorName, setFloorName] = useState(area.floor?.name ?? '');
  const [name, setName] = useState(area.name);
  const [inspectionOrder, setInspectionOrder] = useState(area.inspectionOrder);
  const [isRequired, setIsRequired] = useState(area.isRequired);
  const floorOptionsId = `floor-options-${area.id}`;
  return (
    <article className="area-review-row">
      <div className="field">
        <label htmlFor={`floor-${area.id}`}>Floor</label>
        <input
          id={`floor-${area.id}`}
          list={floorOptionsId}
          value={floorName}
          disabled={readOnly}
          onChange={(event) => setFloorName(event.target.value)}
        />
        <FloorOptions id={floorOptionsId} floorNames={floorNames} />
      </div>
      <div className="field field-grow">
        <label htmlFor={`area-${area.id}`}>Area</label>
        <input
          id={`area-${area.id}`}
          value={name}
          disabled={readOnly}
          onChange={(event) => setName(event.target.value)}
        />
        <small className="cell-note">
          {environmentLabel ? `${environmentLabel} · ` : ''}
          {area.source === 'TECHNICIAN' ? 'Technician-added' : area.source.toLowerCase()}
          {area.createdBy ? ` · by ${area.createdBy.displayName}` : ''}
        </small>
      </div>
      <div className="field area-order-field">
        <label htmlFor={`order-${area.id}`}>Order</label>
        <input
          id={`order-${area.id}`}
          type="number"
          min={1}
          value={inspectionOrder}
          disabled={readOnly}
          onChange={(event) => setInspectionOrder(Number(event.target.value))}
        />
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={isRequired}
          disabled={readOnly}
          onChange={(event) => setIsRequired(event.target.checked)}
        />
        Required
      </label>
      {!readOnly ? (
        <div className="action-row">
          <button
            className="button button-secondary button-small"
            disabled={saving || !floorName.trim() || !name.trim() || inspectionOrder < 1}
            onClick={() =>
              void onSave({ floorName, name, inspectionOrder, isRequired }).catch(() => undefined)
            }
          >
            Save
          </button>
          {area.status === 'DRAFT' ? (
            <button
              className="button button-secondary button-small"
              disabled={saving}
              onClick={() => void onReject().catch(() => undefined)}
            >
              Reject
            </button>
          ) : null}
          <button
            className="button button-secondary button-small"
            disabled={saving}
            onClick={() => void onArchive().catch(() => undefined)}
          >
            Archive
          </button>
          <button
            className="button button-danger button-small"
            disabled={deleting}
            onClick={() => void onDelete().catch(() => undefined)}
          >
            Remove
          </button>
        </div>
      ) : null}
    </article>
  );
}

function FloorOptions({ id, floorNames }: { id: string; floorNames: string[] }) {
  return (
    <datalist id={id}>
      {floorNames.map((floorName) => (
        <option key={floorName} value={floorName} />
      ))}
    </datalist>
  );
}

function groupAreasByFloor(areas: AdminPropertyArea[]) {
  const groups = new Map<
    string,
    { key: string; label: string; sortOrder: number; areas: AdminPropertyArea[] }
  >();
  for (const area of areas) {
    const key = area.floor?.id ?? 'no-floor';
    const existing = groups.get(key);
    if (existing) existing.areas.push(area);
    else {
      groups.set(key, {
        key,
        label: area.floor?.name ?? 'No floor',
        sortOrder: area.floor?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        areas: [area],
      });
    }
  }
  return [...groups.values()]
    .sort(
      (left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label),
    )
    .map((group) => ({
      ...group,
      areas: [...group.areas].sort(
        (left, right) =>
          left.inspectionOrder - right.inspectionOrder || left.name.localeCompare(right.name),
      ),
    }));
}

function formatBytes(value: number) {
  if (value < 1_000_000) return `${Math.max(1, Math.round(value / 1_000))} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
