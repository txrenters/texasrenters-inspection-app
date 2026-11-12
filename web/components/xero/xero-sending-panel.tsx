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
 * into the account chosen for how it was paid. Each invoice goes once
 * (2026-11-12): one changed here after it went is listed, for the office to
 * change in Xero too.
 */
export function XeroSendingPanel({
  view,
  sendFrom,
  canManage,
  booksRead = false,
}: {
  view: XeroSendingView;
  sendFrom: string | null;
  canManage: boolean;
  /** The company's books are read back from Xero (2026-11-13): Xero sends its emails, and the console none. */
  booksRead?: boolean;
}) {
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
  const since = sendFrom ? formatDay(sendFrom, 'long') : 'the start date';
  // Once the console makes them (2026-11-13), counted from the day each is made, whatever day it is dated.
  const counted = view.madeInConsole ? 'made in the console' : 'issued';
  // A project for each visit (2026-11-11): drafts for the office to put on their projects and approve; no payments.
  const how = view.projectsEnabled
    ? `go to Xero as drafts, each visit with a project of its own: in Xero, put each line on its project, then approve the invoice. Payments stay out of Xero`
    : // The console makes the invoices (2026-11-13): its own go as drafts, for the office to approve there.
      view.madeInConsole
      ? 'go to Xero as drafts that Xero numbers, for the office to approve there'
      : 'go to Xero as approved invoices, with the payments recorded against them';

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
          ? `On${view.changedAt ? ` since ${formatRelative(view.changedAt)}` : ''}. Invoices ${counted} since ${since} ${how}, each within about ten minutes. Each goes once: in Xero it is the office's, and a change made here after that is listed below, to make in Xero too.`
          : 'Off. Nothing is sent to Xero.'}{' '}
        <span className="text-muted-foreground">
          {booksRead
            ? 'The console emails nothing for this company: its invoices, reminders and receipts go from Xero, once approved there.'
            : 'Xero emails nobody: invoices, follow-ups and receipts still go from the console.'}
        </span>
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
        {view.counts.changedHere ? <Count label="Changed here since" tone="warning" value={view.counts.changedHere} /> : null}
      </dl>
      <dl aria-label="Payments" className="grid grid-cols-3 gap-3 text-sm sm:max-w-md">
        <Count label="Payments in Xero" value={view.counts.payments.sent} />
        <Count label="Payments refused" tone={view.counts.payments.failed ? 'warning' : undefined} value={view.counts.payments.failed} />
      </dl>
      <dl aria-label="Bad debts" className="grid grid-cols-3 gap-3 text-sm sm:max-w-md">
        <Count label="Written off in Xero" value={view.counts.writeOffs.sent} />
        <Count label="Bad debts refused" tone={view.counts.writeOffs.failed ? 'warning' : undefined} value={view.counts.writeOffs.failed} />
      </dl>
      {view.projectsEnabled || view.counts.projects.done || view.counts.projects.failed ? (
        <dl aria-label="Projects" className="grid grid-cols-3 gap-3 text-sm sm:max-w-md">
          <Count label="Visits with a project" value={view.counts.projects.done} />
          <Count label="Projects refused" tone={view.counts.projects.failed ? 'warning' : undefined} value={view.counts.projects.failed} />
        </dl>
      ) : null}
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
              {view.counts.failed || view.counts.payments.failed || view.counts.writeOffs.failed || view.counts.projects.failed ? (
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

      {view.changedHere.length ? (
        // Never sent again (2026-11-12): the office makes the same change in Xero.
        <div className="space-y-2">
          <p className="text-sm">
            Changed here after they went to Xero. The console does not send them again, so Xero still has them as they went: make the same change in Xero.
          </p>
          <Table aria-label="Changed here since they went to Xero">
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>In Xero</TableHead>
                <TableHead>Changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.changedHere.map((changed) => (
                <TableRow key={changed.invoiceId}>
                  <TableCell className="tabular-nums">
                    <Link className="underline underline-offset-2" href={`/invoices/${changed.invoiceId}`}>
                      {changed.number ? `#${changed.number}` : 'Open'}
                    </Link>
                  </TableCell>
                  <TableCell>{changed.clientName}</TableCell>
                  <TableCell>{changed.voided ? 'Voided here: void it in Xero too' : 'Make the same change in Xero'}</TableCell>
                  <TableCell className="text-muted-foreground">{formatRelative(changed.changedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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

      {view.writeOffFailures.length ? (
        <Table aria-label="Bad debts refused">
          <TableHeader>
            <TableRow>
              <TableHead>Bad debt</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Why</TableHead>
              <TableHead className="text-right">Tries</TableHead>
              <TableHead>Next try</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.writeOffFailures.map((failure) => (
              <TableRow key={failure.invoiceId}>
                <TableCell className="tabular-nums">
                  {formatMoney(failure.amountCents)}
                  {failure.reversing ? <span className="text-muted-foreground"> · taking back</span> : null}
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

      {view.projectFailures.length ? (
        <Table aria-label="Projects refused">
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Why</TableHead>
              <TableHead className="text-right">Tries</TableHead>
              <TableHead>Next try</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.projectFailures.map((failure) => (
              <TableRow key={failure.inspectionId}>
                <TableCell className="max-w-xs whitespace-normal">{failure.name}</TableCell>
                <TableCell className="max-w-md whitespace-normal">{failure.problem}</TableCell>
                <TableCell className="text-right tabular-nums">{failure.attempts}</TableCell>
                <TableCell className="text-muted-foreground">{failure.nextAttemptAt ? formatRelative(failure.nextAttemptAt) : 'On the next run'}</TableCell>
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
                ? view.projectsEnabled
                  ? `Invoices ${counted} since ${since} go to Xero as drafts, each under its property as a contact and each visit with a project of its own: in Xero, put each line on its project, then approve the invoice. Payments stay out of Xero. Each goes once: a change made here after that is the office's to make in Xero. They are in the office's books from then on. Xero emails nobody.`
                  : view.madeInConsole
                    ? `Invoices ${counted} since ${since} go to Xero as drafts, each under its property as a contact, for the office to approve there; Xero numbers them. Each goes once: a change made here after that is the office's to make in Xero.`
                    : `Invoices ${counted} since ${since} go to Xero as approved invoices, each under its property as a contact, with the payments recorded against them. Each goes once: a change made here after that is the office's to make in Xero. They are in the office's books from then on. Xero emails nobody.`
                : view.madeInConsole
                  ? "Invoices are made in the console now. With sending off, this company's new invoices get the console's own numbers and reach no books, and nobody emails them. Turn it back on as soon as they can go again. What was sent stays in Xero."
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
