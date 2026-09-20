'use client';

import {
  VISIT_SERVICE_LABEL,
  visitServicesDetails,
  visitServicesProblems,
  type BookableInspectionType,
} from '@texasrenters/shared';
import { useMemo } from 'react';

import { CopyButton } from '@/components/api-reference/copy-button';
import { CheckRow, RemoveButton, Rows } from '@/components/booking-form-controls';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { servicesFromForm, type BookingFormState } from '@/lib/jobber-booking';

/** The inspection every visit of a kind carries, whatever else it books. */
const INSPECTION_LABEL: Record<BookableInspectionType, string> = {
  OCCUPIED: 'Occupied inspection',
  MOVE_IN: 'Move-in inspection',
  MOVE_OUT: 'Move-out inspection',
  BACK_TO_MARKET: 'Back-to-market inspection',
  HVAC: 'HVAC inspection',
};

/**
 * What the visit books besides its inspection: the AC filter change with the
 * filters to bring, pest control and a flea treatment.
 *
 * Offered on every kind of visit the console creates (the office, 2026-09-19),
 * because a move-in or an HVAC visit booked by hand can carry them as much as
 * a benefit-package visit does. They are written the office's way, at the top
 * of the visit's Details -- "Filter Change: 20x25x1 + Pest Control + HVAC
 * Inspection" -- which is what the phone lists the job's services from. When
 * the visit is booked in Jobber from here, Jobber receives that line with the
 * rest of the Details. When it is not, the inspection still carries it, and
 * the card gives the coordinator the line to put in Jobber themselves.
 */
export function VisitServicesCard({
  inspectionType,
  form,
  onChange,
  booked,
}: {
  inspectionType: BookableInspectionType;
  form: BookingFormState;
  onChange: (next: BookingFormState) => void;
  /** The visit is booked in Jobber from here, so Jobber's Details carry these. */
  booked: boolean;
}) {
  const request = useMemo(() => servicesFromForm(form), [form]);
  const problems = useMemo(() => visitServicesProblems(request), [request]);
  const line = useMemo(() => visitServicesDetails(inspectionType, request), [inspectionType, request]);
  const set = <K extends keyof BookingFormState>(key: K, value: BookingFormState[K]) =>
    onChange({ ...form, [key]: value });
  const tick = (service: keyof BookingFormState['services']) => (checked: boolean) =>
    set('services', { ...form.services, [service]: checked });

  return (
    <Card aria-labelledby="visit-services-title">
      <CardHeader>
        <CardTitle id="visit-services-title">Services</CardTitle>
        <CardDescription>
          What the technician does on this visit besides the inspection. Each one is on the job&apos;s list on the
          phone, and goes at the top of the visit&apos;s Details in Jobber the way the office writes them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div aria-label="Services" className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-4" role="group">
          <CheckRow
            checked={form.services.filterChange}
            label={VISIT_SERVICE_LABEL.filterChange}
            onChange={tick('filterChange')}
          />
          <CheckRow
            checked={form.services.pestControl}
            label={VISIT_SERVICE_LABEL.pestControl}
            onChange={tick('pestControl')}
          />
          <CheckRow
            checked={form.services.fleaTreatment}
            label={VISIT_SERVICE_LABEL.fleaTreatment}
            onChange={tick('fleaTreatment')}
          />
          <span className="flex min-h-9 items-center gap-2 text-sm">
            <Badge variant="secondary">Always</Badge> {INSPECTION_LABEL[inspectionType]}
          </span>
        </div>

        {form.services.filterChange ? (
          <Rows
            addLabel="Add a filter"
            description="Started from the tenant report. Leave the list empty and the Details ask the technician to update the sizes."
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

        {!booked && line ? (
          <section aria-label="For the visit in Jobber" className="grid gap-2">
            <h3 className="text-muted-foreground text-xs">For the visit in Jobber</h3>
            <p className="text-sm">
              This visit isn&apos;t booked in Jobber from here, so Jobber won&apos;t have these. The phone will. Put
              this line at the top of the visit&apos;s Details in Jobber:
            </p>
            <div className="bg-muted/40 flex items-start justify-between gap-2 rounded-lg border p-3">
              <code className="min-w-0 font-mono text-xs leading-relaxed break-words">{line}</code>
              <CopyButton className="shrink-0" label="Copy" value={line} />
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
