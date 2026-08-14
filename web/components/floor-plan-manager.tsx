'use client';

import type { AdminPropertyArea } from '@texasrenters/shared';
import {
  FileTextIcon,
  ExternalLinkIcon,
  InfoIcon,
  SparklesIcon,
  UploadIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { SectionHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { apiBlob } from '@/lib/api';
import { formatDateTime, humanize } from '@/lib/format';
import { useAdminMutations, useFloorPlans, usePropertyAreas, useUnits } from '@/lib/queries';
import { entitySyncMetadata } from '@/lib/state-consistency';
import { cn } from '@/lib/utils';

import { FloorPlanCanvas } from './floor-plan/FloorPlanCanvas';
import { FloorPlanChecklist, getMarkerStatus } from './floor-plan/FloorPlanChecklist';

const BUILDING_SCOPE = 'building-wide';
/** How often the extraction job is polled once started. */
const EXTRACTION_POLL_MS = 2_000;
const EXTRACTION_STAGES = [
  'Reading labels across the full plan',
  'Separating floors and stories',
  'Building the room checklist',
  'Validating draft areas for review',
] as const;
/** Roughly how long each stage runs, used only to advance the progress copy. */
const STAGE_SECONDS = 8;

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
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [extractionSeconds, setExtractionSeconds] = useState(0);
  const [isComparisonOpen, setIsComparisonOpen] = useState(false);
  // Extraction is a background job now; these track the poll rather than the
  // pending state of a (no longer long-running) mutation.
  const [extractingJobId, setExtractingJobId] = useState<string | null>(null);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  // React state does not become visible until the next render. This guard closes
  // the small window where a fast second click could start a duplicate
  // extraction request before the disabled button appears.
  const extractionRequestActive = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    pollAbort.current = controller;
    // Unmounting must stop the poll loop, or it keeps hitting the API and
    // calling setState on a component that is gone.
    return () => controller.abort();
  }, []);

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
  const drafts = useMemo(() => scopedAreas.filter((area) => area.status === 'DRAFT'), [scopedAreas]);
  // Which approved area is open for correction, if any. One at a time, so the
  // approved list stays a list rather than becoming a form.
  const [correctingAreaId, setCorrectingAreaId] = useState<string | null>(null);
  const approved = useMemo(
    () => scopedAreas.filter((area) => area.status === 'APPROVED'),
    [scopedAreas],
  );
  const currentPlanMarkers = useMemo(
    () =>
      latest
        ? scopedAreas.filter((area) => Boolean(area.marker) && area.sourceFloorPlanId === latest.id)
        : [],
    [latest, scopedAreas],
  );
  const adminMarkers = useMemo(
    () =>
      currentPlanMarkers.filter(
        (area) => area.marker?.source === 'ADMIN_ADJUSTED' || area.marker?.source === 'ADMIN_PLACED',
      ),
    [currentPlanMarkers],
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
  const isExtracting = actions.extractFloorPlan.isPending || Boolean(extractingJobId);
  const closeComparison = useCallback(() => setIsComparisonOpen(false), []);

  // Batch selection over the draft review list. Held as ids rather than indices
  // so it survives reordering and refetches.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const draftIds = useMemo(() => drafts.map((area) => area.id), [drafts]);
  // Drop ids that no longer exist — after a delete, an approval, or a scope
  // change — so a stale selection can never be submitted.
  useEffect(() => {
    setSelectedIds((current) => {
      const live = new Set(draftIds);
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [draftIds]);
  const toggleSelected = useCallback((areaId: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(areaId);
      else next.delete(areaId);
      return next;
    });
  }, []);
  const setGroupSelected = useCallback((ids: string[], selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const selectedCount = selectedIds.size;
  const allDraftsSelected = draftIds.length > 0 && selectedCount === draftIds.length;

  const deleteSelected = useCallback(async () => {
    const areaIds = [...selectedIds];
    if (!areaIds.length) return;
    await actions.deletePropertyAreas
      .mutateAsync({ propertyId, areaIds })
      .then(() => {
        setMessage(`${areaIds.length} area${areaIds.length === 1 ? '' : 's'} deleted.`);
        setSelectedIds(new Set());
      })
      .catch(() => undefined);
  }, [actions.deletePropertyAreas, propertyId, selectedIds]);

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
    if (!extractingJobId) {
      setExtractionSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const updateElapsed = () =>
      setExtractionSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [extractingJobId]);

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

  if (plans.isLoading || areas.isLoading || units.isLoading) return <PageSkeleton cards={2} />;
  if (plans.isError) return <ErrorState error={plans.error} retry={() => void plans.refetch()} />;
  if (areas.isError) return <ErrorState error={areas.error} retry={() => void areas.refetch()} />;
  if (units.isError) return <ErrorState error={units.error} retry={() => void units.refetch()} />;

  const actionError = [
    actions.uploadFloorPlan.error,
    actions.extractFloorPlan.error,
    actions.createPropertyArea.error,
    actions.updatePropertyArea.error,
    actions.deletePropertyArea.error,
    actions.deletePropertyAreas.error,
    actions.approvePropertyAreas.error,
  ].find(Boolean);
  const actionErrorMessage = actionError
    ? actionError instanceof Error
      ? actionError.message
      : 'The request could not be completed.'
    : null;

  // Replacing an existing source version is confirmed first; the submit is
  // parked rather than blocked because AlertDialog is asynchronous.
  function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (latest) {
      setConfirmReplace(true);
      return;
    }
    void runUpload();
  }

  async function runUpload() {
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

  /**
   * Starts extraction, then polls the job until it settles. The model call runs
   * server-side outside the request because it outlives the HTTP socket timeout,
   * so there is no long response to await here.
   */
  async function extract() {
    if (!latest || extractionRequestActive.current) return;
    extractionRequestActive.current = true;
    setMessage(undefined);
    setExtractionError(null);
    actions.extractFloorPlan.reset();
    const floorPlanId = latest.id;
    try {
      const started = await actions.extractFloorPlan.mutateAsync({ propertyId, floorPlanId });
      setExtractingJobId(started.jobId);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, EXTRACTION_POLL_MS));
        if (pollAbort.current?.signal.aborted) return;
        const job = await actions.floorPlanExtractionJob(floorPlanId, started.jobId);
        if (job.status === 'COMPLETED') {
          const detected = job.summary?.detectedCount ?? 0;
          const created = job.summary?.createdCount ?? 0;
          const present = job.summary?.alreadyPresentCount ?? 0;
          setMessage(
            `AI detected ${detected} area${detected === 1 ? '' : 's'}: ` +
              `${created} added as new draft${created === 1 ? '' : 's'} and ` +
              `${present} already present in this scope.`,
          );
          setExtractionError(null);
          actions.extractFloorPlan.reset();
          await Promise.all([plans.refetch(), areas.refetch()]);
          return;
        }
        if (job.status === 'FAILED') {
          setExtractionError(
            job.errorCode === 'FLOOR_PLAN_EXTRACTION_TIMED_OUT'
              ? 'Extraction did not finish. The plan may be too complex for the current model - try again, or split the plan by floor.'
              : `Extraction failed (${job.errorCode ?? 'unknown error'}). Check the AI provider settings and try again.`,
          );
          await Promise.all([plans.refetch(), areas.refetch()]);
          return;
        }
      }
    } catch (error) {
      setExtractionError(error instanceof Error ? error.message : 'Extraction could not be started.');
    } finally {
      extractionRequestActive.current = false;
      setExtractingJobId(null);
    }
  }

  return (
    <section aria-labelledby="floor-plan-heading" className="space-y-4 scroll-mt-20" id="floor-plan">
      <SectionHeader
        description="Manage a shared building layout or a plan specific to one unit."
        title="Floor plan and inspection areas"
      />

      {/* One row of scopes rather than a heading block plus a button row: which
          scope you are editing is the only question here. */}
      <div aria-label="Select plan scope" className="flex flex-wrap gap-1.5" role="group">
        <ScopeButton
          label="Building-wide"
          onSelect={() => setScope(BUILDING_SCOPE)}
          selected={scope === BUILDING_SCOPE}
        />
        {activeUnits.map((unit) => (
          <ScopeButton
            key={unit.id}
            label={unit.name}
            onSelect={() => setScope(unit.id)}
            selected={scope === unit.id}
          />
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle id="floor-plan-heading">{scopeLabel} floor plan</CardTitle>
            <CardDescription>
              Maintain the visual reference used to verify and approve this scope&apos;s inspection
              areas.
            </CardDescription>
          </div>
          {latest ? <StatusBadge value={latest.status} /> : null}
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Plan preview</p>
                {previewUrl && latest ? (
                  <a
                    className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                    href={previewUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open original
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : null}
              </div>
              <div className="bg-muted aspect-[4/3] overflow-hidden rounded-lg border">
                {previewUrl && latest ? (
                  <object
                    aria-label={latest.fileName}
                    className="size-full"
                    data={previewUrl}
                    type={latest.mimeType}
                  >
                    <a href={previewUrl} rel="noreferrer" target="_blank">
                      Open {latest.fileName}
                    </a>
                  </object>
                ) : (
                  <div className="text-muted-foreground grid h-full place-content-center gap-1 p-6 text-center">
                    <FileTextIcon aria-hidden className="mx-auto size-6" />
                    <p className="text-foreground text-sm font-medium">
                      No {scopeLabel.toLowerCase()} floor plan uploaded
                    </p>
                    <p className="text-xs">Upload a PDF, PNG, or JPEG up to 20 MB.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4">
              {latest ? (
                <div className="rounded-lg border p-3">
                  <div className="flex items-start gap-2.5">
                    <FileTextIcon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-xs">Current source file</p>
                      <p className="truncate text-sm font-medium">{latest.fileName}</p>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 border-t pt-3">
                    <div>
                      <dt className="text-muted-foreground text-xs">File size</dt>
                      <dd className="text-sm font-medium">{formatBytes(latest.sizeBytes)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs">Uploaded</dt>
                      <dd className="text-sm font-medium">{formatDateTime(latest.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs">Extraction</dt>
                      <dd className="text-sm font-medium">
                        {humanize(latest.extractionJobs?.[0]?.status) || 'Not started'}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : null}

              {canManage ? (
                <>
                  <AlertDialog onOpenChange={setConfirmReplace} open={confirmReplace}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Replace the active source version?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Existing approved areas stay in history, but their markers will require
                          review against the new plan before they can be trusted.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            setConfirmReplace(false);
                            void runUpload();
                          }}
                        >
                          Upload new version
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <form className="space-y-2" onSubmit={upload}>
                    <p className="text-sm font-medium">
                      {latest ? 'Replace source plan' : 'Upload source plan'}
                    </p>
                    <label
                      className="hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 transition-colors"
                      htmlFor="floor-plan-file"
                    >
                      <input
                        accept="application/pdf,image/png,image/jpeg"
                        className="sr-only"
                        id="floor-plan-file"
                        key={`${scope}-${fileInputVersion}`}
                        onChange={(event) => setFile(event.target.files?.[0])}
                        type="file"
                      />
                      <UploadIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {file ? file.name : 'Choose a PDF, PNG, or JPEG'}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {file ? `${formatBytes(file.size)} selected` : 'Secure upload · 20 MB maximum'}
                        </span>
                      </span>
                      <span className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'pointer-events-none')}>
                        {file ? 'Change' : 'Browse'}
                      </span>
                    </label>

                    {file && latest ? (
                      <Alert variant="warning">
                        <AlertDescription>
                          Existing areas remain in history. Markers must be reviewed against the new
                          source before they are treated as current.
                        </AlertDescription>
                      </Alert>
                    ) : null}

                    {file ? (
                      <Button
                        className="w-full"
                        disabled={actions.uploadFloorPlan.isPending}
                        type="submit"
                        variant="outline"
                      >
                        {actions.uploadFloorPlan.isPending ? <Spinner /> : null}
                        {actions.uploadFloorPlan.isPending
                          ? 'Uploading…'
                          : latest
                            ? 'Upload new version'
                            : 'Upload securely'}
                      </Button>
                    ) : null}
                  </form>
                </>
              ) : null}

              {latest ? (
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">Area review workflow</p>
                    <Badge variant="secondary">
                      {scopedAreas.length} area{scopedAreas.length === 1 ? '' : 's'}
                    </Badge>
                  </div>

                  <dl
                    aria-label="Floor plan review readiness"
                    className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                  >
                    {[
                      { label: 'Extracted', value: `${scopedAreas.length}` },
                      { label: 'Approved', value: `${approved.length}/${scopedAreas.length}` },
                      { label: 'Markers', value: `${currentPlanMarkers.length}/${scopedAreas.length}` },
                      { label: 'Admin placed', value: `${adminMarkers.length}` },
                    ].map((item) => (
                      <div className="bg-muted/50 rounded-md p-2" key={item.label}>
                        <dt className="text-muted-foreground text-xs">{item.label}</dt>
                        <dd className="text-sm font-semibold tabular-nums">{item.value}</dd>
                      </div>
                    ))}
                  </dl>

                  <div className="grid gap-2">
                    {canManage ? (
                      <Button
                        disabled={isExtracting}
                        onClick={() => void extract()}
                        type="button"
                        variant="outline"
                      >
                        {isExtracting ? <Spinner /> : <SparklesIcon />}
                        {isExtracting
                          ? 'Extracting…'
                          : scopedAreas.length
                            ? 'Re-extract areas'
                            : 'Extract areas with AI'}
                      </Button>
                    ) : null}
                    <Button
                      disabled={!scopedAreas.length || isExtracting}
                      onClick={() => setIsComparisonOpen(true)}
                      title={
                        scopedAreas.length
                          ? 'Compare the source plan with extracted areas'
                          : 'Extract or define areas before comparing'
                      }
                      type="button"
                    >
                      Review {scopedAreas.length || ''} extracted area
                      {scopedAreas.length === 1 ? '' : 's'}
                    </Button>
                  </div>

                  <Alert>
                    <InfoIcon />
                    <AlertDescription>
                      Area approval and marker placement are reviewed separately. Moving a marker
                      never approves an area.
                    </AlertDescription>
                  </Alert>
                </div>
              ) : null}
            </div>
          </div>

          {extractionError ? (
            // Reported by the job rather than the request, so it survives an
            // extraction that outlives its HTTP call.
            <Alert variant="destructive">
              <AlertDescription>{extractionError}</AlertDescription>
            </Alert>
          ) : null}
          {actionErrorMessage && actionErrorMessage !== extractionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionErrorMessage}</AlertDescription>
            </Alert>
          ) : null}
          {message ? (
            <Alert variant="success">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>{scopeLabel} draft area review</CardTitle>
            <CardDescription>Edit AI suggestions or add missing rooms before approval.</CardDescription>
          </div>
          {canManage ? (
            <Button
              disabled={!drafts.length || actions.approvePropertyAreas.isPending}
              onClick={() =>
                actions.approvePropertyAreas.mutate({
                  propertyId,
                  areaIds: drafts.map((area) => area.id),
                })
              }
            >
              {actions.approvePropertyAreas.isPending ? <Spinner /> : null}
              {actions.approvePropertyAreas.isPending
                ? 'Approving…'
                : `Approve ${drafts.length || ''} draft${drafts.length === 1 ? '' : 's'}`}
            </Button>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-4">
          {canManage ? (
            <ManualAreaForm
              floorNames={floorNames}
              key={scope}
              nextOrder={nextOrder}
              onCreate={(input) =>
                actions.createPropertyArea.mutateAsync({
                  propertyId,
                  unitId: selectedUnitId ?? undefined,
                  ...input,
                })
              }
              submitting={actions.createPropertyArea.isPending}
            />
          ) : null}

          {canManage && draftGroups.length ? (
            <div
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-lg border p-2.5 transition-colors',
                selectedCount && 'border-primary bg-primary/5',
              )}
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <Checkbox
                  // Partial selection reads as indeterminate rather than
                  // unchecked, so the box never implies "nothing is selected".
                  // Radix models this as a third checked value instead of an
                  // imperative DOM property.
                  checked={allDraftsSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
                  onCheckedChange={(checked) => setGroupSelected(draftIds, checked === true)}
                />
                {allDraftsSelected ? 'Clear selection' : 'Select all'}
              </label>
              <span className="text-muted-foreground text-sm">
                {selectedCount
                  ? `${selectedCount} of ${draftIds.length} selected`
                  : `${draftIds.length} draft area${draftIds.length === 1 ? '' : 's'}`}
              </span>
              {selectedCount ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      className="ml-auto"
                      disabled={actions.deletePropertyAreas.isPending}
                      size="sm"
                      variant="destructive"
                    >
                      {actions.deletePropertyAreas.isPending
                        ? 'Deleting…'
                        : `Delete ${selectedCount} selected`}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete {selectedCount} draft area{selectedCount === 1 ? '' : 's'}?
                      </AlertDialogTitle>
                      {/* The count is spelled out because the selection may span
                          floors that are scrolled out of view. */}
                      <AlertDialogDescription>
                        This cannot be undone. Any markers placed on{' '}
                        {selectedCount === 1 ? 'it' : 'them'} are removed with the{' '}
                        {selectedCount === 1 ? 'area' : 'areas'}.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className={buttonVariants({ variant: 'destructive' })}
                        onClick={() => void deleteSelected()}
                      >
                        Delete {selectedCount === 1 ? 'area' : 'areas'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <span className="text-muted-foreground ml-auto text-xs">
                  Select areas to delete them in bulk
                </span>
              )}
            </div>
          ) : null}

          {draftGroups.length ? (
            <div className="space-y-5">
              {draftGroups.map((group) => (
                <section key={group.key}>
                  <FloorGroupHeading
                    count={group.areas.length}
                    label={group.label}
                    onSelectAll={(selected) =>
                      setGroupSelected(
                        group.areas.map((area) => area.id),
                        selected,
                      )
                    }
                    selectable={canManage}
                    selectedCount={group.areas.filter((area) => selectedIds.has(area.id)).length}
                  />
                  <div className="grid gap-2">
                    {group.areas.map((area) => (
                      <AreaReviewRow
                        area={area}
                        deleting={
                          actions.deletePropertyArea.isPending &&
                          actions.deletePropertyArea.variables?.areaId === area.id
                        }
                        floorNames={floorNames}
                        key={area.id}
                        onArchive={() =>
                          actions.archivePropertyArea.mutateAsync({ propertyId, areaId: area.id })
                        }
                        onDelete={() =>
                          actions.deletePropertyArea.mutateAsync({ propertyId, areaId: area.id })
                        }
                        onReject={() =>
                          actions.rejectPropertyArea.mutateAsync({ propertyId, areaId: area.id })
                        }
                        onSave={(input) =>
                          actions.updatePropertyArea.mutateAsync({
                            propertyId,
                            areaId: area.id,
                            expectedUpdatedAt: area.updatedAt,
                            ...input,
                          })
                        }
                        onToggleSelected={(selected) => toggleSelected(area.id, selected)}
                        readOnly={!canManage}
                        saving={
                          actions.updatePropertyArea.isPending &&
                          actions.updatePropertyArea.variables?.areaId === area.id
                        }
                        selected={selectedIds.has(area.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No draft areas are waiting for review in this scope.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>{scopeLabel} approved master areas</CardTitle>
            <CardDescription>
              Only these areas are copied into newly created inspections for this scope.
            </CardDescription>
          </div>
          <Badge variant="success">{approved.length} approved</Badge>
        </CardHeader>

        <CardContent>
          {approvedGroups.length ? (
            <div className="space-y-5">
              {approvedGroups.map((group) => (
                <section key={group.key}>
                  <FloorGroupHeading count={group.areas.length} label={group.label} />
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    {group.areas.map((area) =>
                      /* A technician-added area is the one approved area nobody
                         reviewed before approving — it is approved because the
                         person adding it was standing in it. So it is the only
                         one worth offering to correct here, and the API refuses
                         the rest. Editing swaps the row for the same editor the
                         drafts use rather than building a second one. */
                      correctingAreaId === area.id ? (
                        // Spans the grid: the editor is a full-width row of
                        // fields, and the approved list is four narrow columns.
                        <div className="col-span-full space-y-2" key={area.id}>
                          <AreaReviewRow
                            area={area}
                            deleting={false}
                            floorNames={floorNames}
                            onArchive={() =>
                              actions.archivePropertyArea.mutateAsync({
                                propertyId,
                                areaId: area.id,
                              })
                            }
                            // Approving and rejecting belong to the draft queue;
                            // an approved area has already been through that.
                            onDelete={() => Promise.resolve()}
                            onReject={() => Promise.resolve()}
                            onSave={async (input) => {
                              const saved = await actions.updatePropertyArea.mutateAsync({
                                propertyId,
                                areaId: area.id,
                                expectedUpdatedAt: area.updatedAt,
                                ...input,
                              });
                              setCorrectingAreaId(null);
                              return saved;
                            }}
                            readOnly={!canManage}
                            saving={
                              actions.updatePropertyArea.isPending &&
                              actions.updatePropertyArea.variables?.areaId === area.id
                            }
                          />
                          <Button
                            onClick={() => setCorrectingAreaId(null)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <article className="space-y-1 rounded-lg border p-3" key={area.id}>
                          <p className="truncate text-sm font-medium">{area.name}</p>
                          <p className="text-muted-foreground text-xs">
                            #{area.inspectionOrder} · {area.isRequired ? 'Required' : 'Optional'}
                            {area.source === 'TECHNICIAN' ? ' · Technician-added' : ''}
                          </p>
                          {canManage && area.source === 'TECHNICIAN' ? (
                            <Button
                              onClick={() => setCorrectingAreaId(area.id)}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Correct details
                            </Button>
                          ) : null}
                        </article>
                      ),
                    )}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No areas are approved in this scope. Inspections require an approved master area list.
            </p>
          )}
        </CardContent>
      </Card>

      <ExtractionProgressDialog elapsedSeconds={extractionSeconds} open={isExtracting} />

      {isComparisonOpen && latest ? (
        <FloorPlanComparisonDialog
          canManage={canManage}
          fileName={latest.fileName}
          groups={comparisonGroups}
          mimeType={latest.mimeType}
          onClose={closeComparison}
          planId={latest.id}
          previewUrl={previewUrl}
          propertyId={propertyId}
          scopeLabel={scopeLabel}
        />
      ) : null}
    </section>
  );
}

/**
 * The wait while the model reads the plan.
 *
 * A shadcn Dialog with its close affordances removed, rather than the old
 * hand-rolled portal — that version reimplemented the focus trap, the scroll
 * lock, the Tab cycle and the focus restore by hand, about eighty lines that
 * Radix already does correctly. What is bespoke is only that it *cannot* be
 * dismissed: closing it would strand a job that is still running server-side.
 */
function ExtractionProgressDialog({
  elapsedSeconds,
  open,
}: {
  elapsedSeconds: number;
  open: boolean;
}) {
  const stageIndex = Math.min(
    Math.floor(elapsedSeconds / STAGE_SECONDS),
    EXTRACTION_STAGES.length - 1,
  );
  const percent = Math.min(99, Math.round((elapsedSeconds / (STAGE_SECONDS * EXTRACTION_STAGES.length)) * 100));

  return (
    <Dialog open={open}>
      <DialogContent
        // Undismissable on purpose: the job keeps running server-side, and a
        // closed dialog would leave it invisible.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Analyzing the complete floor plan</DialogTitle>
          <DialogDescription>
            Multi-story plans can take up to a minute. Keep this page open.
          </DialogDescription>
        </DialogHeader>
        <div
          aria-label={`Floor-plan extraction in progress. ${EXTRACTION_STAGES[stageIndex]}.`}
          aria-live="polite"
          className="space-y-3"
          role="status"
        >
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <Spinner />
              {EXTRACTION_STAGES[stageIndex]}…
            </span>
            <span className="text-muted-foreground tabular-nums">{elapsedSeconds}s</span>
          </div>
          <Progress value={percent} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FloorPlanComparisonDialog({
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
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const backfill = useAdminMutations().retryMissingMarkers;
  const selectedArea = allAreas.find((area) => area.id === selectedAreaId) ?? null;
  // Areas with no usable marker for the plan currently displayed.
  const missingMarkerCount = allAreas.filter(
    (area) => !area.marker || area.sourceFloorPlanId !== planId,
  ).length;
  const reviewPercent = allAreas.length ? Math.round((approvedCount / allAreas.length) * 100) : 0;
  const currentMarker =
    selectedArea?.marker && selectedArea.sourceFloorPlanId === planId ? selectedArea.marker : null;
  const hasUnsavedMarkerChanges = Boolean(
    editingAreaId &&
      draftMarker &&
      (!currentMarker ||
        Math.abs(currentMarker.x - draftMarker.x) > 0.000001 ||
        Math.abs(currentMarker.y - draftMarker.y) > 0.000001),
  );
  const hasUnsavedMarkerChangesRef = useRef(hasUnsavedMarkerChanges);
  hasUnsavedMarkerChangesRef.current = hasUnsavedMarkerChanges;

  // `window.confirm` is blocked, so each of these guards could early-return
  // inline. AlertDialog does not, so the intent is parked here and replayed on
  // confirm — otherwise navigating away would silently discard the marker edit.
  const [pendingDiscard, setPendingDiscard] = useState<{ what: string; run: () => void } | null>(
    null,
  );
  const guardUnsaved = useCallback((what: string, next: () => void) => {
    if (!hasUnsavedMarkerChangesRef.current) {
      next();
      return;
    }
    setPendingDiscard({ what, run: next });
  }, []);

  const selectArea = (id: string) => {
    const apply = () => {
      setSelectedAreaId(id);
      setFocusNonce((nonce) => nonce + 1);
      setSaveMessage(null);
      if (editingAreaId && editingAreaId !== id) {
        setEditingAreaId(null);
        setDraftMarker(null);
        setSaveError(null);
      }
    };
    // Only a switch away from the area being edited can lose work.
    if (editingAreaId && editingAreaId !== id) {
      guardUnsaved('select another area', apply);
      return;
    }
    apply();
  };

  const startEdit = (id: string) => {
    const area = allAreas.find((item) => item.id === id);
    setSelectedAreaId(id);
    setEditingAreaId(id);
    setSaveError(null);
    setSaveMessage(null);
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
    const area = allAreas.find((item) => item.id === id);
    setSaveError(null);
    markerMutation.mutate(
      {
        propertyId,
        areaId: id,
        x: draftMarker.x,
        y: draftMarker.y,
        expectedUpdatedAt: area?.updatedAt,
        // PDF coordinates are relative to the page being viewed.
        ...(isPdfPlan ? { pageNumber } : {}),
      },
      {
        onSuccess: () => {
          setEditingAreaId(null);
          setDraftMarker(null);
          setSaveMessage('Marker position saved. Area approval was not changed.');
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

  const requestClose = useCallback(() => {
    guardUnsaved('close the review workspace', onClose);
  }, [guardUnsaved, onClose]);

  const focusArea = (id: string) => {
    setSelectedAreaId(id);
    setFocusNonce((nonce) => nonce + 1);
  };

  return (
    <Dialog onOpenChange={(open) => !open && requestClose()} open>
      <DialogContent className="flex h-[92dvh] max-h-none w-[96vw] max-w-[96vw] flex-col gap-4 overflow-hidden p-4 sm:max-w-[96vw] sm:p-6">
        <AlertDialog
          onOpenChange={(open) => !open && setPendingDiscard(null)}
          open={pendingDiscard !== null}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard the unsaved marker position?</AlertDialogTitle>
              <AlertDialogDescription>
                The marker you moved has not been saved. Continuing to {pendingDiscard?.what}{' '}
                discards that change and keeps the position already stored for this area.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive' })}
                onClick={() => {
                  pendingDiscard?.run();
                  setPendingDiscard(null);
                }}
              >
                Discard change
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <DialogHeader className="shrink-0 pr-10">
          <DialogTitle>Compare plan and extracted areas</DialogTitle>
          <DialogDescription>
            {scopeLabel} · {fileName}
            {isPdfPlan ? ` · Page ${pageNumber}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0 space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{reviewPercent}% reviewed</span>
            <span className="text-muted-foreground text-xs">
              {allAreas.length} areas · {approvedCount} approved · {draftCount} drafts ·{' '}
              {missingMarkerCount} missing markers
            </span>
          </div>
          <Progress value={reviewPercent} />
        </div>

        {/* Plan and checklist side by side above `lg`, stacked below — the old
            modal hid one pane behind a "Show plan / Review areas" toggle on
            every viewport, so on a laptop you could never see both. */}
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section className="flex min-h-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">{fileName}</p>
              <div className="flex shrink-0 items-center gap-3">
                {supportsMarkers ? (
                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                    <Checkbox
                      checked={showAllMarkers}
                      disabled={Boolean(editingAreaId)}
                      onCheckedChange={() => setShowAllMarkers((value) => !value)}
                    />
                    Show all markers
                  </label>
                ) : null}
                {previewUrl ? (
                  <a
                    className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                    href={previewUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open original
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : null}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {previewUrl ? (
                <FloorPlanCanvas
                  areas={allAreas}
                  draftMarker={draftMarker}
                  editingAreaId={editingAreaId}
                  fileName={fileName}
                  focusNonce={focusNonce}
                  mimeType={mimeType}
                  onDraftChange={setDraftMarker}
                  onPageChange={(page) => {
                    guardUnsaved('change pages', () => {
                      setPageNumber(page);
                      // A selection on another page is no longer meaningful.
                      setSelectedAreaId(null);
                      cancelEdit();
                    });
                  }}
                  onSelectArea={selectArea}
                  pageNumber={pageNumber}
                  planId={planId}
                  previewUrl={previewUrl}
                  selectedAreaId={selectedAreaId}
                  showAllMarkers={showAllMarkers}
                />
              ) : (
                <div className="text-muted-foreground bg-muted grid h-full place-content-center rounded-lg border p-6 text-center text-sm">
                  <p className="text-foreground font-medium">Preview unavailable</p>
                  <p>The floor plan could not be displayed in the comparison view.</p>
                </div>
              )}
            </div>
          </section>

          <aside className="flex min-h-0 flex-col gap-3 lg:border-l lg:pl-4">
            {canManage && supportsMarkers && missingMarkerCount > 0 ? (
              <Alert variant="warning">
                <AlertDescription className="gap-2">
                  {missingMarkerCount} area{missingMarkerCount === 1 ? '' : 's'} need marker
                  placement.
                  <Button
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
                    size="sm"
                    variant="outline"
                  >
                    {backfill.isPending ? <Spinner /> : null}
                    {backfill.isPending ? 'Retrying…' : 'Retry marker extraction'}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {backfillMessage ? (
              <p aria-live="polite" className="text-muted-foreground text-xs">
                {backfillMessage}
              </p>
            ) : null}

            <p aria-live="polite" className="sr-only">
              {selectedArea
                ? `${selectedArea.name} selected. Area is ${selectedArea.status.toLowerCase()}; ${
                    getMarkerStatus(selectedArea, planId).announcement
                  }.`
                : ''}
            </p>

            <FloorPlanChecklist
              canManage={canManage}
              editingAreaId={editingAreaId}
              groups={groups}
              hasDraft={draftMarker !== null}
              onCancelEdit={cancelEdit}
              onFocusArea={focusArea}
              onSaveMarker={saveMarker}
              onSelectArea={selectArea}
              onStartEdit={startEdit}
              planId={planId}
              saveError={saveError}
              saveMessage={saveMessage}
              saving={markerMutation.isPending}
              selectedAreaId={selectedAreaId}
              supportsMarkers={supportsMarkers}
            />
          </aside>
        </div>
      </DialogContent>
    </Dialog>
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
    <Button
      aria-pressed={selected}
      onClick={onSelect}
      size="sm"
      type="button"
      variant={selected ? 'default' : 'outline'}
    >
      {label}
    </Button>
  );
}

function FloorGroupHeading({
  label,
  count,
  selectable,
  selectedCount = 0,
  onSelectAll,
}: {
  label: string;
  count: number;
  selectable?: boolean;
  selectedCount?: number;
  onSelectAll?: (selected: boolean) => void;
}) {
  const allSelected = count > 0 && selectedCount === count;
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      {/* Checkbox and floor name are one control, so the title stays
          left-aligned and the box never reads as a stray duplicate of the
          toolbar's. */}
      {selectable && onSelectAll ? (
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            aria-label={`Select all areas on ${label}`}
            // Radix carries the third state as a value rather than an imperative
            // DOM property, so partial selection stays visible on re-render.
            checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
            onCheckedChange={(checked) => onSelectAll(checked === true)}
          />
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {label}
          </h3>
        </label>
      ) : (
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          {label}
        </h3>
      )}
      <span className="text-muted-foreground text-xs">
        {selectedCount
          ? `${selectedCount} of ${count} selected`
          : `${count} area${count === 1 ? '' : 's'}`}
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
  const [hasAirConditioning, setHasAirConditioning] = useState(false);
  return (
    <form
      className="bg-muted/40 flex flex-wrap items-end gap-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({ floorName, name, inspectionOrder: nextOrder, isRequired, hasAirConditioning })
          .then(() => {
            setName('');
            // Cleared with the name: the next area is a different room, and
            // carrying the tick over is how a whole floor silently ends up
            // marked as having units.
            setHasAirConditioning(false);
          })
          .catch(() => undefined);
      }}
    >
      <Field className="w-[180px]">
        <FieldLabel htmlFor="manual-floor">Floor</FieldLabel>
        <Input
          id="manual-floor"
          list="manual-floor-options"
          onChange={(event) => setFloorName(event.target.value)}
          value={floorName}
        />
        <FloorOptions floorNames={floorNames} id="manual-floor-options" />
      </Field>
      <Field className="min-w-[180px] flex-1">
        <FieldLabel htmlFor="manual-area">Area name</FieldLabel>
        <Input
          id="manual-area"
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Bedroom 1"
          value={name}
        />
      </Field>
      <label className="flex h-9 cursor-pointer items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={isRequired}
          onCheckedChange={(checked) => setIsRequired(checked === true)}
        />
        Required
      </label>
      <label className="flex h-9 cursor-pointer items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={hasAirConditioning}
          onCheckedChange={(checked) => setHasAirConditioning(checked === true)}
        />
        Has air conditioning
      </label>
      <Button disabled={!floorName.trim() || !name.trim() || submitting} variant="outline">
        {submitting ? <Spinner /> : null}
        Add draft area
      </Button>
    </form>
  );
}

interface AreaInput {
  floorName: string;
  name: string;
  inspectionOrder: number;
  isRequired: boolean;
  /**
   * Whether this area holds an air conditioner.
   *
   * Scheduling scope rather than a condition observation: an HVAC inspection
   * covers every area where this is true, so it is the office recording where
   * the units are. Until somebody ticks these, an HVAC visit scopes to nothing.
   */
  hasAirConditioning: boolean;
}

function AreaReviewRow({
  area,
  floorNames,
  saving,
  deleting,
  readOnly,
  selected,
  onToggleSelected,
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
  selected?: boolean;
  onToggleSelected?: (selected: boolean) => void;
  onSave: (input: AreaInput) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onReject: () => Promise<unknown>;
  onArchive: () => Promise<unknown>;
}) {
  const environmentLabel = area.environment ? humanize(area.environment) : null;
  const [editing, setEditing] = useState(false);
  const sync = entitySyncMetadata(area);

  return (
    /**
     * A summary, with the editing behind a dialog.
     *
     * Every area used to render its five inputs and four buttons inline, so a
     * property with a dozen areas was a wall of identical form controls with no
     * way to leave one alone once opened — no cancel, no close, and a half-typed
     * name sitting in a field indefinitely. Reading the list and editing one
     * area are different jobs, and only one of them needs a form.
     */
    <article
      aria-busy={Boolean(sync && sync.state !== 'SYNCED')}
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border p-3 transition-colors',
        selected && 'border-primary bg-primary/5',
      )}
    >
      {onToggleSelected ? (
        <label className="flex items-center">
          <Checkbox
            aria-label={`Select ${area.name}`}
            checked={Boolean(selected)}
            onCheckedChange={(checked) => onToggleSelected(checked === true)}
          />
        </label>
      ) : null}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{area.name}</p>
        <p className="text-muted-foreground truncate text-xs">
          {[
            area.floor?.name,
            `Order ${area.inspectionOrder}`,
            environmentLabel,
            area.source === 'TECHNICIAN' ? 'Technician-added' : humanize(area.source),
            area.createdBy ? `by ${area.createdBy.displayName}` : null,
            sync ? syncLabel(sync.state) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      {/* The two facts that change what an inspection does, stated where the
          list is read rather than only inside the form. "Has air conditioning"
          is not a condition observation — it is the office saying where the
          units are, and it is what an HVAC visit is scoped by. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {area.isRequired ? <Badge variant="secondary">Required</Badge> : null}
        {area.hasAirConditioning ? <Badge variant="secondary">Air conditioning</Badge> : null}
      </div>

      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Dialog onOpenChange={setEditing} open={editing}>
            <Button onClick={() => setEditing(true)} size="sm" variant="outline">
              Edit
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit {area.name}</DialogTitle>
                <DialogDescription>
                  Changes apply to future inspections. Evidence already recorded against this area
                  is unaffected.
                </DialogDescription>
              </DialogHeader>
              {/* Mounted with the dialog, so the fields start from what is
                  stored every time it opens and closing discards the draft.
                  That is what makes Close mean something. */}
              {editing ? (
                <AreaEditForm
                  area={area}
                  floorNames={floorNames}
                  onSave={onSave}
                  onSaved={() => setEditing(false)}
                  saving={saving}
                />
              ) : null}
            </DialogContent>
          </Dialog>
          {area.status === 'DRAFT' ? (
            <Button
              disabled={saving}
              onClick={() => void onReject().catch(() => undefined)}
              size="sm"
              variant="outline"
            >
              Reject
            </Button>
          ) : null}
          <Button
            disabled={saving}
            onClick={() => void onArchive().catch(() => undefined)}
            size="sm"
            variant="outline"
          >
            Archive
          </Button>
          {/* Confirmed, like every other destructive control here. Removing an
              area takes its evidence with it and there is no undo. */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleting}
                size="sm"
                variant="ghost"
              >
                {deleting ? 'Removing…' : 'Remove'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {area.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes the area from the floor plan along with anything recorded against
                  it. It cannot be undone. Archive it instead to keep the record and stop
                  scheduling it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={buttonVariants({ variant: 'destructive' })}
                  onClick={() => void onDelete().catch(() => undefined)}
                >
                  Remove area
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
    </article>
  );
}

function AreaEditForm({
  area,
  floorNames,
  saving,
  onSave,
  onSaved,
}: {
  area: AdminPropertyArea;
  floorNames: string[];
  saving: boolean;
  onSave: (input: AreaInput) => Promise<unknown>;
  onSaved: () => void;
}) {
  const [floorName, setFloorName] = useState(area.floor?.name ?? '');
  const [name, setName] = useState(area.name);
  const [inspectionOrder, setInspectionOrder] = useState(area.inspectionOrder);
  const [isRequired, setIsRequired] = useState(area.isRequired);
  const [hasAirConditioning, setHasAirConditioning] = useState(area.hasAirConditioning ?? false);
  // Captured at open. If the row updates underneath while this is on screen,
  // saving would overwrite whatever the other edit did.
  const loadedRevision = useRef(area.updatedAt);
  const hasExternalConflict = loadedRevision.current !== area.updatedAt;
  const floorOptionsId = `floor-options-${area.id}`;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field>
          <FieldLabel htmlFor={`area-${area.id}`}>Area</FieldLabel>
          <Input
            id={`area-${area.id}`}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <FieldError>
            {hasExternalConflict
              ? 'This area changed elsewhere. Close and reopen to see the latest values.'
              : null}
          </FieldError>
        </Field>

        <Field className="sm:w-[96px]">
          <FieldLabel htmlFor={`order-${area.id}`}>Order</FieldLabel>
          <Input
            id={`order-${area.id}`}
            min={1}
            onChange={(event) => setInspectionOrder(Number(event.target.value))}
            type="number"
            value={inspectionOrder}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={`floor-${area.id}`}>Floor</FieldLabel>
        <Input
          id={`floor-${area.id}`}
          list={floorOptionsId}
          onChange={(event) => setFloorName(event.target.value)}
          value={floorName}
        />
        <FloorOptions floorNames={floorNames} id={floorOptionsId} />
      </Field>

      <div className="grid gap-3">
        <label className="hover:bg-accent flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 text-sm font-medium">
          <Checkbox
            checked={isRequired}
            onCheckedChange={(checked) => setIsRequired(checked === true)}
          />
          Required
        </label>

        <label className="hover:bg-accent flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 text-sm font-medium">
          <Checkbox
            checked={hasAirConditioning}
            onCheckedChange={(checked) => setHasAirConditioning(checked === true)}
          />
          <span className="min-w-0">
            Has air conditioning
            <FieldDescription>Scopes HVAC inspections. Not a condition finding.</FieldDescription>
          </span>
        </label>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Close
          </Button>
        </DialogClose>
        <Button
          disabled={
            saving ||
            hasExternalConflict ||
            !floorName.trim() ||
            !name.trim() ||
            inspectionOrder < 1
          }
          onClick={() => {
            void onSave({ floorName, name, inspectionOrder, isRequired, hasAirConditioning })
              .then(onSaved)
              .catch(() => undefined);
          }}
          type="button"
        >
          {saving ? <Spinner /> : null}
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function syncLabel(state: string) {
  const labels: Record<string, string> = {
    CREATING: 'Creating…',
    UPDATING: 'Saving…',
    DELETING: 'Removing…',
    PROCESSING: 'Processing…',
    VERIFYING: 'Verifying…',
    OFFLINE_PENDING: 'Waiting for connection…',
    RETRYING: 'Retrying…',
    FAILED: 'Unable to save',
  };
  return labels[state] ?? state.toLowerCase();
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
        (left, right) =>
          left.inspectionOrder - right.inspectionOrder || left.name.localeCompare(right.name),
      ),
    }));
}

function formatBytes(value: number) {
  if (value < 1_000_000) return `${Math.max(1, Math.round(value / 1_000))} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
