'use client';

import { parseVisitDetails, type VisitDetails } from '@texasrenters/shared';
import { TriangleAlertIcon } from 'lucide-react';
import { useMemo } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
}: {
  title?: string | null;
  details?: string | null;
  inspectionType: string;
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

  return (
    <Card aria-labelledby="jobber-visit-title">
      <CardHeader>
        <CardTitle id="jobber-visit-title">Jobber visit</CardTitle>
        {title ? <CardDescription>{title}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-5">
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
