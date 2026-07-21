'use client';

import type { AdminPropertyArea } from '@texasrenters/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { apiBlob } from '@/lib/api';
import { useAdminMutations, useFloorPlans, usePropertyAreas } from '@/lib/queries';

import { Badge, ErrorState, LoadingState, formatDate } from './ui';

export function FloorPlanManager({ propertyId }: { propertyId: string }) {
  const plans = useFloorPlans(propertyId);
  const areas = usePropertyAreas(propertyId);
  const actions = useAdminMutations();
  const [file, setFile] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const latest = plans.data?.[0];
  const drafts = useMemo(
    () => areas.data?.filter((area) => area.status === 'DRAFT') ?? [],
    [areas.data],
  );
  const approved = useMemo(
    () => areas.data?.filter((area) => area.status === 'APPROVED') ?? [],
    [areas.data],
  );

  useEffect(() => {
    if (!latest) {
      setPreviewUrl(undefined);
      return;
    }
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

  if (plans.isLoading || areas.isLoading) return <LoadingState label="Loading floor plan…" />;
  if (plans.isError) return <ErrorState error={plans.error} retry={() => void plans.refetch()} />;
  if (areas.isError) return <ErrorState error={areas.error} retry={() => void areas.refetch()} />;

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
      await actions.uploadFloorPlan.mutateAsync({ propertyId, file });
      setFile(undefined);
      setMessage('Floor plan uploaded securely. Extract areas or add them manually.');
    } catch {
      // The mutation error is rendered in the workspace alert.
    }
  }

  async function extract() {
    if (!latest) return;
    setMessage(undefined);
    try {
      await actions.extractFloorPlan.mutateAsync({ propertyId, floorPlanId: latest.id });
      setMessage('Area suggestions are ready for human review.');
    } catch {
      // The mutation error is rendered in the workspace alert.
    }
  }

  return (
    <section className="floor-plan-workspace section-gap" aria-labelledby="floor-plan-heading">
      <div className="panel floor-plan-source">
        <div className="panel-header">
          <div>
            <h2 id="floor-plan-heading">Floor plan</h2>
            <p>Use the latest property plan as the source for the approved inspection-area list.</p>
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
                <strong>No floor plan uploaded</strong>
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
                  {latest ? 'Replace with a newer floor plan' : 'Upload floor plan'}
                </label>
                <input
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
              every area.
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
            <h2>Draft area review</h2>
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
          nextOrder={(areas.data?.length ?? 0) + 1}
          submitting={actions.createPropertyArea.isPending}
          onCreate={(input) => actions.createPropertyArea.mutateAsync({ propertyId, ...input })}
        />
        {drafts.length ? (
          <div className="area-review-list">
            {drafts.map((area) => (
              <AreaReviewRow
                key={area.id}
                area={area}
                saving={actions.updatePropertyArea.isPending}
                deleting={actions.deletePropertyArea.isPending}
                onSave={(input) =>
                  actions.updatePropertyArea.mutateAsync({ propertyId, areaId: area.id, ...input })
                }
                onDelete={() =>
                  actions.deletePropertyArea.mutateAsync({ propertyId, areaId: area.id })
                }
              />
            ))}
          </div>
        ) : (
          <p className="floor-plan-muted">No draft areas are waiting for review.</p>
        )}
      </div>

      <div className="panel section-gap">
        <div className="panel-header">
          <div>
            <h2>Approved master areas</h2>
            <p>Only these areas are copied into newly created inspections.</p>
          </div>
          <Badge value={`${approved.length} APPROVED`} />
        </div>
        {approved.length ? (
          <div className="approved-area-grid">
            {approved.map((area) => (
              <article key={area.id}>
                <span>{area.floor?.name ?? 'Ground Floor'}</span>
                <strong>{area.name}</strong>
                <small>
                  #{area.inspectionOrder} · {area.isRequired ? 'Required' : 'Optional'}
                </small>
              </article>
            ))}
          </div>
        ) : (
          <p className="floor-plan-muted">
            No areas are approved yet. Inspections require an approved master area list.
          </p>
        )}
      </div>
    </section>
  );
}

function ManualAreaForm({
  nextOrder,
  submitting,
  onCreate,
}: {
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
        <input id="manual-floor" value={floorName} onChange={(e) => setFloorName(e.target.value)} />
      </div>
      <div className="field field-grow">
        <label htmlFor="manual-area">Area name</label>
        <input
          id="manual-area"
          value={name}
          placeholder="e.g. Bedroom 1"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={isRequired}
          onChange={(e) => setIsRequired(e.target.checked)}
        />
        Required
      </label>
      <button className="button button-secondary" disabled={!name.trim() || submitting}>
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
  saving,
  deleting,
  onSave,
  onDelete,
}: {
  area: AdminPropertyArea;
  saving: boolean;
  deleting: boolean;
  onSave: (input: AreaInput) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [floorName, setFloorName] = useState(area.floor?.name ?? 'Ground Floor');
  const [name, setName] = useState(area.name);
  const [inspectionOrder, setInspectionOrder] = useState(area.inspectionOrder);
  const [isRequired, setIsRequired] = useState(area.isRequired);
  return (
    <article className="area-review-row">
      <div className="field">
        <label htmlFor={`floor-${area.id}`}>Floor</label>
        <input
          id={`floor-${area.id}`}
          value={floorName}
          onChange={(e) => setFloorName(e.target.value)}
        />
      </div>
      <div className="field field-grow">
        <label htmlFor={`area-${area.id}`}>Area</label>
        <input id={`area-${area.id}`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field area-order-field">
        <label htmlFor={`order-${area.id}`}>Order</label>
        <input
          id={`order-${area.id}`}
          type="number"
          min={1}
          value={inspectionOrder}
          onChange={(e) => setInspectionOrder(Number(e.target.value))}
        />
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={isRequired}
          onChange={(e) => setIsRequired(e.target.checked)}
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

function formatBytes(value: number) {
  if (value < 1_000_000) return `${Math.max(1, Math.round(value / 1_000))} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
