'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { InspectionType, type AdminProperty } from '@texasrenters/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { PageHeader } from '@/components/ui';
import { SearchableSelect } from '@/components/searchable-select';
import {
  useAdminMutations,
  useLeases,
  usePortfolios,
  useProperty,
  usePropertyAreas,
  usePropertyOptions,
  useTechnicians,
  useUnits,
} from '@/lib/queries';

const schema = z.object({
  portfolioId: z.string().min(1, 'Select a portfolio.'),
  propertyId: z.string().min(1, 'Select a property.'),
  unitId: z.string().optional(),
  leaseId: z.string().optional(),
  technicianId: z.string().optional(),
  inspectionType: z.nativeEnum(InspectionType),
  scheduledAt: z.string().min(1, 'Select a date and time.'),
  priority: z.enum(['STANDARD', 'HIGH']),
  internalNotes: z.string().max(2000).optional(),
});
type Values = z.infer<typeof schema>;

function propertyAddress(property?: AdminProperty | null) {
  if (!property) return '';
  const cityState = [property.city, property.state].filter(Boolean).join(', ');
  const locality = [cityState, property.postalCode].filter(Boolean).join(' ');
  return [property.addressLine1, property.addressLine2, locality].filter(Boolean).join(', ');
}

function CreateInspectionForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [propertySearch, setPropertySearch] = useState('');
  const [portfolioSearch, setPortfolioSearch] = useState('');
  const [selectedProperty, setSelectedProperty] = useState<AdminProperty | null>(null);
  const prefillId = search.get('propertyId') ?? '';
  const prefill = useProperty(prefillId);
  const portfolios = usePortfolios(portfolioSearch);
  const portfolioOptions = useMemo(
    () =>
      portfolios.data?.pages.flatMap((page) =>
        page.items.map((item) => ({
          value: item.id,
          label: item.name,
          searchText: item.abbreviation ?? undefined,
        })),
      ) ?? [],
    [portfolios.data?.pages],
  );
  const {
    register,
    watch,
    setValue,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      portfolioId: '',
      propertyId: prefillId,
      unitId: '',
      leaseId: '',
      technicianId: '',
      inspectionType: InspectionType.MOVE_IN,
      scheduledAt: '',
      priority: 'STANDARD',
      internalNotes: '',
    },
  });
  const portfolioId = watch('portfolioId');
  const propertyId = watch('propertyId');
  const unitId = watch('unitId');
  const inspectionType = watch('inspectionType');
  const properties = usePropertyOptions(portfolioId, propertySearch);
  const propertyRecords = useMemo(
    () => properties.data?.pages.flatMap((page) => page.items) ?? [],
    [properties.data?.pages],
  );
  const propertyOptions = useMemo(
    () =>
      propertyRecords.map((item) => {
        const itemAddress = propertyAddress(item);
        return {
          value: item.id,
          label: itemAddress ? `${item.name} — ${itemAddress}` : item.name,
          searchText: [item.addressLine1, item.addressLine2, item.city, item.state, item.postalCode]
            .filter(Boolean)
            .join(' '),
        };
      }),
    [propertyRecords],
  );
  const units = useUnits(propertyId);
  const propertyAreas = usePropertyAreas(propertyId);
  const leases = useLeases(unitId ?? '');
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const mutations = useAdminMutations();
  const mutation = mutations.createInspection;
  const fallbackArea = mutations.createFallbackPropertyArea;
  const hasApprovedAreas = propertyAreas.data?.some((area) => area.status === 'APPROVED') ?? false;
  const needsAreaSetup =
    Boolean(propertyId) && !propertyAreas.isLoading && !propertyAreas.isError && !hasApprovedAreas;

  useEffect(() => {
    if (prefill.data) {
      setValue('portfolioId', prefill.data.portfolio.id);
      setSelectedProperty(prefill.data);
    }
  }, [prefill.data, setValue]);
  useEffect(() => {
    if (units.data?.items.length === 1) setValue('unitId', units.data.items[0]!.id);
    if (units.data?.items.length === 0) setValue('unitId', '');
  }, [setValue, units.data]);

  async function submit(values: Values) {
    try {
      const created = await mutation.mutateAsync({
        propertyId: values.propertyId,
        unitId: values.unitId || undefined,
        leaseId: values.leaseId || undefined,
        technicianId: values.technicianId || undefined,
        scheduledAt: new Date(values.scheduledAt).toISOString(),
        inspectionType: values.inspectionType,
        priority: values.priority,
        internalNotes: values.internalNotes || undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      router.push(`/inspections/${created.id}`);
    } catch {
      // The mutation error is rendered below the form without rejecting the submit event.
    }
  }

  return (
    <>
      <PageHeader
        title={`Create ${inspectionTypeLabel(inspectionType).toLowerCase()} inspection`}
        description="Schedule the property lifecycle in order. The approved floor plan is reused while every inspection keeps its own auditable evidence."
        breadcrumbs={[{ label: 'Inspections', href: '/inspections' }, { label: 'Create' }]}
      />
      <form className="panel" onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="inspectionType">Inspection type</label>
            <select id="inspectionType" {...register('inspectionType')}>
              {Object.values(InspectionType).map((type) => (
                <option key={type} value={type}>
                  {inspectionTypeLabel(type)}
                </option>
              ))}
            </select>
            <small>{inspectionTypeGuidance(inspectionType)}</small>
          </div>
          <div className="field">
            <label htmlFor="portfolioId">Portfolio</label>
            <input type="hidden" {...register('portfolioId')} />
            <SearchableSelect
              id="portfolioId"
              value={portfolioId}
              options={portfolioOptions}
              selectedOption={
                prefill.data
                  ? { value: prefill.data.portfolio.id, label: prefill.data.portfolio.name }
                  : undefined
              }
              placeholder={portfolios.isLoading ? 'Loading portfolios…' : 'Select portfolio'}
              searchPlaceholder="Search portfolios…"
              emptyMessage="No active portfolio matches your search."
              optionsLabel="Portfolio options"
              loadingMoreLabel="Loading more portfolios…"
              moreHint="Scroll for more portfolios"
              disabled={portfolios.isLoading || portfolios.isError}
              hasMore={portfolios.hasNextPage}
              loadingMore={portfolios.isFetchingNextPage}
              onSearch={setPortfolioSearch}
              onLoadMore={() => void portfolios.fetchNextPage()}
              onChange={(nextPortfolioId) => {
                setValue('portfolioId', nextPortfolioId, { shouldValidate: true });
                setValue('propertyId', '');
                setValue('unitId', '');
                setValue('leaseId', '');
                setPropertySearch('');
                setSelectedProperty(null);
                mutation.reset();
              }}
            />
            {errors.portfolioId ? (
              <span className="field-error">{errors.portfolioId.message}</span>
            ) : null}
            {portfolios.isError ? (
              <span className="field-error">{portfolios.error.message}</span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="propertyId">Property</label>
            <input type="hidden" {...register('propertyId')} />
            <SearchableSelect
              id="propertyId"
              value={propertyId}
              options={propertyOptions}
              selectedOption={
                selectedProperty
                  ? {
                      value: selectedProperty.id,
                      label: propertyAddress(selectedProperty)
                        ? `${selectedProperty.name} — ${propertyAddress(selectedProperty)}`
                        : selectedProperty.name,
                    }
                  : undefined
              }
              placeholder={
                !portfolioId
                  ? 'Select a portfolio first'
                  : properties.isLoading
                    ? 'Loading properties…'
                    : 'Select property'
              }
              searchPlaceholder="Search name, address, or city…"
              emptyMessage="No active property matches your search."
              optionsLabel="Property options"
              loadingMoreLabel="Loading more properties…"
              moreHint="Scroll for more properties"
              disabled={!portfolioId || properties.isLoading || properties.isError}
              hasMore={properties.hasNextPage}
              loadingMore={properties.isFetchingNextPage}
              onSearch={setPropertySearch}
              onLoadMore={() => void properties.fetchNextPage()}
              onChange={(nextPropertyId) => {
                setValue('propertyId', nextPropertyId, { shouldValidate: true });
                setSelectedProperty(
                  propertyRecords.find((item) => item.id === nextPropertyId) ?? null,
                );
                setValue('unitId', '');
                setValue('leaseId', '');
                mutation.reset();
              }}
            />
            {errors.propertyId ? (
              <span className="field-error">{errors.propertyId.message}</span>
            ) : null}
            {properties.isError ? (
              <span className="field-error">{properties.error.message}</span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="propertyAddress">Property address</label>
            <input
              id="propertyAddress"
              value={propertyAddress(selectedProperty)}
              readOnly
              aria-readonly="true"
              placeholder={
                propertyId ? 'Address not provided' : 'Populated after property selection'
              }
            />
          </div>
          <div className="field">
            <label htmlFor="unitId">Unit (optional)</label>
            <select
              id="unitId"
              {...register('unitId')}
              disabled={!propertyId || units.isLoading}
              onChange={(event) => {
                setValue('unitId', event.target.value, { shouldValidate: true });
                setValue('leaseId', '');
              }}
            >
              <option value="">Inspect the entire property</option>
              {units.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            {units.isError ? <span className="field-error">{units.error.message}</span> : null}
            {propertyId && units.data?.items.length === 0 ? (
              <small>
                No active units are synchronized; this will be a property-level inspection.
              </small>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="leaseId">Lease (optional)</label>
            <select id="leaseId" {...register('leaseId')} disabled={!unitId || leases.isLoading}>
              <option value="">No lease selected</option>
              {leases.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.leaseName ?? item.externalId}
                </option>
              ))}
            </select>
            {leases.isError ? <span className="field-error">{leases.error.message}</span> : null}
            {inspectionType === InspectionType.BACK_TO_MARKET ? (
              <small>
                Back-to-market inspections are normally scheduled about 60 days before the lease
                ends. Confirm the actual date with operations.
              </small>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="scheduledAt">Scheduled date and time</label>
            <input id="scheduledAt" type="datetime-local" {...register('scheduledAt')} />
            {errors.scheduledAt ? (
              <span className="field-error">{errors.scheduledAt.message}</span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="priority">Priority</label>
            <select id="priority" {...register('priority')}>
              <option value="STANDARD">Standard</option>
              <option value="HIGH">High</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="technicianId">Initial technician (optional)</label>
            <select id="technicianId" {...register('technicianId')}>
              <option value="">Leave unassigned</option>
              {technicians.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName} · {item.workload?.current ?? 0} current
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="internalNotes">Internal notes</label>
            <textarea
              id="internalNotes"
              {...register('internalNotes')}
              placeholder="Visible to authorized operations staff"
            />
            {errors.internalNotes ? (
              <span className="field-error">{errors.internalNotes.message}</span>
            ) : null}
          </div>
        </div>
        {needsAreaSetup ? (
          <div className="alert alert-warning" role="alert">
            <span>
              This property needs at least one approved inspection area before an inspection can be
              created. If a detailed area list is not ready, continue with one required Entire
              property area.
            </span>
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={fallbackArea.isPending}
              onClick={() => fallbackArea.mutate({ propertyId })}
            >
              {fallbackArea.isPending ? 'Preparing area…' : 'Use entire property for now'}
            </button>{' '}
            <Link href={`/properties/${propertyId}#floor-plan-heading`}>
              Set up detailed floor plan and areas
            </Link>
          </div>
        ) : mutation.error || fallbackArea.error ? (
          <p className="field-error" role="alert">
            {(mutation.error ?? fallbackArea.error)?.message}
          </p>
        ) : null}
        {propertyAreas.isError ? (
          <p className="field-error" role="alert">
            {propertyAreas.error.message}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={() => router.back()}>
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={
              isSubmitting || mutation.isPending || propertyAreas.isLoading || needsAreaSetup
            }
          >
            {isSubmitting ? 'Creating…' : 'Create inspection'}
          </button>
        </div>
      </form>
    </>
  );
}

function inspectionTypeLabel(type: InspectionType) {
  return {
    [InspectionType.MOVE_IN]: 'Move-in',
    [InspectionType.OCCUPIED]: 'Occupied',
    [InspectionType.BACK_TO_MARKET]: 'Back-to-market',
    [InspectionType.MOVE_OUT]: 'Move-out',
  }[type];
}

function inspectionTypeGuidance(type: InspectionType) {
  return {
    [InspectionType.MOVE_IN]: 'Establishes the initial condition baseline for this occupancy.',
    [InspectionType.OCCUPIED]: 'A repeatable health check compared with the move-in baseline.',
    [InspectionType.BACK_TO_MARKET]: 'Prepares the property for marketing before lease end.',
    [InspectionType.MOVE_OUT]: 'Final condition inspection after the back-to-market inspection.',
  }[type];
}

export default function CreateInspectionPage() {
  return (
    <Suspense fallback={<div className="panel">Loading form…</div>}>
      <CreateInspectionForm />
    </Suspense>
  );
}
