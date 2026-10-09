'use client';

import {
  filterLabel,
  installedFiltersSummary,
  isFinishedStatus,
  parseVisitDetails,
  REPORTABLE_VISIT_SERVICES,
  servicesToReschedule,
  VISIT_SERVICE_LABEL,
  visitStateLabel,
  visitStateOf,
  type AdminInspection,
  type VisitDetails,
  type VisitFilterOutcome,
  type VisitServicesReport,
} from '@texasrenters/shared';
import { TriangleAlertIcon } from 'lucide-react';
import { Fragment, useMemo, type ReactNode } from 'react';

import { ServicePhotos, type ServicePhoto } from '@/components/service-photos';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, formatScheduledDate } from '@/lib/format';
import { inspectionTime, jobWorked } from '@/lib/job-time';

/**
 * The visit: when, who, how long, what it was for, and what the technician
 * reported -- one card instead of three places on the page.
 *
 * It was the "Jobber visit" card, and on a move-out it read as the address
 * again over three nested fold-outs: "Visit details from Jobber", inside it
 * "Completion steps (9)", then the same text a second time as "As written in
 * Jobber" (the office, 2026-10-05: "flat, boring, confusing"). Who walked it
 * and for how long sat in a strip of facts above it, and the import's
 * provenance in a grey box below that. Now the facts lead, the tasks read as a
 * plain list, and only what is reference -- the planning detail once the visit
 * is done, the text as written -- is a click away.
 *
 * Everything parsed from the Details is a reading of free text, and a reading
 * can be wrong where the text cannot, so the text is always one click away.
 */
export function VisitCard({
  inspection,
  technicianName,
  action,
}: {
  inspection: AdminInspection;
  /** The technician currently assigned, if anyone is. */
  technicianName?: string | null;
  /** A control for the header: "Edit visit", where the viewer may. */
  action?: ReactNode;
}) {
  const read = useMemo(
    () => parseVisitDetails(inspection.jobberVisitDetails),
    [inspection.jobberVisitDetails],
  );
  const inJobber = Boolean(inspection.scheduledInJobber || inspection.jobberBooking);
  const done = isFinishedStatus(inspection.status);
  const cancelled = inspection.status === 'CANCELLED';
  // Planning detail -- what to bring, who to call -- matters before the visit.
  // Once it is done it folds away, so the areas under review are not a screen
  // below it; what was done, and any alert, stays open.
  const planningCollapsed = inspection.status !== 'SCHEDULED' && inspection.status !== 'IN_PROGRESS';
  const state = visitState(inspection);
  const worked = jobWorked(inspection);
  const inspected = inspectionTime(inspection.inspectionWorked);
  const zone = /\bzone\s*(\d+)\b/i.exec(inspection.jobberVisitTitle ?? '')?.[1] ?? null;
  const services = serviceLabels(read);
  const tasks = visitTasks(read);
  const report = inspection.servicesReport ?? null;
  const toReschedule = servicesToReschedule(report);
  const pushes = inspection.jobberPushes ?? [];
  const booking = inspection.jobberBooking ?? null;
  // The standard completion steps name the inspection on every benefit-package
  // visit, and the sync reads the whole text, so a visit booked for filters and
  // pest control alone can still arrive here as an occupied inspection.
  const bookedWithoutInspection =
    inspection.inspectionType === 'OCCUPIED' &&
    services.length > 0 &&
    !read.services.occupiedInspection &&
    !read.occupiedInspectionNotNeeded;
  const tenantOrAccess =
    read.tenants.length > 0 || read.accessNotes.length > 0 || read.contactTenantsBeforeArrival;
  const planning =
    services.length || read.services.filterChange || read.plan || tenantOrAccess || read.notes.length;
  // Where the visit stands with Jobber, as words after the visit's state.
  const sync = [
    inJobber ? { key: 'jobber', text: 'Jobber' } : null,
    booking?.status === 'SENT' ? { key: 'booked', text: 'Booked from this console' } : null,
    booking?.status === 'PENDING' || booking?.status === 'FAILED'
      ? { key: 'booking', text: 'Booking in Jobber' }
      : null,
    ...pushes
      .filter((push) => push.status !== 'ABANDONED')
      .map((push) => ({ key: push.kind, text: `Sending ${PUSH_LABEL[push.kind]} to Jobber` })),
  ].filter((part): part is { key: string; text: string } => part !== null);

  return (
    <Card aria-labelledby="visit-title" className="mt-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          {/* "Visit" names the section, so a label (console-development). Its
              state and where it stands with Jobber follow as one quiet line
              rather than up to five badges in the title -- the page header
              already carries the inspection's own status, and two status
              words at the same weight read as a contradiction. */}
          <CardTitle id="visit-title" variant="label">
            Visit
          </CardTitle>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <Badge variant={state.variant}>{state.label}</Badge>
            {sync.map((part) => (
              <Fragment key={part.key}>
                <span aria-hidden>·</span>
                <span>{part.text}</span>
              </Fragment>
            ))}
          </p>
          {!inJobber && read.raw ? (
            <CardDescription>
              Services chosen when this inspection was created. It isn&apos;t booked in Jobber from
              here, so the visit in Jobber needs these services at the top of its Details.
            </CardDescription>
          ) : null}
        </div>
        {action}
      </CardHeader>

      {/* `wrap-anywhere`: Jobber's visit text can carry a link (a report URL
          is 80-odd characters with no space in it), and unbroken it set the
          card's minimum width, so on a phone the whole page scrolled sideways. */}
      <CardContent className="grid gap-5 wrap-anywhere">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Technician">
            {technicianName ?? 'Not assigned'}
            {!technicianName && !done && !cancelled ? (
              <span className="text-warning block text-xs font-normal">
                Required before field work can start
              </span>
            ) : null}
          </Fact>
          <Fact label="Date">
            {formatScheduledDate(inspection.scheduledAt)}
            {zone ? <span className="text-muted-foreground block text-xs font-normal">Zone {zone}</span> : null}
          </Fact>
          {/* The technician's own clock: Start job on the handset to submitting.
              Nothing inferred from photographs or locations. */}
          <Fact label="On site">{worked ? worked.window : 'Not started'}</Fact>
          <Fact label="Time on the job">
            {worked ? `${worked.worked}${worked.running ? ' so far' : ''}` : '—'}
            {/* The inspection on its own, read from its first photograph or
                recording to its last: where a job's time goes. */}
            {inspected ? (
              <span className="text-muted-foreground block text-xs font-normal">
                Inspection {inspected}
              </span>
            ) : null}
          </Fact>
        </dl>

        {pushes
          .filter((push) => push.status === 'ABANDONED')
          .map((push) => (
            <Alert key={push.kind} variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Jobber did not take {PUSH_LABEL[push.kind]}</AlertTitle>
              <AlertDescription>
                {push.lastError ?? 'The change was refused.'} Make the change in Jobber; until then
                Jobber&apos;s copy is what the sync keeps.
              </AlertDescription>
            </Alert>
          ))}
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
        {state.reason ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>{state.reason}</AlertTitle>
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
                .map((service) => `${VISIT_SERVICE_LABEL[service]}: ${report?.services[service]?.reason ?? ''}`)
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

        {report ? (
          <ServicesDone
            report={report}
            reportedAt={inspection.servicesReportedAt ?? null}
            submittedAt={inspection.submittedAt ?? null}
          />
        ) : null}

        {tasks.length ? (
          <section aria-label="Tasks on the visit" className="grid gap-2">
            <h3 className="text-muted-foreground text-xs">Tasks on the visit</h3>
            <ul className="grid gap-1.5 text-sm">
              {tasks.map((task, index) =>
                task.heading ? (
                  <li className="text-muted-foreground pt-1 text-xs" key={index}>
                    {task.text}
                  </li>
                ) : (
                  <li className="flex gap-2" key={index}>
                    <span aria-hidden className="bg-muted-foreground mt-2 size-1 shrink-0 rounded-full" />
                    <span>{task.text}</span>
                  </li>
                ),
              )}
            </ul>
          </section>
        ) : null}

        {planning ? (
          <Fold collapsed={planningCollapsed} label="Before the visit">
            <Planning read={read} services={services} tenantOrAccess={tenantOrAccess} />
          </Fold>
        ) : null}

        {read.raw || inspection.jobberVisitTitle ? (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm select-none">
              {inJobber ? 'As written in Jobber' : 'As written'}
            </summary>
            <div className="bg-muted mt-2 grid gap-2 rounded-lg p-3 text-sm">
              {inspection.jobberVisitTitle ? (
                <p className="font-medium">{inspection.jobberVisitTitle}</p>
              ) : null}
              {read.raw ? <p className="whitespace-pre-wrap">{read.raw}</p> : null}
            </div>
          </details>
        ) : null}

        {/* Where the record came from, mostly: "Imported from an Inspect &
            Cloud PDF report", "Booked from Propertyware". Never published. */}
        {inspection.internalNotes ? (
          <p className="text-muted-foreground border-t pt-3 text-xs whitespace-pre-wrap">
            {inspection.internalNotes}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

/**
 * Where the visit stands, in a word. "Done" from the technician's submission:
 * that is when the visit ended, Jobber was told and the clock stopped -- the
 * office's review of the findings comes after, and is not the visit's.
 */
function visitState(inspection: AdminInspection): {
  label: string;
  variant: 'secondary' | 'info' | 'success' | 'warning';
  reason?: string;
} {
  // The shared rule (`visitStateOf`), so this card and the inspections list
  // say the same thing about the same visit.
  const state = visitStateOf(inspection);
  const label = visitStateLabel(state);
  switch (state) {
    case 'DONE':
      return { label, variant: 'success' };
    case 'COULD_NOT_GET_IN':
      return { label, variant: 'warning', reason: inspection.completionBlockedReason?.trim() };
    case 'FOLLOW_UP':
      return { label, variant: 'warning' };
    case 'IN_PROGRESS':
      return { label, variant: 'info' };
    default:
      return { label, variant: 'secondary' };
  }
}

/**
 * The visit's completion steps as tasks. The parser has already dropped the
 * heading the office types ("Completion Instruction") and the bullets; what is
 * left that heads the lines after it is "Additional Task", its colon cleaned
 * off, or any line still ending in one.
 */
function visitTasks(read: VisitDetails): { text: string; heading: boolean }[] {
  return read.completionInstructions.map((line) => {
    const heading = /:\s*$/.test(line) || /^additional tasks?$/i.test(line.trim());
    return { text: line.replace(/:\s*$/, ''), heading };
  });
}

/**
 * How long after the job was submitted a photograph still missing is called
 * missing rather than uploading. A phone in a cupboard with no signal sends it
 * when the signal returns, which is hours at most; days means it is not coming.
 */
const PHOTO_OVERDUE_MS = 24 * 60 * 60 * 1000;

/** What the technician reported doing: the part a reviewer reads. */
function ServicesDone({
  report,
  reportedAt,
  submittedAt,
}: {
  report: VisitServicesReport;
  reportedAt: string | null;
  submittedAt: string | null;
}) {
  // "Still uploading" four days on told the office to wait for a photograph
  // that was never coming (5706 Micah Ln, 2026-10-02 to 10-06).
  const overdue = submittedAt ? Date.now() - Date.parse(submittedAt) > PHOTO_OVERDUE_MS : false;
  return (
    <section aria-label="Services done" className="grid gap-2">
      <h3 className="text-muted-foreground text-xs">
        Services reported by the technician
        {reportedAt ? ` · ${formatDateTime(reportedAt)}` : ''}
      </h3>
      <ul className="grid gap-1.5 text-sm">
        {REPORTABLE_VISIT_SERVICES.filter((service) => report.services[service]).map((service) => {
          const outcome = report.services[service]!;
          return (
            <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1" key={service}>
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
      {/* Counted, as the Jobber note says it: the invoice is made from it. */}
      {installedFiltersSummary(report) ? (
        <p className="text-sm">
          Filters installed: <span className="font-mono">{installedFiltersSummary(report)}</span>
        </p>
      ) : null}
      {/* Each register the technician answered for, once the office asked for a
          photograph of each (2026-09-18). One marked changed whose photograph
          has not arrived says so, rather than reading as evidenced. */}
      {report.filters?.length ? (
        <ul aria-label="Filter registers" className="grid gap-1.5 text-sm">
          {report.filters.map((filter) => (
            <li
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
              key={`${filter.size}-${filter.location ?? ''}-${filter.slot}`}
            >
              {filter.removed ? (
                <Badge variant="outline">Not at the property</Badge>
              ) : (
                <Badge variant={filter.changed ? 'success' : 'warning'}>
                  {filter.changed ? 'Changed' : 'Not changed'}
                </Badge>
              )}
              <span className={filter.removed ? 'font-mono line-through' : 'font-mono'}>
                {filterLabel(filter.removed ? { ...filter, actualSize: null } : filter)}
              </span>
              {filter.booked ? null : <Badge variant="outline">Found on site</Badge>}
              {/* The listed size the technician corrected: the office's record of
                  this property is wrong until somebody fixes it. */}
              {filter.actualSize && !filter.removed ? (
                <span className="text-muted-foreground text-xs">listed as {filter.size}</span>
              ) : null}
              {filter.reason ? <span className="text-muted-foreground">{filter.reason}</span> : null}
              {/* How it was found, on an HVAC job (Moses, 2026-10-01). */}
              {filterScore(filter) ? (
                <span className="text-muted-foreground text-xs">{filterScore(filter)}</span>
              ) : null}
              {filter.changed && !filter.photoId && !filter.removed ? (
                overdue ? (
                  <span className="text-destructive text-xs">Photograph never arrived</span>
                ) : (
                  <span className="text-warning text-xs">Photograph still uploading</span>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {/* The photographs themselves, beside the answers they evidence. */}
      <ServicePhotos areaName="this job" photos={servicePhotos(report)} />
      {report.notes ? <p className="text-sm whitespace-pre-wrap">{report.notes}</p> : null}
    </section>
  );
}

/** What the visit was booked for, and how to get in: what to know before going. */
function Planning({
  read,
  services,
  tenantOrAccess,
}: {
  read: VisitDetails;
  services: string[];
  tenantOrAccess: boolean;
}) {
  return (
    <div className="grid gap-5">
      {services.length || read.services.filterChange || read.plan ? (
        <div className="grid gap-5 md:grid-cols-2">
          <section aria-label="Services" className="grid content-start gap-2">
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
            <section aria-label="Filters" className="grid content-start gap-2">
              <h3 className="text-muted-foreground text-xs">Filters to bring</h3>
              {read.filters.length ? (
                <ul className="grid gap-1 text-sm">
                  {read.filters.map((filter, index) => (
                    <li className="flex flex-wrap items-baseline gap-x-2" key={`${filter.size}-${index}`}>
                      <span className="font-mono">{filter.size}</span>
                      {filter.quantity > 1 ? (
                        <span className="text-muted-foreground font-mono">× {filter.quantity}</span>
                      ) : null}
                      {filter.media ? <Badge variant="outline">Media</Badge> : null}
                      {filter.location ? <span className="text-muted-foreground">{filter.location}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">No sizes given</p>
              )}
              {read.filterNotes.map((note, index) => (
                <p className="text-muted-foreground text-sm" key={index}>
                  {note}
                </p>
              ))}
            </section>
          ) : null}
        </div>
      ) : null}

      {tenantOrAccess ? (
        <div className="grid gap-5 md:grid-cols-2">
          <section aria-label="Tenant" className="grid content-start gap-2">
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
                            className="text-primary font-mono underline-offset-4 hover:underline"
                            href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                            key={phone}
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
            <section aria-label="Access" className="grid content-start gap-2">
              <h3 className="text-muted-foreground text-xs">Access</h3>
              {read.accessNotes.map((note, index) => (
                <p className="text-sm" key={index}>
                  {note}
                </p>
              ))}
            </section>
          ) : null}
        </div>
      ) : null}

      {read.notes.length ? (
        <section aria-label="Notes" className="grid gap-2">
          <h3 className="text-muted-foreground text-xs">Notes</h3>
          {read.notes.map((note, index) => (
            <p className="text-sm whitespace-pre-wrap" key={index}>
              {note}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

/** Open as it is, or folded into one closed disclosure. */
function Fold({ collapsed, label, children }: { collapsed: boolean; label: string; children: ReactNode }) {
  if (!collapsed) return <>{children}</>;
  return (
    <details>
      <summary className="text-muted-foreground cursor-pointer text-sm select-none">{label}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/**
 * How a filter was scored on an HVAC job, as the report's row reads: "Clean Y ·
 * Undamaged N · Working Y · Not present". Empty for a filter nobody scored.
 */
function filterScore(filter: VisitFilterOutcome): string {
  const axis = (name: string, value: boolean | null | undefined) =>
    value == null ? null : `${name} ${value ? 'Y' : 'N'}`;
  return [
    axis('Clean', filter.isClean),
    axis('Undamaged', filter.isUndamaged),
    axis('Working', filter.isWorking),
    filter.comment?.trim() || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Every photograph the technician took for the job's services, labelled by what it shows. */
function servicePhotos(report: VisitServicesReport): ServicePhoto[] {
  // One thumbnail per photograph, named for every filter in it: the phone takes
  // one photograph of all the filters, stacked (the office, 2026-09-29).
  const byPhoto = new Map<string, string[]>();
  for (const filter of report.filters ?? []) {
    if (!filter.photoId) continue;
    byPhoto.set(filter.photoId, [...(byPhoto.get(filter.photoId) ?? []), filterLabel(filter)]);
  }
  const registers = [...byPhoto].map(
    ([id, labels]): ServicePhoto => ({ id, label: labels.join(', '), captureType: 'SERIAL_OR_LABEL' }),
  );
  const services = REPORTABLE_VISIT_SERVICES.filter((service) => report.services[service]?.photoId).map(
    (service): ServicePhoto => ({
      id: report.services[service]!.photoId!,
      label: VISIT_SERVICE_LABEL[service],
      captureType: 'OTHER',
    }),
  );
  return [...registers, ...services];
}

/** What each kind of console edit changes, in a sentence: "Sending the new date to Jobber". */
const PUSH_LABEL: Record<NonNullable<AdminInspection['jobberPushes']>[number]['kind'], string> = {
  VISIT_RESCHEDULE: 'the new date',
  VISIT_ASSIGN: 'the technician',
  VISIT_EDIT: 'the visit details',
  VISIT_CANCEL: 'the cancellation',
};

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
