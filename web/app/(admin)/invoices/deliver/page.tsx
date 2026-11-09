'use client';

import {
  MAX_BATCH_DELIVERY,
  formatMoney,
  type DeliverableInvoice,
  type DeliverInvoicesResult,
  type InvoiceDetail,
} from '@texasrenters/shared';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, MailIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { InvoiceStatusBadge, formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/auth';
import { businessToday, shiftDay } from '@/lib/clock';
import { useDeliverableInvoices, useDeliverInvoices, useInvoiceEmailSettings } from '@/lib/invoice-delivery-queries';
import { downloadInvoices } from '@/lib/invoice-pdf/download-invoice';
import { invoiceKeys, newClientRequestId } from '@/lib/invoice-queries';

/**
 * Many invoices sent at once (2026-11-09, phase 1 of the invoice gap review),
 * as Jobber's Batch Deliver: the invoices issued in a span of days that
 * nobody has emailed yet, each emailed to the client's own addresses in one
 * press, or all of them printed as one PDF to mail.
 *
 * Every email is billed, so they go only on the press, after asking, at most
 * fifty at a time, under one key: pressing again after no answer sends
 * nothing twice. The PDF is made in the browser and costs nothing.
 */
export default function DeliverInvoicesPage() {
  const { has } = usePermissions();
  if (!has('invoices:manage'))
    return <EmptyState description="Sending invoices is a permission of its own. Ask an administrator." title="You may not send invoices" />;
  return <DeliverInvoices />;
}

const addressed = (invoice: DeliverableInvoice) => invoice.to.length > 0;

function DeliverInvoices() {
  const id = useId();
  const client = useQueryClient();
  const today = businessToday();
  const [from, setFrom] = useState(shiftDay(today, -30));
  const [to, setTo] = useState(today);
  const deliverable = useDeliverableInvoices({ from, to });
  const emails = useInvoiceEmailSettings();
  const deliver = useDeliverInvoices();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState('');
  const [batchKey, setBatchKey] = useState(newClientRequestId);
  const [result, setResult] = useState<{ result: DeliverInvoicesResult; names: Record<string, string> } | null>(null);
  const [printing, setPrinting] = useState(false);

  const items = useMemo(() => deliverable.data ?? [], [deliverable.data]);
  const picked = items.filter((invoice) => chosen.has(invoice.id));
  const toEmail = picked.filter(addressed);
  const emailCount = toEmail.reduce((sum, invoice) => sum + invoice.to.length, 0);
  const tooMany = toEmail.length > MAX_BATCH_DELIVERY;
  const mayEmail = emails.data?.takenOver === true;
  const unaddressed = items.filter((invoice) => !addressed(invoice)).length;

  const toggle = (invoice: DeliverableInvoice, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(invoice.id);
      else next.delete(invoice.id);
      return next;
    });

  const send = () => {
    const names = Object.fromEntries(toEmail.map((invoice) => [invoice.id, invoiceName(invoice)]));
    deliver.mutate(
      {
        batchKey,
        invoices: toEmail.map((invoice) => ({ invoiceId: invoice.id, to: invoice.to })),
        message: message.trim() || null,
      },
      {
        onSuccess: (done) => {
          setAsking(false);
          setResult({ result: done, names });
          setChosen(new Set());
          setBatchKey(newClientRequestId());
          const sent = done.results.filter((row) => row.status === 'SENT').length;
          const failed = done.results.length - sent;
          if (sent) toast.success(`${sent} ${sent === 1 ? 'invoice' : 'invoices'} emailed`, { description: failed ? `${failed} not sent; the reasons are listed.` : undefined });
          else toast.error('No invoice was emailed', { description: 'The reasons are listed.' });
        },
        onError: (error) => {
          setAsking(false);
          // The server answered, so this press is over: pressing again is a new one.
          if (error instanceof ApiError && error.status > 0) setBatchKey(newClientRequestId());
          toast.error('No invoice was emailed', { description: error.message });
        },
      },
    );
  };

  const print = async () => {
    setPrinting(true);
    try {
      // Each invoice's page, from the console's own copy, a few at a time: nothing billed.
      const details: InvoiceDetail[] = [];
      for (let start = 0; start < picked.length; start += 6)
        details.push(
          ...(await Promise.all(
            picked.slice(start, start + 6).map((invoice) =>
              client.fetchQuery({
                queryKey: invoiceKeys.detail(invoice.id),
                queryFn: ({ signal }) => api<InvoiceDetail>(`/api/v1/admin/invoices/${encodeURIComponent(invoice.id)}`, { signal }),
              }),
            ),
          )),
        );
      await downloadInvoices(details, `Invoices ${from} to ${to}.pdf`);
    } catch {
      toast.error('The PDF could not be made', { description: 'Try again in a moment.' });
    } finally {
      setPrinting(false);
    }
  };

  return (
    <>
      <PageHeader
        description="Invoices awaiting payment that nobody has emailed from the console yet: email each to its client, or print them all as one PDF."
        title="Batch deliver invoices"
      />

      <section aria-label="Which invoices" className="flex flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel htmlFor={`${id}-from`}>Issued from</FieldLabel>
          <Input id={`${id}-from`} max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor={`${id}-to`}>to</FieldLabel>
          <Input id={`${id}-to`} max={today} min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
      </section>

      {emails.data && !mayEmail ? (
        <p className="text-muted-foreground mt-4 text-sm" role="note">
          Invoices are emailed from Jobber until the console takes over invoicing. They can still be printed here.
        </p>
      ) : null}

      {result ? <DeliveryResult names={result.names} result={result.result} /> : null}

      {deliverable.isLoading ? (
        <PageSkeleton />
      ) : deliverable.isError ? (
        <ErrorState error={deliverable.error} retry={() => void deliverable.refetch()} />
      ) : !items.length ? (
        <EmptyState description="Every invoice awaiting payment from these days has been emailed, or none was issued." title="Nothing to deliver" />
      ) : (
        <>
          <section aria-label="Invoices to deliver" className="bg-card mt-6 rounded-lg border">
            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 text-sm">
              <label className="flex items-center gap-2 font-medium">
                <Checkbox
                  aria-label="Choose every invoice"
                  checked={picked.length === items.length}
                  onCheckedChange={(checked) => setChosen(checked === true ? new Set(items.map((invoice) => invoice.id)) : new Set())}
                />
                {picked.length} of {items.length} chosen
              </label>
              {unaddressed ? (
                <span className="text-muted-foreground">
                  {unaddressed === 1 ? '1 has no email address, so it can only be printed' : `${unaddressed} have no email address, so they can only be printed`}
                </span>
              ) : null}
              {items.length >= 200 ? <span className="text-muted-foreground">More invoices than are listed: narrow the days.</span> : null}
            </div>
            <ul className="divide-y">
              {items.map((invoice) => (
                <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-sm" key={invoice.id}>
                  <Checkbox
                    aria-label={`Choose ${invoiceName(invoice)}`}
                    checked={chosen.has(invoice.id)}
                    className="mt-0.5"
                    onCheckedChange={(checked) => toggle(invoice, checked === true)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <Link className="text-heading font-semibold hover:underline" href={`/invoices/${invoice.id}`}>
                        {invoice.clientName}
                      </Link>
                      <span className="text-muted-foreground text-xs">
                        {invoice.number ? `#${invoice.number} · ` : ''}issued {formatInvoiceDay(invoice.issuedOn)} · due {formatInvoiceDay(invoice.dueOn)}
                      </span>
                      <InvoiceStatusBadge status={invoice.status} />
                    </p>
                    <p className={addressed(invoice) ? 'text-muted-foreground text-xs break-all' : 'text-destructive text-xs'}>
                      {addressed(invoice) ? invoice.to.join(', ') : 'No email address for this client'}
                    </p>
                  </div>
                  <span className="text-heading ml-auto font-semibold tabular-nums">{formatMoney(invoice.balanceCents)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Send them" className="mt-6 flex flex-wrap items-center justify-end gap-3">
            {tooMany ? <span className="text-destructive text-sm">At most {MAX_BATCH_DELIVERY} emailed at a time.</span> : null}
            <Button disabled={!picked.length || printing} onClick={() => void print()} variant="outline">
              <DownloadIcon />
              {printing ? 'Making the PDF…' : picked.length ? `Download ${picked.length} as one PDF` : 'Download as one PDF'}
            </Button>
            {mayEmail ? (
              <Button disabled={!toEmail.length || tooMany || deliver.isPending} onClick={() => setAsking(true)}>
                <MailIcon />
                {`Email ${toEmail.length} ${toEmail.length === 1 ? 'invoice' : 'invoices'}`}
              </Button>
            ) : null}
          </section>
        </>
      )}

      <AlertDialog onOpenChange={(open) => (open ? undefined : setAsking(false))} open={asking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Email {toEmail.length} {toEmail.length === 1 ? 'invoice' : 'invoices'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Each to its client&apos;s addresses: {emailCount} {emailCount === 1 ? 'email' : 'emails'} in all, counted toward the
              console&apos;s 200 a day.
              {picked.length - toEmail.length === 1
                ? ' 1 chosen has no address and is left out.'
                : picked.length > toEmail.length
                  ? ` ${picked.length - toEmail.length} chosen have no address and are left out.`
                  : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-message`}>Message above each invoice (optional)</FieldLabel>
            <Textarea className="min-h-20" id={`${id}-message`} maxLength={2000} onChange={(event) => setMessage(event.target.value)} value={message} />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              disabled={deliver.isPending}
              onClick={(event) => {
                // Closed once the server answers, not by the click.
                event.preventDefault();
                send();
              }}
            >
              {deliver.isPending ? 'Sending…' : 'Email them'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const invoiceName = (invoice: Pick<DeliverableInvoice, 'number' | 'clientName'>) =>
  invoice.number ? `invoice #${invoice.number}, ${invoice.clientName}` : invoice.clientName;

/** What the last press sent, and what it did not and why. */
function DeliveryResult({ result, names }: { result: DeliverInvoicesResult; names: Record<string, string> }) {
  const sent = result.results.filter((row) => row.status === 'SENT');
  const failed = result.results.filter((row) => row.status === 'FAILED');
  return (
    <section aria-label="What was sent" className="bg-card mt-6 rounded-lg border p-4 text-sm" role="status">
      <h2 className="text-heading text-base font-bold">
        {sent.length} {sent.length === 1 ? 'invoice' : 'invoices'} emailed
      </h2>
      {failed.length ? (
        <>
          <h3 className="text-heading mt-3 font-semibold">Not sent</h3>
          <ul className="text-muted-foreground mt-1 grid gap-0.5">
            {failed.map((row) => (
              <li key={row.invoiceId}>
                <Link className="underline underline-offset-2" href={`/invoices/${row.invoiceId}`}>
                  {names[row.invoiceId] ?? 'An invoice'}
                </Link>
                : {row.problem ?? 'It did not go.'}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
