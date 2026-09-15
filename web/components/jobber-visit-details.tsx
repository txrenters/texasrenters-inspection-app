'use client';

import {
  parseVisitDetails,
  REPORTABLE_VISIT_SERVICES,
  servicesToReschedule,
  VISIT_SERVICE_LABEL,
  type JobberBookingStatus,
  type VisitDetails,
  type VisitServicesReport,
} from '@texasrenters/shared';
import { TriangleAlertIcon } from 'lucide-react';
import { useMemo } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';

/**
 * What the coordinator wrote on the Jobber visit, read into what the office needs.
 *
 * The Details carry the work a visit is for -- filter sizes, the tenant's phone,
 * a gate code, the plan -- and until now none of it reached this page, so the
 * office opened Jobber beside every inspection. Everything above the text as
 * written is a reading of free text, and a reading can be wrong where the text
 * cannot, so the text is always one click away.
 */
export function JobberVisitDetails({
  title,
  details,
  inspectionType,
  servicesReport,
  servicesReportedAt,
  booking,
}: {
  title?: string | null;
  details?: string | null;
  inspectionType: string;
  /** What the technician reported about the booked services when submitting. */
  servicesReport?: VisitServicesReport | null;
  servicesReportedAt?: string | null;
  /** The booking this console asked Jobber for, when the inspection was created here. */
  booking?: JobberBookingStatus | null;
}) {
  const read = useMemo(() => parseVisitDetails(details), [details]);
  if (!title && !read.raw) return null;

  const services = serviceLabels(read);
  // The standard completion steps name the inspection on every benefit-package
  // visit, and the sync reads the whole text, so a visit booked for filters and
  // pest control alone can still arrive here as an occupied inspection.
  const bookedWithoutInspection =
    inspectionType === 'OCCUPIED' &&
    services.length > 0 &&
    !read.services.occupiedInspection &&
    !read.occupiedInspectionNotNeeded;
  const tenantOrAccess =
    read.tenants.length > 0 || read.accessNotes.length > 0 || read.contactTenantsBeforeArrival;
  const toReschedule = servicesToReschedule(servicesReport);

  return (
    <Card aria-labelledby="jobber-visit-title">
      <CardHeader>
        <CardTitle id="jobber-visit-title" className="flex flex-wrap items-center gap-2">
          Jobber visit
          {booking?.status === 'SENT' ? <Badge variant="success">Booked from this console</Badge> : null}
          {booking?.status === 'PENDING' || booking?.status === 'FAILED' ? (
            <Badge variant="info">Booking in Jobber</Badge>
          ) : null}
        </CardTitle>
        {title ? <CardDescription>{title}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-5">
        {booking?.status === 'ABANDONED' ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>This visit was not booked in Jobber</AlertTitle>
            <AlertDescription>
              {booking.lastError ?? 'Jobber did not accept it.'} Book it in Jobber; the inspection
              here is unaffected.
            </AlertDescription>
          </Alert>
        ) : booking?.status === 'FAILED' ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Jobber has not accepted the booking yet</AlertTitle>
            <AlertDescription>
              {booking.lastError ?? 'The last attempt failed.'} It is tried again automatically.
            </AlertDescription>
          </Alert>
        ) : null}
        {read.occupiedInspectionNotNeeded ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>The Details say no occupied inspection is needed</AlertTitle>
            <AlertDescription>
              It was still imported as one, because the Details mention an occupied inspection.
              Check with the coordinator before a technician walks it.
            </AlertDescription>
          </Alert>
        ) : null}
        {toReschedule.length ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>
              {toReschedule.map((service) => VISIT_SERVICE_LABEL[service]).join(' and ')} to reschedule
            </AlertTitle>
            <AlertDescription>
              {toReschedule
                .map((service) => `${VISIT_SERVICE_LABEL[service]}: ${servicesReport?.services[service]?.reason ?? ''}`)
                .join(' ')}
            </AlertDescription>
          </Alert>
        ) : null}
        {bookedWithoutInspection ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>The Details don&apos;t book an occupied inspection</AlertTitle>
            <AlertDescription>
              They list {services.join(', ').toLowerCase()}. It was imported as an occupied
              inspection because the standard completion steps mention one.
            </AlertDescription>
          </Alert>
        ) : null}

        {services.length || read.services.filterChange || read.plan ? (
          <div className="grid gap-5 md:grid-cols-2">
            <section className="grid content-start gap-2" aria-label="Services">
              <h3 className="text-muted-foreground text-xs">Services</h3>
              {services.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {services.map((service) => (
                    <Badge key={service} variant="secondary">
                      {service}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {read.plan ? <p className="text-sm">{planLabel(read.plan)}</p> : null}
            </section>
            {read.services.filterChange ? (
              <section className="grid content-start gap-2" aria-label="Filters">
                <h3 className="text-muted-foreground text-xs">Filters to bring</h3>
                {read.filters.length ? (
                  <ul className="grid gap-1 text-sm">
                    {read.filters.map((filter, index) => (
                      <li key={`${filter.size}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono">{filter.size}</span>
                        {filter.quantity > 1 ? (
                          <span className="text-muted-foreground font-mono">× {filter.quantity}</span>
                        ) : null}
                        {filter.media ? <Badge variant="outline">Media</Badge> : null}
                        {filter.location ? (
                          <span className="text-muted-foreground">{filter.location}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm">No sizes given</p>
                )}
                {read.filterNotes.map((note, index) => (
                  <p key={index} className="text-muted-foreground text-sm">
                    {note}
                  </p>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}

        {tenantOrAccess ? (
          <div className="grid gap-5 md:grid-cols-2">
            <section className="grid content-start gap-2" aria-label="Tenant">
              <h3 className="text-muted-foreground text-xs">Tenant</h3>
              {read.contactTenantsBeforeArrival ? (
                <p className="text-sm">Contact the tenant before arriving.</p>
              ) : null}
              {read.tenants.length ? (
                <ul className="grid gap-2 text-sm">
                  {read.tenants.map((tenant, index) => (
                    <li key={index}>
                      {tenant.unit ? <p className="text-muted-foreground text-xs">{tenant.unit}</p> : null}
                      <p className="font-medium">{tenant.name ?? 'Name not given'}</p>
                      {tenant.phones.length ? (
                        <p className="flex flex-wrap gap-x-3">
                          {tenant.phones.map((phone) => (
                            <a
                              key={phone}
                              className="text-primary font-mono underline-offset-4 hover:underline"
                              href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                            >
                              {phone}
                            </a>
                          ))}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            {read.accessNotes.length ? (
              <section className="grid content-start gap-2" aria-label="Access">
                <h3 className="text-muted-foreground text-xs">Access</h3>
                {read.accessNotes.map((note, index) => (
                  <p key={index} className="text-sm">
                    {note}
                  </p>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}

        {servicesReport ? (
          <section className="grid gap-2" aria-label="Services done">
            <h3 className="text-muted-foreground text-xs">
              Services reported by the technician
              {servicesReportedAt ? ` · ${formatDateTime(servicesReportedAt)}` : ''}
            </h3>
            <ul className="grid gap-1.5 text-sm">
              {REPORTABLE_VISIT_SERVICES.filter((service) => servicesReport.services[service]).map((service) => {
                const outcome = servicesReport.services[service]!;
                return (
                  <li key={service} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Badge variant={outcome.done ? 'success' : 'warning'}>
                      {outcome.done ? 'Done' : 'Not done'}
                    </Badge>
                    <span className="font-medium">{VISIT_SERVICE_LABEL[service]}</span>
                    {outcome.reason ? <span className="text-muted-foreground">{outcome.reason}</span> : null}
                    {outcome.reschedule ? <Badge variant="outline">Reschedule</Badge> : null}
                  </li>
                );
              })}
            </ul>
            {servicesReport.filtersInstalled.length ? (
              <p className="text-sm">
                Filters installed:{' '}
                <span className="font-mono">{servicesReport.filtersInstalled.join(', ')}</span>
              </p>
            ) : null}
            {servicesReport.notes ? (
              <p className="text-sm whitespace-pre-wrap">{servicesReport.notes}</p>
            ) : null}
          </section>
        ) : null}

        {read.notes.length ? (
          <section className="grid gap-2" aria-label="Notes">
            <h3 className="text-muted-foreground text-xs">Notes</h3>
            {read.notes.map((note, index) => (
              <p key={index} className="text-sm whitespace-pre-wrap">
                {note}
              </p>
            ))}
          </section>
        ) : null}

        {read.completionInstructions.length ? (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm select-none">
              Completion steps ({read.completionInstructions.length})
            </summary>
            <ul className="mt-2 grid gap-1 text-sm">
              {read.completionInstructions.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {read.raw ? (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm select-none">
              As written in Jobber
            </summary>
            <p className="bg-muted mt-2 rounded-lg p-3 text-sm whitespace-pre-wrap">{read.raw}</p>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function serviceLabels(read: VisitDetails) {
  return [
    read.services.filterChange ? 'Filter change' : null,
    read.services.pestControl ? 'Pest control' : null,
    read.services.fleaTreatment ? 'Flea treatment' : null,
    read.services.occupiedInspection ? 'Occupied inspection' : null,
    ...read.services.other,
  ].filter((label): label is string => Boolean(label));
}

function planLabel(plan: NonNullable<VisitDetails['plan']>) {
  return [plan.tier ? `${plan.tier} plan` : null, plan.hvacOptedOut ? 'Opted out of the HVAC plan' : null]
    .filter(Boolean)
    .join(' · ');
}
