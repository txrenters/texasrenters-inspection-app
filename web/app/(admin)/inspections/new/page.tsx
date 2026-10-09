'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AreaScope,
  InspectionType,
  areaScopeFor,
  booksAnyService,
  inspectionSeedsStandardLayout,
  isBookableInspectionType,
  isDemoProperty,
  layoutAreasFor,
  visitServicesProblems,
  type AdminProperty,
} from '@texasrenters/shared';
import { CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { JobberBookingCard } from '@/components/jobber-booking-card';
import { PageHeader } from '@/components/page-header';
import { SearchableSelect } from '@/components/searchable-select';
import { PageSkeleton } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { VisitServicesCard } from '@/components/visit-services-card';
import { INSPECTION_TYPE_CHILDREN } from '@/lib/admin-navigation';
import { ApiError } from '@/lib/api';
import { humanize } from '@/lib/format';
import {
  bookingForm,
  bookingFromForm,
  bookingUnavailableReason,
  defaultVisitServices,
  servicesFromForm,
} from '@/lib/jobber-booking';
import { propertyOptionLabel } from '@/lib/property-label';
import {
  useAdminMutations,
  useLeases,
  usePortfolios,
  useProperty,
  usePropertyAreas,
  usePropertyOptions,
  useJobberBookingContext,
  useTechnicians,
  useUnits,
} from '@/lib/queries';

// Radix Select rejects an empty string as an item value; the "nothing selected"
// row carries a sentinel translated back to '' for the form.
const NONE = '__none__';

const NOTES_LIMIT = 2000;

const schema = z.object({
  // Optional: derived from the chosen property, and never sent to the API — it
  // exists only to narrow the property list.
  portfolioId: z.string(),
  propertyId: z.string().min(1, 'Select a property.'),
  unitId: z.string().optional(),
  leaseId: z.string().optional(),
  technicianId: z.string().optional(),
  inspectionType: z.nativeEnum(InspectionType),
  scheduledAt: z.string().min(1, 'Select a date.'),
  priority: z.enum(['STANDARD', 'HIGH']),
  internalNotes: z.string().max(NOTES_LIMIT).optional(),
});
type Values = z.infer<typeof schema>;

/**
 * The types the navigation does not name, the only ones still spelled here: the
 * rest take the navigation's own titles, so the form and the sidebar cannot
 * call the same type two things (console-development).
 */
const OTHER_TYPE_LABEL: Partial<Record<InspectionType, string>> = {
  [InspectionType.ROOF]: 'Roof',
  [InspectionType.SUPRA_LOCKBOX_PLACEMENT]: 'Supra + lockbox placement',
  [InspectionType.SUPRA_LOCKBOX_REMOVAL]: 'Supra + lockbox removal',
  [InspectionType.AC_FILTER_DELIVERY]: 'AC filter delivery',
};

function inspectionTypeLabel(type: InspectionType) {
  return (
    INSPECTION_TYPE_CHILDREN.find((child) => child.type === type)?.title ??
    OTHER_TYPE_LABEL[type] ??
    humanize(type)
  );
}

function inspectionTypeGuidance(type: InspectionType) {
  return {
    [InspectionType.MOVE_IN]: 'Establishes the initial condition baseline for this occupancy.',
    [InspectionType.OCCUPIED]: 'A repeatable health check compared with the move-in baseline.',
    [InspectionType.BACK_TO_MARKET]: 'Prepares the property for marketing before lease end.',
    [InspectionType.MOVE_OUT]: 'Final condition inspection after the back-to-market inspection.',
    [InspectionType.HVAC]:
      'Heating and cooling equipment check. Scheduled independently of the tenancy lifecycle.',
    [InspectionType.ROOF]:
      'Covers every area recorded as a roof. The property decides the scope, so there is nothing to select.',
    [InspectionType.SUPRA_LOCKBOX_PLACEMENT]:
      'Fitting the lockbox. Choose the area it goes on so the photographs have somewhere to file.',
    [InspectionType.SUPRA_LOCKBOX_REMOVAL]:
      'Collecting the lockbox. Choose the area it is coming off.',
    [InspectionType.AC_FILTER_DELIVERY]:
      'Covers every area that has an air conditioner, the same scope as an HVAC visit.',
  }[type];
}

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
   * feeding the derived value back would silently restrict the list to the first
   * property's portfolio and make the next one impossible to find.
   */
  const [portfolioFilterId, setPortfolioFilterId] = useState('');
  const [selectedProperty, setSelectedProperty] = useState<AdminProperty | null>(null);
  const prefillId = search.get('propertyId') ?? '';
  /**
   * The type carried over from the section this was opened from, so "Create
   * inspection" inside Move-out creates a move-out.
   *
   * Validated against the enum rather than trusted: the value comes from the
   * address bar, and an unrecognized one falls back to the default instead of
   * seeding the form with something the API will reject on submit. Still a
   * prefill, not a lock — the type select below stays editable.
   */
  const prefillType = search.get('type');
  const prefilledType = Object.values(InspectionType).includes(prefillType as InspectionType)
    ? (prefillType as InspectionType)
    : undefined;
  const defaultType = prefilledType ?? InspectionType.MOVE_IN;
  /**
   * The technician and the day, carried over from the technician map's "New
   * visit here" (the office, 2026-10-02: add visits to a technician's day from
   * the map). Prefills, like the type, never locks. A date not in the picker's
   * own `YYYY-MM-DD` form is left for the coordinator to choose rather than
   * seeding a value the picker cannot show.
   */
  const prefillTechnicianId = search.get('technicianId') ?? '';
  const prefillDate = search.get('date') ?? '';
  const prefilledDate = /^\d{4}-\d{2}-\d{2}$/.test(prefillDate) ? prefillDate : '';
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
      technicianId: prefillTechnicianId,
      inspectionType: defaultType,
      scheduledAt: prefilledDate,
      priority: 'STANDARD',
      internalNotes: '',
    },
  });

  const portfolioId = watch('portfolioId');
  const propertyId = watch('propertyId');
  const unitId = watch('unitId');
  const inspectionType = watch('inspectionType');
  const internalNotes = watch('internalNotes') ?? '';

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
          /**
           * This is the form the badge matters most on.
           *
           * Booking a visit at a demo property sends a technician to an address
           * that does not exist, and the picker offers it in the same list as
           * 570 real homes. The badge stays on the trigger after the choice is
           * made, so it is still on screen at the moment somebody submits.
           */
          badge: isDemoProperty(item) ? 'Demo' : undefined,
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

  const leaseId = watch('leaseId');
  const technicianId = watch('technicianId');
  const scheduledAt = watch('scheduledAt');
  /**
   * The Jobber booking, offered for every kind of visit the office books in Jobber.
   *
   * Started from the tenant report once per property, unit and lease, and not
   * again for the same one: choosing a technician refetches whether they can be
   * put on the visit, and must not wipe what the coordinator typed.
   */
  const bookable = isBookableInspectionType(inspectionType);
  const bookingContext = useJobberBookingContext(
    {
      propertyId,
      unitId: unitId || undefined,
      leaseId: leaseId || undefined,
      technicianId: technicianId || undefined,
    },
    bookable,
  );
  const [bookInJobber, setBookInJobber] = useState(true);
  const [bookingFormState, setBookingFormState] = useState(() => bookingForm(null, defaultType));
  const [prefilledFor, setPrefilledFor] = useState('');
  const bookingPlace = [propertyId, unitId ?? '', leaseId ?? ''].join('|');
  useEffect(() => {
    // Placeholder data is the previous property's answer, not this one's.
    if (!bookingContext.data || bookingContext.isPlaceholderData || prefilledFor === bookingPlace) return;
    const prefill = bookingContext.data.prefill;
    // The services are the coordinator's choice, not the tenancy's: kept.
    setBookingFormState((current) => ({ ...bookingForm(prefill), services: current.services }));
    setPrefilledFor(bookingPlace);
  }, [bookingContext.data, bookingContext.isPlaceholderData, bookingPlace, prefilledFor]);
  /**
   * Each kind of visit starts with its own services: an occupied visit with the
   * filter change and pest control, any other with none.
   */
  useEffect(() => {
    setBookingFormState((current) => ({ ...current, services: defaultVisitServices(inspectionType) }));
  }, [inspectionType]);
  // The answer for this property, unit and lease. A kept placeholder stands in
  // only while the technician alone changed; for another property it is wrong.
  const bookingContextHere =
    bookingContext.data && (!bookingContext.isPlaceholderData || prefilledFor === bookingPlace)
      ? bookingContext.data
      : undefined;
  const bookingPending = bookable && Boolean(propertyId) && !bookingContextHere && !bookingContext.error;
  const bookingActive =
    bookable &&
    bookInJobber &&
    bookingContextHere !== undefined &&
    bookingUnavailableReason(bookingContextHere) === null;
  // Written whether or not the visit is booked here, so checked either way.
  const servicesProblems = bookable ? visitServicesProblems(servicesFromForm(bookingFormState)) : [];

  /**
   * Exactly what the server will accept, decided by the server's own function.
   *
   * This listed every approved area and the server scopes an inspection with
   * `layoutAreasFor`, which is not the same set. It drops the areas that are
   * not rooms -- an HVAC visit's A/C unit, filters, thermostat and attic all
   * live on the property as `SYSTEM` areas -- and, once a real floor plan or
   * an imported report has arrived, the standard template's guesses too.
   *
   * Two symptoms, one cause. The occupied form offered "AC filters", "Filters",
   * "A/C unit" and "Thermostat" as rooms to walk, next to a phone that has a
   * dedicated AC Filter Change screen for exactly that work. And clearing any
   * single area sent the list of ids explicitly for the first time -- with
   * everything ticked the form sends none and the server quietly uses its own
   * set -- so the rejected ids finally surfaced, as
   * "Select only approved areas belonging to this property" on an untouched
   * form where every area shown really did belong to the property.
   */
  const approvedAreas = layoutAreasFor(
    propertyAreas.data?.filter(
      (area) =>
        area.status === 'APPROVED' &&
        (unitId ? !area.unitId || area.unitId === unitId : !area.unitId),
    ) ?? [],
  );
  const hasApprovedAreas = approvedAreas.length > 0;
  const needsAreaSetup =
    Boolean(propertyId) && !propertyAreas.isLoading && !propertyAreas.isError && !hasApprovedAreas;
  /**
   * Whether this type is given the standard layout rather than refused.
   *
   * The same function the API decides with, so the form cannot disable a
   * button over a property the server would have accepted. A roof inspection
   * is the one that still needs a real layout: it covers areas *recorded as a
   * roof* and the template records none.
   */
  const layoutWillBeSeeded = inspectionSeedsStandardLayout(inspectionType);
  // How many of the areas this inspection will cover have a checklist an
  // administrator wrote. Zero is not an error — the technician gets a generated
  // list — but it is worth knowing here, because this is where someone decides
  // what the visit is for and the checklist lives on another screen entirely.
  const areasWithChecklist = approvedAreas.filter(
    (area) => (area._count?.checklistItems ?? 0) > 0,
  ).length;

  // Resets whenever the property changes: it is a decision about one property's
  // missing floor plan, and carrying it to the next one would schedule a survey
  // nobody asked for.
  const [technicianWillCapture, setTechnicianWillCapture] = useState(false);
  useEffect(() => setTechnicianWillCapture(false), [propertyId]);
  // Settled either way: the technician will survey it, or the standard layout
  // is what it gets.
  const areaSetupResolved = technicianWillCapture || layoutWillBeSeeded;

  /**
   * Which areas this inspection covers, when the type allows a choice.
   *
   * Move-in and move-out always take the whole layout — they are compared to
   * each other area by area, and a subset on either end leaves the other with
   * counterparts that never resolve. The picker is therefore hidden for those
   * rather than shown disabled: there is no decision to make.
   *
   * Held as the *excluded* set, so an area added to the property after this
   * form was opened is included by default. Tracking the included set instead
   * would silently drop it, which is the wrong way round for a scope decision.
   */
  const [excludedAreaIds, setExcludedAreaIds] = useState<ReadonlySet<string>>(new Set());
  // A scope decision about one property, and about one kind of visit.
  useEffect(() => setExcludedAreaIds(new Set()), [propertyId, unitId, inspectionType]);
  /**
   * Only one of the three scopes offers a choice.
   *
   * This asked `!inspectionRequiresEveryArea(...)`, which is the wrong
   * question: that returns true for ALL, so anything else — including HVAC —
   * looked choosable. The picker was then rendered for an HVAC visit, and
   * clearing a single area sent `areaIds` the backend refuses outright. An HVAC
   * visit inspects the property's system as one subject, so there is nothing
   * here to decide.
   */
  const scopeIsChoosable = areaScopeFor(inspectionType) === AreaScope.CHOSEN && hasApprovedAreas;
  const hvacScope = areaScopeFor(inspectionType) === AreaScope.HVAC_SYSTEM;
  const roofScope = areaScopeFor(inspectionType) === AreaScope.ROOF_AREAS;
  const roofAreas = approvedAreas.filter((area) => area.category === 'ROOF');
  const selectedAreas = approvedAreas.filter((area) => !excludedAreaIds.has(area.id));

  useEffect(() => {
    if (prefill.data) {
      // Empty rather than absent: the portfolio field is a filter, and a property
      // with no portfolio should clear it, not leave a stale one.
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
      setError('unitId', { type: 'manual', message: 'Choose the unit this inspection covers.' });
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
        // Only meaningful for a property with no approved areas, and the checkbox
        // is only offered there — but sent as chosen rather than re-derived, so
        // the record says what was decided.
        allowTechnicianAreaCapture: technicianWillCapture || undefined,
        jobberBooking: bookingActive ? bookingFromForm(bookingFormState) : undefined,
        // Not booked from here, the services are still the technician's to do:
        // the inspection carries them for the phone.
        visitServices:
          bookable && !bookingActive && booksAnyService(bookingFormState.services)
            ? servicesFromForm(bookingFormState)
            : undefined,
        // Only when it is genuinely a subset. Sending every id would be
        // refused for a move-in or move-out, and says nothing extra otherwise.
        areaIds:
          scopeIsChoosable && selectedAreas.length < approvedAreas.length
            ? selectedAreas.map((area) => area.id)
            : undefined,
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
      // The mutation error is rendered below the form without rejecting submit.
    }
  }

  return (
    <>
      {/* The page's rule one click away rather than above the form
          (console-development): it is read once, not on every visit booked. */}
      <PageHeader
        info="Schedule the property lifecycle in order. The approved floor plan is reused while every inspection keeps its own auditable evidence."
        title={`Create ${inspectionTypeLabel(inspectionType).toLowerCase()} inspection`}
      />

      {/* Grouped into three questions — what, where, when and who — rather than
          the old single ten-field grid, where "Portfolio (optional filter)" sat
          between the inspection type and the property with nothing to say it was
          a search aid rather than part of the record. */}
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <Card>
          <CardHeader>
            <CardTitle variant="label">What kind of inspection</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="inspectionType">Inspection type</FieldLabel>
              {/* Opened from a section, the type is already decided — the whole
                  point of the split. A dropdown here would invite changing it
                  and quietly file the inspection somewhere other than the
                  section it was created from.

                  A read-only input rather than plain text: it is announced as a
                  field with a value, keeps the row aligned with Priority beside
                  it, and stays selectable. The real value lives in form state,
                  so this element is display only. */}
              {prefilledType ? (
                <Input
                  className="bg-muted/50 text-muted-foreground"
                  id="inspectionType"
                  readOnly
                  value={inspectionTypeLabel(inspectionType)}
                />
              ) : (
                <Controller
                  control={control}
                  name="inspectionType"
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger className="w-full" id="inspectionType">
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
              )}
              <FieldDescription>{inspectionTypeGuidance(inspectionType)}</FieldDescription>
              {/* Which areas, for the types that choose none: said under the
                  type that decides it, where a card holding only this sentence
                  used to sit further down (console-development). "No picker"
                  on its own would read as a missing control. */}
              {hvacScope ? (
                <FieldDescription>
                  None to pick. An HVAC inspection is walked in the office&apos;s HVAC report&apos;s four
                  sections &mdash; Attic, Filters, A/C unit and Thermostat &mdash; each photographed with
                  every row answered, so it needs no floor plan and covers no rooms.
                </FieldDescription>
              ) : null}
              {roofScope && hasApprovedAreas ? (
                <FieldDescription>
                  A roof inspection covers every area categorised as a roof, so it is not chosen here
                  — the floor plan decides it.
                </FieldDescription>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="priority">Priority</FieldLabel>
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger className="w-full" id="priority">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle variant="label">Which property</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="portfolioId">Portfolio (optional filter)</FieldLabel>
              <Input type="hidden" {...register('portfolioId')} />
              <SearchableSelect
                disabled={portfolios.isLoading || portfolios.isError}
                emptyMessage="No active portfolio matches your search."
                hasMore={portfolios.hasNextPage}
                id="portfolioId"
                loadingMore={portfolios.isFetchingNextPage}
                loadingMoreLabel="Loading more portfolios…"
                moreHint="Scroll for more portfolios"
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
                onLoadMore={() => void portfolios.fetchNextPage()}
                onSearch={setPortfolioSearch}
                options={portfolioOptions}
                optionsLabel="Portfolio options"
                placeholder={portfolios.isLoading ? 'Loading portfolios…' : 'All portfolios'}
                searchPlaceholder="Search portfolios…"
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
                value={portfolioId}
              />
              {/* Under the control it is about rather than over the card
                  (console-development). */}
              <FieldDescription>
                The portfolio is only a filter for the property list - it is not part of the
                inspection record, and it fills itself in once a property is chosen.
              </FieldDescription>
              <FieldError>
                {errors.portfolioId?.message ??
                  (portfolios.isError ? portfolios.error.message : null)}
              </FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="propertyId">Property</FieldLabel>
              <Input type="hidden" {...register('propertyId')} />
              <SearchableSelect
                disabled={properties.isLoading || properties.isError}
                emptyMessage="No active property matches your search."
                hasMore={properties.hasNextPage}
                id="propertyId"
                loadingMore={properties.isFetchingNextPage}
                loadingMoreLabel="Loading more properties…"
                moreHint="Scroll for more properties"
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
                onLoadMore={() => void properties.fetchNextPage()}
                onSearch={setPropertySearch}
                options={propertyOptions}
                optionsLabel="Property options"
                placeholder={
                  properties.isLoading ? 'Loading properties…' : 'Search by address or name'
                }
                searchPlaceholder="Search name, address, or city…"
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
                value={propertyId}
              />
              <FieldError>
                {errors.propertyId?.message ??
                  (properties.isError ? properties.error.message : null)}
              </FieldError>
              {/* The address confirms the right property was picked. It was a
                  read-only <input> before, which looks editable and takes a tab
                  stop for something nobody can change. */}
              {selectedProperty ? (
                <FieldDescription>
                  {propertyAddress(selectedProperty) || 'Address not provided'}
                </FieldDescription>
              ) : null}
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
                    <SelectTrigger
                      aria-invalid={errors.unitId ? true : undefined}
                      className="w-full"
                      id="unitId"
                    >
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
                <FieldDescription>
                  This property has units - choose which unit this inspection covers.
                </FieldDescription>
              ) : propertyId && !units.isLoading ? (
                <FieldDescription>
                  No active units are synchronized; this will be a property-level inspection.
                </FieldDescription>
              ) : null}
              <FieldError>
                {errors.unitId?.message ?? (units.isError ? units.error.message : null)}
              </FieldError>
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
                    <SelectTrigger className="w-full" id="leaseId">
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
              {inspectionType === InspectionType.BACK_TO_MARKET ? (
                <FieldDescription>
                  Back-to-market inspections are normally scheduled about 60 days before the lease
                  ends. Confirm the actual date with operations.
                </FieldDescription>
              ) : null}
              <FieldError>{leases.isError ? leases.error.message : null}</FieldError>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle variant="label">When and who</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="scheduledAt">Scheduled date</FieldLabel>
              {/* Date only. An inspection is booked for a day — the hour and
                  minute the old datetime input collected were never used by any
                  part of the workflow, and the column is now a DATE. */}
              <Controller
                control={control}
                name="scheduledAt"
                render={({ field }) => (
                  <DatePicker id="scheduledAt" onChange={field.onChange} value={field.value} />
                )}
              />
              <FieldError>{errors.scheduledAt?.message}</FieldError>
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
                    <SelectTrigger className="w-full" id="technicianId">
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
              <FieldDescription>
                An unassigned inspection reaches nobody until it is assigned.
              </FieldDescription>
            </Field>

            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="internalNotes">Internal notes</FieldLabel>
              <Textarea
                id="internalNotes"
                maxLength={NOTES_LIMIT}
                placeholder="Visible to authorized operations staff"
                {...register('internalNotes')}
              />
              <FieldDescription>
                {internalNotes.length}/{NOTES_LIMIT} characters
              </FieldDescription>
              <FieldError>{errors.internalNotes?.message}</FieldError>
            </Field>
          </CardContent>
        </Card>

        {bookable ? (
          <VisitServicesCard
            booked={bookingActive}
            form={bookingFormState}
            inspectionType={inspectionType}
            onChange={setBookingFormState}
          />
        ) : null}

        {bookable ? (
          <JobberBookingCard
            inspectionType={inspectionType}
            book={bookInJobber}
            context={bookingContextHere}
            error={bookingContext.error}
            form={bookingFormState}
            loading={bookingPending}
            onBookChange={setBookInJobber}
            onChange={setBookingFormState}
            scheduledOn={scheduledAt}
          />
        ) : null}

        {/* Scope, for the types that inspect part of a property. Hidden rather
            than disabled for move-in and move-out: they always cover the whole
            layout, so there is no decision to present. */}
        {scopeIsChoosable ? (
          <Card>
            <CardHeader>
              <CardTitle variant="label">Which areas</CardTitle>
              <CardDescription>
                {inspectionTypeLabel(inspectionType)} inspections cover the areas you choose.
                Everything is included unless you clear it.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {approvedAreas.map((area) => (
                <label
                  className="hover:bg-accent flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm"
                  key={area.id}
                >
                  <Checkbox
                    checked={!excludedAreaIds.has(area.id)}
                    onCheckedChange={(checked) =>
                      setExcludedAreaIds((current) => {
                        const next = new Set(current);
                        if (checked === true) next.delete(area.id);
                        else next.add(area.id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{area.name}</span>
                  {area.floor?.name ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {area.floor.name}
                    </span>
                  ) : null}
                </label>
              ))}
            </CardContent>
            <CardFooter className="justify-between border-t">
              <p className="text-muted-foreground text-sm">
                {selectedAreas.length} of {approvedAreas.length} areas
              </p>
              {/* Clearing every area would schedule a visit with nothing to
                  inspect, so the submit gate below refuses it and this says so
                  where the decision is made. */}
              {selectedAreas.length === 0 ? (
                <p className="text-destructive text-sm">Select at least one area.</p>
              ) : null}
            </CardFooter>
          </Card>
        ) : null}

        {/* An HVAC visit's "which areas" is a sentence under the inspection
            type now, as is the roof's rule; the roof keeps this card for what
            it will actually cover (console-development). */}
        {roofScope && hasApprovedAreas ? (
          <Card>
            <CardHeader>
              <CardTitle variant="label">Which areas</CardTitle>
            </CardHeader>
            <CardContent>
              {roofAreas.length ? (
                <p className="text-sm">
                  {roofAreas.length} of {approvedAreas.length} areas:{' '}
                  <span className="font-medium">
                    {roofAreas.map((area) => area.name).join(', ')}
                  </span>
                </p>
              ) : (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertDescription>
                    No area of this property is categorised as a roof, so this visit would cover
                    nothing.{' '}
                    <Link
                      className="underline underline-offset-4"
                      href={`/properties/${propertyId}#floor-plan`}
                    >
                      Set an area&rsquo;s category to Roof
                    </Link>{' '}
                    first.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        ) : null}

        {/* Every area covered is a fact needing nothing, so a quiet line rather
            than a green-edged alert; a gap keeps the plain panel and its link
            (console-development). */}
        {!needsAreaSetup && approvedAreas.length ? (
          areasWithChecklist === approvedAreas.length ? (
            <p className="text-muted-foreground text-sm">
              All {approvedAreas.length} areas have a coverage checklist.
            </p>
          ) : (
            <Alert>
              <AlertDescription>
                <p>
                  {areasWithChecklist} of {approvedAreas.length} areas have a coverage checklist.
                  The rest fall back to a generated list.{' '}
                  <Link
                    className="underline underline-offset-4"
                    href={`/properties/${propertyId}#floor-plan`}
                  >
                    Set checklists for this property
                  </Link>
                </p>
              </AlertDescription>
            </Alert>
          )
        ) : null}

        {needsAreaSetup ? (
          /* Reads as a decision, not a warning. Three ways forward at three
             different visual weights left it unclear that they were alternatives
             to the same problem, and the amber kept insisting something was wrong
             after it had been resolved. Amber until it is, then a plain panel
             with a tick: a green edge under a warning triangle said both at
             once (console-development). */
          <Alert variant={areaSetupResolved ? 'default' : 'warning'}>
            {areaSetupResolved ? <CircleCheckIcon /> : <TriangleAlertIcon />}
            <AlertTitle>This property has no approved inspection areas</AlertTitle>
            <AlertDescription>
              {/* Not a warning when the visit can be created anyway: the
                  standard layout is what it will get, and the choices below are
                  a better answer rather than a way past a refusal. */}
              <p>
                {layoutWillBeSeeded
                  ? 'It will be given the standard layout — the usual rooms, with their checklists — which an administrator can correct afterwards. Or set it up now:'
                  : 'Choose how this inspection gets them.'}
              </p>

              {/* First because it keeps the per-area structure the whole review
                  is organised around, where the fallback flattens the property to
                  one area and loses it. */}
              {/* A row under a hairline, like the "Or" row below it, rather than
                  a bordered box inside the alert's own (console-development). */}
              <label
                className="mt-2 flex w-full cursor-pointer items-start gap-2.5 border-t pt-3"
                htmlFor="technician-area-capture"
              >
                <Checkbox
                  checked={technicianWillCapture}
                  className="mt-0.5"
                  id="technician-area-capture"
                  onCheckedChange={(checked) => setTechnicianWillCapture(checked === true)}
                />
                <span className="text-foreground min-w-0 grid gap-1">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    The technician surveys the areas on site
                    <Badge variant="info">Recommended</Badge>
                  </span>
                  <span className="text-muted-foreground text-xs leading-relaxed">
                    They add each area as they walk the property. Each one is saved here as a draft
                    for you to approve, so the layout is captured once and reused by every later
                    inspection.
                  </span>
                </span>
              </label>

              <div
                className={`mt-1 flex w-full flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3 text-xs ${
                  technicianWillCapture ? 'opacity-50' : ''
                }`}
              >
                <span className="text-muted-foreground">Or</span>
                <Button
                  disabled={fallbackArea.isPending || technicianWillCapture}
                  onClick={() => fallbackArea.mutate({ propertyId })}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {fallbackArea.isPending ? <Spinner /> : null}
                  {fallbackArea.isPending ? 'Preparing area…' : 'Inspect it as one single area'}
                </Button>
                <Link
                  className="underline underline-offset-4"
                  href={`/properties/${propertyId}#floor-plan`}
                >
                  Set up a floor plan first
                </Link>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {/* Its own block, not the setup alert's `else`: a failed create, or a
            failed "Inspect it as one single area", happens on exactly the
            property the setup alert shows for, and was never shown there. */}
        {mutation.error || fallbackArea.error ? (
          <Alert variant="destructive">
            <AlertDescription>{(mutation.error ?? fallbackArea.error)?.message}</AlertDescription>
          </Alert>
        ) : null}

        {propertyAreas.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{propertyAreas.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => router.back()} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              isSubmitting ||
              mutation.isPending ||
              propertyAreas.isLoading ||
              (scopeIsChoosable && selectedAreas.length === 0) ||
              // Only a type the API would refuse. Everything that walks rooms
              // is seeded the standard layout instead, so blocking here would
              // be the console inventing a rule the server does not have.
              (needsAreaSetup && !technicianWillCapture && !layoutWillBeSeeded) ||
              units.isLoading ||
              (requiresUnit && !unitId) ||
              // Not created while it is still unknown whether it will be booked,
              // or while the services it would write are ones the server refuses.
              bookingPending ||
              servicesProblems.length > 0
            }
            type="submit"
          >
            {isSubmitting ? <Spinner /> : null}
            {isSubmitting ? 'Creating…' : 'Create inspection'}
          </Button>
        </div>
      </form>
    </>
  );
}

export default function CreateInspectionPage() {
  return (
    // `useSearchParams` needs a Suspense boundary to keep the route from opting
    // the whole segment out of prerendering.
    <Suspense fallback={<PageSkeleton cards={3} />}>
      <CreateInspectionForm />
    </Suspense>
  );
}
