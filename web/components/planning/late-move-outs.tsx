'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { formatShortDay } from '@/lib/planning';
import type { LateMoveOut, LateMoveOuts } from '@/lib/planning-queries';

/**
 * Move-outs and move-ins booked onto a technician's benefit-package day after
 * the quarter was published (the office, 2026-10-01).
 *
 * A day with a move-out gives up the three visits furthest from it, and those
 * go to the Monday after, which is kept for rescheduled visits. A build does
 * that for the move-outs it knows of; most are booked later, so they are shown
 * here. Nothing moves until the office confirms, because moving a visit sends
 * Jobber an edit: the window names the visits, the Monday and how full that
 * Monday already is.
 */

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const dayName = (date: string) => `${WEEKDAY.format(new Date(`${date}T00:00:00Z`))}, ${formatShortDay(date)}`;
const kindName = (kind: 'MOVE_OUT' | 'MOVE_IN') => (kind === 'MOVE_IN' ? 'move-in' : 'move-out');

export function LateMoveOutsPanel({
  data,
  canMove,
  pending = false,
  onMove,
}: {
  data: LateMoveOuts;
  /** Allowed to reschedule visits: the planner's grant and the inspections one. */
  canMove: boolean;
  pending?: boolean;
  onMove: (conflict: LateMoveOut, inspectionIds: string[]) => void;
}) {
  const [confirming, setConfirming] = useState<LateMoveOut | null>(null);
  if (!data.conflicts.length) return null;

  return (
    // The console's warning panel, a coloured edge and an icon (console-development),
    // in place of a hand-made amber box. A region, not a live alert: it is a list to
    // work through, and reading it all out whenever the page loads helps nobody.
    <Alert aria-label="Move-outs booked since the plan" role="region" variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>
        {data.conflicts.length === 1
          ? 'A move-out was booked onto a benefit-package day since the plan'
          : `${data.conflicts.length} days had a move-out booked onto them since the plan`}
      </AlertTitle>
      <AlertDescription className="mt-1.5 justify-items-stretch opacity-100">
        <ul className="grid gap-2">
          {data.conflicts.map((conflict) => {
            const count = conflict.suggested.length;
            const reason = !conflict.monday
              ? 'No Monday is left in the quarter after this day: move them by hand.'
              : !data.jobberEditsPushed
                ? 'Edits are not sent to Jobber from here: move them in Jobber.'
                : !canMove
                  ? 'Moving visits needs the planning and inspections permissions.'
                  : null;
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm"
                key={`${conflict.date}|${conflict.technician.id}`}
              >
                <span className="min-w-0">
                  <span className="font-medium">
                    {dayName(conflict.date)} · {conflict.technician.displayName}
                  </span>
                  <span className="text-muted-foreground">
                    {' — '}
                    {conflict.bookings
                      .map((booking) => `${kindName(booking.kind)} at ${booking.address ?? 'an address not on file'}`)
                      .join(', ')}
                    {` · ${conflict.visits} benefit-package ${conflict.visits === 1 ? 'visit' : 'visits'} that day`}
                  </span>
                  {reason ? <span className="text-muted-foreground block text-xs">{reason}</span> : null}
                </span>
                <Button
                  disabled={Boolean(reason) || pending || count === 0}
                  onClick={() => setConfirming(conflict)}
                  size="sm"
                  variant="outline"
                >
                  {conflict.monday ? `Move ${count} to ${dayName(conflict.monday)}…` : `Move ${count}…`}
                </Button>
              </li>
            );
          })}
        </ul>
      </AlertDescription>

      <AlertDialog onOpenChange={(open) => !open && setConfirming(null)} open={confirming !== null}>
        {confirming && confirming.monday ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Move {confirming.suggested.length} {confirming.suggested.length === 1 ? 'visit' : 'visits'} to{' '}
                {dayName(confirming.monday)}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {dayName(confirming.date)} has a {kindName(confirming.bookings[0]!.kind)} for{' '}
                {confirming.technician.displayName}, so the visits furthest from it go to the Monday after, kept for
                rescheduled visits. Each is moved here and in Jobber.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="grid gap-1 text-sm">
              {confirming.suggested.map((visit) => (
                <li className="flex justify-between gap-3" key={visit.inspectionId}>
                  <span className="truncate">{visit.address ?? 'An address not on file'}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {(visit.metresFromBooking / 1000).toFixed(1)} km away
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              {confirming.technician.displayName} already has {confirming.mondayLoad}{' '}
              {confirming.mondayLoad === 1 ? 'visit' : 'visits'} on {dayName(confirming.monday)}.
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onMove(
                    confirming,
                    confirming.suggested.map((visit) => visit.inspectionId),
                  );
                  setConfirming(null);
                }}
              >
                Move {confirming.suggested.length} {confirming.suggested.length === 1 ? 'visit' : 'visits'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </Alert>
  );
}
