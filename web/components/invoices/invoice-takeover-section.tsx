'use client';

import { INVOICE_TAKEOVER_PERMISSIONS, type InvoiceTakeoverCheck } from '@texasrenters/shared';
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { formatInvoiceMoment } from '@/components/invoices/invoice-parts';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { usePermissions } from '@/lib/auth';
import { useInvoiceTakeover, useInvoiceTakeoverActions } from '@/lib/invoice-takeover-queries';

/**
 * Taking invoicing over from Jobber (2026-11-06, phase 8, the cutover), at the
 * foot of the invoice settings: what it waits on, the one button, and -- once
 * taken over -- when and by whom, with an undo while nothing has changed
 * since. Asked once, saying what it does, before anything happens.
 */
export function InvoiceTakeoverSection() {
  const id = useId();
  const takeover = useInvoiceTakeover();
  const actions = useInvoiceTakeoverActions();
  const { has } = usePermissions();
  const [asking, setAsking] = useState<'take' | 'undo' | null>(null);
  const [leaveFailed, setLeaveFailed] = useState(false);
  const mayTake = INVOICE_TAKEOVER_PERMISSIONS.every((permission) => has(permission));
  const busy = actions.takeOver.isPending || actions.undo.isPending;

  if (takeover.isLoading || !takeover.data) return null;
  const view = takeover.data;

  const confirm = () => {
    const failed = (title: string) => (error: Error) => toast.error(title, { description: error.message });
    if (asking === 'undo')
      actions.undo.mutate(undefined, {
        onSuccess: () => {
          toast.success('Jobber holds the invoices again', { description: 'It is read again from where it stopped.' });
          setAsking(null);
        },
        onError: failed('Nothing was undone'),
      });
    else
      actions.takeOver.mutate(
        { acceptFailedFiles: leaveFailed },
        {
          onSuccess: () => {
            toast.success('The console now owns invoicing', { description: 'Make and change invoices and payments here, not in Jobber.' });
            setAsking(null);
          },
          onError: failed('Invoicing was not taken over'),
        },
      );
  };

  return (
    <section aria-label="Take over invoicing" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">Take over invoicing from Jobber</h2>
      {view.takenOverAt ? (
        <>
          <p className="mt-2 text-sm">
            The console has owned invoicing since <span className="font-semibold">{formatInvoiceMoment(view.takenOverAt)}</span>
            {view.takenOverBy ? `, taken over by ${view.takenOverBy.displayName}` : ''}. Jobber&apos;s invoices and payments are no
            longer read: make and change them here.
          </p>
          {view.undoable ? (
            mayTake ? (
              <Button className="mt-3" disabled={busy} onClick={() => setAsking('undo')} size="sm" variant="outline">
                Undo
              </Button>
            ) : null
          ) : (
            <p className="text-muted-foreground mt-2 text-sm">
              It can no longer be undone: {view.changesSince.toLocaleString('en-US')} changes have been made to invoices here since,
              which reading Jobber again would overwrite.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-muted-foreground mt-1 text-sm">
            The console reads Jobber one last time, then stops reading its invoices and payments, and from then on they are made
            and changed here. Nothing is sent to Jobber. Stop working on invoices in Jobber first.
          </p>
          <ul aria-label="What the cutover waits on" className="mt-3 grid gap-2 text-sm">
            {view.checks.map((check) => (
              <CheckRow check={check} key={check.key} />
            ))}
          </ul>
          {mayTake ? (
            <Button className="mt-4" disabled={!view.ready || busy} onClick={() => setAsking('take')}>
              Take over invoicing
            </Button>
          ) : (
            <p className="text-muted-foreground mt-3 text-sm">Only whoever both makes invoices and runs the integrations takes it over.</p>
          )}
        </>
      )}

      <AlertDialog onOpenChange={(open) => (open ? undefined : setAsking(null))} open={asking !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking === 'undo' ? 'Give invoicing back to Jobber?' : 'Take over invoicing from Jobber?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {asking === 'undo'
                ? 'Jobber is read again from where it stopped, and invoices are made and changed there until the console takes over again.'
                : 'The console reads Jobber one last time. Then Jobber is no longer read, and invoices and payments are made and changed only here. It can be undone only until something is changed here.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {asking === 'take' && view.failedFiles ? (
            <div className="flex items-start gap-2 text-sm">
              <Checkbox checked={leaveFailed} id={`${id}-leave`} onCheckedChange={(value) => setLeaveFailed(value === true)} />
              <Label className="font-normal" htmlFor={`${id}-leave`}>
                Leave the {view.failedFiles.toLocaleString('en-US')} files that could not be copied. They open from Jobber only while it
                lasts.
              </Label>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || (asking === 'take' && view.failedFiles > 0 && !leaveFailed)}
              onClick={(event) => {
                // Closed once the server agrees, not by the click.
                event.preventDefault();
                confirm();
              }}
            >
              {busy ? (asking === 'undo' ? 'Undoing…' : 'Reading Jobber one last time…') : asking === 'undo' ? 'Give it back' : 'Take over invoicing'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CheckRow({ check }: { check: InvoiceTakeoverCheck }) {
  const Icon = check.ok ? CircleCheckIcon : check.blocking ? CircleXIcon : CircleAlertIcon;
  const tone = check.ok ? 'text-success' : check.blocking ? 'text-destructive' : 'text-warning';
  return (
    <li className="flex items-start gap-2">
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <span>
        <span className={check.ok ? undefined : 'font-semibold'}>{check.label}</span>
        <span className="sr-only">{check.ok ? ' (done)' : check.blocking ? ' (not yet)' : ' (to know)'}</span>
        {check.detail ? <span className="text-muted-foreground block text-xs">{check.detail}</span> : null}
      </span>
    </li>
  );
}
