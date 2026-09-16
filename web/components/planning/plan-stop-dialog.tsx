'use client';

import Link from 'next/link';
import { Fragment, useMemo, type ReactNode } from 'react';

import { STOP_STATUS, reasonText } from '@/components/planning/plan-stops-table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EMPTY, formatDistance, formatScheduledDate } from '@/lib/format';
import { dayClock, formatClock, formatMinutes, leaveHomeAt } from '@/lib/planning';
import type { PlanDay, PlanStop } from '@/lib/planning-queries';

/** A planned day is a DATE, so it is read in UTC: in Manila, local time would show the day before. */
const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

const ORDER_SOURCE: Record<PlanStop['orderSource'], string> = {
  PRIOR_QUARTER: 'last quarter',
  CARRIED_SKIP: 'carried from a quarter it missed',
  NEW_ENROLLMENT: 'new enrolment, at the back',
};

const zoneLabel = (zone: string | null) => (zone ? (/^\d+$/.test(zone) ? `Zone ${zone}` : zone) : null);

/** One group of label and value, as Jobber lays a visit out: short labels, the values beside them. */
function DetailGroup({ title, rows }: { title: string; rows: Array<[string, ReactNode]> }) {
  return (
    <section className="grid content-start gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value === null || value === undefined || value === '' ? EMPTY : value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

/**
 * Everything about one planned visit, opened from its pin on the map or its row.
 *
 * What Jobber will be sent -- the title and the Details, word for word -- beside
 * when and with whom it is planned, the property and its tenancy, and why it is
 * the kind of visit it is. The office reads a visit in Jobber this way, so the
 * plan is checked the same way before anything is booked.
 */
export function PlanStopDialog({
  stop,
  day,
  onOpenChange,
}: {
  /** The visit to show; null closes the window. */
  stop: PlanStop | null;
  /** The technician-day it is planned on, for its times and drives. */
  day: PlanDay | null;
  onOpenChange: (open: boolean) => void;
}) {
  const timing = useMemo(() => {
    if (!stop || !day) return null;
    const clock = dayClock(day.stops);
    const index = clock.findIndex((entry) => entry.id === stop.id);
    return index === -1 ? null : { entry: clock[index]!, index, count: clock.length };
  }, [stop, day]);

  if (!stop) return <Dialog onOpenChange={onOpenChange} open={false} />;

  const kind = stop.inspectionType === 'HVAC' ? 'HVAC inspection' : 'Occupied inspection';
  const tenant = stop.tenant;
  const filterSizes = stop.hvacFilterSizes.length ? stop.hvacFilterSizes : tenant.hvacFilterSizes;

  const drive = (() => {
    if (!timing) return null;
    if (timing.index > 0)
      return timing.entry.driveSecondsForecast === null
        ? 'Not measured'
        : `${timing.entry.driveMinutes} min from stop ${timing.index}`;
    if (day?.homeDriveSeconds !== null && day?.homeDriveSeconds !== undefined)
      return `${formatMinutes(day.homeDriveSeconds / 60)} from home${
        day.homeDriveMeters ? ` · ${formatDistance(day.homeDriveMeters)}` : ''
      } · leave ${formatClock(leaveHomeAt(timing.entry.arrives, day.homeDriveSeconds))}`;
    return day?.originKind === 'HOME' ? 'From home, not measured' : 'First job of the day';
  })();

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="max-h-[calc(100dvh-4rem)] gap-5 overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={stop.inspectionType === 'HVAC' ? 'info' : 'secondary'}>{kind}</Badge>
            <Badge variant={STOP_STATUS[stop.status].variant}>{STOP_STATUS[stop.status].label}</Badge>
            {stop.inspectionTypeNeedsReview ? <Badge variant="warning">Check the kind of visit</Badge> : null}
          </div>
          <DialogTitle className="text-lg">{tenant.addressLine1 ?? 'Unknown address'}</DialogTitle>
          <DialogDescription>{stop.visitTitle ?? ([tenant.city, zoneLabel(stop.zone)].filter(Boolean).join(' · ') || EMPTY)}</DialogDescription>
        </DialogHeader>

        {stop.blockedMessage ? (
          <Alert variant="destructive">
            <AlertDescription>{stop.blockedMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <DetailGroup
            rows={[
              ['Date', stop.scheduledOn ? LONG_DAY.format(new Date(stop.scheduledOn)) : 'Not on a day yet'],
              ['Time', timing ? `${formatClock(timing.entry.arrives)} – ${formatClock(timing.entry.leaves)}` : null],
              ['Technician', stop.assignedTechnician?.displayName ?? 'Nobody yet'],
              ['Stop', timing ? `${timing.index + 1} of ${timing.count}` : null],
              ['Drive', drive],
              ['On site', stop.onSiteMinutes === null ? null : formatMinutes(stop.onSiteMinutes)],
              [
                'In Jobber',
                stop.jobberVisitId
                  ? 'Booked'
                  : stop.status === 'PUBLISHED'
                    ? 'Waiting to be booked'
                    : 'Booked once the plan is published',
              ],
            ]}
            title="Visit"
          />
          <DetailGroup
            rows={[
              ['Address', tenant.addressLine1],
              ['City', [tenant.city, [tenant.state, tenant.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')],
              ['Unit', stop.propertywareUnit?.name ?? (stop.unitResolution === 'NO_UNITS' ? 'Single-unit property' : null)],
              ['Zone', zoneLabel(stop.zone)],
            ]}
            title="Property"
          />
          <DetailGroup
            rows={[
              ['Lease', tenant.leaseName],
              [
                'Term',
                tenant.startDate || tenant.endDate
                  ? `${formatScheduledDate(tenant.startDate)} – ${tenant.endDate ? formatScheduledDate(tenant.endDate) : 'open'}`
                  : null,
              ],
              ['Plan', tenant.managementPlan],
              ['HVAC plan', tenant.hvacPlan],
              [
                'Filters',
                filterSizes.length || tenant.hvacFilterLocation
                  ? [filterSizes.join(', '), tenant.hvacFilterLocation].filter(Boolean).join(' · ')
                  : null,
              ],
              ['Last filter delivery', tenant.lastFilterDelivery],
              ['Last HVAC inspection', tenant.lastHvacInspection ? formatScheduledDate(tenant.lastHvacInspection) : null],
              ['Last occupied inspection', tenant.lastOccupiedInspection],
            ]}
            title="Tenancy"
          />
          <DetailGroup
            rows={[
              [
                'Kind of visit',
                <span className="grid gap-0.5" key="kind">
                  <span>{kind}</span>
                  <span className="text-muted-foreground text-xs">
                    {stop.inspectionTypeOverriddenAt ? 'Set by a coordinator' : (reasonText(stop.inspectionTypeReason) ?? EMPTY)}
                  </span>
                </span>,
              ],
              [
                'Order',
                `#${stop.sequence}${stop.previousSequence ? ` · #${stop.previousSequence} last quarter` : ` · ${ORDER_SOURCE[stop.orderSource]}`}`,
              ],
              ['Last technician', stop.previousTechnician?.displayName ?? null],
              ['Day set by', stop.scheduleOverriddenAt ? 'A coordinator' : 'The planner'],
            ]}
            title="Plan"
          />
        </div>

        <section aria-labelledby="plan-stop-details" className="grid gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase" id="plan-stop-details">
              Details
            </h3>
            <span className="text-muted-foreground text-xs">
              {stop.officeDetails ? 'From the office’s sheet' : 'Written from the tenant report'} · sent to Jobber as written
            </span>
          </div>
          <p className="bg-muted/50 rounded-lg border px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
            {stop.visitDetails ?? EMPTY}
          </p>
        </section>

        <DialogFooter>
          {stop.inspectionId ? (
            <Button asChild variant="outline">
              <Link href={`/inspections/${stop.inspectionId}`}>Open inspection</Link>
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
