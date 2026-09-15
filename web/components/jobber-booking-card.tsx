'use client';

import { jobberBookingProblems, jobberBookingText, type JobberBookingContext } from '@texasrenters/shared';
import { PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { bookingFromForm, bookingUnavailableReason, type BookingFormState } from '@/lib/jobber-booking';

/** Where the link back to the inspection goes, before the inspection has an address. */
const LINK_PLACEHOLDER = '(a link to this inspection)';

/**
 * Books the occupied inspection's visit in Jobber as it is created.
 *
 * The preview at the bottom is the text Jobber receives, built by the same
 * function the server sends with -- the office format, a link back here, and
 * completion steps pointing at the app.
 */
export function JobberBookingCard({
  context,
  loading,
  error,
  book,
  onBookChange,
  form,
  onChange,
  scheduledOn,
}: {
  context: JobberBookingContext | undefined;
  loading: boolean;
  error: Error | null;
  book: boolean;
  onBookChange: (book: boolean) => void;
  form: BookingFormState;
  onChange: (next: BookingFormState) => void;
  /** "2026-10-06", or empty before a date is chosen. */
  scheduledOn: string;
}) {
  const unavailable = context ? bookingUnavailableReason(context) : null;
  const request = useMemo(() => bookingFromForm(form), [form]);
  const problems = useMemo(() => jobberBookingProblems(request), [request]);
  const preview = useMemo(
    () =>
      context
        ? jobberBookingText(request, {
            address: context.address,
            scheduledOn: /^\d{4}-\d{2}-\d{2}/.test(scheduledOn) ? scheduledOn.slice(0, 10) : '',
            inspectionUrl: LINK_PLACEHOLDER,
          })
        : null,
    [context, request, scheduledOn],
  );
  const set = <K extends keyof BookingFormState>(key: K, value: BookingFormState[K]) =>
    onChange({ ...form, [key]: value });
  const offered = Boolean(context) && !unavailable;

  return (
    <Card aria-labelledby="jobber-booking-title">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle id="jobber-booking-title">Book in Jobber</CardTitle>
          <CardDescription>
            Creates the visit in Jobber in the office&apos;s Details format, with a link back to this
            inspection and completion steps that point technicians at the app.
          </CardDescription>
        </div>
        {offered ? (
          <Switch aria-label="Book this visit in Jobber" checked={book} onCheckedChange={onBookChange} />
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-5">
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner /> Checking Jobber for this property…
          </p>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : !context ? (
          <p className="text-muted-foreground text-sm">Choose the property to see whether it can be booked.</p>
        ) : unavailable ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>This visit won&apos;t be booked in Jobber</AlertTitle>
            <AlertDescription>
              <p>{unavailable}</p>
              {context.enabled && context.connected ? (
                <Link className="underline underline-offset-4" href="/integrations/jobber">
                  Open the Jobber page
                </Link>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : !book ? (
          <p className="text-muted-foreground text-sm">
            Not booked. Only the inspection is created; book the visit in Jobber yourself.
          </p>
        ) : (
          <>
            <div className="grid gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel>Services</FieldLabel>
                <div className="grid gap-2">
                  <CheckRow
                    checked={form.services.filterChange}
                    label="Filter change"
                    onChange={(checked) => set('services', { ...form.services, filterChange: checked })}
                  />
                  <CheckRow
                    checked={form.services.pestControl}
                    label="Pest control"
                    onChange={(checked) => set('services', { ...form.services, pestControl: checked })}
                  />
                  <CheckRow
                    checked={form.services.fleaTreatment}
                    label="Flea treatment"
                    onChange={(checked) => set('services', { ...form.services, fleaTreatment: checked })}
                  />
                  <span className="flex items-center gap-2 text-sm">
                    <Badge variant="secondary">Always</Badge> Occupied inspection
                  </span>
                </div>
              </Field>
              <div className="grid content-start gap-4">
                <Field>
                  <FieldLabel htmlFor="booking-zone">Zone</FieldLabel>
                  <Input
                    id="booking-zone"
                    onChange={(event) => set('zone', event.target.value)}
                    placeholder="Zone 3"
                    value={form.zone}
                  />
                </Field>
                <CheckRow
                  checked={form.benefitPackage}
                  label="Tenant Benefit Package visit"
                  onChange={(checked) => set('benefitPackage', checked)}
                />
                <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                  <Field>
                    <FieldLabel htmlFor="booking-plan">Plan</FieldLabel>
                    <Input
                      id="booking-plan"
                      onChange={(event) => set('planTier', event.target.value)}
                      placeholder="Basic, Standard, Premium…"
                      value={form.planTier}
                    />
                  </Field>
                  <CheckRow
                    checked={form.hvacOptedOut}
                    label="Opted out of the HVAC plan"
                    onChange={(checked) => set('hvacOptedOut', checked)}
                  />
                </div>
              </div>
            </div>

            {form.services.filterChange ? (
              <Rows
                addLabel="Add a filter"
                description="Leave the list empty and the Details ask the technician to update the sizes."
                label="Filters to bring"
                onAdd={() => set('filters', [...form.filters, { size: '', quantity: '', media: false, location: '' }])}
              >
                {form.filters.map((filter, index) => {
                  const update = (next: Partial<typeof filter>) =>
                    set('filters', form.filters.map((row, at) => (at === index ? { ...row, ...next } : row)));
                  return (
                    <div className="grid gap-2 sm:grid-cols-[8rem_5rem_1fr_auto_auto] sm:items-center" key={index}>
                      <Input
                        aria-label={`Filter ${index + 1} size`}
                        className="font-mono"
                        onChange={(event) => update({ size: event.target.value })}
                        placeholder="20x25x1"
                        value={filter.size}
                      />
                      <Input
                        aria-label={`Filter ${index + 1} quantity`}
                        inputMode="numeric"
                        min={1}
                        onChange={(event) => update({ quantity: event.target.value })}
                        placeholder="Qty"
                        type="number"
                        value={filter.quantity}
                      />
                      <Input
                        aria-label={`Filter ${index + 1} location`}
                        onChange={(event) => update({ location: event.target.value })}
                        placeholder="Where it goes (optional)"
                        value={filter.location}
                      />
                      <CheckRow checked={filter.media} label="Media" onChange={(media) => update({ media })} />
                      <RemoveButton
                        label={`Remove filter ${index + 1}`}
                        onClick={() => set('filters', form.filters.filter((_, at) => at !== index))}
                      />
                    </div>
                  );
                })}
              </Rows>
            ) : null}

            <Rows
              addLabel="Add a tenant"
              description="Only the assigned technician and the office see these."
              label="Tenants"
              onAdd={() => set('tenants', [...form.tenants, { name: '', phones: '', unit: '' }])}
            >
              <CheckRow
                checked={form.contactTenantsBeforeArrival}
                label="Ask the technician to contact the tenant before arriving"
                onChange={(checked) => set('contactTenantsBeforeArrival', checked)}
              />
              {form.tenants.map((tenant, index) => {
                const update = (next: Partial<typeof tenant>) =>
                  set('tenants', form.tenants.map((row, at) => (at === index ? { ...row, ...next } : row)));
                return (
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center" key={index}>
                    <Input
                      aria-label={`Tenant ${index + 1} name`}
                      onChange={(event) => update({ name: event.target.value })}
                      placeholder="Name"
                      value={tenant.name}
                    />
                    <Input
                      aria-label={`Tenant ${index + 1} phones`}
                      inputMode="tel"
                      onChange={(event) => update({ phones: event.target.value })}
                      placeholder="Phones, separated by commas"
                      value={tenant.phones}
                    />
                    <RemoveButton
                      label={`Remove tenant ${index + 1}`}
                      onClick={() => set('tenants', form.tenants.filter((_, at) => at !== index))}
                    />
                  </div>
                );
              })}
            </Rows>

            <div className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="booking-access">Getting in</FieldLabel>
                <Textarea
                  id="booking-access"
                  onChange={(event) => set('accessNotes', event.target.value)}
                  placeholder="Gate Code: 1234"
                  value={form.accessNotes}
                />
                <FieldDescription>One per line.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="booking-notes">Notes for the technician</FieldLabel>
                <Textarea
                  id="booking-notes"
                  onChange={(event) => set('notes', event.target.value)}
                  placeholder="Dog in the back yard"
                  value={form.notes}
                />
                <FieldDescription>Separate notes with a blank line.</FieldDescription>
              </Field>
            </div>

            {context.technicianInJobber === false ? (
              <Alert variant="info">
                <AlertDescription>
                  The chosen technician isn&apos;t a Jobber user this console can match, so the visit is
                  booked unassigned. Assign it in Jobber.
                </AlertDescription>
              </Alert>
            ) : null}

            {problems.length ? (
              <Alert variant="destructive">
                <AlertTitle>Fix before creating</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {preview ? (
              <section aria-label="What Jobber receives" className="grid gap-2">
                <h3 className="text-muted-foreground text-xs">What Jobber receives</h3>
                <div className="bg-muted/40 grid gap-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">
                    {scheduledOn ? preview.visitTitle : 'Choose a date to see the visit title.'}
                  </p>
                  <pre className="max-h-80 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
                    {preview.visitDetails}
                  </pre>
                </div>
                {context.jobberProperty.address ? (
                  <p className="text-muted-foreground text-xs">
                    On the Jobber property at {context.jobberProperty.address}.
                  </p>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CheckRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      {label}
    </label>
  );
}

function Rows({
  label,
  description,
  addLabel,
  onAdd,
  children,
}: {
  label: string;
  description: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <p className="text-muted-foreground text-xs">{description}</p>
      {children}
      <Button className="w-fit" onClick={onAdd} size="sm" type="button" variant="outline">
        <PlusIcon />
        {addLabel}
      </Button>
    </fieldset>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button aria-label={label} onClick={onClick} size="icon" type="button" variant="ghost">
      <XIcon />
    </Button>
  );
}
