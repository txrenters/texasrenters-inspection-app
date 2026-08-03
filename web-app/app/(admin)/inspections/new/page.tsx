'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { InspectionType, type AdminProperty } from '@texasrenters/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import { PageHeader } from '@/components/shared';
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
import { ApiError } from '@/lib/api';
import { propertyOptionLabel } from '@/lib/property-label';

const schema = z.object({
  // Optional: derived from the chosen property, and never sent to the API —
  // it exists only to narrow the property list.
  portfolioId: z.string(),
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
  /**
   * The portfolio the coordinator explicitly picked, as opposed to the one
   * derived from a chosen property. Only this narrows the property list —
   * feeding the derived value back would silently restrict the list to the
   * first property's portfolio and make the next one impossible to find.
   */
  const [portfolioFilterId, setPortfolioFilterId] = useState('');
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
    control,
    watch,
    setValue,
    setError,
    clearErrors,
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
  const properties = usePropertyOptions(portfolioFilterId, propertySearch);
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
          label: propertyOptionLabel(item.name, itemAddress),
          searchText: [item.addressLine1, item.addressLine2, item.city, item.state, item.postalCode]
            .filter(Boolean)
            .join(' '),
        };
      }),
    [propertyRecords],
  );
  const units = useUnits(propertyId);
  const activeUnits = useMemo(
    () => units.data?.items.filter((unit) => unit.isActive) ?? [],
    [units.data?.items],
  );
  const requiresUnit = activeUnits.length > 0;
  const propertyAreas = usePropertyAreas(propertyId);
  const leases = useLeases(unitId ?? '');
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const mutations = useAdminMutations();
  const mutation = mutations.createInspection;
  const fallbackArea = mutations.createFallbackPropertyArea;
  const hasApprovedAreas =
    propertyAreas.data?.some(
      (area) =>
        area.status === 'APPROVED' &&
        (unitId ? !area.unitId || area.unitId === unitId : !area.unitId),
    ) ?? false;
  const needsAreaSetup =
    Boolean(propertyId) && !propertyAreas.isLoading && !propertyAreas.isError && !hasApprovedAreas;

  useEffect(() => {
    if (prefill.data) {
      // Empty rather than absent: the portfolio field is a filter, and a
      // property with no portfolio should clear it, not leave a stale one.
      setValue('portfolioId', prefill.data.portfolio?.id ?? '');
      setSelectedProperty(prefill.data);
    }
  }, [prefill.data, setValue]);
  useEffect(() => {
    if (activeUnits.length === 1) {
      setValue('unitId', activeUnits[0]!.id, { shouldValidate: true });
      clearErrors('unitId');
    }
    if (activeUnits.length === 0) {
      setValue('unitId', '');
      clearErrors('unitId');
    }
  }, [activeUnits, clearErrors, setValue]);

  async function submit(values: Values) {
    if (requiresUnit && !values.unitId) {
      setError('unitId', {
        type: 'manual',
        message: 'Choose the unit this inspection covers.',
      });
      return;
    }
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
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNIT_REQUIRED') {
        setError('unitId', {
          type: 'server',
          message: 'This property has units. Choose a unit before creating the inspection.',
        });
      }
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
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <form onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
        <div className="form-grid">
          <Field>
            <FieldLabel htmlFor="inspectionType">Inspection type</FieldLabel>
            <Controller
              control={control}
              name="inspectionType"
              render={({ field }) => (
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger id="inspectionType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(InspectionType).map((type) => (
                      <SelectItem key={type} value={type}>
                        {inspectionTypeLabel(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <small>{inspectionTypeGuidance(inspectionType)}</small>
          </Field>
          <Field>
            <FieldLabel htmlFor="portfolioId">Portfolio (optional filter)</FieldLabel>
            <Input type="hidden" {...register('portfolioId')} />
            <SearchableSelect
              id="portfolioId"
              value={portfolioId}
              options={portfolioOptions}
              selectedOption={
                // The auto-filled portfolio is usually absent from the loaded
                // page of options, so pass it explicitly or the trigger blanks.
                selectedProperty?.portfolio
                  ? {
                      value: selectedProperty.portfolio.id,
                      label: selectedProperty.portfolio.name,
                    }
                  : prefill.data?.portfolio
                    ? { value: prefill.data.portfolio.id, label: prefill.data.portfolio.name }
                    : undefined
              }
              placeholder={portfolios.isLoading ? 'Loading portfolios…' : 'All portfolios'}
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
                setPortfolioFilterId(nextPortfolioId);
                setValue('portfolioId', nextPortfolioId, { shouldValidate: true });
                setValue('propertyId', '');
                setValue('unitId', '');
                setValue('leaseId', '');
                clearErrors('unitId');
                setPropertySearch('');
                setSelectedProperty(null);
                mutation.reset();
              }}
            />
            {errors.portfolioId ? (
              <FieldError>{errors.portfolioId.message}</FieldError>
            ) : null}
            {portfolios.isError ? (
              <FieldError>{portfolios.error.message}</FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="propertyId">Property</FieldLabel>
            <Input type="hidden" {...register('propertyId')} />
            <SearchableSelect
              id="propertyId"
              value={propertyId}
              options={propertyOptions}
              selectedOption={
                selectedProperty
                  ? {
                      value: selectedProperty.id,
                      label: propertyOptionLabel(
                        selectedProperty.name,
                        propertyAddress(selectedProperty),
                      ),
                    }
                  : undefined
              }
              placeholder={
                properties.isLoading ? 'Loading properties…' : 'Search by address or name'
              }
              searchPlaceholder="Search name, address, or city…"
              emptyMessage="No active property matches your search."
              optionsLabel="Property options"
              loadingMoreLabel="Loading more properties…"
              moreHint="Scroll for more properties"
              disabled={properties.isLoading || properties.isError}
              hasMore={properties.hasNextPage}
              loadingMore={properties.isFetchingNextPage}
              onSearch={setPropertySearch}
              onLoadMore={() => void properties.fetchNextPage()}
              onChange={(nextPropertyId) => {
                setValue('propertyId', nextPropertyId, { shouldValidate: true });
                const record = propertyRecords.find((item) => item.id === nextPropertyId) ?? null;
                setSelectedProperty(record);
                // The portfolio is a property of the property, so derive it
                // rather than asking the coordinator to state it twice.
                if (record) {
                  setValue('portfolioId', record.portfolio?.id ?? '', { shouldValidate: true });
                  setPortfolioSearch('');
                }
                setValue('unitId', '');
                setValue('leaseId', '');
                clearErrors('unitId');
                mutation.reset();
              }}
            />
            {errors.propertyId ? (
              <FieldError>{errors.propertyId.message}</FieldError>
            ) : null}
            {properties.isError ? (
              <FieldError>{properties.error.message}</FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="propertyAddress">Property address</FieldLabel>
            <Input
              id="propertyAddress"
              value={propertyAddress(selectedProperty)}
              readOnly
              aria-readonly="true"
              placeholder={
                propertyId ? 'Address not provided' : 'Populated after property selection'
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="unitId">Unit{requiresUnit ? '' : ' (optional)'}</FieldLabel>
            <Controller
              control={control}
              name="unitId"
              render={({ field }) => (
                <Select
                  disabled={!propertyId || units.isLoading}
                  onValueChange={(next) => {
                    const value = next === NONE ? '' : next;
                    field.onChange(value);
                    setValue('unitId', value, { shouldValidate: true });
                    // A lease belongs to a unit, so it cannot survive the change.
                    setValue('leaseId', '');
                    if (value) clearErrors('unitId');
                  }}
                  value={field.value || NONE}
                >
                  <SelectTrigger id="unitId">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      {requiresUnit ? 'Select a unit' : 'Inspect the entire property'}
                    </SelectItem>
                    {activeUnits.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {requiresUnit ? (
              <small>This property has units — choose which unit this inspection covers.</small>
            ) : null}
            {errors.unitId ? <FieldError>{errors.unitId.message}</FieldError> : null}
            {units.isError ? <FieldError>{units.error.message}</FieldError> : null}
            {propertyId && activeUnits.length === 0 && !units.isLoading ? (
              <small>
                No active units are synchronized; this will be a property-level inspection.
              </small>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="leaseId">Lease (optional)</FieldLabel>
            <Controller
              control={control}
              name="leaseId"
              render={({ field }) => (
                <Select
                  disabled={!unitId || leases.isLoading}
                  onValueChange={(next) => field.onChange(next === NONE ? '' : next)}
                  value={field.value || NONE}
                >
                  <SelectTrigger id="leaseId">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No lease selected</SelectItem>
                    {leases.data?.items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.leaseName ?? item.externalId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {leases.isError ? <FieldError>{leases.error.message}</FieldError> : null}
            {inspectionType === InspectionType.BACK_TO_MARKET ? (
              <small>
                Back-to-market inspections are normally scheduled about 60 days before the lease
                ends. Confirm the actual date with operations.
              </small>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="scheduledAt">Scheduled date</FieldLabel>
            {/* Date only. An inspection is booked for a day — the hour and
                minute the old datetime input collected were never used by any
                part of the workflow, and the column is now a DATE. */}
            <Controller
              control={control}
              name="scheduledAt"
              render={({ field }) => (
                <DatePicker
                  id="scheduledAt"
                  onChange={field.onChange}
                  value={field.value}
                />
              )}
            />
            {errors.scheduledAt ? (
              <FieldError>{errors.scheduledAt.message}</FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="priority">Priority</FieldLabel>
            <Controller
              control={control}
              name="priority"
              render={({ field }) => (
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger id="priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STANDARD">Standard</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="technicianId">Initial technician (optional)</FieldLabel>
            <Controller
              control={control}
              name="technicianId"
              render={({ field }) => (
                <Select
                  onValueChange={(next) => field.onChange(next === NONE ? '' : next)}
                  value={field.value || NONE}
                >
                  <SelectTrigger id="technicianId">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Leave unassigned</SelectItem>
                    {technicians.data?.items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.displayName} · {item.workload?.current ?? 0} current
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="internalNotes">Internal notes</FieldLabel>
            <Textarea
              id="internalNotes"
              {...register('internalNotes')}
              placeholder="Visible to authorized operations staff"
            />
            {errors.internalNotes ? (
              <FieldError>{errors.internalNotes.message}</FieldError>
            ) : null}
          </Field>
        </div>
        {needsAreaSetup ? (
          <Alert variant="warning" role="alert">
            <span>
              This property needs at least one approved inspection area before an inspection can be
              created. If a detailed area list is not ready, continue with one required Entire
              property area.
            </span>
            <button
              type="button"
              className={buttonVariants({ variant: 'secondary', size: 'small' })}
              disabled={fallbackArea.isPending}
              onClick={() => fallbackArea.mutate({ propertyId })}
            >
              {fallbackArea.isPending ? 'Preparing area…' : 'Use entire property for now'}
            </button>{' '}
            <Link href={`/properties/${propertyId}#floor-plan-heading`}>
              Set up detailed floor plan and areas
            </Link>
          </Alert>
        ) : mutation.error || fallbackArea.error ? (
          <FieldError>
            {(mutation.error ?? fallbackArea.error)?.message}
          </FieldError>
        ) : null}
        {propertyAreas.isError ? (
          <FieldError>
            {propertyAreas.error.message}
          </FieldError>
        ) : null}
        <div className="form-actions">
          <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={() => router.back()}>
            Cancel
          </button>
          <button
            className={buttonVariants({ variant: 'primary' })}
            disabled={
              isSubmitting ||
              mutation.isPending ||
              propertyAreas.isLoading ||
              needsAreaSetup ||
              units.isLoading ||
              (requiresUnit && !unitId)
            }
          >
            {isSubmitting ? 'Creating…' : 'Create inspection'}
          </button>
        </div>
        </form>
      </Card>
    </>
  );
}

function inspectionTypeLabel(type: InspectionType) {
  return {
    [InspectionType.MOVE_IN]: 'Move-in',
    [InspectionType.OCCUPIED]: 'Occupied',
    [InspectionType.BACK_TO_MARKET]: 'Back-to-market',
    [InspectionType.MOVE_OUT]: 'Move-out',
    [InspectionType.HVAC]: 'HVAC',
  }[type];
}

function inspectionTypeGuidance(type: InspectionType) {
  return {
    [InspectionType.MOVE_IN]: 'Establishes the initial condition baseline for this occupancy.',
    [InspectionType.OCCUPIED]: 'A repeatable health check compared with the move-in baseline.',
    [InspectionType.BACK_TO_MARKET]: 'Prepares the property for marketing before lease end.',
    [InspectionType.MOVE_OUT]: 'Final condition inspection after the back-to-market inspection.',
    [InspectionType.HVAC]:
      'Heating and cooling equipment check. Scheduled independently of the tenancy lifecycle.',
  }[type];
}

// Radix Select rejects an empty string as an item value; the "nothing
// selected" row carries a sentinel translated back to '' for the form.
const NONE = '__none__';

export default function CreateInspectionPage() {
  return (
    <Suspense fallback={<Card className="p-[22px]">Loading form…</Card>}>
      <CreateInspectionForm />
    </Suspense>
  );
}
