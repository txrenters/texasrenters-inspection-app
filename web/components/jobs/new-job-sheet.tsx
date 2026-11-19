'use client';

import {
  AreaScope,
  JOB_INSPECTION_LABEL,
  JOB_INSPECTION_TYPES,
  VISIT_SERVICE_LABEL,
  REPORTABLE_VISIT_SERVICES,
  areaScopeFor,
  booksAnyService,
  inspectionSeedsStandardLayout,
  isBookableInspectionType,
  isDemoProperty,
  jobLeadType,
  jobTitleFor,
  layoutAreasFor,
  normalizeJobNumber,
  visitServicesProblems,
  type AdminProperty,
  type CreateJobInput,
  type JobInspectionType,
} from '@texasrenters/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CheckRow } from '@/components/booking-form-controls';
import { JobberBookingCard } from '@/components/jobber-booking-card';
import { SECTION_LABEL } from '@/components/panel';
import { SearchableSelect } from '@/components/searchable-select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { VisitServicesCard } from '@/components/visit-services-card';
import { ApiError } from '@/lib/api';
import { businessToday } from '@/lib/clock';
import { formatDay } from '@/lib/format';
import {
  bookingForm,
  bookingFromForm,
  bookingUnavailableReason,
  defaultVisitServices,
  servicesFromForm,
} from '@/lib/jobber-booking';
import { propertyOptionLabel } from '@/lib/property-label';
import {
  useCreateJob,
  useJobberBookingContext,
  useLeases,
  useNextJobNumber,
  useProperty,
  usePropertyAreas,
  usePropertyOptions,
  useTechnicians,
  useUnits,
} from '@/lib/queries';

import type { NewJobPrefill } from './new-job-context';

// Radix Select rejects an empty string as an item value.
const NONE = '__none__';
const NOTES_LIMIT = 2000;

function propertyAddress(property?: AdminProperty | null) {
  if (!property) return '';
  const cityState = [property.city, property.state].filter(Boolean).join(', ');
  const locality = [cityState, property.postalCode].filter(Boolean).join(' ');
  return [property.addressLine1, property.addressLine2, locality].filter(Boolean).join(', ');
}

/** "Occupied and HVAC", "Move-out", "Move-in, Occupied and HVAC". */
function listed(words: string[]) {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : (words[0] ?? '');
}

/**
 * The New job panel (2026-11-20, phase 2 of the jobs plan): one job, a number
 * and a title, at one property on one day, holding every inspection ticked
 * and the services that go with them. Saving makes them all at once through
 * POST /admin/jobs, so the technician is alerted once and Jobber gets one visit.
 *
 * It opens beside whatever page it was opened from, so the day and the
 * technician's other jobs stay in sight. A job of services alone is not offered
 * yet: today's phone cannot show one without rooms.
 */
export function NewJobSheet({ prefill, onClose }: { prefill: NewJobPrefill; onClose: () => void }) {
  const router = useRouter();
  const create = useCreateJob();
  const next = useNextJobNumber(true);
  // One press of Save, whatever happens to the response: a retry makes no second job.
  const [requestKey] = useState(() => crypto.randomUUID());

  const [number, setNumber] = useState('');
  const [numberTyped, setNumberTyped] = useState(false);
  const [title, setTitle] = useState('');

  const [propertyId, setPropertyId] = useState(prefill.propertyId ?? '');
  const [propertySearch, setPropertySearch] = useState('');
  const [selectedProperty, setSelectedProperty] = useState<AdminProperty | null>(null);
  const prefilledProperty = useProperty(prefill.propertyId ?? '');
  useEffect(() => {
    if (prefilledProperty.data) setSelectedProperty(prefilledProperty.data);
  }, [prefilledProperty.data]);
  const [unitId, setUnitId] = useState('');
  const [leaseId, setLeaseId] = useState('');

  const [day, setDay] = useState(prefill.date && /^\d{4}-\d{2}-\d{2}$/.test(prefill.date) ? prefill.date : businessToday());
  const [technicianId, setTechnicianId] = useState(prefill.technicianId ?? '');
  const [types, setTypes] = useState<ReadonlySet<JobInspectionType>>(new Set(prefill.inspectionTypes ?? []));
  const [notes, setNotes] = useState('');
  const [technicianWillCapture, setTechnicianWillCapture] = useState(false);

  const ordered = JOB_INSPECTION_TYPES.filter((type) => types.has(type));
  const lead = jobLeadType(ordered);
  const leadBookable = isBookableInspectionType(lead) ? lead : null;

  const properties = usePropertyOptions('', propertySearch);
  const propertyRecords = useMemo(() => properties.data?.pages.flatMap((page) => page.items) ?? [], [properties.data?.pages]);
  const propertyOptions = useMemo(
    () =>
      propertyRecords.map((item) => ({
        value: item.id,
        label: propertyOptionLabel(item.name, propertyAddress(item)),
        searchText: [item.addressLine1, item.addressLine2, item.city, item.state, item.postalCode].filter(Boolean).join(' '),
        badge: isDemoProperty(item) ? 'Demo' : undefined,
      })),
    [propertyRecords],
  );
  const units = useUnits(propertyId);
  const activeUnits = useMemo(() => units.data?.items.filter((unit) => unit.isActive) ?? [], [units.data?.items]);
  const requiresUnit = activeUnits.length > 0;
  useEffect(() => {
    // One unit is the unit; none is the whole property.
    if (activeUnits.length === 1) setUnitId(activeUnits[0]!.id);
    if (activeUnits.length === 0) setUnitId('');
  }, [activeUnits]);
  const leases = useLeases(unitId);
  const technicians = useTechnicians({ page: 1, pageSize: 100, active: true });
  const technicianName = technicians.data?.items.find((item) => item.id === technicianId)?.displayName;
  // A technician handed over (a Schedule column) who is not an active
  // technician any more: nobody, rather than a blank box the server refuses.
  useEffect(() => {
    if (technicianId && technicians.data && !technicians.data.items.some((item) => item.id === technicianId))
      setTechnicianId('');
  }, [technicianId, technicians.data]);

  /**
   * The services and the Jobber booking, as the create form keeps them. A job
   * with an occupied inspection starts with its filter change and pest control,
   * as an occupied visit always has -- also when HVAC beside it leads -- until
   * the office ticks a service itself.
   */
  const occupiedTicked = types.has('OCCUPIED');
  const [form, setForm] = useState(() => bookingForm(null, occupiedTicked ? 'OCCUPIED' : 'NONE'));
  const [servicesTouched, setServicesTouched] = useState(false);
  useEffect(() => {
    if (!servicesTouched)
      setForm((current) => ({ ...current, services: defaultVisitServices(occupiedTicked ? 'OCCUPIED' : 'NONE') }));
  }, [occupiedTicked, servicesTouched]);
  const changeForm = (nextForm: typeof form) => {
    if (nextForm.services !== form.services) setServicesTouched(true);
    setForm(nextForm);
  };

  const bookingContext = useJobberBookingContext(
    { propertyId, unitId: unitId || undefined, leaseId: leaseId || undefined, technicianId: technicianId || undefined },
    Boolean(leadBookable),
  );
  const [bookInJobber, setBookInJobber] = useState(true);
  const [prefilledFor, setPrefilledFor] = useState('');
  const bookingPlace = [propertyId, unitId, leaseId].join('|');
  useEffect(() => {
    if (!bookingContext.data || bookingContext.isPlaceholderData || prefilledFor === bookingPlace) return;
    // The services are the office's choice, not the tenancy's: kept.
    setForm((current) => ({ ...bookingForm(bookingContext.data.prefill), services: current.services }));
    setPrefilledFor(bookingPlace);
  }, [bookingContext.data, bookingContext.isPlaceholderData, bookingPlace, prefilledFor]);
  const bookingContextHere =
    bookingContext.data && (!bookingContext.isPlaceholderData || prefilledFor === bookingPlace) ? bookingContext.data : undefined;
  const bookingPending = Boolean(leadBookable) && Boolean(propertyId) && !bookingContextHere && !bookingContext.error;
  const bookingActive =
    Boolean(leadBookable) && bookInJobber && bookingContextHere !== undefined && bookingUnavailableReason(bookingContextHere) === null;
  const servicesProblems = leadBookable ? visitServicesProblems(servicesFromForm(form)) : [];
  const services = leadBookable ? form.services : null;

  /** Whether the property has a layout, and if not, whether every inspection ticked is given one anyway. */
  const propertyAreas = usePropertyAreas(propertyId);
  const approvedAreas = layoutAreasFor(
    propertyAreas.data?.filter(
      (area) => area.status === 'APPROVED' && (unitId ? !area.unitId || area.unitId === unitId : !area.unitId),
    ) ?? [],
  );
  const needsAreaSetup =
    Boolean(propertyId) && !propertyAreas.isLoading && !propertyAreas.isError && approvedAreas.length === 0;
  const layoutWillBeSeeded = ordered.every(
    (type) => areaScopeFor(type) === AreaScope.HVAC_SYSTEM || inspectionSeedsStandardLayout(type),
  );
  useEffect(() => setTechnicianWillCapture(false), [propertyId]);

  const autoTitle = jobTitleFor(ordered, services);
  const suggestedNumber = next.data?.number ?? '';
  const shownNumber = numberTyped ? number : suggestedNumber;
  const numberProblem =
    numberTyped && number.trim() && !normalizeJobNumber(number)
      ? 'Letters and digits, with - / . or _ between them, at most 40.'
      : null;
  const numberTaken = create.error instanceof ApiError && create.error.code === 'JOB_NUMBER_TAKEN' ? create.error.message : null;

  /** The first thing still in the way of saving, said beside the button. */
  const blocker = !propertyId
    ? 'Choose a property.'
    : requiresUnit && !unitId
      ? 'Choose the unit.'
      : !day
        ? 'Choose the day.'
        : ordered.length === 0
          ? 'Tick at least one inspection.'
          : numberProblem
            ? 'Fix the job number.'
            : servicesProblems.length
              ? 'Fix the services.'
              : needsAreaSetup && !layoutWillBeSeeded && !technicianWillCapture
                ? 'Decide how the areas are found.'
                : bookingPending || units.isLoading || propertyAreas.isLoading
                  ? 'Checking the property…'
                  : null;

  async function save(openAfter: boolean) {
    if (blocker || create.isPending) return;
    const input: CreateJobInput = {
      propertyId,
      unitId: unitId || undefined,
      leaseId: leaseId || undefined,
      scheduledAt: new Date(day).toISOString(),
      technicianId: technicianId || undefined,
      title: title.trim() || undefined,
      // Only a number the office typed: the one shown is not held, and the
      // server gives the next one free when this is left out.
      number: numberTyped && number.trim() ? number.trim() : undefined,
      inspectionTypes: ordered,
      visitServices:
        leadBookable && !bookingActive && booksAnyService(form.services) ? servicesFromForm(form) : undefined,
      jobberBooking: bookingActive ? bookingFromForm(form) : undefined,
      internalNotes: notes.trim() || undefined,
      allowTechnicianAreaCapture: technicianWillCapture || undefined,
      requestKey,
    };
    try {
      const job = await create.mutateAsync(input);
      toast.success(`Job ${job.number} saved`, { description: job.title });
      onClose();
      // The job's own page: every inspection in it, and the way to each (2026-11-20).
      if (openAfter) router.push(`/jobs/${job.id}`);
    } catch {
      // Shown in the panel; nothing is lost.
    }
  }

  const summary = [
    ordered.length
      ? `${ordered.length} ${ordered.length === 1 ? 'inspection' : 'inspections'}: ${listed(
          ordered.map((type) => JOB_INSPECTION_LABEL[type]),
        )}, each with its own report`
      : null,
    leadBookable && services && booksAnyService(services)
      ? `On the ${JOB_INSPECTION_LABEL[leadBookable]} inspection: ${listed(
          REPORTABLE_VISIT_SERVICES.filter((service) => services[service]).map((service) => VISIT_SERVICE_LABEL[service]),
        )}`
      : null,
    technicianName
      ? `${technicianName} gets one alert for the whole job`
      : 'Nobody is assigned yet, so it reaches no phone until somebody is',
    bookingActive && leadBookable ? `Jobber gets one visit, on the ${JOB_INSPECTION_LABEL[leadBookable]} inspection` : null,
  ].filter((line): line is string => Boolean(line));

  const toggle = (type: JobInspectionType) => (checked: boolean) =>
    setTypes((current) => {
      const nextTypes = new Set(current);
      if (checked) nextTypes.add(type);
      else nextTypes.delete(type);
      return nextTypes;
    });

  return (
    <Sheet onOpenChange={(open) => (open ? undefined : onClose())} open>
      <SheetContent className="w-full gap-0 sm:max-w-2xl" side="right">
        <SheetHeader className="border-b">
          <SheetTitle className="text-lg">New job</SheetTitle>
          <SheetDescription>
            {formatDay(day, 'long')}
            {prefill.from ? ` · ${prefill.from}` : ''}
          </SheetDescription>
        </SheetHeader>

        <SheetBody className="grid content-start gap-6 py-5">
          <section aria-labelledby="new-job-the-job" className="grid gap-3">
            <h3 className={SECTION_LABEL} id="new-job-the-job">
              The job
            </h3>
            <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
              <Field>
                <FieldLabel htmlFor="new-job-number">Job number</FieldLabel>
                <Input
                  aria-invalid={numberProblem || numberTaken ? true : undefined}
                  className="font-mono font-semibold"
                  id="new-job-number"
                  onChange={(event) => {
                    setNumberTyped(true);
                    setNumber(event.target.value);
                    create.reset();
                  }}
                  placeholder={next.isLoading ? 'Loading…' : 'J-00001'}
                  value={shownNumber}
                />
                <FieldDescription>The next one. Type over it if you like.</FieldDescription>
                <FieldError>{numberProblem ?? numberTaken}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-job-title">Title</FieldLabel>
                <Input
                  id="new-job-title"
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={autoTitle === 'Job' ? 'Follows what is ticked' : autoTitle}
                  value={title}
                />
                <FieldDescription>Follows what is ticked until you type your own.</FieldDescription>
              </Field>
            </div>
          </section>

          <section aria-labelledby="new-job-where" className="grid gap-3">
            <h3 className={SECTION_LABEL} id="new-job-where">
              Where
            </h3>
            <Field>
              <FieldLabel htmlFor="new-job-property">Property</FieldLabel>
              <SearchableSelect
                disabled={properties.isError}
                emptyMessage="No active property matches your search."
                hasMore={properties.hasNextPage}
                id="new-job-property"
                loadingMore={properties.isFetchingNextPage}
                loadingMoreLabel="Loading more properties…"
                moreHint="Scroll for more properties"
                onChange={(nextPropertyId) => {
                  setPropertyId(nextPropertyId);
                  setSelectedProperty(propertyRecords.find((item) => item.id === nextPropertyId) ?? null);
                  setUnitId('');
                  setLeaseId('');
                  create.reset();
                }}
                onLoadMore={() => void properties.fetchNextPage()}
                onSearch={setPropertySearch}
                options={propertyOptions}
                optionsLabel="Property options"
                placeholder={properties.isLoading ? 'Loading properties…' : 'Search by address or name'}
                searchPlaceholder="Search name, address, or city…"
                selectedOption={
                  selectedProperty
                    ? {
                        value: selectedProperty.id,
                        label: propertyOptionLabel(selectedProperty.name, propertyAddress(selectedProperty)),
                      }
                    : undefined
                }
                value={propertyId}
              />
              <FieldError>{properties.isError ? properties.error.message : null}</FieldError>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-job-unit">Unit{requiresUnit ? '' : ' (optional)'}</FieldLabel>
                <Select
                  disabled={!propertyId || units.isLoading}
                  onValueChange={(value) => {
                    setUnitId(value === NONE ? '' : value);
                    setLeaseId('');
                  }}
                  value={unitId || NONE}
                >
                  <SelectTrigger className="w-full" id="new-job-unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{requiresUnit ? 'Select a unit' : 'The whole property'}</SelectItem>
                    {activeUnits.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-job-lease">Lease (optional)</FieldLabel>
                <Select
                  disabled={!unitId || leases.isLoading}
                  onValueChange={(value) => setLeaseId(value === NONE ? '' : value)}
                  value={leaseId || NONE}
                >
                  <SelectTrigger className="w-full" id="new-job-lease">
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
              </Field>
            </div>
          </section>

          <section aria-labelledby="new-job-when" className="grid gap-3">
            <h3 className={SECTION_LABEL} id="new-job-when">
              When and who
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-job-day">Day</FieldLabel>
                <DatePicker id="new-job-day" onChange={setDay} value={day} />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-job-technician">Technician</FieldLabel>
                <Select onValueChange={(value) => setTechnicianId(value === NONE ? '' : value)} value={technicianId || NONE}>
                  <SelectTrigger className="w-full" id="new-job-technician">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Nobody yet</SelectItem>
                    {technicians.data?.items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </section>

          <section aria-labelledby="new-job-what" className="grid gap-3">
            <h3 className={SECTION_LABEL} id="new-job-what">
              What is in this job
            </h3>
            <fieldset className="grid gap-1 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Inspections</legend>
              <p className="text-muted-foreground text-xs">Each one is its own inspection, with its own report.</p>
              <div className="grid gap-x-6 sm:grid-cols-2">
                {JOB_INSPECTION_TYPES.map((type) => (
                  <CheckRow checked={types.has(type)} key={type} label={JOB_INSPECTION_LABEL[type]} onChange={toggle(type)} />
                ))}
              </div>
            </fieldset>

            {leadBookable ? (
              <VisitServicesCard booked={bookingActive} form={form} inspectionType={leadBookable} onChange={changeForm} />
            ) : (
              <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
                {ordered.length
                  ? 'Services go with an occupied, move-in, move-out, back-to-market or HVAC inspection. Tick one of those to add the filter change, pest control or a flea treatment.'
                  : 'Tick an inspection first. The filter change, pest control and a flea treatment go with it. A job of services alone comes with the next phone update.'}
              </p>
            )}

            {needsAreaSetup && ordered.length && !layoutWillBeSeeded ? (
              <Alert variant={technicianWillCapture ? 'default' : 'warning'}>
                <AlertTitle>This property has no approved inspection areas</AlertTitle>
                <AlertDescription>
                  <label className="mt-1 flex cursor-pointer items-start gap-2.5" htmlFor="new-job-capture">
                    <Checkbox
                      checked={technicianWillCapture}
                      className="mt-0.5"
                      id="new-job-capture"
                      onCheckedChange={(checked) => setTechnicianWillCapture(checked === true)}
                    />
                    <span className="text-foreground">
                      The technician surveys the areas on site. Each one is saved as a draft for you to approve.
                    </span>
                  </label>
                </AlertDescription>
              </Alert>
            ) : null}
          </section>

          {leadBookable ? (
            <JobberBookingCard
              book={bookInJobber}
              context={bookingContextHere}
              error={bookingContext.error}
              form={form}
              inspectionType={leadBookable}
              loading={bookingPending}
              onBookChange={setBookInJobber}
              onChange={changeForm}
              scheduledOn={day}
            />
          ) : null}

          <Field>
            <FieldLabel htmlFor="new-job-notes">Notes for the technician</FieldLabel>
            <Textarea
              id="new-job-notes"
              maxLength={NOTES_LIMIT}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="A gate code, a dog in the yard, when the tenant is home"
              value={notes}
            />
            <FieldDescription>Shown on the phone with the job.</FieldDescription>
          </Field>

          {ordered.length ? (
            <div className="bg-muted/40 grid gap-1.5 rounded-lg border p-4 text-sm" role="status">
              <strong>{shownNumber.trim() ? `Saving makes job ${shownNumber.trim()}` : 'Saving makes this job'}</strong>
              <ul className="text-muted-foreground list-disc pl-5">
                {summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {create.error && !numberTaken ? (
            <Alert variant="destructive">
              <AlertDescription>{create.error.message}</AlertDescription>
            </Alert>
          ) : null}
        </SheetBody>

        <SheetFooter className="flex-row flex-wrap items-center justify-end gap-2">
          {blocker ? <p className="text-muted-foreground mr-auto text-sm">{blocker}</p> : null}
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={Boolean(blocker) || create.isPending} onClick={() => void save(true)} type="button" variant="outline">
            Save and open
          </Button>
          <Button disabled={Boolean(blocker) || create.isPending} onClick={() => void save(false)} type="button">
            {create.isPending ? <Spinner /> : null}
            {create.isPending ? 'Saving…' : 'Save job'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
