'use client';

import type { AdminPropertyArea } from '@texasrenters/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { apiBlob } from '@/lib/api';
import { useAdminMutations, useFloorPlans, usePropertyAreas, useUnits } from '@/lib/queries';

import { Badge, ErrorState, LoadingState, formatDate } from './ui';

const BUILDING_SCOPE = 'building-wide';

export function FloorPlanManager({ propertyId }: { propertyId: string }) {
  const plans = useFloorPlans(propertyId);
  const areas = usePropertyAreas(propertyId);
  const units = useUnits(propertyId);
  const actions = useAdminMutations();
  const [scope, setScope] = useState(BUILDING_SCOPE);
  const [file, setFile] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const activeUnits = useMemo(
    () => units.data?.items.filter((unit) => unit.isActive) ?? [],
    [units.data?.items],
  );
  const selectedUnitId = scope === BUILDING_SCOPE ? null : scope;
  const scopedPlans = useMemo(
    () =>
      plans.data?.filter((plan) => (plan.unitId ?? null) === selectedUnitId) ?? [],
    [plans.data, selectedUnitId],
  );
  const scopedAreas = useMemo(
    () =>
      areas.data?.filter((area) => (area.unitId ?? null) === selectedUnitId) ?? [],
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
  const nextOrder =
    scopedAreas.reduce((highest, area) => Math.max(highest, area.inspectionOrder), 0) + 1;
  const scopeLabel =
    selectedUnitId === null
      ? 'Building-wide'
      : (activeUnits.find((unit) => unit.id === selectedUnitId)?.name ?? 'Selected unit');

  useEffect(() => {
    if (scope !== BUILDING_SCOPE && !activeUnits.some((unit) => unit.id === scope)) {
      setScope(BUILDING_SCOPE);
    }
  }, [activeUnits, scope]);

  useEffect(() => {
    setFile(undefined);
    setMessage(undefined);
  }, [scope]);

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
      setMessage(`${scopeLabel} floor plan uploaded securely. Extract areas or add them manually.`);
    } catch {
      // The mutation error is rendered in the workspace alert.
    }
  }

  async function extract() {
    if (!latest) return;
    setMessage(undefined);
    try {
      await actions.extractFloorPlan.mutateAsync({ propertyId, floorPlanId: latest.id });
      setMessage(`${scopeLabel} area suggestions are ready for human review.`);
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
        <div className="panel-header">
          <div>
            <h2 id="floor-plan-heading">{scopeLabel} floor plan</h2>
            <p>Use the latest plan in this scope as the source for its approved area list.</p>
          </div>
          {latest ? <Badge value={latest.status} /> : null}
        </div>
        <div className="floor-plan-grid">
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
          <div className="floor-plan-controls">
            {latest ? (
              <div className="floor-plan-file-card">
                <strong>{latest.fileName}</strong>
                <span>
                  {formatBytes(latest.sizeBytes)} · uploaded {formatDate(latest.createdAt)}
                </span>
                {latest.extractionJobs?.[0] ? (
                  <small>
                    Latest extraction: {latest.extractionJobs[0].status.replaceAll('_', ' ')}
                  </small>
                ) : null}
              </div>
            ) : null}
            <form onSubmit={(event) => void upload(event)} className="stack">
              <div className="field">
                <label htmlFor="floor-plan-file">
                  {latest ? `Replace ${scopeLabel.toLowerCase()} plan` : `Upload for ${scopeLabel}`}
                </label>
                <input
                  key={scope}
                  id="floor-plan-file"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg"
                  onChange={(event) => setFile(event.target.files?.[0])}
                />
              </div>
              <div className="action-row">
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={!file || actions.uploadFloorPlan.isPending}
                >
                  {actions.uploadFloorPlan.isPending ? 'Uploading…' : 'Upload securely'}
                </button>
                {latest ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => void extract()}
                    disabled={actions.extractFloorPlan.isPending || latest.status === 'PROCESSING'}
                  >
                    {actions.extractFloorPlan.isPending ? 'Extracting…' : 'Extract areas with AI'}
                  </button>
                ) : null}
              </div>
            </form>
            <div className="alert alert-warning">
              AI suggestions remain drafts. An authorized administrator must review and approve
              every area in this scope.
            </div>
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
        </div>
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
    </section>
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
  onSave,
  onDelete,
}: {
  area: AdminPropertyArea;
  floorNames: string[];
  saving: boolean;
  deleting: boolean;
  onSave: (input: AreaInput) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
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
          onChange={(event) => setFloorName(event.target.value)}
        />
        <FloorOptions id={floorOptionsId} floorNames={floorNames} />
      </div>
      <div className="field field-grow">
        <label htmlFor={`area-${area.id}`}>Area</label>
        <input
          id={`area-${area.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field area-order-field">
        <label htmlFor={`order-${area.id}`}>Order</label>
        <input
          id={`order-${area.id}`}
          type="number"
          min={1}
          value={inspectionOrder}
          onChange={(event) => setInspectionOrder(Number(event.target.value))}
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
        <button
          className="button button-danger button-small"
          disabled={deleting}
          onClick={() => void onDelete().catch(() => undefined)}
        >
          Remove
        </button>
      </div>
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
    .sort((left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label))
    .map((group) => ({
      ...group,
      areas: [...group.areas].sort(
        (left, right) => left.inspectionOrder - right.inspectionOrder || left.name.localeCompare(right.name),
      ),
    }));
}

function formatBytes(value: number) {
  if (value < 1_000_000) return `${Math.max(1, Math.round(value / 1_000))} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
