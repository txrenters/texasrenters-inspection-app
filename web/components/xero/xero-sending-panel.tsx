'use client';

import { formatMoney, type XeroSendingView } from '@texasrenters/shared';
import { CircleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Panel } from '@/components/panel';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDay, formatRelative } from '@/lib/format';
import { useXeroSendingActions } from '@/lib/xero-queries';

/**
 * Sending invoices to Xero (2026-11-10, phase 3 of the Xero plan): on or off,
 * what went, what Xero refused and why. Approved invoices, under each property
 * as a contact; Xero emails nobody. Nothing is sent while it is off. And the
 * payments recorded against them (phase 4 of the multi-company plan), each
 * into the account chosen for how it was paid.
 */
export function XeroSendingPanel({ view, sendFrom, canManage }: { view: XeroSendingView; sendFrom: string | null; canManage: boolean }) {
  const actions = useXeroSendingActions(view.tenantId);
  const [asking, setAsking] = useState<'on' | 'off' | null>(null);
  const busy = actions.setEnabled.isPending || actions.run.isPending || actions.retry.isPending;

  const setEnabled = (enabled: boolean) =>
    actions.setEnabled.mutate(enabled, {
      onSuccess: () => {
        setAsking(null);
        toast.success(enabled ? 'Sending to Xero is on' : 'Sending to Xero is off');
      },
      onError: (error) => toast.error(enabled ? 'Not turned on' : 'Not turned off', { description: error.message }),
    });
  const run = () =>
    actions.run.mutate(undefined, {
      onSuccess: (next) => toast.success('Sent what changed', { description: next.lastRunProblem ?? undefined }),
      onError: (error) => toast.error('Not sent', { description: error.message }),
    });
  const retry = () =>
    actions.retry.mutate(undefined, {
      onSuccess: () => toast.success('They go again on the next run'),
      onError: (error) => toast.error('Not done', { description: error.message }),
    });

  return (
    <Panel
      actions={
        <Badge variant={view.enabled ? 'default' : 'outline'}>{view.enabled ? 'On' : 'Off'}</Badge>
      }
      bodyClassName="space-y-4 p-4"
      title="Sending to Xero"
    >
      <p className="text-sm">
        {view.enabled
          ? `On${view.changedAt ? ` since ${formatRelative(view.changedAt)}` : ''}. Invoices issued since ${sendFrom ? formatDay(sendFrom, 'long') : 'the start date'} go to Xero as approved invoices, with the payments recorded against them, and each change follows within about ten minutes.`
          : 'Off. Nothing is sent to Xero.'}{' '}
        <span className="text-muted-foreground">Xero emails nobody: invoices, follow-ups and receipts still go from the console.</span>
      </p>

      {view.blockers.length ? (
        <ul className="space-y-1.5 text-sm">
          {view.blockers.map((blocker) => (
            <li className="flex items-start gap-2" key={blocker}>
              <CircleAlertIcon aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
              <span>{blocker}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="grid grid-cols-3 gap-3 text-sm sm:max-w-md">
        <Count label="In Xero" value={view.counts.sent} />
        <Count label="Not sent yet" value={view.counts.notYet} />
        <Count label="Refused" tone={view.counts.failed ? 'warning' : undefined} value={view.counts.failed} />
      </dl>
      <dl aria-label="Payments" className="grid grid-cols-3 gap-3 text-sm sm:max-w-md">
        <Count label="Payments in Xero" value={view.counts.payments.sent} />
        <Count label="Payments refused" tone={view.counts.payments.failed ? 'warning' : undefined} value={view.counts.payments.failed} />
      </dl>
      {view.counts.noCompany ? (
        // Sent to no organisation (2026-11-10): not taken for sent.
        <p className="text-muted-foreground text-sm">
          {view.counts.noCompany.toLocaleString('en-US')} {view.counts.noCompany === 1 ? 'invoice belongs' : 'invoices belong'} to no company, and{' '}
          {view.counts.noCompany === 1 ? 'is' : 'are'} not sent anywhere: choose each product’s organisation on{' '}
          <Link className="underline underline-offset-2" href="/invoices/settings">
            Invoices → Settings
          </Link>
          .
        </p>
      ) : null}
      <p className="text-muted-foreground text-sm">
        {view.lastRunAt ? `Last run ${formatRelative(view.lastRunAt)}.` : 'Not run yet.'}
        {view.lastRunProblem ? <span className="text-destructive block">{view.lastRunProblem}</span> : null}
      </p>

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {view.enabled ? (
            <>
              <Button disabled={busy || view.blockers.length > 0} onClick={run}>
                {actions.run.isPending ? 'Sending…' : 'Send now'}
              </Button>
              {view.counts.failed || view.counts.payments.failed ? (
                <Button disabled={busy} onClick={retry} variant="outline">
                  Try the refused again
                </Button>
              ) : null}
              <Button disabled={busy} onClick={() => setAsking('off')} variant="outline">
                Turn off
              </Button>
            </>
          ) : (
            <Button disabled={busy || view.blockers.length > 0} onClick={() => setAsking('on')}>
              Turn on
            </Button>
          )}
        </div>
      ) : null}

      {view.failures.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Why</TableHead>
              <TableHead className="text-right">Tries</TableHead>
              <TableHead>Next try</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.failures.map((failure) => (
              <TableRow key={failure.invoiceId}>
                <TableCell className="tabular-nums">{failure.number ? `#${failure.number}` : '—'}</TableCell>
                <TableCell>{failure.clientName}</TableCell>
                <TableCell className="max-w-md whitespace-normal">{failure.problem}</TableCell>
                <TableCell className="text-right tabular-nums">{failure.attempts}</TableCell>
                <TableCell className="text-muted-foreground">
                  {failure.nextAttemptAt ? formatRelative(failure.nextAttemptAt) : 'When it changes'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {view.paymentFailures.length ? (
        <Table aria-label="Payments refused">
          <TableHeader>
            <TableRow>
              <TableHead>Payment</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Why</TableHead>
              <TableHead className="text-right">Tries</TableHead>
              <TableHead>Next try</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.paymentFailures.map((failure) => (
              <TableRow key={failure.paymentId ?? `removed-${failure.invoiceId}-${failure.lastAttemptAt}`}>
                <TableCell className="tabular-nums">
                  {failure.amountCents === null ? 'Removed here' : `${formatMoney(failure.amountCents)}${failure.paidOn ? `, ${formatDay(failure.paidOn)}` : ''}`}
                </TableCell>
                <TableCell>
                  {failure.number ? `#${failure.number}` : '—'} <span className="text-muted-foreground">{failure.clientName}</span>
                </TableCell>
                <TableCell className="max-w-md whitespace-normal">{failure.problem}</TableCell>
                <TableCell className="text-right tabular-nums">{failure.attempts}</TableCell>
                <TableCell className="text-muted-foreground">
                  {failure.nextAttemptAt ? formatRelative(failure.nextAttemptAt) : 'When it changes'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <AlertDialog onOpenChange={(open) => (open ? undefined : setAsking(null))} open={asking !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking === 'on' ? 'Turn on sending to Xero?' : 'Turn off sending to Xero?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {asking === 'on'
                ? `Invoices issued since ${sendFrom ? formatDay(sendFrom, 'long') : 'the start date'} go to Xero as approved invoices, each under its property as a contact, with the payments recorded against them, and every change after follows. They are in the office's books from then on. Xero emails nobody.`
                : 'Nothing more goes to Xero until it is turned on again. What was sent stays in Xero.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={actions.setEnabled.isPending}
              onClick={(event) => {
                event.preventDefault();
                setEnabled(asking === 'on');
              }}
            >
              {asking === 'on' ? 'Turn on' : 'Turn off'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone === 'warning' ? 'text-warning' : ''}`}>{value.toLocaleString('en-US')}</dd>
    </div>
  );
}
