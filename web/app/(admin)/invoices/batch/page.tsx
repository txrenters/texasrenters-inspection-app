'use client';

import {
  MAX_BATCH_INVOICES,
  PAYMENT_TERMS,
  formatEnumLabel,
  formatMoney,
  type BatchInvoiceResult,
  type UninvoicedPart,
  type UninvoicedVisit,
} from '@texasrenters/shared';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { formatInvoiceDay } from '@/components/invoices/invoice-parts';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePermissions } from '@/lib/auth';
import { businessToday, shiftDay } from '@/lib/clock';
import { useBatchInvoices, useUninvoicedVisits } from '@/lib/invoice-batch-queries';
import { newClientRequestId } from '@/lib/invoice-queries';

/**
 * Making many invoices at once (2026-11-06, phase 4 of taking invoicing over
 * from Jobber), as Jobber's Batch Create: the finished visits in a span of
 * days that have no invoice yet, each billed as the office's rules say -- its
 * type and what the technician reported done (2026-11-12) -- at its own prices. Every visit that can be billed is
 * ticked to start with; one that cannot says why, and is invoiced by itself.
 * Asked once before anything is made. A visit whose services go to several
 * companies' books makes one invoice for each (2026-11-10).
 */

/** A visit's invoices, one per company; one for the whole visit from a server that does not split them. */
const partsOf = (visit: UninvoicedVisit): UninvoicedPart[] =>
  visit.invoices?.length ? visit.invoices : [{ xeroTenantId: null, company: null, lineItems: visit.lineItems, totalCents: visit.totalCents }];
export default function BatchInvoicesPage() {
  const { has } = usePermissions();
  if (!has('invoices:manage'))
    return <EmptyState description="Creating invoices is a permission of its own. Ask an administrator." title="You may not create invoices" />;
  return <BatchInvoices />;
}

function BatchInvoices() {
  const id = useId();
  const today = businessToday();
  const [from, setFrom] = useState(shiftDay(today, -7));
  const [to, setTo] = useState(today);
  const visits = useUninvoicedVisits({ from, to });
  const batch = useBatchInvoices();
  const [issuedOn, setIssuedOn] = useState(today);
  // The office's terms from its settings until somebody picks others.
  const [pickedTerms, setTerms] = useState<string | null>(null);
  const terms = pickedTerms ?? String(visits.data?.paymentTermsDays ?? 30);
  const [asDraft, setAsDraft] = useState(false);
  // The console makes the invoices (2026-11-13): each goes to Xero as a draft, which Xero dates and sets due itself.
  const madeHere = Boolean(visits.data?.startsOn);
  // Unticked by hand; every billable visit is ticked otherwise.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<BatchInvoiceResult | null>(null);
  // One key per batch: a resend makes no second invoice for any visit.
  const [requestId, setRequestId] = useState(newClientRequestId);

  const items = useMemo(() => visits.data?.items ?? [], [visits.data?.items]);
  const billable = items.filter((visit) => !visit.problem);
  const chosen = billable.filter((visit) => !unticked.has(visit.inspectionId));
  const chosenCents = chosen.reduce((sum, visit) => sum + visit.totalCents, 0);
  // What the batch makes: one invoice per company of each visit.
  const invoiceCount = chosen.reduce((sum, visit) => sum + partsOf(visit).length, 0);
  // Of those, the ones made in a company's books in Xero as drafts (2026-11-12).
  const toXeroCount = chosen.reduce((sum, visit) => sum + partsOf(visit).filter((part) => part.toXero).length, 0);
  const invoicesWord = `${invoiceCount} ${invoiceCount === 1 ? 'invoice' : 'invoices'}`;
  const tooMany = chosen.length > MAX_BATCH_INVOICES;

  const toggle = (visit: UninvoicedVisit, on: boolean) =>
    setUnticked((current) => {
      const next = new Set(current);
      if (on) next.delete(visit.inspectionId);
      else next.add(visit.inspectionId);
      return next;
    });

  const create = () =>
    batch.mutate(
      {
        inspectionIds: chosen.map((visit) => visit.inspectionId),
        issuedOn,
        paymentTermsDays: Number(terms),
        ...(asDraft && !madeHere ? { asDraft: true } : {}),
        clientRequestId: requestId,
      },
      {
        onSuccess: (made) => {
          setAsking(false);
          setResult(made);
          setUnticked(new Set());
          setRequestId(newClientRequestId());
          toast.success(`${made.created.length} ${made.created.length === 1 ? 'invoice' : 'invoices'} made`, {
            description: made.skipped.length ? `${made.skipped.length} skipped; the reasons are listed.` : undefined,
          });
        },
        onError: (error) => {
          setAsking(false);
          toast.error('No invoices were made', { description: error.message });
        },
      },
    );

  return (
    <>
      <PageHeader
        description="The finished visits with no invoice yet, each billed as the rules under Invoices → Settings say, at the office's prices."
        title="Batch create invoices"
      />

      <section aria-label="Which visits" className="flex flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel htmlFor={`${id}-from`}>Visits from</FieldLabel>
          <Input id={`${id}-from`} max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor={`${id}-to`}>to</FieldLabel>
          <Input id={`${id}-to`} max={today} min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
      </section>

      {result ? <BatchResult items={items} result={result} /> : null}

      {visits.isLoading ? (
        <PageSkeleton />
      ) : visits.isError ? (
        <ErrorState error={visits.error} retry={() => void visits.refetch()} />
      ) : !items.length ? (
        <EmptyState description="Every finished visit in these days has an invoice, or none was finished." title="Nothing to invoice" />
      ) : (
        <>
          <section aria-label="Visits to invoice" className="bg-card mt-6 rounded-lg border">
            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 text-sm">
              <label className="flex items-center gap-2 font-medium">
                <Checkbox
                  aria-label="Choose every visit that can be billed"
                  checked={chosen.length === billable.length && billable.length > 0}
                  onCheckedChange={(checked) =>
                    setUnticked(checked === true ? new Set() : new Set(billable.map((visit) => visit.inspectionId)))
                  }
                />
                {chosen.length} of {billable.length} chosen
              </label>
              {items.length > billable.length ? (
                <span className="text-muted-foreground">{items.length - billable.length} cannot be billed as they stand</span>
              ) : null}
              {visits.data?.truncated ? <span className="text-muted-foreground">More visits than are listed: narrow the days.</span> : null}
              {visits.data?.startsOn ? (
                <span className="text-muted-foreground">
                  Visits from {formatInvoiceDay(visits.data.startsOn)}, when the console began making the invoices.
                </span>
              ) : null}
            </div>
            <ul className="divide-y">
              {items.map((visit) => (
                <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-sm" key={visit.inspectionId}>
                  <Checkbox
                    aria-label={`Invoice ${visit.clientName}, ${formatInvoiceDay(visit.scheduledOn)}`}
                    checked={!visit.problem && !unticked.has(visit.inspectionId)}
                    className="mt-0.5"
                    disabled={Boolean(visit.problem)}
                    onCheckedChange={(checked) => toggle(visit, checked === true)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <Link className="text-heading font-semibold hover:underline" href={`/inspections/${visit.inspectionId}`}>
                        {visit.clientName}
                      </Link>
                      <span className="text-muted-foreground text-xs">
                        {formatInvoiceDay(visit.scheduledOn)} · {formatEnumLabel(visit.inspectionType)}
                      </span>
                    </p>
                    {visit.problem ? (
                      <p className="text-destructive text-xs">{visit.problem}</p>
                    ) : partsOf(visit).some((part) => part.company) || partsOf(visit).length > 1 ? (
                      <ul aria-label={`Invoices for ${visit.clientName}`} className="text-muted-foreground grid gap-0.5 text-xs">
                        {partsOf(visit).map((part) => (
                          <li key={part.xeroTenantId ?? 'none'}>
                            <span className="text-foreground font-medium">{part.company ?? 'No company'}</span>:{' '}
                            {part.lineItems.map((line) => line.name).join(' · ')} · {formatMoney(part.totalCents)}
                            {part.toXero ? ' · a draft in Xero' : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground text-xs">{visit.lineItems.map((line) => line.name).join(' · ')}</p>
                    )}
                  </div>
                  <span className="text-heading ml-auto font-semibold tabular-nums">{visit.problem ? '—' : formatMoney(visit.totalCents)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="How they are made" className="mt-6 flex flex-wrap items-end gap-3">
            <Field className="w-auto">
              <FieldLabel htmlFor={`${id}-issued`}>Issued</FieldLabel>
              <Input id={`${id}-issued`} max={today} onChange={(event) => setIssuedOn(event.target.value)} type="date" value={issuedOn} />
            </Field>
            {madeHere ? (
              <p className="text-muted-foreground max-w-md pb-2 text-sm">
                Each goes to its company&apos;s books in Xero as a draft, for the office to approve there. Xero dates it on its
                visit&apos;s day and makes it due on the last day of that month.
              </p>
            ) : (
              <>
                <Field className="w-auto">
                  <FieldLabel htmlFor={`${id}-terms`}>Payment terms</FieldLabel>
                  <Select onValueChange={setTerms} value={terms}>
                    <SelectTrigger className="w-44" id={`${id}-terms`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_TERMS.map((term) => (
                        <SelectItem key={term.days} value={String(term.days)}>
                          {term.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <Checkbox checked={asDraft} onCheckedChange={(checked) => setAsDraft(checked === true)} />
                  Make them drafts, to look over first
                </label>
              </>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-3">
              {tooMany ? <span className="text-destructive text-sm">At most {MAX_BATCH_INVOICES} visits at a time.</span> : null}
              <Button disabled={!chosen.length || tooMany || batch.isPending} onClick={() => setAsking(true)}>
                {`Create ${invoicesWord} · ${formatMoney(chosenCents)}`}
              </Button>
            </div>
          </section>
        </>
      )}

      <AlertDialog onOpenChange={(open) => (open ? undefined : setAsking(false))} open={asking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create {invoicesWord}?</AlertDialogTitle>
            <AlertDialogDescription>
              {formatMoney(chosenCents)} in all, issued {formatInvoiceDay(issuedOn)}
              {invoiceCount > chosen.length ? `, for ${chosen.length} ${chosen.length === 1 ? 'visit' : 'visits'}: one for each company’s books` : ''}.{' '}
              {toXeroCount
                ? `${toXeroCount === invoiceCount ? 'Each goes' : `${toXeroCount} go`} to its company’s books in Xero as a draft: Xero numbers it, and it is approved there. `
                : ''}
              {toXeroCount === invoiceCount
                ? ''
                : asDraft
                  ? 'They are kept as drafts, and numbered when each is marked sent.'
                  : 'Each is numbered next and owed from now.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              disabled={batch.isPending}
              onClick={(event) => {
                event.preventDefault();
                create();
              }}
            >
              {batch.isPending ? 'Creating…' : 'Create them'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What the last batch made, each opening its invoice, and what it skipped and why. */
function BatchResult({ result, items }: { result: BatchInvoiceResult; items: readonly UninvoicedVisit[] }) {
  const nameOf = (inspectionId: string) => items.find((visit) => visit.inspectionId === inspectionId)?.clientName ?? 'A visit';
  return (
    <section aria-label="What was made" className="bg-card mt-6 rounded-lg border p-4 text-sm" role="status">
      <h2 className="text-heading text-base font-bold">
        {result.created.length} {result.created.length === 1 ? 'invoice' : 'invoices'} made
      </h2>
      {result.created.length ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {result.created.map((made) => (
            <li key={made.invoiceId}>
              <Link className="underline underline-offset-2" href={`/invoices/${made.invoiceId}`}>
                {made.number ? `#${made.number}` : 'Draft'}
              </Link>{' '}
              <span className="text-muted-foreground">
                {made.company ? `${made.company} · ` : ''}
                {formatMoney(made.totalCents)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.skipped.length ? (
        <>
          <h3 className="text-heading mt-3 font-semibold">Skipped</h3>
          <ul className="text-muted-foreground mt-1 grid gap-0.5">
            {result.skipped.map((skip) => (
              <li key={skip.inspectionId}>
                {nameOf(skip.inspectionId)}: {skip.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
