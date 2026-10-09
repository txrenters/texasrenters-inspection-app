'use client';

import type { JobberDayRow } from '@texasrenters/shared';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { usePermissions } from '@/lib/auth';
import { type JobberDayAction, useJobberDayAction } from '@/lib/queries';

interface Choice {
  label: string;
  /** What the confirmation says will happen, in the office's words. */
  confirm: string;
  /** True when it changes Jobber (once the outbox sends it). */
  writesJobber: boolean;
  request: JobberDayAction;
  done: string;
}

/**
 * The buttons beside one difference on the day (console-development).
 *
 * Every one asks first, saying what will change and where, because the ones
 * that write to Jobber change the real schedule technicians work from. While
 * sending to Jobber is switched off those are shown disabled, with the reason,
 * rather than hidden: the office should know the option exists and why it is
 * not on.
 */
export function JobberDayActions({ row, pushesEnabled }: { row: JobberDayRow; pushesEnabled: boolean }) {
  const { has } = usePermissions();
  const mutation = useJobberDayAction();
  const [pending, setPending] = useState<Choice | null>(null);
  const choices = choicesFor(row, {
    manage: has('inspections:manage'),
    assign: has('inspections:assign'),
    finalize: has('inspections:finalize'),
  });
  if (!choices.length) return null;

  const run = (choice: Choice) =>
    mutation.mutate(choice.request, {
      onSuccess: () => toast.success(choice.done),
      onError: (error) =>
        toast.error(`${choice.label}: not done`, {
          description: error instanceof Error ? error.message : 'The request failed.',
        }),
      onSettled: () => setPending(null),
    });

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {choices.map((choice) => {
        const blocked = choice.writesJobber && !pushesEnabled;
        return (
          <Button
            className="h-7 px-2.5 text-xs"
            disabled={blocked || mutation.isPending}
            key={choice.label}
            onClick={() => setPending(choice)}
            size="sm"
            title={blocked ? 'Sending changes to Jobber is switched off. Make the change in Jobber instead.' : undefined}
            variant="outline"
          >
            {choice.label}
          </Button>
        );
      })}

      <AlertDialog onOpenChange={(open) => !open && !mutation.isPending && setPending(null)} open={pending !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.label}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.confirm}
              {pending?.writesJobber
                ? ' It goes out with the next Jobber send, within a few minutes, and is recorded in the audit log.'
                : ' It is recorded in the audit log.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (pending) run(pending);
              }}
            >
              {mutation.isPending ? 'Working…' : pending?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function choicesFor(
  row: JobberDayRow,
  can: { manage: boolean; assign: boolean; finalize: boolean },
): Choice[] {
  const where = row.property;
  const id = row.inspectionId;
  const open = row.status === 'SCHEDULED' || row.status === 'IN_PROGRESS';
  const take = (): Choice | null =>
    can.manage && id
      ? {
          label: "Take Jobber's",
          confirm: `${where} will be set to what Jobber has. Any change of ours still waiting to go to Jobber is withdrawn.`,
          writesJobber: false,
          request: { action: 'take-jobber', inspectionId: id },
          done: `${where} now follows Jobber`,
        }
      : null;

  switch (row.state) {
    case 'TIME_DIFFERS':
    case 'DAY_DIFFERS':
      return [
        can.manage && id && open
          ? {
              label: 'Send ours to Jobber',
              confirm: `Jobber's visit at ${where} will be moved to the day and time set here.`,
              writesJobber: true,
              request: { action: 'push', inspectionId: id },
              done: `${where}: our time is queued for Jobber`,
            }
          : null,
        take(),
      ].filter((choice): choice is Choice => choice !== null);
    case 'TECHNICIAN_DIFFERS':
      return [
        can.manage && can.assign && id && open
          ? {
              label: 'Send our technician',
              confirm: `Jobber's visit at ${where} will be given the technician set here, with our time.`,
              writesJobber: true,
              request: { action: 'push', inspectionId: id, technician: true },
              done: `${where}: our technician is queued for Jobber`,
            }
          : null,
        take(),
      ].filter((choice): choice is Choice => choice !== null);
    case 'ONLY_IN_JOBBER':
      return can.manage && row.jobberVisitId && !row.inspectionId
        ? [
            {
              label: 'Create inspection',
              confirm: `The Jobber visit at ${where} is read again. It becomes an inspection only if it passes the sync's rules: named as an inspection, and its property linked.`,
              writesJobber: false,
              request: { action: 'create-inspection', jobberVisitId: row.jobberVisitId },
              done: `${where} was read again from Jobber`,
            },
          ]
        : [];
    case 'CANCELLED_HERE':
      return can.manage && id
        ? [
            {
              label: 'Cancel in Jobber',
              confirm: `The Jobber visit at ${where} will be removed, as it was cancelled here. If it is the job's only open visit, the job is closed too.`,
              writesJobber: true,
              request: { action: 'cancel-in-jobber', inspectionId: id },
              done: `${where}: the cancellation is queued for Jobber`,
            },
          ]
        : [];
    case 'DONE_HERE':
      return can.finalize && id
        ? [
            {
              label: 'Complete in Jobber',
              confirm: `The Jobber visit at ${where} will be marked completed, as it is done here.`,
              writesJobber: true,
              request: { action: 'complete-in-jobber', inspectionId: id },
              done: `${where}: the completion is queued for Jobber`,
            },
          ]
        : [];
    case 'DONE_IN_JOBBER':
      return [take()].filter((choice): choice is Choice => choice !== null);
    default:
      return [];
  }
}
