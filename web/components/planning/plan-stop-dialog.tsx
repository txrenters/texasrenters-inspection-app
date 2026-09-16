'use client';

import { isRescheduleMonday, quarterEnd, quarterStart, type Quarter } from '@texasrenters/shared';
import Link from 'next/link';
import { Fragment, useMemo, type ReactNode } from 'react';

import { EditableDate, EditablePick, EditableText, type PickOption } from '@/components/planning/inline-edit';
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
import {
  usePlanTechnicians,
  usePlanningMutations,
  type PlanDay,
  type PlanInspectionType,
  type PlanStop,
  type PlanStopEdit,
} from '@/lib/planning-queries';

/** A planned day is a DATE, so it is read in UTC: in Manila, local time would show the day before. */
const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

const ORDER_SOURCE: Record<PlanStop['orderSource'], string> = {
  PRIOR_QUARTER: 'last quarter',
  CARRIED_SKIP: 'carried from a quarter it missed',
  NEW_ENROLLMENT: 'new enrolment, at the back',
};

const zoneLabel = (zone: string | null) => (zone ? (/^\d+$/.test(zone) ? `Zone ${zone}` : zone) : null);

const KIND_OPTIONS: PickOption[] = [
  { value: 'OCCUPIED', label: 'Occupied inspection' },
  { value: 'HVAC', label: 'HVAC inspection' },
];

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

/** What a day is, when it is not an ordinary working day for the plan. */
function dayNote(date: string, quarter: Quarter, closedDays: readonly string[]) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return `A ${WEEKDAY.format(new Date(`${date}T00:00:00Z`))}: the office is closed.`;
  if (closedDays.includes(date)) return 'A day the office is closed.';
  if (isRescheduleMonday(date, quarter)) return 'A Monday kept for rescheduled visits.';
  return null;
}

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
  editable = false,
  quarter = null,
  closedDays = [],
}: {
  /** The visit to show; null closes the window. */
  stop: PlanStop | null;
  /** The technician-day it is planned on, for its times and drives. */
  day: PlanDay | null;
  onOpenChange: (open: boolean) => void;
  /**
   * A coordinator may change this draft's visits. Each value they may change is
   * then its own control, as the office asked (2026-09-16): no Edit button.
   */
  editable?: boolean;
  /** The plan's quarter: the days a visit can move to. */
  quarter?: Quarter | null;
  /** The quarter's closed days, `YYYY-MM-DD`, named when a visit is moved onto one. */
  closedDays?: readonly string[];
}) {
  const { editStop } = usePlanningMutations();
  const canEdit = Boolean(
    editable && quarter && stop && !stop.inspectionId && stop.status !== 'PUBLISHED' && stop.status !== 'EXCLUDED',
  );
  const technicians = usePlanTechnicians(canEdit);
  const technicianOptions = useMemo<PickOption[]>(
    () =>
      (technicians.data ?? []).map((technician) => ({
        value: technician.id,
        label: technician.displayName,
        hint: technician.hasHome ? undefined : 'No home on file: the day starts at the first visit',
        group: technician.crewOrder === null ? 'Other technicians' : 'Benefit-package crew',
      })),
    [technicians.data],
  );
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
  const save = (input: PlanStopEdit) => editStop.mutateAsync({ stopId: stop.id, ...input });
  const scheduledOn = stop.scheduledOn ? stop.scheduledOn.slice(0, 10) : null;
  const severalUnits = stop.buildingUnits.length > 1;
  const note = canEdit && scheduledOn && quarter ? dayNote(scheduledOn, quarter, closedDays) : null;
  // The last day of the quarter: the day before the next one starts.
  const lastDay = quarter ? new Date(quarterEnd(quarter).getTime() - 86_400_000).toISOString().slice(0, 10) : '';

  const dateText = scheduledOn ? LONG_DAY.format(new Date(stop.scheduledOn!)) : 'Not on a day yet';
  const technicianText = stop.assignedTechnician?.displayName ?? 'Nobody yet';
  const unitText = stop.propertywareUnit
    ? [stop.propertywareUnit.name, stop.propertywareUnit.addressLine1].filter(Boolean).join(' · ')
    : stop.unitResolution === 'NO_UNITS'
      ? 'Single-unit property'
      : null;
  const onSiteText = stop.onSiteMinutes === null ? null : formatMinutes(stop.onSiteMinutes);
  const kindText = (
    <span className="grid gap-0.5">
      <span>{kind}</span>
      <span className="text-muted-foreground text-xs">
        {stop.inspectionTypeOverriddenAt ? 'Set by a coordinator' : (reasonText(stop.inspectionTypeReason) ?? EMPTY)}
      </span>
    </span>
  );

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
      <DialogContent
        className="max-h-[calc(100dvh-4rem)] gap-5 overflow-y-auto sm:max-w-2xl"
        // Escape in a field being edited puts its value back; it does not close the window.
        onEscapeKeyDown={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-inline-editing]')) event.preventDefault();
        }}
      >
        <DialogHeader className="gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={stop.inspectionType === 'HVAC' ? 'info' : 'secondary'}>{kind}</Badge>
            <Badge variant={STOP_STATUS[stop.status].variant}>{STOP_STATUS[stop.status].label}</Badge>
            {stop.inspectionTypeNeedsReview ? <Badge variant="warning">Check the kind of visit</Badge> : null}
          </div>
          <DialogTitle className="text-lg">
            {stop.propertywareUnit && severalUnits
              ? (stop.propertywareUnit.addressLine1 ?? tenant.addressLine1)
              : (tenant.addressLine1 ?? 'Unknown address')}
          </DialogTitle>
          <DialogDescription>
            {[tenant.city, zoneLabel(stop.zone)].filter(Boolean).join(' · ') || EMPTY}
            {canEdit ? ' · Click a value to change it; each change is saved as you make it and kept when the plan is rebuilt.' : ''}
          </DialogDescription>
        </DialogHeader>

        {stop.blockedMessage ? (
          <Alert variant="destructive">
            <AlertDescription>{stop.blockedMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <DetailGroup
            rows={[
              [
                'Date',
                canEdit ? (
                  <span className="grid gap-0.5" key="date">
                    <EditableDate
                      display={dateText}
                      label="the date"
                      max={lastDay}
                      min={quarterStart(quarter!).toISOString().slice(0, 10)}
                      onSave={(value) => save({ scheduledOn: value })}
                      value={scheduledOn}
                    />
                    {note ? <span className="text-warning text-xs">{note}</span> : null}
                  </span>
                ) : (
                  dateText
                ),
              ],
              ['Time', timing ? `${formatClock(timing.entry.arrives)} – ${formatClock(timing.entry.leaves)}` : null],
              [
                'Technician',
                canEdit ? (
                  <EditablePick
                    display={technicianText}
                    key="technician"
                    label="the technician"
                    onSave={(value) => save({ assignedTechnicianId: value })}
                    options={technicianOptions}
                    searchable
                    value={stop.assignedTechnicianId}
                  />
                ) : (
                  technicianText
                ),
              ],
              ['Stop', timing ? `${timing.index + 1} of ${timing.count}` : null],
              ['Drive', drive],
              [
                'On site',
                canEdit ? (
                  <EditableText
                    display={onSiteText ?? EMPTY}
                    hint="Minutes on site · Enter to save · Esc to undo"
                    inputMode="numeric"
                    key="on-site"
                    label="the time on site"
                    onSave={(value) => {
                      const minutes = value.trim();
                      if (!/^\d+$/.test(minutes)) throw new Error('Write the time on site in whole minutes, like 45.');
                      return save({ onSiteMinutes: Number(minutes) });
                    }}
                    value={stop.onSiteMinutes === null ? '' : String(stop.onSiteMinutes)}
                  />
                ) : (
                  onSiteText
                ),
              ],
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
              [
                'Unit',
                canEdit && severalUnits ? (
                  <EditablePick
                    display={unitText ?? <span className="text-warning">Choose which unit this tenancy is in</span>}
                    key="unit"
                    label="the unit"
                    onSave={(value) => save({ propertywareUnitId: value })}
                    options={stop.buildingUnits.map((unit) => ({
                      value: unit.id,
                      label: unit.name,
                      hint: unit.addressLine1 ?? undefined,
                    }))}
                    value={stop.propertywareUnit?.id ?? null}
                  />
                ) : (
                  unitText
                ),
              ],
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
                canEdit ? (
                  <EditablePick
                    display={kindText}
                    key="kind"
                    label="the kind of visit"
                    onSave={(value) => save({ inspectionType: value as PlanInspectionType })}
                    options={KIND_OPTIONS}
                    value={stop.inspectionType}
                  />
                ) : (
                  <Fragment key="kind">{kindText}</Fragment>
                ),
              ],
              [
                'Order',
                `#${stop.sequence}${stop.previousSequence ? ` · #${stop.previousSequence} last quarter` : ` · ${ORDER_SOURCE[stop.orderSource]}`}`,
              ],
              ['Last technician', stop.previousTechnician?.displayName ?? null],
              ['Placed by', stop.scheduleOverriddenAt || stop.technicianOverriddenAt ? 'A coordinator' : 'The planner'],
            ]}
            title="Plan"
          />
        </div>

        <section aria-labelledby="plan-stop-title" className="grid gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase" id="plan-stop-title">
              Title
            </h3>
            <span className="text-muted-foreground text-xs">
              {stop.visitTitleOverriddenAt ? 'Written by a coordinator' : 'Written by the plan'} · sent to Jobber as written
            </span>
          </div>
          {canEdit ? (
            <EditableText label="the title" onSave={(value) => save({ visitTitle: value })} value={stop.visitTitle ?? ''} />
          ) : (
            <p className="text-sm">{stop.visitTitle ?? EMPTY}</p>
          )}
        </section>

        <section aria-labelledby="plan-stop-details" className="grid gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase" id="plan-stop-details">
              Details
            </h3>
            <span className="text-muted-foreground text-xs">
              {stop.visitDetailsOverriddenAt
                ? 'Written by a coordinator'
                : stop.officeDetails
                  ? 'From the office’s sheet'
                  : 'Written from the tenant report'}{' '}
              · sent to Jobber as written
            </span>
          </div>
          {canEdit ? (
            <EditableText
              display={
                <span className="bg-muted/50 block rounded-lg border px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                  {stop.visitDetails ?? EMPTY}
                </span>
              }
              label="the Details"
              multiline
              onSave={(value) => save({ visitDetails: value })}
              value={stop.visitDetails ?? ''}
            />
          ) : (
            <p className="bg-muted/50 rounded-lg border px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
              {stop.visitDetails ?? EMPTY}
            </p>
          )}
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
