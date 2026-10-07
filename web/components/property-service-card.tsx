'use client';

import type { PropertyServiceMark, PropertyServiceView, SetPropertyServiceStatusInput } from '@texasrenters/shared';
import { TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { ErrorState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { usePermissions } from '@/lib/auth';
import { formatDate, formatScheduledDate, humanize } from '@/lib/format';
import { usePropertyServiceStatus, useSetPropertyServiceStatus } from '@/lib/property-service-queries';

type Flag = keyof SetPropertyServiceStatusInput;

/** The visit as the office names it; anything else falls back to its enum, humanized. */
const VISIT_LABEL: Record<string, string> = {
  MOVE_OUT: 'Move-out',
  MOVE_IN: 'Move-in',
  OCCUPIED: 'Occupied',
  HVAC: 'HVAC',
  BACK_TO_MARKET: 'Back-to-market',
};

/**
 * What each switch stops, in the office's words (2026-10-08). The two are
 * different on purpose: an owner who ends the management takes the property
 * out of everything, while a property that leaves the benefit package still
 * has its move-ins and move-outs -- those are owed whenever a tenant comes or
 * goes, package or not.
 */
const SWITCHES: Record<Flag, { label: string; help: string }> = {
  managementEnded: {
    label: 'Owner ended the management',
    help: 'Nothing more is booked here: no move-out, no move-in, no benefit-package visit.',
  },
  tbpOptedOut: {
    label: 'Opted out of the benefit package',
    help: 'No more quarterly occupied and HVAC visits. Move-ins and move-outs go on.',
  },
};

/**
 * The office's switches on a property, for what Propertyware has not been told
 * yet: it is updated late, and until it was, the lease schedule went on booking
 * move-outs and move-ins at properties the owner had taken away.
 *
 * Every switch is confirmed first, saying what it will do, and what it did is
 * said after: how many bookings were called off, and what is still booked here
 * that a person has to cancel -- nothing booked by hand, started or published
 * is cancelled by itself.
 */
export function PropertyServiceCard({ propertyId, propertyName }: { propertyId: string; propertyName: string }) {
  const canChange = usePermissions().has('properties:manage');
  const view = usePropertyServiceStatus(propertyId);
  const turn = useSetPropertyServiceStatus(propertyId);
  const [asking, setAsking] = useState<{ flag: Flag; on: boolean } | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  async function confirm() {
    if (!asking) return;
    try {
      const change = await turn.mutateAsync({ [asking.flag]: asking.on });
      setSaid(outcome(asking.flag, asking.on, change.calledOff, change.booked));
      setAsking(null);
    } catch {
      // The error is shown in the dialog, which stays open.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduling</CardTitle>
        <CardDescription>
          For what Propertyware has not been told yet. Everything that books visits here follows these.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.isError ? (
          <ErrorState error={view.error} retry={() => void view.refetch()} />
        ) : !view.data ? (
          <div className="space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (
          <>
            {(Object.keys(SWITCHES) as Flag[]).map((flag) => (
              <SwitchRow
                disabled={!canChange || turn.isPending}
                flag={flag}
                key={flag}
                mark={view.data.status[flag]}
                onTurn={(on) => {
                  turn.reset();
                  setSaid(null);
                  setAsking({ flag, on });
                }}
              />
            ))}
            {said ? <p className="text-muted-foreground text-sm">{said}</p> : null}
            <StillBooked view={view.data} />
          </>
        )}
      </CardContent>

      {asking && view.data ? (
        <AlertDialog onOpenChange={(open) => (open ? undefined : setAsking(null))} open>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{question(asking.flag, asking.on)}</AlertDialogTitle>
              <AlertDialogDescription>{propertyName}</AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
              {consequences(asking.flag, asking.on, view.data.leaseScheduleOn).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {turn.error ? (
              <Alert variant="destructive">
                <AlertDescription>{turn.error.message}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={turn.isPending}>Keep as it is</AlertDialogCancel>
              {/* Not AlertDialogAction: that closes on click, before the request has answered. */}
              <Button disabled={turn.isPending} onClick={() => void confirm()} type="button">
                {turn.isPending ? <Spinner /> : null}
                {asking.on ? 'Switch on' : 'Switch off'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Card>
  );
}

function SwitchRow({
  flag,
  mark,
  disabled,
  onTurn,
}: {
  flag: Flag;
  mark: PropertyServiceMark | null;
  disabled: boolean;
  onTurn: (on: boolean) => void;
}) {
  const id = `property-service-${flag}`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-0.5">
        <label className="text-sm font-medium" htmlFor={id}>
          {SWITCHES[flag].label}
        </label>
        <p className="text-muted-foreground text-xs">{SWITCHES[flag].help}</p>
        {mark ? (
          <p className="text-warning text-xs">
            Switched on {mark.by ? `by ${mark.by.displayName} ` : ''}· {formatDate(mark.at)}
          </p>
        ) : null}
      </div>
      <Switch checked={Boolean(mark)} disabled={disabled} id={id} onCheckedChange={onTurn} />
    </div>
  );
}

/** What is still booked here that the switches say should not happen: a person decides. */
function StillBooked({ view }: { view: PropertyServiceView }) {
  if (!view.stillBooked.length) return null;
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>
        {view.stillBooked.length === 1 ? 'One visit is still booked here' : `${view.stillBooked.length} visits are still booked here`}
      </AlertTitle>
      <AlertDescription>
        <p>Booked by hand, started or already published, so nothing cancelled them. Cancel any that should not happen.</p>
        <ul className="mt-1 space-y-0.5">
          {view.stillBooked.map((visit) => (
            <li key={visit.inspectionId}>
              <Link className="text-foreground underline-offset-2 hover:underline" href={`/inspections/${visit.inspectionId}`}>
                {VISIT_LABEL[visit.inspectionType] ?? humanize(visit.inspectionType)} · {formatScheduledDate(visit.scheduledOn)}
              </Link>
              <span className="text-muted-foreground">
                {' '}
                · {visit.technician ?? 'Nobody assigned'} · {humanize(visit.status)}
              </span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function question(flag: Flag, on: boolean) {
  if (flag === 'managementEnded') return on ? 'Has the owner ended the management?' : 'Is Texas Renters managing it again?';
  return on ? 'Has it opted out of the benefit package?' : 'Is it back on the benefit package?';
}

function consequences(flag: Flag, on: boolean, leaseScheduleOn: boolean): string[] {
  if (flag === 'managementEnded' && on)
    return [
      leaseScheduleOn
        ? 'Move-outs and move-ins the schedule booked here, and nobody has touched, are cancelled now — in Jobber too — and their technician is told.'
        : 'The lease schedule is switched off, so it books nothing here; anything it booked earlier stays until someone cancels it.',
      'Its benefit-package visits that are not published yet leave the quarter’s plan.',
      'Anything booked by hand, started or already published stays, and is listed here for you to cancel.',
    ];
  if (flag === 'managementEnded')
    return [
      leaseScheduleOn
        ? 'The lease schedule books its move-out and move-in again, as the lease asks.'
        : 'The lease schedule is switched off, so nothing is booked by itself.',
      'Its benefit-package visits rejoin the quarter’s plan, while Propertyware has the tenant enrolled.',
    ];
  if (on)
    return [
      'Its quarterly occupied and HVAC visits stop: ones not published yet leave the quarter’s plan.',
      'Published ones are listed here for you to cancel.',
      'Move-ins and move-outs are not affected.',
    ];
  return ['Its visits rejoin the quarter’s plan, while Propertyware has the tenant enrolled.'];
}

function outcome(flag: Flag, on: boolean, calledOff: number, booked: number) {
  const plural = (count: number) => (count === 1 ? 'one move-out or move-in' : `${count} move-outs and move-ins`);
  const parts = [on ? 'Switched on.' : 'Switched off.'];
  if (flag === 'managementEnded' && calledOff) parts.push(`Called off ${plural(calledOff)}.`);
  if (flag === 'managementEnded' && booked) parts.push(`Booked ${plural(booked)} again.`);
  return parts.join(' ');
}
